<?php
declare(strict_types=1);

/**
 * FOODAY — two-factor sign-in (MFA).
 *
 * Library only: this file has no dispatcher and no side effects, so config.php
 * can require it and any endpoint can use it. The endpoints are account.php
 * (customer) and admin.php (admin); both call the same helpers here, and
 * auth.php uses mfa_challenge_required() to hold a sign-in open.
 *
 * How a code actually protects an account
 * --------------------------------------
 * A 6-digit code has only a million possible values, so the code is never the
 * whole story. Four things stand in front of it:
 *
 *   1. The password must already be correct. A code is useless alone.
 *   2. Codes live ~10 minutes and are single-use. A new code supersedes any
 *      earlier one, so an old email stops working the moment a new one is sent.
 *   3. A wrong entry is simply refused: it does not count against the code and
 *      never retires it, so the code stays usable until it is used once or it
 *      expires. What limits guessing is that a fresh code may only be requested
 *      every few minutes (see code_resend_cooldown_minutes()), so the code
 *      space cannot be walked at speed.
 *   4. Codes are stored as HMAC-SHA256 digests, never in the clear, so a
 *      database dump cannot be walked to recover a live code.
 *
 * The digest is keyed on a per-account secret and, if set, MFA_PEPPER from .env.
 */

require_once __DIR__ . '/mailer.php';

/** Whether the pending sign-in is still waiting for a code. */
const MFA_CHALLENGE_TTL_MINUTES = 15;

/** Recovery codes handed over once, at enrolment. */
const MFA_RECOVERY_CODE_COUNT = 8;

/** Letters a human has to read aloud or retype, minus the easy-to-mistake ones. */
const MFA_RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* ---------------------------------------------------------------
 |  Small helpers
 * --------------------------------------------------------------- */

function mfa_code_ttl_minutes(): int
{
    return max(2, min(60, env_int('MFA_CODE_TTL_MINUTES', 10)));
}

/**
 * How long an existing code must sit before another may be requested for the
 * same account. Wrong entries never retire a code, so this cooldown — not an
 * attempts budget — is what keeps the inbox from being hammered.
 */
function code_resend_cooldown_minutes(): int
{
    return max(0, min(60, env_int('CODE_RESEND_COOLDOWN_MINUTES', 3)));
}

/**
 * Seconds left before a new code may be requested for the same key, or 0 when
 * one may be requested now. `$sql` must return the age in seconds of the most
 * recent *live* code for the key (or NULL/false when there is none), so a code
 * that was already used or has expired never blocks a fresh request.
 *
 * @param array<int,mixed> $params
 */
function code_reissue_wait(PDO $pdo, string $sql, array $params): int
{
    $cooldown = code_resend_cooldown_minutes();
    if ($cooldown <= 0) {
        return 0;
    }
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $age = $stmt->fetchColumn();
    if ($age === false || $age === null || $age === '') {
        return 0;
    }
    return max(0, $cooldown * 60 - (int) $age);
}

/** The refusal raised while the code already sent is still too new to replace. */
function code_reissue_error(int $wait): ApiError
{
    $minutes = max(1, (int) ceil($wait / 60));
    return new ApiError(
        'A code was just sent. Please wait about ' . $minutes . ' minute' . ($minutes === 1 ? '' : 's')
        . ' before requesting another one.'
    );
}

function mfa_recovery_code_count(): int
{
    return MFA_RECOVERY_CODE_COUNT;
}

/**
 * Resolves who is asking, so the customer and admin sides share one code path.
 *
 * @return array{type:string,id:int,email:string,name:string}|null
 */
function mfa_actor(): ?array
{
    $admin = current_admin_data();
    if ($admin !== null) {
        return [
            'type'  => 'admin',
            'id'    => (int) $admin['id'],
            'email' => (string) $admin['email'],
            'name'  => (string) $admin['name'],
        ];
    }

    $user = current_user();
    if ($user !== null) {
        return [
            'type'  => 'user',
            'id'    => (int) $user['id'],
            'email' => (string) $user['email'],
            'name'  => (string) $user['name'],
        ];
    }

    return null;
}

/** The signed-in actor, or an error if there is nobody. */
function mfa_require_actor(): array
{
    $actor = mfa_actor();
    if ($actor === null) {
        throw new ApiError('Please sign in to continue.', 401);
    }
    return $actor;
}

/* ---------------------------------------------------------------
 |  Codes and digests
 * --------------------------------------------------------------- */

function mfa_pepper(): string
{
    return env('MFA_PEPPER', '');
}

/** A fresh per-account secret, used to key that account's digests. */
function mfa_new_secret(): string
{
    return bin2hex(random_bytes(32));
}

/**
 * A 6-digit code from a CSPRNG — never random_int's weaker cousins.
 * Zero-padded, so it is always six digits to read and retype.
 */
function mfa_generate_code(): string
{
    return str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
}

/** The code as it is emailed and typed: six digits, no spaces. */
function mfa_format_code(string $code): string
{
    return preg_replace('/\D/', '', $code) ?? $code;
}

function mfa_hash_code(string $code, string $secret): string
{
    return hash_hmac('sha256', strtoupper(preg_replace('/\D/', '', $code) ?? $code), $secret . mfa_pepper());
}

/** Recovery codes are typed by hand, so they stay short and grouped. */
function mfa_new_recovery_codes(int $count = MFA_RECOVERY_CODE_COUNT): array
{
    $codes = [];
    for ($i = 0; $i < $count; $i++) {
        $raw = '';
        for ($g = 0; $g < 3; $g++) {
            for ($c = 0; $c < 4; $c++) {
                $raw .= MFA_RECOVERY_ALPHABET[random_int(0, strlen(MFA_RECOVERY_ALPHABET) - 1)];
            }
            $raw .= $g === 2 ? '' : '-';
        }
        $codes[] = $raw;
    }
    return array_values(array_unique($codes));
}

function mfa_hash_recovery(string $code, string $secret): string
{
    return hash_hmac('sha256', strtoupper(trim($code)), $secret . mfa_pepper());
}

/* ---------------------------------------------------------------
 |  Storage
 * --------------------------------------------------------------- */

/**
 * Fetches the MFA row, creating an empty one on first use.
 *
 * @return array<string,mixed>|null null when the actor type is unknown
 */
function mfa_account(PDO $pdo, string $type, int $id): ?array
{
    if (!in_array($type, ['admin', 'user'], true)) {
        return null;
    }

    $stmt = $pdo->prepare(
        'SELECT *, (pending_expires_at IS NOT NULL AND pending_expires_at < NOW()) AS pending_expired
           FROM mfa_accounts WHERE actor_type = ? AND actor_id = ?'
    );
    $stmt->execute([$type, $id]);
    $row = $stmt->fetch();

    if (!$row) {
        $ins = $pdo->prepare('INSERT IGNORE INTO mfa_accounts (actor_type, actor_id, secret) VALUES (?, ?, ?)');
        $ins->execute([$type, $id, mfa_new_secret()]);
        $stmt->execute([$type, $id]);
        $row = $stmt->fetch();
    }

    return $row ?: null;
}

function mfa_is_enabled(PDO $pdo, string $type, int $id): bool
{
    $row = mfa_account($pdo, $type, $id);
    return $row !== null && (int) $row['enabled'] === 1;
}

/** True when this actor must clear a code before a session is granted. */
function mfa_challenge_required(PDO $pdo, string $type, int $id): bool
{
    return mfa_is_enabled($pdo, $type, $id);
}

/* ---------------------------------------------------------------
 |  Email delivery
 * --------------------------------------------------------------- */

/**
 * Sends a one-time code. Returns the send result so callers can refuse to
 * continue rather than tell someone to check an inbox that will stay empty.
 *
 * @return array{sent:bool,reason:string}
 */
function mfa_send_code(string $to, string $name, string $code, string $purpose): array
{
    $minutes = mfa_code_ttl_minutes();
    $pretty  = mfa_format_code($code);

    $text = "Your FOODAY $purpose code is $pretty\n\n"
          . "It expires in $minutes minutes and can only be used once.\n"
          . "If you did not try to sign in, change your password now.\n";

    $html = '<div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#F7F1EC;padding:24px">'
          . '<div style="max-width:420px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">'
          . '<div style="background:#5B1A24;padding:18px 22px;color:#fff">'
          . '<div style="font-size:11px;letter-spacing:1.4px;opacity:.8">FOODAY</div>'
          . '<div style="font-size:16px;font-weight:700">' . htmlspecialchars(ucfirst($purpose)) . ' code</div>'
          . '</div>'
          . '<div style="padding:22px;color:#2B2320">'
          . '<p style="margin:0 0 14px;font-size:14px">Hi ' . htmlspecialchars($name) . ', use this code to finish signing in.</p>'
          . '<div style="font-size:32px;letter-spacing:8px;font-weight:700;background:#FBF3EF;border:1px solid #EAD9D0;'
          . 'border-radius:12px;padding:14px;text-align:center;color:#5B1A24">' . htmlspecialchars($pretty) . '</div>'
          . '<p style="margin:16px 0 0;font-size:12px;color:#7A6E68">This code expires in '
          . $minutes . ' minutes and works only once.</p>'
          . '<p style="margin:10px 0 0;font-size:12px;color:#7A6E68">If you did not try to sign in, change your password right away.</p>'
          . '</div></div></div>';

    return send_mail($to, "Your FOODAY $purpose code is $pretty", $html, $text);
}

/* ---------------------------------------------------------------
 |  Enrolment
 * --------------------------------------------------------------- */

/**
 * Sends the enrolment code. The account password must be re-entered first, so a
 * walked-up-to or borrowed session cannot start switching the second factor on.
 * Refuses when mail is unusable — enabling MFA you can never complete would lock
 * the account out of its own dashboard.
 */
function mfa_start_enrollment(array $actor, string $password): array
{
    $pdo = db();

    $table = $actor['type'] === 'admin' ? 'admins' : 'users';
    $stmt = $pdo->prepare("SELECT password FROM `$table` WHERE id = ?");
    $stmt->execute([$actor['id']]);
    if (!password_matches($password, (string) $stmt->fetchColumn())) {
        throw new ApiError('Please enter your current password to turn two-factor sign-in on.');
    }

    if (mail_configured_failure() !== '') {
        throw new ApiError(
            'Two-factor sign-in cannot be switched on yet. ' . mail_configured_failure(),
            503
        );
    }

    $account = mfa_account($pdo, $actor['type'], $actor['id']);
    if ($account === null) {
        throw new ApiError('Account not found.', 404);
    }
    if ((int) $account['enabled'] === 1) {
        throw new ApiError('Two-factor sign-in is already switched on for this account.');
    }

    // A setup code that was just emailed is not replaced yet. It lives on the
    // account row rather than in mfa_codes, so its age is derived from its
    // expiry — computed by MySQL, so it never drifts against PHP's clock.
    $wait = code_reissue_wait(
        $pdo,
        'SELECT TIMESTAMPDIFF(SECOND, DATE_SUB(pending_expires_at, INTERVAL ? MINUTE), NOW())
           FROM mfa_accounts
          WHERE actor_type = ? AND actor_id = ?
            AND pending_expires_at IS NOT NULL AND pending_expires_at > NOW()',
        [mfa_code_ttl_minutes(), $actor['type'], $actor['id']]
    );
    if ($wait > 0) {
        throw code_reissue_error($wait);
    }

    $code = mfa_generate_code();
    $up = $pdo->prepare(
        'UPDATE mfa_accounts
            SET pending_hash = ?, pending_expires_at = DATE_ADD(NOW(), INTERVAL ? MINUTE)
          WHERE actor_type = ? AND actor_id = ?'
    );
    $up->execute([mfa_hash_code($code, (string) $account['secret']), mfa_code_ttl_minutes(), $actor['type'], $actor['id']]);

    $sent = mfa_send_code($actor['email'], $actor['name'], $code, 'setup');
    if (!$sent['sent']) {
        // Do not leave a pending code behind that the user was never told about.
        $pdo->prepare('UPDATE mfa_accounts SET pending_hash = NULL, pending_expires_at = NULL
                       WHERE actor_type = ? AND actor_id = ?')->execute([$actor['type'], $actor['id']]);
        throw new ApiError('The code could not be sent. ' . $sent['reason'], 502);
    }

    return [
        'sent_to'    => mask_email($actor['email']),
        'expires_in' => mfa_code_ttl_minutes(),
    ];
}

/**
 * Confirms the enrolment code and switches MFA on.
 * @return array<string,mixed>
 */
function mfa_confirm_enrollment(array $actor, string $code): array
{
    $pdo = db();
    $account = mfa_account($pdo, $actor['type'], $actor['id']);
    if ($account === null) {
        throw new ApiError('Account not found.', 404);
    }
    if ((int) $account['enabled'] === 1) {
        throw new ApiError('Two-factor sign-in is already switched on for this account.');
    }

    $pending = (string) ($account['pending_hash'] ?? '');
    if ($pending === '' || $account['pending_expires_at'] === null) {
        throw new ApiError('Request a new code first — there is no setup code waiting.');
    }
    // Compared by the database, not by PHP: the column is written with NOW() on
    // the server, so asking PHP's clock about it would drift by the MySQL/PHP
    // timezone offset and either expire codes early or let them run on.
    if ((int) ($account['pending_expired'] ?? 0) === 1) {
        throw new ApiError('That setup code has expired. Request a new one.');
    }

    if (!hash_equals($pending, mfa_hash_code($code, (string) $account['secret']))) {
        throw new ApiError('That code is not correct. Check the email and try again, or request a new code.');
    }

    // The plain recovery codes are returned exactly once, here, and only their
    // digests are kept. There is no way to show them again later.
    $recovery = mfa_new_recovery_codes();

    $up = $pdo->prepare(
        'UPDATE mfa_accounts
            SET enabled = 1, enabled_at = NOW(), last_used_at = NULL,
                pending_hash = NULL, pending_expires_at = NULL,
                recovery_hashes = ?
          WHERE actor_type = ? AND actor_id = ?'
    );
    $up->execute([
        json_encode(array_map(static fn(string $c): string => mfa_hash_recovery($c, (string) $account['secret']), $recovery)),
        $actor['type'],
        $actor['id'],
    ]);

    // Enabling a second factor ends other sessions, so a stolen one is useless.
    // That also retires the session doing the enabling, so the caller is told to
    // make the user sign in again rather than discovering it on the next click.
    mfa_bump_auth_version($pdo, $actor);

    return [
        'enabled'         => true,
        'recovery_codes'  => $recovery,
        'reauth_required' => true,
    ];
}

/** Switches MFA off. The account password must be re-entered to confirm. */
function mfa_disable(array $actor, string $password, string $code = ''): void
{
    $pdo = db();
    $account = mfa_account($pdo, $actor['type'], $actor['id']);
    if ($account === null || (int) $account['enabled'] !== 1) {
        throw new ApiError('Two-factor sign-in is not switched on for this account.');
    }

    $table = $actor['type'] === 'admin' ? 'admins' : 'users';
    $stmt = $pdo->prepare("SELECT password FROM `$table` WHERE id = ?");
    $stmt->execute([$actor['id']]);
    if (!password_matches($password, (string) $stmt->fetchColumn())) {
        throw new ApiError('Please enter your current password to turn two-factor sign-in off.');
    }

    // A live code also authorises turning it off, so a stolen session alone
    // cannot remove the second factor.
    if ($code !== '') {
        $check = mfa_verify_code($pdo, $actor, $code, true);
        if (!$check['ok']) {
            throw new ApiError($check['reason']);
        }
    }

    $pdo->prepare(
        'UPDATE mfa_accounts
            SET enabled = 0, enabled_at = NULL, recovery_hashes = NULL, last_used_at = NULL
          WHERE actor_type = ? AND actor_id = ?'
    )->execute([$actor['type'], $actor['id']]);

    mfa_delete_challenges($pdo, $actor['type'], $actor['id']);
}

function mfa_bump_auth_version(PDO $pdo, array $actor): void
{
    $table = $actor['type'] === 'admin' ? 'admins' : 'users';
    $pdo->prepare("UPDATE `$table` SET auth_version = auth_version + 1 WHERE id = ?")
        ->execute([$actor['id']]);
}

/* ---------------------------------------------------------------
 |  Sign-in challenge
 * --------------------------------------------------------------- */

/**
 * The live sign-in code still waiting for this actor, with its age and the
 * seconds left before it expires. NULL when there is none (used, replaced or
 * expired).
 *
 * @return array{age_secs:int,left_secs:int}|null
 */
function mfa_live_challenge(PDO $pdo, string $type, int $id): ?array
{
    $stmt = $pdo->prepare(
        'SELECT TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age_secs,
                TIMESTAMPDIFF(SECOND, NOW(), expires_at)  AS left_secs
           FROM mfa_codes
          WHERE actor_type = ? AND actor_id = ? AND consumed_at IS NULL AND expires_at > NOW()
          ORDER BY id DESC LIMIT 1'
    );
    $stmt->execute([$type, $id]);
    $row = $stmt->fetch();
    return $row ?: null;
}

/**
 * Issues a fresh sign-in code and retires every earlier one, so only the most
 * recent email can be used.
 *
 * With $reuseLive true — the sign-in path — a code already sent a moment ago
 * is handed back instead of being replaced, so a second attempt within the
 * resend cooldown still lands on the code step rather than being refused. With
 * it false — an explicit "send a new code" — a too-recent code is refused, so
 * the inbox cannot be flooded.
 *
 * @return array{sent:bool,reason:string,masked:string,expires_in:int}
 */
function mfa_issue_challenge(PDO $pdo, array $actor, string $secret, bool $reuseLive = false): array
{
    $live = mfa_live_challenge($pdo, $actor['type'], $actor['id']);
    if ($live !== null) {
        $wait = max(0, code_resend_cooldown_minutes() * 60 - (int) $live['age_secs']);
        if ($wait > 0) {
            if ($reuseLive) {
                return [
                    'sent'       => true,
                    'reason'     => '',
                    'masked'     => mask_email($actor['email']),
                    'expires_in' => max(1, (int) ceil(((int) $live['left_secs']) / 60)),
                ];
            }
            throw code_reissue_error($wait);
        }
    }

    mfa_delete_challenges($pdo, $actor['type'], $actor['id']);

    $code = mfa_generate_code();
    $stmt = $pdo->prepare(
        'INSERT INTO mfa_codes (actor_type, actor_id, code_hash, expires_at)
         VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))'
    );
    $stmt->execute([$actor['type'], $actor['id'], mfa_hash_code($code, $secret), mfa_code_ttl_minutes()]);

    $sent = mfa_send_code($actor['email'], $actor['name'], $code, 'sign-in');
    if (!$sent['sent']) {
        mfa_delete_challenges($pdo, $actor['type'], $actor['id']);
    }

    return [
        'sent'       => $sent['sent'],
        'reason'     => $sent['reason'],
        'masked'     => mask_email($actor['email']),
        'expires_in' => mfa_code_ttl_minutes(),
    ];
}

function mfa_delete_challenges(PDO $pdo, string $type, int $id): void
{
    $pdo->prepare('DELETE FROM mfa_codes WHERE actor_type = ? AND actor_id = ?')->execute([$type, $id]);
}

/**
 * Checks a code, or a recovery code, against the live challenge.
 *
 * @return array{ok:bool,reason:string,recovery_used:bool}
 */
function mfa_verify_code(PDO $pdo, array $actor, string $input, bool $allowRecovery = true): array
{
    $input = strtoupper(trim($input));
    if ($input === '') {
        return ['ok' => false, 'reason' => 'Enter the code from your email.', 'recovery_used' => false];
    }

    $account = mfa_account($pdo, $actor['type'], $actor['id']);
    if ($account === null) {
        return ['ok' => false, 'reason' => 'Account not found.', 'recovery_used' => false];
    }
    $secret = (string) $account['secret'];

    $stmt = $pdo->prepare(
        'SELECT *, (expires_at < NOW()) AS is_expired
           FROM mfa_codes
          WHERE actor_type = ? AND actor_id = ? AND consumed_at IS NULL
          ORDER BY id DESC LIMIT 1'
    );
    $stmt->execute([$actor['type'], $actor['id']]);
    $challenge = $stmt->fetch();

    // A recovery code is checked first and needs no live challenge, because the
    // moment someone actually needs one is when the mailbox is gone and the
    // emailed code is unreachable. It carries ~60 bits, so it is not guessable
    // the way a 6-digit code is, and login_is_blocked() still rate limits it.
    if ($allowRecovery && preg_match('/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/', $input)) {
        $hashes = json_decode((string) ($account['recovery_hashes'] ?? '[]'), true);
        if (is_array($hashes)) {
            foreach ($hashes as $h) {
                if (hash_equals((string) $h, mfa_hash_recovery($input, $secret))) {
                    if ($challenge && !$challenge['consumed_at']) {
                        mfa_consume_challenge($pdo, (int) $challenge['id']);
                    }
                    mfa_spend_recovery_code($pdo, $actor, (string) $h);
                    return ['ok' => true, 'reason' => '', 'recovery_used' => true];
                }
            }
        }
        return ['ok' => false, 'reason' => 'That recovery code is not valid.', 'recovery_used' => false];
    }

    if (!$challenge) {
        return ['ok' => false, 'reason' => 'Request a new code to sign in.', 'recovery_used' => false];
    }
    // is_expired comes from MySQL's NOW() — see mfa_account() for why.
    if ((int) $challenge['is_expired'] === 1) {
        mfa_delete_challenges($pdo, $actor['type'], $actor['id']);
        return ['ok' => false, 'reason' => 'That code has expired. Request a new one.', 'recovery_used' => false];
    }

    // A wrong entry never counts against the code and never retires it: the
    // code stays live until it is used once, replaced by a newer one, or it
    // expires. Requesting a replacement is what the resend cooldown limits.
    if (!hash_equals((string) $challenge['code_hash'], mfa_hash_code($input, $secret))) {
        return ['ok' => false, 'reason' => 'That code is not correct. Check your email and try again.', 'recovery_used' => false];
    }

    mfa_consume_challenge($pdo, (int) $challenge['id']);

    return ['ok' => true, 'reason' => '', 'recovery_used' => false];
}

function mfa_consume_challenge(PDO $pdo, int $id): void
{
    $pdo->prepare('UPDATE mfa_codes SET consumed_at = NOW() WHERE id = ?')->execute([$id]);
}

function mfa_spend_recovery_code(PDO $pdo, array $actor, string $usedHash): void
{
    $account = mfa_account($pdo, $actor['type'], $actor['id']);
    $hashes = json_decode((string) ($account['recovery_hashes'] ?? '[]'), true);
    if (!is_array($hashes)) {
        return;
    }
    $left = array_values(array_filter($hashes, static fn($h): bool => !hash_equals((string) $usedHash, (string) $h)));
    $pdo->prepare('UPDATE mfa_accounts SET recovery_hashes = ? WHERE actor_type = ? AND actor_id = ?')
        ->execute([json_encode($left), $actor['type'], $actor['id']]);
}

/* ---------------------------------------------------------------
 |  Status for the settings screen
 * --------------------------------------------------------------- */

/** @return array<string,mixed> */
function mfa_status_payload(array $actor): array
{
    $pdo = db();
    $account = mfa_account($pdo, $actor['type'], $actor['id']);
    $enabled = $account !== null && (int) $account['enabled'] === 1;

    $hashes = json_decode((string) ($account['recovery_hashes'] ?? '[]'), true);
    $left = is_array($hashes) ? count($hashes) : 0;

    return [
        'enabled'        => $enabled,
        'masked_email'   => mask_email($actor['email']),
        'recovery_left'  => $left,
        'recovery_total' => MFA_RECOVERY_CODE_COUNT,
        'enabled_at'     => $account['enabled_at'] ?? null,
        'last_used_at'   => $account['last_used_at'] ?? null,
        'mail_ready'     => mail_available(),
        'mail_problem'   => mail_configured_failure(),
        'code_minutes'   => mfa_code_ttl_minutes(),
    ];
}

function mfa_mark_used(PDO $pdo, string $type, int $id): void
{
    $pdo->prepare('UPDATE mfa_accounts SET last_used_at = NOW() WHERE actor_type = ? AND actor_id = ?')
        ->execute([$type, $id]);
}
