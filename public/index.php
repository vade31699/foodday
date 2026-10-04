<?php
declare(strict_types=1);

/**
 * FOODAY — front controller for the Laravel Cloud PHP runtime.
 *
 * Laravel Cloud serves PHP applications from a `public/` document root (the
 * Laravel and Symfony convention). FOODAY keeps its files at the project root
 * so the Apache/IIS rules in .htaccess and web.config, and the test suite,
 * keep working unchanged. This file is the bridge: it is the only file inside
 * public/, so every request lands here and it returns just the handful of
 * files that are meant to be public.
 *
 * It is an allow-list, not a filter. A path that is not named below is a 404,
 * so .env, fooday.sql, README.md and tests/ cannot be reached through it even
 * if a later edit drops such a file next to the served ones.
 */

const FOODAY_ROOT = __DIR__ . '/..';

/** Files the browser may download, as request path => [file on disk, content type]. */
const FOODAY_PUBLIC_FILES = [
    '/'                => ['index.html', 'text/html; charset=UTF-8'],
    '/index.html'      => ['index.html', 'text/html; charset=UTF-8'],
    '/styles.css'      => ['styles.css', 'text/css; charset=UTF-8'],
    '/app.js'          => ['app.js', 'text/javascript; charset=UTF-8'],
    '/fooday-logo.jpg' => ['fooday-logo.jpg', 'image/jpeg'],
    // PWA / Trusted Web Activity assets (the Android app the manifest wraps).
    '/manifest.webmanifest'      => ['manifest.webmanifest', 'application/manifest+json; charset=UTF-8'],
    '/icons/icon-192.png'        => ['icons/icon-192.png', 'image/png'],
    '/icons/icon-512.png'        => ['icons/icon-512.png', 'image/png'],
    '/icons/maskable-512.png'    => ['icons/maskable-512.png', 'image/png'],
    // Digital Asset Links: proves the APK may open this site without a URL bar.
    '/.well-known/assetlinks.json' => ['.well-known/assetlinks.json', 'application/json'],
];

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
if (!is_string($path) || $path === '') {
    $path = '/';
}
// Normalise backslashes first: on Windows they are path separators, and the
// allow-list below must never match a de-escaped traversal such as /%2e%2e/.
$path = str_replace('\\', '/', rawurldecode($path));

if (isset(FOODAY_PUBLIC_FILES[$path])) {
    [$file, $type] = FOODAY_PUBLIC_FILES[$path];
    header('Content-Type: ' . $type);
    // index.html is the app shell and points at version-stamped assets, so it
    // must never be cached. assetlinks.json must stay revalidatable too, or a
    // signing-key change would not reach Chrome. manifest.webmanifest is the
    // same kind of thing: it names the start URL, theme and icon paths, and
    // Android caches it, so a year-long immutable copy would freeze the
    // installed app on its first values. The stamped assets, and the icon
    // files whose names change when the artwork does, are safe to cache hard.
    header('Cache-Control: ' . (in_array($file, ['index.html', 'manifest.webmanifest', '.well-known/assetlinks.json'], true)
        ? 'no-cache, must-revalidate'
        : 'public, max-age=31536000, immutable'));
    readfile(FOODAY_ROOT . '/' . $file);
    return;
}

// API endpoints: /api/<name>.php and nothing else. The frontend builds these
// as `api/${path}` (see app.js), so the name is always lowercase and fixed.
if (preg_match('#^/api/[a-z_]+\.php$#', $path)) {
    $endpoint = FOODAY_ROOT . $path;
    if (is_file($endpoint)) {
        require $endpoint;
        return;
    }
}

http_response_code(404);
header('Content-Type: text/plain; charset=UTF-8');
echo 'Not found';
