import { api } from "./api.js";
import { h, mount, toast, modal, confirmBox, promptBox, field, badge, localISODate, downloadUrl } from "./ui.js";
import * as qzs from "./qz.js";
import * as printing from "./printing.js";
import { computeTotals, formatAmount, formatMoneyDisplay, formatQty, formatDecimal, parseAmount, parseQty, grossToNetCents, netToGrossCents, formatRate } from "/shared/money.js";
import { layoutReceipt, receiptLinesToHtml, hasNonAscii, sampleReferenceReceipt, SAMPLE_RECEIPT_SOURCE, buildReceiptFromTransaction } from "/shared/receipt.js";

const app = document.getElementById("app");
let user = null;
let settings = null;
let currentPage = null;

const money = (c) => formatMoneyDisplay(c);
const etb = (c) => `${money(c)} ${settings?.currency || "ETB"}`;
const isAdmin = () => user?.role === "admin";

api.onUnauthorized = () => { if (user) { user = null; toast("Your session ended. Please sign in again.", "bad"); boot(); } };

// ---------------------------------------------------------------- boot / auth
async function boot() {
  let state;
  try { state = await api.get("/api/state"); } catch (e) { return mount(app, h("div", { class: "login-wrap" }, h("div", { class: "ink-card login-card" }, h("h2", null, "Server unavailable"), h("p", null, e.message), h("button", { class: "ink-btn", style: { marginTop: "14px" }, onclick: boot }, "Try again")))); }
  if (state.setupRequired) return setupScreen();
  if (!state.user) return loginScreen();
  user = state.user;
  settings = await api.get("/api/settings");
  shell();
}

function brandBlock(subtitle) {
  return [
    h("div", { class: "login-title" }, settings?.business?.displayName || "Restaurant"),
    h("div", { class: "divider-ornate" }, "❦   ❦   ❦"),
    h("div", { class: "muted small", style: { textAlign: "center", letterSpacing: ".2em", textTransform: "uppercase", marginBottom: "22px" } }, subtitle),
  ];
}

function loginScreen() {
  const u = h("input", { class: "ink-input", placeholder: "Username", autocomplete: "username", style: { marginBottom: "10px" } });
  const p = h("input", { class: "ink-input", type: "password", placeholder: "Password", autocomplete: "current-password", style: { marginBottom: "6px" } });
  const err = h("div", { class: "err" });
  const btn = h("button", { class: "ink-btn", style: { width: "100%", padding: "13px" } }, "Sign In");
  const submit = async () => {
    btn.disabled = true; err.textContent = "";
    try { const r = await api.post("/api/login", { username: u.value, password: p.value }); user = r.user; settings = await api.get("/api/settings"); shell(); }
    catch (e) { err.textContent = e.message; btn.disabled = false; }
  };
  btn.onclick = submit;
  p.addEventListener("keydown", (e) => e.key === "Enter" && submit());
  mount(app, h("div", { class: "login-wrap" }, h("div", { class: "ink-card login-card" }, ...brandBlock("Restaurant management · sign in"), u, p, err, btn)));
  u.focus();
}

function setupScreen() {
  const code = h("input", { class: "ink-input", placeholder: "e.g. 7F3A9C21B0", autocomplete: "off" });
  const name = h("input", { class: "ink-input", placeholder: "Your name" });
  const un = h("input", { class: "ink-input", placeholder: "admin username", autocomplete: "username" });
  const p1 = h("input", { class: "ink-input", type: "password", autocomplete: "new-password" });
  const p2 = h("input", { class: "ink-input", type: "password", autocomplete: "new-password" });
  const err = h("div", { class: "err" });
  const go = async () => {
    err.textContent = "";
    if (p1.value !== p2.value) { err.textContent = "Passwords do not match."; return; }
    try { const r = await api.post("/api/setup", { setupCode: code.value, name: name.value, username: un.value, password: p1.value }); user = r.user; settings = await api.get("/api/settings"); toast("Administrator account created."); location.hash = "#/settings"; shell(); }
    catch (e) { err.textContent = e.message; }
  };
  mount(app, h("div", { class: "login-wrap" }, h("div", { class: "ink-card login-card", style: { maxWidth: "480px" } },
    ...brandBlock("First-time setup"),
    h("div", { class: "notice" }, "No administrator exists yet. Enter the setup code shown in the server window (also saved in ", h("span", { class: "mono" }, "data/SETUP-TOKEN.txt"), ") and choose the administrator's username and password."),
    field("Setup code", code), field("Administrator name", name), field("Username", un), field("Password (at least 8 characters)", p1), field("Repeat password", p2), err,
    h("button", { class: "ink-btn", style: { width: "100%", padding: "13px" }, onclick: go }, "Create administrator"))));
  code.focus();
}

async function changeOwnPassword() {
  await modal((close) => {
    const cur = h("input", { class: "ink-input", type: "password", autocomplete: "current-password" });
    const n1 = h("input", { class: "ink-input", type: "password", autocomplete: "new-password" });
    const n2 = h("input", { class: "ink-input", type: "password", autocomplete: "new-password" });
    const err = h("div", { class: "err" });
    const save = async () => {
      if (n1.value !== n2.value) { err.textContent = "New passwords do not match."; return; }
      try { await api.post("/api/me/password", { currentPassword: cur.value, newPassword: n1.value }); toast("Password changed."); close(true); } catch (e) { err.textContent = e.message; }
    };
    return [h("h2", null, "Change password"), field("Current password", cur), field("New password", n1), field("Repeat new password", n2), err,
      h("div", { class: "modal-actions" }, h("button", { class: "ink-btn-ghost plain", onclick: () => close() }, "Back"), h("button", { class: "ink-btn", onclick: save }, "Change password"))];
  });
}

// ---------------------------------------------------------------- shell & routing
const PAGES = [
  { key: "dashboard", label: "Dashboard", render: dashboardPage },
  { key: "orders", label: "Orders", render: ordersPage },
  { key: "transactions", label: "Transactions", render: transactionsPage },
  { key: "menu", label: "Menu", render: menuPage },
  { key: "reports", label: "Reports", render: reportsPage, admin: true },
  { key: "printer", label: "Printer", render: printerPage },
  { key: "settings", label: "Settings", render: settingsPage, admin: true },
  { key: "sample", label: "Sample receipt", render: samplePage, hidden: true },
];

let mainEl, navEl, qzPill;
function shell() {
  navEl = h("nav", { class: "nav" });
  const dot = h("span", { class: "dot" });
  const qzLabel = h("span", null, "Printer offline");
  qzPill = h("button", { class: "qz-pill", title: "QZ Tray status — open Printer page", onclick: () => go("printer") }, dot, qzLabel);
  qzs.onQzState((s) => {
    dot.className = "dot " + (s.status === "connected" ? "ok" : s.status === "connecting" ? "wait" : "bad");
    qzLabel.textContent = s.status === "connected" ? "QZ connected" : s.status === "connecting" ? "Connecting" : "QZ offline";
  });
  const brandName = h("span", null, settings.business.displayName || "Restaurant");
  mainEl = h("main", { id: "main" });
  mount(app,
    h("header", { class: "topbar" },
      h("div", { class: "brand" }, brandName, h("b", null, ".")),
      navEl,
      h("div", { class: "who" }, qzPill,
        h("button", { style: { border: "none", color: "var(--line)" }, title: "Change password", onclick: changeOwnPassword }, `${user.name} · ${user.role}`),
        h("button", { onclick: async () => { await api.post("/api/logout"); user = null; history.replaceState(null, "", "#/dashboard"); try { await qzs.disconnect(); } catch {} boot(); } }, "Sign Out"))),
    mainEl);
  window.onhashchange = route;
  route();
  qzs.connect().catch(() => { /* status pill shows offline; Printer page explains */ });
}

function go(key) { location.hash = "#/" + key; }
function route() {
  const key = (location.hash.replace(/^#\//, "").split("?")[0]) || "dashboard";
  const page = PAGES.find((p) => p.key === key && (!p.admin || isAdmin())) || PAGES[0];
  currentPage = page.key;
  mount(navEl, PAGES.filter((p) => !p.hidden && (!p.admin || isAdmin())).map((p) => h("button", { class: p.key === page.key ? "active" : "", onclick: () => go(p.key) }, p.label)));
  mount(mainEl, h("div", { class: "muted" }, "Loading…"));
  Promise.resolve(page.render(mainEl)).catch((e) => mount(mainEl, h("div", { class: "notice bad" }, e.message)));
}
const stillOn = (key) => currentPage === key;

// ---------------------------------------------------------------- dashboard
async function dashboardPage(el) {
  const [d, tables] = await Promise.all([api.get("/api/dashboard"), api.get("/api/tables")]);
  const stat = (label, value, unit, onclick) => h("div", { class: "ink-card", style: { cursor: onclick ? "pointer" : "default" }, onclick }, h("div", { class: "stat-label" }, label), h("div", { class: "stat-value" }, value, unit ? h("small", null, " " + unit) : null));
  const active = tables.filter((t) => t.active);
  mount(el,
    h("h1", null, "Good day."),
    h("div", { class: "sub" }, `${settings.business.displayName} — ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`),
    h("div", { class: "grid stats" },
      stat("Today's sales (incl. VAT)", money(d.salesCents), settings.currency, () => go("transactions")),
      stat("Completed transactions", d.completed, "", () => go("transactions")),
      stat("Unpaid orders", d.unpaidOrders, "", () => go("orders")),
      stat("Occupied tables", `${d.occupiedTables} / ${d.tables}`, "", () => go("orders"))),
    d.unprintedToday ? h("div", { class: "notice bad" }, `${d.unprintedToday} sale(s) today have no successful receipt print. Open Transactions to print them.`) : null,
    h("div", { class: "two-col" },
      h("div", { class: "ink-card" },
        h("div", { class: "spread" }, h("h2", null, "Recent transactions"), h("button", { class: "ink-btn-ghost btn-sm", onclick: () => go("transactions") }, "All transactions")),
        d.recent.length ? h("table", { class: "list" },
          h("tr", null, h("th", null, "Receipt"), h("th", null, "Time"), h("th", null, "Order"), h("th", null, "Payment"), h("th", { class: "num" }, "Total"), h("th", null, "")),
          d.recent.map((t) => h("tr", { class: "click", onclick: () => receiptModal(t.id) },
            h("td", { class: "mono" }, pad8(t.receiptNo)), h("td", null, `${t.receiptDate} ${t.receiptTime.slice(0, 5)}`), h("td", null, orderLabel(t)), h("td", null, t.paymentLabel),
            h("td", { class: "num" }, money(t.totalCents)), h("td", null, t.status === "voided" ? badge("voided") : t.printedOk ? "" : h("span", { class: "badge st-cancelled" }, "not printed")))))
          : h("p", { class: "muted", style: { fontStyle: "italic", padding: "14px 0" } }, "No sales yet. ", h("button", { class: "ink-btn btn-sm", onclick: () => go("orders") }, "Take an order"))),
      h("div", { class: "ink-card" },
        h("h2", null, "Tables"),
        h("div", { class: "muted small", style: { marginBottom: "10px" } }, `Orders: ${d.ordersByStatus.open || 0} open · ${d.ordersByStatus.submitted || 0} in kitchen · ${d.ordersByStatus.ready || 0} ready`),
        h("div", { class: "table-grid" }, active.map((t) => h("button", { class: "table-tile " + (t.occupied ? "busy" : "free"), onclick: () => (t.occupied ? openOrder(t.openOrderId) : startOrder("dine_in", t.id)) },
          h("div", { class: "lb" }, t.label), h("div", { class: "small muted" }, t.occupied ? "occupied" : "free")))))));
}
const pad8 = (n) => String(n).padStart(8, "0");
const orderLabel = (o) => (o.orderType === "takeaway" ? "Takeaway" : "Table " + (o.tableLabel ?? ""));

// ---------------------------------------------------------------- orders
let selectedOrderId = null;
let orderFilter = "active";
let menuCat = null;

function openOrder(id) { selectedOrderId = id; if (currentPage === "orders") route(); else go("orders"); }
async function startOrder(type, tableId) {
  try {
    const o = await api.post("/api/orders", { orderType: type, tableId });
    selectedOrderId = o.id;
    toast(`Order #${o.id} started — ${orderLabel(o)}`, "info");
    if (currentPage === "orders") route(); else go("orders");
  } catch (e) { toast(e.message, "bad"); }
}

async function chooseTable() {
  const tables = (await api.get("/api/tables")).filter((t) => t.active);
  return modal((close) => [h("h2", null, "New dine-in order"), h("p", { class: "muted small", style: { marginBottom: "12px" } }, "Choose a table. Occupied tables open their current order."),
    h("div", { class: "table-grid" }, tables.map((t) => h("button", { class: "table-tile " + (t.occupied ? "busy" : "free"), onclick: () => close(t) }, h("div", { class: "lb" }, t.label), h("div", { class: "small muted" }, t.occupied ? "occupied" : "free")))),
    h("div", { class: "modal-actions" }, h("button", { class: "ink-btn-ghost plain", onclick: () => close() }, "Back"))]);
}

async function ordersPage(el) {
  const [orders, menu, categories] = await Promise.all([api.get("/api/orders?status=" + orderFilter), api.get("/api/menu"), api.get("/api/categories")]);
  if (!stillOn("orders")) return;
  let order = null;
  if (selectedOrderId) { try { order = await api.get("/api/orders/" + selectedOrderId); } catch { selectedOrderId = null; } }
  const editable = order && ["open", "submitted", "ready"].includes(order.status);
  const refresh = () => ordersPage(el);

  const newButtons = h("div", { class: "row", style: { marginBottom: "16px" } },
    h("button", { class: "ink-btn", onclick: async () => { const t = await chooseTable(); if (!t) return; if (t.occupied) openOrder(t.openOrderId); else startOrder("dine_in", t.id); } }, "+ Dine-in order"),
    h("button", { class: "ink-btn dark", onclick: () => startOrder("takeaway") }, "+ Takeaway order"));

  const filters = h("div", { class: "chips" }, [["active", "Active"], ["open", "Open"], ["submitted", "In kitchen"], ["ready", "Ready"], ["paid", "Paid"], ["cancelled", "Cancelled"]].map(([k, l]) =>
    h("button", { class: "chip" + (orderFilter === k ? " active" : ""), onclick: () => { orderFilter = k; refresh(); } }, l)));

  const orderCards = orders.length ? h("div", { class: "grid", style: { gridTemplateColumns: "repeat(auto-fill,minmax(210px,1fr))" } }, orders.map((o) => h("div", { class: "ink-card order-card" + (o.id === selectedOrderId ? " sel" : ""), onclick: () => { selectedOrderId = o.id; refresh(); } },
    h("div", { class: "spread" }, h("b", null, `#${o.id} · ${orderLabel(o)}`), badge(o.status)),
    h("div", { class: "muted small", style: { margin: "6px 0" } }, `${o.items.length} line(s) · ${new Date(o.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} · ${o.createdBy}`),
    h("div", { class: "serif", style: { fontSize: "18px" } }, etb(o.totals.totalCents)))))
    : h("p", { class: "muted", style: { fontStyle: "italic" } }, "No orders in this view.");

  // Menu picker for the selected editable order
  const cats = categories.filter((c) => c.active);
  if (!menuCat || !cats.some((c) => c.id === menuCat)) menuCat = cats[0]?.id ?? null;
  const menuSection = editable ? h("div", null,
    h("div", { class: "spread", style: { marginBottom: "10px" } }, h("h2", null, `Add to order #${order.id}`), h("button", { class: "ink-btn-ghost btn-sm plain", onclick: () => { selectedOrderId = null; refresh(); } }, "← All orders")),
    h("div", { class: "chips" }, cats.map((c) => h("button", { class: "chip" + (menuCat === c.id ? " active" : ""), onclick: () => { menuCat = c.id; refresh(); } }, c.name))),
    h("div", { class: "menu-grid" }, menu.filter((m) => m.categoryId === menuCat).map((m) => h("button", { class: "menu-tile" + (m.available ? "" : " off"), disabled: !m.available, title: m.available ? "Add to order" : "Unavailable",
      onclick: () => addItem(order, m, refresh) },
      h("div", { class: "nm" }, m.name), h("div", { class: "pr" }, `${formatAmount(m.priceCents)}${m.unit === "kg" ? " /kg" : ""}`), !m.available && h("div", { class: "small" }, "Unavailable"))))) : null;

  mount(el,
    h("h1", null, "Orders"),
    h("div", { class: "sub" }, "Dine-in and takeaway orders: add items, send to the kitchen, bill and take payment."),
    h("div", { class: "two-col" },
      h("div", null, editable ? menuSection : [newButtons, filters, orderCards]),
      orderPanel(order, refresh)));
}

async function addItem(order, m, refresh) {
  let qty = 1000;
  if (m.unit === "kg") {
    const v = await promptBox(`Weight — ${m.name}`, "Weight in kg (e.g. 1.000, 0.500)", { value: "1.000", okLabel: "Add" });
    if (v === undefined) return;
    qty = parseQty(v);
    if (!qty) { toast("Enter a weight such as 0.750", "bad"); return; }
  }
  try { await api.post(`/api/orders/${order.id}/items`, { menuItemId: m.id, qty }); refresh(); } catch (e) { toast(e.message, "bad"); }
}

function orderPanel(order, refresh) {
  if (!order) return h("div", { class: "ink-card" }, h("h2", null, "No order selected"), h("p", { class: "muted" }, "Start a dine-in or takeaway order, or select one from the list."));
  const editable = ["open", "submitted", "ready"].includes(order.status);
  const call = async (fn) => { try { await fn(); refresh(); } catch (e) { toast(e.message, "bad"); } };
  const setStatus = (status, reason) => call(() => api.post(`/api/orders/${order.id}/status`, { status, reason }));

  const lines = order.items.map((it) => {
    const step = it.unit === "kg" ? 250 : 1000;
    const qtyInput = h("input", { value: formatDecimal(it.qtyMilli, 3).replace(/\.?0+$/, ""), inputmode: "decimal", disabled: !editable, "aria-label": "Quantity" });
    const commit = () => { const q = parseQty(qtyInput.value); if (!q) { toast("Invalid quantity", "bad"); qtyInput.value = formatDecimal(it.qtyMilli, 3).replace(/\.?0+$/, ""); return; } if (q !== it.qtyMilli) call(() => api.patch(`/api/orders/${order.id}/items/${it.id}`, { qty: q })); };
    qtyInput.addEventListener("change", commit);
    qtyInput.addEventListener("keydown", (e) => e.key === "Enter" && qtyInput.blur());
    return h("div", { class: "order-line" },
      h("div", { class: "top" }, h("div", null, h("b", null, it.name), h("div", { class: "muted small mono" }, `${formatQty(it.qtyMilli, it.unit)} x ${formatAmount(it.unitPriceCents)}`)), h("div", { class: "mono" }, formatAmount(it.amountCents))),
      it.note && h("div", { class: "small", style: { color: "var(--accent-dark)", margin: "4px 0" } }, "Note: " + it.note),
      editable && h("div", { class: "row", style: { marginTop: "6px" } },
        h("div", { class: "qty" },
          h("button", { title: "Less", disabled: it.qtyMilli <= step, onclick: () => call(() => api.patch(`/api/orders/${order.id}/items/${it.id}`, { qty: it.qtyMilli - step })) }, "−"),
          qtyInput,
          h("button", { title: "More", onclick: () => call(() => api.patch(`/api/orders/${order.id}/items/${it.id}`, { qty: it.qtyMilli + step })) }, "+")),
        h("button", { class: "ink-btn-ghost btn-sm plain", onclick: async () => { const n = await promptBox("Line note", "Note for the kitchen (e.g. no onion)", { value: it.note, required: false, okLabel: "Save" }); if (n !== undefined) call(() => api.patch(`/api/orders/${order.id}/items/${it.id}`, { note: n })); } }, it.note ? "Edit note" : "Note"),
        h("button", { class: "ink-btn-ghost btn-sm", title: "Remove line", onclick: () => call(() => api.del(`/api/orders/${order.id}/items/${it.id}`)) }, "Remove")));
  });

  const note = h("textarea", { class: "ink-input", placeholder: "Order note (allergies, timing, …)", disabled: !editable }, order.note);
  note.value = order.note;
  note.addEventListener("change", () => call(() => api.patch(`/api/orders/${order.id}`, { note: note.value })));

  const t = order.totals;
  const actions = [];
  if (order.status === "open") actions.push(h("button", { class: "ink-btn dark", disabled: !order.items.length, onclick: () => setStatus("submitted") }, "Send to kitchen"));
  if (order.status === "submitted") actions.push(h("button", { class: "ink-btn dark", onclick: () => setStatus("ready") }, "Mark ready"), h("button", { class: "ink-btn-ghost plain", onclick: () => setStatus("open") }, "Reopen"));
  if (order.status === "ready") actions.push(h("button", { class: "ink-btn-ghost plain", onclick: () => setStatus("submitted") }, "Back to kitchen"));
  if (editable) actions.push(h("button", { class: "ink-btn ok", disabled: !order.items.length, onclick: () => payModal(order, refresh) }, "Bill & pay"));
  if (editable && (order.status === "open" || isAdmin())) actions.push(h("button", { class: "ink-btn-ghost", onclick: async () => { const r = await promptBox(`Cancel order #${order.id}`, "Reason for cancelling", { okLabel: "Cancel order" }); if (r) setStatus("cancelled", r); } }, "Cancel order"));
  if (order.status === "paid" && order.transactionId) actions.push(h("button", { class: "ink-btn", onclick: () => receiptModal(order.transactionId) }, `Receipt ${pad8(order.receiptNo)}`));

  return h("div", { class: "ink-card" },
    h("div", { class: "spread" }, h("h2", null, `Order #${order.id}`), badge(order.status)),
    h("div", { class: "row muted small", style: { marginBottom: "8px" } }, orderLabel(order), "·", `by ${order.createdBy}`,
      editable && h("button", { class: "ink-btn-ghost btn-sm plain", onclick: () => changeOrderType(order, refresh) }, "Change table / type")),
    order.cancelReason && h("div", { class: "notice bad" }, "Cancelled: " + order.cancelReason),
    lines.length ? lines : h("p", { class: "muted", style: { padding: "16px 0", fontStyle: "italic" } }, editable ? "Tap menu items on the left to add them." : "No items."),
    h("div", { style: { margin: "12px 0" } }, note),
    h("div", { class: "totals" },
      t.taxGroups.map((g) => [h("div", null, h("span", null, `Taxable ${formatRate(g.rateBp)}%`), h("span", { class: "mono" }, formatAmount(g.taxableCents))), h("div", null, h("span", null, `VAT ${formatRate(g.rateBp)}%`), h("span", { class: "mono" }, formatAmount(g.taxCents)))]),
      h("div", { class: "grand" }, h("span", null, "Total"), h("span", null, etb(t.totalCents)))),
    h("div", { class: "row", style: { marginTop: "16px" } }, actions));
}

async function changeOrderType(order, refresh) {
  const tables = (await api.get("/api/tables")).filter((t) => t.active);
  const res = await modal((close) => [h("h2", null, "Change table / order type"),
    h("div", { class: "row", style: { marginBottom: "12px" } }, h("button", { class: "ink-btn dark", onclick: () => close({ orderType: "takeaway" }) }, "Make takeaway")),
    h("p", { class: "muted small", style: { marginBottom: "8px" } }, "Or move to table:"),
    h("div", { class: "table-grid" }, tables.map((t) => h("button", { class: "table-tile " + (t.occupied && t.id !== order.tableId ? "busy" : "free"), onclick: () => close({ orderType: "dine_in", tableId: t.id }) }, h("div", { class: "lb" }, t.label)))),
    h("div", { class: "modal-actions" }, h("button", { class: "ink-btn-ghost plain", onclick: () => close() }, "Back"))]);
  if (!res) return;
  try { await api.patch(`/api/orders/${order.id}`, res); refresh(); } catch (e) { toast(e.message, "bad"); }
}

// ---------------------------------------------------------------- payment
async function payModal(order, refresh) {
  const methods = settings.paymentMethods.filter((m) => m.enabled);
  const key = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2));
  const total = order.totals.totalCents;
  const tx = await modal((close) => {
    let method = methods[0]?.id;
    const err = h("div", { class: "err" });
    const tendered = h("input", { class: "ink-input mono", inputmode: "decimal", placeholder: formatAmount(total) });
    const change = h("div", { class: "serif", style: { fontSize: "20px" } }, "Change: 0.00");
    const ref = h("input", { class: "ink-input", placeholder: "Transaction / approval reference (optional)" });
    const tin = h("input", { class: "ink-input mono", inputmode: "numeric", maxlength: "10", placeholder: "10 digits (optional)" });
    const bname = h("input", { class: "ink-input", maxlength: "40", placeholder: "Optional" });
    const cashBox = h("div");
    const refBox = h("div");
    const updateChange = () => { const c = parseAmount(tendered.value); change.textContent = "Change: " + (c === null ? "—" : c >= total ? formatAmount(c - total) : "amount too low"); };
    tendered.addEventListener("input", updateChange);
    const quick = [total, Math.ceil(total / 5000) * 5000, Math.ceil(total / 10000) * 10000, Math.ceil(total / 50000) * 50000].filter((v, i, a) => a.indexOf(v) === i);
    mount(cashBox, field("Amount received (cash)", tendered), h("div", { class: "row", style: { marginBottom: "8px" } }, quick.map((q) => h("button", { class: "ink-btn-ghost btn-sm plain", onclick: () => { tendered.value = formatAmount(q); updateChange(); } }, formatAmount(q)))), change);
    mount(refBox, field("Payment reference", ref));
    const mBtns = h("div", { class: "pay-methods" });
    const drawMethods = () => {
      mount(mBtns, methods.map((m) => h("button", { class: method === m.id ? "active" : "", onclick: () => { method = m.id; drawMethods(); } }, m.label)));
      cashBox.classList.toggle("hidden", method !== "cash");
      refBox.classList.toggle("hidden", method === "cash");
    };
    drawMethods();
    const confirm = h("button", { class: "ink-btn ok" }, "Confirm payment");
    confirm.onclick = async () => {
      err.textContent = "";
      if (method === "cash" && tendered.value.trim()) { const c = parseAmount(tendered.value); if (c === null || c < total) { err.textContent = "Amount received must be at least the total."; return; } }
      confirm.disabled = true; confirm.textContent = "Saving…";
      try {
        const res = await api.post(`/api/orders/${order.id}/pay`, { idempotencyKey: key, method, tendered: method === "cash" ? tendered.value.trim() : undefined, reference: ref.value, buyerTin: tin.value.trim(), buyerName: bname.value.trim(), expectedTotalCents: total });
        close(res);
      } catch (e) {
        // Safe to retry: the same request key can never create a second sale.
        err.textContent = e.message + (e.network ? " Press Confirm again to retry — the sale will not be duplicated." : "");
        confirm.disabled = false; confirm.textContent = "Confirm payment";
      }
    };
    return [h("h2", null, `Bill — order #${order.id}`), h("div", { class: "muted small", style: { marginBottom: "10px" } }, orderLabel(order)),
      h("div", { class: "totals", style: { marginBottom: "14px" } },
        order.totals.taxGroups.map((g) => [h("div", null, h("span", null, `TXBL ${g.index} (${formatRate(g.rateBp)}%)`), h("span", { class: "mono" }, formatAmount(g.taxableCents))), h("div", null, h("span", null, `TAX ${g.index} (${formatRate(g.rateBp)}%)`), h("span", { class: "mono" }, formatAmount(g.taxCents)))]),
        h("div", { class: "grand" }, h("span", null, "TOTAL"), h("span", null, etb(total)))),
      field("Payment method", mBtns), cashBox, refBox,
      h("details", { style: { margin: "10px 0" } }, h("summary", { class: "small", style: { cursor: "pointer" } }, "Buyer details (printed as Buyer's TIN / NAME)"), h("div", { style: { marginTop: "10px" } }, field("Buyer's TIN", tin), field("Buyer's name", bname))),
      err,
      h("div", { class: "modal-actions" }, h("button", { class: "ink-btn-ghost plain", onclick: () => close() }, "Back"), confirm)];
  });
  if (!tx) return;
  toast(`Sale saved — receipt ${pad8(tx.receiptNo)}${tx.replay ? " (already recorded)" : ""}`);
  selectedOrderId = null;
  refresh();
  receiptModal(tx.id, { autoPrint: settings.autoPrint && !tx.replay, openDrawer: tx.paymentMethod === "cash" });
}

// ---------------------------------------------------------------- receipt preview / print
function receiptPreview(lines, cfg, { caption, watermark } = {}) {
  const scale = 1.55; // on-screen magnification of the true paper size
  const pxPerMm = 3.78 * scale;
  const fontPx = (cfg.printableWidthMm * pxPerMm) / (cfg.charsPerLine * 0.6);
  return h("div", null,
    caption && h("div", { class: "rc-caption" }, caption),
    h("div", { class: "rc-paper", style: { width: cfg.paperWidthMm * pxPerMm + "px" } },
      watermark && h("div", { class: "rc-watermark" }, watermark),
      h("div", { class: "rc", style: { width: cfg.printableWidthMm * pxPerMm + "px", fontSize: fontPx.toFixed(2) + "px" }, html: receiptLinesToHtml(lines) })));
}

async function receiptModal(txId, { autoPrint = false, openDrawer = false } = {}) {
  let tx = await api.get("/api/transactions/" + txId);
  const cfg = printing.getPrintConfig();
  await modal((close) => {
    const stage = h("div", { class: "receipt-stage" });
    const info = h("div");
    const buttons = h("div", { class: "modal-actions" });
    const draw = () => {
      const willCopy = tx.printedOk;
      mount(stage, receiptPreview(printing.receiptLines(tx, { copy: willCopy, config: cfg }), cfg, { caption: willCopy ? "Next print will be marked COPY" : "What will print" }));
      const last = tx.prints.filter((p) => p.kind !== "test").slice(-1)[0];
      mount(info,
        tx.status === "voided" && h("div", { class: "notice bad" }, `VOIDED: ${tx.voidReason}`),
        h("div", { class: "small muted" }, `Receipt ${pad8(tx.receiptNo)} · ${tx.receiptDate} ${tx.receiptTime} · ${orderLabel(tx)} · ${tx.cashierName} · ${tx.paymentLabel}${tx.paymentRef ? " ref " + tx.paymentRef : ""}`),
        h("div", { class: "small muted" }, tx.fiscalFsNo ? `Fiscal register FS No.: ${tx.fiscalFsNo}` : "No fiscal-register FS No. recorded."),
        h("div", { class: "small", style: { marginTop: "6px" } }, last ? `Last print: ${last.status.toUpperCase()} (${last.kind}) ${last.error ? "— " + last.error : ""}` : "Not printed yet."),
        !cfg.printer && h("div", { class: "notice bad" }, "No printer selected on this computer. ", h("a", { href: "#/printer", onclick: () => close() }, "Open Printer settings"), "."));
      mount(buttons,
        h("button", { class: "ink-btn-ghost plain", onclick: () => close() }, "Close"),
        h("button", { class: "ink-btn-ghost plain", title: "Uses the browser print dialog instead of QZ Tray", onclick: () => doBrowserPrint() }, "Browser print (fallback)"),
        h("button", { class: "ink-btn-ghost plain", onclick: recordFs }, tx.fiscalFsNo ? "Edit FS No." : "Record FS No."),
        isAdmin() && tx.status !== "voided" && h("button", { class: "ink-btn-ghost", onclick: voidTx }, "Void sale"),
        h("button", { class: "ink-btn", onclick: () => doPrint() }, tx.printedOk ? "Reprint (COPY)" : "Print receipt"));
    };
    const reload = async () => { tx = await api.get("/api/transactions/" + txId); draw(); };
    const askReason = async () => (tx.printedOk ? promptBox("Reprint receipt", "Reason for reprint (recorded)", { okLabel: "Reprint", help: "The original was already printed. The reprint will be marked *** COPY ***." }) : "");
    const doPrint = async (drawer = false) => {
      const reason = await askReason();
      if (reason === undefined) return;
      mount(info, h("div", { class: "notice" }, "Sending to printer…"));
      const r = await printing.printTransaction(tx, { reason, openDrawer: drawer });
      await reload();
      if (r.ok) toast(r.copy ? "Copy sent to printer." : "Receipt sent to printer.");
      else info.prepend(h("div", { class: "notice bad" }, h("b", null, "Print failed: "), r.error, h("br"), "The sale is saved. Fix the problem and press Print again — this will not create another sale."));
    };
    const doBrowserPrint = async () => {
      const reason = await askReason();
      if (reason === undefined) return;
      try {
        const job = await printing.browserPrintTransaction(tx, { reason });
        const ok = await confirmBox("Browser print", "Did the receipt print correctly?", { okLabel: "Yes, printed" });
        await printing.finishBrowserJob(job.jobId, !!ok);
        await reload();
      } catch (e) { toast(e.message, "bad"); }
    };
    const recordFs = async () => {
      const v = await promptBox("Fiscal register FS No.", "FS No. printed by the fiscal cash register for this sale", { value: tx.fiscalFsNo, required: false, okLabel: "Save", help: "This app cannot generate fiscal numbers. Record the number from the register's receipt so both records can be matched." });
      if (v === undefined) return;
      try { await api.post(`/api/transactions/${tx.id}/fiscal`, { fiscalFsNo: v }); await reload(); toast("FS No. recorded."); } catch (e) { toast(e.message, "bad"); }
    };
    const voidTx = async () => {
      const r = await promptBox(`Void receipt ${pad8(tx.receiptNo)}`, "Reason (recorded; the receipt number stays used)", { okLabel: "Void sale" });
      if (!r) return;
      try { await api.post(`/api/transactions/${tx.id}/void`, { reason: r }); await reload(); toast("Sale voided."); } catch (e) { toast(e.message, "bad"); }
    };
    draw();
    if (autoPrint) setTimeout(() => doPrint(openDrawer), 50);
    return [h("div", { class: "spread" }, h("h2", null, `Receipt ${pad8(tx.receiptNo)}`), badge(tx.status)), info, h("div", { style: { margin: "12px 0" } }, stage), buttons];
  }, { wide: true });
  if (currentPage === "dashboard" || currentPage === "transactions") route();
}

// ---------------------------------------------------------------- transactions
const txQuery = { from: localISODate(), to: localISODate(), q: "", status: "", method: "" };
async function transactionsPage(el) {
  const form = h("div", { class: "row", style: { marginBottom: "14px" } });
  const from = h("input", { class: "ink-input", type: "date", value: txQuery.from, style: { width: "auto" } });
  const to = h("input", { class: "ink-input", type: "date", value: txQuery.to, style: { width: "auto" } });
  const q = h("input", { class: "ink-input", placeholder: "Receipt no., FS no., item, buyer, cashier, table", value: txQuery.q, style: { width: "320px", maxWidth: "100%" } });
  const status = h("select", { class: "ink-input", style: { width: "auto" } }, h("option", { value: "" }, "All statuses"), h("option", { value: "completed" }, "Completed"), h("option", { value: "voided" }, "Voided"));
  status.value = txQuery.status;
  const method = h("select", { class: "ink-input", style: { width: "auto" } }, h("option", { value: "" }, "All payments"), settings.paymentMethods.map((m) => h("option", { value: m.id }, m.label)));
  method.value = txQuery.method;
  const results = h("div");
  const params = () => new URLSearchParams(Object.entries(txQuery).filter(([, v]) => v)).toString();
  const load = async () => {
    Object.assign(txQuery, { from: from.value, to: to.value, q: q.value.trim(), status: status.value, method: method.value });
    const rows = await api.get("/api/transactions?" + params());
    const done = rows.filter((r) => r.status === "completed");
    const sum = (k) => done.reduce((a, r) => a + r[k], 0);
    mount(results,
      h("div", { class: "muted small", style: { marginBottom: "8px" } }, `${rows.length} transaction(s) · completed total ${etb(sum("totalCents"))} (net ${money(sum("netCents"))}, VAT ${money(sum("taxCents"))})`),
      h("div", { class: "table-scroll" }, h("table", { class: "list" },
        h("tr", null, ["Receipt", "Date", "Time", "Order", "Cashier", "Payment", "FS No.", "Total", "Status", "Printed"].map((c, i) => h("th", { class: i === 7 ? "num" : "" }, c))),
        rows.map((t) => h("tr", { class: "click", onclick: () => receiptModal(t.id) },
          h("td", { class: "mono" }, pad8(t.receiptNo)), h("td", null, t.receiptDate), h("td", null, t.receiptTime), h("td", null, orderLabel(t)), h("td", null, t.cashierName), h("td", null, t.paymentLabel),
          h("td", { class: "mono" }, t.fiscalFsNo || "—"), h("td", { class: "num" }, money(t.totalCents)), h("td", null, badge(t.status)), h("td", null, t.printedOk ? "yes" : h("span", { class: "badge st-cancelled" }, "no")))))));
    if (!rows.length) results.append(h("p", { class: "muted", style: { padding: "14px 0", fontStyle: "italic" } }, "No transactions match."));
  };
  q.addEventListener("keydown", (e) => e.key === "Enter" && load());
  mount(form, field("From", from), field("To", to), field("Search", q), field("Status", status), field("Payment", method),
    h("button", { class: "ink-btn", style: { alignSelf: "center" }, onclick: load }, "Search"),
    isAdmin() && h("button", { class: "ink-btn-ghost btn-sm", style: { alignSelf: "center" }, onclick: () => downloadUrl("/api/export/transactions.csv?" + params()) }, "Export CSV"));
  mount(el, h("h1", null, "Transactions"), h("div", { class: "sub" }, "Find any sale, view or reprint its receipt, and record the fiscal register's FS number."), h("div", { class: "ink-card" }, form, results));
  await load();
}

// ---------------------------------------------------------------- menu
let menuFilter = "all";
async function menuPage(el) {
  const [menu, categories] = await Promise.all([api.get("/api/menu"), api.get("/api/categories")]);
  const catName = (id) => categories.find((c) => c.id === id)?.name || "?";
  const shown = menu.filter((m) => menuFilter === "all" || m.categoryId === menuFilter);
  const refresh = () => menuPage(el);
  const setAvail = async (m, v) => { try { await api.post(`/api/menu/${m.id}/availability`, { available: v }); refresh(); } catch (e) { toast(e.message, "bad"); } };
  mount(el,
    h("div", { class: "spread" }, h("div", null, h("h1", null, "Menu"), h("div", { class: "sub" }, isAdmin() ? "Food and beverages, categories, prices and availability." : "Mark items sold out or available. Prices are managed by an administrator.")),
      isAdmin() && h("div", { class: "row" }, h("button", { class: "ink-btn-ghost", onclick: () => categoriesModal(categories, refresh) }, "Categories"), h("button", { class: "ink-btn", onclick: () => itemModal(null, categories, refresh) }, "+ Add item"))),
    h("div", { class: "chips" }, h("button", { class: "chip" + (menuFilter === "all" ? " active" : ""), onclick: () => { menuFilter = "all"; refresh(); } }, "All"),
      categories.map((c) => h("button", { class: "chip" + (menuFilter === c.id ? " active" : ""), onclick: () => { menuFilter = c.id; refresh(); } }, c.name + (c.active ? "" : " (hidden)")))),
    h("div", { class: "ink-card table-scroll" }, h("table", { class: "list" },
      h("tr", null, h("th", null, "Item"), h("th", null, "Receipt text"), h("th", null, "Category"), h("th", null, "Unit"), h("th", { class: "num" }, "Price (net)"), h("th", { class: "num" }, "VAT"), h("th", { class: "num" }, "Price incl. VAT"), h("th", null, "Available"), h("th", null, "")),
      shown.map((m) => h("tr", null,
        h("td", null, h("b", null, m.name)), h("td", { class: "mono small" }, m.receiptName, hasNonAscii(m.receiptName) ? h("div", { class: "fail small" }, "non-ASCII: prints as ? in ESC/POS") : null), h("td", null, catName(m.categoryId)), h("td", null, m.unit),
        h("td", { class: "num mono" }, formatAmount(m.priceCents)), h("td", { class: "num" }, formatRate(m.taxRateBp) + "%"), h("td", { class: "num mono" }, formatAmount(netToGrossCents(m.priceCents, m.taxRateBp))),
        h("td", null, h("button", { class: "ink-btn-ghost btn-sm" + (m.available ? " plain" : ""), onclick: () => setAvail(m, !m.available) }, m.available ? "Available" : "Sold out")),
        h("td", null, isAdmin() && h("div", { class: "row" }, h("button", { class: "ink-btn-ghost btn-sm plain", onclick: () => itemModal(m, categories, refresh) }, "Edit"),
          h("button", { class: "ink-btn-ghost btn-sm", onclick: async () => { if (await confirmBox("Remove item", `Remove “${m.name}” from the menu? Past sales keep their records.`, { okLabel: "Remove", danger: true })) { try { await api.del("/api/menu/" + m.id); refresh(); } catch (e) { toast(e.message, "bad"); } } } }, "Remove"))))))),
    h("p", { class: "muted small", style: { marginTop: "10px" } }, "Prices are stored and printed tax-exclusive (net), as on the sample receipt; VAT is added per line at billing."));
}

async function itemModal(item, categories, refresh) {
  await modal((close) => {
    const name = h("input", { class: "ink-input", value: item?.name || "" });
    const rname = h("input", { class: "ink-input mono", value: item?.receiptName || "", placeholder: "Defaults to the item name" });
    const cat = h("select", { class: "ink-input" }, categories.map((c) => h("option", { value: String(c.id) }, c.name)));
    cat.value = String(item?.categoryId || categories[0]?.id || "");
    const unit = h("select", { class: "ink-input" }, h("option", { value: "pcs" }, "pcs (counted)"), h("option", { value: "kg" }, "kg (weighed)"));
    unit.value = item?.unit || "pcs";
    const rate = h("input", { class: "ink-input", value: formatRate(item?.taxRateBp ?? settings.tax.defaultRateBp), inputmode: "decimal" });
    const net = h("input", { class: "ink-input mono", value: item ? formatAmount(item.priceCents) : "", inputmode: "decimal", placeholder: "e.g. 60.87" });
    const gross = h("input", { class: "ink-input mono", inputmode: "decimal", placeholder: "e.g. 70.00" });
    const grossOut = h("div", { class: "muted small" });
    const avail = h("input", { type: "checkbox", checked: item ? item.available : true });
    const sort = h("input", { class: "ink-input", value: String(item?.sort ?? 0), inputmode: "numeric" });
    const err = h("div", { class: "err" });
    const rateBp = () => { const r = parseDecimalPct(rate.value); return r; };
    const showGross = () => { const n = parseAmount(net.value); const r = rateBp(); grossOut.textContent = n !== null && r !== null ? `Customer pays ${formatAmount(netToGrossCents(n, r))} incl. VAT per ${unit.value === "kg" ? "kg" : "item"}` : ""; };
    net.addEventListener("input", showGross); rate.addEventListener("input", showGross); unit.addEventListener("change", showGross);
    gross.addEventListener("input", () => { const g = parseAmount(gross.value); const r = rateBp(); if (g !== null && r !== null) { net.value = formatAmount(grossToNetCents(g, r)); showGross(); } });
    showGross();
    const save = async () => {
      err.textContent = "";
      const r = rateBp();
      if (r === null) { err.textContent = "VAT rate must be a percentage such as 15."; return; }
      const body = { name: name.value, receiptName: rname.value, categoryId: Number(cat.value), unit: unit.value, price: net.value, taxRateBp: r, available: avail.checked, sort: Number(sort.value) || 0 };
      try { if (item) await api.patch("/api/menu/" + item.id, body); else await api.post("/api/menu", body); toast("Menu saved."); close(true); refresh(); } catch (e) { err.textContent = e.message; }
    };
    return [h("h2", null, item ? "Edit menu item" : "Add menu item"),
      field("Name (shown to staff)", name), field("Receipt text", rname, "Printed on the receipt. Use Latin letters for ESC/POS printers; Amharic needs HTML print mode."),
      h("div", { class: "cols-2" }, field("Category", cat), field("Unit", unit)),
      h("div", { class: "cols-2" }, field("Unit price, net (excl. VAT)", net), field("VAT rate %", rate)),
      field("…or calculate net from a price incl. VAT", gross, "Rounded to the cent. Check the result: the sample receipt's register used 2782.60 net for a 3200 item, where rounding gives 2782.61."),
      grossOut,
      h("div", { class: "cols-2" }, h("label", { class: "check" }, avail, "Available for ordering"), field("Sort order", sort)),
      err, h("div", { class: "modal-actions" }, h("button", { class: "ink-btn-ghost plain", onclick: () => close() }, "Back"), h("button", { class: "ink-btn", onclick: save }, "Save"))];
  });
}
function parseDecimalPct(s) { const v = parseAmount(String(s).replace("%", "").trim()); return v === null || v > 10000 ? null : v; }

async function categoriesModal(categories, refresh) {
  await modal((close) => {
    const list = h("div");
    const draw = (cats) => mount(list, h("table", { class: "list" }, h("tr", null, h("th", null, "Name"), h("th", null, "Type"), h("th", null, "Order"), h("th", null, "Shown"), h("th", null, "")),
      cats.map((c) => {
        const n = h("input", { class: "ink-input", value: c.name });
        const k = h("select", { class: "ink-input" }, ["food", "beverage", "other"].map((x) => h("option", { value: x }, x)));
        k.value = c.kind;
        const s = h("input", { class: "ink-input", value: String(c.sort), style: { width: "60px" } });
        const a = h("input", { type: "checkbox", checked: c.active });
        return h("tr", null, h("td", null, n), h("td", null, k), h("td", null, s), h("td", null, a), h("td", null, h("button", { class: "ink-btn btn-sm", onclick: async () => { try { await api.patch("/api/categories/" + c.id, { name: n.value, kind: k.value, sort: Number(s.value) || 0, active: a.checked }); toast("Category saved."); } catch (e) { toast(e.message, "bad"); } } }, "Save")));
      })));
    draw(categories);
    const nn = h("input", { class: "ink-input", placeholder: "New category name" });
    const nk = h("select", { class: "ink-input", style: { width: "auto" } }, ["food", "beverage", "other"].map((x) => h("option", { value: x }, x)));
    return [h("h2", null, "Menu categories"), list,
      h("div", { class: "row", style: { marginTop: "14px" } }, nn, nk, h("button", { class: "ink-btn", onclick: async () => { try { await api.post("/api/categories", { name: nn.value, kind: nk.value, sort: 99 }); nn.value = ""; draw(await api.get("/api/categories")); } catch (e) { toast(e.message, "bad"); } } }, "Add")),
      h("div", { class: "modal-actions" }, h("button", { class: "ink-btn-ghost plain", onclick: () => { close(); refresh(); } }, "Done"))];
  }, { wide: true });
  refresh();
}

// ---------------------------------------------------------------- reports
const repQuery = { from: localISODate(), to: localISODate() };
async function reportsPage(el) {
  const from = h("input", { class: "ink-input", type: "date", value: repQuery.from, style: { width: "auto" } });
  const to = h("input", { class: "ink-input", type: "date", value: repQuery.to, style: { width: "auto" } });
  const out = h("div");
  const range = (a, b) => { from.value = localISODate(a); to.value = localISODate(b); load(); };
  const now = new Date();
  const qs = () => `from=${repQuery.from}&to=${repQuery.to}`;
  const tbl = (title, rows, cols) => h("div", { class: "ink-card" }, h("h3", null, title), rows.length ? h("div", { class: "table-scroll" }, h("table", { class: "list" }, h("tr", null, cols.map((c) => h("th", { class: c.num ? "num" : "" }, c.label))), rows.map((r) => h("tr", null, cols.map((c) => h("td", { class: c.num ? "num" : "" }, c.get(r))))))) : h("p", { class: "muted" }, "No data."));
  const load = async () => {
    Object.assign(repQuery, { from: from.value, to: to.value });
    const r = await api.get("/api/reports/summary?" + qs());
    const s = r.totals;
    mount(out,
      h("div", { class: "grid stats" },
        ...[["Sales incl. VAT", money(s.totalCents), settings.currency], ["Net (taxable)", money(s.netCents), settings.currency], ["VAT", money(s.taxCents), settings.currency], ["Transactions", s.count, ""], ["Voided", `${r.voided.count}`, r.voided.count ? `(${money(r.voided.totalCents)})` : ""]]
          .map(([l, v, u]) => h("div", { class: "ink-card" }, h("div", { class: "stat-label" }, l), h("div", { class: "stat-value" }, v, u ? h("small", null, " " + u) : null)))),
      h("div", { class: "cols-2" },
        tbl("By day", r.byDay, [{ label: "Date", get: (x) => x.label }, { label: "Sales", num: 1, get: (x) => x.count }, { label: "Net", num: 1, get: (x) => money(x.netCents) }, { label: "VAT", num: 1, get: (x) => money(x.taxCents) }, { label: "Total", num: 1, get: (x) => money(x.totalCents) }]),
        tbl("By payment method", r.byMethod, [{ label: "Method", get: (x) => x.label }, { label: "Sales", num: 1, get: (x) => x.count }, { label: "Total", num: 1, get: (x) => money(x.totalCents) }]),
        tbl("By item (net)", r.byItem, [{ label: "Item", get: (x) => x.label }, { label: "Quantity", num: 1, get: (x) => formatQty(x.qtyMilli, x.unit) }, { label: "Net", num: 1, get: (x) => money(x.netCents) }]),
        tbl("By cashier", r.byCashier, [{ label: "Cashier", get: (x) => x.label }, { label: "Sales", num: 1, get: (x) => x.count }, { label: "Total", num: 1, get: (x) => money(x.totalCents) }])));
  };
  const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  mount(el, h("h1", null, "Reports"), h("div", { class: "sub" }, "Sales totals for any period (completed sales; voided sales listed separately)."),
    h("div", { class: "ink-card", style: { marginBottom: "16px" } }, h("div", { class: "row" }, field("From", from), field("To", to), h("button", { class: "ink-btn", onclick: load }, "Show"),
      h("button", { class: "ink-btn-ghost btn-sm plain", onclick: () => range(now, now) }, "Today"), h("button", { class: "ink-btn-ghost btn-sm plain", onclick: () => range(yest, yest) }, "Yesterday"),
      h("button", { class: "ink-btn-ghost btn-sm plain", onclick: () => range(monday, now) }, "This week"), h("button", { class: "ink-btn-ghost btn-sm plain", onclick: () => range(new Date(now.getFullYear(), now.getMonth(), 1), now) }, "This month"),
      h("button", { class: "ink-btn-ghost btn-sm", onclick: () => downloadUrl("/api/export/transactions.csv?" + qs()) }, "Export transactions CSV"),
      h("button", { class: "ink-btn-ghost btn-sm", onclick: () => downloadUrl("/api/export/lines.csv?" + qs()) }, "Export item lines CSV"))),
    out);
  await load();
}

// ---------------------------------------------------------------- printer (QZ Tray)
async function printerPage(el) {
  let cfg = printing.getPrintConfig();
  const status = h("div");
  const jobsBox = h("div");
  const printerSel = h("select", { class: "ink-input" });
  const fillPrinters = (list) => { mount(printerSel, h("option", { value: "" }, "— select printer —"), [...new Set([...(list || []), cfg.printer].filter(Boolean))].map((p) => h("option", { value: p }, p))); printerSel.value = cfg.printer; };
  fillPrinters([]);
  const mode = h("select", { class: "ink-input" }, h("option", { value: "escpos" }, "Raw ESC/POS (thermal receipt printers — recommended)"), h("option", { value: "html" }, "HTML / pixel (any printer; supports Amharic text)"));
  mode.value = cfg.mode;
  const num = (v) => h("input", { class: "ink-input", value: String(v), inputmode: "numeric" });
  const paper = h("select", { class: "ink-input" }, h("option", { value: "58" }, "58 mm"), h("option", { value: "80" }, "80 mm"), h("option", { value: "custom" }, "Other…"));
  const paperW = num(cfg.paperWidthMm), printableW = num(cfg.printableWidthMm), cols = num(cfg.charsPerLine), feed = num(cfg.feedLines), codePage = num(cfg.codePage);
  paper.value = cfg.paperWidthMm === 58 ? "58" : cfg.paperWidthMm === 80 ? "80" : "custom";
  paper.addEventListener("change", () => {
    if (paper.value === "58") { paperW.value = 58; printableW.value = 48; cols.value = 32; }
    if (paper.value === "80") { paperW.value = 80; printableW.value = 72; cols.value = 48; }
  });
  const cut = h("input", { type: "checkbox", checked: cfg.cut });
  const drawer = h("input", { type: "checkbox", checked: cfg.openDrawer });
  const msg = h("div");
  const show = (text, kind = "") => mount(msg, h("div", { class: "notice " + kind }, text));

  const drawStatus = (s) => mount(status,
    h("div", { class: "row" }, h("span", { class: "dot " + (s.status === "connected" ? "ok" : s.status === "connecting" ? "wait" : "bad"), style: { width: "14px", height: "14px" } }),
      h("div", { style: { flex: 1 } }, h("div", { class: "serif", style: { fontSize: "21px" } }, s.status === "connected" ? "QZ Tray connected" : s.status === "connecting" ? "Connecting…" : "QZ Tray not connected"),
        h("div", { class: "small muted" }, s.version ? `QZ Tray ${s.version} · ` : "", s.signing ? (s.signing.certificate && s.signing.privateKey ? "Signed requests (certificate installed)" : "Unsigned: QZ Tray will ask to allow requests — see README") : "")),
      s.status === "connected" ? h("button", { class: "ink-btn-ghost btn-sm plain", onclick: () => qzs.disconnect() }, "Disconnect") : h("button", { class: "ink-btn", onclick: () => qzs.connect().catch((e) => show(e.message, "bad")) }, "Connect")),
    s.status !== "connected" && s.message && h("div", { class: "notice bad" }, s.message));
  const unsub = qzs.onQzState((s) => { if (!document.body.contains(status) && currentPage !== "printer") { unsub(); return; } drawStatus(s); });

  const find = async () => { show("Searching for printers…"); try { const list = await qzs.findPrinters(); fillPrinters(list); show(`Found ${list.length} printer(s). Select one and press Save.`, "ok"); } catch (e) { show(e.message, "bad"); } };
  const useDefault = async () => { try { const p = await qzs.defaultPrinter(); if (!p) { show("No default printer is set on this computer.", "bad"); return; } fillPrinters([p]); printerSel.value = p; show(`Default printer: ${p}. Press Save to keep it.`, "ok"); } catch (e) { show(e.message, "bad"); } };
  const useNetwork = async () => {
    const v = await promptBox("Network receipt printer", "IP address and port, e.g. 192.168.1.50:9100", { okLabel: "Use", value: (qzs.parseNetworkPrinter(printerSel.value) ? printerSel.value.replace("net://", "") : "") , help: "For Ethernet/Wi-Fi ESC/POS printers. QZ Tray sends raw data straight to the printer's port (usually 9100)." });
    if (!v) return;
    const p = "net://" + v.trim().replace(/^net:\/\//, "");
    if (!qzs.parseNetworkPrinter(p)) { show("Enter an address like 192.168.1.50:9100", "bad"); return; }
    fillPrinters([p]); printerSel.value = p; mode.value = "escpos"; show(`Network printer ${p}. Press Save to keep it.`, "ok");
  };
  const save = () => {
    try {
      cfg = printing.savePrintConfig({ printer: printerSel.value, mode: mode.value, paperWidthMm: paperW.value, printableWidthMm: printableW.value, charsPerLine: cols.value, feedLines: feed.value, codePage: codePage.value, cut: cut.checked, openDrawer: drawer.checked });
      paperW.value = cfg.paperWidthMm; printableW.value = cfg.printableWidthMm; cols.value = cfg.charsPerLine;
      show(cfg.printer ? `Saved for this computer: ${cfg.printer}` : "Saved. No printer selected yet.", "ok");
    } catch (e) { show(e.message, "bad"); }
  };
  const test = async () => { save(); show("Sending test page…"); try { await printing.testPrint(); show("Test page sent to " + cfg.printer + ". Check the paper: the 1234567890 ruler must fit on one line.", "ok"); } catch (e) { show(e.message, "bad"); } loadJobs(); };
  const loadJobs = async () => {
    const jobs = await api.get("/api/print-jobs");
    mount(jobsBox, jobs.length ? h("div", { class: "table-scroll" }, h("table", { class: "list" }, h("tr", null, ["Time", "Receipt", "Kind", "Status", "Printer", "By", "Detail"].map((c) => h("th", null, c))),
      jobs.map((j) => h("tr", null, h("td", null, new Date(j.createdAt).toLocaleString("en-GB")), h("td", { class: "mono" }, j.receiptNo ? pad8(j.receiptNo) : "test"), h("td", null, j.kind), h("td", null, h("span", { class: "badge " + (j.status === "sent" ? "st-completed" : j.status === "failed" ? "st-cancelled" : "st-open") }, j.status)), h("td", { class: "small" }, j.printer + (j.mode ? ` (${j.mode})` : "")), h("td", null, j.userName), h("td", { class: "small" }, j.reason || j.error))))) : h("p", { class: "muted" }, "No print attempts yet."));
  };

  mount(el, h("h1", null, "Printer"), h("div", { class: "sub" }, "QZ Tray connection and the receipt printer for this computer."),
    h("div", { class: "ink-card", style: { marginBottom: "16px" } }, status),
    h("div", { class: "cols-2" },
      h("div", { class: "ink-card" }, h("h2", null, "Receipt printer"),
        field("Printer", printerSel), h("div", { class: "row", style: { marginBottom: "12px" } }, h("button", { class: "ink-btn-ghost btn-sm", onclick: find }, "Find printers"), h("button", { class: "ink-btn-ghost btn-sm plain", onclick: useDefault }, "Use system default"), h("button", { class: "ink-btn-ghost btn-sm plain", onclick: useNetwork }, "Network printer (IP)…")),
        field("Print method", mode),
        h("div", { class: "cols-2" }, field("Paper roll", paper), field("Paper width (mm)", paperW)),
        h("div", { class: "cols-2" }, field("Printable width (mm)", printableW), field("Characters per line", cols, "Font A: 32 on 58 mm, 48 on 80 mm (some 80 mm models: 42)")),
        h("div", { class: "cols-2" }, field("Feed lines before cut", feed), field("ESC/POS code page", codePage, "0 = PC437 (default)")),
        h("label", { class: "check" }, cut, "Cut paper after receipt"), h("label", { class: "check" }, drawer, "Open cash drawer on cash sales (drawer connected to printer)"),
        msg,
        h("div", { class: "row", style: { marginTop: "10px" } }, h("button", { class: "ink-btn", onclick: save }, "Save"), h("button", { class: "ink-btn dark", onclick: test }, "Test print"))),
      h("div", { class: "ink-card" }, h("h2", null, "If printing does not work"),
        h("ol", { style: { marginLeft: "18px", lineHeight: 1.7 } },
          h("li", null, "Make sure QZ Tray is installed and running on ", h("b", null, "this"), " computer (tray icon near the clock). Start it from the Start menu if needed, then press Connect."),
          h("li", null, "Chrome/Edge 147+: allow “access other apps and services on this device” when asked. If it was blocked: padlock icon → Site settings → Local network access → Allow, then reload."),
          h("li", null, "When QZ Tray asks to allow this website, click Allow (tick “Remember this decision” when the site is signed)."),
          h("li", null, "Printer missing: switch it on, check the USB cable and that it appears in Windows “Printers & scanners”, then Find printers and Save."),
          h("li", null, "Text cut off or wrapped: lower Characters per line; blank paper at the end: lower Feed lines."),
          h("li", null, "Sales are saved before printing. After fixing the problem, open the sale in Transactions and press Print — no duplicate sale is created."),
          h("li", null, "Emergency only: “Browser print (fallback)” on the receipt uses the browser’s print dialog instead of QZ Tray.")),
        h("p", { class: "small muted" }, "Printer choice and paper settings are saved in this browser, because each computer has its own printer."),
        h("button", { class: "ink-btn-ghost btn-sm", style: { marginTop: "8px" }, onclick: () => go("sample") }, "Receipt layout check (sample)"))),
    h("div", { class: "ink-card", style: { marginTop: "16px" } }, h("div", { class: "spread" }, h("h2", null, "Recent print attempts"), h("button", { class: "ink-btn-ghost btn-sm plain", onclick: loadJobs }, "Refresh")), jobsBox));
  await loadJobs();
}

// ---------------------------------------------------------------- sample receipt check
async function samplePage(el) {
  const cfg = printing.getPrintConfig();
  const S = SAMPLE_RECEIPT_SOURCE;
  const totals = computeTotals(S.items.map((i) => ({ ...i, taxRateBp: 1500 })));
  const refLines = layoutReceipt(sampleReferenceReceipt(totals), 32);
  // How this application prints the same sale with the current settings (marked SAMPLE).
  const fakeTx = { receiptNo: 0, receiptDate: S.date, receiptTime: S.time, buyerTin: S.buyerTin, buyerName: S.buyerName, lines: totals.lines.map((l) => ({ ...l, receiptName: l.name })), taxGroups: totals.taxGroups, totalCents: totals.totalCents, paymentLabel: "CASH", tenderedCents: totals.totalCents, changeCents: 0, status: "completed", orderType: "dine_in", tableLabel: "1",
    receiptSnapshot: { tin: settings.business.tin, headerLines: settings.business.headerLines, heading: settings.receipt.heading, numberLabel: settings.receipt.numberLabel, footerLines: settings.receipt.footerLines, printOrderInfo: settings.receipt.printOrderInfo } };
  const appLines = layoutReceipt({ ...buildReceiptFromTransaction(fakeTx), number: "SAMPLE", banner: "SAMPLE - NOT A SALE" }, cfg.charsPerLine);
  const checks = [["Taxable (TXBL 1 15%)", S.printed.txbl, totals.taxGroups[0].taxableCents], ["Tax (TAX 1 15%)", S.printed.tax, totals.taxCents], ["TOTAL", S.printed.total, totals.totalCents], ["CASH", S.printed.cash, totals.totalCents], ["ITEM count", S.printed.itemCount, totals.itemCount]];
  const show = h("div");
  mount(el, h("h1", null, "Receipt layout check"), h("div", { class: "sub" }, "The supplied receipt (FS No. 00000594) recalculated and re-laid out by this application. Sample values are never used for new sales."),
    h("div", { class: "ink-card", style: { marginBottom: "16px" } }, h("h2", null, "Calculation check"),
      h("table", { class: "list check-table" }, h("tr", null, h("th", null, "Line"), h("th", { class: "num" }, "Printed on sample"), h("th", { class: "num" }, "Calculated"), h("th", null, "Result")),
        checks.map(([l, a, b]) => h("tr", null, h("td", null, l), h("td", { class: "num mono" }, l === "ITEM count" ? a : formatAmount(a)), h("td", { class: "num mono" }, l === "ITEM count" ? b : formatAmount(b)), h("td", { class: a === b ? "pass" : "fail" }, a === b ? "MATCH" : "DIFFERENT")))),
      h("p", { class: "small muted", style: { marginTop: "8px" } }, "Rule: prices are net; VAT 15% is rounded per line (417.39 + 7.83 + 10.44 + 9.13 = 444.79). Calculating VAT on the subtotal would give 444.78, which does not match the sample.")),
    h("div", { class: "side-by-side" },
      h("div", { class: "receipt-stage" }, receiptPreview(refLines, { ...cfg, charsPerLine: 32, paperWidthMm: 58, printableWidthMm: 48 }, { caption: "Reference: sample receipt as scanned", watermark: "REFERENCE" })),
      h("div", { class: "receipt-stage" }, receiptPreview(appLines, cfg, { caption: `This app's print layout (${cfg.paperWidthMm} mm / ${cfg.charsPerLine} chars)`, watermark: "SAMPLE" }))),
    h("div", { class: "notice" }, "Differences on purpose: the app prints its own receipt number (", h("b", null, settings.receipt.numberLabel), ") instead of the fiscal register's FS No., and replaces the ERCA / machine-number footer with “NON-FISCAL RECEIPT”, because only the registered fiscal machine may issue those. Header and footer text are editable in Settings."),
    h("div", { class: "row", style: { marginTop: "10px" } }, h("button", { class: "ink-btn", onclick: async () => {
      if (!cfg.printer) { mount(show, h("div", { class: "notice bad" }, "Select a printer on the Printer page first.")); return; }
      const job = await api.post("/api/print-jobs", { printer: cfg.printer, mode: cfg.mode });
      try {
        if (cfg.mode === "html") { const { receiptDocumentHtml } = await import("/shared/receipt.js"); await qzs.printHtml(cfg.printer, receiptDocumentHtml(appLines, cfg), cfg.paperWidthMm); }
        else { const { encodeEscPos, bytesToBase64 } = await import("/shared/receipt.js"); await qzs.printRaw(cfg.printer, bytesToBase64(encodeEscPos(appLines, cfg))); }
        await api.patch(`/api/print-jobs/${job.jobId}`, { status: "sent" });
        mount(show, h("div", { class: "notice ok" }, "Sample sent to the printer. Lay it beside the original receipt to compare."));
      } catch (e) { await api.patch(`/api/print-jobs/${job.jobId}`, { status: "failed", error: qzs.explain(e) }).catch(() => {}); mount(show, h("div", { class: "notice bad" }, qzs.explain(e))); }
    } }, "Test-print sample (marked SAMPLE)"), h("button", { class: "ink-btn-ghost plain", onclick: () => printing.browserPrintLines(appLines, cfg) }, "Browser print (fallback)")),
    show);
}

// ---------------------------------------------------------------- settings (admin)
async function settingsPage(el) {
  settings = await api.get("/api/settings");
  const s = settings;
  const [users, tables, qzStatus] = await Promise.all([api.get("/api/users"), api.get("/api/tables"), api.get("/api/qz/status")]);
  const refresh = () => settingsPage(el);
  const saveSettings = async (body, msgEl) => { try { await api.put("/api/settings", body); settings = await api.get("/api/settings"); mount(msgEl, h("div", { class: "notice ok" }, "Saved.")); } catch (e) { mount(msgEl, h("div", { class: "notice bad" }, e.message)); } };

  // business & receipt
  const disp = h("input", { class: "ink-input", value: s.business.displayName });
  const tin = h("input", { class: "ink-input mono", value: s.business.tin });
  const header = h("textarea", { class: "ink-input mono", rows: 6 }); header.value = s.business.headerLines.join("\n");
  const heading = h("input", { class: "ink-input mono", value: s.receipt.heading });
  const numLabel = h("input", { class: "ink-input mono", value: s.receipt.numberLabel });
  const footer = h("textarea", { class: "ink-input mono", rows: 3 }); footer.value = s.receipt.footerLines.join("\n");
  const orderInfo = h("input", { type: "checkbox", checked: s.receipt.printOrderInfo });
  const bizMsg = h("div");
  // operations
  const rate = h("input", { class: "ink-input", value: formatRate(s.tax.defaultRateBp) });
  const tz = h("input", { class: "ink-input", value: s.timezone });
  const cur = h("input", { class: "ink-input", value: s.currency });
  const autoPrint = h("input", { type: "checkbox", checked: s.autoPrint });
  const reprint = h("input", { type: "checkbox", checked: s.cashierCanReprint });
  const nextNo = h("input", { class: "ink-input mono", value: String(s.nextReceiptNo) });
  const pm = s.paymentMethods.map((m) => ({ m, label: h("input", { class: "ink-input", value: m.label }), on: h("input", { type: "checkbox", checked: m.enabled }) }));
  const opMsg = h("div");

  const userRows = users.map((u) => h("tr", null, h("td", { class: "mono" }, u.username), h("td", null, u.name), h("td", null, u.role), h("td", null, u.active ? "active" : h("span", { class: "fail" }, "disabled")),
    h("td", null, h("div", { class: "row" },
      h("button", { class: "ink-btn-ghost btn-sm plain", onclick: () => userModal(u, refresh) }, "Edit"),
      h("button", { class: "ink-btn-ghost btn-sm", onclick: async () => { try { await api.patch("/api/users/" + u.id, { active: !u.active }); refresh(); } catch (e) { toast(e.message, "bad"); } } }, u.active ? "Disable" : "Enable")))));

  const tableRows = tables.map((t) => {
    const lb = h("input", { class: "ink-input", value: t.label, style: { width: "90px" } });
    const seats = h("input", { class: "ink-input", value: String(t.seats), style: { width: "70px" } });
    const act = h("input", { type: "checkbox", checked: t.active });
    return h("tr", null, h("td", null, lb), h("td", null, seats), h("td", null, act), h("td", null, t.occupied ? "occupied" : ""), h("td", null, h("button", { class: "ink-btn btn-sm", onclick: async () => { try { await api.patch("/api/tables/" + t.id, { label: lb.value, seats: Number(seats.value), active: act.checked }); toast("Table saved."); } catch (e) { toast(e.message, "bad"); } } }, "Save")));
  });
  const newTable = h("input", { class: "ink-input", placeholder: "Label", style: { width: "110px" } });

  mount(el, h("h1", null, "Settings"), h("div", { class: "sub" }, "Business details, receipt content, operations, users, tables and backups."),
    h("div", { class: "cols-2" },
      h("div", { class: "ink-card" }, h("h2", null, "Business & receipt"),
        field("Name shown in this app", disp), field("TIN (printed as TIN:…)", tin), field("Receipt header lines (one per line, centred)", header, "From the sample: owner, trade name, address, phone. Keep each line within the characters-per-line of your printer."),
        h("div", { class: "cols-2" }, field("Receipt heading", heading), field("Receipt number label", numLabel)),
        field("Footer lines (after NON-FISCAL RECEIPT)", footer),
        h("label", { class: "check" }, orderInfo, "Also print order type/table and cashier (not on the original layout)"),
        h("div", { class: "notice" }, "“NON-FISCAL RECEIPT” is always printed, and the ERCA logo / machine number are not reproduced: legal fiscal receipts must come from the registered fiscal cash register. Record the register's FS No. on each sale to match records."),
        bizMsg,
        h("div", { class: "row" }, h("button", { class: "ink-btn", onclick: () => saveSettings({ business: { displayName: disp.value, tin: tin.value, headerLines: header.value.split("\n") }, receipt: { heading: heading.value, numberLabel: numLabel.value, footerLines: footer.value.split("\n"), printOrderInfo: orderInfo.checked } }, bizMsg) }, "Save"), h("button", { class: "ink-btn-ghost plain", onclick: () => go("sample") }, "Preview with sample"))),
      h("div", { class: "ink-card" }, h("h2", null, "Operations"),
        h("div", { class: "cols-2" }, field("Default VAT rate for new items (%)", rate), field("Currency label", cur)),
        field("Time zone (receipt date/time and business day)", tz),
        field("Next receipt number", nextNo, "Can only be raised above the last issued number."),
        h("h3", { style: { marginTop: "8px" } }, "Payment methods"),
        pm.map((p) => h("div", { class: "row", style: { marginBottom: "6px" } }, p.on, h("span", { style: { width: "80px" }, class: "small muted" }, p.m.id), p.label)),
        h("label", { class: "check" }, autoPrint, "Print receipt automatically after payment"),
        h("label", { class: "check" }, reprint, "Cashiers may reprint receipts (always marked COPY, reason recorded)"),
        opMsg,
        h("button", { class: "ink-btn", onclick: () => { const r = parseDecimalPct(rate.value); if (r === null) { mount(opMsg, h("div", { class: "notice bad" }, "Invalid VAT rate.")); return; } saveSettings({ tax: { defaultRateBp: r }, timezone: tz.value.trim(), currency: cur.value, nextReceiptNo: Number(nextNo.value) === s.nextReceiptNo ? undefined : Number(nextNo.value), autoPrint: autoPrint.checked, cashierCanReprint: reprint.checked, paymentMethods: pm.map((p) => ({ id: p.m.id, label: p.label.value, enabled: p.on.checked })) }, opMsg); } }, "Save"))),
    h("div", { class: "cols-2", style: { marginTop: "16px" } },
      h("div", { class: "ink-card" }, h("div", { class: "spread" }, h("h2", null, "Users"), h("button", { class: "ink-btn btn-sm", onclick: () => userModal(null, refresh) }, "+ Add user")),
        h("p", { class: "small muted" }, "Administrator: everything. Cashier: orders, payments, receipts, transactions, menu availability and printer setup."),
        h("div", { class: "table-scroll" }, h("table", { class: "list" }, h("tr", null, ["Username", "Name", "Role", "Status", ""].map((c) => h("th", null, c))), userRows))),
      h("div", { class: "ink-card" }, h("h2", null, "Tables"),
        h("div", { class: "table-scroll" }, h("table", { class: "list" }, h("tr", null, ["Label", "Seats", "In use", "", ""].map((c) => h("th", null, c))), tableRows)),
        h("div", { class: "row", style: { marginTop: "10px" } }, newTable, h("button", { class: "ink-btn btn-sm", onclick: async () => { try { await api.post("/api/tables", { label: newTable.value }); refresh(); } catch (e) { toast(e.message, "bad"); } } }, "Add table")))),
    h("div", { class: "cols-2", style: { marginTop: "16px" } },
      h("div", { class: "ink-card" }, h("h2", null, "Backup & export"),
        h("p", { class: "small muted", style: { marginBottom: "10px" } }, "All records live in one database on the server computer (data/restaurant.db), shared by every connected device. Download a backup daily and keep it on another drive."),
        h("div", { class: "row" }, h("button", { class: "ink-btn", onclick: () => downloadUrl("/api/backup/database") }, "Download database backup"), h("button", { class: "ink-btn-ghost", onclick: () => downloadUrl("/api/backup/json") }, "Export everything (JSON)"))),
      h("div", { class: "ink-card" }, h("h2", null, "QZ Tray signing"),
        h("p", null, qzStatus.certificate && qzStatus.privateKey ? h("span", { class: "pass" }, "Certificate and private key installed on the server — print requests are signed.") : h("span", { class: "fail" }, "No signing key installed — QZ Tray will ask staff to allow each connection/print.")),
        h("p", { class: "small muted", style: { marginTop: "8px" } }, "Place digital-certificate.txt and private-key.pem in the server's data/qz folder (see README). The private key stays on the server and is never sent to browsers."))));
}

async function userModal(u, refresh) {
  await modal((close) => {
    const un = h("input", { class: "ink-input mono", value: u?.username || "", disabled: !!u });
    const nm = h("input", { class: "ink-input", value: u?.name || "" });
    const role = h("select", { class: "ink-input" }, h("option", { value: "cashier" }, "Cashier"), h("option", { value: "admin" }, "Administrator"));
    role.value = u?.role || "cashier";
    const pw = h("input", { class: "ink-input", type: "password", autocomplete: "new-password", placeholder: u ? "Leave blank to keep" : "At least 8 characters" });
    const err = h("div", { class: "err" });
    const save = async () => {
      try {
        if (u) await api.patch("/api/users/" + u.id, { name: nm.value, role: role.value, password: pw.value || undefined });
        else await api.post("/api/users", { username: un.value, name: nm.value, role: role.value, password: pw.value });
        toast("User saved."); close(true); refresh();
      } catch (e) { err.textContent = e.message; }
    };
    return [h("h2", null, u ? "Edit user" : "Add user"), field("Username", un), field("Full name", nm), field("Role", role), field(u ? "New password" : "Password", pw), err,
      h("div", { class: "modal-actions" }, h("button", { class: "ink-btn-ghost plain", onclick: () => close() }, "Back"), h("button", { class: "ink-btn", onclick: save }, "Save"))];
  });
}

boot();
