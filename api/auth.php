<?php
declare(strict_types=1);

require __DIR__ . '/config.php';

$data   = body();
$action = field($data, 'action');

switch ($action) {
    case 'signup':
        signup($data);
        break;

    case 'signin':
        signin($data);
        break;

    case 'logout':
        unset($_SESSION['user_id'], $_SESSION['user_auth'], $_SESSION['mfa_pending']);
        ok();
        break;

    case 'reset_password':
        reset_password($data);
        break;

    case 'admin_logout':
        unset($_SESSION['admin_id'], $_SESSION['admin_auth'], $_SESSION['mfa_pending']);
        ok();
        break;

    case 'mfa_verify':
        mfa_verify_signin($data);
        break;

    case 'mfa_resend':
        mfa_resend_code();
        break;

    default:
        throw new ApiError('Unknown auth action.', 400);
}

function signup(array $data): void
{
    if (signup_throttled()) {
        throw new ApiError('Too many accounts created from this device. Please try again later.', 429);
    }

    $name     = capitalize(field($data, 'name'));
    $email    = strtolower(field($data, 'email'));
    $phone    = field($data, 'phone');
    $password = (string) ($data['password'] ?? '');

    if ($name === '' || $email === '' || $phone === '' || $password === '') {
        throw new ApiError('Please complete all required fields.');
    }
    if (!valid_name($name)) {
        throw new ApiError('Please enter a valid full name.');
    }
    if (!valid_email($email)) {
        throw new ApiError('Please enter a valid email address.');
    }
    if (!valid_phone($phone)) {
        throw new ApiError('Please enter a valid 11-digit Philippine mobile number.');
    }
    if ($problem = password_problem($password)) {
        throw new ApiError($problem);
    }
    // An account is created around a delivery address, so it is required here
    // and not just in the form. Typed or GPS-pinned, it is the same row.
    $address = address_input($data);

    $pdo = db();
    $exists = $pdo->prepare('SELECT id FROM users WHERE email = ?');
    $exists->execute([$email]);
    if ($exists->fetch()) {
        throw new ApiError('An account with that email already exists.');
    }

    // The user row and their first address go in together: an account with no
    // address would leave the customer stuck at checkout with nothing saved.
    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare('INSERT INTO users (name, email, phone, password) VALUES (?, ?, ?, ?)');
        $stmt->execute([$name, $email, $phone, password_hash($password, PASSWORD_DEFAULT)]);
        $userId = (int) $pdo->lastInsertId();
        address_insert($pdo, $userId, $address, true);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    sign_in_user($pdo, $userId);
    ok(['user' => current_user()]);
}

function signin(array $data): void
{
    $email    = strtolower(field($data, 'email'));
    $password = (string) ($data['password'] ?? '');

    if ($email === '' || $password === '') {
        throw new ApiError('Please enter your email and password.');
    }
    if (!valid_email($email)) {
        throw new ApiError('Please enter a valid email address.');
    }
    if ($wait = login_is_blocked($email)) {
        $mins = (int) ceil($wait / 60);
        throw new ApiError(
            "Too many failed sign-in attempts. Please try again in {$mins} minute" . ($mins === 1 ? '' : 's') . '.',
            429
        );
    }

    $pdo = db();

    // An admin account can also sign in from the customer login page;
    // it is sent straight to the admin dashboard.
    $adminStmt = $pdo->prepare('SELECT id, name, password FROM admins WHERE email = ?');
    $adminStmt->execute([$email]);
    $admin = $adminStmt->fetch();
    if ($admin && password_matches($password, (string) $admin['password'])) {
        upgrade_admin_password((int) $admin['id'], (string) $admin['password'], $password);
        $actor = ['type' => 'admin', 'id' => (int) $admin['id'], 'email' => $email, 'name' => (string) $admin['name']];
        // A correct password is not a session while MFA is on: hand over to the
        // code step, which is the only thing that can open the door.
        if (mfa_challenge_required($pdo, 'admin', (int) $admin['id'])) {
            mfa_hold_for_code($pdo, $actor);
        }
        sign_in_admin($pdo, (int) $admin['id']);
        login_record($email, true);
        ok(['admin' => true, 'admin_profile' => current_admin_data()]);
    }

    $stmt = $pdo->prepare('SELECT id, name, password FROM users WHERE email = ?');
    $stmt->execute([$email]);
    $user = $stmt->fetch();

    if (!$user || !password_verify($password, (string) $user['password'])) {
        login_record($email, false);
        throw new ApiError('The email or password is incorrect.');
    }

    $actor = ['type' => 'user', 'id' => (int) $user['id'], 'email' => $email, 'name' => (string) $user['name']];
    if (mfa_challenge_required($pdo, 'user', (int) $user['id'])) {
        mfa_hold_for_code($pdo, $actor);
    }

    login_record($email, true);
    sign_in_user($pdo, (int) $user['id']);
    ok(['user' => current_user(), 'admin' => false]);
}

/* ---------------------------------------------------------------
 |  Two-factor sign-in
 * --------------------------------------------------------------- */

/**
 * Parks a verified sign-in at the code step and answers with mfa_required.
 *
 * Nothing privileged is written: $_SESSION['user_id'] / ['admin_id'] stay unset,
 * so every other endpoint still sees a signed-out visitor while this waits.
 * Always finishes the request.
 */
function mfa_hold_for_code(PDO $pdo, array $actor): void
{
    $account = mfa_account($pdo, $actor['type'], $actor['id']);
    if ($account === null) {
        // No MFA row but the guard said yes — refuse rather than skip the check.
        throw new ApiError('Two-factor sign-in could not be read for this account.', 500);
    }

    $challenge = mfa_issue_challenge($pdo, $actor, (string) $account['secret']);

    session_regenerate_id(true);
    $_SESSION['mfa_pending'] = [
        'type'   => $actor['type'],
        'id'     => $actor['id'],
        'email'  => $actor['email'],
        'issued' => time(),
    ];

    // Still fail closed: a failed send never becomes a session. But the pending
    // hold is already in place, so the account can still use a recovery code or
    // ask for a resend — otherwise a mail outage would lock people out entirely.
    $payload = [
        'masked_email' => $challenge['masked'],
        'expires_in'   => $challenge['expires_in'],
        'is_admin'     => $actor['type'] === 'admin',
        'mail_sent'    => $challenge['sent'],
    ];
    if (!$challenge['sent']) {
        $payload['mail_problem'] = $challenge['reason'];
    }

    ok(['mfa_required' => true, 'mfa' => $payload]);
}

/** Re-reads the pending actor straight from the database. */
function mfa_pending_actor(PDO $pdo): array
{
    $pending = $_SESSION['mfa_pending'] ?? null;
    if (!is_array($pending) || !isset($pending['type'], $pending['id'])) {
        throw new ApiError('Your sign-in attempt has ended. Please sign in again.', 401);
    }
    if (time() - (int) ($pending['issued'] ?? 0) > MFA_CHALLENGE_TTL_MINUTES * 60) {
        unset($_SESSION['mfa_pending']);
        throw new ApiError('Your sign-in attempt timed out. Please sign in again.', 401);
    }

    $table = $pending['type'] === 'admin' ? 'admins' : 'users';
    $stmt = $pdo->prepare("SELECT id, name, email FROM `$table` WHERE id = ?");
    $stmt->execute([(int) $pending['id']]);
    $row = $stmt->fetch();
    if (!$row) {
        unset($_SESSION['mfa_pending']);
        throw new ApiError('That account no longer exists. Please sign in again.', 401);
    }

    return [
        'type'  => (string) $pending['type'],
        'id'    => (int) $row['id'],
        'email' => (string) $row['email'],
        'name'  => (string) $row['name'],
    ];
}

function mfa_verify_signin(array $data): void
{
    $pdo = db();
    $actor = mfa_pending_actor($pdo);
    $email = $actor['email'];

    if ($wait = login_is_blocked('mfa:' . $email)) {
        throw new ApiError(
            'Too many wrong codes. Please try again in ' . (int) ceil($wait / 60) . ' minutes.',
            429
        );
    }

    $check = mfa_verify_code($pdo, $actor, trim(field($data, 'code')) ?: trim(field($data, 'recovery_code')));
    if (!$check['ok']) {
        login_record('mfa:' . $email, false);
        throw new ApiError($check['reason'], 401);
    }
    login_record('mfa:' . $email, true);

    // The code is good, so the sign-in is now allowed to finish. Clearing the
    // hold before sign_in_* regenerates the id keeps the old id unusable.
    unset($_SESSION['mfa_pending']);

    mfa_mark_used($pdo, $actor['type'], $actor['id']);
    login_record($email, true);

    if ($actor['type'] === 'admin') {
        sign_in_admin($pdo, $actor['id']);
        ok([
            'admin'          => true,
            'admin_profile'  => current_admin_data(),
            'recovery_used'  => $check['recovery_used'],
        ]);
    }

    sign_in_user($pdo, $actor['id']);
    ok([
        'user'          => current_user(),
        'admin'         => false,
        'recovery_used' => $check['recovery_used'],
    ]);
}

function mfa_resend_code(): void
{
    $pdo = db();
    $actor = mfa_pending_actor($pdo);

    if ($wait = login_is_blocked('mfa:' . $actor['email'])) {
        throw new ApiError(
            'Too many attempts. Please try again in ' . (int) ceil($wait / 60) . ' minutes.',
            429
        );
    }

    $account = mfa_account($pdo, $actor['type'], $actor['id']);
    if ($account === null) {
        throw new ApiError('Two-factor sign-in is not set up for this account.', 400);
    }

    $challenge = mfa_issue_challenge($pdo, $actor, (string) $account['secret']);
    if (!$challenge['sent']) {
        throw new ApiError('The code could not be sent. ' . $challenge['reason'], 502);
    }

    // A resent code extends how long this attempt may live, but not forever.
    $_SESSION['mfa_pending']['issued'] = time();

    ok([
        'mfa' => [
            'masked_email' => $challenge['masked'],
            'expires_in'   => $challenge['expires_in'],
            'is_admin'     => $actor['type'] === 'admin',
        ],
    ]);
}

function reset_password(array $data): void
{
    $email    = strtolower(field($data, 'email'));
    $phone    = field($data, 'phone');
    $password = (string) ($data['password'] ?? '');

    if (!valid_email($email)) {
        throw new ApiError('Please enter a valid email address.');
    }
    if (!valid_phone($phone)) {
        throw new ApiError('Please enter a valid 11-digit Philippine mobile number.');
    }
    if ($wait = login_is_blocked('reset:' . $email)) {
        throw new ApiError('Too many reset attempts. Please try again in ' . (int) ceil($wait / 60) . ' minutes.', 429);
    }
    if ($problem = password_problem($password)) {
        throw new ApiError($problem);
    }

    // The account is confirmed with the email + mobile number on file.
    $stmt = db()->prepare('SELECT id FROM users WHERE email = ? AND phone = ?');
    $stmt->execute([$email, $phone]);
    $user = $stmt->fetch();

    if (!$user) {
        login_record('reset:' . $email, false);
        throw new ApiError('No account matches that email and mobile number.');
    }

    login_record('reset:' . $email, true);
    db()->prepare('UPDATE users SET password = ?, auth_version = auth_version + 1 WHERE id = ?')
        ->execute([password_hash($password, PASSWORD_DEFAULT), (int) $user['id']]);

    ok();
}

/** Caps how many accounts a single device can create per hour. */
function signup_throttled(): bool
{
    $stmt = db()->prepare(
        'SELECT COUNT(*) FROM login_attempts
          WHERE email = ? AND ok = 0 AND created_at > (NOW() - INTERVAL 1 HOUR)'
    );
    $stmt->execute(['signup:' . client_ip()]);
    return (int) $stmt->fetchColumn() >= 10;
}
