<?php
declare(strict_types=1);

/**
 * FOODAY — unit tests for delivery-address validation.
 *
 * Covers the GPS pin that travels with an address (`address_point` and the
 * shared `address_input`) and the ten-address limit, all in api/config.php.
 *
 * Nothing here touches the database. The pin rules are pure string and number
 * work, and the limit is tested on the boundary it is actually decided by —
 * `address_limit_reached` — rather than on the SQL that counts rows.
 *
 * Run with:  php tests/address-validation.test.php
 */

require __DIR__ . '/../api/config.php';
require __DIR__ . '/harness.php';

/* ---------- the pin ---------- */

test('a typed address carries no pin at all', function (): void {
    expect_same([null, null], address_point([]), 'an address with no coordinates has no pin');
    expect_same([null, null], address_point(['lat' => null, 'lng' => null]), 'the browser sends null when nothing was pinned');
    expect_same([null, null], address_point(['lat' => '', 'lng' => '']), 'empty strings mean the same as absent');
    expect_same([null, null], address_point(['lat' => '   ', 'lng' => '   ']), 'whitespace is not a coordinate');
});

test('half a pin is dropped rather than stored', function (): void {
    // A latitude with no longitude points nowhere, so neither half is kept.
    expect_same([null, null], address_point(['lat' => '14.5995']), 'a latitude on its own is dropped');
    expect_same([null, null], address_point(['lng' => '120.9842']), 'a longitude on its own is dropped');
    expect_same([null, null], address_point(['lat' => '14.5995', 'lng' => '']), 'an empty longitude is dropped');
});

test('a real pin is rounded to the seven decimals the column keeps', function (): void {
    [$lat, $lng] = address_point(['lat' => '14.59951234567', 'lng' => '120.984219999']);

    expect_close(14.5995123, $lat, 'the latitude is rounded');
    expect_close(120.98422, $lng, 'the longitude is rounded');
});

test('numbers are accepted whether they arrive as strings or as numbers', function (): void {
    expect_same([14.5, 121.0], address_point(['lat' => 14.5, 'lng' => 121]), 'JSON numbers are accepted');
    expect_same([14.5, 121.0], address_point(['lat' => '14.5', 'lng' => '+121.0']), 'a leading plus is still numeric');
    expect_same([-14.5, -121.0], address_point(['lat' => '-14.5', 'lng' => '-121']), 'negative coordinates are accepted');
});

test('a pin that is not a number is refused', function (): void {
    foreach (['abc', '14,5', '14.5abc', '121.0.0', 'NaN', '1e9999'] as $rubbish) {
        expect_refused(
            fn() => address_point(['lat' => $rubbish, 'lng' => '121']),
            'a latitude of "' . $rubbish . '" is refused'
        );
    }
    expect_refused(fn() => address_point(['lat' => '14.5', 'lng' => 'abc']), 'a non-numeric longitude is refused');
});

test('a pin outside the world is refused', function (): void {
    expect_refused(fn() => address_point(['lat' => '90.1', 'lng' => '121']), 'a latitude above 90 is refused');
    expect_refused(fn() => address_point(['lat' => '-90.1', 'lng' => '121']), 'a latitude below -90 is refused');
    expect_refused(fn() => address_point(['lat' => '14.5', 'lng' => '180.1']), 'a longitude above 180 is refused');
    expect_refused(fn() => address_point(['lat' => '14.5', 'lng' => '-180.1']), 'a longitude below -180 is refused');
});

test('the corners of the map are inside it', function (): void {
    expect_same([90.0, 180.0], address_point(['lat' => '90', 'lng' => '180']), '+90/+180 is a real point');
    expect_same([-90.0, -180.0], address_point(['lat' => '-90', 'lng' => '-180']), '-90/-180 is a real point');
});

test('the server stores 0,0 — the browser is what refuses Null Island', function (): void {
    // A pin that came back as 0,0 means the fix failed, and app.js turns it away
    // before it is ever sent. The server keeps its own contract simple: numeric
    // and in range. This test pins that split, so neither side drifts.
    expect_same([0.0, 0.0], address_point(['lat' => '0', 'lng' => '0']), 'a point on the equator is not the server\'s to refuse');
});

test('a stray field in the payload cannot confuse the pin', function (): void {
    // Only `lat` and `lng` are read, so anything else riding along in the
    // request is ignored rather than tripped over — including a nested array,
    // which would be a fatal string conversion if the server cast it blindly.
    [$lat, $lng] = address_point(['lat' => '14.5', 'lng' => '120.9', 'extra' => ['nested']]);

    expect_close(14.5, $lat, 'the latitude is read from lat');
    expect_close(120.9, $lng, 'the longitude is read from lng');
});

/* ---------- the address the pin belongs to ---------- */

test('an address with no text is refused', function (): void {
    expect_refused(fn() => address_input([]), 'an empty address is refused');
    expect_refused(fn() => address_input(['address' => '   ']), 'spaces are not an address');
});

test('a typed address is stored without a pin', function (): void {
    $a = address_input(['address' => '  12 Mabini St, Lipa  ']);

    expect_same('12 Mabini St, Lipa', $a['address'], 'the address is trimmed');
    expect_same('Home', $a['label'], 'an unlabelled address is called Home');
    expect_same(null, $a['landmark'], 'no landmark is null, not an empty string');
    expect_same(null, $a['lat'], 'a typed address has no latitude');
    expect_same(null, $a['lng'], 'a typed address has no longitude');
});

test('a pinned address keeps the pin it came with', function (): void {
    $a = address_input([
        'address' => 'Pinned location (14.59951, 120.98422)',
        'label'   => 'Work',
        'lat'     => '14.59951',
        'lng'     => '120.98422',
    ]);

    expect_close(14.59951, $a['lat'], 'the latitude is carried through');
    expect_close(120.98422, $a['lng'], 'the longitude is carried through');
    expect_same('Work', $a['label'], 'the label is kept');
    expect_same('Pinned location (14.59951, 120.98422)', $a['address'], 'the address text is kept as it was sent');
});

test('a broken pin cannot be saved by getting the address right', function (): void {
    expect_refused(
        fn() => address_input(['address' => '12 Mabini St', 'lat' => 'nonsense', 'lng' => '120.9']),
        'a broken pin is refused even with a valid address'
    );
});

test('overlong text is cut to what the columns hold', function (): void {
    $a = address_input([
        'address'  => '12 Mabini St',
        'label'    => str_repeat('L', 50),
        'landmark' => str_repeat('M', 200),
    ]);

    expect_same(40, mb_strlen($a['label']), 'the label is cut to 40 characters');
    expect_same(190, mb_strlen($a['landmark']), 'the landmark is cut to 190 characters');
});

/* ---------- the address limit ---------- */

test('the limit is ten addresses', function (): void {
    expect_same(10, ADDRESS_LIMIT, 'the seeded limit');
});

test('the limit is reached on the tenth address, not the eleventh', function (): void {
    expect_same(false, address_limit_reached(0), 'an empty address book has room');
    expect_same(false, address_limit_reached(9), 'nine leaves room for one more');
    expect_same(true, address_limit_reached(10), 'the tenth address fills the book');
    expect_same(true, address_limit_reached(11), 'past the limit stays refused');
});

test('the refusal names the limit and the way out of it', function (): void {
    $e = address_limit_error();

    expect_true(str_contains($e->getMessage(), '10'), 'the message says how many are allowed');
    expect_true(str_contains($e->getMessage(), 'Delete one'), 'the message says how to make room');
    expect_same(400, $e->status, 'a full address book is a bad request, not a server error');
});

test('the browser falls back to the same limit when config is silent', function (): void {
    // app.js mirrors ADDRESS_LIMIT so the form can disable itself before the
    // server refuses. The two must not drift apart.
    $js = (string) file_get_contents(__DIR__ . '/../app.js');

    expect_true(
        (bool) preg_match('/function addressLimit\(\)\s*\{[^}]*\|\|\s*(\d+)\)/', $js, $m),
        'addressLimit() is still written the way this test expects to read it'
    );
    expect_same((string) ADDRESS_LIMIT, $m[1], 'the fallback in app.js matches ADDRESS_LIMIT');
});

/* ---------- summary ---------- */

finish('address-validation');
