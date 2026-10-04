<?php
declare(strict_types=1);

/**
 * FOODAY — unit tests for the password policy in api/config.php.
 *
 * "Require letters and numbers" used to be a setting an admin could switch off,
 * which meant a password could be weakened by turning it off. It is now a fixed
 * rule, and these tests pin that: the rule holds whatever the settings table
 * says, including a row left over from an older install.
 *
 * The minimum length is still a setting, because a stricter floor is a matter of
 * taste rather than of security, so it is tested as one.
 *
 * No database is needed: settings_all() falls back to an empty map when it cannot
 * reach one, and these tests write the settings map directly anyway.
 *
 * Run with:  php tests/password-policy.test.php
 */

require __DIR__ . '/../api/config.php';
require __DIR__ . '/harness.php';

/** Puts a settings row in place, as a save_settings() call would leave it. */
function with_settings(array $rows, callable $body): void
{
    $saved = $GLOBALS['__fooday_settings'] ?? null;
    $GLOBALS['__fooday_settings'] = $rows;
    try {
        $body();
    } finally {
        $GLOBALS['__fooday_settings'] = $saved;
    }
}

/* ---------- letters and numbers, always ---------- */

test('letters on their own are refused', function (): void {
    with_settings([], function (): void {
        $problem = password_problem('foodayonly');

        expect_true($problem !== null, 'a password with no number was accepted');
        expect_same('Password must contain both letters and numbers.', $problem, 'and says what is missing');
    });
});

test('numbers on their own are refused', function (): void {
    with_settings([], function (): void {
        expect_same(
            'Password must contain both letters and numbers.',
            password_problem('12345678'),
            'a password with no letter was accepted'
        );
    });
});

test('a password that keeps the rule is accepted', function (): void {
    with_settings([], function (): void {
        expect_same(null, password_problem('fooday1'), 'letters and numbers at the default length are enough');
        expect_same(null, password_problem('F00day!Bar'), 'punctuation is welcome on top');
    });
});

test('the rule cannot be switched off by the settings table', function (): void {
    // An install upgraded from a version where this was a setting still holds
    // the row. It must not loosen anything, whichever way it is set.
    foreach (['0', '1', '', 'off', 'false'] as $value) {
        with_settings(['password_require_mixed' => $value], function () use ($value): void {
            expect_true(
                password_problem('foodayonly') !== null,
                'the row set to "' . $value . '" turned the rule off'
            );
        });
    }
});

/* ---------- the length is still a setting ---------- */

test('the minimum length is read from the settings', function (): void {
    with_settings(['password_min_length' => '10'], function (): void {
        expect_same('Password must be at least 10 characters.', password_problem('fooday1'), 'the floor is not the one configured');
        expect_same(null, password_problem('fooday1234'), 'a password at that floor is fine');
    });
});

test('the floor is clamped so it can never be turned off or absurd', function (): void {
    foreach (['0' => 6, '-4' => 6, '99' => 32, 'not a number' => 6] as $stored => $expected) {
        with_settings(['password_min_length' => $stored], function () use ($expected, $stored): void {
            $problem = password_problem('a1');
            expect_true(
                $problem === null || str_contains((string) $problem, (string) $expected),
                'a floor of "' . $stored . '" did not clamp to ' . $expected . ' (got: ' . var_export($problem, true) . ')'
            );
        });
    }
});

/* ---------- the denylist is not a setting either ---------- */

test('the common passwords stay refused whatever the length', function (): void {
    with_settings(['password_min_length' => '6'], function (): void {
        // These two keep the letters-and-numbers rule, so they reach the denylist.
        foreach (['admin123', 'fooday123'] as $common) {
            expect_same(
                'That password is too common. Please choose another one.',
                password_problem($common),
                '"' . $common . '" was accepted'
            );
        }
        // These two are refused for missing a character class, which is the
        // other half of the same rule.
        foreach (['123456', 'password'] as $common) {
            expect_same(
                'Password must contain both letters and numbers.',
                password_problem($common),
                '"' . $common . '" was accepted'
            );
        }
    });
});

finish('password-policy');
