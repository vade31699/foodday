/* FOODAY — emailed code when creating an account.
 *
 * A sign-up must not create an account until a one-time code has come back from
 * the address being registered, so an account cannot be opened around someone
 * else's mailbox. The backend half is a source contract (auth.php only reaches
 * the INSERT through signup_verify_code()); the frontend half is exercised
 * through the real app.js in a fake DOM, with only fetch stubbed out.
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
const authPhp = read("api/auth.php");
const configPhp = read("api/config.php");
const signupPhp = read("api/signup_codes.php");
const migrationsPhp = read("api/migrations.php");
const sql = read("fooday.sql");

/* ---------- the backend only creates the account after the code ---------- */

test("the signup-code library emails and verifies a code", () => {
  assert.ok(signupPhp.includes("function signup_request_code"), "a code can be requested");
  assert.ok(signupPhp.includes("function signup_verify_code"), "and verified");
  assert.match(signupPhp, /send_mail\(/, "the code goes out through the one mail path");
});

test("config.php loads the signup-code library", () => {
  assert.match(configPhp, /require_once __DIR__ \. '\/signup_codes\.php'/, "the library is always available");
});

test("signup asks for a code instead of creating an account", () => {
  const body = authPhp.slice(authPhp.indexOf("function signup("), authPhp.indexOf("function signup_verify("));
  assert.match(body, /signup_request_code\(/, "the form starts a pending signup");
  assert.match(body, /verify_required/, "and tells the client a code is needed");
  assert.doesNotMatch(body, /INSERT INTO users/, "nothing is written to users yet");
});

test("the account is created only after the emailed code is verified", () => {
  const body = authPhp.slice(authPhp.indexOf("function signup_verify("), authPhp.indexOf("function signup_resend("));
  assert.match(body, /signup_verify_code\(/, "the code is checked first");
  assert.match(body, /INSERT INTO users/, "and only then is the user row written");
  assert.ok(body.indexOf("signup_verify_code(") < body.indexOf("INSERT INTO users"),
    "the check comes before the insert");
});

test("the schema ships the signup_codes table", () => {
  assert.match(sql, /CREATE TABLE signup_codes/, "a fresh import creates it");
  assert.match(migrationsPhp, /CREATE TABLE IF NOT EXISTS signup_codes/, "an upgraded install gets it too");
  assert.match(migrationsPhp, /const FOODAY_SCHEMA_VERSION = '10'/, "the version is bumped so an existing install upgrades");
});

/* ---------- the frontend shows the sheet and returns the code ---------- */

test("index.html declares the signup confirmation sheet", () => {
  assert.match(indexHtml, /id="modal-signup-code"/, "the sheet exists");
  assert.match(indexHtml, /id="signup-code-input"/, "with somewhere to type the code");
  assert.match(indexHtml, /onclick="submitSignupCode\(\)"/, "and a button that confirms it");
  assert.match(indexHtml, /onclick="resendSignupCode\(\)"/, "plus a way to ask for another code");
});

test("handleSignUp opens the signup sheet when the server asks for a code", () => {
  const body = appJs.slice(appJs.indexOf("function handleSignUp"), appJs.indexOf("function beginSignupCode"));
  assert.match(body, /beginSignupCode\(/, "the form hands over to the code sheet");
  assert.match(body, /verify_required/, "only when the server asked for a code");
});

test("the code is confirmed against the signup_verify action", () => {
  const body = appJs.slice(appJs.indexOf("function submitSignupCode"));
  assert.match(body, /action:\s*"signup_verify"/, "the sheet posts the code to the verify action");
  assert.match(body.slice(0, 800), /signupPendingEmail/, "for the address the form registered");
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
      type: "",
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

test("beginSignupCode opens the sheet with the masked address", async () => {
  const app = loadApp();
  await app.run("beginSignupCode('new@mail.com', { sent_to: 'n**@mail.com' })");
  assert.ok(app.dom.isOpen("modal-signup-code"), "the signup sheet opens");
  assert.match(app.dom.el("signup-code-text").innerHTML, /n\*\*@mail\.com/, "the sheet shows where the code went");
});

test("an empty signup code never runs the change", async () => {
  const app = loadApp();
  app.run("globalThis.__verified = false");
  app.run("api = async function () { __verified = true; return {}; }");
  await app.run("submitSignupCode()");
  assert.equal(app.run("__verified"), false, "nothing happens without a code");
});

test("a confirmed signup code verifies the address and closes the sheet", async () => {
  const app = loadApp();
  app.run("globalThis.__calls = []");
  app.run("globalThis.refreshStore = async function () {}");
  app.run("api = async function (p, body) { __calls.push([p, body]); return { ok: true, user: { name: 'New' } }; }");
  await app.run("beginSignupCode('new@mail.com', { sent_to: 'n**@mail.com' })");
  app.dom.el("signup-code-input").value = "04 3921";

  await app.run("submitSignupCode()");

  const calls = JSON.stringify(app.run("__calls"));
  assert.equal(calls, JSON.stringify([["auth.php", { action: "signup_verify", email: "new@mail.com", code: "043921" }]]),
    "the spaces are stripped and the code is verified");
  assert.ok(!app.dom.isOpen("modal-signup-code"), "the sheet closes once the account is created");
});
