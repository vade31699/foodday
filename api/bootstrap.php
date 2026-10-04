<?php
declare(strict_types=1);

require __DIR__ . '/config.php';

/**
 * Single call the frontend makes on load (and after every change).
 * Returns the session state plus all catalog data the UI needs.
 */

$user  = current_user();
$admin = current_admin_data();

$orders = [];
if ($admin !== null) {
    $orders = fetch_orders(null, true);
} elseif ($user) {
    $orders = fetch_orders($user['id']);
}

json_out([
    'ok'            => true,
    'user'          => $user,
    'admin'         => $admin !== null,
    'adminProfile'  => $admin,
    'sessionExpired' => session_was_expired(),
    'config'        => public_config(),
    'settings'      => $admin !== null ? admin_settings_payload() : null,
    'categories'    => fetch_categories(),
    'products'      => fetch_products(),
    'areas'         => fetch_areas(),
    'announcements' => fetch_announcements(),
    'favorites'     => $user ? fetch_favorites($user['id']) : [],
    'addresses'     => $user ? fetch_addresses($user['id']) : [],
    'orders'        => $orders,
]);

/** Flat copy of the settings store for the admin Settings screen. */
function admin_settings_payload(): array
{
    $out = [];
    foreach (db()->query('SELECT k, v FROM settings')->fetchAll(PDO::FETCH_KEY_PAIR) as $k => $v) {
        $out[(string) $k] = (string) $v;
    }
    return $out;
}
