/* FOODAY — emailed code for sensitive account changes.
 *
 * Changing the email an account signs in with, or its password, must be
 * confirmed with a one-time code sent to the address on file. That holds for
 * both the admin and the customer, and it is independent of two-factor sign-in.
 *
 * The backend half of this is a source contract (the endpoints call
 * change_verify_code()); the frontend half is exercised through the real app.js
 * in a fake DOM, with only fetch stubbed out.
 *
 * Run with:  node --test
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");

const indexHtml = read("index.html");
const appJs = read("app.js");
const accountPhp = read("api/account.php");
const adminPhp = read("api/admin.php");
const configPhp = read("api/config.php");
const changeCodesPhp = read("api/change_codes.php");
const migrationsPhp = read("api/migrations.php");
const sql = read("fooday.sql");

/* ---------- the backend actually checks the code ---------- */

test("the change-code library emails and verifies a purpose-bound code", () => {
  assert.ok(changeCodesPhp.includes("function change_request_code"), "a code can be requested");
  assert.ok(changeCodesPhp.includes("function change_verify_code"), "and verified");
  assert.match(changeCodesPhp, /\['email', 'password'\]/, "only the two sensitive changes are allowed");
  assert.match(changeCodesPhp, /send_mail\(/, "the code goes out through the one mail path");
});

test("config.php loads the change-code library", () => {
  assert.match(configPhp, /require_once __DIR__ \. '\/change_codes\.php'/, "the library is always available");
});

test("changing a password always verifies the emailed code, for both accounts", () => {
  for (const [name, php] of [["customer", accountPhp], ["admin", adminPhp]]) {
    const handler = name === "customer" ? "function change_password" : "function change_admin_password";
    const body = php.slice(php.indexOf(handler));
    assert.match(body, /change_verify_code\(/, name + " password change confirms a code");
  }
});

test("moving an account to a new email verifies the emailed code, for both accounts", () => {
  for (const [name, php] of [["customer", accountPhp], ["admin", adminPhp]]) {
    const handler = name === "customer" ? "function update_profile" : "function update_admin_profile";
    const body = php.slice(php.indexOf(handler), php.indexOf("\nfunction ", php.indexOf(handler) + 10));
    assert.match(body, /change_verify_code\(/, name + " email change confirms a code");
    assert.match(body, /strcasecmp\(/, "and only when the email actually differs");
  }
});

test("the schema ships the change_codes table", () => {
  assert.match(sql, /CREATE TABLE change_codes/, "a fresh import creates it");
  assert.match(migrationsPhp, /CREATE TABLE IF NOT EXISTS change_codes/, "an upgraded install gets it too");
  assert.match(migrationsPhp, /const FOODAY_SCHEMA_VERSION = '9'/, "the version is bumped so an existing install upgrades");
});

/* ---------- the frontend routes every change through one sheet ---------- */

test("index.html declares the one confirmation sheet", () => {
  assert.match(indexHtml, /id="modal-change-code"/, "the sheet exists");
  assert.match(indexHtml, /id="change-code-input"/, "with somewhere to type the code");
  assert.match(indexHtml, /onclick="submitChangeCode\(\)"/, "and a button that confirms it");
  assert.match(indexHtml, /onclick="resendChangeCode\(\)"/, "plus a way to ask for another code");
});

test("each email or password change opens the confirmation sheet", () => {
  for (const fn of ["saveProfile", "submitPasswordChange", "submitAdminEmail", "saveAdminProfile", "submitAdminPassword"]) {
    const body = appJs.slice(appJs.indexOf(`function ${fn}`));
    assert.match(body.slice(0, 900), /beginChangeCode\(/, fn + " confirms the change with a code");
  }
});

test("the confirmation sheet is declared after every sheet that opens it", () => {
  const code = indexHtml.indexOf('id="modal-change-code"');
  for (const id of ["modal-edit-profile", "modal-security", "modal-password", "modal-admin-profile", "modal-admin-password", "modal-change-email"]) {
    const at = indexHtml.indexOf(`id="${id}"`);
    assert.notEqual(at, -1, id + " exists");
    assert.ok(at < code, id + " must come before the confirmation sheet, so the sheet paints on top");
  }
});

test("the confirmation request is sent to the right endpoint for each account", () => {
  assert.match(appJs, /function changeCodeApi\(who\) \{ return who === "admin" \? "admin\.php" : "account\.php"; \}/);
});

/* ---------- exercising the sheet through the real app.js ---------- */

function fakeDom() {
  const nodes = new Map();
  const classes = new Map();

  function make(id) {
    const set = new Set();
    classes.set(id, set);
    const node = {
      id,
      innerHTML: "",
      textContent: "",
      value: "",
      hidden: false,
      style: {},
      dataset: {},
      classList: {
        add: c => set.add(c),
        remove: c => set.delete(c),
        contains: c => set.has(c),
        toggle: (c, on) => {
          const want = on === undefined ? !set.has(c) : !!on;
          if (want) set.add(c); else set.delete(c);
          return want;
        },
      },
      setAttribute() {},
      getAttribute: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
      focus() {},
      appendChild() {},
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    };
    nodes.set(id, node);
    return node;
  }

  const el = id => nodes.get(id) || make(id);

  return {
    el,
    isOpen: id => classes.get(id)?.has("open") || false,
    document: {
      getElementById: el,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => make("__new" + nodes.size),
      addEventListener: () => {},
      body: make("body"),
      hidden: false,
      title: "",
      activeElement: null,
    },
  };
}

function loadApp() {
  const dom = fakeDom();
  const sandbox = {
    console,
    document: dom.document,
    window: null,
    addEventListener: () => {},
    fetch: () => Promise.reject(new Error("no network in tests")),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
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
  vm.runInContext(appJs, ctx, { filename: path.join(ROOT, "app.js") });

  return { dom, run: expr => vm.runInContext(expr, ctx) };
}

test("beginChangeCode requests an email code and opens the sheet with the masked address", async () => {
  const app = loadApp();
  app.run("globalThis.__apiCalls = []");
  app.run("api = async function (p, body) { __apiCalls.push([p, body]); return { change: { sent_to: 'd****@mail.com' } }; }");

  await app.run("beginChangeCode('admin', 'password', () => {})");

  const calls = JSON.stringify(app.run("__apiCalls"));
  assert.equal(calls, JSON.stringify([["admin.php", { action: "request_change_code", purpose: "password" }]]), "the admin endpoint asks for a password code");
  assert.ok(app.dom.isOpen("modal-change-code"), "the confirmation sheet opens");
  assert.match(app.dom.el("change-code-title").textContent, /Password Change/, "the title names the change");
  assert.match(app.dom.el("change-code-text").innerHTML, /d\*\*\*\*@mail\.com/, "the sheet shows where the code went");
});

test("an empty code never runs the change", async () => {
  const app = loadApp();
  app.run("globalThis.__ran = false");
  app.run("changeCodeRun = () => { __ran = true; }");
  await app.run("submitChangeCode()");
  assert.equal(app.run("__ran"), false, "nothing happens without a code");
});

test("a confirmed code runs the change and closes the sheet", async () => {
  const app = loadApp();
  app.run("globalThis.__got = null");
  app.run("changeCodeRun = async (code) => { __got = code; }");
  app.run("openModal('modal-change-code')");
  app.dom.el("change-code-input").value = "04 3921";

  await app.run("submitChangeCode()");

  assert.equal(app.run("__got"), "043921", "the spaces are stripped before the code is used");
  assert.ok(!app.dom.isOpen("modal-change-code"), "the sheet closes once the change succeeds");
});

test("a rejected code keeps the sheet open so it can be retried", async () => {
  const app = loadApp();
  app.run("changeCodeRun = async () => { throw new Error('That code is not correct.'); }");
  app.run("openModal('modal-change-code')");

  await app.run("submitChangeCode()");

  assert.ok(app.dom.isOpen("modal-change-code"), "the sheet stays open on a wrong code");
  assert.notEqual(app.run("changeCodeRun"), null, "the pending change is still there to retry");
});
