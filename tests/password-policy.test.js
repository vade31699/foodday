/* FOODAY — the password policy is fixed, not a setting.
 *
 * "Require letters and numbers" used to be a switch in Admin > Settings >
 * Security, which meant a password could be weakened by turning it off. The
 * rule is now always in force, so there is nothing left to switch: the screen
 * states it as always-on, nothing collects it, and both ends of the app refuse
 * a password without letters and numbers.
 *
 * The minimum length stays a setting — a stricter floor is a matter of taste —
 * so these tests pin the *rule*, not the number.
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
const configPhp = read("api/config.php");
const adminPhp = read("api/admin.php");
const migrationsPhp = read("api/migrations.php");
const schemaSql = read("fooday.sql");

/** The `const NAME = [...];` list app.js keeps its setting keys in. */
function jsKeyList(name) {
  const at = appJs.indexOf(`const ${name} = [`);
  assert.notEqual(at, -1, name + " was not found in app.js");
  return appJs.slice(at, appJs.indexOf("]", at)).match(/"([^"]*)"/g).map(s => s.slice(1, -1));
}

/** app.js loaded into a sandbox, with no config: the default 6-character floor. */
function loadApp() {
  const el = { innerHTML: "" };
  const sandbox = {
    console,
    document: {
      getElementById: id => (id === "pw-rules" ? el : null),
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
  vm.runInContext(appJs, ctx, { filename: "app.js" });
  ctx.renderPasswordRules("pw-rules");
  return { rules: el.innerHTML, problem: p => ctx.passwordProblem(p) };
}

const app = loadApp();

/* ---------- there is nothing left to switch ---------- */

test("the settings state the rule as always on", () => {
  assert.ok(!/data-setting="password_require_mixed"/.test(indexHtml), "the rule is not a switch");
  assert.ok(!indexHtml.includes("toggleSetting('password_require_mixed')"), "and nothing calls one");

  const at = indexHtml.indexOf("Require letters and numbers");
  assert.notEqual(at, -1, "the rule is still stated");
  const row = indexHtml.slice(at, indexHtml.indexOf("</div>", at));
  assert.ok(!row.includes("data-setting="), "the row that applies it cannot be clicked");
  assert.match(row, /switch on locked/, "and is shown locked on");
});

test("app.js collects no switch for the rule, but still collects the length", () => {
  assert.ok(!jsKeyList("SETTINGS_TOGGLES").includes("password_require_mixed"), "there is no switch to save");
  assert.ok(jsKeyList("SETTINGS_TEXT").includes("password_min_length"), "the length is still a setting");
});

test("neither the schema, the seeds nor the dump carry the retired setting", () => {
  for (const [name, source] of [
    ["api/config.php", configPhp],
    ["api/admin.php", adminPhp],
    ["fooday.sql", schemaSql],
  ]) {
    assert.ok(!source.includes("require_mixed"), name + " still names the retired setting");
  }
  assert.ok(!configPhp.includes("'pw_require_mixed'"), "and it is no longer published to the browser");
  assert.ok(!migrationsPhp.includes("'password_require_mixed',"), "nor seeded as a default");

  // The one place it may still be named is the line that retires it.
  const mentions = migrationsPhp.split("require_mixed").length - 1;
  assert.equal(mentions, 1, "an upgrade mentions it once, to delete the row");
  assert.match(migrationsPhp, /DELETE FROM settings WHERE k = 'password_require_mixed'/, "and only to delete it");
});

/* ---------- the rule is in force everywhere a password is taken ---------- */

test("the form refuses a password with only letters, or only numbers", () => {
  for (const weak of ["abcdefgh", "12345678", "!!!!!!!!", "fooday123"]) {
    assert.match(app.problem(weak), /letters and numbers|too common/, weak + " should not be accepted");
  }
});

test("the form accepts a password that keeps the rule", () => {
  assert.equal(app.problem("fooday1"), null, "letters and numbers are enough at the default length");
  assert.match(app.problem("food1"), /at least/, "the length floor still applies");
});

test("the rules the form shows are the rules it keeps", () => {
  assert.ok(app.rules.includes("letters and numbers"), "the rule is always listed");
  assert.ok(app.rules.includes("At least 6 characters"), "alongside the length floor");
  assert.ok(app.rules.includes("Not a commonly used password"), "and the denylist");
});

test("the server refuses it too, and no setting can talk it out of that", () => {
  const policy = configPhp.slice(configPhp.indexOf("function password_problem"));
  const body = policy.slice(0, policy.indexOf("\n}"));

  assert.ok(!body.includes("setting_bool"), "the rule is not behind a switch");
  assert.ok(!body.includes("if (setting"), "nor gated on any other setting");
  assert.match(body, /\[A-Za-z\][\s\S]*\d|\d[\s\S]*\[A-Za-z\]/, "it still checks for letters and numbers");
});
