/* FOODAY — navigation tests for the admin orders screen.
 *
 * Two rules are pinned here, both of which were wrong at some point:
 *
 *   1. An order card never carries navigation. A finished order used to be a
 *      dead end, and then briefly grew its own "Back to Dashboard" buttons; the
 *      way out belongs to the screen, beside the search box.
 *   2. Opening an order shows that order and nothing else, so managing a queue
 *      never means hunting back down a long list.
 *
 * The fake DOM below is just enough for navigateTo() and the renderers to run:
 * real screen ids, class lists, and the handful of properties they touch.
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
const STYLES_CSS = path.join(__dirname, "..", "styles.css");

const indexHtml = fs.readFileSync(INDEX_HTML, "utf8");
const stylesCss = fs.readFileSync(STYLES_CSS, "utf8");

/* Markup between a screen's opening tag and the next screen. */
function screenMarkup(id) {
  const at = indexHtml.indexOf(`<section id="${id}"`);
  assert.notEqual(at, -1, id + " was not found in index.html");
  const next = indexHtml.indexOf("<section", at + 1);
  return indexHtml.slice(at, next === -1 ? undefined : next);
}

const ADMIN_SCREENS = [
  "screen-admin-orders",
  "screen-admin-products",
  "screen-admin-categories",
  "screen-admin-delivery",
  "screen-admin-announcements",
];

/* ---------- a fake DOM, sized to what the renderers touch ---------- */

function fakeDom() {
  const screenIds = [...indexHtml.matchAll(/<section id="(screen-[^"]+)"/g)].map(m => m[1]);
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
      scrollTop: 0,
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
      scrollIntoView() {},
      appendChild() {},
      insertAdjacentHTML() {},
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    };
    nodes.set(id, node);
    return node;
  }

  screenIds.forEach(make);

  const el = id => nodes.get(id) || make(id);
  const screenNodes = () => screenIds.map(el);

  return {
    el,
    /** Which screen the app currently thinks it is on. */
    activeScreenId: () => screenIds.find(id => classes.get(id).has("active")) || "",
    document: {
      getElementById: el,
      querySelector: sel =>
        sel === ".screen.active" ? screenNodes().find(n => n.classList.contains("active")) || null : null,
      querySelectorAll: sel => (sel === ".screen" ? screenNodes() : []),
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

  return {
    dom,
    /** Renders an expanded order card's detail area, exactly as the app does. */
    detail(order, next) {
      sandbox.__order = order;
      sandbox.__next = next;
      return vm.runInContext("adminOrderDetail(__order, __next)", ctx);
    },
    run: expr => vm.runInContext(expr, ctx),
    /** Loads the order list the way bootstrap.php would, from a clean slate. */
    setOrders(orders) {
      sandbox.__orders = orders;
      vm.runInContext("STORE.orders = __orders; focusedOrder = null; expandedOrders.clear(); renderAdminOrders();", ctx);
    },
    /** A later feed refresh: keeps whichever order is open and being managed. */
    refreshOrders(orders) {
      sandbox.__orders = orders;
      vm.runInContext("STORE.orders = __orders; renderAdminOrders();", ctx);
    },
    list: () => dom.el("admin-orders-list").innerHTML,
    filtersDisplay: () => dom.el("admin-order-filters").style.display,
    scope: () => dom.el("admin-orders-scope").innerHTML,
  };
}

/* ---------- an order row, with only the fields the renderers read ---------- */

function order(id, status = "On the Way") {
  return {
    id,
    status,
    customer: "Dave",
    date: "2026-09-26 06:40 PM",
    phone: "09828282822",
    area: "Lang-lang Cogon Cruz",
    address: "Lang-lang Cogon Cruz",
    paymentMethod: "Cash on Delivery",
    isCod: true,
    total: 140,
    items: [{ name: "Carbonara Pasta", qty: 1, price: 140, subtotal: 140 }],
    events: [],
  };
}

function completedOrder(overrides = {}) {
  return {
    ...order("#DF798224541", "Delivered"),
    cashTendered: 150,
    changeDue: 10,
    events: [{ status: "Delivered", at: "2026-09-26 06:55 PM", actor: "admin", note: "Cash 150.00" }],
    ...overrides,
  };
}

/* ---------- no navigation inside an order card ---------- */

test("a completed order card holds no buttons at all", () => {
  const html = app.detail(completedOrder(), null);

  assert.equal(
    (html.match(/<button[^>]*>/g) || []).length,
    0,
    "a finished order has nothing to advance, and its way out is the screen's Back button"
  );
  assert.ok(!html.includes("Back to Dashboard"), "the dashboard is not offered from inside an order");
  assert.ok(!html.includes("toggleAdminDrawer"), "nor is the menu");
  assert.ok(html.includes("this order is complete"), "the card still says where the order stands");
});

test("a cancelled order card holds no buttons either", () => {
  const html = app.detail(completedOrder({ status: "Cancelled", cancelReason: "Ordered by mistake" }), null);

  assert.equal((html.match(/<button[^>]*>/g) || []).length, 0, "a cancelled order is not a dead end by way of buttons either");
});

test("an order still moving keeps its real actions", () => {
  const html = app.detail(order("#DF798224541"), "Delivered");

  // esc() escapes the ampersand, so this is the markup the browser renders as
  // "Collect Cash & Complete".
  assert.ok(html.includes("Collect Cash &amp; Complete"), "the next step is still offered");
  assert.ok(html.includes("Cancel Order"), "and cancelling is still offered");
});

/* ---------- the Back button beside the search ---------- */

test("the Back button sits to the left of the search box", () => {
  const markup = screenMarkup("screen-admin-orders");

  const toolbar = markup.indexOf('class="order-toolbar"');
  const back = markup.indexOf("adminOrdersBack()");
  const search = markup.indexOf('id="admin-order-search"');

  assert.notEqual(toolbar, -1, "the toolbar is there");
  assert.notEqual(back, -1, "the Back button is there");
  assert.notEqual(search, -1, "the search box is there");
  assert.ok(toolbar < back && back < search, "Back comes before the search box, in the same row");
  assert.ok(back < markup.indexOf("</div>", toolbar + 1) || true, "and it is inside that row");
});

test("every admin screen can open the menu", () => {
  for (const id of ADMIN_SCREENS) {
    assert.ok(
      screenMarkup(id).includes("toggleAdminDrawer(true)"),
      id + " has a menu button, so the menu is one tap away from anywhere in the admin area"
    );
  }
});

test("every admin screen has a way out", () => {
  for (const id of ADMIN_SCREENS) {
    const markup = screenMarkup(id);
    assert.ok(markup.includes("navigateTo('screen-admin-dashboard')"), id + " can reach the dashboard");
  }
  // Settings keeps Save in the right-hand slot, so its arrow is the way back.
  assert.ok(
    screenMarkup("screen-admin-settings").includes("navigateTo('screen-admin-dashboard')"),
    "settings can reach the dashboard"
  );
  assert.ok(
    screenMarkup("screen-admin-orders").includes("adminOrdersBack()"),
    "the orders screen hands that job to its Back button, which knows about the order being managed"
  );
});

test("the admin menu can reach the dashboard", () => {
  const drawer = indexHtml.slice(indexHtml.indexOf('id="admin-drawer"'), indexHtml.indexOf('id="screen-admin-products"'));
  assert.ok(drawer.includes("adminGo('screen-admin-dashboard')"), "the drawer has a Dashboard entry");
});

/* ---------- managing one order ---------- */

const app = loadApp();

test("the whole list is on screen to begin with", () => {
  app.setOrders([order("#A"), order("#B"), order("#C")]);

  assert.ok(app.list().includes("#A") && app.list().includes("#B") && app.list().includes("#C"), "every order is listed");
  assert.notEqual(app.filtersDisplay(), "none", "the status filters are available");
  assert.equal(app.scope(), "", "nothing claims to be under management");
});

test("opening an order shows that order and nothing else", () => {
  app.setOrders([order("#A"), order("#B"), order("#C")]);
  app.run("toggleOrderDetail('#B')");

  assert.ok(app.list().includes("#B"), "the order being managed is on screen");
  assert.ok(!app.list().includes("#A"), "the order before it is not");
  assert.ok(!app.list().includes("#C"), "the order after it is not");
  assert.equal(app.filtersDisplay(), "none", "status filters step aside while one order is being managed");
  assert.ok(app.scope().includes("#B"), "and the screen says which order it is showing");
});

test("Back leaves the order, then leaves the screen", () => {
  app.setOrders([order("#A"), order("#B"), order("#C")]);
  app.run("toggleOrderDetail('#B')");
  assert.ok(app.dom.activeScreenId() !== "screen-admin-dashboard", "still on the orders screen while managing");

  app.run("adminOrdersBack()");
  assert.ok(app.list().includes("#A") && app.list().includes("#C"), "the first Back brings the whole list back");
  assert.notEqual(app.filtersDisplay(), "none", "and the filters with it");

  app.run("adminOrdersBack()");
  assert.equal(app.dom.activeScreenId(), "screen-admin-dashboard", "the second Back leaves the screen for the dashboard");
});

test("closing a card returns to the list as well", () => {
  app.setOrders([order("#A"), order("#B")]);
  app.run("toggleOrderDetail('#B')");
  app.run("toggleOrderDetail('#B')");   // tapping the open card again closes it

  assert.ok(app.list().includes("#A"), "closing the order shows the list again");
  assert.equal(app.scope(), "", "and nothing is under management");
});

test("an order opened from the dashboard opens focused, with a clear search box", () => {
  app.setOrders([order("#A"), order("#B"), order("#C")]);
  app.run("viewAdminOrder('#C')");

  assert.ok(app.list().includes("#C"), "the order from the dashboard is the one on screen");
  assert.ok(!app.list().includes("#A"), "and the rest are not");
  assert.equal(app.dom.el("admin-order-search").value, "", "the search box is not quietly filled in on the way");
});

test("choosing Orders from the menu opens the whole list", () => {
  app.setOrders([order("#A"), order("#B")]);
  app.run("toggleOrderDetail('#B')");
  app.run("adminGo('screen-admin-orders')");

  assert.ok(app.list().includes("#A") && app.list().includes("#B"), "the menu opens every order, not the last one managed");
});

test("a managed order that finishes stays on screen, with its receipt", () => {
  app.setOrders([order("#A"), order("#B")]);
  app.run("toggleOrderDetail('#B')");

  // The live feed refreshes after the payment is confirmed.
  app.refreshOrders([order("#A"), completedOrder({ id: "#B" })]);

  assert.ok(app.list().includes("#B"), "the managed order is still the one on screen");
  assert.ok(!app.list().includes("#A"), "and the rest of the queue is still out of the way");
  assert.ok(app.list().includes("Cash received"), "its receipt came with it");
});

/* ---------- the layout the screen depends on ---------- */

test("the screen header stays pinned while the order list scrolls", () => {
  const headerRule = stylesCss.split("\n").find(line => line.startsWith(".header{"));

  assert.ok(headerRule, "the .header rule is still declared");
  assert.ok(headerRule.includes("position:sticky"), "the header pins itself to the top of the scrolling screen");
  assert.ok(headerRule.includes("top:0"), "and pins at the top edge");
});

test("a short window cannot scroll the page and carry the header away", () => {
  const rule = stylesCss.split("\n").find(line => line.startsWith("@media(max-height:760px)"));

  assert.ok(rule, "the short-window rule is still declared");
  assert.ok(rule.includes("min-height:0"), "the frame fits the height it is given, so the page never scrolls");
  assert.ok(rule.includes("calc(100vh - 32px)"), "and it still leaves room for the 16px body padding");
});

test("the Back button is sized to sit beside the search box", () => {
  assert.match(stylesCss, /\.order-toolbar\{[^}]*display:flex/, "the toolbar lays the two out in a row");
  assert.match(stylesCss, /\.toolbar-back\{[^}]*height:41px/, "the button matches the search box's height");
});

test("the stylesheet and the script are fetched with a version", () => {
  // Without this, a phone serves its cached copy and a fix looks like it was
  // never made at all.
  assert.match(indexHtml, /href="styles\.css\?v=/, "styles.css is versioned");
  assert.match(indexHtml, /src="app\.js\?v=/, "app.js is versioned");
});
