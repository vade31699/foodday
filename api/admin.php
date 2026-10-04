<?php
declare(strict_types=1);

/**
 * FOODAY — admin-only endpoints.
 * Everything that backs Admin > Settings, the dashboard figures and the
 * admin's own security, all guarded by require_admin().
 */

require __DIR__ . '/config.php';

require_admin();

$data   = body();
$action = field($data, 'action');

switch ($action) {
    case 'settings':
        ok(['settings' => admin_settings()]);
        break;

    case 'save_settings':
        save_settings($data);
        break;

    case 'update_profile':
        update_admin_profile($data);
        break;

    case 'change_password':
        change_admin_password($data);
        break;

    case 'request_change_code':
        ok(['change' => change_request_code(mfa_actor_admin(), field($data, 'purpose'))]);
        break;

    case 'signout_others':
        signout_other_devices();
        break;

    case 'security_report':
        security_report();
        break;

    case 'clear_login_log':
        clear_login_log();
        break;

    case 'stats':
        dashboard_stats();
        break;

    case 'mfa_status':
        ok(['mfa' => mfa_status_payload(mfa_actor_admin())]);
        break;

    case 'mfa_start':
        $actor = mfa_actor_admin();
        ok(['mfa' => array_merge(mfa_status_payload($actor), mfa_start_enrollment($actor, (string) ($data['password'] ?? '')))]);
        break;

    case 'mfa_confirm':
        $actor = mfa_actor_admin();
        $result = mfa_confirm_enrollment($actor, field($data, 'code'));
        ok(['mfa' => array_merge($result, mfa_status_payload($actor))]);
        break;

    case 'mfa_disable':
        $actor = mfa_actor_admin();
        mfa_disable($actor, (string) ($data['password'] ?? ''), field($data, 'code'));
        ok(['mfa' => mfa_status_payload($actor)]);
        break;

    default:
        throw new ApiError('Unknown admin action.', 400);
}

/** Admin-scoped actor, so the admin can only ever read or change their own MFA. */
function mfa_actor_admin(): array
{
    $admin = require_admin();
    return [
        'type'  => 'admin',
        'id'    => (int) $admin['id'],
        'email' => (string) $admin['email'],
        'name'  => (string) $admin['name'],
    ];
}

/* ---------------------------------------------------------------
 |  Settings
 * --------------------------------------------------------------- */

/**
 * The single source of truth for Admin > Settings.
 * 'group' drives the UI sections, 'type' drives validation, and the
 * min/max clamp every number so a bad value can never be stored.
 */
function settings_schema(): array
{
    return [
        // Store
        'store_name'         => ['group' => 'store',     'type' => 'text', 'max' => 60],
        'store_tagline'      => ['group' => 'store',     'type' => 'text', 'max' => 120],
        'support_email'      => ['group' => 'store',     'type' => 'email'],
        'support_phone'      => ['group' => 'store',     'type' => 'text', 'max' => 30],
        'store_open'         => ['group' => 'store',     'type' => 'bool'],

        // Orders
        'order_auto_accept'  => ['group' => 'orders',    'type' => 'bool'],
        'order_prep_minutes' => ['group' => 'orders',    'type' => 'int', 'min' => 5, 'max' => 240],
        'order_allow_cancel' => ['group' => 'orders',    'type' => 'bool'],
        'order_cancel_window'=> ['group' => 'orders',    'type' => 'int', 'min' => 0, 'max' => 1440],
        'order_min_total'    => ['group' => 'orders',    'type' => 'money', 'min' => 0, 'max' => 100000],

        // Payments
        'pay_cod_enabled'    => ['group' => 'payments',  'type' => 'bool'],
        'pay_gcash_enabled'  => ['group' => 'payments',  'type' => 'locked'], // needs a GCash merchant account

        // Privacy
        'privacy_show_contact' => ['group' => 'privacy', 'type' => 'bool'],
        'privacy_show_notes'   => ['group' => 'privacy', 'type' => 'bool'],

        // Security
        'password_min_length'   => ['group' => 'security', 'type' => 'int', 'min' => 6, 'max' => 32],
        'login_max_attempts'    => ['group' => 'security', 'type' => 'int', 'min' => 3, 'max' => 20],
        'login_lockout_minutes' => ['group' => 'security', 'type' => 'int', 'min' => 1, 'max' => 1440],
        'session_idle_minutes'  => ['group' => 'security', 'type' => 'int', 'min' => 0, 'max' => 1440],
    ];
}

function admin_settings(): array
{
    $out = [];
    foreach (settings_schema() as $key => $meta) {
        $out[$key] = setting($key, (string) ($meta['min'] ?? 0));
    }
    return $out;
}

function save_settings(array $data): void
{
    $pdo = db();
    confirm_admin_password($pdo, (string) ($data['password'] ?? ''));

    $schema  = settings_schema();
    $incoming = is_array($data['settings'] ?? null) ? $data['settings'] : [];
    $pairs   = [];

    foreach ($incoming as $key => $value) {
        $key = (string) $key;
        if (!isset($schema[$key])) {
            continue; // unknown key — silently ignored, never written
        }
        $meta = $schema[$key];
        $value = is_scalar($value) ? (string) $value : '';

        if ($meta['type'] === 'locked') {
            continue; // GCash cannot be switched on until a merchant account exists
        }
        if ($meta['type'] === 'bool') {
            $pairs[$key] = ($value === '1' || $value === 'true') ? '1' : '0';
            continue;
        }
        if (in_array($meta['type'], ['int', 'money'], true)) {
            $n = is_numeric($value) ? (int) round((float) $value) : (int) $meta['min'];
            $pairs[$key] = (string) max((int) $meta['min'], min((int) $meta['max'], $n));
            continue;
        }
        $value = trim($value);
        if ($meta['type'] === 'email' && $value !== '' && !valid_email($value)) {
            throw new ApiError('Please enter a valid support email address.');
        }
        if ($meta['type'] === 'text') {
            $value = mb_substr($value, 0, (int) $meta['max']);
        }
        $pairs[$key] = $value;
    }

    if (!$pairs) {
        throw new ApiError('There was nothing to save.');
    }

    setting_set_many($pairs);
    ok(['settings' => admin_settings(), 'saved' => array_keys($pairs)]);
}

/* ---------------------------------------------------------------
 |  Admin account
 * --------------------------------------------------------------- */

function update_admin_profile(array $data): void
{
    $admin  = require_admin();
    $pdo    = db();
    $name   = capitalize(field($data, 'name'));
    $email  = strtolower(field($data, 'email'));
    $phone  = field($data, 'phone');
    $image  = (string) ($data['image'] ?? '');

    if (!valid_name($name)) {
        throw new ApiError('Please enter a valid full name.');
    }
    if (!valid_email($email)) {
        throw new ApiError('Please enter a valid email address.');
    }
    if ($phone !== '' && !valid_phone($phone)) {
        throw new ApiError('Please enter a valid 11-digit Philippine mobile number.');
    }

    $dup = $pdo->prepare('SELECT id FROM admins WHERE email = ? AND id <> ?');
    $dup->execute([$email, $admin['id']]);
    if ($dup->fetch()) {
        throw new ApiError('That email is already used by another admin.');
    }

    // Moving the admin to a new sign-in address needs a code sent to the
    // address already on file.
    if (strcasecmp($email, (string) $admin['email']) !== 0) {
        change_verify_code(mfa_actor_admin(), 'email', (string) ($data['code'] ?? ''));
    }

    $pdo->prepare('UPDATE admins SET name = ?, email = ?, phone = ? WHERE id = ?')
        ->execute([$name, $email, $phone !== '' ? $phone : null, $admin['id']]);

    if ($image !== '') {
        if (!str_starts_with($image, 'data:image/')) {
            throw new ApiError('Please choose a valid image.');
        }
        $pdo->prepare('UPDATE admins SET profile_image = ? WHERE id = ?')
            ->execute([$image, $admin['id']]);
    }

    ok(['admin' => current_admin_data()]);
}

function change_admin_password(array $data): void
{
    $admin    = require_admin();
    $current  = (string) ($data['current_password'] ?? '');
    $new      = (string) ($data['new_password'] ?? '');
    $confirm  = (string) ($data['confirm_password'] ?? '');

    $pdo = db();
    $stmt = $pdo->prepare('SELECT password FROM admins WHERE id = ?');
    $stmt->execute([$admin['id']]);
    $stored = (string) $stmt->fetchColumn();

    if (!password_verify($current, $stored)) {
        login_record($admin['email'], false);
        throw new ApiError('Your current password is incorrect.');
    }
    if ($new !== $confirm) {
        throw new ApiError('The new passwords do not match.');
    }
    if ($new === $current) {
        throw new ApiError('Your new password must be different from the current one.');
    }
    if ($problem = password_problem($new)) {
        throw new ApiError($problem);
    }

    // A new password always needs a code emailed to the address on file, so a
    // stolen session cannot lock the admin out of their own account.
    change_verify_code(mfa_actor_admin(), 'password', (string) ($data['code'] ?? ''));

    // Bumping auth_version logs out every other device; this session is
    // immediately re-issued below so the admin stays signed in here.
    $pdo->prepare('UPDATE admins SET password = ?, auth_version = auth_version + 1 WHERE id = ?')
        ->execute([password_hash($new, PASSWORD_DEFAULT), $admin['id']]);

    sign_in_admin($pdo, (int) $admin['id']);
    login_record($admin['email'], true);

    ok(['message' => 'Password updated. Every other signed-in device has been logged out.']);
}

function signout_other_devices(): void
{
    $admin = require_admin();
    $pdo   = db();
    $pdo->prepare('UPDATE admins SET auth_version = auth_version + 1 WHERE id = ?')
        ->execute([(int) $admin['id']]);
    sign_in_admin($pdo, (int) $admin['id']);
    ok(['message' => 'All other devices have been signed out.']);
}

function security_report(): void
{
    require_admin();
    $pdo = db();

    $failed = $pdo->query(
        'SELECT COUNT(*) FROM login_attempts
          WHERE ok = 0 AND created_at > (NOW() - INTERVAL 7 DAY)'
    )->fetchColumn();
    $locked = $pdo->query(
        'SELECT COUNT(DISTINCT email) FROM login_attempts
          WHERE ok = 0 AND created_at > (NOW() - INTERVAL 1 DAY)'
    )->fetchColumn();
    $recent = $pdo->prepare(
        'SELECT email, ip, created_at FROM login_attempts WHERE ok = 0 ORDER BY id DESC LIMIT 8'
    );
    $recent->execute();

    $checks = [
        [
            'label' => 'Password hashed with bcrypt',
            'ok'    => true,
            'hint'  => 'All passwords are stored as one-way hashes.',
        ],
        [
            'label' => 'Default admin password changed',
            'ok'    => !hash_equals(FOODAY_SEED_PASSWORD_HASH, current_hashed_password()),
            'hint'  => 'Replace the password that shipped with fooday.sql.',
        ],
        [
            'label' => 'Brute-force lockout enabled',
            'ok'    => setting_int('login_max_attempts', 5) > 0,
            'hint'  => 'Sign-in attempts are limited per email address.',
        ],
        [
            'label' => 'Idle session timeout set',
            'ok'    => setting_int('session_idle_minutes', 60) > 0,
            'hint'  => 'Inactive sessions are signed out automatically.',
        ],
        [
            'label' => 'Stronger password policy',
            'ok'    => setting_int('password_min_length', 6) >= 8,
            'hint'  => 'Letters and numbers are always required. 8+ characters scores higher.',
        ],
        [
            'label' => 'Confirmation for sensitive actions',
            'ok'    => true,
            'hint'  => 'Your password is required before any setting can be saved.',
        ],
    ];

    ok([
        'failed_attempts' => (int) $failed,
        'flagged_accounts' => (int) $locked,
        'recent'          => array_map(static fn(array $r): array => [
            'email' => $r['email'],
            'ip'    => $r['ip'],
            'at'    => date('M j, g:i A', strtotime((string) $r['created_at'])),
        ], $recent->fetchAll()),
        'checks'          => $checks,
    ]);
}

function current_hashed_password(): string
{
    $stmt = db()->prepare('SELECT password FROM admins WHERE id = ?');
    $stmt->execute([(int) $_SESSION['admin_id']]);
    return (string) $stmt->fetchColumn();
}

function clear_login_log(): void
{
    require_admin();
    db()->exec('DELETE FROM login_attempts');
    ok(['message' => 'Sign-in attempt log cleared.']);
}

/* ---------------------------------------------------------------
 |  Dashboard figures (server-side aggregates)
 * --------------------------------------------------------------- */

function dashboard_stats(): void
{
    require_admin();
    $pdo = db();

    $revenue = (float) $pdo->query(
        "SELECT COALESCE(SUM(total), 0) FROM orders WHERE status <> 'Cancelled'"
    )->fetchColumn();
    $today = (float) $pdo->query(
        "SELECT COALESCE(SUM(total), 0) FROM orders
          WHERE status <> 'Cancelled' AND DATE(placed_at) = CURDATE()"
    )->fetchColumn();

    $byStatus = [];
    foreach ($pdo->query('SELECT status, COUNT(*) AS n FROM orders GROUP BY status')->fetchAll() as $r) {
        $byStatus[$r['status']] = (int) $r['n'];
    }

    $top = $pdo->query(
        'SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.subtotal) AS amount
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
          WHERE o.status <> "Cancelled"
          GROUP BY oi.name
          ORDER BY qty DESC
          LIMIT 5'
    )->fetchAll();

    $sources = [];
    foreach ($pdo->query('SELECT source, COUNT(*) AS n FROM orders GROUP BY source')->fetchAll() as $r) {
        $sources[$r['source'] ?: 'Cart'] = (int) $r['n'];
    }

    $customers = (int) $pdo->query('SELECT COUNT(*) FROM users')->fetchColumn();
    $newToday  = (int) $pdo->query('SELECT COUNT(*) FROM orders WHERE DATE(placed_at) = CURDATE()')->fetchColumn();

    ok([
        'revenue'     => $revenue,
        'today'       => $today,
        'byStatus'    => $byStatus,
        'topItems'    => array_map(static fn(array $r): array => [
            'name'   => $r['name'],
            'qty'    => (int) $r['qty'],
            'amount' => (float) $r['amount'],
        ], $top),
        'sources'     => $sources,
        'customers'   => $customers,
        'newToday'    => $newToday,
    ]);
}
