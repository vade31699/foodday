/* FOODAY — the merged Security entry point.
 *
 * Change password and two-factor used to sit apart in the menus as if they were
 * unrelated settings. They are the same question — how this account is locked —
 * so each menu now has ONE Security row, and the sheet it opens offers both.
 *
 * The password and two-factor sheets are deliberately declared *after* the
 * Security sheet, so they open on top of it and closing one comes back here.
 *
 * Run with:  node --test
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_JS = path.join(__dirname, "..", "app.js");
const INDEX_HTML = path.join(__dirname, "..", "index.html");

const indexHtml = fs.readFileSync(INDEX_HTML, "utf8");

/* Markup between a screen's opening tag and the next screen. */
function screenMarkup(id) {
  const at = indexHtml.indexOf(`<section id="${id}"`);
  assert.notEqual(at, -1, id + " was not found in index.html");
  const next = indexHtml.indexOf("<section", at + 1);
  return indexHtml.slice(at, next === -1 ? undefined : next);
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/* ---------- one Security row per menu ---------- */

test("the customer profile offers Security exactly once", () => {
  const profile = screenMarkup("screen-profile");

  assert.equal(count(profile, "openSecurityModal('user')"), 1, "one Security row for the customer");
  assert.ok(!profile.includes("openMfaModal("), "two-factor is no longer a separate row");
  assert.ok(!profile.includes("openPasswordChange()"), "nor is the password");
});

test("the admin settings is a menu of the account actions", () => {
  const settings = screenMarkup("screen-admin-settings");

  assert.equal(count(settings, "openAdminPasswordModal()"), 1, "Change Password is offered once");
  assert.equal(count(settings, "openMfaModal('admin')"), 1, "Two-Factor is offered once");
  assert.equal(count(settings, "openChangeEmail()"), 1, "Change Email is offered once");
  assert.ok(!settings.includes("openSecurityModal"), "the admin routes straight to each action, not a merged sheet");
});

test("the admin settings menu carries no settings fields of its own", () => {
  const settings = screenMarkup("screen-admin-settings");

  assert.ok(!settings.includes("data-setting="), "no switches on the menu screen");
  assert.ok(!settings.includes('id="set-'), "and no value fields either");
});

/* ---------- the sheet offers both protections ---------- */

test("the Security sheet offers Change Password and Two-Factor", () => {
  const at = indexHtml.indexOf('id="modal-security"');
  assert.notEqual(at, -1, "the Security sheet exists");
  const sheet = indexHtml.slice(at, indexHtml.indexOf('id="modal-password"', at));

  assert.ok(sheet.includes("securityOpenPassword()"), "Change Password is offered");
  assert.ok(sheet.includes("securityOpenMfa()"), "Two-Factor Authentication is offered");
  assert.ok(sheet.includes('id="security-pass-summary"'), "the password line has somewhere to report from");
  assert.ok(sheet.includes('id="security-mfa-summary"'), "and so does the two-factor line");
  assert.ok(sheet.includes('id="security-intro"'), "the sheet can explain itself in the account's own words");
});

test("the sheets it leads to are declared after it, so they open on top", () => {
  const security = indexHtml.indexOf('id="modal-security"');

  for (const id of ["modal-password", "modal-admin-password", "modal-mfa"]) {
    const at = indexHtml.indexOf(`id="${id}"`);
    assert.notEqual(at, -1, id + " exists");
    assert.ok(security < at, id + " comes after the Security sheet, so closing it returns to Security");
  }
});

/* ---------- and routes to the account's own password and two-factor ---------- */

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
  vm.runInContext(fs.readFileSync(APP_JS, "utf8"), ctx, { filename: APP_JS });

  return { dom, run: expr => vm.runInContext(expr, ctx) };
}

const app = loadApp();

test("choosing Security opens the one sheet and remembers the account", () => {
  app.run("openSecurityModal('user')");
  assert.ok(app.dom.isOpen("modal-security"), "the Security sheet opens");
  assert.equal(app.run("securityWho"), "user", "the customer's account is the one in view");

  app.run("closeModal('modal-security')");
  app.run("openSecurityModal('admin')");
  assert.equal(app.run("securityWho"), "admin", "the admin's account is the one in view when the admin asks");
  assert.ok(app.dom.isOpen("modal-security"), "the same sheet serves both");
});

test("the intro speaks to whoever is signed in", () => {
  app.run("openSecurityModal('user')");
  const user = app.dom.el("security-intro").textContent;
  app.run("openSecurityModal('admin')");
  const admin = app.dom.el("security-intro").textContent;

  assert.match(user, /your account/i, "the customer is told about their account");
  assert.match(admin, /admin/i, "the admin is told about the admin account");
  assert.notEqual(user, admin, "the two are not the same sentence");
});

test("Change Password opens the sheet belonging to the account in view", () => {
  app.run("closeModal('modal-password'); closeModal('modal-admin-password')");

  app.run("openSecurityModal('user'); securityOpenPassword()");
  assert.ok(app.dom.isOpen("modal-password"), "the customer gets the customer sheet");
  assert.ok(!app.dom.isOpen("modal-admin-password"), "and not the admin one");

  app.run("closeModal('modal-password'); openSecurityModal('admin'); securityOpenPassword()");
  assert.ok(app.dom.isOpen("modal-admin-password"), "the admin gets the admin sheet");
});

test("Two-Factor opens for the account in view", () => {
  app.run("closeModal('modal-mfa')");

  app.run("openSecurityModal('user')");
  app.run("securityOpenMfa()");
  assert.equal(app.run("mfaWho"), "user", "the customer's two-factor is the one offered");
  assert.ok(app.dom.isOpen("modal-mfa"), "the two-factor sheet opens");

  app.run("closeModal('modal-mfa'); openSecurityModal('admin')");
  app.run("securityOpenMfa()");
  assert.equal(app.run("mfaWho"), "admin", "the admin's two-factor is the one offered");
});
