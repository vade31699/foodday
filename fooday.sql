-- ============================================================
--  FOODAY - Database schema v7 (MySQL / MariaDB)
-- ============================================================
--  !!  THIS SCRIPT IS DESTRUCTIVE. IT DELETES EVERYTHING.      !!
--  !!
--  !!  It runs DROP TABLE on all 14 tables below, so every     !!
--  !!  order, customer, address and favourite in the target    !!
--  !!  database is destroyed and cannot be recovered unless     !!
--  !!  you have a backup or binary logging switched on.        !!
--  !!
--  !!  ONLY run this on a brand new, empty server. Never run   !!
--  !!  it against a database that holds real data.             !!
--  !!
--  ALREADY RUNNING AN OLDER VERSION?  Do NOT re-import this
--  file. Just reload the app: api/migrations.php upgrades the
--  existing database in place and keeps all of your data.
--  That is the normal way to update.
--
--  HOW TO PICK THE DATABASE
--    The name is set once, below, at the USE line. Change it
--    there if you do not want `fooday_db`, and change it in
--    api/config.php (DB_NAME) to match, or the app will not
--    find the tables.
--
--  HOW TO INSTALL ON A NEW SERVER (HeidiSQL)
--    1. Connect to your MySQL/MariaDB server.
--    2. File > Load SQL file... (or Query tab > load this file)
--    3. Run the whole script (F9). It creates the database,
--       all tables, and seeds the default data.
--    4. Refresh the database tree - it will appear.
--  From a terminal, run it against a throwaway name instead:
--    mysql -u root -e "CREATE DATABASE scratch_db"
--    (edit the USE line to scratch_db, then)
--    mysql -u root < fooday.sql
-- ============================================================

-- >>> TARGET DATABASE: change `fooday_db` here and in api/config.php DB_NAME <<<
CREATE DATABASE IF NOT EXISTS fooday_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE fooday_db;

SET FOREIGN_KEY_CHECKS = 0;

-- ------------------------------------------------------------
--  EVERYTHING BELOW THIS LINE IS DESTROYED AND RECREATED.
--  If the database you just selected above is not brand new and
--  empty, close this file without running the rest of it.
--  To update an existing install, reload the app instead so
--  api/migrations.php can upgrade it without dropping anything.
-- ------------------------------------------------------------
DROP TABLE IF EXISTS change_codes;
DROP TABLE IF EXISTS mfa_codes;
DROP TABLE IF EXISTS mfa_accounts;
DROP TABLE IF EXISTS order_events;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS favorites;
DROP TABLE IF EXISTS addresses;
DROP TABLE IF EXISTS announcements;
DROP TABLE IF EXISTS delivery_areas;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS login_attempts;
DROP TABLE IF EXISTS admins;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS fooday_meta;
SET FOREIGN_KEY_CHECKS = 1;

-- ------------------------------------------------------------
-- schema bookkeeping (used by api/migrations.php)
-- ------------------------------------------------------------
CREATE TABLE fooday_meta (
  k VARCHAR(60) NOT NULL,
  v VARCHAR(190) NOT NULL,
  PRIMARY KEY (k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- customers
-- ------------------------------------------------------------
CREATE TABLE users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(120)  NOT NULL,
  email         VARCHAR(190)  NOT NULL,
  phone         VARCHAR(11)   NOT NULL,
  password      VARCHAR(255)  NOT NULL,
  profile_image LONGTEXT      NULL,
  -- bumped whenever the password changes, which invalidates every
  -- other session that was signed in with the old password
  auth_version  INT UNSIGNED  NOT NULL DEFAULT 1,
  last_login    TIMESTAMP     NULL DEFAULT NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- admins
--   Sign in with this email from the normal Sign In page and the
--   app opens the admin dashboard.
-- ------------------------------------------------------------
CREATE TABLE admins (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(120) NOT NULL DEFAULT 'FOODAY Admin',
  email         VARCHAR(190) NOT NULL,
  phone         VARCHAR(11)  NULL,
  password      VARCHAR(255) NOT NULL,
  profile_image LONGTEXT     NULL,
  auth_version  INT UNSIGNED NOT NULL DEFAULT 1,
  last_login    TIMESTAMP    NULL DEFAULT NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admins_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- food categories
-- ------------------------------------------------------------
CREATE TABLE categories (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(80)  NOT NULL,
  icon       VARCHAR(16)  NOT NULL DEFAULT '🍴',
  is_locked  TINYINT(1)   NOT NULL DEFAULT 0,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- products
-- ------------------------------------------------------------
CREATE TABLE products (
  id           INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  name         VARCHAR(150)   NOT NULL,
  price        DECIMAL(10,2)  NOT NULL DEFAULT 0.00,
  category_id  INT UNSIGNED   NULL,
  rating       DECIMAL(2,1)   NOT NULL DEFAULT 4.7,
  reviews      INT UNSIGNED   NOT NULL DEFAULT 0,
  description  TEXT           NULL,
  image        LONGTEXT       NULL,          -- URL or base64 data URI
  is_available TINYINT(1)     NOT NULL DEFAULT 1, -- admin can mark sold out
  created_at   TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_products_category (category_id),
  CONSTRAINT fk_products_category
    FOREIGN KEY (category_id) REFERENCES categories(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- delivery areas
-- ------------------------------------------------------------
CREATE TABLE delivery_areas (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(120) NOT NULL,
  fee        VARCHAR(60)  NOT NULL DEFAULT 'To be arranged',
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_areas_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- announcements
-- ------------------------------------------------------------
CREATE TABLE announcements (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  title      VARCHAR(180) NOT NULL,
  message    TEXT         NOT NULL,
  icon       VARCHAR(16)  NOT NULL DEFAULT '👏',
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- saved delivery addresses
-- ------------------------------------------------------------
CREATE TABLE addresses (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  label      VARCHAR(40)  NOT NULL DEFAULT 'Home',
  address    TEXT         NOT NULL,
  landmark   VARCHAR(190) NULL,
  -- Filled in when the customer pins the spot on their phone's map instead of
  -- typing it. Both are NULL for a hand-typed address, and always both or
  -- neither: a half-read pin would point nowhere.
  lat        DECIMAL(10,7) NULL,
  lng        DECIMAL(10,7) NULL,
  is_default TINYINT(1)   NOT NULL DEFAULT 0,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_addresses_user (user_id),
  CONSTRAINT fk_addresses_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- favorites
-- ------------------------------------------------------------
CREATE TABLE favorites (
  user_id    INT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, product_id),
  CONSTRAINT fk_favorites_user
    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_favorites_product
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- orders
--   status pipeline (enforced by api/orders.php):
--     Order Placed -> Accepted -> Preparing -> On the Way -> Delivered
--     any active status -> Cancelled
-- ------------------------------------------------------------
CREATE TABLE orders (
  id             INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  order_code     VARCHAR(20)   NOT NULL,          -- e.g. #FD123456789
  user_id        INT UNSIGNED  NULL,
  customer_name  VARCHAR(120)  NOT NULL,
  contact_phone  VARCHAR(11)   NOT NULL,
  area           VARCHAR(120)  NULL,
  address        TEXT          NULL,
  landmark       VARCHAR(190)  NULL,
  order_note     VARCHAR(255)  NULL,
  payment_method VARCHAR(40)   NOT NULL DEFAULT 'Cash on Delivery',
  status         ENUM('Order Placed','Accepted','Preparing','On the Way','Delivered','Cancelled')
                 NOT NULL DEFAULT 'Order Placed',
  subtotal       DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  delivery_fee   DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  total          DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  -- where the order came from: Cart (add to cart) or Buy Now
  source         VARCHAR(20)   NOT NULL DEFAULT 'Cart',
  -- private note for the kitchen / rider, never shown to the customer
  admin_note     VARCHAR(255)  NULL,
  cancel_reason  VARCHAR(190)  NULL,
  -- cash handed over at the door and the change given back (Cash on Delivery)
  cash_tendered  DECIMAL(10,2) NULL DEFAULT NULL,
  change_due     DECIMAL(10,2) NULL DEFAULT NULL,
  placed_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status_updated TIMESTAMP     NULL DEFAULT NULL,
  accepted_at    TIMESTAMP     NULL DEFAULT NULL,
  prepared_at    TIMESTAMP     NULL DEFAULT NULL,
  dispatched_at  TIMESTAMP     NULL DEFAULT NULL,
  delivered_at   TIMESTAMP     NULL DEFAULT NULL,
  cancelled_at   TIMESTAMP     NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_orders_code (order_code),
  KEY idx_orders_user (user_id),
  KEY idx_orders_status (status),
  KEY idx_orders_placed (placed_at),
  CONSTRAINT fk_orders_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- order line items
-- ------------------------------------------------------------
CREATE TABLE order_items (
  id         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  order_id   INT UNSIGNED  NOT NULL,
  product_id INT UNSIGNED  NULL,
  name       VARCHAR(150)  NOT NULL,
  price      DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  qty        INT UNSIGNED  NOT NULL DEFAULT 1,
  subtotal   DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  note       VARCHAR(255)  NULL,
  PRIMARY KEY (id),
  KEY idx_items_order (order_id),
  CONSTRAINT fk_items_order
    FOREIGN KEY (order_id)   REFERENCES orders(id)   ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_items_product
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- order history  (one row per status change — the audit trail
-- shown to the customer on the tracking screen)
-- ------------------------------------------------------------
CREATE TABLE order_events (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- key/value store for everything configured in Admin > Settings
-- ------------------------------------------------------------
CREATE TABLE settings (
  k          VARCHAR(80)  NOT NULL,
  v          TEXT         NULL,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- failed sign-in attempts  (brute-force protection)
-- ------------------------------------------------------------
CREATE TABLE login_attempts (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email      VARCHAR(190) NOT NULL,
  ip         VARCHAR(45)  NOT NULL,
  ok         TINYINT(1)   NOT NULL DEFAULT 0,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_attempts_lookup (email, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- two-factor sign-in
--
-- actor_type/actor_id carry no foreign key on purpose: one row can
-- belong to either admins or users, and MySQL cannot point a single
-- column at two parent tables. fooday_mfa_purge() in api/migrations.php
-- removes an account's rows when the account is deleted.
-- ------------------------------------------------------------
CREATE TABLE mfa_accounts (
  actor_type         ENUM('admin','user')   NOT NULL,
  actor_id           INT UNSIGNED          NOT NULL,
  enabled            TINYINT(1)            NOT NULL DEFAULT 0,
  method             ENUM('email_code')    NOT NULL DEFAULT 'email_code',
  secret             CHAR(64)              NOT NULL,
  pending_hash       CHAR(64)              NULL,
  pending_expires_at DATETIME              NULL,
  recovery_hashes    TEXT                  NULL,
  enabled_at         DATETIME              NULL,
  last_used_at       DATETIME              NULL,
  created_at         TIMESTAMP             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (actor_type, actor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One live sign-in code per actor. Issuing a new row retires the previous
-- one, so an older email can never be replayed.
CREATE TABLE mfa_codes (
  id          BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  actor_type  ENUM('admin','user') NOT NULL,
  actor_id    INT UNSIGNED     NOT NULL,
  code_hash   CHAR(64)         NOT NULL,
  expires_at  DATETIME         NOT NULL,
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  consumed_at DATETIME         NULL,
  created_at  TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_mfa_codes_lookup (actor_type, actor_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One live confirmation code per actor and purpose. Changing an account's
-- email or password always emails a code to the address on file, whether or
-- not two-factor sign-in is switched on. Issuing a new code retires the
-- previous one for that purpose, so an older email can never be replayed.
CREATE TABLE change_codes (
  id          BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  actor_type  ENUM('admin','user') NOT NULL,
  actor_id    INT UNSIGNED     NOT NULL,
  purpose     ENUM('email','password') NOT NULL,
  code_hash   CHAR(64)         NOT NULL,
  expires_at  DATETIME         NOT NULL,
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  consumed_at DATETIME         NULL,
  created_at  TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_change_codes_lookup (actor_type, actor_id, purpose, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
--  SEED DATA
-- ============================================================

-- Change this password after your first sign-in (Admin > Settings > Security).
INSERT INTO admins (name, email, password) VALUES
  ('FOODAY Admin', 'dvidad316@gmail.com', '$2y$10$ReXRyNhJqVHW7wcASOXGVege8iWRLzt83teFLFQwFlMQoK6LAYWz2');

INSERT INTO categories (name, icon, is_locked) VALUES
  ('All',     '🍽️', 1),
  ('Burgers', '🍔', 0),
  ('Pizza',   '🍕', 0),
  ('Chicken', '🍗', 0),
  ('Fries',   '🍟', 0),
  ('Korean',  '🍜', 0),
  ('Pasta',   '🍝', 0),
  ('Drinks',  '🥤', 0);

-- category ids: 1=All 2=Burgers 3=Pizza 4=Chicken 5=Fries 6=Korean 7=Pasta 8=Drinks
INSERT INTO products (name, price, category_id, rating, reviews, description, image) VALUES
  ('Cheesy Burger', 120.00, 2, 4.8, 120,
   '100% beef patty with cheese, lettuce, tomato, onions and our special sauce.',
   'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=900&q=90'),
  ('Carbonara Pasta', 140.00, 7, 4.7, 120,
   'Creamy pasta with bacon bits and a rich, savory sauce.',
   'https://images.unsplash.com/photo-1612874742237-6526221588e3?w=900&q=90'),
  ('Crispy Chicken', 130.00, 4, 4.8, 120,
   'Golden crispy chicken served with a savory gravy.',
   'https://images.unsplash.com/photo-1626645738196-c2a7c87a8f58?w=900&q=90'),
  ('Iced Coffee', 70.00, 8, 4.6, 120,
   'Freshly brewed coffee over ice with smooth cold milk.',
   'https://images.unsplash.com/photo-1517701604599-bb29b565090c?w=900&q=90'),
  ('Cheesy Fries', 85.00, 5, 4.7, 120,
   'Crispy fries topped with creamy cheese sauce.',
   'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=900&q=90'),
  ('Korean Chicken', 155.00, 6, 4.9, 120,
   'Crispy chicken glazed with a sweet and savory Korean-style sauce.',
   'https://images.unsplash.com/photo-1525755662778-989d0524087e?w=900&q=90'),
  ('Pepperoni Pizza', 180.00, 3, 4.8, 120,
   'Cheesy pizza topped with pepperoni and herbs.',
   'https://images.unsplash.com/photo-1628840042765-356cda07504e?w=900&q=90');

INSERT INTO delivery_areas (name, fee) VALUES
  ('Bantayan',   'To be arranged'),
  ('Madridejos', '₱15 - ₱30'),
  ('Santa Fe',   'To be arranged');

-- ------------------------------------------------------------
-- default settings  (Admin > Settings reads and writes these)
-- ------------------------------------------------------------
INSERT INTO settings (k, v) VALUES
  -- store
  ('store_name',             'FOODAY'),
  ('store_tagline',          'Good Food, Anytime, Anywhere.'),
  ('support_email',          'support@fooday.ph'),
  ('support_phone',          '0917 000 0000'),
  ('store_open',             '1'),
  -- orders
  ('order_auto_accept',      '0'),
  ('order_prep_minutes',     '30'),
  ('order_allow_cancel',     '1'),
  ('order_cancel_window',    '5'),
  ('order_min_total',        '0'),
  -- payments
  ('pay_cod_enabled',        '1'),
  -- GCash is intentionally 0: no merchant account is connected yet.
  ('pay_gcash_enabled',      '0'),
  -- privacy
  ('privacy_show_contact',   '1'),
  ('privacy_show_notes',     '1'),
  -- security
  ('password_min_length',    '6'),
  ('login_max_attempts',     '5'),
  ('login_lockout_minutes',  '15'),
  ('session_idle_minutes',   '60');

-- migration marker
INSERT INTO fooday_meta (k, v) VALUES ('schema_version', '8');
