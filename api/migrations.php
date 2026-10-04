<?php
declare(strict_types=1);

/**
 * FOODAY — in-place schema upgrade.
 *
 * The app was originally built against schema v1. Everything that
 * v2 added (the order pipeline, the settings store, the order history
 * table, the security columns), v3 added (the cash-on-delivery
 * tender), v5 added (favorites, two-factor sign-in), v7 added
 * (the GPS point on a saved address) and v9 added (the emailed
 * confirmation codes for changing an email or password) is applied here
 * automatically the first time the app connects, so an existing install
 * keeps all of its data and never has to re-import fooday.sql.
 *
 * The whole routine is idempotent and guarded by fooday_meta.schema_version,
 * so it costs one cheap SELECT per request.
 */

const FOODAY_SCHEMA_VERSION = '9';

/** @return array<int,string> */
function fooday_all_tables(PDO $pdo): array
{
    $sql = 'SELECT TABLE_NAME FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE()';
    return $pdo->query($sql)->fetchAll(PDO::FETCH_COLUMN);
}

function fooday_table_exists(PDO $pdo, string $table): bool
{
    static $cache = null;
    if ($cache === null) {
        $cache = array_map('strtolower', fooday_all_tables($pdo));
    }
    return in_array(strtolower($table), $cache, true);
}

function fooday_column_exists(PDO $pdo, string $table, string $column): bool
{
    $stmt = $pdo->prepare(
        'SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?'
    );
    $stmt->execute([$table, $column]);
    return (bool) $stmt->fetchColumn();
}

function fooday_create_table(PDO $pdo, string $sql): void
{
    $pdo->exec($sql);
}

/** Adds a column only when it is missing, so re-running is harmless. */
function fooday_add_column(PDO $pdo, string $table, string $column, string $definition): void
{
    if (fooday_table_exists($pdo, $table) && !fooday_column_exists($pdo, $table, $column)) {
        $pdo->exec("ALTER TABLE `$table` ADD COLUMN `$column` $definition");
    }
}

function fooday_add_index(PDO $pdo, string $table, string $index, string $column): void
{
    if (!fooday_table_exists($pdo, $table) || !fooday_column_exists($pdo, $table, $column)) {
        return;
    }
    $stmt = $pdo->prepare(
        'SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?'
    );
    $stmt->execute([$table, $index]);
    if ($stmt->fetchColumn()) {
        return;
    }
    $pdo->exec("CREATE INDEX `$index` ON `$table` (`$column`)");
}

function fooday_meta_get(PDO $pdo, string $key): ?string
{
    $stmt = $pdo->prepare('SELECT v FROM fooday_meta WHERE k = ?');
    $stmt->execute([$key]);
    $v = $stmt->fetchColumn();
    return $v === false ? null : (string) $v;
}

function fooday_meta_set(PDO $pdo, string $key, string $value): void
{
    $stmt = $pdo->prepare(
        'INSERT INTO fooday_meta (k, v) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE v = VALUES(v)'
    );
    $stmt->execute([$key, $value]);
}

/** Default values written the first time the settings store is created. */
function fooday_default_settings(): array
{
    return [
        'store_name'                  => 'FOODAY',
        'store_tagline'               => 'Good Food, Anytime, Anywhere.',
        'support_email'               => 'support@fooday.ph',
        'support_phone'               => '0917 000 0000',
        'store_open'                  => '1',
        'order_auto_accept'           => '0',
        'order_prep_minutes'          => '30',
        'order_allow_cancel'          => '1',
        'order_cancel_window'         => '5',
        'order_min_total'             => '0',
        'pay_cod_enabled'             => '1',
        'pay_gcash_enabled'           => '0',
        'privacy_show_contact'        => '1',
        'privacy_show_notes'          => '1',
        'password_min_length'         => '6',
        'login_max_attempts'          => '5',
        'login_lockout_minutes'       => '15',
        'session_idle_minutes'        => '60',
    ];
}

function fooday_seed_settings(PDO $pdo): void
{
    $stmt = $pdo->prepare('INSERT IGNORE INTO settings (k, v) VALUES (?, ?)');
    foreach (fooday_default_settings() as $k => $v) {
        $stmt->execute([$k, $v]);
    }
}

function fooday_migrate(PDO $pdo): void
{
    // Bookkeeping table has to exist before we can read the version.
    fooday_create_table($pdo, "CREATE TABLE IF NOT EXISTS fooday_meta (
        k VARCHAR(60) NOT NULL,
        v VARCHAR(190) NOT NULL,
        PRIMARY KEY (k)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    if (fooday_meta_get($pdo, 'schema_version') === FOODAY_SCHEMA_VERSION) {
        return; // already up to date
    }

    // The gate above is all-or-nothing, so a version number and the columns it
    // adds must always ship together — otherwise an install that connects in
    // between the two is marked up to date and never receives them. Bumping the
    // number again is what repairs such an install.

    // Fresh install? The tables are not there yet, so there is nothing
    // to upgrade — the user just needs to import fooday.sql.
    if (!fooday_table_exists($pdo, 'orders')) {
        throw new ApiError(
            'The FOODAY database is empty. Please import fooday.sql into "' . DB_NAME . '" using HeidiSQL or phpMyAdmin.',
            500
        );
    }

    /* --- users --- */
    fooday_add_column($pdo, 'users', 'auth_version', 'INT UNSIGNED NOT NULL DEFAULT 1');
    fooday_add_column($pdo, 'users', 'last_login',   'TIMESTAMP NULL DEFAULT NULL');

    /* --- admins --- */
    fooday_add_column($pdo, 'admins', 'phone',         'VARCHAR(11) NULL');
    fooday_add_column($pdo, 'admins', 'profile_image', 'LONGTEXT NULL');
    fooday_add_column($pdo, 'admins', 'auth_version',  'INT UNSIGNED NOT NULL DEFAULT 1');
    fooday_add_column($pdo, 'admins', 'last_login',    'TIMESTAMP NULL DEFAULT NULL');
    fooday_add_column($pdo, 'admins', 'updated_at',    'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    /* --- products --- */
    fooday_add_column($pdo, 'products', 'is_available', 'TINYINT(1) NOT NULL DEFAULT 1');
    fooday_add_column($pdo, 'products', 'updated_at',   'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    /* --- addresses --- */
    fooday_add_column($pdo, 'addresses', 'label',      "VARCHAR(40) NOT NULL DEFAULT 'Home'");
    fooday_add_column($pdo, 'addresses', 'is_default', 'TINYINT(1) NOT NULL DEFAULT 0');
    // GPS pin behind a saved address. Both are NULL for a hand-typed address.
    fooday_add_column($pdo, 'addresses', 'lat', 'DECIMAL(10,7) NULL DEFAULT NULL');
    fooday_add_column($pdo, 'addresses', 'lng', 'DECIMAL(10,7) NULL DEFAULT NULL');

    /* --- orders: new status, delivery fee, source, per-step timestamps --- */
    $pdo->exec("ALTER TABLE orders MODIFY status ENUM(
        'Order Placed','Accepted','Preparing','On the Way','Delivered','Cancelled'
    ) NOT NULL DEFAULT 'Order Placed'");
    fooday_add_column($pdo, 'orders', 'delivery_fee',  'DECIMAL(10,2) NOT NULL DEFAULT 0.00');
    fooday_add_column($pdo, 'orders', 'source',        "VARCHAR(20) NOT NULL DEFAULT 'Cart'");
    fooday_add_column($pdo, 'orders', 'admin_note',    'VARCHAR(255) NULL');
    fooday_add_column($pdo, 'orders', 'cancel_reason', 'VARCHAR(190) NULL');
    fooday_add_column($pdo, 'orders', 'accepted_at',   'TIMESTAMP NULL DEFAULT NULL');
    fooday_add_column($pdo, 'orders', 'prepared_at',   'TIMESTAMP NULL DEFAULT NULL');
    fooday_add_column($pdo, 'orders', 'dispatched_at', 'TIMESTAMP NULL DEFAULT NULL');
    fooday_add_column($pdo, 'orders', 'delivered_at',  'TIMESTAMP NULL DEFAULT NULL');
    fooday_add_column($pdo, 'orders', 'cancelled_at',  'TIMESTAMP NULL DEFAULT NULL');
    fooday_add_column($pdo, 'orders', 'cash_tendered', 'DECIMAL(10,2) NULL DEFAULT NULL');
    fooday_add_column($pdo, 'orders', 'change_due',    'DECIMAL(10,2) NULL DEFAULT NULL');
    fooday_add_index($pdo, 'orders', 'idx_orders_placed', 'placed_at');

    /* --- order_items --- */
    fooday_add_column($pdo, 'order_items', 'subtotal', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00');

    /* --- new tables --- */
    fooday_create_table($pdo, "CREATE TABLE IF NOT EXISTS order_events (
        id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
        order_id   INT UNSIGNED NOT NULL,
        status     VARCHAR(40)  NOT NULL,
        note       VARCHAR(255) NULL,
        actor      ENUM('customer','admin','system') NOT NULL DEFAULT 'system',
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_events_order (order_id),
        CONSTRAINT fk_events_order
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    fooday_create_table($pdo, "CREATE TABLE IF NOT EXISTS settings (
        k          VARCHAR(80) NOT NULL,
        v          TEXT        NULL,
        updated_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (k)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    fooday_create_table($pdo, "CREATE TABLE IF NOT EXISTS login_attempts (
        id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        email      VARCHAR(190) NOT NULL,
        ip         VARCHAR(45)  NOT NULL,
        ok         TINYINT(1)   NOT NULL DEFAULT 0,
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_attempts_lookup (email, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    // The favorites table is read on every signed-in bootstrap, so if it is
    // missing the whole app returns 500, not just the favorites screen. It has
    // to be created here as well as in fooday.sql, or an install that was only
    // ever migrated (never re-imported) would stamp itself up to date and skip
    // this table forever.
    fooday_create_table($pdo, "CREATE TABLE IF NOT EXISTS favorites (
        user_id    INT UNSIGNED NOT NULL,
        product_id INT UNSIGNED NOT NULL,
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, product_id),
        KEY idx_favorites_product (product_id),
        CONSTRAINT fk_favorites_user
          FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT fk_favorites_product
          FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    // Two-factor sign-in. actor_type/actor_id deliberately carry no foreign
    // key: one row can belong to either admins or users, and MySQL cannot point
    // a single column at two parent tables. Orphans are swept below instead, and
    // deleting an account removes its MFA rows in mfa_purge_actor().
    fooday_create_table($pdo, "CREATE TABLE IF NOT EXISTS mfa_accounts (
        actor_type         ENUM('admin','user') NOT NULL,
        actor_id           INT UNSIGNED    NOT NULL,
        enabled            TINYINT(1)      NOT NULL DEFAULT 0,
        method             ENUM('email_code') NOT NULL DEFAULT 'email_code',
        secret             CHAR(64)        NOT NULL,
        pending_hash       CHAR(64)        NULL,
        pending_expires_at DATETIME        NULL,
        recovery_hashes    TEXT            NULL,
        enabled_at         DATETIME        NULL,
        last_used_at       DATETIME        NULL,
        created_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (actor_type, actor_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    // One live sign-in code per actor. Issuing a new row retires the previous
    // one, so an older email can never be replayed.
    fooday_create_table($pdo, "CREATE TABLE IF NOT EXISTS mfa_codes (
        id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        actor_type  ENUM('admin','user') NOT NULL,
        actor_id    INT UNSIGNED    NOT NULL,
        code_hash   CHAR(64)        NOT NULL,
        expires_at  DATETIME        NOT NULL,
        attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
        consumed_at DATETIME        NULL,
        created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_mfa_codes_lookup (actor_type, actor_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    // Confirmation codes for changing an email or password. Separate from
    // mfa_codes so the requirement holds even when two-factor sign-in is off.
    fooday_create_table($pdo, "CREATE TABLE IF NOT EXISTS change_codes (
        id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        actor_type  ENUM('admin','user') NOT NULL,
        actor_id    INT UNSIGNED    NOT NULL,
        purpose     ENUM('email','password') NOT NULL,
        code_hash   CHAR(64)        NOT NULL,
        expires_at  DATETIME        NOT NULL,
        attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
        consumed_at DATETIME        NULL,
        created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_change_codes_lookup (actor_type, actor_id, purpose, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    fooday_seed_settings($pdo);

    // Letters and numbers are now required of every password, so the setting
    // that could turn that off is retired rather than left in the table.
    $pdo->exec("DELETE FROM settings WHERE k = 'password_require_mixed'");

    // Give pre-existing orders a starting point in the history timeline.
    $pdo->exec("INSERT INTO order_events (order_id, status, note, actor)
                SELECT o.id, o.status, 'Order imported from the previous version', 'system'
                  FROM orders o
                 WHERE NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id)");

    // mfa_* cannot use foreign keys (see above), so tidy up by hand: codes that
    // are long dead, and rows whose account no longer exists.
    $pdo->exec("DELETE FROM mfa_codes WHERE expires_at < (NOW() - INTERVAL 1 DAY)");
    $pdo->exec("DELETE FROM change_codes WHERE expires_at < (NOW() - INTERVAL 1 DAY)");
    $pdo->exec("DELETE mfa_accounts FROM mfa_accounts
                  LEFT JOIN admins a ON a.id = mfa_accounts.actor_id AND mfa_accounts.actor_type = 'admin'
                  LEFT JOIN users u ON u.id = mfa_accounts.actor_id AND mfa_accounts.actor_type = 'user'
                 WHERE COALESCE(a.id, u.id) IS NULL");
    $pdo->exec("DELETE mfa_codes FROM mfa_codes
                  LEFT JOIN mfa_accounts m
                    ON m.actor_id = mfa_codes.actor_id AND m.actor_type = mfa_codes.actor_type
                 WHERE m.actor_id IS NULL");
    $pdo->exec("DELETE change_codes FROM change_codes
                  LEFT JOIN admins a ON a.id = change_codes.actor_id AND change_codes.actor_type = 'admin'
                  LEFT JOIN users u ON u.id = change_codes.actor_id AND change_codes.actor_type = 'user'
                 WHERE COALESCE(a.id, u.id) IS NULL");

    fooday_meta_set($pdo, 'schema_version', FOODAY_SCHEMA_VERSION);
    fooday_meta_set($pdo, 'upgraded_at', date('Y-m-d H:i:s'));
}

/**
 * Removes an account's MFA rows. Called when an account disappears, since
 * mfa_* has no foreign key to cascade.
 */
function fooday_mfa_purge(PDO $pdo, string $type, int $id): void
{
    $pdo->prepare('DELETE FROM mfa_codes WHERE actor_type = ? AND actor_id = ?')->execute([$type, $id]);
    $pdo->prepare('DELETE FROM change_codes WHERE actor_type = ? AND actor_id = ?')->execute([$type, $id]);
    $pdo->prepare('DELETE FROM mfa_accounts WHERE actor_type = ? AND actor_id = ?')->execute([$type, $id]);
}
