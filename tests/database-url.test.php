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

test('a TiDB Cloud Serverless URL is split, TLS mode and all', function () {
    $url = 'mysql://3fA9aBc.root:Ab%40c%2Fd12@gateway01.us-east-1.prod.aws.tidbcloud.com:4000/fooday_db?ssl-mode=REQUIRED';
    $parts = db_url_parts($url);
    expect_same('gateway01.us-east-1.prod.aws.tidbcloud.com', $parts['host'], 'host');
    expect_same(4000, $parts['port'], 'TiDB port');
    expect_same('3fA9aBc.root', $parts['user'], 'the instance prefix is kept in the user');
    expect_same('Ab@c/d12', $parts['pass'], 'a percent-encoded password is decoded');
    expect_same('fooday_db', $parts['name'], 'database');
    expect_same('REQUIRED', $parts['ssl_mode'], 'ssl-mode is carried through');
});

test('an ssl_ca path and the tls shorthand are read from the URL too', function () {
    $ca = db_url_parts('mysql://u:p@h:4000/db?ssl_ca=/etc/ssl/certs/ca-certificates.crt');
    expect_same('/etc/ssl/certs/ca-certificates.crt', $ca['ssl_ca'], 'ssl_ca');

    $tls = db_url_parts('mysql://u:p@h:4000/db?tls=true');
    expect_same('true', $tls['ssl_mode'], 'tls=true maps to a mode');

    $plain = db_url_parts('mysql://u:p@h:4000/db');
    expect_true(!isset($plain['ssl_mode']), 'a plain URL carries no mode');
});

test('the several TLS spellings fold onto five modes', function () {
    expect_same('disabled', db_ssl_mode(''), 'empty is off');
    expect_same('disabled', db_ssl_mode('DISABLED'), 'disabled');
    expect_same('preferred', db_ssl_mode('PREFERRED'), 'preferred');
    expect_same('required', db_ssl_mode('REQUIRED'), 'TiDB REQUIRED');
    expect_same('required', db_ssl_mode('true'), 'tls=true');
    expect_same('verify_ca', db_ssl_mode('VERIFY_CA'), 'verify_ca');
    expect_same('verify_identity', db_ssl_mode('VERIFY_IDENTITY'), 'TiDB VERIFY_IDENTITY');
    expect_same('verify_identity', db_ssl_mode('verify-full'), 'verify-full folds');
    expect_same('bogus', db_ssl_mode('bogus'), 'an unknown mode is kept, to be refused later');
});

finish('database-url');
