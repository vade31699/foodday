<?php
declare(strict_types=1);

/**
 * FOODAY — the emailed one-time code policy.
 *
 * Every emailed code (two-factor sign-in, sign-up and email/password change) is
 * six digits with no spaces, single-use, and cannot be replaced for a few
 * minutes. A wrong entry is not counted as an attempt and does not retire the
 * code. These are the parts that can be checked without a database: the code
 * formatter, the resend cooldown length, and the source contracts that keep the
 * attempt counter and the cooldown in the three verification paths.
 *
 * Run with:  php tests/email-code.test.php
 */

require __DIR__ . '/../api/config.php';
require __DIR__ . '/harness.php';

$mfaPhp    = file_get_contents(__DIR__ . '/../api/mfa.php');
$changePhp = file_get_contents(__DIR__ . '/../api/change_codes.php');
$signupPhp = file_get_contents(__DIR__ . '/../api/signup_codes.php');

test('a code is six digits with no spaces', function (): void {
    expect_same('043921', mfa_format_code('043921'), 'a plain code is unchanged');
    expect_same('043921', mfa_format_code('04 3921'), 'a spaced code loses the space');
    expect_same('043921', mfa_format_code('043-921'), 'and so does a dashed one');
    expect_same('043921', mfa_format_code(' 043921 '), 'surrounding space is trimmed too');
    expect_true(preg_match('/^\d{6}$/', mfa_format_code('043921')) === 1, 'the result is exactly six digits');
});

test('the emailed code is never re-spaced', function () use ($mfaPhp, $changePhp, $signupPhp): void {
    expect_true(!str_contains($mfaPhp, 'chunk_split'), 'the old spacing helper is gone');
    foreach (['mfa_send_code', 'change_send_code', 'signup_send_code'] as $fn) {
        $file = $fn === 'change_send_code' ? $changePhp : ($fn === 'signup_send_code' ? $signupPhp : $mfaPhp);
        expect_true(str_contains($file, "function $fn"), $fn . ' exists');
    }
});

test('the resend cooldown defaults to three minutes and is clamped', function (): void {
    putenv('CODE_RESEND_COOLDOWN_MINUTES');
    expect_same(3, code_resend_cooldown_minutes(), 'the default is three minutes');

    putenv('CODE_RESEND_COOLDOWN_MINUTES=7');
    expect_same(7, code_resend_cooldown_minutes(), 'a configured value is used');

    putenv('CODE_RESEND_COOLDOWN_MINUTES=999');
    expect_same(60, code_resend_cooldown_minutes(), 'an absurd value is clamped down');

    putenv('CODE_RESEND_COOLDOWN_MINUTES=-4');
    expect_same(0, code_resend_cooldown_minutes(), 'a negative value becomes no cooldown');

    putenv('CODE_RESEND_COOLDOWN_MINUTES');
});

test('the resend refusal names how long to wait', function (): void {
    $error = code_reissue_error(45);
    expect_true($error instanceof ApiError, 'it is a user-facing error');
    expect_true(str_contains($error->getMessage(), '1 minute'), 'a 45 second wait rounds up to a minute');
    expect_true(str_contains(code_reissue_error(121)->getMessage(), '3 minutes'), '121 seconds rounds up to three');
});

test('every code request path enforces the cooldown', function () use ($mfaPhp, $changePhp, $signupPhp): void {
    // Each request function must consult the cooldown before issuing a new code,
    // either directly (code_resend_cooldown_minutes) or through code_reissue_wait().
    $consulted = static fn(string $body): bool =>
        str_contains($body, 'code_reissue_wait(') || str_contains($body, 'code_resend_cooldown_minutes(');

    $mfaIssue  = substr($mfaPhp, strpos($mfaPhp, 'function mfa_issue_challenge'));
    $changeReq = substr($changePhp, strpos($changePhp, 'function change_request_code'));
    $signupReq = substr($signupPhp, strpos($signupPhp, 'function signup_request_code'));

    expect_true($consulted($mfaIssue), 'two-factor sign-in respects the cooldown');
    expect_true($consulted($changeReq), 'the email/password change respects it');
    expect_true($consulted($signupReq), 'sign-up respects it');
});

test('a second sign-in reuses the live code instead of being refused', function () use ($mfaPhp, $changePhp, $signupPhp): void {
    $authPhp = file_get_contents(__DIR__ . '/../api/auth.php');
    expect_true(str_contains($mfaPhp, 'function mfa_issue_challenge(PDO $pdo, array $actor, string $secret, bool $reuseLive = false)'),
        'the challenge issuer can reuse a live code');
    expect_true(str_contains($mfaPhp, 'function mfa_live_challenge('), 'there is a way to read the live code');
    $hold = substr($authPhp, strpos($authPhp, 'function mfa_hold_for_code'));
    expect_true(str_contains($hold, 'mfa_issue_challenge($pdo, $actor, (string) $account[\'secret\'], true)'),
        'signing in reuses the code rather than refusing');
});

test('a wrong code is never counted as an attempt', function () use ($mfaPhp, $changePhp, $signupPhp): void {
    foreach (['mfa.php' => $mfaPhp, 'change_codes.php' => $changePhp, 'signup_codes.php' => $signupPhp] as $name => $source) {
        expect_true(!str_contains($source, 'attempts = attempts + 1'), $name . ' no longer increments attempts');
        expect_true(!str_contains($source, 'mfa_max_attempts'), $name . ' no longer has an attempts budget');
        expect_true(str_contains($source, 'That code is not correct'), $name . ' still refuses a wrong code plainly');
    }
});

test('a code is still single-use', function () use ($mfaPhp, $changePhp, $signupPhp): void {
    expect_true(str_contains($mfaPhp, 'mfa_consume_challenge('), 'the sign-in code is consumed');
    expect_true(str_contains($changePhp, 'DELETE FROM change_codes WHERE id = ?'), 'the change code is deleted on use');
    expect_true(str_contains($signupPhp, 'DELETE FROM signup_codes WHERE id = ?'), 'the signup code is deleted on use');
});

finish('email-code');
