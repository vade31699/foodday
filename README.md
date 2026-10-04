# FOODAY

A food ordering web app (HTML/CSS/JS frontend + PHP/MySQL backend).

Customers build a cart or buy a single item straight away, pay cash on
delivery, and watch their order move through the kitchen. Staff get an
incoming-order queue and move each order one step at a time.

## Requirements

- PHP 8.0+ (with PDO MySQL)
- MySQL or MariaDB (e.g. XAMPP, WAMP, Laragon, or standalone)
- HeidiSQL (optional, for browsing the database)

## Setup

1. **Create the database.** Open HeidiSQL and run `fooday.sql`
   (`File > Load SQL file...` then execute, or paste it into a Query tab).
   This creates the `fooday_db` database, all tables, and seed data.

   > **`fooday.sql` is destructive and deletes everything.** It runs
   > `DROP TABLE` on all 14 tables, so every order, customer, address and
   > favourite in the target database is destroyed. Only run it on a brand new,
   > empty server.
   >
   > It also selects the database itself (`USE fooday_db;`), so you cannot point
   > it somewhere else from the command line — `mysql -u root < fooday.sql`
   > ignores the database you name and imports into `fooday_db` regardless. If
   > you want a different name, or want to try the script somewhere harmless,
   > edit that `USE` line first (and `DB_NAME` in `api/config.php` to match).

   **Already running an older version?** Do *not* re-import — that drops your
   data. Just reload the app: `api/migrations.php` upgrades the existing
   database in place on the first request and keeps every row. It is
   idempotent, so reloading is safe. The version it upgrades to is
   `FOODAY_SCHEMA_VERSION` in `api/migrations.php`; bump that number **in the
   same edit** as any columns it adds, or an install that connects in between
   marks itself up to date and never receives them.

2. **Check the DB connection.** The credentials come from the environment
   first, then from `.env`, and only then fall back to the local defaults
   (`127.0.0.1` / `fooday_db` / `root` / no password) — so a stock WAMP or
   XAMPP install needs no edit at all. To point it elsewhere, either set the
   real environment variables on the host, or copy `.env.example` to `.env`
   and fill in the `DB_*` section:

   ```
   DB_HOST=127.0.0.1
   DB_PORT=3306
   DB_DATABASE=fooday_db
   DB_USERNAME=root
   DB_PASSWORD=
   ```

   A real environment variable always beats the value in `.env`, so a hosting
   panel's own database configuration cannot be shadowed by a stale file.

3. **Serve the app through PHP.** The app talks to PHP endpoints, so it must
   be opened over HTTP — not by double-clicking `index.html`.

   - With XAMPP: copy this folder into `htdocs/` and visit
     `http://localhost/fooday/` (start Apache).
   - With WAMP: it is already served at `http://localhost/isugan/`.
   - Without either: from this folder run
     `php -S 127.0.0.1:8000` and visit `http://127.0.0.1:8000/`.

## Deploying

The app is plain PHP + MySQL with no framework and no Composer, so it runs on
any PHP host:

- **Database** is read from `DB_HOST` / `DB_PORT` / `DB_DATABASE` /
  `DB_USERNAME` / `DB_PASSWORD` (environment first, then `.env`). No host is
  hard-coded in the request path. It speaks MySQL through PDO, so it runs
  against MySQL, MariaDB or a MySQL-compatible cloud database such as
  [TiDB Cloud](#tidb-cloud).
- **Mail** is read from the `MAIL_*` variables (see `.env.example`). Leaving
  them unset is safe: two-factor enrolment is refused rather than leaving an
  account that could never receive a code.
- **Sessions** use `Secure` cookies automatically behind HTTPS (including
  behind a proxy that sets `X-Forwarded-Proto`), with `HttpOnly` and
  `SameSite=Lax`.
- **Schema upgrades** run themselves on first connect (`api/migrations.php`),
  so deploying new code does not need a manual import.

### TiDB Cloud

FOODAY talks MySQL through PDO, and [TiDB Cloud](https://tidbcloud.com/)
Starter/Essential is MySQL-compatible, so the app runs there with **no code
changes** — only connection settings.

1. **Create a Starter (or Essential) instance**, then open **Connect**, keep
   the connection type as **Public**, and pick your client. The console offers
   a string like:

   ```
   mysql://3fA9aBc.root:your-password@gateway01.us-east-1.prod.aws.tidbcloud.com:4000/fooday_db?ssl-mode=REQUIRED
   ```

   The user name carries the instance prefix (`….root`); percent-encoded
   passwords are decoded for you.

2. **Paste it as `DATABASE_URL`** (a real environment variable or `.env`). The
   five separate `DB_*` variables still win when both are set, so use one or the
   other. The `?ssl-mode=REQUIRED` query is read from the URL, so a pasted
   string is enough to get connected.

3. **TLS is required.** TiDB Cloud accepts only TLS 1.2/1.3. `REQUIRED`
   encrypts the connection but does not verify the certificate; for a verified
   connection set `DB_SSL_MODE=verify_identity` and point `DB_SSL_CA` at a CA
   bundle. On Linux the app finds the system store itself; on Windows download
   the [ISRG Root X1](https://letsencrypt.org/certs/isrgrootx1.pem) certificate
   and set `DB_SSL_CA` to its path (e.g. `C:/certs/isrgrootx1.pem`). A verifying
   mode with no usable CA is refused with a message, never silently downgraded.
   Leaving `DB_SSL_MODE` unset keeps local MySQL/MariaDB on plain TCP.

4. **Import `fooday.sql`.** A fresh instance is empty. Run the file in the
   TiDB Cloud **SQL Editor** (or `mysql … < fooday.sql`). If you keep the
   instance's own database name, drop the file's `CREATE DATABASE IF NOT
   EXISTS fooday_db` and `USE fooday_db;` lines first and point `DB_DATABASE`
   (or the URL's path) at that name. As on any host, `fooday.sql` is
   destructive — run it only against a brand-new database.

5. **Schema upgrades still run themselves.** `api/migrations.php` works the
   same way against TiDB, so deploying new code needs no manual step.

Portability notes the app keeps so TiDB behaves like MySQL:

- **TLS** is driven by `DB_SSL_MODE` / `DB_SSL_CA` (or the URL query), never
  assumed; unset means "local MySQL, no SSL".
- **`ON DUPLICATE KEY UPDATE`** binds the new value again instead of using
  `VALUES(col)`, which MySQL 8 deprecated and TiDB may not accept in that form.
- The **order queue and announcements** sort newest-first by timestamp, not by
  `id`: TiDB only promises auto-increment ids are *unique*, not sequential, so
  "the biggest id" is not reliably the most recent row.
- Everything else — InnoDB (ignored by TiDB), `ENUM`, foreign keys,
  `information_schema`, `INTERVAL`, multi-table `DELETE` and
  `utf8mb4_unicode_ci` — is supported by TiDB as-is.

### Keep secrets out of the web root

Every file in the document root is public. `.env` holds the database password,
the SMTP app password and `MFA_PEPPER`, so a production deploy should not put
it there. In order of preference:

1. **Set real environment variables** (`DB_*`, `MAIL_*`, `MFA_*`) in the
   hosting panel. They always win over any file, so nothing secret needs to be
   uploaded at all — this is the recommended deploy.
2. **Point `FOODAY_ENV_FILE` at a path outside the document root** (for example
   `/etc/fooday/.env`) and keep the values there.
3. **Leave `.env` in the project folder.** Apache and IIS are covered by the
   bundled `.htaccess` and `web.config`, which refuse to serve `.env`, `*.sql`,
   `*.md`, `tests/` and hidden files. nginx does not read those files, so add
   the equivalent yourself:

   ```nginx
   location ~ /\.(?!well-known) { deny all; }
   location ~* \.(env|sql|md|log)$ { deny all; }
   location ^~ /tests/ { deny all; }
   ```

`README.md` prints the seeded admin password and `fooday.sql` holds the schema
and that same password hash, so neither should be public either — the rules
above block both. (`README.md` and `fooday.sql` are the only files in the
folder that are both non-essential and unsafe to expose; `app.js`, `styles.css`
and `api/*.php` must stay reachable.)

The PHP built-in server (`php -S`) reads neither `.htaccess` nor `web.config`,
so on that path keep it bound to `127.0.0.1` as the Setup step does, or move
`.env` outside the folder with `FOODAY_ENV_FILE`.

**Set the document root to this folder** (the one holding `index.html` and
`api/`). If the host serves a `public/` document root — Laravel Cloud does —
use the bundled `public/index.php` front controller instead (below); it serves
the same files without copying anything else into the web root.

### Laravel Cloud

Laravel Cloud runs Laravel and Symfony, and also **other PHP backend
applications** on its PHP runtime. It picks a runtime from marker files in the
repository, so a framework-free app is detected as *PHP (Other PHP backend
applications)* as soon as a `composer.json` is present — that is why the import
screen previously stopped at *"We couldn't find a supported framework at the
root"*. The `composer.json` in this repo declares no dependencies; it exists to
be found.

1. **Application directory:** the repository root.
2. **Runtime:** PHP — choose 8.3 (8.2–8.5 are supported).
3. **Build command:** `composer install --no-dev --no-interaction`. There is no
   frontend build step, so delete any `npm run build` the dashboard pre-fills.
4. **Deploy command:** leave it empty. Schema migrations run themselves on the
   first request (`api/migrations.php`).
5. **Database:** create or attach a **Laravel MySQL** database. Unlike Laravel
   and Symfony, the generic PHP runtime does **not** inject `DB_*` for you, so
   configure the connection yourself: either the five variables (`DB_HOST`,
   `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`) or the single
   `DATABASE_URL` (`mysql://user:pass@host:port/database`) the dashboard offers.
   `DATABASE_URL` is read as a fallback for any of the five that is unset, so
   pasting it alone is enough; the five individual variables always win.

   A fresh managed database is empty. Before the first request, import
   `fooday.sql` into it — and if the managed database has its own generated
   name, drop the file's `CREATE DATABASE IF NOT EXISTS fooday_db` and
   `USE fooday_db;` lines first, then set `DB_DATABASE` to that name.
6. **Environment variables:** add the `MAIL_*` values and `MFA_PEPPER` from
   `.env.example`. They are set on the process, and `env()` reads the process
   environment before any file, so `.env` must not be deployed.
7. **Document root:** the PHP runtime serves `public/`. That folder holds a
   single `index.php` front controller which returns the five public files
   (`index.html`, `styles.css`, `app.js`, `fooday-logo.jpg`, `api/*.php`) and
   answers 404 for anything else. Because no other file is copied into the web
   root, `fooday.sql`, `README.md`, `tests/` and any `.env` stay unreachable —
   this replaces the `.htaccess` and `web.config` rules, which Laravel Cloud's
   nginx does not read. If the host instead serves the repository root, the
   root `index.php` delegates to the same controller, so both layouts serve
   the identical, restricted set of files.

## Accounts

- **Customer:** create an account on the "Create Account" screen. A delivery
  address is part of signing up — type one, or pin your current location — and
  it becomes the account's default address, so checkout starts from it. See
  [Delivery addresses](#delivery-addresses).
- **Forgot password:** on the Sign In screen, confirm the email and mobile
  number on the account, then choose a new password.
- **Admin:** sign in on the normal **Sign In** page with
  `dvidad316@gmail.com` / `March031699-`. An admin login skips the home
  screen and opens the admin dashboard automatically.

There is no admin sign-up. Admin accounts exist only as rows in the `admins`
table, so the public sign-up form can never create one.

> Change that admin password from **Settings > Account** on first login. The
> security panel warns you while the seeded password is still in use.

### Photos

Picking a photo — a customer profile picture, an admin photo, or a menu item —
opens the phone's own picker. That "access your photos" permission belongs to
the operating system and is asked by the picker itself, not by FOODAY: the page
is handed exactly the one file that was chosen, and a photo library is never
read.

The chosen image is re-encoded in the browser before it is uploaded. Its longest
edge is scaled to 720 px for a profile picture and 1000 px for a menu item, and
the encoder then makes it fit under 1.4 MB. A multi-megabyte photo straight from
a phone camera therefore just works, and the server's own ceilings — 2 MB for a
profile picture, 4 MB for a product — stay the hard limit. An image the browser
cannot decode is reported plainly instead of failing mid-upload.

What it is re-encoded to depends on the image itself:

- **A PNG stays a PNG when it can**, so a graphic — a logo, a menu board, a
  screenshot — keeps its crisp edges instead of picking up JPEG ringing. There
  is one attempt at full size; a photograph saved as PNG is usually too heavy
  for it and falls through to the JPEG path below.
- **A PNG with real see-through pixels keeps its alpha**, so a cut-out logo is
  never flattened onto a background. Transparency is tested on the pixels, and
  only for formats that can carry alpha, so a JPEG never pays for a pixel scan.
  PNG has no quality dial, so this path trades away resolution instead — down to
  320 px — before giving up on PNG altogether.
- **Everything else becomes a JPEG**, with the quality stepping down
  (0.82 → 0.5) until it fits. The picture keeps its size and shape and only
  gives up detail a screen was never going to show.

## Ordering

**Cart tab** — a draggable cart tab sits along the edge of the screen on every
customer screen. Drag it to any height and it snaps to whichever edge is
nearer; tap it to open the cart. The chosen edge and height are remembered in
`localStorage` (`fooday_fab_pos`), and the tab is kept clear of the bottom nav
and of the cart's Checkout bar so it can never cover them.

**Cart** — add items from the menu or a product page, adjust quantities in the
cart, then check out.

**Buy Now** — the ⚡ button on a product skips the cart and goes straight to
checkout with that one item. The order is tagged `Buy Now` so staff can see it
came from a single-item purchase, and **Back to cart** returns you to the cart
without losing anything.

New orders appear in **Admin > Orders** the moment they are committed — there
is no approval queue to clear first.

### Delivery addresses

A customer can type an address or pin the place they are standing in. Every
screen that asks for an address — **Create Account**, **Checkout** and
**Settings > Addresses** — offers both options through one routine in `app.js`
(`requestPin` / `allowPin`), so each form only names the fields the pin fills
in. A pin used when creating an account or saving an address is stored on that
address row; a pin used at checkout fills the delivery address for that order.

- **Signing up creates the first address.** It is required (enforced in
  `api/auth.php`, not just in the form) and saved as the account's default, so
  checkout starts from it instead of asking again.
- **The customer is asked first.** Tapping *Use my current location* opens
  FOODAY's own sheet explaining what will happen, and only *Allow Location*
  hands over to the browser's permission prompt. *Not Now* leaves the form
  exactly as it was.
- **The pin is the address.** The coordinates are read once, reverse-geocoded
  through OpenStreetMap's Nominatim (which needs no API key), and written into
  the address field, so the pin never needs a map to be read. A small card
  confirms what was filled in, with its accuracy and `lat, lng`, and offers
  *Remove* and *Re-pin*. If the lookup is slow or unreachable the pin is still
  kept, and the customer is asked for a landmark instead.
- **Typed text is never silently replaced.** If the field already holds
  something the customer wrote, replacing it asks first. Declining the replace
  removes the pin as well, so a pin can never point somewhere other than the
  address being saved.
- **A half-read pin is refused.** Latitude and longitude must arrive together,
  be numeric and in range (`address_point()` in `api/config.php`); only then are
  they rounded to 7 decimals and stored. A hand-typed address keeps `lat` and
  `lng` as `NULL`, and the Addresses screen marks the ones that have a pin.
- **Refusals are explained, not swallowed.** No geolocation support, a page
  that is not a secure context, a blocked permission, a timeout, or a fix that
  lands on Null Island each show a plain-language note — and typing the address
  always still works.
- **A customer may keep 10 addresses.** `ADDRESS_LIMIT` in `api/config.php` is
  the single source; it is sent to the browser as `config.address_limit`, and
  the boundary itself is `address_limit_reached()`. The server refuses an 11th
  insert, and the Addresses screen mirrors that by disabling *Save Address* and
  hiding the GPS button once the slots are full.

> Location is requested only after an explicit in-app agreement, is used once
> to drop the pin, and is stored on that one address row. It is never tracked in
> the background.

### Favorites

The ♥ on a product card and the ♥ in the product header are the same control, so
food can be saved from the menu, the home list, or the product screen, and
removed again from the Favorites screen without opening the product. One tap
toggles it; a filled heart on a coloured circle means it is saved.

- Tapping the heart repaints immediately, then the server's `favorited` answer
  has the last word. The screen never waits on a full `bootstrap.php` re-fetch to
  show the result, and a failure anywhere else in the app can no longer make a
  successful save look like it failed. If the save itself fails, the heart goes
  back to how it was.
- Favorites need an account, so a signed-out tap is answered with a "Sign In
  Required" toast and the sign-in screen rather than a bare error.
- `toggle_favorite` is a transaction with the row locked, so a double tap cannot
  produce a duplicate-key error.
- The `favorites` table is created by `fooday.sql` **and** by
  `api/migrations.php`. It is read on every signed-in `bootstrap.php`, so an
  install that was upgraded in place rather than re-imported would otherwise
  return a 500 for the whole app, not just the favorites screen.
- `aria-pressed` and a descriptive `aria-label` are kept in step with the state on
  every heart.

### Order pipeline

```
Order Placed -> Accepted -> Preparing -> On the Way -> Delivered
       \______________________________________________/
                          Cancelled
```

Staff can only move an order to the *one* step it is actually waiting for, so
the customer timeline can never skip or go backwards. That step comes from
`order_next_status()`, which both the advance endpoint and the order feed read,
so the timeline a customer sees cannot disagree with the one staff may move.
Every change is stamped
(`accepted_at`, `prepared_at`, `dispatched_at`, `delivered_at`) and appended to
the order's history, which both the customer and staff can read.

- **Auto-accept** (Settings > Orders) jumps straight to `Accepted` so a busy
  kitchen does not have to tap through every order.
- **Cancelling** is a time window, not a status: the customer can cancel while
  the order is still inside `order_cancel_window` minutes of being placed.
  Staff can cancel at any point before delivery, and must give a reason once a
  rider is on the way.
- **Internal notes** typed by staff are never sent to the customer.
- **Live tracking** — the customer's Track Order screen polls the order feed
  every 8 seconds, so a status moved in Admin &gt; Orders appears on the
  customer's phone within seconds (with a toast) without a manual refresh.
  Nothing is re-rendered unless the feed actually changed, and never while a
  field on the screen is being typed in. The admin order list refreshes the
  same way, so new orders show up without a reload.
- **Cash is collected at the door.** The button that completes a Cash on
  Delivery order reads *Collect Cash & Complete* and opens a prompt for the
  cash handed over, with the amount due and one-tap notes (the exact total
  first, then the usual round numbers above it). Change is worked out as you
  type. *Not Yet* backs out and leaves the order On the Way. See
  [Payments](#payments) for the rules.
- **Managing one order at a time.** Opening an order puts the screen into that
  order's context: the list shows it and nothing else, the status filters step
  aside, and a line above the list names the order being managed. Tapping the
  open card again, or Back, brings the whole queue back — and a managed order
  that finishes keeps its receipt on screen.
- **A Back button beside the search box** is the way out of the screen, and the
  only one: out of the order being managed first, then off the screen to the
  dashboard. An order card never carries navigation of its own — a delivered or
  cancelled order renders no buttons at all — so a finished order is never a
  dead end and the card stays about the order.
- **The admin menu is one tap from anywhere.** Every admin screen header has the
  same ☰ button as the dashboard, and the drawer it opens now has a **Dashboard**
  entry of its own (it used to list everything *except* the way home). Settings
  keeps *Save* in that slot; its back arrow still leads to the dashboard.
- **The screen header cannot be lost.** It is `position:sticky` inside the
  scrolling screen, and the frame is sized so that a short window (a phone
  sideways) can never scroll the *page* and carry the header off the top with
  it. `tests/admin-navigation.test.js` guards all three of these.

### Payments

- **Cash on Delivery** is active.
- **GCash** is shown in the app but locked. It cannot be turned on until a GCash
  merchant account is connected — the server rejects GCash orders regardless of
  what the browser sends, so the toggle cannot be spoofed.

Delivery fee is shown to the customer as "To be arranged"; the stored
`delivery_fee` is `0.00` and the total is the food subtotal.

#### Cash on Delivery settlement

Completing a cash order is the only step that touches money, so it is the only
step that records any:

- The tender is **required** to mark a Cash on Delivery order `Delivered`, and
  it must be **at least the total**. The server refuses the transition
  otherwise, so an order cannot be closed by skipping the prompt or by editing
  the request.
- `change_due` is calculated on the server as `cash_tendered - total`, rounded
  to two decimals, and stored alongside the tender. The browser's figure is only
  a preview and is never trusted. Because both are written in the same
  statement, the change cannot drift from the total.
- Only the final step records money. Earlier steps, cancelling, and non-cash
  orders leave `cash_tendered` and `change_due` as `NULL`.
- The tender, the change, and a note such as `Collected ₱500.00 · Change
  ₱250.00` are appended to the order history.
- Once the order is `Delivered`, both the customer (Track Order) and staff
  (Admin &gt; Orders) see a receipt: amount to pay, cash received, and change.
  For a non-cash order the receipt shows a dash instead, because there is
  genuinely nothing to collect.
- Orders delivered before this existed have no tender recorded, so their
  receipt reads *Not recorded* rather than showing a misleading ₱0.00.

## Admin settings

Everything on this screen is stored in the `settings` table and takes effect
immediately, with no code edits.

| Section | What it controls |
| --- | --- |
| **Store** | Name, tagline, support email/phone, open/closed |
| **Orders** | Auto-accept, prep time, cancellation window, minimum order |
| **Payments** | Cash on delivery; GCash (locked) |
| **Privacy** | Mask customer name, phone and address for staff |
| **Security** | Minimum password length, login throttling, idle timeout, plus your own password and two-factor |
| **Account** | Edit profile, sign out other devices, sign-in activity |

**Your password is required to save any setting.** This is not optional, so a
walked-up-to or borrowed admin session cannot silently reconfigure the store.

**Two password rules are fixed and show as "Always on"** rather than as toggles:
letters *and* numbers are required, and your password is required to save any
setting. Only the minimum length is a setting, because a stricter floor is a
matter of taste rather than a matter of security.

## Security notes

- **One Security sheet, opened from either menu.** A customer reaches it from
  Profile, an admin from Settings; both rows lead to the same `#modal-security`,
  which offers **Change Password** and **Two-Factor Authentication** instead of
  scattering them as unrelated rows. The sheet knows which account it is
  standing in for (`securityWho`), so it opens that account's own password form
  and that account's own two-factor state. The password and two-factor sheets
  are declared after the Security sheet, so they open on top of it and closing
  one comes back here rather than dropping to the screen underneath.
- Passwords are bcrypt hashes; a password change bumps `auth_version`, which
  silently signs out every other device for that account. Every password must
  contain both letters and numbers (`password_problem()` in `api/config.php`);
  the client mirrors that in `passwordProblem()` so a form says it before the
  round trip.
- Failed sign-ins are throttled per account and logged in `login_attempts`,
  with the recent attempts shown in the security panel.
- Idle sessions time out; the session cookie is `HttpOnly` + `SameSite=Lax`
  and is only marked `Secure` over HTTPS.
- Staff-only endpoints (`admin.php`, and the write actions on `orders.php`,
  `products.php`, `categories.php`, `announcements.php`, `areas.php`) require
  an admin session.
- Customer order payloads never include staff internal notes.

## Tests

Dependency-free — nothing to install, no Composer, no PHPUnit, no `npm install`:

```
node --test                             # all JS tests             (Node 18+)
php tests/address-validation.test.php   # address validation       (PHP 8+)
php tests/order-pipeline.test.php       # statuses and cash tender (PHP 8+)
php tests/password-policy.test.php      # the fixed password rules (PHP 8+)
```

`node --test` with no arguments finds every `tests/*.test.js` on its own.

The three PHP files share `tests/harness.php` — a few `expect_*` helpers, and a
`finish()` that prints the tally and exits non-zero when anything failed. They
load the real `api/config.php` with no database at all: `db()` is only ever
called lazily, so the decision logic underneath the SQL can be exercised alone.

**`password-policy.test.php` / `.test.js`** cover the password rule that is no
longer a setting. The PHP file drives `password_problem()` itself, including
with a `password_require_mixed` row left over from an older install, to show the
rule cannot be talked out of by the settings table. The JS file checks the
settings screen offers no switch for it, that `app.js` collects no such key, and
that the browser's `passwordProblem()` refuses the same passwords the server
does.

**`photo-encoder.test.js`** covers the photo encoder in `app.js`, which decides
whether a picked image is re-encoded as a JPEG or kept as a PNG and how far it
may shrink before giving that up. `app.js` is a browser script, so the test
loads it into a `node:vm` sandbox with a fake canvas whose `toDataURL` returns
a string of a length the test chooses — output size is the encoder's only input
besides the image, which is what makes the format choice observable. The cases
cover a photograph, an opaque PNG, a transparent PNG that has to give up
resolution, both fallbacks to JPEG, the alpha threshold that keeps anti-aliased
edges from counting as transparency, and the refusals for a non-image or an
absurdly large file.

**`address-validation.test.php`** covers `address_point` and the ten-address
limit in `api/config.php`: a typed address carrying no pin, half a pin being
dropped, rounding to the seven decimals the column keeps, non-numeric and
out-of-range pins being refused, the corners of the map being inside it, the
split where the server stores `0,0` while the browser is what refuses Null
Island, label and landmark truncation, and the limit being reached on the tenth
address rather than the eleventh. It needs no database — the limit is tested on
`address_limit_reached()`, the boundary it is decided by, rather than on the SQL
that counts rows. One case reads `app.js` to check its `address_limit` fallback
still matches `ADDRESS_LIMIT`, so the form cannot quietly disable itself at a
different number from the server.

**`order-pipeline.test.php`** covers the status transitions and the cash tender
rules in `api/config.php`:

- The pipeline is one chain: `ORDER_NEXT` is the flow minus its final step, so a
  step can never be skipped, repeated or reversed. A golden table spells out the
  one step each status waits for, and a finished order (`Delivered`,
  `Cancelled`) waits for nothing.
- The four advance targets are the only steps staff may ever name, so cancelling
  cannot happen through the advance endpoint and an unknown status is refused
  before the order is even looked up.
- Every reachable step has a `*_at` column to stamp it, every status has a
  customer-facing label, and `ORDER_ACTIVE` / `ORDER_DONE` split the statuses
  between them exactly once.
- Cash: a GCash order has nothing to collect and never validates a tender; a cash
  order requires one, it must be numeric and must cover the total, and the change
  is the difference to the centavo — including the cases where binary floating
  point would otherwise leave a crumb (`0.1 + 0.2`, `500 - 280.9`).
- It reads `app.js` too, checking `ORDER_FLOW` and `CASH_METHODS` still match the
  server's, so the timeline a customer sees cannot drift from the one staff may
  move through.

**`security-merge.test.js`** pins the merged Security entry point: each menu
carries the Security row exactly once (no leftover separate password or
Two-Factor rows), the sheet itself exposes both options, and the sheets it leads
to are declared after it so closing them returns to Security. It then runs
`openSecurityModal`, `securityOpenPassword` and `securityOpenMfa` against a fake
DOM to prove the account in view is the one that gets the password form and the
two-factor state — the admin's, or the customer's, never the wrong one.

**`admin-navigation.test.js`** covers the admin orders screen, where a dead end
is most costly. It loads the real renderers against a small fake DOM built from
`index.html`'s own screen ids, so navigation can be observed rather than assumed:

- **An order card never carries navigation.** A completed or cancelled order
  renders *no buttons at all*, while an order still moving keeps *Collect Cash &
  Complete* and *Cancel Order*.
- **The Back button sits to the left of the search box**, in the same row, and it
  walks back the way the admin came: out of the order being managed, then off the
  screen to the dashboard.
- **Opening an order shows that order and nothing else.** The other orders leave
  the list, the filters step aside, and the screen names the order it is showing.
  Closing the card, pressing Back, or choosing Orders from the menu each bring the
  whole queue back; an order opened from the dashboard arrives focused with an
  empty search box; and a managed order that finishes keeps its receipt on screen.
- Every admin screen can open the menu and reach the dashboard, and the drawer
  itself has a Dashboard entry. Settings is checked for the dashboard but not the
  menu button, because that slot holds *Save*.
- The layout the screen relies on: a `position:sticky` header, the short-window
  rule that stops the page from scrolling the header away, the Back button being
  sized to match the search box, and the `?v=` versioning that stops a phone
  serving a cached copy of an old bug.

```
tests/
  harness.php                   the shared expect_* helpers and the tally
  photo-encoder.test.js         format choice of the photo encoder
  address-validation.test.php   GPS pin rules and the ten-address limit
  order-pipeline.test.php       status transitions and the cash tender
  admin-navigation.test.js      ways out of a finished order and the admin menu
```

## Structure

```
index.php         entry point for a repository-root document root (delegates to
                  public/index.php)
index.html        UI (all screens), loading styles.css and app.js with a ?v= cache
                  version
styles.css        styles
app.js            frontend logic (talks to api/*.php)
composer.json     no dependencies; present so PHP hosts detect the application
public/
  index.php       front controller for a public/ document root (Laravel Cloud)
fooday.sql        database schema (v9) + seed data. DESTRUCTIVE - see Setup
api/
  config.php      PDO connection, session, settings, auth + order helpers
  migrations.php  upgrades an existing database to v9 in place, without dropping
  bootstrap.php   loads session + catalog for the frontend
  auth.php        signup / signin / logout / password reset
  admin.php       settings, profile, password, security report, stats
  products.php    admin add / edit / availability / delete products
  categories.php  admin add/delete categories
  areas.php       admin add delivery areas
  announcements.php admin add/delete announcements
  orders.php      place / advance / note / cancel orders
  account.php     profile, picture, password, addresses, favorites
```

(`app.js` also carries the photo pipeline — shrinking, and the JPEG-or-PNG
choice — because the app is loaded as plain scripts with no bundler.)

### API actions

| Endpoint | Actions |
| --- | --- |
| `auth.php` | `signup`, `signin`, `logout`, `reset_password`, `admin_logout` |
| `admin.php` | `settings`, `save_settings`, `update_profile`, `change_password`, `signout_others`, `security_report`, `clear_login_log`, `stats` |
| `orders.php` | `create`, `advance`, `update_status`, `note`, `cancel` |
| `products.php` | `add`, `update`, `availability`, `delete` |
| `categories.php` / `announcements.php` | `add`, `delete` |
| `account.php` | `update_profile`, `update_picture`, `change_password`, `add_address`, `edit_address`, `delete_address`, `default_address`, `toggle_favorite` |

`auth.php?action=signup` takes `name`, `email`, `phone`, `password`, `address`,
and an optional `lat`/`lng` pair for a pinned location. A sign-up without an
address is refused.

`account.php?action=add_address` / `edit_address` take `label`, `address`,
`landmark` and the same optional `lat`/`lng` pair. `add_address` answers `400`
once the account already holds 10 addresses.

`orders.php?action=create` takes `payment_method` plus a `checkout` object
(`name`, `phone`, `address`, `area`, `landmark`, `note`, `buy_now`) and an
`items` array of `{product_id, qty, name, price, note}`. Prices are always
re-read from the database, never trusted from the request.

`orders.php?action=advance` takes `order_code` and `status`, plus
`cash_tendered` when moving a Cash on Delivery order to `Delivered`. The
response echoes `status`, `label`, and — for a settled cash order —
`cash_tendered` and `change_due`. Every order in the feed also carries
`isCod`, `cashTendered` and `changeDue`; the last two are `null` for orders
that were never settled in cash, so the UI can tell "nothing to collect" apart
from "collected nothing".

`account.php?action=toggle_favorite` takes `product_id` and answers
`{"ok":true,"favorited":true|false}` — the authoritative new state, which the
client applies directly. It requires a signed-in customer (`401` otherwise),
answers `404` for a product that is no longer on the menu, and `400` for a
missing or non-numeric `product_id`.
