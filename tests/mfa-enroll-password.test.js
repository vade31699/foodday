/* FOODAY — turning on two-factor asks for the password first.
 *
 * The emailed code is the second factor, so it must not be sent until the first
 * one has been proven: starting an enrolment requires the account's current
 * password, for a customer and an admin alike. Only then is a one-time code
 * emailed, and it may be replaced no sooner than the shared resend cooldown.
 *
 * The server side is checked at the source level (its decision lives behind a
 * database) and the browser side is exercised through the real app.js so the
 * modal can be observed rather than assumed.
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

const mfaPhp = read("api/mfa.php");
const accountPhp = read("api/account.php");
const adminPhp = read("api/admin.php");
const appJs = read("app.js");

/* ---------- the server side ---------- */

test("starting an enrolment requires the current password", () => {
  assert.match(
    mfaPhp,
    /function mfa_start_enrollment\(array \$actor, string \$password\)/,
    "mfa_start_enrollment takes a password"
  );

  const start = mfaPhp.slice(mfaPhp.indexOf("function mfa_start_enrollment"));
  const until = start.indexOf("function mfa_confirm_enrollment");
  const body = start.slice(0, until === -1 ? undefined : until);

  assert.match(body, /password_matches\(\$password/, "the password is checked against the account's own hash");
  assert.match(body, /SELECT password FROM `\$table`/, "the right account table is read");

  // The code must not be emailed before the password is verified.
  const check = body.indexOf("password_matches(");
  const send = body.indexOf("mfa_send_code(");
  assert.ok(check !== -1 && send !== -1, "both a check and a send are present");
  assert.ok(check < send, "the password is checked before any code is sent");
});

test("both the customer and the admin pass their password through", () => {
  for (const [name, source] of [["account.php", accountPhp], ["admin.php", adminPhp]]) {
    assert.match(
      source,
      /mfa_start_enrollment\(\$actor, \(string\) \(\$data\['password'\] \?\? ''\)\)/,
      name + " forwards the password to the enrolment"
    );
  }
});

test("the resend cooldown still limits how fast a code can be replaced", () => {
  const start = mfaPhp.slice(mfaPhp.indexOf("function mfa_start_enrollment"));
  const body = start.slice(0, start.indexOf("function mfa_confirm_enrollment"));
  assert.match(body, /code_reissue_wait\(/, "an enrolment code cannot be replaced inside the cooldown");
});

/* ---------- the browser side ---------- */

function fakeDom() {
  const nodes = new Map();

  function make(id) {
    const set = new Set();
    const node = {
      id,
      innerHTML: "",
      textContent: "",
      value: "",
      hidden: false,
      style: {},
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
    };
    nodes.set(id, node);
    return node;
  }

  const el = id => nodes.get(id) || make(id);

  return {
    el,
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

const app = loadApp();

test("the off state offers the password step, not a code straight away", () => {
  app.run("mfaWho = 'user'; mfaLogin = { masked_email: 'a***@b.com' }; mfaRecovery = null; mfaState = 'status'; mfaRender()");
  const view = app.dom.el("mfa-body").innerHTML;

  assert.match(view, /onclick="mfaGo\('password'\)"/, "Turn On leads to the password step");
  assert.ok(!view.includes("mfaStartEnable()"), "it does not send a code directly");
});

test("the password step asks for the current password and sends the code", () => {
  app.run("mfaState = 'password'; mfaRender()");
  const view = app.dom.el("mfa-body").innerHTML;

  assert.match(view, /id="mfa-enable-pass"/, "a password field is shown");
  assert.match(view, /onclick="mfaStartEnable\(\)"/, "the button sends the code");
  assert.match(
    view,
    /togglePasswordVisibility\('mfa-enable-pass'/,
    "the field carries a show/hide eye"
  );
  assert.match(view, /a\*\*\*@b\.com/, "it names the address the code will go to");
});

test("the browser sends the password with the request", () => {
  const start = appJs.slice(appJs.indexOf("async function mfaStartEnable"));
  const body = start.slice(0, start.indexOf("async function mfaConfirmEnable"));

  assert.match(body, /action: "mfa_start", password: pass/, "the password travels with the action");
  assert.match(body, /mfaEnablePass = pass/, "and is remembered for a resend");
  assert.match(body, /if \(!pass\)/, "an empty password is refused before the round trip");
});

test("a resend reuses the password already entered", () => {
  const setup = appJs.slice(appJs.indexOf("function mfaSetupView"));
  assert.match(
    setup.slice(0, setup.indexOf("function mfaCodesView")),
    /mfaStartEnable\(\)/,
    "the setup step can ask for another code"
  );

  // With the password field gone from the setup step, mfaStartEnable falls back
  // to the held password rather than sending nothing.
  assert.match(appJs, /passInput \? \(passInput\.value \|\| ""\) : mfaEnablePass/);
});
