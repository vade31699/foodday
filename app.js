/* FOODAY — frontend
 * All account, catalog, settings and order data lives in MySQL and is
 * reached through the PHP API in ./api/. Only the cart and the in-progress
 * checkout are kept in the browser (they are transient).
 */

const EMPTY_STORE = {
  user: null,
  admin: false,
  adminProfile: null,
  config: {},
  settings: null,
  categories: [],
  products: [],
  areas: [],
  announcements: [],
  favorites: [],
  addresses: [],
  orders: []
};

const ORDER_FLOW = ["Order Placed", "Accepted", "Preparing", "On the Way", "Delivered"];
const ORDER_DONE = ["Delivered", "Cancelled"];
/* Payment methods settled in cash at the door; mirrors ORDER_CASH_METHODS in api/config.php */
const CASH_METHODS = ["Cash on Delivery", "COD", "Cash"];
/* Notes the rider is most likely to be handed, for one-tap entry. */
const CASH_QUICK = [20, 50, 100, 200, 500, 1000];
/* Text of the admin button that moves an order INTO the given status.
   Keyed by the target, because that is what the button passes to the API. */
const ADVANCE_LABEL = {
  "Accepted": "Accept Order",
  "Preparing": "Start Preparing",
  "On the Way": "Delivery on the Way",
  "Delivered": "Mark Delivered"
};
const STEP_BLURB = {
  "Order Placed": "We received your order",
  "Accepted": "Order accepted by FOODAY",
  "Preparing": "Our kitchen is preparing your food",
  "On the Way": "Your rider is on the way",
  "Delivered": "Enjoy your meal!"
};
const ADMIN_FILTERS = ["All", "New", "Accepted", "Preparing", "On the Way", "Delivered", "Cancelled"];

let STORE = { ...EMPTY_STORE };
let currentCategory = "All";
let currentProduct = null;
let detailQty = 1;
let currentOrderId = null;
let productImageData = "";
let editingProductId = null;
let checkoutMode = "cart";          // 'cart' | 'buynow'
let buyNowItem = null;
let selectedPayment = "Cash on Delivery";
let cancelTarget = null;
let cashTarget = null;         // the order whose cash is being collected
let adminOrderFilter = "All";
let orderFilter = "All";
let settingsDirty = false;
let pendingSettings = null;
let expandedOrders = new Set();
let advancing = new Set();      // "order|status" keys of advances still in flight
let focusedOrder = null;        // the one order being managed, if any
let liveTimer = null;           // poll that mirrors admin changes onto this device
let livePokeTimer = null;
let liveBusy = false;
let lastOrderSig = "";
let cart = getLocal("fooday_cart", []);

/* ---------- small helpers ---------- */

function getLocal(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function setLocal(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function money(n) { return `₱${Number(n || 0).toFixed(2)}`; }
function esc(v) { return String(v ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m])); }
/*
 * esc() is for HTML text and attribute values. It is NOT safe inside an inline
 * handler: the browser decodes entities in an attribute before the JS engine
 * sees it, so an esc()'d "&#039;" turns back into a quote and can break out of
 * a single-quoted JS string. jsq() encodes a value for exactly that position —
 * a single-quoted string argument inside a double-quoted HTML attribute — by
 * removing every character that could end the string or the attribute
 * (\ ' " < > & and line breaks) and emitting them as JS escapes instead.
 */
function jsq(v) {
  return String(v ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, "\\u0022")
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
/* Numeric-only fields: a phone number field takes digits and nothing else. */
function digitsOnly(el) {
  const max = Number(el.getAttribute("maxlength")) || 0;
  let v = (el.value || "").replace(/\D/g, "");
  if (max) v = v.slice(0, max);
  if (v !== el.value) el.value = v;
}
/* Decimal-only fields: digits and at most one dot, for money amounts. */
function decimalOnly(el) {
  let v = (el.value || "").replace(/[^\d.]/g, "");
  const dot = v.indexOf(".");
  if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, "");
  if (v !== el.value) el.value = v;
}
function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function validPhone(v) { return /^09\d{9}$/.test(v); }
function validName(v) { return /^[A-Za-z][A-Za-z\s.'-]*$/.test(v.trim()); }
function capitalize(v) { return v.trim().replace(/\b\w/g, c => c.toUpperCase()); }

function products() { return STORE.products || []; }
function categories() { return STORE.categories || []; }
function areas() { return STORE.areas || []; }
function orders() { return STORE.orders || []; }
function user() { return STORE.user || {}; }
function admin() { return STORE.adminProfile || {}; }
function favorites() { return STORE.favorites || []; }
function addresses() { return STORE.addresses || []; }
function announcements() { return STORE.announcements || []; }
function config() { return STORE.config || {}; }
function settingValue(key, fallback = "") { return STORE.settings && STORE.settings[key] !== undefined ? String(STORE.settings[key]) : fallback; }
function settingOn(key) { return settingValue(key, "0") === "1"; }
function isStoreOpen() { return config().store_open !== false; }
function orderableProducts() { return STORE.products.filter(p => p.available !== false); }

/* ---------- API access ---------- */

async function api(path, payload) {
  let res;
  try {
    res = await fetch(`api/${path}`, {
      method: payload ? "POST" : "GET",
      headers: payload ? { "Content-Type": "application/json" } : {},
      body: payload ? JSON.stringify(payload) : undefined,
      credentials: "same-origin"
    });
  } catch {
    throw new Error("Cannot reach the FOODAY server. Make sure you opened the app through a PHP server (e.g. http://localhost/fooday/) and not as a plain file.");
  }
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON response */ }
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || `Request failed (${res.status}).`);
    err.unauthorized = res.status === 401;
    err.status = res.status;          // lets a caller tell a rejected form from a dead server
    throw err;
  }
  return data;
}

async function refreshStore() {
  const store = applyStore(await api("bootstrap.php"));
  lastOrderSig = orderSignature(store.orders);
  return store;
}

function applyStore(data) { STORE = { ...EMPTY_STORE, ...data }; return STORE; }

/** Shows the error in the app's own alert sheet, and sends the user back to
 *  sign-in if their session expired. */
function reportError(e) {
  const message = e && e.message ? e.message : "Something went wrong. Please try again.";
  showAlert(message, e && e.unauthorized ? "Session Ended" : "Something Went Wrong");
  if (e && e.unauthorized) {
    refreshStore().then(() => navigateTo("screen-signin")).catch(() => {});
  }
}

/**
 * Guards an action that only works for a signed-in customer. Better than letting
 * the request fail with a bare 401, which reads as "the app is broken".
 */
function requireSignIn(what) {
  toast("Sign In Required", `Please sign in to ${what}.`);
  navigateTo("screen-signin");
  return false;
}

/* ---------- live order sync ----------
 * The kitchen moves an order along the pipeline while the customer is sitting
 * on Track Order, so the customer's screen has to follow on its own. A quiet
 * poll of bootstrap.php does it: the DOM is only touched when the order feed
 * actually changed, and never while a field on that screen is being typed in.
 */

const LIVE_INTERVAL = 8000;
const LIVE_SCREENS = ["screen-orders", "screen-tracking", "screen-admin-dashboard", "screen-admin-orders"];

/** Cheap fingerprint of everything the order views render. */
function orderSignature(list) {
  return (list || [])
    .map(o => `${o.id}:${o.status}:${o.statusUpdated || ""}:${o.cancelReason || ""}:${(o.events || []).length}:${o.canCancel ? 1 : 0}`)
    .join("|");
}
function activeScreenId() { return document.querySelector(".screen.active")?.id || ""; }
function orderIsDone(o) { return ORDER_DONE.includes(o.status); }
/* The server flag is authoritative; the name list only covers payloads that
   predate the flag. */
function isCod(o) { return o.isCod === true || (o.isCod === undefined && CASH_METHODS.includes(o.paymentMethod)); }
function cashPaid(o) { return o.cashTendered === null || o.cashTendered === undefined ? null : Number(o.cashTendered); }

/** True when the caret is in a field that the next render would wipe out. */
function liveFieldFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return false;
  return el.type !== "checkbox" && el.type !== "radio";
}

function startLiveSync() {
  stopLiveSync();
  lastOrderSig = orderSignature(orders());
  liveTimer = setInterval(tickLiveSync, LIVE_INTERVAL);
}
function stopLiveSync() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
  if (livePokeTimer) clearTimeout(livePokeTimer);
  livePokeTimer = null;
}

/** Pulls fresh data as soon as a live screen opens, instead of next tick. */
function pokeLiveSync() {
  if (livePokeTimer) clearTimeout(livePokeTimer);
  if (!LIVE_SCREENS.includes(activeScreenId())) return;
  livePokeTimer = setTimeout(() => { livePokeTimer = null; tickLiveSync(); }, 250);
}

async function tickLiveSync() {
  if (liveBusy || document.hidden) return;
  const screen = activeScreenId();
  if (!LIVE_SCREENS.includes(screen) || liveFieldFocused()) return;
  liveBusy = true;
  try {
    const data = await api("bootstrap.php");
    const sig = orderSignature(data.orders);
    if (sig === lastOrderSig) return;             // nothing moved — leave the DOM alone
    const before = orders();
    lastOrderSig = sig;
    applyStore(data);
    if (data.sessionExpired) { stopLiveSync(); navigateTo("screen-signin"); return; }
    renderLiveScreen(screen);
    announceOrderChange(before, data.orders || []);
  } catch { /* offline or server busy — retried on the next tick */ }
  finally { liveBusy = false; }
}

function renderLiveScreen(screen) {
  if (screen === "screen-tracking") renderTracking();
  else if (screen === "screen-orders") renderOrders(orderFilter);
  else if (screen === "screen-admin-orders") { renderAdminOrders(); renderAdminDashboard(); }
  else if (screen === "screen-admin-dashboard") renderAdminDashboard();
}

/** Tells the customer their tracked order just moved, using the server's wording. */
function announceOrderChange(before, after) {
  const now = after.find(o => o.id === currentOrderId);
  if (!now) return;
  const was = before.find(o => o.id === now.id);
  if (!was || was.status === now.status) return;
  toast("Order Update", `${now.id} · ${now.statusLabel || now.status}`);
}

/* ---------- toast / modals ---------- */

function toast(title, message) {
  const t = document.getElementById("toast"); t.innerHTML = `<b>${esc(title)}</b><span>${esc(message)}</span>`; t.classList.add("show");
  clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => t.classList.remove("show"), 4200);
}
function showInfo(title, message) { document.getElementById("info-title").textContent = title; document.getElementById("info-body").textContent = message; openModal("modal-info"); }
function openModal(id) { document.getElementById(id)?.classList.add("open"); }
function closeModal(id) { document.getElementById(id)?.classList.remove("open"); }

/* ---------- alert and confirmation dialogs ----------
 * The browser's own alert and confirm panels are drawn by the operating system:
 * they block the page, ignore FOODAY's colours, and on Android look enough like a
 * system warning to be worth avoiding. Everything the app has to say, and every
 * "are you sure?", goes through the app's own sheets instead.
 */

/** The alert sheet: one message and a single Done button. */
function showAlert(message, title = "Please Check") { showInfo(title, message); }

/* A confirmation is asynchronous: confirmDialog() resolves to true or false once
 * the customer taps one of the two buttons, so callers always await it before
 * acting. A second call replaces any still-pending one, which can only happen if
 * a caller forgets its await. */
let confirmAnswer = null;
function confirmDialog({ title = "Please Confirm", message = "", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false } = {}) {
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-text").textContent = message;
  document.getElementById("confirm-cancel").textContent = cancelLabel;
  const ok = document.getElementById("confirm-ok");
  ok.textContent = confirmLabel;
  ok.className = danger ? "btn btn-danger" : "btn btn-primary";
  openModal("modal-confirm");
  return new Promise(resolve => { confirmAnswer = resolve; });
}
function confirmDialogAnswer(answer) {
  closeModal("modal-confirm");
  const resolve = confirmAnswer;
  confirmAnswer = null;
  if (resolve) resolve(answer);
}

function helpCenterText() {
  const c = config();
  const pay = c.gcash_enabled ? "Cash on Delivery or GCash" : "Cash on Delivery (GCash is coming soon)";
  return `Ordering\nAdd foods to your cart, or tap Buy Now on any item to order it straight away. You can follow every order from My Orders → Track Order.\n\nPayment\nWe currently accept ${pay}. Please have the exact amount ready for your rider.\n\nCancelling\nTap Track Order → Cancel Order. You can cancel while the order is still within the cancellation window shown on the order.\n\nContact\n${c.support_email || "support@fooday.com"}${c.support_phone ? ` · ${c.support_phone}` : ""}`;
}

/* ---------- floating cart button (draggable, every customer screen) ---------- */

/** Every signed-in customer screen (bottom nav + floating cart live on these). */
const USER_SCREENS = ["screen-home", "screen-menu", "screen-product", "screen-cart", "screen-checkout", "screen-payment", "screen-confirmation", "screen-orders", "screen-tracking", "screen-profile", "screen-favorites"];

const FAB_POS_KEY = "fooday_fab_pos";
const FAB_HINT_KEY = "fooday_fab_hint_done";
/* Everywhere except My Cart — that screen is where the button leads, and it has
   its own Subtotal/Total/Checkout bar, so a cart button there points at itself. */
const FAB_SCREENS = USER_SCREENS.filter(id => id !== "screen-cart");
let fabDrag = null;        // active pointer gesture
let fabPlaced = false;     // has a position been resolved this session
let fabSuppressClick = false;   // the last gesture was a drag, not a tap
let fabLastTap = 0;              // lets the pointer path and the click agree on one activation
let fabCeilCache = { id: null, top: null };

function fabEl() { return document.getElementById("cart-fab"); }

/** Origin of the frame's padding box: where left:0/top:0 actually sit. */
function fabFrame() {
  const vp = document.querySelector(".app-viewport");
  if (!vp) return null;
  const v = vp.getBoundingClientRect();
  return { vp, ox: v.left + (vp.clientLeft || 0), oy: v.top + (vp.clientTop || 0) };
}

/**
 * Top edge of a bottom action bar inside the active screen (e.g. the cart's
 * Subtotal/Total/Checkout bar, which sits just above the nav rather than flush
 * with the frame). Cached per screen because it is read on every drag frame.
 */
function fabBottomBarTop() {
  const screen = document.querySelector(".screen.active");
  const id = screen ? screen.id : null;
  if (fabCeilCache.id === id) return fabCeilCache.top;
  let top = null;
  if (screen) {
    const f = fabFrame();
    const mid = f.oy + f.vp.clientHeight * 0.5;
    for (const el of screen.children) {
      const cs = getComputedStyle(el);
      if (cs.position !== "absolute" && cs.position !== "fixed") continue;
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (!r.height) continue;
      if (r.top < mid) continue;                        // only bars hugging the lower half
      if (top === null || r.top < top) top = r.top;
    }
  }
  fabCeilCache = { id, top };
  return top;
}

/** Usable area for the tab, in padding-box coordinates, kept clear of overlays. */
function fabBounds() {
  const fab = fabEl(), f = fabFrame();
  if (!fab || !f) return null;
  const w = fab.offsetWidth || 46, h = fab.offsetHeight || 64;
  const pad = 10, navGap = 12;
  const minX = pad, maxX = Math.max(pad, f.vp.clientWidth - w - pad);
  const minY = pad;
  let maxY = Math.max(pad, f.vp.clientHeight - h - pad);
  const nav = document.getElementById("bottom-nav");
  if (nav && getComputedStyle(nav).display !== "none" && nav.offsetHeight) {
    maxY = Math.min(maxY, (nav.getBoundingClientRect().top - f.oy) - h - navGap);
  }
  const barTop = fabBottomBarTop();                     // e.g. the cart screen's Checkout bar
  if (barTop != null) maxY = Math.min(maxY, (barTop - f.oy) - h - navGap);
  if (maxY < minY) maxY = minY;
  return { minX, maxX, minY, maxY, w, h, vw: f.vp.clientWidth };
}

/** Horizontal resting spot of a docked tab: flush against the frame edge. */
function fabEdgeX(edge, b) {
  return edge === "left" ? 0 : b.vw - b.w;
}

/**
 * Places the tab in padding-box coordinates. Passing an edge docks it flush to
 * that side; omitting one keeps it free-floating (clamped inside the frame).
 */
function fabPlace(x, y, save, edge) {
  const b = fabBounds(); if (!b) return;
  const fab = fabEl();
  const dockX = edge ? fabEdgeX(edge, b) : null;
  const lo = dockX === null ? b.minX : dockX;
  const hi = dockX === null ? b.maxX : dockX;
  const left = Math.min(Math.max(dockX === null ? x : dockX, lo), hi);
  const top = Math.min(Math.max(y, b.minY), b.maxY);
  fab.style.left = left + "px";
  fab.style.top = top + "px";
  if (edge) fab.dataset.edge = edge;
  if (save) setLocal(FAB_POS_KEY, edge ? { edge, y: Math.round(top) } : { x: Math.round(left), y: Math.round(top) });
}

/** Docks the tab to whichever vertical edge is nearer, keeping its height. */
function fabSnap(save) {
  const fab = fabEl(), b = fabBounds(); if (!fab || !b) return;
  const left = parseFloat(fab.style.left) || 0;
  const edge = left <= (b.maxX - left) ? "left" : "right";
  fabPlace(left, parseFloat(fab.style.top) || 0, save, edge);
}

function fabApply() {
  const fab = fabEl(), b = fabBounds(); if (!fab || !b) return;
  const saved = getLocal(FAB_POS_KEY, null);
  const edge = (saved && (saved.edge === "left" || saved.edge === "right")) ? saved.edge : "right";
  const y = (saved && Number.isFinite(saved.y)) ? saved.y : b.maxY;
  fabPlace(0, y, false, edge);
  fabPlaced = true;
  if (getLocal(FAB_HINT_KEY, "") !== "1") fab.classList.add("hint");
}

/** Keeps the tab visible and correctly docked whenever the screen changes. */
function fabSyncScreen(id) {
  const fab = fabEl(); if (!fab) return;
  fabCeilCache = { id: null, top: null };        // ceiling differs per screen
  const show = FAB_SCREENS.includes(id);
  fab.classList.toggle("show", show);
  if (!show) return;
  if (!fabPlaced || fab.style.left === "") { requestAnimationFrame(fabApply); return; }
  const b = fabBounds(); if (!b) return;
  const edge = fab.dataset.edge === "left" ? "left" : "right";
  fabPlace(0, parseFloat(fab.style.top) || 0, false, edge);   // re-clamp above this screen's bar
}

function bumpFabBadge() {
  const b = fabEl()?.querySelector(".cart-fab-badge");
  if (!b) return;
  b.classList.remove("bump");
  void b.offsetWidth;          // restart the animation
  b.classList.add("bump");
}

function cartFabDown(e) {
  const fab = fabEl(), f = fabFrame(); if (!fab || !f) return;
  if (e.button != null && e.button !== 0) return;
  fabSuppressClick = false;
  fabDrag = {
    id: e.pointerId,
    grabX: e.clientX - f.ox - fab.offsetLeft,      // offset from the tab's own top-left
    grabY: e.clientY - f.oy - fab.offsetTop,
    startX: e.clientX, startY: e.clientY, moved: false
  };
  try { fab.setPointerCapture(e.pointerId); } catch (_) {}
  fab.classList.add("dragging");
  fab.dataset.edge = "free";
}

function cartFabMove(e) {
  if (!fabDrag || e.pointerId !== fabDrag.id) return;
  const dx = e.clientX - fabDrag.startX, dy = e.clientY - fabDrag.startY;
  if (!fabDrag.moved && Math.hypot(dx, dy) < 5) return;   // ignore micro jitter
  fabDrag.moved = true;
  const f = fabFrame();
  fabPlace(e.clientX - f.ox - fabDrag.grabX, e.clientY - f.oy - fabDrag.grabY, false);
  if (e.cancelable) e.preventDefault();
}

function cartFabUp(e) {
  if (!fabDrag || (e && e.pointerId !== fabDrag.id)) return;
  const fab = fabEl();
  const moved = fabDrag.moved;
  fabDrag = null;
  if (fab) {
    fab.classList.remove("dragging");
    if (e && e.pointerId != null) { try { fab.releasePointerCapture(e.pointerId); } catch (_) {} }
  }
  if (!moved) {                       // a tap: open the cart straight from the pointer
    fabSuppressClick = false;
    if (e && e.cancelable) e.preventDefault();
    cartFabActivate(e);
    return;
  }
  fabSuppressClick = true;            // a drag must not open the cart
  if (fab) {
    fabSnap(true);
    fab.classList.remove("hint");
    setLocal(FAB_HINT_KEY, "1");
  }
}

function cartFabActivate(e) {
  if (e) e.stopPropagation();
  if (fabSuppressClick) { fabSuppressClick = false; return; }
  if (Date.now() - fabLastTap < 700) return;      // the pointer path already opened the cart
  fabLastTap = Date.now();
  navigateTo("screen-cart");
}

function cartFabInit() {
  const fab = fabEl(); if (!fab) return;
  fab.addEventListener("pointerdown", cartFabDown);
  fab.addEventListener("pointermove", cartFabMove);
  fab.addEventListener("pointerup", cartFabUp);
  fab.addEventListener("pointercancel", cartFabUp);
  // Belt and braces: the tab's own visibility must never be left to an animation.
  fab.addEventListener("animationend", (e) => {
    if (e.target === fab) fab.classList.remove("hint");
  });
  window.addEventListener("resize", () => {
    if (!fabPlaced) return;
    const fab2 = fabEl(), b = fabBounds();
    if (!fab2 || !b) return;
    const edge = fab2.dataset.edge === "left" ? "left" : "right";
    fabPlace(0, parseFloat(fab2.style.top) || 0, false, edge);
  });
}

/* ---------- navigation ---------- */

function navigateTo(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  const screen = document.getElementById(id); if (!screen) return;
  screen.classList.add("active"); screen.scrollTop = 0;
  document.getElementById("bottom-nav").style.display = USER_SCREENS.includes(id) ? "flex" : "none";
  document.querySelectorAll("#bottom-nav button").forEach(b => b.classList.toggle("active", b.dataset.screen === id));
  fabSyncScreen(id);
  if (id === "screen-signin") clearLoginError();
  if (id === "screen-home") renderHome();
  if (id === "screen-menu") renderMenu();
  if (id === "screen-cart") renderCart();
  if (id === "screen-checkout") prefillCheckout();
  if (id === "screen-payment") renderPayment();
  if (id === "screen-orders") renderOrders("All");
  if (id === "screen-tracking") renderTracking();
  if (id === "screen-profile") renderProfile();
  if (id === "screen-favorites") renderFavorites();
  if (id === "screen-admin-dashboard") renderAdminDashboard();
  if (id === "screen-admin-products") renderAdminProducts();
  if (id === "screen-admin-orders") renderAdminOrders();
  if (id === "screen-admin-categories") renderAdminCategories();
  if (id === "screen-admin-delivery") renderDeliveryAreas();
  if (id === "screen-admin-announcements") renderAnnouncements();
  if (id === "screen-admin-settings") renderAdminSettings();
  // The Security sheet's two-factor line is refreshed when the sheet opens, so
  // there is nothing to keep honest while merely walking the menus.
  pokeLiveSync();
}

/* ---------- admin menu drawer ---------- */

function toggleAdminDrawer(open) {
  const drawer = document.getElementById("admin-drawer");
  if (!drawer) return;
  if (open) syncAdminDrawer();
  drawer.classList.toggle("open", !!open);
  drawer.setAttribute("aria-hidden", open ? "false" : "true");
  // Every admin screen has its own menu button, so keep them all in step rather
  // than only the first one in the document.
  document.querySelectorAll(".hamburger-btn").forEach(b => b.setAttribute("aria-expanded", open ? "true" : "false"));
}
function syncAdminDrawer() {
  const name = document.getElementById("drawer-name");
  const avatar = document.getElementById("drawer-avatar");
  const who = (admin() && admin().name) || "Admin";
  if (name) name.textContent = who;
  if (avatar) avatar.textContent = (who.trim()[0] || "A");
}
/** Drawer navigation: close first so the screen change is visible, then go. */
function adminGo(screen) {
  toggleAdminDrawer(false);
  if (screen === "__logout__") { adminLogout(); return; }
  // Choosing Orders from the menu opens the whole list, not whichever order was
  // last being managed.
  if (screen === "screen-admin-orders") focusedOrder = null;
  navigateTo(screen);
}

/* ---------- security: the password and two-factor, in one sheet ---------- */

/* "user" or "admin": the Security sheet is the same sheet for both, so it has to
   know whose password and whose two-factor it is offering. */
let securityWho = "user";

/**
 * One way in to both account protections.
 *
 * Change password and two-factor used to sit apart in the menu as if they were
 * unrelated settings. They are the same question — how this account is locked —
 * so choosing Security now opens both, and the sheets they lead to open on top
 * of this one, which is what closing them comes back to.
 */
function openSecurityModal(who) {
  securityWho = who;
  const intro = document.getElementById("security-intro");
  if (intro) {
    intro.textContent = who === "admin"
      ? "Protect the admin account with a password and a second step at sign-in."
      : "Protect your account with a password and a second step at sign-in.";
  }
  const passSummary = document.getElementById("security-pass-summary");
  if (passSummary) passSummary.textContent = who === "admin"
    ? "Also signs out every other device"
    : "Also signs out your other devices";
  mfaRefreshSummaries();
  openModal("modal-security");
}

/** The password sheets are per-account, so pick the one that matches. */
function securityOpenPassword() {
  if (securityWho === "admin") openAdminPasswordModal(); else openPasswordChange();
}

function securityOpenMfa() { openMfaModal(securityWho); }

/* ---------- two-factor authentication ---------- */

/**
 * One modal drives every MFA state, so sign-in, enrollment and settings can
 * never drift apart. `mfaWho` is "admin" or "user"; `mfaState` is the current
 * view. Rendering is always done from a value we hold, never from the DOM.
 */
let mfaWho = "user", mfaState = "status", mfaRecovery = null, mfaLogin = null, mfaReauth = false;

function mfaApi(who) { return who === "admin" ? "admin.php" : "account.php"; }
function mfaIsAdmin(who) { return who === "admin"; }

function mfaTitle() {
  if (mfaState === "login") return "Verify it's you";
  if (mfaState === "setup") return mfaWho === "admin" ? "Confirm your code" : "Confirm your code";
  if (mfaState === "codes") return "Save your recovery codes";
  if (mfaState === "disable") return "Turn off two-factor";
  return "Two-Factor Authentication";
}

function mfaBack() {
  if (mfaState === "login") { closeModal("modal-mfa"); mfaLogin = null; return; }
  if (mfaState === "setup" || mfaState === "codes" || mfaState === "disable") { mfaState = "status"; openMfaModal(mfaWho); return; }
  closeModal("modal-mfa");
}

function mfaMaskedEmail(s) { return (s && s.masked_email) || "your email address"; }

function mfaStatusView(s) {
  const on = !!s.enabled;
  const mailOk = !!s.mail_ready;
  const blocks = [];
  blocks.push(`<div class="mfa-state ${on ? "on" : ""}">
    <span class="mfa-state-dot">${on ? "🛡" : "🔓"}</span>
    <span><b>${on ? "Two-factor is on" : "Two-factor is off"}</b>
    <small>${on
      ? `A one-time code is emailed to ${esc(mfaMaskedEmail(s))} every time you sign in.`
      : `Add a one-time code emailed to ${esc(mfaMaskedEmail(s))} every time you sign in.`}</small></span>
  </div>`);

  if (on) {
    blocks.push(`<p class="mfa-hint">Recovery codes left: <b>${Number(s.recovery_left || 0)}</b>. Each one signs you in once if your email is unreachable.</p>`);
    blocks.push(`<button class="btn btn-ghost" onclick="mfaGo('disable')">Turn Off Two-Factor</button>`);
  } else {
    blocks.push(`<button class="btn btn-primary" onclick="mfaStartEnable()">Turn On Two-Factor</button>`);
    if (!mailOk) {
      blocks.push(`<p class="mfa-hint warn">⚠ ${esc(s.mail_problem || "Email delivery is not set up yet, so codes could not be sent.")}</p>`);
    }
  }
  return blocks.join("");
}

function mfaSetupView(s) {
  return `<p>Enter the 6-digit code we emailed to <b>${esc(mfaMaskedEmail(s))}</b> to finish turning on two-factor.</p>
    <div class="form-stack"><label>Verification code</label>
      <input id="mfa-setup-code" class="input mfa-code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000000">
    </div>
    <button class="btn btn-primary" onclick="mfaConfirmEnable()">Confirm and Turn On</button>
    <p class="mfa-pending-note">Wrong code? <button onclick="mfaStartEnable()">Send a new one</button></p>`;
}

function mfaCodesView(codes) {
  return `<p><b>Save these ${codes.length} recovery codes somewhere safe.</b> Each one works once, if you ever cannot receive the email. They are the only way back in.</p>
    <div class="mfa-codes">${codes.map(c => `<span>${esc(c)}</span>`).join("")}</div>
    <p class="mfa-hint warn">This is the only time these are shown. Screenshot them now.</p>
    <button class="btn btn-primary" onclick="mfaFinishCodes()">I have saved them</button>`;
}

function mfaDisableView() {
  return `<p>Turning this off removes the emailed code at sign-in. Your password still protects the account.</p>
    <div class="form-stack"><label>Your password</label>
      <input id="mfa-disable-pass" class="input" type="password" autocomplete="current-password" placeholder="Enter your password">
    </div>
    <button class="btn btn-danger" onclick="mfaConfirmDisable()">Turn Off Two-Factor</button>`;
}

function mfaLoginView(d) {
  const undelivered = d.mail_sent === false;
  return `<p>${undelivered
      ? `We could not send the code just now (${esc(d.mail_problem || "email is unavailable")}). You can retry, or use a recovery code.`
      : `We emailed a 6-digit code to <b>${esc(mfaMaskedEmail(d))}</b>. Enter it to finish signing in.`}</p>
    <div class="form-stack"><label>Verification code</label>
      <input id="mfa-login-code" class="input mfa-code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000000">
    </div>
    <button class="btn btn-primary" onclick="mfaSubmitLogin()">Verify and Sign In</button>
    <p class="mfa-pending-note"><button onclick="mfaResend()">Send a new code</button> · <button onclick="mfaToggleRecovery()">Use a recovery code</button></p>
    <div class="form-stack" id="mfa-recovery-wrap" style="display:none;margin-top:11px"><label>Recovery code</label>
      <input id="mfa-login-recovery" class="input" placeholder="XXXX-XXXX-XXXX" autocapitalize="characters">
    </div>`;
}

/** The two inputs are alternatives, so clear one whenever the other is used. */
function mfaToggleRecovery() {
  const wrap = document.getElementById("mfa-recovery-wrap");
  if (!wrap) return;
  const showing = wrap.style.display !== "none";
  wrap.style.display = showing ? "none" : "block";
  if (showing) {
    document.getElementById("mfa-login-code")?.focus();
  } else {
    document.getElementById("mfa-login-recovery")?.focus();
  }
}

function mfaRender() {
  const body = document.getElementById("mfa-body");
  if (!body) return;
  document.getElementById("mfa-title").textContent = mfaTitle();
  const view = mfaLogin ? "login" : mfaState;
  if (view === "login") body.innerHTML = mfaLoginView(mfaLogin);
  else if (view === "setup") body.innerHTML = mfaSetupView(mfaLogin || {});
  else if (view === "codes") body.innerHTML = mfaCodesView(mfaRecovery || []);
  else if (view === "disable") body.innerHTML = mfaDisableView();
  else body.innerHTML = mfaStatusView(mfaLogin || { enabled: false });
}

async function mfaLoadStatus(who) {
  try {
    const res = await api(mfaApi(who), { action: "mfa_status" });
    mfaLogin = res.mfa;
    mfaRender();
    return res.mfa;
  } catch (e) { reportError(e); return null; }
}

async function openMfaModal(who) {
  mfaWho = who; mfaState = "status"; mfaLogin = null; mfaRecovery = null;
  mfaRender();
  openModal("modal-mfa");
  await mfaLoadStatus(who);
  mfaRefreshSummaries();
}

function mfaGo(state) { mfaState = state; mfaRender(); }

/** The two-factor line on the Security sheet, kept in step with the account. */
async function mfaRefreshSummaries() {
  const el = document.getElementById("security-mfa-summary");
  if (!el) return;
  try {
    const res = await api(mfaApi(securityWho), { action: "mfa_status" });
    const s = res.mfa || {};
    el.textContent = s.enabled
      ? `On · codes emailed to ${s.masked_email || "you"}`
      : (s.mail_ready ? "Off · add a code at every sign-in" : "Off · email not set up yet");
  } catch { el.textContent = "Unavailable"; }
}

async function mfaStartEnable() {
  try {
    const res = await api(mfaApi(mfaWho), { action: "mfa_start" });
    mfaLogin = res.mfa;
    mfaState = "setup";
    mfaRender();
  } catch (e) { reportError(e); }
}

async function mfaConfirmEnable() {
  const code = (document.getElementById("mfa-setup-code")?.value || "").replace(/\s+/g, "");
  if (!code) { showAlert("Enter the code from your email.", "Verification Code"); return; }
  try {
    const res = await api(mfaApi(mfaWho), { action: "mfa_confirm", code });
    mfaRecovery = res.recovery_codes || [];
    // Turning MFA on ends every session including this one, so the user has to
    // sign in again. Say that now, while the recovery codes are still on screen.
    mfaReauth = !!res.reauth_required;
    mfaState = "codes";
    mfaRender();
    toast("Two-Factor On", "Your account now needs a code at every sign-in.");
  } catch (e) { reportError(e); }
}

function mfaFinishCodes() {
  const mustReauth = mfaReauth;
  mfaRecovery = null; mfaReauth = false; mfaState = "status";
  if (mustReauth) {
    closeModal("modal-mfa");
    showInfo("Two-Factor Is On", "For your security, every session was signed out when two-factor was turned on — including this one. Sign in with your password and the new emailed code.");
    if (mfaIsAdmin(mfaWho)) { adminLogout(); } else { logoutUser(); }
    return;
  }
  mfaLoadStatus(mfaWho);
  toast("Recovery codes saved", "Keep them somewhere safe.");
}

async function mfaConfirmDisable() {
  const pass = document.getElementById("mfa-disable-pass")?.value || "";
  if (!pass) { showAlert("Enter your password to turn two-factor off.", "Two-Factor"); return; }
  try {
    await api(mfaApi(mfaWho), { action: "mfa_disable", password: pass });
    mfaState = "status";
    await mfaLoadStatus(mfaWho);
    mfaRefreshSummaries();
    toast("Two-Factor Off", "Sign-in now needs only your password.");
  } catch (e) { reportError(e); }
}

/* ---------- emailed code for sensitive account changes ---------- */

/*
 * Changing the email an account signs in with, or its password, always needs a
 * one-time code emailed to the address on file — whether or not two-factor is
 * on. The forms themselves stay small: they collect the change, then hand it to
 * this one sheet, which emails the code and only runs the change once the code
 * is confirmed. A wrong code keeps the sheet open so it can be retried without
 * re-entering the form.
 */
let changeCodeWho = "user", changeCodePurpose = "", changeCodeRun = null;

function changeCodeApi(who) { return who === "admin" ? "admin.php" : "account.php"; }

function changeCodeText(maskedTo) {
  const el = document.getElementById("change-code-text");
  if (el) el.innerHTML = `We emailed a 6-digit code to <b>${esc(maskedTo)}</b>. Enter it to confirm the change.`;
}

/** Asks the server to email a code, then opens the sheet that consumes it. */
async function beginChangeCode(who, purpose, run) {
  try {
    const res = await api(changeCodeApi(who), { action: "request_change_code", purpose });
    changeCodeWho = who;
    changeCodePurpose = purpose;
    changeCodeRun = run;
    document.getElementById("change-code-title").textContent =
      purpose === "email" ? "Confirm Email Change" : "Confirm Password Change";
    changeCodeText((res.change && res.change.sent_to) || "your email address");
    document.getElementById("change-code-input").value = "";
    document.getElementById("change-code-hint").textContent = "";
    openModal("modal-change-code");
    document.getElementById("change-code-input")?.focus();
  } catch (e) { reportError(e); }
}

async function submitChangeCode() {
  const code = (document.getElementById("change-code-input")?.value || "").replace(/\s+/g, "");
  if (!code) { showAlert("Enter the code from your email.", "Verification Code"); return; }
  if (!changeCodeRun) return;
  try {
    await changeCodeRun(code);       // throws when the code or the change is rejected
    closeModal("modal-change-code");
    changeCodeRun = null;
  } catch (e) { reportError(e); }
}

async function resendChangeCode() {
  try {
    const res = await api(changeCodeApi(changeCodeWho), { action: "request_change_code", purpose: changeCodePurpose });
    changeCodeText((res.change && res.change.sent_to) || "your email address");
    document.getElementById("change-code-hint").textContent = "A new code is on its way.";
  } catch (e) { reportError(e); }
}

/* ---------- GPS address pinning ---------- */

/**
 * A customer can always type an address, and can also drop a pin on where they
 * are right now. One routine serves all three places that offer it — sign-up,
 * checkout and Settings > Addresses — so each target only names the fields it
 * fills and nothing here has to know which screen it is running on.
 *
 * The browser's own permission prompt only ever appears after the customer has
 * agreed on our own sheet first, so nothing is requested behind their back.
 */
const PIN_TARGETS = {
  signup:   { address: "signup-address",   landmark: null,               button: "signup-gps-btn",   card: "signup-pin" },
  checkout: { address: "checkout-address", landmark: "checkout-landmark", button: "checkout-gps-btn", card: "checkout-pin", area: true },
  saved:    { address: "new-address",      landmark: "new-landmark",     button: "address-gps-btn",   card: "address-pin" }
};
/* The pin each form is holding, so a re-pin can tell its own text apart from
   something the customer typed. */
const PINS = {};
const GEOCODE_TIMEOUT = 6000;
let pinTarget = null;   // the target waiting on the permission sheet
let pinBusy = false;

function pin(key) { return PINS[key] || null; }

/** Asks first, then reads the position. Everything that can refuse happens here. */
async function requestPin(key) {
  if (pinBusy || !PIN_TARGETS[key]) return;

  if (!navigator.geolocation) {
    showInfo("Location Unavailable", "This browser cannot share your location. Please type your address instead — everything else on this form works the same way.");
    return;
  }
  // A phone on plain http (or a file opened off disk) is not a secure context,
  // so the browser would refuse silently. Say so instead of failing oddly.
  if (window.isSecureContext === false) {
    showInfo("Location Needs a Secure Connection", "Your phone only shares its location over a secure (https) address or on localhost. Open FOODAY the way you normally do, or type your address for now.");
    return;
  }

  // Once a browser has been told "no" it will not prompt again, so check first
  // and explain how to change it rather than showing a prompt that cannot work.
  if (navigator.permissions && navigator.permissions.query) {
    try {
      const state = await navigator.permissions.query({ name: "geolocation" });
      if (state.state === "denied") {
        showInfo("Location Is Turned Off", "Location access is blocked for FOODAY on this device. Open your browser settings, allow location for this site, then tap Use my current location again. You can also just type your address.");
        return;
      }
    } catch { /* not every browser answers this query; carry on and let it prompt */ }
  }

  pinTarget = key;
  openModal("modal-location");
}

/** "Allow Location" on our sheet. The browser prompt is the next thing to happen. */
function allowPin() {
  const key = pinTarget;
  pinTarget = null;
  closeModal("modal-location");
  if (key) locatePin(key);
}

function locatePin(key) {
  pinBusy = true;
  setPinBusy(key, true);
  navigator.geolocation.getCurrentPosition(
    pos => { pinBusy = false; setPinBusy(key, false); pinLocated(key, pos); },
    err => { pinBusy = false; setPinBusy(key, false); pinFailed(err); },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 }
  );
}

async function pinLocated(key, pos) {
  const target = PIN_TARGETS[key];
  const lat = Number(pos.coords.latitude);
  const lng = Number(pos.coords.longitude);

  // Null Island is what a broken fix looks like, not a real delivery address.
  if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) {
    pinFailed({ code: 2 });
    return;
  }

  const previous = pin(key);
  PINS[key] = { lat, lng, accuracy: Number(pos.coords.accuracy) || 0, place: "", text: "", resolving: true };
  renderPin(key);

  const place = await reverseGeocode(lat, lng);
  const current = pin(key);
  if (!current || current.lat !== lat || current.lng !== lng) return;  // cleared or re-pinned while looking up

  current.place  = place;
  current.resolving = false;
  current.text   = place || pinnedText(lat, lng);

  const field = document.getElementById(target.address);
  const typed = (field.value || "").trim();
  // Never silently throw away something the customer wrote. Declining the
  // replace drops the pin too, so a pin can never point somewhere else.
  if (typed && typed !== (previous ? previous.text : "") && !(await confirmDialog({
    title: "Replace Your Address?",
    message: "Use your pinned location instead of the address you typed?",
    confirmLabel: "Use Pin",
    cancelLabel: "Keep My Text",
    danger: true,
  }))) {
    clearPin(key, "Your typed address was kept, and the pin was removed.");
    return;
  }
  if (field) field.value = current.text;

  // Only ever fills a blank landmark: a landmark the customer wrote is still true.
  if (target.landmark && !place) {
    const landmark = document.getElementById(target.landmark);
    if (landmark && !landmark.value.trim()) landmark.value = "My pinned location";
  }
  if (target.area) suggestArea(place);

  renderPin(key);
  toast("Location Pinned", place ? "Your address was filled in from your current location." : "Pinned. Add a landmark so the rider can find you.");
}

function pinFailed(err) {
  if (err && err.code === 1) {
    showInfo("Location Permission Denied", "You said no to location access, so nothing was pinned. You can allow it again in your browser settings for this site, or just type your address below.");
  } else if (err && err.code === 3) {
    showInfo("Location Timed Out", "Finding your location took too long. Please try again, or type your address — both work.");
  } else {
    showInfo("Location Unavailable", "Your phone could not work out where you are. Check that location services are switched on (and GPS too if you are indoors), then try again — or type your address.");
  }
}

/** Removes the pin, and the text it filled in, leaving a clean typed field. */
function clearPin(key, message) {
  const field = document.getElementById(PIN_TARGETS[key].address);
  const held = pin(key);
  if (field && held && (field.value || "").trim() === held.text) field.value = "";
  delete PINS[key];
  renderPin(key);
  if (message) toast("Pin Removed", message);
}

function setPinBusy(key, busy) {
  const btn = document.getElementById(PIN_TARGETS[key].button);
  if (!btn) return;
  btn.disabled = !!busy;
  btn.classList.toggle("locating", !!busy);
  btn.setAttribute("aria-busy", busy ? "true" : "false");
  const label = btn.querySelector("span");
  if (label) label.textContent = busy ? "Finding your location…" : "Use my current location";
}

function renderPin(key) {
  const target = PIN_TARGETS[key];
  const card = document.getElementById(target.card);
  const held = pin(key);
  if (!card) return;
  if (!held) { card.hidden = true; card.innerHTML = ""; return; }

  card.hidden = false;
  card.innerHTML = `
    <div class="pin-top"><span class="pin-badge">📍 Pinned here</span><small>${held.accuracy ? `accurate to about ${Math.round(held.accuracy)} m` : "accuracy unknown"}</small></div>
    <p class="pin-place">${held.resolving ? "Looking up this address…" : esc(held.place || "We could not look up a street name here — add a landmark so the rider can find you.")}</p>
    <div class="pin-foot">
      <span>${held.lat.toFixed(5)}, ${held.lng.toFixed(5)}</span>
      <div><button type="button" onclick="clearPin('${jsq(key)}')">Remove</button><button type="button" onclick="requestPin('${jsq(key)}')">Re-pin</button></div>
    </div>`;
}

/** What the address field says when there is no street name to be found. */
function pinnedText(lat, lng) {
  return `Pinned location (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
}

/**
 * Turns a pin into something a rider can read. OpenStreetMap's reverse lookup
 * is used because it needs no key; when it is slow or unreachable the pin is
 * still kept and the customer is asked for a landmark instead.
 */
async function reverseGeocode(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=en&lat=${lat}&lon=${lng}`;
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), GEOCODE_TIMEOUT);
  try {
    const res = await fetch(url, { signal: control.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return "";
    const data = await res.json();
    return String(data.display_name || "")
      .replace(/,\s*Philippines\s*$/i, "")
      .replace(/\s+/g, " ")
      .replace(/,\s*,/g, ",")
      .trim();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** Preselects the delivery area the pin fell in, if it is unambiguous. */
function suggestArea(place) {
  if (!place) return;
  const select = document.getElementById("checkout-area");
  if (!select || select.value) return;
  const haystack = place.toLowerCase();
  const match = areas().find(a => {
    const name = String(a.name || "").trim().toLowerCase();
    return name.length > 2 && haystack.includes(name);
  });
  if (match) select.value = match.name;
}

/* ---------- auth ---------- */

async function handleSignUp() {
  const name = document.getElementById("signup-name").value.trim();
  const email = document.getElementById("signup-email").value.trim().toLowerCase();
  const phone = document.getElementById("signup-phone").value.trim();
  const pass = document.getElementById("signup-pass").value;
  const confirm = document.getElementById("signup-confirm").value;
  const address = document.getElementById("signup-address").value.trim();
  const pinned = pin("signup");

  if (!name || !email || !phone || !pass || !confirm) { showAlert("Please complete all required fields.", "Create Account"); return; }
  if (!validName(name)) { showAlert("Please enter a valid full name."); return; }
  if (!validEmail(email)) { showAlert("Please enter a valid email address."); return; }
  if (!validPhone(phone)) { showAlert("Please enter a valid 11-digit Philippine mobile number."); return; }
  if (pass !== confirm) { showAlert("Passwords do not match."); return; }
  const weak = passwordProblem(pass); if (weak) { showAlert(weak); return; }
  if (!address) { showAlert("Please enter your delivery address, or pin your current location."); return; }
  if (!document.getElementById("terms-check").checked) { showAlert("Please agree to the Terms & Conditions and Privacy Policy."); return; }

  try {
    // The address goes in with the account and becomes the customer's default,
    // so checkout starts from it without asking again.
    await api("auth.php", {
      action: "signup", name, email, phone, password: pass, address,
      lat: pinned ? pinned.lat : null,
      lng: pinned ? pinned.lng : null
    });
    await refreshStore();
    document.getElementById("signup-pass").value = ""; document.getElementById("signup-confirm").value = "";
    document.getElementById("signup-address").value = "";
    delete PINS.signup; renderPin("signup");
    updatePasswordHint("signup-pass", "signup-hint");
    toast("Account Created", `Good to see you, ${user().name}!`);
    navigateTo("screen-home");
  } catch (e) { reportError(e); }
}

/* The sign-in form reports its own problems under its fields rather than in a
 * sheet: a wrong email or password is about those two boxes, and a sheet hides
 * them. Everything the server can say about this form comes back as a 400. */
function showLoginError(message) {
  const el = document.getElementById("login-error");
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("show", !!message);
}
function clearLoginError() { showLoginError(""); }

async function handleSignIn() {
  const email = document.getElementById("login-email").value.trim().toLowerCase();
  const pass = document.getElementById("login-pass").value;
  clearLoginError();
  if (!email || !pass) { showLoginError("Please enter your email and password."); return; }
  if (!validEmail(email)) { showLoginError("Please enter a valid email address."); return; }

  try {
    const res = await api("auth.php", { action: "signin", email, password: pass });

    // Password is correct but the account also needs an emailed code. The server
    // has NOT signed anyone in yet, so show the challenge instead of navigating.
    if (res.mfa_required) {
      document.getElementById("login-pass").value = "";
      mfaWho = res.admin ? "admin" : "user";
      mfaLogin = res.mfa;
      mfaState = "status";
      mfaRender();
      openModal("modal-mfa");
      return;
    }

    await mfaFinishSignIn(res);
  } catch (e) {
    // A 400 is the server rejecting this form (wrong email or password). Any
    // other failure — a dead server, an expired session — is not about these
    // fields, so it keeps the normal sheet.
    if (e && e.status === 400) { showLoginError(e.message); return; }
    reportError(e);
  }
}

async function mfaSubmitLogin() {
  const code = (document.getElementById("mfa-login-code")?.value || "").replace(/\s+/g, "");
  const recovery = (document.getElementById("mfa-login-recovery")?.value || "").trim().toUpperCase();
  if (!code && !recovery) { showAlert("Enter the code from your email, or a recovery code."); return; }
  try {
    // Send only the field the user actually filled, so an empty code can never
    // shadow a valid recovery code.
    const payload = recovery ? { recovery_code: recovery } : { code };
    const res = await api("auth.php", { action: "mfa_verify", ...payload });
    closeModal("modal-mfa");
    mfaLogin = null;
    await mfaFinishSignIn(res, recovery && !code);
  } catch (e) { reportError(e); }
}

async function mfaResend() {
  try {
    await api("auth.php", { action: "mfa_resend" });
    const input = document.getElementById("mfa-login-code");
    if (input) input.value = "";
    toast("Code Sent", "Check your email for a fresh code.");
  } catch (e) { reportError(e); }
}

async function mfaFinishSignIn(res, viaRecovery) {
  await refreshStore();
  document.getElementById("login-pass").value = "";
  if (res.admin) {
    toast("Admin Access", `Signed in as ${admin().name || "admin"}.${viaRecovery ? " Signed in with a recovery code." : ""}`);
    navigateTo("screen-admin-dashboard");
    return;
  }
  toast("Signed In", `Good to see you, ${user().name}.${viaRecovery ? " Signed in with a recovery code." : ""}`);
  navigateTo("screen-home");
}

function openPasswordReset() {
  document.getElementById("reset-email").value = document.getElementById("login-email").value.trim();
  document.getElementById("reset-phone").value = "";
  document.getElementById("reset-pass").value = "";
  updatePasswordHint("reset-pass", "reset-hint");
  openModal("modal-reset");
}
async function submitPasswordReset() {
  const email = document.getElementById("reset-email").value.trim().toLowerCase();
  const phone = document.getElementById("reset-phone").value.trim();
  const pass = document.getElementById("reset-pass").value;
  if (!validEmail(email)) { showAlert("Please enter a valid email address."); return; }
  if (!validPhone(phone)) { showAlert("Please enter a valid 11-digit Philippine mobile number."); return; }
  const weak = passwordProblem(pass); if (weak) { showAlert(weak); return; }
  try {
    await api("auth.php", { action: "reset_password", email, phone, password: pass });
    closeModal("modal-reset");
    document.getElementById("login-email").value = email;
    document.getElementById("login-pass").value = "";
    toast("Password Reset", "Your password was updated. You can sign in now.");
  } catch (e) { reportError(e); }
}

async function logoutUser() {
  try { await api("auth.php", { action: "logout" }); } catch (e) { /* ignore */ }
  await refreshStore();
  navigateTo("screen-signin");
  toast("Signed Out", "You have been signed out.");
}

async function adminLogout() {
  try { await api("auth.php", { action: "admin_logout" }); } catch (e) { /* ignore */ }
  await refreshStore();
  navigateTo("screen-signin");
  toast("Admin Logout", "Admin session ended.");
}

/* ---------- password strength ---------- */

function passwordMinLength() { return Number(config().pw_min_length || 6); }
/* Letters and numbers are required of every password, always. Mirrors
   password_problem() on the server, so the form says it before the round trip. */
function passwordProblem(v) {
  if (v.length < passwordMinLength()) return `Password must be at least ${passwordMinLength()} characters.`;
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return "Password must contain both letters and numbers.";
  if (/^(123456|password|admin123|fooday123)$/i.test(v)) return "That password is too common. Please choose another one.";
  return null;
}
function passwordScore(v) {
  let s = 0;
  if (v.length >= 8) s++;
  if (v.length >= 12) s++;
  if (/[A-Za-z]/.test(v) && /\d/.test(v)) s++;
  if (/[^A-Za-z0-9]/.test(v)) s++;
  return s;
}
function updatePasswordHint(inputId, hintId) {
  const input = document.getElementById(inputId), hint = document.getElementById(hintId);
  if (!input || !hint) return;
  const v = input.value;
  if (!v) { hint.innerHTML = ""; hint.className = "pw-hint"; return; }
  const s = passwordScore(v);
  const labels = ["Very weak", "Weak", "Fair", "Good", "Strong"];
  hint.className = `pw-hint w${s}`;
  hint.innerHTML = `<div class="pw-bar"><i style="width:${(s + 1) * 20}%"></i></div><span>${labels[s]}</span>`;
}
function renderPasswordRules(elId) {
  const el = document.getElementById(elId); if (!el) return;
  el.innerHTML = `<b>Password rules</b><ul>
    <li>At least ${passwordMinLength()} characters</li>
    <li>Contains both letters and numbers</li>
    <li>Not a commonly used password</li>
  </ul>`;
}

/* ---------- home / menu / product ---------- */

function renderHome() {
  const u = user();
  document.getElementById("home-greeting").textContent = u.name ? `Good to see you, ${u.name}!` : "Good to see you!";
  document.getElementById("home-categories").innerHTML = categories().slice(0, 8).map(c => `<button class="category-chip ${c.name === "All" ? "active" : ""}" onclick="selectHomeCategory('${jsq(c.name)}')"><span class="cat-icon">${esc(c.icon)}</span>${esc(c.name)}</button>`).join("");
  document.getElementById("home-popular").innerHTML = orderableProducts().slice(0, 6).map(p => `<button class="mini-product" onclick="openProduct(${p.id})"><img src="${esc(p.img)}" alt="${esc(p.name)}"><b>${esc(p.name)}</b><span>${money(p.price)}</span></button>`).join("");
  const banner = document.getElementById("store-closed-banner");
  if (isStoreOpen()) { banner.style.display = "none"; banner.innerHTML = ""; }
  else { banner.style.display = "flex"; banner.innerHTML = `<b>🔒 ${esc(config().store_name || "FOODAY")} is closed right now</b><span>We are not accepting orders at the moment. Please check back soon.</span>`; }
  renderHomeAnnouncement();
}
function renderHomeAnnouncement() {
  const box = document.getElementById("home-announcement"), list = announcements();
  if (!list.length) { box.style.display = "none"; box.innerHTML = ""; return; }
  const a = list[0];
  box.style.display = "flex";
  box.innerHTML = `<span class="announce-icon">${esc(a.icon || "👏")}</span><div><b>${esc(a.title)}</b><p>${esc(a.message)}</p><small>FOODAY Announcement</small></div>`;
}
function selectHomeCategory(c) { currentCategory = c; navigateTo("screen-menu"); }

function renderCategoryButtons() {
  document.getElementById("menu-categories").innerHTML = categories().map(c => `<button class="${c.name === currentCategory ? "active" : ""}" onclick="setCategory('${jsq(c.name)}')"><span>${esc(c.icon)}</span>${esc(c.name)}</button>`).join("");
}
function setCategory(c) { currentCategory = c; renderMenu(); }
function renderMenu() {
  renderCategoryButtons();
  const q = document.getElementById("menu-search").value.trim().toLowerCase();
  const list = products().filter(p => (currentCategory === "All" || p.category === currentCategory) && (!q || `${p.name} ${p.category}`.toLowerCase().includes(q)));
  document.getElementById("menu-heading").textContent = currentCategory === "All" ? "All Items" : currentCategory;
  document.getElementById("menu-count").textContent = `${list.length} item${list.length === 1 ? "" : "s"}`;
  document.getElementById("menu-list").innerHTML = list.length ? list.map(productCard).join("") : `<div class="empty">No food found in this category.</div>`;
}
function productCard(p) {
  const sold = p.available === false;
  const fav = isFavorite(p.id);
  // The heart sits outside the openProduct wrapper so tapping it never opens the
  // detail screen, and every card carries the id so one repaint can fix them all.
  return `<div class="product-card ${sold ? "sold" : ""}"><img src="${esc(p.img)}" alt="${esc(p.name)}" onclick="openProduct(${p.id})"><div onclick="openProduct(${p.id})"><h4>${esc(p.name)}</h4><p>${esc(p.desc)}</p><div class="rating-row"><span class="stars">★</span> ${esc(p.rating || 4.7)}</div><div class="price">${money(p.price)}${sold ? ' <em class="sold-tag">Sold out</em>' : ""}</div></div><div class="card-actions"><button class="heart-btn card-heart${fav ? " on" : ""}" data-fav="${p.id}" onclick="toggleFavorite(${p.id})" aria-pressed="${fav}" aria-label="${fav ? "Remove from favorites" : "Save to favorites"}">${fav ? "♥" : "♡"}</button><button class="add-round" onclick="quickAdd(${p.id})" ${sold ? "disabled" : ""} aria-label="Add to cart"><svg viewBox="0 0 24 24"><path d="M3 4h2l2.2 10.1a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 1.9-1.5L21 8H6"></path><circle cx="10" cy="20" r="1.2"></circle><circle cx="18" cy="20" r="1.2"></circle></svg></button><button class="buy-round" onclick="buyNowFromCard(${p.id})" ${sold ? "disabled" : ""} aria-label="Buy now"><svg viewBox="0 0 24 24"><path d="M13 2 4 14h6l-1 8 9-12h-6z"></path></svg></button></div></div>`;
}
function openProduct(id) {
  currentProduct = products().find(p => p.id === Number(id)); if (!currentProduct) return;
  detailQty = 1;
  const c = config();
  document.getElementById("detail-image").src = currentProduct.img;
  document.getElementById("detail-name").textContent = currentProduct.name;
  document.getElementById("detail-price").textContent = money(currentProduct.price);
  document.getElementById("detail-description").textContent = currentProduct.desc;
  document.getElementById("detail-category").textContent = `${categories().find(x => x.name === currentProduct.category)?.icon || "🍽️"} ${currentProduct.category}`;
  document.getElementById("detail-rating").textContent = currentProduct.rating || 4.7;
  document.getElementById("detail-reviews").textContent = `(${currentProduct.reviews || 120} reviews)`;
  document.getElementById("detail-qty").textContent = "1";
  document.getElementById("detail-note").value = "";
  document.getElementById("detail-eta").textContent = `${c.prep_minutes || 30}–${(c.prep_minutes || 30) + 15} min`;
  document.getElementById("detail-soldout").style.display = currentProduct.available === false ? "block" : "none";
  document.getElementById("detail-add-btn").disabled = currentProduct.available === false;
  document.getElementById("detail-buy-btn").disabled = currentProduct.available === false;
  const head = document.getElementById("favorite-btn");
  head.dataset.fav = String(currentProduct.id);
  head.textContent = isFavorite(currentProduct.id) ? "♥" : "♡";
  head.classList.toggle("on", isFavorite(currentProduct.id));
  head.setAttribute("aria-pressed", isFavorite(currentProduct.id) ? "true" : "false");
  updateDetailTotals();
  navigateTo("screen-product");
}
function updateDetailTotals() {
  if (!currentProduct) return;
  const total = money(currentProduct.price * detailQty);
  document.getElementById("detail-total").textContent = total;
  document.getElementById("detail-buy-total").textContent = total;
}
function changeDetailQty(delta) { detailQty = Math.max(1, Math.min(99, detailQty + delta)); document.getElementById("detail-qty").textContent = detailQty; updateDetailTotals(); }

/* ---------- cart & buy now ---------- */

function quickAdd(id) {
  const p = products().find(x => x.id === Number(id)); if (!p) return;
  if (p.available === false) { toast("Sold Out", `${p.name} is not available right now.`); return; }
  addCart(p, 1); toast("Cart Updated", `${p.name} added to your cart.`);
}
function addCart(p, qty, note = "") {
  const existing = cart.find(x => x.id === p.id);
  if (existing) { existing.qty = Math.min(99, existing.qty + qty); if (note) existing.note = note; }
  else cart.push({ id: p.id, name: p.name, price: p.price, img: p.img, qty, note });
  setLocal("fooday_cart", cart); updateCartCount();
}
function addDetailToCart() {
  if (!currentProduct) return;
  if (currentProduct.available === false) { toast("Sold Out", "This item is not available right now."); return; }
  addCart(currentProduct, detailQty, document.getElementById("detail-note").value.trim());
  toast("Cart Updated", `${currentProduct.name} × ${detailQty} added to your cart.`);
  navigateTo("screen-cart");
}
/** Skips the cart: the single item goes straight into checkout. */
function buyNowDetail() {
  if (!currentProduct) return;
  if (currentProduct.available === false) { toast("Sold Out", "This item is not available right now."); return; }
  startBuyNow(currentProduct, detailQty, document.getElementById("detail-note").value.trim());
}
function buyNowFromCard(id) {
  const p = products().find(x => x.id === Number(id)); if (!p) return;
  if (p.available === false) { toast("Sold Out", `${p.name} is not available right now.`); return; }
  startBuyNow(p, 1, "");
}
function startBuyNow(product, qty, note) {
  buyNowItem = { id: product.id, name: product.name, price: product.price, img: product.img, qty, note };
  checkoutMode = "buynow";
  toast("Buy Now", `${product.name} · checking out now.`);
  navigateTo("screen-checkout");
}
function cancelBuyNow() {
  buyNowItem = null; checkoutMode = "cart";
  toast("Back to Cart", "Your cart is unchanged.");
  navigateTo("screen-cart");
}
function activeOrderItems() {
  if (checkoutMode === "buynow" && buyNowItem) {
    return [{ product_id: buyNowItem.id, name: buyNowItem.name, price: buyNowItem.price, qty: buyNowItem.qty, note: buyNowItem.note || "" }];
  }
  return cart.map(x => ({ product_id: x.id, name: x.name, price: x.price, qty: x.qty, note: x.note || "" }));
}
function activeOrderTotal() {
  return activeOrderItems().reduce((s, x) => s + Number(x.price) * Number(x.qty), 0);
}
function updateCartCount() {
  const n = cart.reduce((s, x) => s + x.qty, 0);
  const el = document.getElementById("cart-count");
  if (el) {
    const was = el.textContent;
    el.textContent = n;
    if (was !== String(n) && el.classList.contains("cart-fab-badge")) bumpFabBadge();
  }
  const fab = document.getElementById("cart-fab");
  if (fab) fab.classList.toggle("has-items", n > 0);
}
function clearCart() { cart = []; setLocal("fooday_cart", cart); renderCart(); updateCartCount(); }
function removeCart(i) { cart.splice(i, 1); setLocal("fooday_cart", cart); renderCart(); updateCartCount(); }
function renderCart() {
  const c = document.getElementById("cart-list");
  if (!cart.length) c.innerHTML = `<div class="empty">Your cart is empty.<button class="btn btn-primary" style="margin-top:12px" onclick="navigateTo('screen-menu')">Browse Menu</button></div>`;
  else c.innerHTML = cart.map((x, i) => `<div class="cart-item"><img src="${esc(x.img)}" alt="${esc(x.name)}"><div><b>${esc(x.name)}</b><small>${money(x.price)} × ${x.qty}</small>${x.note ? `<small>Note: ${esc(x.note)}</small>` : ""}</div><button class="remove" onclick="removeCart(${i})">×</button></div>`).join("");
  const total = cart.reduce((s, x) => s + x.price * x.qty, 0);
  document.getElementById("cart-subtotal").textContent = money(total);
  document.getElementById("cart-total").textContent = money(total);
  updateCartCount();
}

/* ---------- checkout / payment ---------- */

function goCheckout() {
  const buyNow = checkoutMode === "buynow" && buyNowItem;
  if (!cart.length && !buyNow) { showAlert("Your cart is empty.", "Your Cart Is Empty"); return; }
  checkoutMode = cart.length ? "cart" : "buynow";
  navigateTo("screen-checkout");
}
function checkoutBack() {
  if (checkoutMode === "buynow" && buyNowItem) navigateTo("screen-product");
  else navigateTo("screen-cart");
}
function prefillCheckout() {
  const u = user();
  document.getElementById("checkout-name").value = document.getElementById("checkout-name").value || u.name || "";
  document.getElementById("checkout-phone").value = document.getElementById("checkout-phone").value || u.phone || "";
  const areaSel = document.getElementById("checkout-area");
  const keep = areaSel.value;
  areaSel.innerHTML = `<option value="">Select your area</option>` + areas().map(a => `<option value="${esc(a.name)}">${esc(a.name)} (${esc(a.fee)})</option>`).join("");
  if (keep) areaSel.value = keep;
  const saved = addresses().find(a => a.is_default) || addresses()[0];
  if (saved && !document.getElementById("checkout-address").value) {
    document.getElementById("checkout-address").value = saved.address;
    document.getElementById("checkout-landmark").value = saved.landmark || "";
  }
  renderCheckoutSummary();
}
function renderCheckoutSummary() {
  const items = activeOrderItems();
  const total = items.reduce((s, x) => s + Number(x.price) * Number(x.qty), 0);
  const buyNow = checkoutMode === "buynow" && buyNowItem;
  const mode = document.getElementById("checkout-mode");
  mode.className = buyNow ? "buy-mode-banner buy" : "buy-mode-banner cart";
  mode.innerHTML = buyNow
    ? `<span class="mode-icon">⚡</span><div><b>Buy Now · ${esc(buyNowItem.name)} × ${buyNowItem.qty}</b><small>Your cart is untouched. <button onclick="cancelBuyNow()">Go back to cart</button></small></div>`
    : `<span class="mode-icon">🛒</span><div><b>Checking out your cart</b><small>${cart.length} item${cart.length === 1 ? "" : "s"} · ${money(total)}</small></div>`;

  document.getElementById("checkout-item-count").textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;
  document.getElementById("checkout-summary").innerHTML = items.length
    ? items.map(x => `<div class="summary-line"><span>${esc(x.name)} × ${x.qty}</span><b>${money(Number(x.price) * Number(x.qty))}</b></div>`).join("") +
      `<div class="summary-line"><span>Delivery fee</span><b>To be arranged</b></div>` +
      `<div class="summary-line total"><span>Total</span><b>${money(total)}</b></div>`
    : `<div class="empty">No items to check out.</div>`;

  const warn = document.getElementById("checkout-min-warning");
  const min = Number(config().min_total || 0);
  if (min && total < min) { warn.style.display = "block"; warn.innerHTML = `Minimum order is <b>${money(min)}</b>. Add ${money(min - total)} more to continue.`; }
  else warn.style.display = "none";
  return total;
}
function continueToPayment() {
  if (!isStoreOpen()) { showAlert("FOODAY is closed right now. Please try again later.", "We're Closed"); return; }
  const name = document.getElementById("checkout-name").value.trim();
  const phone = document.getElementById("checkout-phone").value.trim();
  const address = document.getElementById("checkout-address").value.trim();
  if (!name || !phone || !address) { showAlert("Please complete your delivery information."); return; }
  if (!validName(name)) { showAlert("Please enter a valid full name."); return; }
  if (!validPhone(phone)) { showAlert("Please enter a valid 11-digit Philippine mobile number."); return; }
  const total = renderCheckoutSummary();
  const min = Number(config().min_total || 0);
  if (min && total < min) { showAlert(`Minimum order is ${money(min)}.`, "Minimum Order"); return; }
  setLocal("fooday_checkout", {
    name, phone,
    area: document.getElementById("checkout-area").value,
    address,
    landmark: document.getElementById("checkout-landmark").value.trim(),
    note: document.getElementById("checkout-note").value.trim(),
    buy_now: checkoutMode === "buynow" && !!buyNowItem
  });
  selectedPayment = "Cash on Delivery";
  navigateTo("screen-payment");
}
function selectPayment(method) {
  if (method === "GCash") { notifyGcash(); return; }
  selectedPayment = method;
  document.getElementById("pay-cod").classList.add("selected");
}
function notifyGcash() {
  toast("GCash — Coming Soon", "We are completing our GCash merchant setup. Cash on delivery is available now.");
}
function renderPayment() {
  const c = config();
  document.getElementById("payment-total").textContent = money(activeOrderTotal());
  document.getElementById("pay-cod").classList.toggle("selected", selectedPayment === "Cash on Delivery");
  document.getElementById("pay-cod").classList.toggle("disabled", c.cod_enabled === false);
  const btn = document.getElementById("place-order-btn");
  if (c.cod_enabled === false) { btn.disabled = true; btn.textContent = "Payments Unavailable"; }
  else { btn.disabled = false; btn.textContent = checkoutMode === "buynow" ? "Buy Now" : "Place Order"; }
  document.getElementById("payment-intro").textContent = c.cod_enabled === false
    ? "Online payments are temporarily unavailable. Please check back shortly."
    : "Choose how you would like to pay. Please prepare your payment when your order arrives.";
}
async function placeOrder() {
  if (!isStoreOpen()) { showAlert("FOODAY is closed right now. Please try again later.", "We're Closed"); return; }
  if (config().cod_enabled === false) { showAlert("Payments are temporarily unavailable.", "Payments Unavailable"); return; }
  if (selectedPayment !== "Cash on Delivery") { notifyGcash(); return; }
  const items = activeOrderItems();
  if (!items.length) { showAlert("Your cart is empty.", "Your Cart Is Empty"); return; }
  await finalizeOrder("Cash on Delivery", items, checkoutMode === "buynow");
}
async function finalizeOrder(payment, items, wasBuyNow) {
  const checkout = getLocal("fooday_checkout", {});
  try {
    const res = await api("orders.php", { action: "create", payment_method: payment, items, checkout });
    if (!wasBuyNow) { cart = []; setLocal("fooday_cart", cart); updateCartCount(); }
    buyNowItem = null; checkoutMode = "cart";
    await refreshStore();
    currentOrderId = res.order_id;
    document.getElementById("confirm-name").textContent = res.customer_name || user().name || checkout.name || "there";
    document.getElementById("confirm-id").textContent = res.order_id;
    document.getElementById("confirm-status").textContent = res.status || "Order Placed";
    document.getElementById("confirm-rows").innerHTML = `
      <div class="confirm-row"><span>Items</span><b>${items.reduce((s, x) => s + Number(x.qty), 0)}</b></div>
      <div class="confirm-row"><span>Total</span><b>${money(res.total)}</b></div>
      <div class="confirm-row"><span>Payment</span><b>${esc(payment)}</b></div>
      <div class="confirm-row"><span>Via</span><b>${wasBuyNow ? "Buy Now" : "Cart"}</b></div>
      <div class="confirm-row"><span>Ready in</span><b>~${config().prep_minutes || 30} min</b></div>`;
    toast("Order Placed", "Your order is now waiting for the kitchen to accept it.");
    navigateTo("screen-confirmation");
  } catch (e) { reportError(e); }
}

/* ---------- orders / tracking ---------- */

function statusTone(s) {
  if (s === "Delivered") return "completed";
  if (s === "Cancelled") return "cancelled";
  if (s === "On the Way") return "transit";
  if (s === "Preparing" || s === "Accepted") return "active";
  return "new";
}
function renderOrderFilters(active = "All") {
  const statuses = ["All", ...ORDER_FLOW, "Cancelled"];
  document.getElementById("order-filters").innerHTML = statuses.map(s => `<button class="${s === active ? "active" : ""}" onclick="renderOrders('${jsq(s)}')">${esc(s)}</button>`).join("");
}
function renderOrders(filter = "All") {
  orderFilter = filter;
  renderOrderFilters(filter);
  const list = orders().filter(o => filter === "All" || o.status === filter);
  document.getElementById("orders-list").innerHTML = list.length ? list.map(orderCard).join("") : `<div class="empty">No ${filter === "All" ? "orders" : filter.toLowerCase() + " orders"} yet.</div>`;
}
function orderCard(o) {
  const tone = statusTone(o.status);
  const qty = (o.items || []).reduce((s, x) => s + x.qty, 0);
  return `<div class="order-card"><div class="order-top"><strong>${esc(o.id)}</strong><span class="status ${tone}">${esc(o.status)}</span></div><div class="order-meta">${esc(o.date)} · ${esc(o.paymentMethod)} · ${qty} item${qty === 1 ? "" : "s"}</div><div class="order-items-preview">${(o.items || []).map(x => `<span class="item-chip">${esc(x.name)} × ${x.qty}</span>`).join("")}</div><div class="order-bottom"><strong>${money(o.total)}</strong>${o.status === "Cancelled" || o.status === "Delivered" ? `<button class="track-btn ghost" onclick="openTracking('${jsq(o.id)}')">View Details</button>` : `<button class="track-btn" onclick="openTracking('${jsq(o.id)}')">Track Order</button>`}</div></div>`;
}
function openTracking(id) {
  const o = orders().find(x => x.id === id); if (!o) return;
  currentOrderId = id; navigateTo("screen-tracking");
}
function renderTracking() {
  const o = orders().find(x => x.id === currentOrderId);
  if (!o) { navigateTo("screen-orders"); return; }
  const tone = statusTone(o.status);
  const idx = ORDER_FLOW.indexOf(o.status);
  const cancelled = o.status === "Cancelled";

  document.getElementById("tracking-card").innerHTML = `
    <div class="tracking-title"><b>${esc(o.id)}</b><span class="status ${tone}">${esc(o.status)}</span></div>
    <div class="tracking-now ${tone}">
      <b>${esc(o.statusLabel || o.status)}</b>
      <small>${orderIsDone(o) ? `Closed ${esc(o.statusUpdated || o.date)}` : `Updated ${esc(o.statusUpdated || o.date)} · this page refreshes on its own`}</small>
    </div>
    <div class="tracking-sub">${esc(o.customer)} · ${esc(o.date)} · ${esc(o.paymentMethod)}</div>
    <div class="tracking-lines">
      ${(o.items || []).map(x => `<div><span>${esc(x.name)} × ${x.qty}</span><b>${money(x.subtotal || x.price * x.qty)}</b></div>`).join("")}
      <div><span>Delivery fee</span><b>To be arranged</b></div>
      <div class="total"><span>Total</span><b>${money(o.total)}</b></div>
    </div>
    <div class="tracking-addr"><b>Deliver to</b><p>${esc(o.address || "—")}</p>${o.landmark ? `<small>Landmark: ${esc(o.landmark)}</small>` : ""}${o.area ? `<small>Area: ${esc(o.area)}</small>` : ""}</div>
    ${o.status === "Delivered" ? receiptHtml(o) : ""}
    ${o.note ? `<div class="tracking-note"><b>Your note</b><p>${esc(o.note)}</p></div>` : ""}
    ${o.cancelReason ? `<div class="tracking-note cancelled-note"><b>Cancellation reason</b><p>${esc(o.cancelReason)}</p></div>` : ""}`;

  const tl = document.getElementById("tracking-timeline");
  if (cancelled) tl.innerHTML = `<div class="tracking-title"><b>Order history</b></div><div class="timeline">${orderTimelineHtml(o)}</div>`;
  else tl.innerHTML = `<div class="tracking-title"><b>Order progress</b></div><div class="timeline">${ORDER_FLOW.map((s, i) => `<div class="step ${i < idx ? "done" : i === idx ? "current" : ""}"><span class="step-dot">${i < idx ? "✓" : i + 1}</span><div><b>${esc(s)}</b><small>${esc(STEP_BLURB[s])}</small></div></div>`).join("")}</div>`;

  const cancel = document.getElementById("cancel-order-btn");
  const canCancel = o.canCancel === true;
  cancel.style.display = orderIsDone(o) ? "none" : "block";
  cancel.disabled = !canCancel;
  cancel.textContent = canCancel ? "Cancel Order" : "Cancellation Closed";
}
function orderTimelineHtml(o) {
  const events = o.events && o.events.length ? o.events : [{ status: o.status, at: o.date, actor: "system", note: "" }];
  return events.map(e => `<div class="step ${e.status === o.status ? "current" : "done"}"><span class="step-dot">${e.status === o.status ? "•" : "✓"}</span><div><b>${esc(e.status)}</b><small>${esc(e.at)}${e.note ? ` · ${esc(e.note)}` : ""}</small></div></div>`).join("");
}
function askCancelOrder() {
  const o = orders().find(x => x.id === currentOrderId); if (!o) return;
  if (o.canCancel !== true) { showAlert("This order can no longer be cancelled. Please contact FOODAY support for help.", "Cannot Cancel"); return; }
  cancelTarget = o.id;
  document.getElementById("cancel-order-text").textContent = `Cancel ${o.id}? This cannot be undone.`;
  document.getElementById("cancel-reason").value = "";
  openModal("modal-cancel-order");
}
async function confirmCancelOrder() {
  if (!cancelTarget) return;
  const code = cancelTarget;
  cancelTarget = null;
  try {
    await api("orders.php", { action: "cancel", order_code: code, reason: document.getElementById("cancel-reason").value.trim() });
    closeModal("modal-cancel-order");
    await refreshStore();
    if (STORE.admin) { expandedOrders.delete(code); renderAdminOrders(); renderAdminDashboard(); }
    else if (currentOrderId === code) renderTracking();
    renderOrders();
    toast("Order Cancelled", `${code} was cancelled.`);
  } catch (e) { reportError(e); }
}

/* ---------- favorites ---------- */

/** True when this product is already saved. */
function isFavorite(id) { return favorites().some(x => x.id === Number(id)); }

/**
 * Repaints every heart pointing at one product: the card hearts and the header
 * heart. Keyed off data-fav, so the menu, the favorites list and the open
 * product screen all stay in step from a single call.
 */
function paintFavoriteHearts(productId, on) {
  document.querySelectorAll(`[data-fav="${productId}"]`).forEach(el => {
    el.textContent = on ? "♥" : "♡";
    el.classList.toggle("on", !!on);
    el.setAttribute("aria-pressed", on ? "true" : "false");
    el.setAttribute("aria-label", on ? "Remove from favorites" : "Save to favorites");
  });
}

/** Mirrors the server's answer into the local list, without refetching anything. */
function applyFavoriteLocally(productId, on) {
  const id = Number(productId);
  STORE.favorites = on
    ? (isFavorite(id) ? favorites() : [...favorites(), products().find(p => p.id === id)].filter(Boolean))
    : favorites().filter(x => x.id !== id);
}

async function toggleFavorite(productId) {
  const id = Number(productId ?? (currentProduct && currentProduct.id));
  if (!id) return;
  if (!user().id) { requireSignIn("save favorites"); return; }

  // Repaint immediately so the tap always feels answered, then let the server
  // have the last word. The old version waited on a full bootstrap.php re-fetch
  // before touching the DOM, so any unrelated failure left the heart unchanged
  // and popped an error even though the row had already been saved.
  const was = isFavorite(id);
  paintFavoriteHearts(id, !was);
  try {
    const res = await api("account.php", { action: "toggle_favorite", product_id: id });
    const on = res && res.favorited === true;
    applyFavoriteLocally(id, on);
    paintFavoriteHearts(id, on);
    renderFavorites();
    toast("Favorites", on ? "Saved to your favorites." : "Removed from your favorites.");
  } catch (e) {
    paintFavoriteHearts(id, was);   // the save did not happen, so undo the guess
    reportError(e);
  }
}
function renderFavorites() {
  const list = document.getElementById("favorites-list");
  if (!list) return;
  list.innerHTML = favorites().length
    ? favorites().map(productCard).join("")
    : `<div class="empty">No favorite foods yet.</div>`;
}

/* ---------- profile ---------- */

function renderProfile() {
  const u = user();
  document.getElementById("profile-name").textContent = u.name || "User";
  document.getElementById("profile-email").textContent = u.email || "";
  document.getElementById("profile-phone").textContent = u.phone || "";
  const src = u.profile_image;
  const img = document.getElementById("profile-image"), letter = document.getElementById("profile-letter");
  if (src) { img.src = src; img.style.display = "block"; letter.style.display = "none"; }
  else { img.style.display = "none"; letter.style.display = "grid"; letter.textContent = (u.name || "U").charAt(0).toUpperCase(); }
}
function openEditProfile() {
  const u = user();
  document.getElementById("edit-name").value = u.name || "";
  document.getElementById("edit-email").value = u.email || "";
  document.getElementById("edit-phone").value = u.phone || "";
  openModal("modal-edit-profile");
}
async function saveProfile() {
  const name = document.getElementById("edit-name").value.trim();
  const email = document.getElementById("edit-email").value.trim().toLowerCase();
  const phone = document.getElementById("edit-phone").value.trim();
  if (!validName(name)) { showAlert("Please enter a valid full name."); return; }
  if (!validEmail(email)) { showAlert("Please enter a valid email address."); return; }
  if (!validPhone(phone)) { showAlert("Please enter a valid 11-digit Philippine mobile number."); return; }
  // Only a change of the sign-in email needs a code; a name or phone tweak does not.
  if (email === (user().email || "").toLowerCase()) {
    try { await commitProfile(name, email, phone, ""); } catch (e) { reportError(e); }
    return;
  }
  await beginChangeCode("user", "email", code => commitProfile(name, email, phone, code));
}
async function commitProfile(name, email, phone, code) {
  await api("account.php", { action: "update_profile", name, email, phone, code });
  await refreshStore();
  closeModal("modal-edit-profile"); renderProfile(); renderHome();
  toast("Profile Updated", "Your profile has been updated.");
}
/* ---------- photos: pick, then shrink to fit ---------- */

/* A phone camera makes photos far larger than this app needs — 3 to 12 MB from a
 * normal 12 MP sensor — while the server accepts a data URL of at most
 * 4,000,000 bytes for a product and 2,000,000 for a profile picture, and base64
 * already adds about a third on top of the file. So instead of refusing a photo
 * that was just taken, it is drawn into a canvas and re-encoded to something
 * that always fits. Nothing is uploaded until that is done, so a big photo is
 * never rejected for being big.
 *
 * A photograph becomes a JPEG, which is the smallest way to carry one. A menu
 * graphic that really has see-through pixels keeps its alpha as a PNG instead,
 * because a flattened logo is a broken logo.
 *
 * The phone's own picker owns the "access your photos" permission — it hands the
 * page exactly the one file that was chosen, and a photo library is never read.
 */
const PHOTO_MAX_EDGE     = 720;        // still sharp on a retina avatar, a fraction of the bytes
const PHOTO_PRODUCT_EDGE = 1000;       // menu photos are shown far larger than an avatar
const PHOTO_ALPHA_EDGE   = 320;        // floor for a transparent graphic we keep as PNG
const PHOTO_SCAN_EDGE    = 256;        // where the pixels are read to look for transparency
const PHOTO_MAX_BYTES    = 1_400_000;  // safely under the server's smallest ceiling (2,000,000)
const PHOTO_INPUT_MAX    = 30_000_000; // beyond this, decoding would just stall a phone

/** Shrinks a picked photo to a data URL, or "" when it cannot be read. */
async function shrinkPhoto(file, maxEdge = PHOTO_MAX_EDGE) {
  if (!file || !/^image\//.test(file.type || "") || file.size > PHOTO_INPUT_MAX) return "";

  const source = await decodePhoto(file);
  if (!source || !source.width || !source.height) return "";

  // A format that can carry transparency may be a graphic rather than a
  // photograph, so it gets a chance to stay lossless. With alpha, pixels are
  // traded away to fit; without, the PNG gets one attempt before JPEG takes
  // over — which is what a photograph saved as PNG will fall through to.
  let dataUrl = "";
  if (photoMayHaveAlpha(file.type)) {
    dataUrl = photoHasAlpha(source)
      ? encodePng(source, maxEdge, PHOTO_ALPHA_EDGE)
      : encodePng(source, maxEdge, maxEdge);
  }
  // Decoded before the bitmap is released: every encoder draws from `source`,
  // and a closed ImageBitmap can no longer be drawn.
  if (!dataUrl) dataUrl = encodeJpeg(source, maxEdge);
  if (source.close) source.close();
  return dataUrl;
}

/** Draws the image at the given longest edge. A small image is never enlarged. */
function photoCanvas(source, maxEdge) {
  const scale  = Math.min(1, maxEdge / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width  = Math.max(1, Math.round(source.width  * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** A photograph: the quality steps down, so the picture keeps its size and shape
    and only gives up detail a screen was never going to show. */
function encodeJpeg(source, maxEdge) {
  const canvas = photoCanvas(source, maxEdge);
  for (const quality of [0.82, 0.7, 0.6, 0.5]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length <= PHOTO_MAX_BYTES) return url;
  }
  return "";
}

/** Keeps the image lossless as a PNG, trading resolution away down to `minEdge`
    to make it fit. With no floor below the top edge it is a single attempt,
    which is how an opaque PNG gets one chance to stay crisp. */
function encodePng(source, maxEdge, minEdge) {
  let dataUrl = "";
  for (let edge = maxEdge; edge >= minEdge; edge = edge > minEdge ? Math.max(minEdge, Math.round(edge * 0.75)) : 0) {
    dataUrl = photoCanvas(source, edge).toDataURL("image/png");
    if (dataUrl.length <= PHOTO_MAX_BYTES) return dataUrl;
  }
  return "";
}

/** Formats that can carry transparency at all. A JPEG never can, so it is never
    sent down the lossless path. */
function photoMayHaveAlpha(type) {
  return /^image\/(png|webp|gif|avif)$/.test(type || "");
}

/** Whether the pixels really are see-through somewhere. */
function photoHasAlpha(source) {
  try {
    const canvas = photoCanvas(source, PHOTO_SCAN_EDGE);
    const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 250) return true;
    }
    return false;
  } catch {
    // Pixels we cannot read: keeping the alpha is the safer of the two mistakes.
    return true;
  }
}

/** Decodes the file, preferring the path that also applies EXIF rotation. */
function decodePhoto(file) {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file, { imageOrientation: "from-image" })
      .catch(() => createImageBitmap(file).catch(() => null));
  }
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

/** Clears the input and hands back the chosen file, so the same photo can be
    picked twice in a row — a cleared input fires `change` again. */
function pickedPhoto(input) {
  const file = input.files?.[0] || null;
  input.value = "";
  return file;
}

function changeProfilePicture() { document.getElementById("profile-file").click(); }
async function saveProfilePicture(e) {
  const file = pickedPhoto(e.target);
  if (!file) return;

  const image = await shrinkPhoto(file);
  if (!image) { toast("Photo Not Used", "That photo could not be read. Please choose another one."); return; }
  try {
    await api("account.php", { action: "update_picture", image });
    await refreshStore();
    renderProfile();
    toast("Profile Picture", "Your profile picture was updated.");
  } catch (err) { reportError(err); }
}
function openPasswordChange() {
  ["pw-current", "pw-new", "pw-confirm"].forEach(id => { document.getElementById(id).value = ""; });
  updatePasswordHint("pw-new", "pw-hint");
  renderPasswordRules("pw-rules");
  openModal("modal-password");
}
async function submitPasswordChange() {
  const current = document.getElementById("pw-current").value;
  const next = document.getElementById("pw-new").value;
  const confirm = document.getElementById("pw-confirm").value;
  if (!current || !next) { showAlert("Please complete all password fields."); return; }
  if (next !== confirm) { showAlert("The new passwords do not match."); return; }
  const weak = passwordProblem(next); if (weak) { showAlert(weak); return; }
  await beginChangeCode("user", "password", code => commitPasswordChange(current, next, confirm, code));
}
async function commitPasswordChange(current, next, confirm, code) {
  const res = await api("account.php", { action: "change_password", current_password: current, new_password: next, confirm_password: confirm, code });
  await refreshStore();
  closeModal("modal-password");
  toast("Password Updated", res.message || "Your password was updated.");
}
function openAddresses() { renderAddresses(); openModal("modal-addresses"); }

/** How many addresses this customer may keep. Never fewer than three. */
function addressLimit() { return Math.max(3, Number(config().address_limit) || 10); }

function renderAddresses() {
  const list = addresses();
  const limit = addressLimit();
  const full = list.length >= limit;

  document.getElementById("address-list").innerHTML = list.length
    ? list.map(a => `<div class="address-row${a.is_default ? " default" : ""}">
        <div><b>${esc(a.label)}${a.is_default ? ' <em class="default-tag">Default</em>' : ""}</b><small>${esc(a.address)}${a.landmark ? ` · ${esc(a.landmark)}` : ""}</small>${a.lat !== null && a.lat !== undefined ? `<small class="address-pin-tag">📍 Pinned · ${Number(a.lat).toFixed(4)}, ${Number(a.lng).toFixed(4)}</small>` : ""}</div>
        <div class="address-actions">
          ${a.is_default ? "" : `<button onclick="setDefaultAddress(${a.id})">Set default</button>`}
          <button class="danger" onclick="deleteAddress(${a.id})">Delete</button>
        </div></div>`).join("")
    : `<div class="empty">No saved addresses yet.</div>`;

  // The server enforces the same limit; saying so here is what stops the
  // customer filling in a form that is going to be refused.
  const note = document.getElementById("address-limit-note");
  if (note) {
    note.textContent = full
      ? `All ${limit} address slots are used. Delete one to save another.`
      : `${list.length} of ${limit} address slots used. Type an address, or pin where you are now.`;
  }
  const saveBtn = document.getElementById("save-address-btn");
  if (saveBtn) saveBtn.disabled = full;
  const gpsBtn = document.getElementById("address-gps-btn");
  if (gpsBtn) gpsBtn.hidden = full;
}
async function saveAddress() {
  const address = document.getElementById("new-address").value.trim();
  const landmark = document.getElementById("new-landmark").value.trim();
  const label = document.getElementById("new-address-label").value.trim() || "Home";
  const pinned = pin("saved");
  if (!address) { showAlert("Please enter a complete address, or pin your current location."); return; }
  try {
    await api("account.php", {
      action: "add_address", address, landmark, label,
      lat: pinned ? pinned.lat : null,
      lng: pinned ? pinned.lng : null
    });
    await refreshStore();
    document.getElementById("new-address").value = ""; document.getElementById("new-landmark").value = ""; document.getElementById("new-address-label").value = "";
    delete PINS.saved; renderPin("saved");
    renderAddresses();
    toast("Address Saved", "Your delivery address was saved.");
  } catch (e) { reportError(e); }
}
async function deleteAddress(id) {
  const sure = await confirmDialog({
    title: "Delete Address?",
    message: "Delete this saved address? This cannot be undone.",
    confirmLabel: "Delete",
    cancelLabel: "Keep It",
    danger: true,
  });
  if (!sure) return;
  try {
    await api("account.php", { action: "delete_address", id });
    await refreshStore();
    renderAddresses();
    toast("Address Removed", "The address was deleted.");
  } catch (e) { reportError(e); }
}
async function setDefaultAddress(id) {
  try {
    await api("account.php", { action: "default_address", id });
    await refreshStore();
    renderAddresses();
    toast("Default Set", "This address will be used at checkout.");
  } catch (e) { reportError(e); }
}

/* ---------- admin: dashboard ---------- */

function incomingOrders() { return orders().filter(o => o.status === "Order Placed"); }
function renderAdminDashboard() {
  const list = orders();
  const sales = list.filter(o => o.status !== "Cancelled").reduce((s, o) => s + Number(o.total || 0), 0);
  document.getElementById("stat-products").textContent = products().length;
  document.getElementById("stat-orders").textContent = list.length;
  document.getElementById("stat-revenue").textContent = money(sales);
  document.getElementById("stat-pending").textContent = incomingOrders().length;
  renderIncomingOrders();
  syncAdminDrawer();
}
function renderIncomingOrders() {
  const list = incomingOrders();
  const box = document.getElementById("admin-incoming");
  document.getElementById("incoming-count").textContent = list.length;
  box.innerHTML = list.length ? list.map(o => `
    <div class="incoming-card" onclick="openIncomingOrder('${jsq(o.id)}', event)">
      <div class="incoming-top">
        <div><b>${esc(o.id)}</b><small>${esc(o.customer)} · ${esc(o.date)}</small></div>
        <strong>${money(o.total)}</strong>
      </div>
      <div class="incoming-items">${(o.items || []).map(x => `<span class="item-chip">${esc(x.name)} × ${x.qty}</span>`).join("")}</div>
      <div class="incoming-where">📍 ${esc(o.area || "—")}${o.address ? ` · ${esc(o.address)}` : ""}</div>
      <div class="incoming-actions">
        <button class="btn btn-primary" onclick="adminAdvanceOrder('${jsq(o.id)}','${jsq(o.nextStatus || "Accepted")}')">${esc(ADVANCE_LABEL[o.nextStatus || "Accepted"] || "Accept Order")}</button>
        <button class="btn btn-ghost" onclick="viewAdminOrder('${jsq(o.id)}')">Details</button>
      </div>
    </div>`).join("")
    : `<div class="empty">🎉 No orders waiting. New orders appear here the moment a customer checks out.</div>`;
}
/** Tapping a pending card opens it, but its own buttons keep their own job. */
function openIncomingOrder(code, e) {
  if (e && e.target.closest("button")) return;
  viewAdminOrder(code);
}
function viewAdminOrder(code) {
  adminOrderFilter = "All";
  focusedOrder = code;
  expandedOrders.add(code);
  document.getElementById("admin-order-search").value = "";
  navigateTo("screen-admin-orders");
  renderAdminOrders();
}

/* ---------- admin: orders ---------- */

function renderAdminOrderFilters() {
  const counts = {};
  orders().forEach(o => { counts[o.status] = (counts[o.status] || 0) + 1; });
  document.getElementById("admin-order-filters").innerHTML = ADMIN_FILTERS.map(f => {
    const n = f === "All" ? orders().length : (f === "New" ? (counts["Order Placed"] || 0) : (counts[f] || 0));
    return `<button class="${f === adminOrderFilter ? "active" : ""}" onclick="setAdminOrderFilter('${jsq(f)}')">${esc(f)}<span>${n}</span></button>`;
  }).join("");
}
function setAdminOrderFilter(f) { adminOrderFilter = f; renderAdminOrders(); }
function renderAdminOrders() {
  renderAdminOrderFilters();
  const q = document.getElementById("admin-order-search").value.trim().toLowerCase();

  // While an order is being managed the screen is that order's: the rest of the
  // list, and the filters that only make sense over the whole list, step aside
  // until Back is pressed.
  const managing = focusedOrder ? orders().find(o => o.id === focusedOrder) || null : null;
  let list = managing ? [managing] : orders();
  if (!managing) {
    if (adminOrderFilter === "New") list = list.filter(o => o.status === "Order Placed");
    else if (adminOrderFilter !== "All") list = list.filter(o => o.status === adminOrderFilter);
  }
  if (q) list = list.filter(o => `${o.id} ${o.customer} ${o.phone} ${o.area || ""}`.toLowerCase().includes(q));

  document.getElementById("admin-order-filters").style.display = managing ? "none" : "";
  const scope = document.getElementById("admin-orders-scope");
  if (scope) scope.innerHTML = managing
    ? `Managing <b>${esc(managing.id)}</b> · Back shows the whole list.`
    : "";

  document.getElementById("admin-orders-list").innerHTML = list.length
    ? list.map(adminOrderCard).join("")
    : `<div class="empty">No orders match this view.</div>`;
}

/**
 * The Back button beside the search box, and the only way out of the screen.
 *
 * It walks back the way the admin came: out of the order they opened first, and
 * out of the orders screen second. A finished order is therefore never a dead
 * end, and nothing had to be added to the order card to say so.
 */
function adminOrdersBack() {
  if (focusedOrder) {
    focusedOrder = null;
    renderAdminOrders();
    return;
  }
  navigateTo("screen-admin-dashboard");
}
function adminOrderCard(o) {
  const tone = statusTone(o.status);
  const open = expandedOrders.has(o.id);
  const next = o.nextStatus;
  return `<div class="admin-order ${tone}${open ? " open" : ""}">
    <button class="ao-open" aria-expanded="${open}" onclick="toggleOrderDetail('${jsq(o.id)}')">
      ${adminOrderSummary(o)}
      <span class="ao-toggle">${open ? "Hide details ▴" : "View details ▾"}</span>
    </button>
    ${open ? adminOrderDetail(o, next) : ""}
  </div>`;
}
/** The always-visible part of an order card. All spans, so it can sit inside a button. */
function adminOrderSummary(o) {
  const qty = (o.items || []).reduce((s, x) => s + x.qty, 0);
  return `<span class="admin-order-top">
      <span><b>${esc(o.id)}</b><span class="ao-when">${esc(o.customer)} · ${esc(o.date)}</span></span>
      <span class="status ${statusTone(o.status)}">${esc(o.status)}</span>
    </span>
    <span class="admin-order-items">${(o.items || []).map(x => `<span class="item-chip">${esc(x.name)} × ${x.qty}</span>`).join("")}</span>
    <span class="admin-order-foot">
      <strong>${money(o.total)}</strong>
      <span class="ao-tags">${esc(o.paymentMethod)} · ${qty} item${qty === 1 ? "" : "s"}${o.source === "Buy Now" ? " · ⚡ Buy Now" : ""}</span>
    </span>`;
}
function adminOrderDetail(o, next) {
  const masked = o.contactHidden;
  return `<div class="ao-detail">
    ${o.status === "Delivered" ? receiptHtml(o) : ""}
    <div class="ao-block">
      <b>Items</b>
      ${(o.items || []).map(x => `<div class="ao-line"><span>${esc(x.name)} × ${x.qty} <small>@ ${money(x.price)}</small></span><b>${money(x.subtotal || x.price * x.qty)}</b></div>`).join("")}
      <div class="ao-line"><span>Delivery fee</span><b>To be arranged</b></div>
      <div class="ao-line total"><span>Total</span><b>${money(o.total)}</b></div>
    </div>
    <div class="ao-block">
      <b>Delivery</b>
      ${masked
        ? `<p class="ao-masked">🔒 Hidden by the Privacy setting in Admin &gt; Settings.</p>`
        : `<div class="ao-line"><span>Phone</span><b>${esc(o.phone)}</b></div>
           <div class="ao-line"><span>Area</span><b>${esc(o.area || "—")}</b></div>
           <div class="ao-line"><span>Address</span><b>${esc(o.address || "—")}</b></div>
           ${o.landmark ? `<div class="ao-line"><span>Landmark</span><b>${esc(o.landmark)}</b></div>` : ""}`}
      ${o.noteHidden ? `<p class="ao-masked">🔒 Customer note hidden by the Privacy setting.</p>` : (o.note ? `<div class="ao-note"><b>Customer note</b><p>${esc(o.note)}</p></div>` : "")}
      ${o.cancelReason ? `<div class="ao-note danger"><b>Cancel reason</b><p>${esc(o.cancelReason)}</p></div>` : ""}
    </div>
    <div class="ao-block">
      <b>Internal note (never shown to the customer)</b>
      <input class="input" value="${esc(o.adminNote || "")}" placeholder="e.g. Prepare 1 portion extra spicy" onchange="saveAdminOrderNote('${jsq(o.id)}', this.value)">
    </div>
    <div class="ao-block">
      <b>History</b>
      <div class="ao-history">${orderTimelineHtml(o)}</div>
    </div>
    <div class="ao-block">
      <b>Progress</b>
      ${adminStepper(o)}
    </div>
    <div class="ao-actions">
      ${adminAdvanceButton(o, next)}
      ${!orderIsDone(o) ? `<button class="btn btn-cancel-outline" onclick="adminCancelOrder('${jsq(o.id)}')">Cancel Order</button>` : ""}
    </div>
  </div>`;
}
/** The whole pipeline at a glance, so the admin always knows which step is next. */
function adminStepper(o) {
  if (o.status === "Cancelled") return `<p class="ao-masked">Cancelled — the order left the pipeline.</p>`;
  const i = ORDER_FLOW.indexOf(o.status);
  return `<div class="ao-steps">${ORDER_FLOW.map((s, n) =>
    `<span class="${n < i ? "done" : n === i ? "now" : ""}">${n < i ? "✓ " : ""}${esc(s)}</span>`).join("")}</div>`;
}
/** The one button that moves the order along. Never renders without a label. */
function adminAdvanceButton(o, next) {
  if (!next) {
    return o.status === "Delivered"
      ? `<div class="ao-finish done">✓ Delivered — this order is complete.</div>`
      : `<div class="ao-finish cancelled">✕ This order is closed.</div>`;
  }
  const busy = advancing.has(`${o.id}|${next}`);
  const label = next === "Delivered" && isCod(o) ? "Collect Cash & Complete" : (ADVANCE_LABEL[next] || `Mark ${next}`);
  return `<button class="btn btn-primary"${busy ? " disabled" : ""} onclick="adminAdvanceOrder('${jsq(o.id)}','${jsq(next)}')">${busy ? "Updating…" : esc(label)}</button>`;
}
/** Amount due, cash taken and change — the receipt for a completed order. */
function receiptHtml(o) {
  const paid = cashPaid(o);
  const change = o.changeDue === null || o.changeDue === undefined ? null : Number(o.changeDue);
  const cod = isCod(o);
  return `<div class="ao-receipt">
    <div class="ao-receipt-head"><b>Receipt</b><span>${esc(o.paymentMethod)}</span></div>
    <div class="ao-line"><span>Amount to pay</span><b>${money(o.total)}</b></div>
    <div class="ao-line"><span>Cash received</span><b>${paid === null ? (cod ? "Not recorded" : "—") : money(paid)}</b></div>
    <div class="ao-line total"><span>Change</span><b>${change === null ? (cod ? "Not recorded" : "—") : money(change)}</b></div>
    ${paid !== null && change !== null && change > 0 ? `<p class="ao-receipt-note">Return ${money(change)} to the customer.</p>` : ""}
  </div>`;
}
/**
 * Opening an order puts the screen into that one order's context: the list then
 * shows it and nothing else, so working through a long queue never means hunting
 * back down the list. Closing it, or Back, returns to every order.
 */
function toggleOrderDetail(code) {
  if (expandedOrders.has(code)) {
    expandedOrders.delete(code);
    if (focusedOrder === code) focusedOrder = null;
  } else {
    expandedOrders.add(code);
    focusedOrder = code;
  }
  renderAdminOrders();
}
async function adminAdvanceOrder(code, status) {
  const o = orders().find(x => x.id === code);
  // Completing a cash order has to capture the tender first, so the rider
  // cannot close the order without saying how much was handed over.
  if (o && status === "Delivered" && isCod(o)) { askCashOnDelivery(o); return; }
  await commitAdvance(code, status, {});
}

/** Performs the status change itself; `extra` carries the cash tender. */
async function commitAdvance(code, status, extra) {
  const key = `${code}|${status}`;
  if (advancing.has(key)) return;          // a double tap must not fire two requests
  advancing.add(key);
  renderAdminOrders();
  try {
    const res = await api("orders.php", { action: "advance", order_code: code, status, ...extra });
    await refreshStore();
    toast("Order Update", `${code} · ${res.label || status}`);
  } catch (e) { reportError(e); }
  finally { advancing.delete(key); renderAdminOrders(); renderAdminDashboard(); }
}

/* ---------- cash on delivery ---------- */

function askCashOnDelivery(o) {
  cashTarget = o;
  document.getElementById("cash-intro").textContent = `Collect the cash for ${o.id} before completing the order.`;
  document.getElementById("cash-due").textContent = money(o.total);
  const input = document.getElementById("cash-received");
  input.value = "";
  // Notes worth offering: the exact amount, then the usual round ones above it.
  const quick = [...new Set([Math.ceil(Number(o.total)), ...CASH_QUICK.filter(v => v >= Number(o.total))])];
  document.getElementById("cash-quick").innerHTML =
    quick.map(v => `<button type="button" onclick="setCashQuick(${v})">${v === Math.ceil(Number(o.total)) ? "Exact" : money(v)}</button>`).join("");
  updateCashChange();
  openModal("modal-cash");
  setTimeout(() => input.focus(), 60);
}
function setCashQuick(v) {
  const input = document.getElementById("cash-received");
  input.value = Number(v).toFixed(2);
  updateCashChange();
  input.focus();
}
function updateCashChange() {
  const o = cashTarget;
  const box = document.getElementById("cash-hint");
  if (!o) { box.textContent = ""; return; }
  const due = Number(o.total);
  const paid = parseFloat(document.getElementById("cash-received").value);
  const change = document.getElementById("cash-change");
  if (!isFinite(paid) || paid <= 0) {
    change.textContent = "—";
    box.className = "cash-hint";
    box.textContent = "Enter the cash the customer handed over.";
    return;
  }
  const diff = Math.round((paid - due) * 100) / 100;
  change.textContent = money(diff > 0 ? diff : 0);
  if (diff < 0) {
    box.className = "cash-hint short";
    box.textContent = `That is ${money(Math.abs(diff))} short of the amount due.`;
  } else if (diff === 0) {
    box.className = "cash-hint exact";
    box.textContent = "Paid exactly — no change.";
  } else {
    box.className = "cash-hint";
    box.textContent = `Give ${money(diff)} back to the customer.`;
  }
}
/** Backs out of the prompt; the order stays On the Way. */
function cancelCashCollection() {
  cashTarget = null;
  closeModal("modal-cash");
}
async function confirmCashDelivery() {
  const o = cashTarget;
  if (!o) return;
  const due = Number(o.total);
  const paid = parseFloat(document.getElementById("cash-received").value);
  if (!isFinite(paid) || paid <= 0) { showAlert("Enter the cash the customer handed over.", "Cash Payment"); return; }
  if (Math.round((paid - due) * 100) / 100 < 0) {
    showAlert(`That is less than the amount due (${money(due)}). Ask the customer for the balance.`, "Cash Payment");
    return;
  }
  closeModal("modal-cash");
  cashTarget = null;
  await commitAdvance(o.id, "Delivered", { cash_tendered: paid.toFixed(2) });
}
function adminCancelOrder(code) {
  cancelTarget = code;
  document.getElementById("cancel-order-text").textContent = `Cancel ${code}? A reason is required once a rider is on the way.`;
  document.getElementById("cancel-reason").value = "";
  openModal("modal-cancel-order");
}
async function saveAdminOrderNote(code, note) {
  try {
    await api("orders.php", { action: "note", order_code: code, note });
    await refreshStore();
    toast("Note Saved", "Internal note updated.");
  } catch (e) { reportError(e); }
}

/* ---------- admin: products ---------- */

function renderAdminProducts() {
  const cat = document.getElementById("product-category");
  cat.innerHTML = categories().filter(c => c.name !== "All").map(c => `<option value="${esc(c.name)}">${esc(c.icon)} ${esc(c.name)}</option>`).join("");
  document.getElementById("admin-products-list").innerHTML = products().map(p => `
    <div class="admin-product-row${p.available === false ? " off" : ""}">
      <img src="${esc(p.img)}" alt="${esc(p.name)}">
      <div><b>${esc(p.name)}</b><small>${esc(p.category)}${p.available === false ? " · Sold out" : ""}</small><strong>${money(p.price)}</strong></div>
      <div class="product-row-actions">
        <button class="mini-btn" onclick="startEditProduct(${p.id})" aria-label="Edit">✎</button>
        <button class="mini-btn" onclick="toggleProductAvailability(${p.id}, ${p.available === false})" aria-label="Toggle availability">${p.available === false ? "◻" : "◼"}</button>
        <button class="delete-btn" onclick="deleteProduct(${p.id})" aria-label="Delete">×</button>
      </div>
    </div>`).join("");
}
async function previewProductImage(e) {
  const file = pickedPhoto(e.target);
  if (!file) return;

  const label = document.getElementById("product-file-name");
  label.textContent = "Preparing photo…";

  // Same pipeline as a profile photo, at a larger edge: a dish is shown full
  // width, so it keeps more detail than an avatar ever could use.
  const image = await shrinkPhoto(file, PHOTO_PRODUCT_EDGE);
  if (!image) {
    label.textContent = "Choose image from storage / album";
    toast("Photo Not Used", "That photo could not be read. Please choose another one.");
    return;
  }

  productImageData = image;
  label.textContent = file.name;
  const preview = document.getElementById("product-image-preview");
  preview.src = image;
  preview.style.display = "block";
}
function startEditProduct(id) {
  const p = products().find(x => x.id === Number(id)); if (!p) return;
  editingProductId = p.id;
  document.getElementById("product-name").value = p.name;
  document.getElementById("product-price").value = p.price;
  document.getElementById("product-category").value = p.category || "";
  document.getElementById("product-description").value = p.desc || "";
  productImageData = "";
  const prev = document.getElementById("product-image-preview");
  prev.src = p.img; prev.style.display = "block";
  document.getElementById("product-file-name").textContent = "Keep current photo or choose a new one";
  document.getElementById("product-form-title").textContent = "Edit Food";
  const sub = document.getElementById("product-form-sub");
  if (sub) sub.textContent = `Editing ${p.name}.`;
  document.getElementById("product-form-icon").textContent = "✎";
  document.getElementById("product-submit-btn").textContent = "Save Changes";
  document.getElementById("product-cancel-btn").style.display = "block";
  document.getElementById("product-name").scrollIntoView({ behavior: "smooth", block: "center" });
}
function resetProductForm() {
  editingProductId = null; productImageData = "";
  ["product-name", "product-price", "product-description"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("product-image-file").value = "";
  document.getElementById("product-file-name").textContent = "Choose image from storage / album";
  document.getElementById("product-image-preview").style.display = "none";
  document.getElementById("product-form-title").textContent = "Add Food";
  const sub = document.getElementById("product-form-sub");
  if (sub) sub.textContent = "";
  document.getElementById("product-form-icon").textContent = "+";
  document.getElementById("product-submit-btn").textContent = "Add Product";
  document.getElementById("product-cancel-btn").style.display = "none";
}
async function submitProduct() {
  const name = document.getElementById("product-name").value.trim();
  const price = Number(document.getElementById("product-price").value);
  const category = document.getElementById("product-category").value;
  const desc = document.getElementById("product-description").value.trim();
  if (!name || !price || price <= 0) { showAlert("Please enter a food name and a valid price."); return; }
  if (!category) { showAlert("Please choose a category."); return; }
  if (!editingProductId && !productImageData) { showAlert("Please choose a product image from your storage or album."); return; }
  try {
    await api("products.php", editingProductId
      ? { action: "update", id: editingProductId, name, price, category, desc, img: productImageData }
      : { action: "add", name, price, category, desc, img: productImageData });
    const wasEditing = editingProductId;
    await refreshStore();
    resetProductForm();
    renderAdminProducts(); renderAdminDashboard(); renderMenu(); renderHome();
    toast(wasEditing ? "Food Updated" : "Food Added", wasEditing ? "The food was updated." : "The food and its real image were saved.");
  } catch (e) { reportError(e); }
}
async function toggleProductAvailability(id, currentlyAvailable) {
  try {
    await api("products.php", { action: "availability", id, available: !currentlyAvailable });
    await refreshStore();
    renderAdminProducts(); renderMenu(); renderHome();
    toast("Availability", currentlyAvailable ? "Item marked as sold out." : "Item is available again.");
  } catch (e) { reportError(e); }
}
async function deleteProduct(id) {
  const sure = await confirmDialog({
    title: "Remove This Food?",
    message: "Remove this food? Past orders keep their saved copy.",
    confirmLabel: "Remove",
    danger: true,
  });
  if (!sure) return;
  try {
    await api("products.php", { action: "delete", id });
    if (editingProductId === id) resetProductForm();
    await refreshStore();
    renderAdminProducts(); renderAdminDashboard(); renderMenu(); renderHome(); renderFavorites();
    toast("Food Removed", "The product was removed.");
  } catch (e) { reportError(e); }
}

/* ---------- admin: settings ---------- */

const SETTINGS_TEXT = ["store_name", "store_tagline", "support_email", "support_phone", "order_prep_minutes", "order_cancel_window", "order_min_total", "password_min_length", "login_max_attempts", "login_lockout_minutes", "session_idle_minutes"];
const SETTINGS_TOGGLES = ["store_open", "order_auto_accept", "order_allow_cancel", "pay_cod_enabled", "privacy_show_contact", "privacy_show_notes"];

/** Fills the settings fields from the store, so whichever sheet opens shows the
    values the account currently holds. */
function fillSettingsForm() {
  SETTINGS_TEXT.forEach(key => {
    const el = document.getElementById(`set-${key}`);
    if (el) el.value = settingValue(key);
  });
  SETTINGS_TOGGLES.forEach(key => {
    const row = document.querySelector(`.toggle-row[data-setting="${key}"] .switch`);
    if (row) row.classList.toggle("on", settingOn(key));
  });
}

/** The Settings screen is only a menu now: the fields live in the sheets each
    option opens, so there is nothing to fill in on the screen itself. */
function renderAdminSettings() {
  settingsDirty = false;
  pendingSettings = null;
  updateSettingsHint();
}

/** Payment Option sheet: fill it, then show it. */
function openPaymentSettings() {
  fillSettingsForm();
  settingsDirty = false;
  pendingSettings = null;
  updateSettingsHint();
  openModal("modal-payment-settings");
}

/** Other Settings sheet: store, orders, privacy, security and account, in one. */
function openOtherSettings() {
  fillSettingsForm();
  settingsDirty = false;
  pendingSettings = null;
  updateSettingsHint();
  openModal("modal-other-settings");
}

/** Change Email sheet for the admin's sign-in address. */
function openChangeEmail() {
  document.getElementById("admin-email-new").value = admin().email || "";
  openModal("modal-change-email");
}

/** Saves a new sign-in email, leaving the rest of the admin profile as it is. */
async function submitAdminEmail() {
  const email = document.getElementById("admin-email-new").value.trim().toLowerCase();
  if (!validEmail(email)) { showAlert("Please enter a valid email address."); return; }
  const a = admin();
  if (email === (a.email || "").toLowerCase()) {
    try { await commitAdminEmail(a.name, email, a.phone, ""); } catch (e) { reportError(e); }
    return;
  }
  await beginChangeCode("admin", "email", code => commitAdminEmail(a.name, email, a.phone, code));
}
async function commitAdminEmail(name, email, phone, code) {
  await api("admin.php", { action: "update_profile", name, email, phone, code });
  await refreshStore();
  closeModal("modal-change-email");
  renderAdminSettings(); renderAdminDashboard();
  toast("Email Updated", "Your sign-in email was updated.");
}
function updateSettingsHint(text) {
  const el = document.getElementById("settings-hint");
  if (!el) return;
  el.textContent = text || (settingsDirty ? "You have unsaved changes." : "No changes yet.");
  el.classList.toggle("dirty", settingsDirty);
}
function markSettingsDirty() { settingsDirty = true; updateSettingsHint(); }
function toggleSetting(key) {
  if (!SETTINGS_TOGGLES.includes(key)) return;
  const row = document.querySelector(`.toggle-row[data-setting="${key}"] .switch`);
  if (!row) return;
  row.classList.toggle("on");
  markSettingsDirty();
}
function collectSettings() {
  const out = {};
  SETTINGS_TEXT.forEach(key => { const el = document.getElementById(`set-${key}`); if (el) out[key] = el.value.trim(); });
  SETTINGS_TOGGLES.forEach(key => {
    const row = document.querySelector(`.toggle-row[data-setting="${key}"] .switch`);
    if (row) out[key] = row.classList.contains("on") ? "1" : "0";
  });
  return out;
}
async function saveSettings() {
  if (!settingsDirty) { toast("Nothing to Save", "You have not changed any setting."); return; }
  pendingSettings = collectSettings();
  document.getElementById("confirm-settings-pass").value = "";
  openModal("modal-confirm-settings");
}
async function submitSettingsWithPassword() {
  const pass = document.getElementById("confirm-settings-pass").value;
  if (!pass) { showAlert("Please enter your admin password."); return; }
  const payload = pendingSettings || collectSettings();
  closeModal("modal-confirm-settings");
  await commitSettings(payload, pass);
}
async function commitSettings(payload, password) {
  try {
    await api("admin.php", { action: "save_settings", settings: payload, password });
    await refreshStore();
    closeModal("modal-other-settings");
    closeModal("modal-payment-settings");
    renderAdminSettings();
    renderAdminDashboard();
    toast("Settings Saved", "Your changes are now live.");
  } catch (e) { reportError(e); }
}
function openAdminProfile() {
  const a = admin();
  document.getElementById("admin-edit-name").value = a.name || "";
  document.getElementById("admin-edit-email").value = a.email || "";
  document.getElementById("admin-edit-phone").value = a.phone || "";
  openModal("modal-admin-profile");
}
async function saveAdminProfile() {
  const name = document.getElementById("admin-edit-name").value.trim();
  const email = document.getElementById("admin-edit-email").value.trim().toLowerCase();
  const phone = document.getElementById("admin-edit-phone").value.trim();
  if (!validName(name)) { showAlert("Please enter a valid full name."); return; }
  if (!validEmail(email)) { showAlert("Please enter a valid email address."); return; }
  if (phone && !validPhone(phone)) { showAlert("Please enter a valid 11-digit Philippine mobile number."); return; }
  // Only a change of the sign-in email needs a code; the rest of the profile does not.
  if (email === (admin().email || "").toLowerCase()) {
    try { await commitAdminProfile(name, email, phone, ""); } catch (e) { reportError(e); }
    return;
  }
  await beginChangeCode("admin", "email", code => commitAdminProfile(name, email, phone, code));
}
async function commitAdminProfile(name, email, phone, code) {
  await api("admin.php", { action: "update_profile", name, email, phone, code });
  await refreshStore();
  closeModal("modal-admin-profile");
  renderAdminSettings(); renderAdminDashboard();
  toast("Profile Updated", "Your admin profile was updated.");
}
function changeAdminPicture() { document.getElementById("admin-file").click(); }
async function saveAdminPicture(e) {
  const file = pickedPhoto(e.target);
  if (!file) return;

  const image = await shrinkPhoto(file);
  if (!image) { toast("Photo Not Used", "That photo could not be read. Please choose another one."); return; }
  try {
    await api("admin.php", { action: "update_profile", name: admin().name, email: admin().email, phone: admin().phone, image });
    await refreshStore();
    renderAdminSettings();
    toast("Photo Updated", "Your admin photo was updated.");
  } catch (err) { reportError(err); }
}
function openAdminPasswordModal() {
  ["admin-pw-current", "admin-pw-new", "admin-pw-confirm"].forEach(id => { document.getElementById(id).value = ""; });
  updatePasswordHint("admin-pw-new", "admin-pw-hint");
  renderPasswordRules("admin-pw-rules");
  openModal("modal-admin-password");
}
async function submitAdminPassword() {
  const current = document.getElementById("admin-pw-current").value;
  const next = document.getElementById("admin-pw-new").value;
  const confirm = document.getElementById("admin-pw-confirm").value;
  if (!current || !next) { showAlert("Please complete all password fields."); return; }
  if (next !== confirm) { showAlert("The new passwords do not match."); return; }
  const weak = passwordProblem(next); if (weak) { showAlert(weak); return; }
  await beginChangeCode("admin", "password", code => commitAdminPassword(current, next, confirm, code));
}
async function commitAdminPassword(current, next, confirm, code) {
  const res = await api("admin.php", { action: "change_password", current_password: current, new_password: next, confirm_password: confirm, code });
  await refreshStore();
  closeModal("modal-admin-password");
  loadSecurityReport();
  toast("Password Updated", res.message || "Your password was updated.");
}
async function adminSignOutOthers() {
  try {
    const res = await api("admin.php", { action: "signout_others" });
    await refreshStore();
    toast("Devices Signed Out", res.message || "All other devices have been signed out.");
  } catch (e) { reportError(e); }
}
async function clearLoginLog() {
  const sure = await confirmDialog({
    title: "Clear Sign-In Log?",
    message: "Clear the stored failed sign-in attempts?",
    confirmLabel: "Clear",
    danger: true,
  });
  if (!sure) return;
  try {
    const res = await api("admin.php", { action: "clear_login_log" });
    await loadSecurityReport();
    toast("Log Cleared", res.message || "Sign-in attempt log cleared.");
  } catch (e) { reportError(e); }
}
async function loadSecurityReport() {
  try {
    const res = await api("admin.php", { action: "security_report" });
    const passed = res.checks.filter(c => c.ok).length;
    const total = res.checks.length;
    const pct = Math.round((passed / total) * 100);
    const tone = pct >= 80 ? "good" : pct >= 50 ? "fair" : "weak";
    const bar = document.getElementById("security-score");
    if (bar) {
      bar.className = `security-score ${tone}`;
      bar.innerHTML = `
        <div class="ss-head"><div><b>Security score</b><small>${passed} of ${total} checks passed</small></div><strong>${pct}%</strong></div>
        <div class="ss-bar"><i style="width:${pct}%"></i></div>
        <ul>${res.checks.map(c => `<li class="${c.ok ? "ok" : "warn"}"><span>${c.ok ? "✓" : "!"}</span><div><b>${esc(c.label)}</b><small>${esc(c.hint)}</small></div></li>`).join("")}</ul>`;
    }
    const sum = document.getElementById("security-summary");
    if (sum) sum.textContent = `${res.failed_attempts} failed attempt${res.failed_attempts === 1 ? "" : "s"} in the last 7 days`;
  } catch (e) { /* the report is informational only */ }
}

/* ---------- admin: categories, areas, announcements ---------- */

function renderAdminCategories() {
  document.getElementById("admin-category-list").innerHTML = categories().map((c, i) => `<div class="category-admin-row"><span class="big-icon">${esc(c.icon)}</span><b>${esc(c.name)}</b>${c.locked ? `<em class="locked-tag">System</em>` : `<button onclick="deleteCategory(${i})">Remove</button>`}</div>`).join("");
}
async function adminAddCategory() {
  const name = capitalize(document.getElementById("new-category-name").value.trim());
  const icon = document.getElementById("new-category-icon").value.trim() || "🍴";
  if (!name) { showAlert("Please enter a category name."); return; }
  try {
    await api("categories.php", { action: "add", name, icon });
    await refreshStore();
    document.getElementById("new-category-name").value = "";
    document.getElementById("new-category-icon").value = "";
    renderAdminCategories(); renderAdminProducts(); renderHome(); renderMenu();
    toast("Category Added", `${name} is now available in FOODAY.`);
  } catch (e) { reportError(e); }
}
async function deleteCategory(i) {
  const c = categories()[i];
  if (!c || c.locked) return;
  const sure = await confirmDialog({
    title: "Remove Category?",
    message: `Remove the "${c.name}" category?`,
    confirmLabel: "Remove",
    danger: true,
  });
  if (!sure) return;
  try {
    await api("categories.php", { action: "delete", name: c.name });
    await refreshStore();
    renderAdminCategories(); renderAdminProducts(); renderHome(); renderMenu();
    toast("Category Removed", "The category was removed.");
  } catch (e) { reportError(e); }
}
function renderDeliveryAreas() {
  document.getElementById("delivery-list").innerHTML = areas().map(a => `<div class="delivery-row" style="margin-bottom:8px"><div><b>${esc(a.name)}</b><small>Delivery fee</small></div><strong>${esc(a.fee)}</strong></div>`).join("");
}
async function addDeliveryArea() {
  const name = document.getElementById("area-name").value.trim();
  const feeRaw = document.getElementById("area-fee").value.trim();
  const fee = Number(feeRaw);
  if (!name || !feeRaw) { showAlert("Please enter the area and delivery fee."); return; }
  if (!Number.isFinite(fee) || fee < 0) { showAlert("Please enter a valid delivery fee — numbers only."); return; }
  try {
    await api("areas.php", { action: "add", name, fee: fee.toFixed(2) });
    await refreshStore();
    document.getElementById("area-name").value = "";
    document.getElementById("area-fee").value = "";
    renderDeliveryAreas(); prefillCheckout();
    toast("Area Saved", "Delivery area settings were updated.");
  } catch (e) { reportError(e); }
}
function renderAnnouncements() {
  const list = announcements();
  document.getElementById("announcements-list").innerHTML = list.length
    ? list.map(a => `<div class="announcement-admin"><span class="ann-icon">${esc(a.icon || "👏")}</span><div style="flex:1"><b>${esc(a.title)}</b><p>${esc(a.message)}</p><small>${esc(a.date)}</small></div><button onclick="deleteAnnouncement(${a.id})">Delete</button></div>`).join("")
    : `<div class="empty">No announcements posted yet.</div>`;
}
async function publishAnnouncement() {
  const title = document.getElementById("announcement-title").value.trim();
  const message = document.getElementById("announcement-message").value.trim();
  const icon = document.getElementById("announcement-icon").value.trim() || "👏";
  if (!title || !message) { showAlert("Please enter an announcement title and message."); return; }
  try {
    await api("announcements.php", { action: "add", title, message, icon });
    await refreshStore();
    document.getElementById("announcement-title").value = "";
    document.getElementById("announcement-message").value = "";
    document.getElementById("announcement-icon").value = "";
    renderAnnouncements(); renderHome();
    toast("Announcement Posted", "Your announcement is now visible on Home.");
  } catch (e) { reportError(e); }
}
async function deleteAnnouncement(id) {
  const sure = await confirmDialog({
    title: "Delete Announcement?",
    message: "Delete this announcement?",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!sure) return;
  try {
    await api("announcements.php", { action: "delete", id });
    await refreshStore();
    renderAnnouncements(); renderHome();
  } catch (e) { reportError(e); }
}

/* ---------- boot ---------- */

function applyBranding() {
  const c = config();
  const name = c.store_name || "FOODAY";
  const tagline = c.store_tagline || "Good Food, Anytime, Anywhere.";
  document.getElementById("splash-brand").textContent = name;
  document.getElementById("splash-tagline").innerHTML = `${esc(tagline)} <span class="gold-heart">♥</span>`;
  document.title = name;
}

async function init() {
  try {
    await refreshStore();
  } catch (e) {
    showAlert(e.message, "Cannot Reach the Server");
    return;
  }
  applyBranding();
  updateCartCount();
  cartFabInit();
  startLiveSync();
  renderHome();
  if (STORE.sessionExpired) toast("Signed Out", "You were signed out after a period of inactivity.");
  if (STORE.admin) navigateTo("screen-admin-dashboard");
  else if (STORE.user) navigateTo("screen-home");
}
document.addEventListener("DOMContentLoaded", init);
/* Coming back to the tab is the most likely moment for a status to have moved. */
document.addEventListener("visibilitychange", () => { if (!document.hidden) tickLiveSync(); });
