/* FOODAY — input hardening and deployment readiness.
 *
 * Four rules are pinned here, all of which were applied in one pass:
 *
 *   1. A value that goes into an inline handler is escaped for a JavaScript
 *      string (jsq), not for HTML text (esc). esc() turns a quote into
 *      "&#039;" which the browser decodes back to a quote before the JS engine
 *      sees it, so it can break out of the string; jsq JSON-style escapes.
 *   2. A field that takes a number takes numbers only — front and back.
 *   3. Supporting/decorative copy has been removed from the screens.
 *   4. The DB connection is environment-driven, and the responsive rules lock
 *      phones to portrait while leaving tablets free to rotate.
 *
 * Run with:  node --test
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(ROOT, file), "utf8");

const appJs = read("app.js");
const indexHtml = read("index.html");
const stylesCss = read("styles.css");
const configPhp = read("api/config.php");
const areasPhp = read("api/areas.php");
const envPhp = read("api/env.php");
const migrationsPhp = read("api/migrations.php");
const sql = read("fooday.sql");
const htaccess = read(".htaccess");
const webConfig = read("web.config");
const composerJson = read("composer.json");
const frontController = read("public/index.php");

/* ---------- app.js in a sandbox, for the pure helpers ---------- */

function loadApp() {
  const sandbox = {
    console,
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} } }),
      addEventListener: () => {},
      body: {},
      hidden: false,
      title: "",
      activeElement: null,
    },
    window: null,
    addEventListener: () => {},
    fetch: () => Promise.reject(new Error("no network in tests")),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: "node", language: "en" },
    setTimeout,
    clearTimeout,
    AbortController,
    URL,
    Image: function Image() {},
    FileReader: function FileReader() {},
    createImageBitmap: async () => null,
    alert: () => {},
    confirm: () => false,
    prompt: () => null,
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(appJs, ctx, { filename: "app.js" });
  return {
    jsq: v => vm.runInContext(`jsq(${JSON.stringify(v)})`, ctx),
    digitsOnly: el => vm.runInContext("digitsOnly", ctx)(el),
    decimalOnly: el => vm.runInContext("decimalOnly", ctx)(el),
  };
}

const app = loadApp();
const field = (value, maxlength) => ({ value, getAttribute: () => (maxlength ? String(maxlength) : "") });

/* ---------- 1. inline-handler escaping ---------- */

test("jsq leaves nothing that can end the string, the attribute or start a tag", () => {
  const payload = "x'); alert(document.cookie); //<img src=x onerror=alert(1)>";
  const out = app.jsq(payload);

  assert.ok(!out.includes('"'), "no raw double quote, which would close the HTML attribute");
  assert.ok(!/[<>]/.test(out), "no angle brackets, which would start an element");
  assert.ok(!out.includes("&"), "no ampersand, so a stray entity can never be decoded back");
  assert.ok(!/(^|[^\\])'/.test(out), "every single quote is escaped");
});

test("a hostile value survives as data without executing", () => {
  const payload = "Snacks'); globalThis.__pwned = true; //";
  const attr = `openTracking('${app.jsq(payload)}')`;
  const sandbox = { console, __calls: [] };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(`globalThis.f = () => ${attr}; globalThis.openTracking = v => __calls.push(v);`, ctx);
  vm.runInContext("f()", ctx);

  assert.deepEqual(sandbox.__calls, [payload], "the value arrives intact, as a string argument");
  assert.equal(sandbox.__pwned, undefined, "and nothing it contained ran");
});

test("the inline handlers that carry server text use jsq, not esc", () => {
  // A category name is admin-authored and reaches an inline handler; that was
  // the one escape-the-quote spot that esc() alone could not protect.
  for (const call of [
    "selectHomeCategory('${jsq(c.name)}')",
    "setCategory('${jsq(c.name)}')",
    "openTracking('${jsq(o.id)}')",
    "toggleOrderDetail('${jsq(o.id)}')",
    "adminCancelOrder('${jsq(o.id)}')",
  ]) {
    assert.ok(appJs.includes(call), call + " escapes for the JS string, not HTML text");
  }
  // None of those spots may have been left on esc(), which cannot protect a
  // single-quoted JS string inside an attribute.
  assert.ok(!appJs.includes("selectHomeCategory('${esc("), "home categories no longer use esc()");
  assert.ok(!appJs.includes("openTracking('${esc("), "order tracking no longer uses esc()");
});

/* ---------- 2. numeric-only fields ---------- */

test("digitsOnly keeps digits, drops everything else, and honours maxlength", () => {
  const el = field("09ab 12-34·56789", 11);
  app.digitsOnly(el);
  assert.equal(el.value, "09123456789");
});

test("decimalOnly keeps digits and a single dot", () => {
  const el = field("1a2.3.4x");
  app.decimalOnly(el);
  assert.equal(el.value, "12.34");

  const letters = field("abc");
  app.decimalOnly(letters);
  assert.equal(letters.value, "");
});

test("every phone field is numeric-only on the way in", () => {
  for (const id of ["signup-phone", "checkout-phone", "edit-phone", "admin-edit-phone", "reset-phone"]) {
    const at = indexHtml.indexOf(`id="${id}"`);
    assert.notEqual(at, -1, id + " exists");
    const tag = indexHtml.slice(at, indexHtml.indexOf(">", at));
    assert.ok(tag.includes('inputmode="numeric"'), id + " asks a phone keyboard for numbers");
    assert.ok(tag.includes("digitsOnly(this)"), id + " filters non-digits as they are typed");
  }
});

test("the delivery fee is a number on both ends", () => {
  const at = indexHtml.indexOf('id="area-fee"');
  const tag = indexHtml.slice(at, indexHtml.indexOf(">", at));
  assert.ok(tag.includes('type="number"'), "the fee field is a number input");

  assert.match(areasPhp, /is_numeric\(\$fee\)/, "the server refuses a non-numeric fee");
  assert.match(areasPhp, /numbers only/, "and says so");
});

/* ---------- 3. supporting text is gone ---------- */

test("the decorative subtitles and helper blurbs are gone", () => {
  for (const needle of [
    'class="subtitle"',
    'class="secure-note"',
    'class="buy-hint"',
    'class="pay-footnote"',
    'class="gcash-note"',
    'class="gps-facts"',
    'class="field-hint"',
    'id="product-form-sub"',
    "Sign up to continue",
    "Sign in to continue",
  ]) {
    assert.ok(!indexHtml.includes(needle), needle + " should have been removed");
  }
});

test("the dynamic, functional text is kept", () => {
  // These carry live state, not decoration, so they stay.
  for (const id of ["payment-intro", "cash-intro", "address-limit-note", "settings-hint", "checkout-item-count"]) {
    assert.ok(indexHtml.includes(`id="${id}"`), id + " is still on screen");
  }
});

/* ---------- 4. responsive + orientation ---------- */

test("a tablet gets a wider frame and multi-column lists", () => {
  assert.match(stylesCss, /@media \(min-width: 700px\)/, "tablet breakpoint");
  assert.match(stylesCss, /@media \(min-width: 1000px\)/, "wide tablet breakpoint");
  const tablet = stylesCss.slice(stylesCss.indexOf("@media (min-width: 700px)"));
  assert.match(tablet, /\.app-viewport\{width:min\(100%,760px\)/, "the frame widens");
  assert.match(tablet, /\.product-list\{display:grid/, "lists flow into columns");
});

test("a phone on its side is asked to rotate back", () => {
  assert.ok(indexHtml.includes('id="rotate-hint"'), "the overlay exists");
  const rule = stylesCss.slice(stylesCss.indexOf(".rotate-hint{display:none}"));
  assert.match(rule, /orientation: landscape/, "it keys off orientation");
  assert.match(rule, /max-height: ?620px/, "and a short viewport, which is what a phone on its side has");
  assert.match(rule, /display:flex/, "which makes it cover the screen");
});

test("a tablet in landscape is not caught by the phone rule", () => {
  // A tablet on its side is at least ~700px tall, so it falls outside the
  // max-height and rotation is allowed there — the whole point of the split.
  const rule = stylesCss.slice(stylesCss.indexOf(".rotate-hint{display:none}"));
  const maxHeight = Number((rule.match(/max-height: ?(\d+)px/) || [])[1]);
  assert.ok(maxHeight <= 620, "the ceiling stays well under any tablet's landscape height");
});

/* ---------- deployment readiness ---------- */

test("the database connection is environment-driven, with local defaults", () => {
  assert.match(configPhp, /define\('DB_HOST', env\('DB_HOST',/, "DB_HOST comes from env()");
  assert.match(configPhp, /define\('DB_NAME', env\('DB_DATABASE',/, "DB_DATABASE");
  assert.match(configPhp, /define\('DB_USER', env\('DB_USERNAME',/, "DB_USERNAME");
  assert.match(configPhp, /define\('DB_PASS', env\('DB_PASSWORD',/, "DB_PASSWORD");
  assert.match(configPhp, /;port=' \. DB_PORT \./, "the port is part of the DSN");
  assert.match(configPhp, /env\('DB_HOST', \$db_url\['host'\] \?\? '127\.0\.0\.1'\)/, "with the local default as the fallback");
});

test("a single DATABASE_URL is accepted alongside the separate variables", () => {
  assert.match(configPhp, /db_url_parts\(env\('DATABASE_URL', ''\)\)/, "the URL is parsed once into the defaults");
  assert.match(configPhp, /function db_url_parts/, "the parser stands on its own");
  assert.match(configPhp, /!== 'mysql'/, "only mysql:// URLs are accepted");
});

test("no query is built by string concatenation", () => {
  assert.ok(!/WHERE id = ' \. \$/.test(configPhp), "no id is pasted into SQL");
  assert.ok(!/\$pdo->query\('[^']*' \./.test(configPhp), "and no query is assembled from a variable");
});

test("an unexpected error never echoes its raw message to the client", () => {
  const handler = configPhp.slice(configPhp.indexOf("set_exception_handler"));
  assert.match(handler, /instanceof ApiError/, "curated errors and raw throwables are told apart");
  assert.match(handler, /else \{\s*\$status\s*=\s*500;\s*\$message\s*=\s*'Something went wrong/, "an unexpected error gets a generic line");
  assert.match(handler, /json_out\(\['ok' => false, 'error' => \$message\]/, "the response uses the message variable, not the throwable");
  assert.ok(!/json_out\([^\n]*getMessage/.test(handler), "a raw message is never sent to the browser");
});

test("a failed schema upgrade reports generically and logs the detail", () => {
  assert.ok(!/Could not upgrade the FOODAY database schema: ' \. \$e->getMessage\(\)/.test(configPhp), "the driver message is not returned");
  assert.match(configPhp, /Could not upgrade the FOODAY database schema\. See the server log/, "the client gets a generic upgrade error");
});

test(".env can be pointed outside the document root", () => {
  assert.match(envPhp, /getenv\('FOODAY_ENV_FILE'\)/, "FOODAY_ENV_FILE is honoured");
  const pathFn = envPhp.slice(envPhp.indexOf("function env_file_path"));
  assert.match(pathFn, /getenv\('FOODAY_ENV_FILE'\)[\s\S]*dirname\(__DIR__\)/, "and falls back to the project-root .env");
});

test("a fresh import is stamped with the current schema version", () => {
  const code = (migrationsPhp.match(/FOODAY_SCHEMA_VERSION = '(\d+)'/) || [])[1];
  const seed = (sql.match(/'schema_version',\s*'(\d+)'/) || [])[1];
  assert.ok(code, "migrations.php declares a schema version");
  assert.equal(seed, code, "fooday.sql seeds the same version, so a fresh import skips the migration pass");
});

test("the bundled server rules refuse to serve secrets and source data", () => {
  assert.match(htaccess, /FilesMatch[\s\S]*\\\.env/, "Apache denies dotfiles");
  assert.match(htaccess, /\\\.sql/, "Apache denies the SQL dump");
  assert.match(htaccess, /\\\.md/, "Apache denies README.md");
  assert.match(htaccess, /tests/, "Apache denies tests/");
  assert.match(htaccess, /Options -Indexes/, "Apache directory listings are off");

  assert.match(webConfig, /<add segment="\.env"/, "IIS hides .env");
  assert.match(webConfig, /<add segment="tests"/, "IIS hides tests/");
  assert.match(webConfig, /directoryBrowse enabled="false"/, "IIS directory browsing is off");
});

test("a composer.json marks the app detectable by Laravel Cloud", () => {
  const manifest = JSON.parse(composerJson);
  assert.ok(manifest.require && manifest.require.php, "it declares a PHP requirement");
  assert.ok(
    !Object.keys(manifest.require).some(name => /^(laravel\/framework|symfony\/framework-bundle)$/.test(name)),
    "without pulling in a framework this app does not use"
  );
});

test("the public/ front controller serves only the app's public files", () => {
  const start = frontController.indexOf("FOODAY_PUBLIC_FILES");
  const allowList = frontController.slice(start, frontController.indexOf("];", start));

  for (const file of ["index.html", "styles.css", "app.js", "fooday-logo.jpg"]) {
    assert.ok(allowList.includes(`'${file}'`), `${file} is on the allow-list`);
  }
  for (const secret of [".env", "fooday.sql", "README", "tests"]) {
    assert.ok(!allowList.includes(secret), `${secret} is not on the allow-list`);
  }

  assert.match(frontController, /preg_match\('#\^\/api\/\[a-z_\]\+\\\.php\$#'/, "only /api/<name>.php is routed");
  assert.match(frontController, /readfile\(FOODAY_ROOT \. '\/' \. \$file\)/, "the served file comes from the allow-list");
  assert.ok(!/readfile\([^)]*\$path/.test(frontController), "the request path is never streamed straight from disk");
  assert.match(frontController, /http_response_code\(404\)/, "anything else is a 404");
});

test("the app also has an entry point at the repository root", () => {
  const rootEntry = read("index.php");
  assert.match(rootEntry, /require __DIR__ \. '\/public\/index\.php';/, "it delegates to the one front controller");
});
