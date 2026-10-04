/* FOODAY — the show/hide eye on every password field.
 *
 * A password box is the one field people mistype, so every one of them carries
 * an eye that flips between hidden and visible. The eye is part of the markup
 * (so it is styled and reachable without JavaScript running a scan), and the
 * toggle itself is checked through the real app.js in a fake DOM.
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
const styles = read("styles.css");

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

test("every password input in index.html sits in a field with an eye", () => {
  const passwords = occurrences(indexHtml, 'type="password"');
  const fields = occurrences(indexHtml, 'class="pw-field"');
  const eyes = occurrences(indexHtml, 'class="pw-eye"');
  assert.ok(passwords > 0, "there are password fields");
  assert.equal(fields, passwords, "each password field in the markup is wrapped");
  assert.equal(eyes, fields, "each field has exactly one eye");
});

test("the eye is labelled and wired to the toggle", () => {
  assert.match(indexHtml, /onclick="togglePasswordVisibility\('signup-pass', this\)"/, "the signup password has an eye");
  assert.match(indexHtml, /onclick="togglePasswordVisibility\('admin-pw-new', this\)"/, "the admin password has one too");
  assert.match(indexHtml, /aria-label="Show password"/, "the eye is announced to a screen reader");
});

test("the dynamically rendered disable-password field has an eye as well", () => {
  const body = appJs.slice(appJs.indexOf("function mfaDisableView"));
  assert.match(body.slice(0, 900), /togglePasswordVisibility\('mfa-disable-pass'/, "the two-factor password can be revealed");
});

test("styles.css gives the eye its own placement", () => {
  assert.match(styles, /\.pw-field\{/, "the field is a positioning context");
  assert.match(styles, /\.pw-eye\{/, "the eye is positioned over the input");
  assert.match(styles, /\.pw-eye-slash\{display:none\}/, "the slash only appears while the password is shown");
});

/* ---------- exercising the toggle through the real app.js ---------- */

function fakeDom() {
  const nodes = new Map();

  function make(id) {
    const set = new Set();
    const node = {
      id,
      value: "",
      type: "password",
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
      attributes: {},
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute: k => (k in node.attributes ? node.attributes[k] : null),
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

test("togglePasswordVisibility flips the field and the eye in step", () => {
  const app = loadApp();
  const input = app.dom.el("pw-new");
  const eye = app.dom.el("pw-eye");

  app.run("togglePasswordVisibility('pw-new', document.getElementById('pw-eye'))");

  assert.equal(input.type, "text", "the password is shown");
  assert.equal(eye.getAttribute("aria-label"), "Hide password", "the eye now offers to hide it");
  assert.equal(eye.getAttribute("aria-pressed"), "true", "and reads as pressed");
  assert.ok(eye.classList.contains("on"), "the slash is shown while the password is visible");

  app.run("togglePasswordVisibility('pw-new', document.getElementById('pw-eye'))");

  assert.equal(input.type, "password", "a second tap hides it again");
  assert.equal(eye.getAttribute("aria-label"), "Show password", "and the eye offers to show it");
  assert.ok(!eye.classList.contains("on"), "the slash is gone");
});
