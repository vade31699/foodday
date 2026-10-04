<?php
declare(strict_types=1);

/**
 * FOODAY — DATABASE_URL parsing.
 *
 * A host such as Laravel Cloud can hand the database out as one URL instead of
 * five variables. db_url_parts() turns it into the parts db() needs, and this
 * pins the shapes it accepts — and, just as importantly, what it refuses.
 *
 * Run with:  php tests/database-url.test.php
 */

require __DIR__ . '/../api/config.php';
require __DIR__ . '/harness.php';

test('a full mysql URL is split into host, port, database, user and password', function () {
    $parts = db_url_parts('mysql://fooday_user:s3cret@db.example.com:3307/fooday_db');
    expect_same('db.example.com', $parts['host'], 'host');
    expect_same(3307, $parts['port'], 'port');
    expect_same('fooday_db', $parts['name'], 'database');
    expect_same('fooday_user', $parts['user'], 'user');
    expect_same('s3cret', $parts['pass'], 'password');
});

test('a URL without a port omits it, so the 3306 default still applies', function () {
    $parts = db_url_parts('mysql://user:pass@db.example.com/fooday_db');
    expect_same('db.example.com', $parts['host'], 'host');
    expect_true(!isset($parts['port']), 'no port key, so DB_PORT keeps its default');
});

test('percent-encoded credentials are decoded', function () {
    $parts = db_url_parts('mysql://user%40mail:p%40ss%2Fword@db.example.com/fooday_db');
    expect_same('user@mail', $parts['user'], 'user');
    expect_same('p@ss/word', $parts['pass'], 'password');
});

test('a postgres URL is refused rather than mis-parsed', function () {
    expect_same([], db_url_parts('postgres://user:pass@db.example.com:5432/fooday_db'), 'postgres is not MySQL');
});

test('an empty or malformed value yields nothing, keeping the local defaults', function () {
    expect_same([], db_url_parts(''), 'empty');
    expect_same([], db_url_parts('not a url'), 'junk');
});

finish('database-url');
