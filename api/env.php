<?php
declare(strict_types=1);

/**
 * FOODAY — minimal .env reader.
 *
 * The project has no Composer, so this stands in for vlucas/phpdotenv. It reads
 * the project's .env file once per request and exposes it through env().
 *
 * Rules it follows on purpose:
 *  - A real environment variable set on the server always wins over the file,
 *    so a hosting panel's own configuration cannot be shadowed by a stale .env.
 *  - The file is optional. Every value has a safe default, so the app boots
 *    exactly as before when .env is absent — which is what happens today.
 *  - Nothing is ever executed or expanded; the parser only splits on the first
 *    "=" and strips wrapping quotes.
 */

/** Absolute path of the .env this project reads. */
function env_file_path(): string
{
    static $path = null;
    if ($path === null) {
        $path = dirname(__DIR__) . DIRECTORY_SEPARATOR . '.env';
    }
    return $path;
}

/** @return array<string,string> */
function env_load(): array
{
    static $loaded = false;
    static $values = [];

    if ($loaded) {
        return $values;
    }
    $loaded = true;

    $file = env_file_path();
    if (!is_readable($file)) {
        return $values;
    }

    $lines = @file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if ($lines === false) {
        return $values;
    }

    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#') {
            continue;
        }
        if (str_starts_with($line, 'export ')) {
            $line = substr($line, 7);
        }

        $eq = strpos($line, '=');
        if ($eq === false) {
            continue;
        }

        $key = trim(substr($line, 0, $eq));
        if ($key === '' || !preg_match('/^[A-Za-z_][A-Za-z0-9_.]*$/', $key)) {
            continue;
        }

        $value = trim(substr($line, $eq + 1));

        // A " #" outside quotes starts a trailing comment.
        if ($value !== '' && $value[0] !== '"' && $value[0] !== "'") {
            $hash = strpos($value, ' #');
            if ($hash !== false) {
                $value = rtrim(substr($value, 0, $hash));
            }
        }

        if (strlen($value) >= 2) {
            $first = $value[0];
            if (($first === '"' || $first === "'") && $value[strlen($value) - 1] === $first) {
                $value = substr($value, 1, -1);
                if ($first === '"') {
                    $value = str_replace(
                        ['\\n', '\\r', '\\"', '\\\\'],
                        ["\n", "\r", '"', '\\'],
                        $value
                    );
                }
            }
        }

        $values[$key] = $value;
    }

    return $values;
}

function env(string $key, string $default = ''): string
{
    $fromServer = getenv($key);
    if ($fromServer !== false && $fromServer !== '') {
        return $fromServer;
    }
    if (isset($_ENV[$key]) && $_ENV[$key] !== '') {
        return (string) $_ENV[$key];
    }

    $values = env_load();
    if (isset($values[$key]) && $values[$key] !== '') {
        return $values[$key];
    }

    return $default;
}

function env_bool(string $key, bool $default = false): bool
{
    $value = env($key, '');
    if ($value === '') {
        return $default;
    }
    return in_array(strtolower($value), ['1', 'true', 'on', 'yes'], true);
}

function env_int(string $key, int $default = 0): int
{
    $value = env($key, '');
    return is_numeric($value) ? (int) $value : $default;
}

/**
 * True when a value is still the untouched placeholder shipped in .env.example.
 * Used so a half-filled .env is reported as "not configured" instead of
 * silently attempting to authenticate as "your-app-password@gmail.com".
 */
function env_is_placeholder(string $value): bool
{
    if ($value === '') {
        return true;
    }
    $lower = strtolower($value);
    foreach (['your-', 'your_', 'xxxxx', 'change_me', 'changeme', 'replace', 'todo', 'example', 'placeholder'] as $marker) {
        if (str_contains($lower, $marker)) {
            return true;
        }
    }
    return false;
}
