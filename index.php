<?php
declare(strict_types=1);

/**
 * FOODAY — entry point at the repository root.
 *
 * Laravel Cloud (and other hosts) may serve a PHP app from either the
 * repository root or a public/ directory. public/index.php holds the actual
 * front-controller logic — the allow-list of public files and the /api router.
 * This file exists so the app also serves when the document root is the
 * repository root itself, which is what happens if the host looks for
 * index.php here rather than in public/.
 *
 * Both entry points run the same code, so there is only one place to change.
 */

require __DIR__ . '/public/index.php';
