<?php
declare(strict_types=1);

/**
 * FOODAY — the smallest test harness these PHP tests need.
 *
 * No PHPUnit and no Composer: `php tests/<file>.test.php` is the whole story, so
 * the tests run on the same PHP and the same database-free machine the app is
 * developed on.
 *
 * require it *after* api/config.php, whose ApiError these helpers report.
 */

$GLOBALS['fooday_passed'] = 0;
$GLOBALS['fooday_failed'] = 0;

/** Runs one named test; a thrown exception is a failure and is reported on the spot. */
function test(string $name, callable $body): void
{
    try {
        $body();
        $GLOBALS['fooday_passed']++;
        echo '✔ ' . $name . PHP_EOL;
    } catch (Throwable $e) {
        $GLOBALS['fooday_failed']++;
        echo '✖ ' . $name . PHP_EOL;
        echo '    ' . $e->getMessage() . PHP_EOL;
    }
}

function expect_true(bool $condition, string $what): void
{
    if (!$condition) {
        throw new RuntimeException($what);
    }
}

function expect_same(mixed $expected, mixed $actual, string $what): void
{
    if ($expected !== $actual) {
        throw new RuntimeException(
            $what . ' (expected ' . var_export($expected, true) . ', got ' . var_export($actual, true) . ')'
        );
    }
}

/** Money and coordinates are compared with a tolerance: rounding is not bit-exact. */
function expect_close(float $expected, float $actual, string $what, float $tolerance = 0.0000001): void
{
    if (abs($expected - $actual) > $tolerance) {
        throw new RuntimeException($what . ' (expected ' . $expected . ', got ' . $actual . ')');
    }
}

/** Runs the code and returns the refusal it raised; fails the test if it did not. */
function expect_refused(callable $body, string $what): ApiError
{
    try {
        $body();
    } catch (ApiError $e) {
        return $e;
    }
    throw new RuntimeException($what . ' — it was accepted instead');
}

/** Prints the tally and exits non-zero when anything failed. */
function finish(string $suite): void
{
    $passed = $GLOBALS['fooday_passed'];
    $failed = $GLOBALS['fooday_failed'];

    echo PHP_EOL;
    if ($failed === 0) {
        echo 'All ' . $passed . ' ' . $suite . ' tests passed.' . PHP_EOL;
    } else {
        echo $failed . ' of ' . ($passed + $failed) . ' ' . $suite . ' tests failed.' . PHP_EOL;
    }

    exit($failed === 0 ? 0 : 1);
}
