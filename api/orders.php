<?php
declare(strict_types=1);

require __DIR__ . '/config.php';

$data   = body();
$action = field($data, 'action');

switch ($action) {
    case 'create':
        create_order($data);
        break;

    case 'advance':
        advance_order($data);
        break;

    case 'update_status':
        update_status($data);
        break;

    case 'note':
        set_note($data);
        break;

    case 'cancel':
        cancel_order($data);
        break;

    default:
        throw new ApiError('Unknown order action.', 400);
}

/* ---------------------------------------------------------------
 |  Placing an order
 *  Works for both entry points: "Add to Cart" (checkout.buy_now = false)
 |  and "Buy Now" (checkout.buy_now = true, which skips the cart).
 * --------------------------------------------------------------- */
function create_order(array $data): void
{
    $items    = is_array($data['items'] ?? null) ? $data['items'] : [];
    $checkout = is_array($data['checkout'] ?? null) ? $data['checkout'] : [];

    if (!$items) {
        throw new ApiError('Your cart is empty.');
    }
    if (!setting_bool('store_open', true)) {
        throw new ApiError('FOODAY is closed right now. Please try again later.');
    }

    // Every free-text field is trimmed to the width of its column, so an
    // oversized value is refused in words rather than as a database error.
    $name    = mb_substr(trim((string) ($checkout['name'] ?? '')), 0, 120);
    $phone   = trim((string) ($checkout['phone'] ?? ''));
    $address = mb_substr(trim((string) ($checkout['address'] ?? '')), 0, 500);

    if ($name === '' || $phone === '' || $address === '') {
        throw new ApiError('Please complete your delivery information.');
    }
    if (!valid_name($name)) {
        throw new ApiError('Please enter a valid full name.');
    }
    if (!valid_phone($phone)) {
        throw new ApiError('Please enter a valid 11-digit Philippine mobile number.');
    }

    // FOODAY takes cash on delivery for now. GCash is presented in the app but
    // stays switched off until a GCash merchant account is connected, so a
    // tampered request cannot slip a different method through.
    $requested = field($data, 'payment_method', 'Cash on Delivery');
    if ($requested !== 'Cash on Delivery' && $requested !== 'GCash') {
        throw new ApiError('Please choose a valid payment method.');
    }
    if ($requested === 'GCash' && !setting_bool('pay_gcash_enabled', false)) {
        throw new ApiError('GCash is not available yet. Please pay cash on delivery.');
    }
    if ($requested === 'Cash on Delivery' && !setting_bool('pay_cod_enabled', true)) {
        throw new ApiError('Cash on delivery is currently unavailable. Please try again later.');
    }
    $payment = 'Cash on Delivery';

    $user = current_user();
    $pdo  = db();
    $pdo->beginTransaction();

    try {
        $total = 0.0;
        $rows  = [];
        $priceStmt = $pdo->prepare('SELECT price, is_available FROM products WHERE id = ?');

        foreach ($items as $item) {
            $productId = (int) ($item['product_id'] ?? 0);
            $qty       = max(1, min(99, (int) ($item['qty'] ?? 1)));
            $price     = (float) ($item['price'] ?? 0);
            $available = true;

            if ($productId > 0) {
                $priceStmt->execute([$productId]);
                $row = $priceStmt->fetch();
                if ($row !== false) {
                    $price     = (float) $row['price'];
                    $available = (int) $row['is_available'] === 1;
                }
            }
            if (!$available) {
                throw new ApiError('One of the items just went out of stock. Please review your order.');
            }

            $lineTotal = round($price * $qty, 2);
            $total    += $lineTotal;
            $rows[]    = [
                'product_id' => $productId,
                'name'       => mb_substr(trim((string) ($item['name'] ?? 'Item')), 0, 150),
                'price'      => $price,
                'qty'        => $qty,
                'note'       => mb_substr(trim((string) ($item['note'] ?? '')), 0, 255),
                'subtotal'   => $lineTotal,
            ];
        }
        $total = round($total, 2);

        if ($min = setting_int('order_min_total', 0)) {
            if ($total < $min) {
                throw new ApiError('Minimum order is ' . money($min) . '. Please add more items.');
            }
        }

        $code  = unique_order_code($pdo);
        $buyNow = !empty($checkout['buy_now']);

        $orderStmt = $pdo->prepare(
            'INSERT INTO orders
                (order_code, user_id, customer_name, contact_phone, area, address, landmark, order_note,
                 payment_method, status, subtotal, delivery_fee, total, source, accepted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, "Order Placed", ?, 0.00, ?, ?, ?)'
        );
        $orderStmt->execute([
            $code,
            $user['id'] ?? null,
            capitalize($name),
            $phone,
            mb_substr(trim((string) ($checkout['area'] ?? '')), 0, 120),
            $address,
            mb_substr(trim((string) ($checkout['landmark'] ?? '')), 0, 190),
            mb_substr(trim((string) ($checkout['note'] ?? '')), 0, 255),
            $payment,
            $total,
            $total,
            $buyNow ? 'Buy Now' : 'Cart',
            null,
        ]);
        $orderId = (int) $pdo->lastInsertId();

        $itemStmt = $pdo->prepare(
            'INSERT INTO order_items (order_id, product_id, name, price, qty, subtotal, note)
             VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        foreach ($rows as $r) {
            $itemStmt->execute([
                $orderId,
                $r['product_id'] > 0 ? $r['product_id'] : null,
                $r['name'],
                $r['price'],
                $r['qty'],
                $r['subtotal'],
                $r['note'] !== '' ? $r['note'] : null,
            ]);
        }

        // The order is visible in Admin > Orders the moment it is committed.
        log_order_event($pdo, $orderId, 'Order Placed', 'customer', 'Order received by FOODAY');

        // Optional auto-accept from Admin > Settings > Orders.
        if (setting_bool('order_auto_accept', false)) {
            $pdo->prepare('UPDATE orders SET status = "Accepted", accepted_at = NOW(), status_updated = NOW() WHERE id = ?')
                ->execute([$orderId]);
            log_order_event($pdo, $orderId, 'Accepted', 'system', 'Automatically accepted (auto-accept is on)');
        }

        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    ok([
        'order_id'      => $code,
        'customer_name' => capitalize($name),
        'total'         => $total,
        'status'        => setting_bool('order_auto_accept', false) ? 'Accepted' : 'Order Placed',
    ]);
}

/* ---------------------------------------------------------------
 |  Admin pipeline:  Accept -> Prepare -> On the Way -> Delivered
 *  Each step is only accepted if it is the current step, which keeps
 |  the customer timeline honest.
 * --------------------------------------------------------------- */
function advance_order(array $data): void
{
    $admin  = require_admin();
    $code   = field($data, 'order_code');
    $target = field($data, 'status');
    $note   = mb_substr(field($data, 'note'), 0, 255);

    if (!in_array($target, array_values(ORDER_NEXT), true)) {
        throw new ApiError('Invalid order status.');
    }

    $pdo = db();
    $stmt = $pdo->prepare('SELECT id, status, total, payment_method FROM orders WHERE order_code = ?');
    $stmt->execute([$code]);
    $order = $stmt->fetch();
    if (!$order) {
        throw new ApiError('Order not found.');
    }

    $current = (string) $order['status'];
    if (in_array($current, ORDER_DONE, true)) {
        throw new ApiError("This order is already {$current}.");
    }
    $expected = order_next_status($current);
    if ($target !== $expected) {
        throw new ApiError("This order is waiting to be marked \"{$expected}\".");
    }

    // Completing a cash order closes the money side too, so the tender is
    // recorded in the same step and the change can never drift from the total.
    $cash = $target === 'Delivered'
        ? order_settle_cash($order, field($data, 'cash_tendered'))
        : null;

    $stamp = ORDER_STAMP[$target];
    $pdo->prepare(
        "UPDATE orders SET status = ?, status_updated = NOW(), `$stamp` = NOW(),
                           cash_tendered = ?, change_due = ?
          WHERE id = ?"
    )->execute([
        $target,
        $cash['cash']   ?? null,
        $cash['change'] ?? null,
        (int) $order['id'],
    ]);

    if ($cash !== null) {
        $note = $note !== '' ? $note . ' · ' : '';
        $note .= 'Cash ' . pesos($cash['cash'])
            . ($cash['change'] > 0 ? ' · change ' . pesos($cash['change']) : ' · no change');
    }

    log_order_event($pdo, (int) $order['id'], $target, 'admin', $note);

    ok([
        'status'        => $target,
        'label'         => ORDER_LABEL[$target] ?? $target,
        'cash_tendered' => $cash['cash']   ?? null,
        'change_due'    => $cash['change'] ?? null,
    ]);
}

/** Kept for the old dropdown UI — now funnelled through the same rules. */
function update_status(array $data): void
{
    require_admin();
    $status = field($data, 'status');
    $code   = field($data, 'order_code');

    if ($status === 'Cancelled') {
        cancel_order($data);
        return;
    }
    advance_order(['order_code' => $code, 'status' => $status, 'note' => field($data, 'note')]);
}

function set_note(array $data): void
{
    require_admin();
    $code = field($data, 'order_code');
    $note = mb_substr(field($data, 'note'), 0, 255);

    $stmt = db()->prepare('SELECT id FROM orders WHERE order_code = ?');
    $stmt->execute([$code]);
    $order = $stmt->fetch();
    if (!$order) {
        throw new ApiError('Order not found.');
    }

    db()->prepare('UPDATE orders SET admin_note = ? WHERE id = ?')
        ->execute([$note !== '' ? $note : null, (int) $order['id']]);

    ok();
}

function cancel_order(array $data): void
{
    $user   = current_user();
    $admin  = current_admin();
    $code   = field($data, 'order_code');
    $reason = mb_substr(field($data, 'reason'), 0, 190);

    $pdo = db();
    $stmt = $pdo->prepare('SELECT id, user_id, status, placed_at FROM orders WHERE order_code = ?');
    $stmt->execute([$code]);
    $order = $stmt->fetch();
    if (!$order) {
        throw new ApiError('Order not found.');
    }
    if (in_array($order['status'], ORDER_DONE, true)) {
        throw new ApiError("This order is already {$order['status']}.");
    }

    if ($admin) {
        // Admins may cancel at any point before delivery.
        if ($order['status'] === 'On the Way' && $reason === '') {
            throw new ApiError('Please give a short reason for cancelling an order that is already on the way.');
        }
    } else {
        $isOwner = $user && (int) $order['user_id'] === (int) $user['id'];
        if (!$isOwner) {
            throw new ApiError('You cannot cancel this order.', 403);
        }
        if (!order_can_cancel($order, $user)) {
            throw new ApiError(
                'This order can no longer be cancelled. Please contact FOODAY support for help.'
            );
        }
    }

    $pdo->prepare(
        'UPDATE orders SET status = "Cancelled", status_updated = NOW(), cancelled_at = NOW(), cancel_reason = ?
          WHERE id = ?'
    )->execute([$reason !== '' ? $reason : null, (int) $order['id']]);

    log_order_event(
        $pdo,
        (int) $order['id'],
        'Cancelled',
        $admin ? 'admin' : 'customer',
        $reason !== '' ? $reason : 'Order cancelled'
    );

    ok();
}

function unique_order_code(PDO $pdo): string
{
    for ($i = 0; $i < 5; $i++) {
        $code = '#FD' . str_pad((string) random_int(0, 999999999), 9, '0', STR_PAD_LEFT);
        $check = $pdo->prepare('SELECT 1 FROM orders WHERE order_code = ?');
        $check->execute([$code]);
        if (!$check->fetchColumn()) {
            return $code;
        }
    }
    throw new ApiError('Could not generate an order id. Please try again.');
}

function money(float $amount): string
{
    return '₱' . number_format($amount, 2);
}
