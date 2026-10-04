<?php
declare(strict_types=1);

/**
 * FOODAY — unit tests for the order pipeline.
 *
 * Two things are covered, both from api/config.php:
 *
 *  1. The status transitions — an order moves one step at a time, never skips,
 *     never goes backwards, and never leaves the pipeline once it is finished.
 *  2. The cash tender rules — completing a Cash on Delivery order requires a
 *     tender that covers the total, and the change is the difference.
 *
 * No database is needed: the transition decision is `order_next_status()`, the
 * same call api/orders.php makes before it lets a step through, and the money
 * rules are pure arithmetic on the order's total.
 *
 * Run with:  php tests/order-pipeline.test.php
 */

require __DIR__ . '/../api/config.php';
require __DIR__ . '/harness.php';

/* ---------- shared helpers ---------- */

/** An order row with only the fields the money and cancel helpers look at. */
function fake_order(string $paymentMethod, float|string $total): array
{
    return ['payment_method' => $paymentMethod, 'total' => $total, 'status' => 'On the Way'];
}

/** Every status the app can show: the pipeline, plus the way out of it. */
function all_statuses(): array
{
    return [...ORDER_FLOW, 'Cancelled'];
}

/** Reads a `const NAME = ["a", "b"];` list of strings out of app.js. */
function js_string_array(string $js, string $name): array
{
    if (!preg_match('/const ' . preg_quote($name, '/') . '\s*=\s*\[([^\]]*)\]/', $js, $m)) {
        throw new RuntimeException($name . ' was not found in app.js');
    }
    preg_match_all('/"([^"]*)"/', $m[1], $items);

    return $items[1];
}

/* ---------- the shape of the pipeline ---------- */

test('the pipeline is one chain, in one direction', function (): void {
    expect_same(
        array_slice(ORDER_FLOW, 1),
        array_values(ORDER_NEXT),
        'each step leads to the next one, with nothing skipped'
    );
    expect_same(
        array_slice(ORDER_FLOW, 0, -1),
        array_keys(ORDER_NEXT),
        'only a step that is not the last one has somewhere to go'
    );
});

test('every step has exactly one next step, and the last has none', function (): void {
    $last = ORDER_FLOW[count(ORDER_FLOW) - 1];

    foreach (ORDER_FLOW as $status) {
        $next = order_next_status($status);

        if ($status === $last) {
            expect_same(null, $next, 'the final step is the end of the line');
            continue;
        }

        expect_true($next !== null, 'a step mid-pipeline always has a next step');
        expect_same(
            array_search($status, ORDER_FLOW, true) + 1,
            array_search($next, ORDER_FLOW, true),
            'the next step is the following one in the flow'
        );
    }
});

test('a finished order is never advanced again, and neither is an unknown status', function (): void {
    foreach (ORDER_DONE as $done) {
        expect_same(null, order_next_status($done), 'a ' . $done . ' order has no next step');
    }
    expect_same(null, order_next_status(''), 'an empty status goes nowhere');
    expect_same(null, order_next_status('Refunded'), 'a status the app does not have goes nowhere');
});

test('the only steps staff may advance to are the four real transitions', function (): void {
    $targets = array_values(ORDER_NEXT);

    // api/orders.php refuses anything outside this list before it even looks up
    // the order, so these four strings are the entire set of moves that exist.
    expect_same(4, count($targets), 'there are four steps to move to');

    foreach ($targets as $target) {
        expect_true(in_array($target, ORDER_FLOW, true), 'a target is a real pipeline step');
    }

    expect_same(false, in_array('Cancelled', $targets, true), 'cancelling is not an advance — it has its own endpoint');
    expect_same(false, in_array('Order Placed', $targets, true), 'an order can never be moved back to the start');
    expect_same(false, in_array('Refunded', $targets, true), 'a status the app does not have is never a target');
});

test('each step waits for exactly one named step, written out', function (): void {
    // The contract in full, spelled out independently of how ORDER_NEXT is built:
    // api/orders.php refuses a step unless it equals this, so a step can never be
    // skipped, repeated or gone back to. Any edit to the map has to come here too.
    $waitsFor = [
        'Order Placed' => 'Accepted',
        'Accepted'     => 'Preparing',
        'Preparing'    => 'On the Way',
        'On the Way'   => 'Delivered',
        'Delivered'    => null,
        'Cancelled'    => null,
    ];

    foreach ($waitsFor as $current => $expected) {
        expect_same(
            $expected,
            order_next_status($current),
            'from "' . $current . '" the step it is waiting for is ' . var_export($expected, true)
        );
    }
});

test('every step that can be reached records when it was reached', function (): void {
    $stamped = [...array_values(ORDER_NEXT), 'Cancelled'];

    foreach ($stamped as $status) {
        expect_true(array_key_exists($status, ORDER_STAMP), $status . ' has a timestamp column');
        expect_true(str_ends_with(ORDER_STAMP[$status], '_at'), $status . ' stamps a time column');
    }

    // Placing the order is the row insert itself; there is nothing to stamp.
    expect_same(false, array_key_exists('Order Placed', ORDER_STAMP), 'the first step has no separate stamp');
});

test('every status is labelled for the customer', function (): void {
    foreach (all_statuses() as $status) {
        expect_true(array_key_exists($status, ORDER_LABEL), $status . ' has a label');
        expect_true(trim(ORDER_LABEL[$status]) !== '', 'the label for ' . $status . ' is not empty');
    }
});

test('active and finished statuses cover every status exactly once', function (): void {
    $union = [...ORDER_ACTIVE, ...ORDER_DONE];
    sort($union);
    $every = all_statuses();
    sort($every);

    expect_same($every, $union, 'every status is either active or finished, and nothing else');
    expect_same([], array_intersect(ORDER_ACTIVE, ORDER_DONE), 'a status is never both active and finished');

    // Cancelled is not a step on the way anywhere, so the active steps are the
    // pipeline with its finished ones taken out.
    expect_same(
        array_values(array_diff(ORDER_FLOW, ORDER_DONE)),
        ORDER_ACTIVE,
        'the active steps are the pipeline minus the finished ones'
    );
    expect_true(in_array('On the Way', ORDER_ACTIVE, true), 'an order with a rider is still active');
});

test('the browser cannot drift from the pipeline the server enforces', function (): void {
    $js = (string) file_get_contents(__DIR__ . '/../app.js');

    expect_same(ORDER_FLOW, js_string_array($js, 'ORDER_FLOW'), 'app.js holds the same pipeline, in the same order');
    expect_same(
        ORDER_CASH_METHODS,
        js_string_array($js, 'CASH_METHODS'),
        'app.js treats the same payment methods as cash at the door'
    );
});

/* ---------- which orders are settled in cash ---------- */

test('the cash methods are the ones settled at the door', function (): void {
    foreach (['Cash on Delivery', 'COD', 'Cash', '  COD  '] as $method) {
        expect_same(true, order_is_cod(fake_order($method, 100)), '"' . $method . '" is paid in cash');
    }

    foreach (['GCash', 'Card', 'Bank Transfer', ''] as $method) {
        expect_same(false, order_is_cod(fake_order($method, 100)), '"' . $method . '" is not a cash order');
    }
});

test('an order with no payment method is not quietly treated as cash', function (): void {
    expect_same(false, order_is_cod(['total' => 100]), 'a missing payment_method is not a cash order');
    expect_same(false, order_is_cod(['payment_method' => null, 'total' => 100]), 'null is not a cash order');
});

test('the cash methods are matched exactly, not loosely', function (): void {
    // The app only ever sends the stored spelling, so a near-miss means something
    // is wrong upstream and must not be collected as though it were fine.
    expect_same(false, order_is_cod(fake_order('cash on delivery', 100)), 'case matters');
    expect_same(false, order_is_cod(fake_order('COD Cash', 100)), 'a phrase containing a method is not that method');
});

/* ---------- the tender ---------- */

test('a non-cash order has nothing to collect', function (): void {
    // The prompt is never reached for one of these, so even nonsense goes
    // unanswered rather than blowing up on a GCash order.
    expect_same(null, order_settle_cash(fake_order('GCash', 500), '600'), 'a GCash order records no tender');
    expect_same(null, order_settle_cash(fake_order('GCash', 500), ''), 'a GCash order is not asked for cash');
    expect_same(null, order_settle_cash(fake_order('GCash', 500), 'nonsense'), 'a GCash order never validates a tender');
});

test('the tender is required to complete a cash order', function (): void {
    $e = expect_refused(
        fn() => order_settle_cash(fake_order('Cash on Delivery', 100), ''),
        'an empty tender is refused'
    );

    expect_true(str_contains($e->getMessage(), 'cash'), 'the refusal asks for the cash');
    expect_same(400, $e->status, 'a missing tender is a bad request');
});

test('the tender must be a number', function (): void {
    foreach (['abc', '100 pesos', '1,234.56', '10.0.0'] as $rubbish) {
        expect_refused(
            fn() => order_settle_cash(fake_order('Cash on Delivery', 100), $rubbish),
            'a tender of "' . $rubbish . '" is refused'
        );
    }
});

test('the tender must cover the total', function (): void {
    $e = expect_refused(
        fn() => order_settle_cash(fake_order('Cash on Delivery', 100), '99.99'),
        'one centavo short is refused'
    );

    expect_true(str_contains($e->getMessage(), '100.00'), 'the refusal says how much is due');
    expect_same(400, $e->status, 'a short tender is a bad request');
});

test('a negative tender cannot buy an order', function (): void {
    expect_refused(
        fn() => order_settle_cash(fake_order('Cash on Delivery', 100), '-5'),
        'a negative tender is refused'
    );
});

test('the exact total is accepted, with no change due', function (): void {
    $paid = order_settle_cash(fake_order('Cash on Delivery', 250), '250');

    expect_same(250.0, $paid['cash'], 'the tender is the total');
    expect_same(0.0, $paid['change'], 'the change is exactly zero, not a rounding crumb');
});

test('float noise does not make exact cash look short', function (): void {
    // 0.1 + 0.2 is 0.30000000000000004, and a tender of 0.30 must still settle it.
    $paid = order_settle_cash(fake_order('Cash on Delivery', 0.1 + 0.2), '0.30');

    expect_close(0.3, $paid['cash'], 'the tender is kept to the centavo');
    expect_same(0.0, $paid['change'], 'exact cash leaves no change');
});

test('the change is the tender minus the total, to the centavo', function (): void {
    expect_same(
        ['cash' => 500.0, 'change' => 29.5],
        order_settle_cash(fake_order('Cash on Delivery', 470.5), '500'),
        'a round note'
    );
    expect_same(
        ['cash' => 1000.0, 'change' => 720.0],
        order_settle_cash(fake_order('Cash on Delivery', 280), '1000'),
        'a large note'
    );
    expect_same(
        ['cash' => 20.0, 'change' => 0.25],
        order_settle_cash(fake_order('Cash on Delivery', 19.75), '20'),
        'small change, still to the centavo'
    );
});

test('a total that does not divide evenly leaves no floating trail', function (): void {
    $paid = order_settle_cash(fake_order('Cash on Delivery', 280.9), '500');

    expect_same(219.1, $paid['change'], '219.10, not 219.10000000000002');
});

test('a total and a tender with extra decimals are rounded to centavos first', function (): void {
    $paid = order_settle_cash(fake_order('Cash on Delivery', '100.567'), '200.019');

    expect_close(200.02, $paid['cash'], 'the tender is rounded to the centavo');
    expect_close(99.45, $paid['change'], 'the change is rounded to the centavo');
});

test('an order that owes nothing still settles cleanly', function (): void {
    // A 0.00 total only arrives through a data mistake, but settling it must not
    // crash, nor demand money that is not owed.
    $paid = order_settle_cash(fake_order('Cash on Delivery', 0), '0');

    expect_same(0.0, $paid['cash'], 'nothing was taken');
    expect_same(0.0, $paid['change'], 'nothing is owed back');
});

test('amounts are shown with two decimals and thousands', function (): void {
    expect_same('1,234.50', pesos(1234.5), 'a large amount');
    expect_same('0.00', pesos(0), 'nothing');
    expect_same('100.00', pesos(99.999), 'a half-centavo rounds up');
    expect_same('19.75', pesos(19.75), 'small money');
});

/* ---------- who may cancel ---------- */

test('a signed-out visitor can never cancel an order', function (): void {
    $order = ['id' => 7, 'user_id' => 7, 'status' => 'Order Placed', 'placed_at' => date('Y-m-d H:i:s')];

    expect_same(false, order_can_cancel($order, null), 'there is nobody to cancel as');
});

test('an order belongs only to the customer who placed it', function (): void {
    $order = ['id' => 7, 'user_id' => 7, 'status' => 'Order Placed', 'placed_at' => date('Y-m-d H:i:s')];

    expect_same(false, order_can_cancel($order, ['id' => 8]), 'another customer cannot cancel it');
});

test('a finished order cannot be cancelled', function (): void {
    $placed = date('Y-m-d H:i:s');

    foreach (ORDER_DONE as $status) {
        $order = ['id' => 7, 'user_id' => 7, 'status' => $status, 'placed_at' => $placed];

        expect_same(false, order_can_cancel($order, ['id' => 7]), 'a ' . $status . ' order is closed');
    }
});

/* ---------- summary ---------- */

finish('order-pipeline');
