<?php
declare(strict_types=1);

/**
 * FOODAY — emailed confirmation codes for sensitive account changes.
 *
 * Changing the email an account signs in with, or its password, is the kind of
 * move that takes an account away from its owner. So both require a one-time
 * code delivered to the address already on file, whether or not two-factor
 * sign-in is switched on. The code proves the person making the change can read
 * the account's current mailbox, which a stolen session alone cannot.
 *
 * This is deliberately separate from mfa_codes: two-factor is optional and can
 * be turned off, but this confirmation is always required. The two flows share
 * only the code generator, the per-account secret and the mail transport.
 *
 * Library only — no dispatcher and no side effects.
 */

require_once __DIR__ . '/mfa.php';

const CHANGE_PURPOSES = ['email', 'password'];

function change_purpose_valid(string $purpose): bool
{
    return in_array($purpose, CHANGE_PURPOSES, true);
}

/** A human label for the change the code authorises, used in the email. */
function change_purpose_label(string $purpose): string
{
    return $purpose === 'email' ? 'email change' : 'password change';
}

/** Retires any live code for this actor and purpose, so only one can be used. */
function change_codes_clear(PDO $pdo, string $type, int $id, string $purpose): void
{
    $pdo->prepare('DELETE FROM change_codes WHERE actor_type = ? AND actor_id = ? AND purpose = ?')
        ->execute([$type, $id, $purpose]);
}

/**
 * Emails a fresh confirmation code for the change, replacing any earlier one.
 * Refuses rather than promise a code that can never arrive.
 *
 * @return array{sent_to:string,expires_in:int}
 */
function change_request_code(array $actor, string $purpose): array
{
    if (!change_purpose_valid($purpose)) {
        throw new ApiError('Unknown confirmation type.', 400);
    }
    if (mail_configured_failure() !== '') {
        throw new ApiError(
            'A confirmation code is needed for this change, but email is not set up yet. '
            . mail_configured_failure(),
            503
        );
    }

    $pdo = db();
    // mfa_account() creates the row on first use, so the per-account secret the
    // digest is keyed on exists even for an account that never turned on 2FA.
    $account = mfa_account($pdo, $actor['type'], $actor['id']);
    if ($account === null) {
        throw new ApiError('Account not found.', 404);
    }

    $code = mfa_generate_code();
    change_codes_clear($pdo, $actor['type'], $actor['id'], $purpose);
    $pdo->prepare(
        'INSERT INTO change_codes (actor_type, actor_id, purpose, code_hash, expires_at)
         VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))'
    )->execute([
        $actor['type'],
        $actor['id'],
        $purpose,
        mfa_hash_code($code, (string) $account['secret']),
        mfa_code_ttl_minutes(),
    ]);

    $sent = change_send_code($actor['email'], $actor['name'], $code, $purpose);
    if (!$sent['sent']) {
        // Never leave a live code the user was not told about.
        change_codes_clear($pdo, $actor['type'], $actor['id'], $purpose);
        throw new ApiError('The code could not be sent. ' . $sent['reason'], 502);
    }

    return [
        'sent_to'    => mask_email($actor['email']),
        'expires_in' => mfa_code_ttl_minutes(),
    ];
}

/**
 * Verifies a confirmation code and consumes it. Throws on anything wrong, so
 * callers only continue when the code really authorised the change.
 */
function change_verify_code(array $actor, string $purpose, string $input): void
{
    if (!change_purpose_valid($purpose)) {
        throw new ApiError('Unknown confirmation type.', 400);
    }

    $input = strtoupper(preg_replace('/\D/', '', $input) ?? '');
    if ($input === '') {
        throw new ApiError('Enter the code we emailed you to confirm this change.');
    }

    $pdo = db();
    $account = mfa_account($pdo, $actor['type'], $actor['id']);
    if ($account === null) {
        throw new ApiError('Account not found.', 404);
    }

    $stmt = $pdo->prepare(
        'SELECT id, code_hash, attempts, (expires_at < NOW()) AS is_expired
           FROM change_codes
          WHERE actor_type = ? AND actor_id = ? AND purpose = ? AND consumed_at IS NULL
          ORDER BY id DESC LIMIT 1'
    );
    $stmt->execute([$actor['type'], $actor['id'], $purpose]);
    $row = $stmt->fetch();

    if (!$row) {
        throw new ApiError('Request a confirmation code first, then enter it here.');
    }
    // is_expired comes from MySQL's NOW(), the same clock the expiry was set on.
    if ((int) $row['is_expired'] === 1) {
        change_codes_clear($pdo, $actor['type'], $actor['id'], $purpose);
        throw new ApiError('That code has expired. Request a new one.');
    }
    if ((int) $row['attempts'] >= mfa_max_attempts()) {
        change_codes_clear($pdo, $actor['type'], $actor['id'], $purpose);
        throw new ApiError('Too many wrong codes. Request a new one.');
    }

    if (!hash_equals((string) $row['code_hash'], mfa_hash_code($input, (string) $account['secret']))) {
        $pdo->prepare('UPDATE change_codes SET attempts = attempts + 1 WHERE id = ?')
            ->execute([(int) $row['id']]);
        $left = mfa_max_attempts() - ((int) $row['attempts'] + 1);
        throw new ApiError(
            $left > 0
                ? 'That code is not correct. ' . $left . ' ' . ($left === 1 ? 'attempt' : 'attempts') . ' left.'
                : 'Too many wrong codes. Request a new one.'
        );
    }

    // Single use: gone the moment it has authorised one change.
    $pdo->prepare('DELETE FROM change_codes WHERE id = ?')->execute([(int) $row['id']]);
}

/**
 * Sends the confirmation code. Wording names the change, so a code that arrives
 * out of the blue is recognisable as something the reader did not ask for.
 *
 * @return array{sent:bool,reason:string}
 */
function change_send_code(string $to, string $name, string $code, string $purpose): array
{
    $minutes = mfa_code_ttl_minutes();
    $pretty  = mfa_format_code($code);
    $label   = change_purpose_label($purpose);

    $text = "Your FOODAY $label code is $pretty\n\n"
          . "It expires in $minutes minutes and can only be used once.\n"
          . "If you did not ask to change your " . ($purpose === 'email' ? 'email address' : 'password')
          . ", ignore this email and change your password now.\n";

    $html = '<div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#F7F1EC;padding:24px">'
          . '<div style="max-width:420px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">'
          . '<div style="background:#5B1A24;padding:18px 22px;color:#fff">'
          . '<div style="font-size:11px;letter-spacing:1.4px;opacity:.8">FOODAY</div>'
          . '<div style="font-size:16px;font-weight:700">Confirm your ' . htmlspecialchars($label) . '</div>'
          . '</div>'
          . '<div style="padding:22px;color:#2B2320">'
          . '<p style="margin:0 0 14px;font-size:14px">Hi ' . htmlspecialchars($name) . ', use this code to confirm the change to your account.</p>'
          . '<div style="font-size:32px;letter-spacing:8px;font-weight:700;background:#FBF3EF;border:1px solid #EAD9D0;'
          . 'border-radius:12px;padding:14px;text-align:center;color:#5B1A24">' . htmlspecialchars($pretty) . '</div>'
          . '<p style="margin:16px 0 0;font-size:12px;color:#7A6E68">This code expires in '
          . $minutes . ' minutes and works only once.</p>'
          . '<p style="margin:10px 0 0;font-size:12px;color:#7A6E68">If you did not ask for this, ignore this email and change your password right away.</p>'
          . '</div></div></div>';

    return send_mail($to, "Your FOODAY $label code is $pretty", $html, $text);
}
