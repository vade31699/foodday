/* FOODAY — the app's own alert and confirmation sheets.
 *
 * The browser's own alert and confirm panels belong to the operating system:
 * they block the page, ignore FOODAY's styling, and on Android are easy to
 * mistake for a system warning. Both are replaced by sheets drawn inside the
 * app, so a failed sign-in and an "are you sure?" read like the rest of FOODAY.
 *
 * These tests pin the two things that would regress most easily:
 *
 *   1. No blocking browser dialog is left anywhere in app.js. A single missed
 *      call site would freeze the app on a phone again.
 *   2. A confirmation resolves only when a button is tapped. A dialog that
 *      quietly answered "yes" by itself would remove the wrong thing.
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

/* A native call is `alert(`, `confirm(` or `prompt(` with nothing but a word
 * break in front of it. The [^\w.$] guard is what keeps the helpers
 * (showAlert, confirmDialog) and the ordinary identifiers that merely start with
 * those words — a form field named `confirm`, an element id of `confirm-ok` —
 * off the hook. */
test("no blocking browser dialog is left in the app", () => {
  assert.doesNotMatch(appJs, /(^|[^\w.$])alert\s*\(/, "no native alert remains");
  assert.doesNotMatch(appJs, /(^|[^\w.$])confirm\s*\(/, "no native confirm remains");
  assert.doesNotMatch(appJs, /(^|[^\w.$])prompt\s*\(/, "no native prompt remains");
});

test("the error reporter speaks through the app's own alert sheet", () => {
  const body = appJs.slice(appJs.indexOf("function reportError"), appJs.indexOf("function reportError") + 420);
  assert.match(body, /showAlert\(/, "reportError shows the error in the alert sheet");
  assert.match(body, /unauthorized/, "and still sends an expired session back to sign-in");
});

test("the destructive actions share one awaited confirmation", () => {
  const calls = appJs.match(/await confirmDialog\(/g) || [];
  assert.ok(calls.length >= 6, `every destructive action confirms first (found ${calls.length})`);
  assert.match(appJs, /await confirmDialog\(/, "callers await the answer before acting");
});

test("the confirm sheet is declared after the sheets that can open it", () => {
  const at = indexHtml.indexOf('id="modal-confirm"');
  assert.notEqual(at, -1, "the confirm sheet exists");

  for (const id of ["modal-addresses", "modal-password", "modal-admin-password", "modal-change-code"]) {
    const opener = indexHtml.indexOf(`id="${id}"`);
    assert.notEqual(opener, -1, id + " exists");
    assert.ok(opener < at, id + " is declared before the confirm sheet, so the confirm paints on top");
  }

  assert.match(indexHtml, /onclick="confirmDialogAnswer\(true\)"/, "one button confirms");
  assert.match(indexHtml, /onclick="confirmDialogAnswer\(false\)"/, "one button cancels");
});

/* ---------- behaviour, in a stubbed browser ---------- */

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
    alert: () => { throw new Error("a native alert was called"); },
    confirm: () => { throw new Error("a native confirm was called"); },
    prompt: () => { throw new Error("a native prompt was called"); },
  };
  sandbox.window = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(appJs, ctx, { filename: "app.js" });

  return { dom, run: expr => vm.runInContext(expr, ctx) };
}

const app = loadApp();

test("an alert shows the exact message it was given", () => {
  app.run(`showAlert("The email or password is incorrect.", "Something Went Wrong")`);
  assert.ok(app.dom.isOpen("modal-info"), "the alert sheet opens");
  assert.equal(app.dom.el("info-title").textContent, "Something Went Wrong");
  assert.equal(app.dom.el("info-body").textContent, "The email or password is incorrect.");
});

test("a confirmation opens the sheet and stays pending until it is answered", async () => {
  let settled = false;
  const pending = app.run(
    `confirmDialog({ title: "Remove This Food?", message: "Remove this food? Past orders keep their saved copy.", confirmLabel: "Remove", danger: true })`
  );
  pending.then(() => { settled = true; });
  await Promise.resolve(); // let any accidental immediate settle surface

  assert.equal(settled, false, "the dialog does not answer itself");
  assert.ok(app.dom.isOpen("modal-confirm"), "the confirm sheet opens");
  assert.equal(app.dom.el("confirm-title").textContent, "Remove This Food?", "the title is the caller's");
  assert.equal(app.dom.el("confirm-text").textContent, "Remove this food? Past orders keep their saved copy.");
  assert.equal(app.dom.el("confirm-ok").textContent, "Remove", "the confirm button is relabelled");
  assert.match(app.dom.el("confirm-ok").className, /btn-danger/, "a destructive confirm is styled as danger");

  app.run("confirmDialogAnswer(false)");
  assert.equal(await pending, false, "cancelling resolves false");
  assert.ok(!app.dom.isOpen("modal-confirm"), "and closes the sheet");
});

test("confirming resolves true", async () => {
  const pending = app.run(`confirmDialog({ title: "Delete?", message: "Sure?" })`);
  app.run("confirmDialogAnswer(true)");
  assert.equal(await pending, true, "confirming resolves true");
  assert.ok(!app.dom.isOpen("modal-confirm"), "and closes the sheet");
});

/* ---------- the sign-in form reports under its own fields ---------- */

test("the sign-in form carries its own error line, under both inputs", () => {
  const email = indexHtml.indexOf('id="login-email"');
  const pass = indexHtml.indexOf('id="login-pass"');
  const err = indexHtml.indexOf('id="login-error"');

  assert.notEqual(email, -1, "the email field exists");
  assert.notEqual(pass, -1, "the password field exists");
  assert.notEqual(err, -1, "the error line exists");
  assert.ok(err > pass, "it sits below the password field, so under both inputs");
  assert.match(indexHtml.slice(err - 140, err + 60), /role="alert"/, "and is announced to a screen reader");

  assert.match(stylesCss, /\.field-error\{display:none/, "hidden until it has something to say");
  assert.match(stylesCss, /\.field-error\.show\{display:block\}/, "and shown once it does");
});

test("a rejected sign-in is reported under the fields, not in a sheet", async () => {
  const fresh = loadApp();
  fresh.run(`document.getElementById("login-email").value = "a@b.com"`);
  fresh.run(`document.getElementById("login-pass").value = "secret1"`);
  fresh.run(`api = async () => { const e = new Error("The email or password is incorrect."); e.status = 400; throw e; }`);
  await fresh.run("handleSignIn()");

  assert.ok(!fresh.dom.isOpen("modal-info"), "no alert sheet is opened for a rejected sign-in");
  const err = fresh.dom.el("login-error");
  assert.equal(err.textContent, "The email or password is incorrect.", "the server's message is shown verbatim");
  assert.ok(err.classList.contains("show"), "the inline error is visible");
});

test("an empty sign-in is refused under the fields too", async () => {
  const fresh = loadApp();
  await fresh.run("handleSignIn()");

  assert.ok(!fresh.dom.isOpen("modal-info"), "no alert sheet for an empty form");
  assert.equal(fresh.dom.el("login-error").textContent, "Please enter your email and password.");
});

test("a failure that is not about the fields keeps the sheet", async () => {
  const fresh = loadApp();
  fresh.run(`document.getElementById("login-email").value = "a@b.com"`);
  fresh.run(`document.getElementById("login-pass").value = "secret1"`);
  fresh.run(`api = async () => { throw new Error("Cannot reach the FOODAY server."); }`);
  await fresh.run("handleSignIn()");

  assert.ok(fresh.dom.isOpen("modal-info"), "a dead server still uses the alert sheet");
  assert.ok(!fresh.dom.el("login-error").classList.contains("show"), "and shows nothing under the fields");
});

test("editing a field clears the sign-in error", async () => {
  const fresh = loadApp();
  await fresh.run("handleSignIn()");
  assert.ok(fresh.dom.el("login-error").classList.contains("show"), "it starts shown");

  fresh.run("clearLoginError()");
  assert.ok(!fresh.dom.el("login-error").classList.contains("show"), "and is cleared once the user types");
  assert.equal(fresh.dom.el("login-error").textContent, "");
});
