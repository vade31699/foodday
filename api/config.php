<?php
declare(strict_types=1);

/**
 * FOODAY — shared backend configuration and helpers.
 * Edit the DB_* constants below to match your MySQL/MariaDB setup.
 */

require __DIR__ . '/migrations.php';
require_once __DIR__ . '/env.php';
require_once __DIR__ . '/mfa.php';
require_once __DIR__ . '/change_codes.php';

/* ---------------------------------------------------------------
 |  Session — hardened cookies + idle timeout
 * --------------------------------------------------------------- */

if (session_status() !== PHP_SESSION_ACTIVE) {
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');

    session_set_cookie_params([
        'lifetime' => 0,
        'path'     => '/',
        'httponly' => true,          // JavaScript can never read the session id
        'secure'   => $https,        // HTTPS only when the site is served over HTTPS
        'samesite' => 'Lax',         // blocks cross-site POSTs (basic CSRF defence)
    ]);
    ini_set('session.use_strict_mode', '1');
    session_name('fooday_session');
    session_start();
}

/* ---------------------------------------------------------------
 |  Database
 * --------------------------------------------------------------- */

/*
 * Database connection.
 *
 * Every value is read from the environment first (a hosting panel sets real
 * environment variables, and those always win) and only then from .env, so the
 * same code runs untouched on a laptop and in the cloud. The defaults keep a
 * stock WAMP/XAMPP install working with no configuration at all.
 */
define('DB_HOST', env('DB_HOST', '127.0.0.1'));
define('DB_NAME', env('DB_DATABASE', 'fooday_db'));
define('DB_USER', env('DB_USERNAME', 'root'));
define('DB_PASS', env('DB_PASSWORD', ''));
define('DB_PORT', env_int('DB_PORT', 3306));
const DB_CHARSET = 'utf8mb4';

/* ---------------------------------------------------------------
 |  Order pipeline
 *   Order Placed -> Accepted -> Preparing -> On the Way -> Delivered
 *   Cancelled is reachable from any active status.
 * --------------------------------------------------------------- */

const ORDER_FLOW = ['Order Placed', 'Accepted', 'Preparing', 'On the Way', 'Delivered'];
const ORDER_ACTIVE = ['Order Placed', 'Accepted', 'Preparing', 'On the Way'];
const ORDER_DONE = ['Delivered', 'Cancelled'];
const ORDER_NEXT = [
    'Order Placed' => 'Accepted',
    'Accepted'     => 'Preparing',
    'Preparing'    => 'On the Way',
    'On the Way'   => 'Delivered',
];
const ORDER_LABEL = [
    'Order Placed' => 'Awaiting acceptance',
    'Accepted'     => 'Order accepted',
    'Preparing'    => 'Preparing your food',
    'On the Way'   => 'Delivery on the way',
    'Delivered'    => 'Delivered',
    'Cancelled'    => 'Cancelled',
];

/** The bcrypt hash seeded in fooday.sql, used only to warn if it is unchanged. */
const FOODAY_SEED_PASSWORD_HASH = '$2y$10$ReXRyNhJqVHW7wcASOXGVege8iWRLzt83teFLFQwFlMQoK6LAYWz2';

/** Maps a status to the timestamp column that records when it was reached. */
const ORDER_STAMP = [
    'Accepted'   => 'accepted_at',
    'Preparing'  => 'prepared_at',
    'On the Way' => 'dispatched_at',
    'Delivered'  => 'delivered_at',
    'Cancelled'  => 'cancelled_at',
];

/** Payment methods that are settled in cash at the door. */
const ORDER_CASH_METHODS = ['Cash on Delivery', 'COD', 'Cash'];

/** How many delivery addresses one customer may keep in their address book. */
const ADDRESS_LIMIT = 10;

/**
 * The single step an order is waiting for, or null once it can go no further.
 *
 * Both the admin pipeline (api/orders.php) and the order feed read the next
 * step from here, so the timeline the customer sees and the one staff may move
 * to can never disagree. A finished order — `Delivered` or `Cancelled` — has no
 * next step, and is never advanced again.
 */
function order_next_status(string $status): ?string
{
    return ORDER_NEXT[$status] ?? null;
}


/** True when the order is paid in cash on delivery, so it needs a tender recorded. */
function order_is_cod(array $order): bool
{
    return in_array(trim((string) ($order['payment_method'] ?? '')), ORDER_CASH_METHODS, true);
}

/** Peso amount for messages and history notes: 1234.5 -> "1,234.50". */
function pesos(float $amount): string
{
    return number_format($amount, 2);
}

/**
 * Works out the cash taken and the change due for a delivery.
 * Returns null when the order is not settled in cash.
 *
 * @return array{cash:float,change:float}|null
 */
function order_settle_cash(array $order, string $raw): ?array
{
    if (!order_is_cod($order)) {
        return null;
    }
    if ($raw === '') {
        throw new ApiError('Enter the cash the customer handed over before completing this order.');
    }
    if (!is_numeric($raw)) {
        throw new ApiError('Cash received must be a number.');
    }

    $cash = round((float) $raw, 2);
    $due  = round((float) $order['total'], 2);
    if ($cash + 0.005 < $due) {
        throw new ApiError('Cash received is less than the amount due (' . pesos($due) . ').');
    }

    return ['cash' => $cash, 'change' => round($cash - $due, 2)];
}

/** Raised for expected errors; carries an HTTP status code. */
class ApiError extends Exception
{
    public int $status;

    public function __construct(string $message, int $status = 400)
    {
        parent::__construct($message);
        $this->status = $status;
    }
}

set_exception_handler(function (Throwable $e): void {
    // A curated ApiError carries a message the user can act on (including the
    // setup hints for an empty database). Anything else is unexpected, so its
    // detail goes to the server log and the client gets a generic line — a raw
    // PDO/stack message must never be echoed to the browser in production.
    if ($e instanceof ApiError) {
        $status  = $e->status;
        $message = $e->getMessage();
    } else {
        $status  = 500;
        $message = 'Something went wrong. Please try again.';
    }
    if ($status >= 500) {
        error_log('FOODAY: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    }
    json_out(['ok' => false, 'error' => $message], $status);
});

function db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $dsn = 'mysql:host=' . DB_HOST . ';port=' . DB_PORT . ';dbname=' . DB_NAME . ';charset=' . DB_CHARSET;
        try {
            $pdo = new PDO($dsn, DB_USER, DB_PASS, [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
            ]);
        } catch (PDOException $e) {
            throw new ApiError(
                'Could not connect to the FOODAY database. Check api/config.php and make sure fooday.sql was imported.',
                500
            );
        }
        try {
            fooday_migrate($pdo);
        } catch (ApiError $e) {
            // Already curated for the user (e.g. "import fooday.sql").
            throw $e;
        } catch (Throwable $e) {
            error_log('FOODAY migration failed: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
            throw new ApiError('Could not upgrade the FOODAY database schema. See the server log for details.', 500);
        }
        fooday_session_guard();
    }
    return $pdo;
}

/* ---------------------------------------------------------------
 |  Requests / responses
 * --------------------------------------------------------------- */

function json_out($data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($data);
    exit;
}

function ok(array $extra = []): void
{
    json_out(['ok' => true] + $extra);
}

/** Request payload: JSON body, falling back to form/query params. */
function body(): array
{
    $raw = file_get_contents('php://input');
    if (is_string($raw) && $raw !== '') {
        $json = json_decode($raw, true);
        if (is_array($json)) {
            return $json;
        }
    }
    return $_POST ?: $_GET;
}

function field(array $data, string $key, string $default = ''): string
{
    return trim((string) ($data[$key] ?? $default));
}

function valid_email(string $v): bool
{
    return (bool) filter_var($v, FILTER_VALIDATE_EMAIL);
}

function valid_phone(string $v): bool
{
    return (bool) preg_match('/^09\d{9}$/', $v);
}

function valid_name(string $v): bool
{
    return (bool) preg_match("/^[A-Za-z][A-Za-z\\s.'-]*$/", $v);
}

function capitalize(string $v): string
{
    return mb_convert_case(trim($v), MB_CASE_TITLE, 'UTF-8');
}

function client_ip(): string
{
    return substr((string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'), 0, 45);
}

function mask_phone(string $phone): string
{
    $phone = preg_replace('/\D/', '', $phone) ?? '';
    return strlen($phone) === 11 ? substr($phone, 0, 3) . ' ' . str_repeat('•', 7) . ' ' . substr($phone, -2) : str_repeat('•', 11);
}

function mask_name(string $name): string
{
    $parts = preg_split('/\s+/', trim($name)) ?: [];
    if (!$parts) {
        return str_repeat('•', 4);
    }
    $out = [];
    foreach ($parts as $i => $part) {
        $out[] = $i === 0
            ? mb_substr($part, 0, 1) . str_repeat('•', max(1, mb_strlen($part) - 1))
            : str_repeat('•', mb_strlen($part));
    }
    return implode(' ', $out);
}

/** Keeps enough of an address to recognise it, not enough to use it. */
function mask_email(string $email): string
{
    $email = trim($email);
    $at = strrpos($email, '@');
    if ($at === false || $at === 0) {
        return str_repeat('•', 4);
    }
    $local = substr($email, 0, $at);
    $domain = substr($email, $at);
    $head = mb_substr($local, 0, 1);
    $tail = mb_strlen($local) > 2 ? mb_substr($local, -1) : '';
    return $head . str_repeat('•', max(2, mb_strlen($local) - 1 - mb_strlen($head) - mb_strlen($tail))) . $tail . $domain;
}

/* ---------------------------------------------------------------
 |  Settings store  (Admin > Settings)
 * --------------------------------------------------------------- */

function settings_all(): array
{
    if (!isset($GLOBALS['__fooday_settings']) || !is_array($GLOBALS['__fooday_settings'])) {
        $GLOBALS['__fooday_settings'] = [];
        try {
            $GLOBALS['__fooday_settings'] = db()
                ->query('SELECT k, v FROM settings')
                ->fetchAll(PDO::FETCH_KEY_PAIR);
        } catch (Throwable $e) {
            $GLOBALS['__fooday_settings'] = [];
        }
    }
    return $GLOBALS['__fooday_settings'];
}

function setting(string $key, string $default = ''): string
{
    $all = settings_all();
    $v = $all[$key] ?? null;
    return ($v === null || $v === '') ? $default : (string) $v;
}

function setting_int(string $key, int $default = 0): int
{
    $v = setting($key, (string) $default);
    return is_numeric($v) ? (int) $v : $default;
}

function setting_bool(string $key, bool $default = false): bool
{
    $v = setting($key, $default ? '1' : '0');
    return $v === '1' || strtolower($v) === 'true' || strtolower($v) === 'on';
}

function setting_set(string $key, string $value): void
{
    $stmt = db()->prepare(
        'INSERT INTO settings (k, v) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE v = VALUES(v)'
    );
    $stmt->execute([$key, $value]);
    settings_cache_reset();
}

function setting_set_many(array $pairs): void
{
    $stmt = db()->prepare(
        'INSERT INTO settings (k, v) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE v = VALUES(v)'
    );
    foreach ($pairs as $k => $v) {
        $stmt->execute([(string) $k, (string) $v]);
    }
    settings_cache_reset();
}

/** settings_all() memoises for the request, so a save has to drop the copy. */
function settings_cache_reset(): void
{
    unset($GLOBALS['__fooday_settings']);
}

/** The subset of settings the customer app is allowed to see. */
function public_config(): array
{
    return [
        'store_name'          => setting('store_name', 'FOODAY'),
        'store_tagline'       => setting('store_tagline', 'Good Food, Anytime, Anywhere.'),
        'support_email'       => setting('support_email', ''),
        'support_phone'       => setting('support_phone', ''),
        'store_open'          => setting_bool('store_open', true),
        'prep_minutes'        => max(5, setting_int('order_prep_minutes', 30)),
        'min_total'           => max(0, setting_int('order_min_total', 0)),
        'allow_cancel'        => setting_bool('order_allow_cancel', true),
        'cancel_window'       => max(0, setting_int('order_cancel_window', 5)),
        'cod_enabled'         => setting_bool('pay_cod_enabled', true),
        'gcash_enabled'       => setting_bool('pay_gcash_enabled', false),
        'pw_min_length'       => max(6, min(32, setting_int('password_min_length', 6))),
        'address_limit'       => ADDRESS_LIMIT,
    ];
}

/* ---------------------------------------------------------------
 |  Session guards
 * --------------------------------------------------------------- */

function fooday_session_guard(): void
{
    $minutes = setting_int('session_idle_minutes', 60);
    if ($minutes <= 0) {
        return;
    }
    $now = time();
    $last = (int) ($_SESSION['last_seen'] ?? 0);
    if ($last > 0 && ($now - $last) > $minutes * 60) {
        $_SESSION = [];
        session_regenerate_id(true);
        $GLOBALS['__fooday_session_expired'] = true;
        return;
    }
    $_SESSION['last_seen'] = $now;
}

function session_was_expired(): bool
{
    return !empty($GLOBALS['__fooday_session_expired']);
}

function current_user(): ?array
{
    if (empty($_SESSION['user_id'])) {
        return null;
    }
    $stmt = db()->prepare(
        'SELECT id, name, email, phone, profile_image, auth_version, last_login FROM users WHERE id = ?'
    );
    $stmt->execute([(int) $_SESSION['user_id']]);
    $user = $stmt->fetch();
    if (!$user) {
        unset($_SESSION['user_id']);
        return null;
    }
    // A password change bumps auth_version, silently dropping old sessions.
    if ((int) ($_SESSION['user_auth'] ?? 0) !== (int) $user['auth_version']) {
        unset($_SESSION['user_id'], $_SESSION['user_auth']);
        return null;
    }
    return [
        'id'            => (int) $user['id'],
        'name'          => $user['name'],
        'email'         => $user['email'],
        'phone'         => $user['phone'],
        'profile_image' => $user['profile_image'] ?? '',
        'last_login'    => $user['last_login'] ?? null,
    ];
}

function require_user(): array
{
    $user = current_user();
    if ($user === null) {
        throw new ApiError('Please sign in to continue.', 401);
    }
    return $user;
}

function sign_in_user(PDO $pdo, int $userId): void
{
    session_regenerate_id(true);          // blocks session fixation
    $versionStmt = $pdo->prepare('SELECT auth_version FROM users WHERE id = ?');
    $versionStmt->execute([$userId]);
    $version = (int) $versionStmt->fetchColumn();
    $_SESSION['user_id']    = $userId;
    $_SESSION['user_auth']  = $version ?: 1;
    $_SESSION['last_seen']  = time();
    $up = $pdo->prepare('UPDATE users SET last_login = NOW() WHERE id = ?');
    $up->execute([$userId]);
}

function current_admin(): bool
{
    return current_admin_data() !== null;
}

function current_admin_data(): ?array
{
    if (empty($_SESSION['admin_id'])) {
        return null;
    }
    $stmt = db()->prepare(
        'SELECT id, name, email, phone, profile_image, auth_version, last_login, created_at
           FROM admins WHERE id = ?'
    );
    $stmt->execute([(int) $_SESSION['admin_id']]);
    $admin = $stmt->fetch();
    if (!$admin) {
        unset($_SESSION['admin_id']);
        return null;
    }
    if ((int) ($_SESSION['admin_auth'] ?? 0) !== (int) $admin['auth_version']) {
        unset($_SESSION['admin_id'], $_SESSION['admin_auth']);
        return null;
    }
    return [
        'id'            => (int) $admin['id'],
        'name'          => $admin['name'],
        'email'         => $admin['email'],
        'phone'         => $admin['phone'] ?? '',
        'profile_image' => $admin['profile_image'] ?? '',
        'last_login'    => $admin['last_login'] ?? null,
        'created_at'    => $admin['created_at'] ?? null,
    ];
}

function require_admin(): array
{
    $admin = current_admin_data();
    if ($admin === null) {
        throw new ApiError('Admin access required.', 403);
    }
    return $admin;
}

function sign_in_admin(PDO $pdo, int $adminId): void
{
    session_regenerate_id(true);
    $versionStmt = $pdo->prepare('SELECT auth_version FROM admins WHERE id = ?');
    $versionStmt->execute([$adminId]);
    $version = (int) $versionStmt->fetchColumn();
    unset($_SESSION['user_id'], $_SESSION['user_auth']);
    $_SESSION['admin_id']    = $adminId;
    $_SESSION['admin_auth']  = $version ?: 1;
    $_SESSION['last_seen']   = time();
    $up = $pdo->prepare('UPDATE admins SET last_login = NOW() WHERE id = ?');
    $up->execute([$adminId]);
}

function sign_out_all(): void
{
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
    }
    session_regenerate_id(true);
}

/* ---------------------------------------------------------------
 |  Passwords
 * --------------------------------------------------------------- */

/** Accepts a hashed password or the plain-text seed value from fooday.sql. */
function password_matches(string $input, string $stored): bool
{
    return password_verify($input, $stored) || hash_equals($stored, $input);
}

/** Replaces a plain-text seed password with a hash after a successful login. */
function upgrade_admin_password(int $adminId, string $stored, string $input): void
{
    if (str_starts_with($stored, '$2')) {
        return;
    }
    $up = db()->prepare('UPDATE admins SET password = ? WHERE id = ?');
    $up->execute([password_hash($input, PASSWORD_DEFAULT), $adminId]);
}

/**
 * Applies the password policy. Letters and numbers are always required;
 * only the minimum length is configurable (Admin > Settings > Security).
 * Returns a human-readable reason, or null when the password is acceptable.
 */
function password_problem(string $password): ?string
{
    $min = max(6, min(32, setting_int('password_min_length', 6)));
    if (strlen($password) < $min) {
        return "Password must be at least {$min} characters.";
    }
    if (!preg_match('/[A-Za-z]/', $password) || !preg_match('/\d/', $password)) {
        return 'Password must contain both letters and numbers.';
    }
    if (preg_match('/^(123456|password|admin123|fooday123)$/i', $password)) {
        return 'That password is too common. Please choose another one.';
    }
    return null;
}

/** Rough strength score (0-4) used by the password meter in the UI. */
function password_strength(string $password): array
{
    $score = 0;
    if (strlen($password) >= 8) { $score++; }
    if (strlen($password) >= 12) { $score++; }
    if (preg_match('/[A-Za-z]/', $password) && preg_match('/\d/', $password)) { $score++; }
    if (preg_match('/[^A-Za-z0-9]/', $password)) { $score++; }
    $labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];
    return ['score' => $score, 'label' => $labels[$score]];
}

/**
 * Re-checks the admin's own password before a sensitive action. Always on:
 * no setting can turn it off.
 */
function confirm_admin_password(PDO $pdo, string $password): void
{
    $stmt = $pdo->prepare('SELECT password FROM admins WHERE id = ?');
    $stmt->execute([(int) $_SESSION['admin_id']]);
    $stored = (string) $stmt->fetchColumn();
    if ($stored === '' || !password_matches($password, $stored)) {
        throw new ApiError('Please enter your current admin password to confirm this change.');
    }
}

/* ---------------------------------------------------------------
 |  Brute-force protection
 * --------------------------------------------------------------- */

function login_is_blocked(string $email): int
{
    $max   = max(1, min(50, setting_int('login_max_attempts', 5)));
    $after = max(1, min(1440, setting_int('login_lockout_minutes', 15)));
    $stmt  = db()->prepare(
        'SELECT COUNT(*) FROM login_attempts
          WHERE email = ? AND ok = 0 AND created_at > (NOW() - INTERVAL ' . $after . ' MINUTE)'
    );
    $stmt->execute([strtolower($email)]);
    if ((int) $stmt->fetchColumn() < $max) {
        return 0;
    }
    $oldest = db()->prepare(
        'SELECT TIMESTAMPDIFF(SECOND, MIN(created_at), NOW()) FROM login_attempts
          WHERE email = ? AND ok = 0 AND created_at > (NOW() - INTERVAL ' . $after . ' MINUTE)'
    );
    $oldest->execute([strtolower($email)]);
    $wait = $after * 60 - (int) $oldest->fetchColumn();
    return max(1, $wait);
}

function login_record(string $email, bool $success): void
{
    $stmt = db()->prepare('INSERT INTO login_attempts (email, ip, ok) VALUES (?, ?, ?)');
    $stmt->execute([strtolower($email), client_ip(), $success ? 1 : 0]);
    if ($success) {
        $del = db()->prepare('DELETE FROM login_attempts WHERE email = ? AND ok = 0');
        $del->execute([strtolower($email)]);
    } else {
        // keep the table small
        db()->exec('DELETE FROM login_attempts WHERE created_at < (NOW() - INTERVAL 7 DAY)');
    }
}

/* ---------------------------------------------------------------
 |  Order history
 * --------------------------------------------------------------- */

function log_order_event(PDO $pdo, int $orderId, string $status, string $actor = 'system', string $note = ''): void
{
    $stmt = $pdo->prepare('INSERT INTO order_events (order_id, status, note, actor) VALUES (?, ?, ?, ?)');
    $stmt->execute([$orderId, $status, $note !== '' ? mb_substr($note, 0, 255) : null, $actor]);
}

function fetch_order_events(int $orderId): array
{
    $stmt = db()->prepare(
        "SELECT status, note, actor,
                DATE_FORMAT(created_at, '%Y-%m-%d %h:%i %p') AS at
           FROM order_events WHERE order_id = ? ORDER BY id"
    );
    $stmt->execute([$orderId]);
    return array_map(static fn(array $r): array => [
        'status' => $r['status'],
        'note'   => $r['note'] ?? '',
        'actor'  => $r['actor'],
        'at'     => $r['at'],
    ], $stmt->fetchAll());
}

/** True while the customer is still allowed to cancel their own order. */
function order_can_cancel(array $order, ?array $user): bool
{
    if ($user === null || (int) $order['user_id'] !== (int) $user['id']) {
        return false;
    }
    if (!in_array($order['status'], ORDER_ACTIVE, true)) {
        return false;
    }
    if (!setting_bool('order_allow_cancel', true)) {
        return false;
    }
    $window = max(0, setting_int('order_cancel_window', 5));
    if ($window === 0) {
        return true;
    }
    $placed = strtotime((string) $order['placed_at']);
    return $placed !== false && (time() - $placed) <= $window * 60;
}

/* ---------------------------------------------------------------
 |  Row mappers (DB rows -> shapes the frontend already uses)
 * --------------------------------------------------------------- */

/** @return array<string,mixed> */
function product_map(array $r): array
{
    return [
        'id'          => (int) $r['id'],
        'name'        => $r['name'],
        'price'       => (float) $r['price'],
        'rating'      => (float) $r['rating'],
        'reviews'     => (int) $r['reviews'],
        'desc'        => $r['desc'] ?? '',
        'img'         => $r['img'] ?? '',
        'category'    => $r['category'] ?? '',
        'available'   => !isset($r['is_available']) || (int) $r['is_available'] === 1,
    ];
}

const PRODUCT_SELECT = 'SELECT p.id, p.name, p.price, p.rating, p.reviews,
                                p.description AS `desc`, p.image AS img, p.is_available, c.name AS category
                           FROM products p
                           LEFT JOIN categories c ON c.id = p.category_id';

function fetch_categories(): array
{
    $rows = db()->query('SELECT name, icon, is_locked FROM categories ORDER BY id')->fetchAll();
    return array_map(static fn(array $r): array => [
        'name'   => $r['name'],
        'icon'   => $r['icon'],
        'locked' => (bool) $r['is_locked'],
    ], $rows);
}

function fetch_products(bool $includeUnavailable = true): array
{
    $sql = PRODUCT_SELECT . ' ORDER BY p.id';
    if (!$includeUnavailable) {
        $sql = PRODUCT_SELECT . ' WHERE p.is_available = 1 ORDER BY p.id';
    }
    return array_map('product_map', db()->query($sql)->fetchAll());
}

function fetch_areas(): array
{
    $rows = db()->query('SELECT name, fee FROM delivery_areas ORDER BY id')->fetchAll();
    return array_map(static fn(array $r): array => [
        'name' => $r['name'],
        'fee'  => $r['fee'],
    ], $rows);
}

function fetch_announcements(): array
{
    $rows = db()->query(
        "SELECT id, title, message, icon,
                DATE_FORMAT(created_at, '%Y-%m-%d %h:%i %p') AS date
           FROM announcements
         ORDER BY id DESC"
    )->fetchAll();
    return array_map(static fn(array $r): array => [
        'id'      => (int) $r['id'],
        'title'   => $r['title'],
        'message' => $r['message'],
        'icon'    => $r['icon'],
        'date'    => $r['date'],
    ], $rows);
}

function fetch_favorites(int $userId): array
{
    $stmt = db()->prepare(
        PRODUCT_SELECT . '
           JOIN favorites f ON f.product_id = p.id
          WHERE f.user_id = ?
          ORDER BY p.id'
    );
    $stmt->execute([$userId]);
    return array_map('product_map', $stmt->fetchAll());
}

function fetch_addresses(int $userId): array
{
    $stmt = db()->prepare(
        'SELECT id, label, address, landmark, lat, lng, is_default
           FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id'
    );
    $stmt->execute([$userId]);
    return array_map(static fn(array $r): array => [
        'id'         => (int) $r['id'],
        'label'      => $r['label'] ?: 'Home',
        'address'    => $r['address'],
        'landmark'   => $r['landmark'] ?? '',
        'lat'        => $r['lat'] === null ? null : (float) $r['lat'],
        'lng'        => $r['lng'] === null ? null : (float) $r['lng'],
        'is_default' => (bool) $r['is_default'],
    ], $stmt->fetchAll());
}

/**
 * The GPS point that came with an address, if the customer pinned one.
 *
 * Both numbers have to be there and in range: a half-read pin (a latitude with
 * no longitude) points nowhere, so it is rejected rather than stored.
 *
 * @return array{0: float|null, 1: float|null}
 */
function address_point(array $data): array
{
    $lat = trim((string) ($data['lat'] ?? ''));
    $lng = trim((string) ($data['lng'] ?? ''));

    if ($lat === '' || $lng === '') {
        return [null, null];
    }
    if (!is_numeric($lat) || !is_numeric($lng)) {
        throw new ApiError('That location pin is not valid. Please try again.');
    }

    $lat = round((float) $lat, 7);
    $lng = round((float) $lng, 7);
    if ($lat < -90 || $lat > 90 || $lng < -180 || $lng > 180) {
        throw new ApiError('That location pin is outside the map. Please try again.');
    }
    return [$lat, $lng];
}

/**
 * One saved address, cleaned up and ready for the database. Shared by sign-up
 * and Settings > Addresses so a typed address and a pinned one are stored
 * exactly the same way, whichever screen the customer used.
 *
 * @return array{label:string,address:string,landmark:?string,lat:?float,lng:?float}
 */
function address_input(array $data): array
{
    $address  = trim((string) ($data['address'] ?? ''));
    $landmark = mb_substr(trim((string) ($data['landmark'] ?? '')), 0, 190);
    $label    = mb_substr(trim((string) ($data['label'] ?? '')), 0, 40) ?: 'Home';

    if ($address === '') {
        throw new ApiError('Please enter a complete address.');
    }

    [$lat, $lng] = address_point($data);

    return [
        'label'    => $label,
        'address'  => $address,
        'landmark' => $landmark !== '' ? $landmark : null,
        'lat'      => $lat,
        'lng'      => $lng,
    ];
}

/** @param array{label:string,address:string,landmark:?string,lat:?float,lng:?float} $a */
function address_insert(PDO $pdo, int $userId, array $a, bool $isDefault): void
{
    $pdo->prepare(
        'INSERT INTO addresses (user_id, label, address, landmark, lat, lng, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?)'
    )->execute([$userId, $a['label'], $a['address'], $a['landmark'], $a['lat'], $a['lng'], $isDefault ? 1 : 0]);
}

function address_count(int $userId): int
{
    $stmt = db()->prepare('SELECT COUNT(*) FROM addresses WHERE user_id = ?');
    $stmt->execute([$userId]);
    return (int) $stmt->fetchColumn();
}

/**
 * True when an account already holds as many addresses as it may keep.
 *
 * Kept apart from the counting itself, which needs the database: the two halves
 * of saving an address are "how many are there" (SQL) and "is that too many"
 * (this), and only the second is worth a unit test.
 */
function address_limit_reached(int $count): bool
{
    return $count >= ADDRESS_LIMIT;
}

/** The refusal shown when a customer's address book is full. */
function address_limit_error(): ApiError
{
    return new ApiError(
        'You can save up to ' . ADDRESS_LIMIT . ' addresses. Delete one to add another.'
    );
}

/**
 * @param int|null $userId  Pass a user id to limit to that customer, or null for every order (admin).
 * @param bool     $isAdmin When true, the Admin > Settings > Privacy switches are applied.
 */
function fetch_orders(?int $userId, bool $isAdmin = false): array
{
    $columns = 'id, order_code, user_id, customer_name, contact_phone, area, address, landmark,
                       order_note, admin_note, cancel_reason, payment_method, status, subtotal,
                       delivery_fee, total, source, placed_at, status_updated, cash_tendered, change_due,
                       accepted_at, prepared_at, dispatched_at, delivered_at, cancelled_at';

    if ($userId === null) {
        $stmt = db()->query(
            "SELECT $columns, DATE_FORMAT(placed_at, '%Y-%m-%d %h:%i %p') AS placed
               FROM orders ORDER BY id DESC"
        );
    } else {
        $stmt = db()->prepare(
            "SELECT $columns, DATE_FORMAT(placed_at, '%Y-%m-%d %h:%i %p') AS placed
               FROM orders WHERE user_id = ? ORDER BY id DESC"
        );
        $stmt->execute([$userId]);
    }
    $rows = $stmt->fetchAll();
    if (!$rows) {
        return [];
    }

    $ids  = array_column($rows, 'id');
    $in   = implode(',', array_fill(0, count($ids), '?'));
    $itemStmt = db()->prepare(
        "SELECT order_id, name, price, qty, subtotal, note FROM order_items WHERE order_id IN ($in) ORDER BY id"
    );
    $itemStmt->execute($ids);
    $items = [];
    foreach ($itemStmt->fetchAll() as $it) {
        $items[(int) $it['order_id']][] = [
            'name'     => $it['name'],
            'price'    => (float) $it['price'],
            'qty'      => (int) $it['qty'],
            'subtotal' => (float) $it['subtotal'],
            'note'     => $it['note'] ?? '',
        ];
    }

    $eventStmt = db()->prepare(
        "SELECT order_id, status, note, actor, DATE_FORMAT(created_at, '%Y-%m-%d %h:%i %p') AS at
           FROM order_events WHERE order_id IN ($in) ORDER BY id"
    );
    $eventStmt->execute($ids);
    $events = [];
    foreach ($eventStmt->fetchAll() as $ev) {
        $events[(int) $ev['order_id']][] = [
            'status' => $ev['status'],
            'note'   => $ev['note'] ?? '',
            'actor'  => $ev['actor'],
            'at'     => $ev['at'],
        ];
    }

    $viewer = $userId !== null ? ['id' => $userId] : null;
    $showContact = !$isAdmin || setting_bool('privacy_show_contact', true);
    $showNotes   = !$isAdmin || setting_bool('privacy_show_notes', true);

    return array_map(static function (array $r) use ($items, $events, $viewer, $showContact, $showNotes, $isAdmin): array {
        $id = (int) $r['id'];
        return [
            'id'            => $r['order_code'],
            'date'          => $r['placed'],
            'customer'      => $showContact ? $r['customer_name'] : mask_name((string) $r['customer_name']),
            'phone'         => $showContact ? $r['contact_phone'] : mask_phone((string) $r['contact_phone']),
            'contactHidden' => !$showContact,
            'area'          => $showContact ? ($r['area'] ?? '') : '',
            'address'       => $showContact ? ($r['address'] ?? '') : '',
            'landmark'      => $showContact ? ($r['landmark'] ?? '') : '',
            'note'          => $showNotes ? ($r['order_note'] ?? '') : '',
            'noteHidden'    => !$showNotes,
            'adminNote'     => $isAdmin ? ($r['admin_note'] ?? '') : '',
            'cancelReason'  => $r['cancel_reason'] ?? '',
            'paymentMethod' => $r['payment_method'],
            'status'        => $r['status'],
            'statusLabel'   => ORDER_LABEL[$r['status']] ?? $r['status'],
            'subtotal'      => (float) $r['subtotal'],
            'deliveryFee'   => (float) $r['delivery_fee'],
            'total'         => (float) $r['total'],
            'source'        => $r['source'] ?? 'Cart',
            'items'         => $items[$id] ?? [],
            'events'        => $events[$id] ?? [],
            'placedAt'      => $r['placed_at'],
            'statusUpdated' => $r['status_updated'],
            'times'         => [
                'accepted'   => $r['accepted_at'],
                'prepared'   => $r['prepared_at'],
                'dispatched' => $r['dispatched_at'],
                'delivered'  => $r['delivered_at'],
                'cancelled'  => $r['cancelled_at'],
            ],
            'canCancel'     => $viewer !== null && order_can_cancel($r, $viewer),
            'nextStatus'    => order_next_status((string) $r['status']),
            'isCod'         => order_is_cod($r),
            'cashTendered'  => $r['cash_tendered'] === null ? null : (float) $r['cash_tendered'],
            'changeDue'     => $r['change_due'] === null ? null : (float) $r['change_due'],
        ];
    }, $rows);
}
