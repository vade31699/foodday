<?php
declare(strict_types=1);

/**
 * FOODAY — emailed confirmation for creating an account.
 *
 * A new account is not created the moment the form is submitted. Instead the
 * details are held, pending, in signup_codes and a one-time code is emailed to
 * the address being registered. Only when that code comes back do the user row
 * and its first address go in together and the session open.
 *
 * This proves the person signing up can actually read the mailbox they are
 * registering, so accounts cannot be created around someone else's address.
 * The code is keyed on a per-pending-secret digest and, if set, MFA_PEPPER, and
 * it is compared in constant time exactly like the other emailed codes.
 *
 * Library only — no dispatcher and no side effects.
 */

require_once __DIR__ . '/mfa.php';

/** Drops any code already waiting for this address. */
function signup_code_clear(PDO $pdo, string $email): void
{
    $pdo->prepare('DELETE FROM signup_codes WHERE email = ?')->execute([strtolower(trim($email))]);
}

/** The pending signup for an address, or null when there is none. */
function signup_pending(PDO $pdo, string $email): ?array
{
    $stmt = $pdo->prepare(
        'SELECT *, (expires_at < NOW()) AS is_expired
           FROM signup_codes WHERE email = ? AND consumed_at IS NULL
          ORDER BY id DESC LIMIT 1'
    );
    $stmt->execute([strtolower(trim($email))]);
    $row = $stmt->fetch();
    return $row ?: null;
}

/**
 * Stores the pending signup and emails a fresh code, replacing any earlier one
 * so only the most recent email can be used. Refuses rather than promise a code
 * that can never arrive.
 *
 * @param array<string,mixed> $signup name, email, phone, password_hash and the
 *                                    address fields from address_input()
 * @return array{sent_to:string,expires_in:int}
 */
function signup_request_code(array $signup): array
{
    $email = strtolower(trim((string) ($signup['email'] ?? '')));
    if ($email === '' || !valid_email($email)) {
        throw new ApiError('Please enter a valid email address.');
    }
    foreach (['name', 'phone', 'password_hash', 'address'] as $key) {
        if ((string) ($signup[$key] ?? '') === '') {
            throw new ApiError('Please complete all required fields.');
        }
    }

    if (mail_configured_failure() !== '') {
        throw new ApiError(
            'A confirmation code is needed to finish creating your account, but email is not set up yet. '
            . mail_configured_failure(),
            503
        );
    }

    $pdo = db();
    $secret = mfa_new_secret();
    $code   = mfa_generate_code();

    signup_code_clear($pdo, $email);
    $pdo->prepare(
        'INSERT INTO signup_codes
            (email, code_hash, secret, name, phone, password_hash, label, address, landmark, lat, lng, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))'
    )->execute([
        $email,
        mfa_hash_code($code, $secret),
        $secret,
        (string) $signup['name'],
        (string) $signup['phone'],
        (string) $signup['password_hash'],
        (string) ($signup['label'] ?? 'Home'),
        (string) $signup['address'],
        ($signup['landmark'] ?? '') === '' ? null : (string) $signup['landmark'],
        $signup['lat'] ?? null,
        $signup['lng'] ?? null,
        mfa_code_ttl_minutes(),
    ]);

    $sent = signup_send_code($email, (string) $signup['name'], $code);
    if (!$sent['sent']) {
        // Never leave a live code the user was not told about.
        signup_code_clear($pdo, $email);
        throw new ApiError('The code could not be sent. ' . $sent['reason'], 502);
    }

    return [
        'sent_to'    => mask_email($email),
        'expires_in' => mfa_code_ttl_minutes(),
    ];
}

/**
 * Verifies a signup code and consumes it, returning the pending account details
 * so the caller can create the account. Throws on anything wrong, so the caller
 * only continues when the address itself was proven.
 *
 * @return array<string,mixed>
 */
function signup_verify_code(string $email, string $input): array
{
    $email = strtolower(trim($email));
    $input = strtoupper(preg_replace('/\D/', '', $input) ?? '');
    if ($input === '') {
        throw new ApiError('Enter the code we emailed you to finish creating your account.');
    }

    $pdo = db();
    $row = signup_pending($pdo, $email);
    if ($row === null) {
        throw new ApiError('Request a code for this email first, then enter it here.');
    }
    // is_expired comes from MySQL's NOW(), the same clock the expiry was set on.
    if ((int) $row['is_expired'] === 1) {
        signup_code_clear($pdo, $email);
        throw new ApiError('That code has expired. Request a new one.');
    }
    if ((int) $row['attempts'] >= mfa_max_attempts()) {
        signup_code_clear($pdo, $email);
        throw new ApiError('Too many wrong codes. Request a new one.');
    }

    if (!hash_equals((string) $row['code_hash'], mfa_hash_code($input, (string) $row['secret']))) {
        $pdo->prepare('UPDATE signup_codes SET attempts = attempts + 1 WHERE id = ?')
            ->execute([(int) $row['id']]);
        $left = mfa_max_attempts() - ((int) $row['attempts'] + 1);
        throw new ApiError(
            $left > 0
                ? 'That code is not correct. ' . $left . ' ' . ($left === 1 ? 'attempt' : 'attempts') . ' left.'
                : 'Too many wrong codes. Request a new one.'
        );
    }

    // Single use: gone the moment it has created one account.
    $pdo->prepare('DELETE FROM signup_codes WHERE id = ?')->execute([(int) $row['id']]);

    return $row;
}

/** Removes a pending signup once its account exists (or is abandoned). */
function signup_pending_clear(PDO $pdo, string $email): void
{
    signup_code_clear($pdo, $email);
}

/**
 * Sends the sign-up code. The wording names account creation, so a code that
 * arrives out of the blue is recognisable as something the reader did not ask
 * for.
 *
 * @return array{sent:bool,reason:string}
 */
function signup_send_code(string $to, string $name, string $code): array
{
    $minutes = mfa_code_ttl_minutes();
    $pretty  = mfa_format_code($code);

    $text = "Your FOODAY sign-up code is $pretty\n\n"
          . "It expires in $minutes minutes and can only be used once.\n"
          . "If you did not try to create a FOODAY account, ignore this email.\n";

    $html = '<div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#F7F1EC;padding:24px">'
          . '<div style="max-width:420px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">'
          . '<div style="background:#5B1A24;padding:18px 22px;color:#fff">'
          . '<div style="font-size:11px;letter-spacing:1.4px;opacity:.8">FOODAY</div>'
          . '<div style="font-size:16px;font-weight:700">Confirm your email</div>'
          . '</div>'
          . '<div style="padding:22px;color:#2B2320">'
          . '<p style="margin:0 0 14px;font-size:14px">Hi ' . htmlspecialchars($name) . ', use this code to finish creating your FOODAY account.</p>'
          . '<div style="font-size:32px;letter-spacing:8px;font-weight:700;background:#FBF3EF;border:1px solid #EAD9D0;'
          . 'border-radius:12px;padding:14px;text-align:center;color:#5B1A24">' . htmlspecialchars($pretty) . '</div>'
          . '<p style="margin:16px 0 0;font-size:12px;color:#7A6E68">This code expires in '
          . $minutes . ' minutes and works only once.</p>'
          . '<p style="margin:10px 0 0;font-size:12px;color:#7A6E68">If you did not try to create an account, you can ignore this email.</p>'
          . '</div></div></div>';

    return send_mail($to, "Your FOODAY sign-up code is $pretty", $html, $text);
}
