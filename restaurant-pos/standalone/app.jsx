// Restaurant POS — single-file edition (opens directly in the browser, no server).
// Built into restaurant-pos-standalone.html by tools/build-standalone.mjs together with the shared,
// tested money/receipt code (shared/money.js, shared/receipt.js).
const { useState, useEffect, useCallback, useMemo, useRef } = React;

// =====================================================================================
// STORAGE — IndexedDB in this browser (much larger than localStorage). Every change is
// written in one IndexedDB transaction; a Web Lock serialises changes made in several tabs.
// =====================================================================================
const DB_NAME = "hbm-restaurant-pos";
const DB_VERSION = 1;
const ORDER_OPEN = ["open", "submitted", "ready"];

const DEFAULT_CORE = () => ({
  version: 0,
  settings: {
    business: {
      displayName: "Hailu Beyene Minda Restaurant",
      tin: "0038779012",
      headerLines: ["HAILU BEYENE MINDA", "RESTAURANT SERVICE", "HAWASSA S.C MENAL KETEMA", "K.ADDIS ABEBA H.NO.", "TEL.0912061331E.MOB140010169008"],
    },
    receipt: { heading: "INVOICE", numberLabel: "RCPT No.:", footerLines: ["THANK YOU"], printOrderInfo: false },
    defaultTaxRateBp: 1500,
    currency: "ETB",
    timezone: "Africa/Addis_Ababa",
    autoPrint: true,
    cashierCanReprint: true,
    paymentMethods: [
      { id: "cash", label: "CASH", enabled: true },
      { id: "card", label: "CARD", enabled: true },
      { id: "mobile", label: "MOBILE MONEY", enabled: true },
      { id: "transfer", label: "BANK TRANSFER", enabled: true },
    ],
  },
  users: [],
  categories: [{ id: 1, name: "Food", active: true }, { id: 2, name: "Beverages", active: true }],
  // Starter items: the four lines of the supplied receipt, with their receipt prices (net of VAT).
  menu: [
    { id: 1, categoryId: 1, name: "Tibs (per kg)", receiptName: "1k tibs2", unit: "kg", priceCents: 278260, taxRateBp: 1500, available: true, archived: false },
    { id: 2, categoryId: 1, name: "Mabaya", receiptName: "Mabaya", unit: "pcs", priceCents: 2609, taxRateBp: 1500, available: true, archived: false },
    { id: 3, categoryId: 2, name: "Water 2 L", receiptName: "2  Liter water", unit: "pcs", priceCents: 6957, taxRateBp: 1500, available: true, archived: false },
    { id: 4, categoryId: 2, name: "Soft drink", receiptName: "Sofet derink", unit: "pcs", priceCents: 6087, taxRateBp: 1500, available: true, archived: false },
  ],
  tables: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, label: String(i + 1), active: true })),
  counters: { order: 1, line: 1, receipt: 1, menu: 5, category: 3, table: 11, user: 1, print: 1 },
  audit: [],
  lastBackupAt: null,
});

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("This browser cannot store data (IndexedDB unavailable). Use Chrome, Edge or Firefox, not a private window."));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
      if (!d.objectStoreNames.contains("orders")) d.createObjectStore("orders", { keyPath: "id" });
      if (!d.objectStoreNames.contains("txs")) d.createObjectStore("txs", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
let idb = null;
async function getIdb() { if (!idb) idb = await idbOpen(); return idb; }

async function readCore() {
  const d = await getIdb();
  return reqP(d.transaction("meta").objectStore("meta").get("core"));
}
async function readAll() {
  const d = await getIdb();
  const t = d.transaction(["meta", "orders", "txs"]);
  const [core, orders, txs] = await Promise.all([reqP(t.objectStore("meta").get("core")), reqP(t.objectStore("orders").getAll()), reqP(t.objectStore("txs").getAll())]);
  return { core: core || null, orders, txs };
}
async function writeChanges(core, orders, txs, replaceAll = false) {
  const d = await getIdb();
  return new Promise((resolve, reject) => {
    const t = d.transaction(["meta", "orders", "txs"], "readwrite");
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error || new Error("Saving failed"));
    t.onabort = () => reject(t.error || new Error("Saving was aborted (storage full?)"));
    if (replaceAll) { t.objectStore("orders").clear(); t.objectStore("txs").clear(); }
    t.objectStore("meta").put(core, "core");
    for (const o of orders) t.objectStore("orders").put(o);
    for (const x of txs) t.objectStore("txs").put(x);
  });
}

let cache = null; // { core, orders: Map, txs: Map }
const channel = "BroadcastChannel" in window ? new BroadcastChannel(DB_NAME) : null;
const withLock = (fn) => (navigator.locks ? navigator.locks.request(DB_NAME, fn) : fn());

async function loadState() {
  const all = await readAll();
  let core = all.core;
  if (!core) { core = DEFAULT_CORE(); await writeChanges(core, [], []); }
  cache = { core, orders: new Map(all.orders.map((o) => [o.id, o])), txs: new Map(all.txs.map((x) => [x.id, x])) };
  return snapshot();
}
function snapshot() {
  return { core: cache.core, orders: [...cache.orders.values()].sort((a, b) => b.id - a.id), txs: [...cache.txs.values()].sort((a, b) => b.receiptNo - a.receiptNo) };
}

// Apply a change atomically. fn(ctx) may read ctx.core / ctx.orders / ctx.txs, change ctx.core,
// and call ctx.putOrder(o) / ctx.putTx(t). Throwing inside fn saves nothing.
async function commit(fn) {
  return withLock(async () => {
    const stored = await readCore();
    if (!cache || !stored || stored.version !== cache.core.version) await loadState(); // another tab changed data
    const core = structuredClone(cache.core);
    const dirtyOrders = new Map();
    const dirtyTxs = new Map();
    const ctx = {
      core,
      getOrder: (id) => dirtyOrders.get(id) || structuredClone(cache.orders.get(id) || null),
      getTx: (id) => dirtyTxs.get(id) || structuredClone(cache.txs.get(id) || null),
      orders: () => [...cache.orders.values()].map((o) => dirtyOrders.get(o.id) || o),
      txs: () => [...cache.txs.values()].map((t) => dirtyTxs.get(t.id) || t),
      putOrder: (o) => dirtyOrders.set(o.id, o),
      putTx: (t) => dirtyTxs.set(t.id, t),
      next: (k) => core.counters[k]++,
    };
    const result = fn(ctx);
    core.version = (core.version || 0) + 1;
    await writeChanges(core, [...dirtyOrders.values()], [...dirtyTxs.values()]);
    cache.core = core;
    for (const o of dirtyOrders.values()) cache.orders.set(o.id, o);
    for (const t of dirtyTxs.values()) cache.txs.set(t.id, t);
    channel?.postMessage("changed");
    return result;
  });
}

function audit(core, user, action, detail) {
  core.audit.unshift({ at: new Date().toISOString(), user: user?.username || "", action, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
  if (core.audit.length > 500) core.audit.length = 500;
}

// =====================================================================================
// PASSWORDS — PBKDF2-SHA256 via the browser's Web Crypto. Nothing is hard-coded.
// =====================================================================================
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return b64(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" }, key, 256));
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: b64(salt), hash: await pbkdf2(password, salt) };
}
async function checkPassword(user, password) { return (await pbkdf2(password, unb64(user.salt))) === user.hash; }
const pwProblem = (p) => (!p || p.length < 8 ? "Password must be at least 8 characters." : null);

// =====================================================================================
// HELPERS
// =====================================================================================
const pad8 = (n) => String(n).padStart(8, "0");
const money = (c) => formatMoneyDisplay(c);
const orderLabel = (o, tables) => (o.orderType === "takeaway" ? "Takeaway" : "Table " + (o.tableLabel || tables?.find((t) => t.id === o.tableId)?.label || "?"));
function localStamp(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date).map((x) => [x.type, x.value]));
  return { localDate: `${p.year}-${p.month}-${p.day}`, receiptDate: `${p.day}/${p.month}/${p.year}`, receiptTime: `${p.hour}:${p.minute}:${p.second}` };
}
const todayLocal = (tz) => localStamp(new Date(), tz).localDate;
const orderTotals = (o) => computeTotals(o.items);
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random());
function download(name, type, data) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const csvCell = (v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCsv = (rows) => "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

// =====================================================================================
// QZ TRAY — same connection pattern as the hotel file, with clearer errors and recovery.
// Signing (optional, admin): the certificate + private key created by QZ Tray's Site Manager on THIS
// computer are kept in this browser's storage (never in this file or in backups) and requests are
// signed with Web Crypto (RSA SHA-512), which removes the "Allow" prompts. Without them QZ Tray
// asks staff to allow the page, as the hotel file did.
// =====================================================================================
const PRINT_KEY = "hbm_rpos_printer_v1";
const SIGN_KEY = "hbm_rpos_qz_signing_v1";
const PRINT_DEFAULTS = { printer: "", mode: "escpos", paperWidthMm: 58, printableWidthMm: 48, charsPerLine: 32, feedLines: 4, cut: true, openDrawer: false, codePage: 0 };
// Until a printer is saved here, reuse the printer and paper width saved by the hotel file in this
// browser ("welkite_printer" / "welkite_paper"), since that printer is known to work on this computer.
function inheritedDefaults() {
  const d = { ...PRINT_DEFAULTS };
  try {
    const printer = localStorage.getItem("welkite_printer");
    const paper = localStorage.getItem("welkite_paper");
    if (printer) d.printer = printer;
    if (paper === "80") Object.assign(d, { paperWidthMm: 80, printableWidthMm: 72, charsPerLine: 48 });
  } catch {}
  return d;
}
const getPrintCfg = () => { try { const saved = JSON.parse(localStorage.getItem(PRINT_KEY)); return saved ? { ...PRINT_DEFAULTS, ...saved } : inheritedDefaults(); } catch { return inheritedDefaults(); } };
// Same rule as the hotel file: prefer a receipt/thermal printer, otherwise the first one.
const pickReceiptPrinter = (list) => list.find((p) => /CN710|thermal|receipt|POS|XP-|TM-|80mm|58mm/i.test(p)) || list[0] || "";
const savePrintCfg = (c) => localStorage.setItem(PRINT_KEY, JSON.stringify(c));
const getSigning = () => { try { return JSON.parse(localStorage.getItem(SIGN_KEY)) || null; } catch { return null; } };

function pemBody(pem, label) {
  const m = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`).exec(pem || "");
  return m ? unb64(m[1].replace(/\s+/g, "")) : null;
}
let signKeyCache = null;
let lastQzError = "";
async function importSigningKey(keyPem) {
  if (/BEGIN RSA PRIVATE KEY/.test(keyPem)) throw new Error("This key is in PKCS#1 format. Use the private-key.pem created by QZ Tray's Site Manager (PKCS#8), or convert it: openssl pkcs8 -topk8 -nocrypt -in key.pem -out private-key.pem");
  const der = pemBody(keyPem, "PRIVATE KEY");
  if (!der) throw new Error("Paste the whole private-key.pem, including the BEGIN/END PRIVATE KEY lines.");
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" }, false, ["sign"]);
}
async function signForQZ(toSign) {
  const s = getSigning();
  if (!s) return undefined;
  if (!signKeyCache || signKeyCache.pem !== s.key) signKeyCache = { pem: s.key, key: await importSigningKey(s.key) };
  return b64(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signKeyCache.key, new TextEncoder().encode(toSign)));
}
function setupQZ() {
  if (!window.qz) return;
  const s = getSigning();
  qz.security.setCertificatePromise((resolve) => resolve(s ? s.cert : undefined));
  qz.security.setSignatureAlgorithm("SHA512");
  qz.security.setSignaturePromise((toSign) => (resolve, reject) => { signForQZ(toSign).then(resolve, reject); });
}
const errText = (e) => (!e ? "Unknown error" : typeof e === "string" ? e : e.message || String(e));
function explainQZ(e) {
  const m = errText(e);
  if (/ConnectException|Connection refused|connect timed out|UnknownHost|No route to host/i.test(m)) return "The network printer did not answer (" + m.replace(/^.*Exception:\s*/, "") + "). Check it is on and that the IP address and port are correct.";
  if (/Unable to establish connection|not running|closed/i.test(m)) return "QZ Tray is not reachable. Start QZ Tray on this computer (tray icon near the clock), then press Connect. If the browser asked to access apps on this device, choose Allow.";
  if (/blocked|denied|rejected|untrusted/i.test(m)) return "The request was blocked in QZ Tray. Press Connect again and choose Allow in the QZ Tray window.";
  if (/printer|PrintException/i.test(m)) return "Printer problem: " + m + ". Check the printer is on and installed, then Detect printers and Save.";
  return m;
}
async function qzConnect() {
  if (!window.qz) throw new Error("The QZ Tray library is missing from this page.");
  setupQZ();
  if (!qz.websocket.isActive()) {
    try { await qz.websocket.connect({ retries: 2, delay: 1 }); } catch (e) { throw new Error(explainQZ(e)); }
  }
}
const netPrinter = (p) => { const m = /^net:\/\/([^:\/\s]+)(?::(\d{1,5}))?$/.exec(String(p || "").trim()); return m ? { host: m[1], port: Number(m[2] || 9100) } : null; };
async function qzSend(cfg, lines) {
  await qzConnect();
  const target = netPrinter(cfg.printer) || cfg.printer;
  const run = () => {
    if (cfg.mode === "html") {
      if (netPrinter(cfg.printer)) throw new Error("HTML printing needs an installed printer. Use Raw ESC/POS for a network (IP) printer.");
      const c = qz.configs.create(target, { units: "mm", size: { width: cfg.paperWidthMm, height: null }, margins: 0, scaleContent: false, rasterize: true, density: 203, colorType: "blackwhite" });
      return qz.print(c, [{ type: "pixel", format: "html", flavor: "plain", data: receiptDocumentHtml(lines, cfg), options: { pageWidth: cfg.paperWidthMm } }]);
    }
    const bytes = encodeEscPos(lines, { feedLines: cfg.feedLines, cut: cfg.cut, openDrawer: cfg.openDrawer, codePage: cfg.codePage });
    return qz.print(qz.configs.create(target, { encoding: "ISO-8859-1" }), [{ type: "raw", format: "command", flavor: "base64", data: bytesToBase64(bytes) }]);
  };
  try { await run(); lastQzError = ""; }
  catch (e) {
    lastQzError = errText(e);
    if (/websocket|connection|closed|not connect/i.test(errText(e)) && !/ConnectException|refused/i.test(errText(e))) {
      try { await qz.websocket.disconnect(); } catch {}
      await qzConnect();
      try { await run(); } catch (e2) { throw new Error(explainQZ(e2)); }
    } else throw new Error(explainQZ(e));
  }
}

// FALLBACK ONLY: the browser's print dialog (not QZ Tray), printing the receipt alone.
function browserPrint(lines, cfg) {
  return new Promise((resolve) => {
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    f.srcdoc = receiptDocumentHtml(lines, cfg);
    f.onload = () => setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } finally { setTimeout(() => { f.remove(); resolve(); }, 500); } }, 150);
    document.body.appendChild(f);
  });
}

function txReceiptLines(tx, copy, cfg) {
  return layoutReceipt(buildReceiptFromTransaction(tx, { copy }), cfg.charsPerLine);
}

// =====================================================================================
// SMALL UI PIECES (hotel styling)
// =====================================================================================
const H1 = ({ children, sub }) => (<><h1 className="serif" style={{ fontSize: 40, marginBottom: 4 }}>{children}</h1>{sub && <div style={{ color: "#7a5e3a", marginBottom: 24 }}>{sub}</div>}</>);
const Card = ({ children, style }) => <div className="ink-card" style={{ padding: 22, marginBottom: 16, ...style }}>{children}</div>;
const Field = ({ label, children, help }) => (<label className="field"><span>{label}</span>{children}{help && <div className="muted small" style={{ marginTop: 4 }}>{help}</div>}</label>);
const Badge = ({ s }) => <span className={"badge st-" + s}>{s === "submitted" ? "in kitchen" : s}</span>;
function Modal({ children, onClose, wide }) {
  useEffect(() => { const k = (e) => e.key === "Escape" && onClose(); document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onClose]);
  return (<div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className={"modal" + (wide ? " wide" : "")} role="dialog" aria-modal="true">{children}</div></div>);
}
function Ask({ title, label, help, okLabel = "OK", required = true, initial = "", onDone }) {
  const [v, setV] = useState(initial); const [err, setErr] = useState("");
  const ok = () => { if (required && !v.trim()) return setErr("This is required."); onDone(v.trim()); };
  return (<Modal onClose={() => onDone(undefined)}>
    <h2 className="serif">{title}</h2>{help && <p className="muted small" style={{ marginBottom: 10 }}>{help}</p>}
    <Field label={label}><input autoFocus className="ink-input" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ok()} /></Field>
    <div className="err">{err}</div>
    <div className="modal-actions"><button className="ink-btn-ghost plain" onClick={() => onDone(undefined)}>Back</button><button className="ink-btn" onClick={ok}>{okLabel}</button></div>
  </Modal>);
}
function ReceiptPaper({ lines, cfg, caption, watermark }) {
  const pxPerMm = 3.78 * 1.5;
  const fontPx = (cfg.printableWidthMm * pxPerMm) / (cfg.charsPerLine * 0.6);
  return (<div>
    {caption && <div className="rc-caption">{caption}</div>}
    <div className="rc-paper" style={{ width: cfg.paperWidthMm * pxPerMm }}>
      {watermark && <div className="rc-watermark">{watermark}</div>}
      <div className="rc" style={{ width: cfg.printableWidthMm * pxPerMm, fontSize: fontPx.toFixed(2) + "px" }} dangerouslySetInnerHTML={{ __html: receiptLinesToHtml(lines) }} />
    </div>
  </div>);
}

// =====================================================================================
// APP
// =====================================================================================
function App() {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [user, setUser] = useState(null);
  const [page, setPage] = useState("salon");
  const [toasts, setToasts] = useState([]);
  const [qzStatus, setQzStatus] = useState("offline");
  const [receiptFor, setReceiptFor] = useState(null); // { id, autoPrint }

  const toast = useCallback((msg, kind = "ok") => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-2), { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  const refresh = useCallback(() => setState(snapshot()), []);
  const act = useCallback(async (fn, okMsg) => {
    try { const r = await commit(fn); refresh(); if (okMsg) toast(okMsg); return r; }
    catch (e) { toast(e.message || String(e), "bad"); refresh(); return undefined; }
  }, [refresh, toast]);

  useEffect(() => {
    loadState().then((s) => {
      setState(s);
      const uid = Number(sessionStorage.getItem("hbm_rpos_user"));
      const u = s.core.users.find((x) => x.id === uid && x.active);
      if (u) setUser(u);
    }).catch((e) => setLoadError(e.message || String(e)));
    navigator.storage?.persist?.().catch(() => {});
    if (channel) channel.onmessage = () => loadState().then(setState);
  }, []);

  const tryConnect = useCallback(async () => {
    setQzStatus("connecting");
    try { await qzConnect(); setQzStatus("connected"); } catch (e) { setQzStatus("offline"); lastQzError = e.message; throw e; }
    // Like the hotel file: if no printer is chosen yet, choose the receipt printer automatically.
    const cfg = getPrintCfg();
    if (!cfg.printer) {
      try {
        const ps = await qz.printers.find();
        const pick = pickReceiptPrinter(Array.isArray(ps) ? ps : [ps]);
        if (pick) { savePrintCfg({ ...cfg, printer: pick }); toast(`Printer selected automatically: ${pick}. Change it in The Press if needed.`, "info"); }
      } catch { /* printers can still be chosen manually in The Press */ }
    }
    return true;
  }, [toast]);
  useEffect(() => {
    if (!user || !window.qz) return;
    setupQZ();
    qz.websocket.setClosedCallbacks(() => setQzStatus("offline"));
    tryConnect().catch(() => {});
  }, [user, tryConnect]);

  if (loadError) return <div className="login-wrap"><div className="ink-card login-card"><h2 className="serif">Cannot open the data store</h2><p>{loadError}</p></div></div>;
  if (!state) return null;
  const S = state.core.settings;
  if (state.core.users.length === 0) return <Setup act={act} onDone={(u) => { sessionStorage.setItem("hbm_rpos_user", u.id); setUser(u); setPage("atelier"); }} name={S.business.displayName} />;
  const liveUser = user && state.core.users.find((x) => x.id === user.id && x.active);
  if (!liveUser) return <Login users={state.core.users} name={S.business.displayName} onLogin={(u) => { sessionStorage.setItem("hbm_rpos_user", u.id); setUser(u); setPage("salon"); }} />;

  const isAdmin = liveUser.role === "admin";
  const PAGES = [
    { key: "salon", label: "Salon" }, { key: "service", label: "Service" }, { key: "ledger", label: "Ledger" },
    { key: "fare", label: "Bill of Fare" }, { key: "reports", label: "Reports", admin: true }, { key: "press", label: "The Press" }, { key: "atelier", label: "Atelier", admin: true },
  ].filter((p) => !p.admin || isAdmin);
  const current = PAGES.some((p) => p.key === page) || page === "sample" ? page : "salon";
  const ctx = { state, S, user: liveUser, isAdmin, act, toast, setPage, openReceipt: (id, autoPrint = false) => setReceiptFor({ id, autoPrint }), qzStatus, tryConnect, refresh };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <header className="topbar">
        <div className="brand">{S.business.displayName}<b>.</b></div>
        <nav className="nav">{PAGES.map((p) => <button key={p.key} className={current === p.key ? "active" : ""} onClick={() => setPage(p.key)}>{p.label}</button>)}</nav>
        <div className="who">
          <button className="qz-pill" title="Printer status" onClick={() => setPage("press")}><span className={"dot " + (qzStatus === "connected" ? "ok" : qzStatus === "connecting" ? "wait" : "bad")} />{qzStatus === "connected" ? "QZ connected" : qzStatus === "connecting" ? "Connecting" : "QZ offline"}</button>
          <span>{liveUser.name} · {liveUser.role}</span>
          <button onClick={() => { sessionStorage.removeItem("hbm_rpos_user"); setUser(null); setPage("salon"); }}>Sign Out</button>
        </div>
      </header>
      <main style={{ flex: 1, width: "100%" }}>
        {current === "salon" && <Salon {...ctx} />}
        {current === "service" && <Service {...ctx} />}
        {current === "ledger" && <Ledger {...ctx} />}
        {current === "fare" && <BillOfFare {...ctx} />}
        {current === "reports" && <Reports {...ctx} />}
        {current === "press" && <Press {...ctx} />}
        {current === "atelier" && <Atelier {...ctx} />}
        {current === "sample" && <SampleCheck {...ctx} />}
      </main>
      {receiptFor && <ReceiptView {...ctx} txId={receiptFor.id} autoPrint={receiptFor.autoPrint} onClose={() => setReceiptFor(null)} />}
      <div className="toast-wrap" role="status">{toasts.map((t) => <div key={t.id} className={"toast " + (t.kind === "ok" ? "" : t.kind)}>{t.kind === "bad" ? "⚠ " : "✓ "}{t.msg}</div>)}</div>
    </div>
  );
}

// ----------------------------------------------------------------------------- setup / login
function Setup({ act, onDone, name }) {
  const [f, setF] = useState({ name: "", username: "", p1: "", p2: "" }); const [err, setErr] = useState("");
  const go = async () => {
    setErr("");
    const username = f.username.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) return setErr("Username: 3-40 letters, digits, dot, dash or underscore.");
    const p = pwProblem(f.p1); if (p) return setErr(p);
    if (f.p1 !== f.p2) return setErr("Passwords do not match.");
    const ph = await hashPassword(f.p1);
    const u = await act((c) => {
      if (c.core.users.length) throw new Error("An administrator already exists. Please sign in.");
      const u = { id: c.next("user"), username, name: f.name.trim() || username, role: "admin", active: true, ...ph, createdAt: new Date().toISOString() };
      c.core.users.push(u); audit(c.core, u, "setup.admin_created", username); return u;
    }, "Administrator account created.");
    if (u) onDone(u);
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (<div className="login-wrap"><div className="ink-card login-card" style={{ maxWidth: 460 }}>
    <div className="login-title">{name}</div><div className="divider-ornate">❦   ❦   ❦</div>
    <div className="muted small" style={{ textAlign: "center", letterSpacing: ".2em", textTransform: "uppercase", marginBottom: 18 }}>First-time setup</div>
    <div className="notice">No accounts exist on this computer yet. Create the administrator account. Keep the password safe — there is no password in this file.</div>
    <Field label="Administrator name"><input className="ink-input" value={f.name} onChange={set("name")} /></Field>
    <Field label="Username"><input className="ink-input" value={f.username} onChange={set("username")} autoComplete="username" /></Field>
    <Field label="Password (at least 8 characters)"><input className="ink-input" type="password" value={f.p1} onChange={set("p1")} autoComplete="new-password" /></Field>
    <Field label="Repeat password"><input className="ink-input" type="password" value={f.p2} onChange={set("p2")} onKeyDown={(e) => e.key === "Enter" && go()} autoComplete="new-password" /></Field>
    <div className="err">{err}</div>
    <button className="ink-btn" style={{ width: "100%", padding: 14 }} onClick={go}>Create administrator</button>
  </div></div>);
}

const failures = {};
function Login({ users, name, onLogin }) {
  const [u, setU] = useState(""); const [p, setP] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async () => {
    const key = u.trim().toLowerCase();
    const f = failures[key];
    if (f && f.n >= 5 && Date.now() - f.t < 300000) return setErr("Too many failed attempts. Wait 5 minutes.");
    setBusy(true); setErr("");
    const found = users.find((x) => x.username === key && x.active);
    const ok = found && (await checkPassword(found, p));
    setBusy(false);
    if (!ok) { failures[key] = { n: (f && Date.now() - f.t < 300000 ? f.n : 0) + 1, t: Date.now() }; return setErr("Incorrect username or password."); }
    delete failures[key];
    onLogin(found);
  };
  return (<div className="login-wrap"><div className="ink-card login-card">
    <div className="login-title">{name}</div><div className="divider-ornate">❦   ❦   ❦</div>
    <div className="muted small" style={{ textAlign: "center", letterSpacing: ".2em", textTransform: "uppercase", marginBottom: 22 }}>Hawassa · Restaurant service</div>
    <input className="ink-input" style={{ marginBottom: 10 }} placeholder="Username" value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" autoFocus />
    <input className="ink-input" style={{ marginBottom: 6 }} type="password" placeholder="Password" value={p} onChange={(e) => setP(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} autoComplete="current-password" />
    <div className="err">{err}</div>
    <button className="ink-btn" style={{ width: "100%", padding: 14 }} disabled={busy} onClick={submit}>Sign In</button>
  </div></div>);
}

// ----------------------------------------------------------------------------- Salon (dashboard)
function Salon({ state, S, setPage, openReceipt, act, user }) {
  const d = todayLocal(S.timezone);
  const todays = state.txs.filter((t) => t.localDate === d && t.status === "completed");
  const unpaid = state.orders.filter((o) => ORDER_OPEN.includes(o.status));
  const tables = state.core.tables.filter((t) => t.active);
  const busy = new Map(unpaid.filter((o) => o.tableId).map((o) => [o.tableId, o]));
  const unprinted = state.txs.filter((t) => t.localDate === d && !t.prints.some((p) => p.status === "sent"));
  const stat = (label, value, unit, go) => (<div className="ink-card" style={{ padding: 24, cursor: "pointer" }} onClick={() => setPage(go)}>
    <div className="stat-label">{label}</div><div className="stat-value">{value}{unit && <small> {unit}</small>}</div></div>);
  const startAt = async (t) => {
    const id = await act((c) => { const o = newOrder(c, user, "dine_in", t.id); return o.id; });
    if (id) { sessionStorage.setItem("hbm_rpos_order", id); setPage("service"); }
  };
  const backupAge = state.core.lastBackupAt ? Math.floor((Date.now() - Date.parse(state.core.lastBackupAt)) / 86400000) : null;
  return (<div style={{ maxWidth: 1200, margin: "0 auto", padding: "32px clamp(16px,4vw,48px)" }}>
    <div className="serif" style={{ fontSize: 48, marginBottom: 6 }}>Good day.</div>
    <div style={{ color: "#7a5e3a", fontSize: 14, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 32 }}>An overview of {S.business.displayName} — {new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</div>
    <div className="grid stats">
      {stat("Today's sales (incl. VAT)", money(todays.reduce((a, t) => a + t.totalCents, 0)), S.currency, "ledger")}
      {stat("Completed transactions", todays.length, "", "ledger")}
      {stat("Unpaid orders", unpaid.length, "", "service")}
      {stat("Occupied tables", `${busy.size} / ${tables.length}`, "", "service")}
    </div>
    {unprinted.length > 0 && <div className="notice bad">{unprinted.length} sale(s) today have no successful receipt print. Open the Ledger to print them.</div>}
    {user.role === "admin" && (backupAge === null || backupAge >= 1) && <div className="notice">Sales are stored in this browser on this computer. {backupAge === null ? "No backup has been made yet." : `Last backup ${backupAge} day(s) ago.`} Make a backup in Atelier → Backup.</div>}
    <div className="two-col">
      <div className="ink-card" style={{ padding: 28 }}>
        <div className="serif" style={{ fontSize: 24, marginBottom: 4 }}>Recent Transactions</div>
        <div style={{ color: "#9a7e5a", fontSize: 12, marginBottom: 18 }}>Latest 10 entries from the ledger</div>
        {state.txs.slice(0, 10).map((t) => (
          <div key={t.id} onClick={() => openReceipt(t.id)} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "12px 0", borderBottom: "1px dotted #cdb88a", fontSize: 13, cursor: "pointer" }}>
            <div><span className="serif" style={{ color: "#c8553d", marginRight: 10 }}>№</span><span className="mono">{pad8(t.receiptNo)}</span></div>
            <div style={{ color: "#7a5e3a" }}>{t.receiptDate} {t.receiptTime.slice(0, 5)}</div>
            <div className="serif">{t.status === "voided" ? <span className="fail">VOID </span> : null}ETB {money(t.totalCents)}</div>
          </div>))}
        {state.txs.length === 0 && <div style={{ color: "#9a7e5a", fontStyle: "italic", padding: "20px 0" }}>The ledger awaits its first entry. <button onClick={() => setPage("service")} className="ink-btn" style={{ marginLeft: 10 }}>Take an order</button></div>}
      </div>
      <div className="ink-card" style={{ padding: 28 }}>
        <div className="serif" style={{ fontSize: 24, marginBottom: 12 }}>Tables</div>
        <div className="table-grid">{tables.map((t) => { const o = busy.get(t.id); return (
          <button key={t.id} className={"table-tile " + (o ? "busy" : "free")} onClick={() => { if (o) { sessionStorage.setItem("hbm_rpos_order", o.id); setPage("service"); } else startAt(t); }}>
            <div className="lb">{t.label}</div><div className="small muted">{o ? "occupied" : "free"}</div></button>); })}</div>
      </div>
    </div>
  </div>);
}

function newOrder(c, user, orderType, tableId) {
  if (orderType === "dine_in") {
    const t = c.core.tables.find((x) => x.id === tableId && x.active);
    if (!t) throw new Error("Choose a table for a dine-in order.");
  }
  const now = new Date().toISOString();
  const o = { id: c.next("order"), orderType, tableId: orderType === "dine_in" ? tableId : null, status: "open", note: "", items: [], createdAt: now, updatedAt: now, createdBy: user.name };
  c.putOrder(o); audit(c.core, user, "order.created", { id: o.id, orderType, tableId });
  return o;
}

// ----------------------------------------------------------------------------- Service (orders)
function Service({ state, S, user, isAdmin, act, toast, openReceipt }) {
  const [selId, setSelId] = useState(() => Number(sessionStorage.getItem("hbm_rpos_order")) || null);
  const [cat, setCat] = useState(state.core.categories.find((c) => c.active)?.id);
  const [filter, setFilter] = useState("active");
  const [ask, setAsk] = useState(null);
  const [pay, setPay] = useState(false);
  const [pickTable, setPickTable] = useState(null); // "new" | "move"
  useEffect(() => { if (selId) sessionStorage.setItem("hbm_rpos_order", selId); else sessionStorage.removeItem("hbm_rpos_order"); }, [selId]);
  const tables = state.core.tables;
  const order = state.orders.find((o) => o.id === selId) || null;
  const editable = order && ORDER_OPEN.includes(order.status);
  const totals = order ? orderTotals(order) : null;
  const busy = new Map(state.orders.filter((o) => ORDER_OPEN.includes(o.status) && o.tableId).map((o) => [o.tableId, o]));
  const shown = state.orders.filter((o) => (filter === "active" ? ORDER_OPEN.includes(o.status) : o.status === filter)).slice(0, 60);

  const mutate = (fn, msg) => act((c) => {
    const o = c.getOrder(order.id);
    if (!ORDER_OPEN.includes(o.status)) throw new Error(`Order is ${o.status} and can no longer be changed.`);
    fn(o, c); o.updatedAt = new Date().toISOString(); c.putOrder(o);
  }, msg);
  const addItem = (m, qtyMilli = 1000) => mutate((o, c) => {
    const item = c.core.menu.find((x) => x.id === m.id);
    if (!item || !item.available || item.archived) throw new Error(`${m.name} is unavailable.`);
    const same = o.items.find((i) => i.menuId === item.id && !i.note && i.unitPriceCents === item.priceCents && i.taxRateBp === item.taxRateBp);
    if (same) same.qtyMilli += qtyMilli;
    else o.items.push({ id: c.next("line"), menuId: item.id, name: item.name, receiptName: item.receiptName || item.name, unit: item.unit, unitPriceCents: item.priceCents, taxRateBp: item.taxRateBp, qtyMilli, note: "" });
    audit(c.core, user, "order.item_added", { order: o.id, item: item.name, qtyMilli });
  });
  const setQty = (line, q) => { if (!q || q <= 0) return toast("Quantity must be greater than 0", "bad"); mutate((o, c) => { o.items.find((i) => i.id === line.id).qtyMilli = q; audit(c.core, user, "order.qty", { order: o.id, item: line.name, q }); }); };
  const setStatus = (to, reason) => act((c) => {
    const o = c.getOrder(order.id);
    const allowed = { open: ["submitted", "cancelled"], submitted: ["ready", "open", "cancelled"], ready: ["submitted", "cancelled"] };
    if (!allowed[o.status]?.includes(to)) throw new Error(`Cannot change from ${o.status} to ${to}.`);
    if (to === "submitted" && !o.items.length) throw new Error("Add at least one item first.");
    if (to === "cancelled") {
      if (!isAdmin && o.status !== "open") throw new Error("Only an administrator can cancel an order already sent to the kitchen.");
      o.cancelReason = reason; o.cancelledBy = user.name;
    }
    o.status = to; o.updatedAt = new Date().toISOString(); c.putOrder(o);
    audit(c.core, user, "order.status", { order: o.id, to, reason });
  });
  const start = async (type, tableId) => { const id = await act((c) => newOrder(c, user, type, tableId).id); if (id) setSelId(id); };

  const menu = state.core.menu.filter((m) => !m.archived && m.categoryId === cat);
  return (<div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 400px", gap: 24, maxWidth: 1400, margin: "0 auto", alignItems: "start", padding: "32px clamp(16px,4vw,48px)" }} className="service-grid">
    <div>
      <H1 sub={editable ? `Adding to order #${order.id} — ${orderLabel(order, tables)}` : "Compose an order for the dining room or takeaway."}>Service</H1>
      <div className="row" style={{ marginBottom: 16 }}>
        <button className="ink-btn" onClick={() => setPickTable("new")}>+ Dine-in order</button>
        <button className="ink-btn dark" onClick={() => start("takeaway")}>+ Takeaway order</button>
        {editable && <button className="ink-btn-ghost plain" onClick={() => setSelId(null)}>← All orders</button>}
      </div>
      {editable ? (<>
        <div className="chips">{state.core.categories.filter((c) => c.active).map((c) => <button key={c.id} className={"chip" + (cat === c.id ? " active" : "")} onClick={() => setCat(c.id)}>{c.name}</button>)}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
          {menu.map((m) => (<button key={m.id} disabled={!m.available} onClick={() => m.unit === "kg" ? setAsk({ kind: "weight", m }) : addItem(m)} className="ink-card menu-tile" style={{ padding: 16, opacity: m.available ? 1 : 0.45 }}>
            <div className="serif" style={{ fontSize: 17, marginBottom: 6 }}>{m.name}</div>
            <div style={{ color: "#c8553d", fontSize: 14, fontWeight: 700 }}>{formatAmount(netToGrossCents(m.priceCents, m.taxRateBp))} ETB{m.unit === "kg" ? " /kg" : ""}<span className="muted small" style={{ fontWeight: 400 }}> incl. VAT</span></div>
            {!m.available && <div className="small">Sold out</div>}
          </button>))}
        </div>
      </>) : (<>
        <div className="chips">{[["active", "Active"], ["open", "Open"], ["submitted", "In kitchen"], ["ready", "Ready"], ["paid", "Paid"], ["cancelled", "Cancelled"]].map(([k, l]) => <button key={k} className={"chip" + (filter === k ? " active" : "")} onClick={() => setFilter(k)}>{l}</button>)}</div>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(210px,1fr))" }}>
          {shown.map((o) => (<div key={o.id} className={"ink-card order-card" + (o.id === selId ? " sel" : "")} onClick={() => setSelId(o.id)}>
            <div className="spread"><b>#{o.id} · {orderLabel(o, tables)}</b><Badge s={o.status} /></div>
            <div className="muted small" style={{ margin: "6px 0" }}>{o.items.length} line(s) · {new Date(o.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} · {o.createdBy}</div>
            <div className="serif" style={{ fontSize: 18 }}>ETB {money(orderTotals(o).totalCents)}</div>
          </div>))}
        </div>
        {shown.length === 0 && <p className="muted" style={{ fontStyle: "italic" }}>No orders in this view.</p>}
      </>)}
    </div>

    <div className="ink-card" style={{ padding: 22, position: "sticky", top: 16 }}>
      {!order ? (<><h2 className="serif" style={{ fontSize: 24 }}>The Order</h2><div className="divider-ornate" style={{ fontSize: 12 }}>· · ·</div><p className="muted" style={{ fontStyle: "italic", textAlign: "center" }}>Start a dine-in or takeaway order, or pick one from the list.</p></>) : (<>
        <div className="spread"><h2 className="serif" style={{ fontSize: 24 }}>Order #{order.id}</h2><Badge s={order.status} /></div>
        <div className="row muted small" style={{ margin: "4px 0 8px" }}>{orderLabel(order, tables)} · by {order.createdBy}{editable && <button className="ink-btn-ghost btn-sm plain" onClick={() => setPickTable("move")}>Change table / type</button>}</div>
        {order.cancelReason && <div className="notice bad">Cancelled: {order.cancelReason}</div>}
        <div className="divider-ornate" style={{ fontSize: 12, margin: "8px 0 10px" }}>· · ·</div>
        <div style={{ borderTop: "1px dashed #cdb88a" }}>
          {order.items.length === 0 && <div style={{ color: "#9a7e5a", fontStyle: "italic", padding: "14px 0", textAlign: "center" }}>No items selected</div>}
          {totals.lines.map((it) => { const step = it.unit === "kg" ? 250 : 1000; return (
            <div key={it.id} className="order-line">
              <div className="top"><div><b>{it.name}</b><div className="muted small mono">{formatQty(it.qtyMilli, it.unit)} x {formatAmount(it.unitPriceCents)}</div></div><div className="mono">{formatAmount(it.amountCents)}</div></div>
              {it.note && <div className="small" style={{ color: "#a64530", margin: "4px 0" }}>Note: {it.note}</div>}
              {editable && <div className="row" style={{ marginTop: 6 }}>
                <div className="qty">
                  <button title="Less" disabled={it.qtyMilli <= step} onClick={() => setQty(it, it.qtyMilli - step)}>−</button>
                  <input key={it.qtyMilli} defaultValue={formatDecimal(it.qtyMilli, 3).replace(/\.?0+$/, "")} inputMode="decimal" aria-label="Quantity" onBlur={(e) => { const q = parseQty(e.target.value); if (q !== it.qtyMilli) setQty(it, q); }} onKeyDown={(e) => e.key === "Enter" && e.target.blur()} />
                  <button title="More" onClick={() => setQty(it, it.qtyMilli + step)}>+</button>
                </div>
                <button className="ink-btn-ghost btn-sm plain" onClick={() => setAsk({ kind: "note", line: it })}>{it.note ? "Edit note" : "Note"}</button>
                <button className="ink-btn-ghost btn-sm" onClick={() => mutate((o, c) => { o.items = o.items.filter((i) => i.id !== it.id); audit(c.core, user, "order.item_removed", { order: o.id, item: it.name }); })}>Remove</button>
              </div>}
            </div>); })}
        </div>
        <textarea key={order.id + ":" + order.updatedAt} className="ink-input" style={{ margin: "12px 0" }} placeholder="Order note (allergies, timing…)" disabled={!editable} defaultValue={order.note} onBlur={(e) => e.target.value !== order.note && mutate((o) => { o.note = e.target.value.slice(0, 300); })} />
        <div style={{ borderTop: "1px solid #cdb88a", paddingTop: 12, fontSize: 13 }} className="totals">
          {totals.taxGroups.map((g) => (<React.Fragment key={g.rateBp}><div><span>Taxable {formatRate(g.rateBp)}%</span><span className="mono">{formatAmount(g.taxableCents)}</span></div><div><span>VAT {formatRate(g.rateBp)}%</span><span className="mono">{formatAmount(g.taxCents)}</span></div></React.Fragment>))}
          <div className="serif" style={{ display: "flex", justifyContent: "space-between", marginTop: 12, paddingTop: 12, borderTop: "2px solid #c8553d", fontSize: 22 }}><span>Total</span><span style={{ color: "#c8553d" }}>ETB {money(totals.totalCents)}</span></div>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          {order.status === "open" && <button className="ink-btn dark" disabled={!order.items.length} onClick={() => setStatus("submitted")}>Send to kitchen</button>}
          {order.status === "submitted" && <><button className="ink-btn dark" onClick={() => setStatus("ready")}>Mark ready</button><button className="ink-btn-ghost plain" onClick={() => setStatus("open")}>Reopen</button></>}
          {order.status === "ready" && <button className="ink-btn-ghost plain" onClick={() => setStatus("submitted")}>Back to kitchen</button>}
          {editable && (order.status === "open" || isAdmin) && <button className="ink-btn-ghost" onClick={() => setAsk({ kind: "cancel" })}>Cancel order</button>}
          {order.status === "paid" && <button className="ink-btn" onClick={() => { const t = state.txs.find((x) => x.orderId === order.id); t && openReceipt(t.id); }}>View receipt</button>}
        </div>
        {editable && <button className="ink-btn" disabled={!order.items.length} style={{ width: "100%", marginTop: 14, padding: 14, fontSize: 16 }} onClick={() => setPay(true)}>Settle Account</button>}
      </>)}
    </div>

    {ask?.kind === "weight" && <Ask title={`Weight — ${ask.m.name}`} label="Weight in kg (e.g. 1.000 or 0.500)" initial="1.000" okLabel="Add" onDone={(v) => { setAsk(null); if (v === undefined) return; const q = parseQty(v); if (!q) return toast("Enter a weight such as 0.750", "bad"); addItem(ask.m, q); }} />}
    {ask?.kind === "note" && <Ask title="Line note" label="Note for the kitchen" required={false} initial={ask.line.note} okLabel="Save" onDone={(v) => { setAsk(null); if (v !== undefined) mutate((o) => { o.items.find((i) => i.id === ask.line.id).note = v.slice(0, 120); }); }} />}
    {ask?.kind === "cancel" && <Ask title={`Cancel order #${order.id}`} label="Reason for cancelling" okLabel="Cancel order" onDone={(v) => { setAsk(null); if (v) setStatus("cancelled", v); }} />}
    {pickTable && <TablePicker tables={tables} busy={busy} current={order} allowTakeaway={pickTable === "move"} onDone={async (r) => {
      const mode = pickTable; setPickTable(null); if (!r) return;
      if (mode === "new") { const existing = busy.get(r.tableId); if (existing) setSelId(existing.id); else start("dine_in", r.tableId); }
      else mutate((o, c) => { if (r.orderType === "dine_in" && !c.core.tables.find((t) => t.id === r.tableId && t.active)) throw new Error("Choose a table."); o.orderType = r.orderType; o.tableId = r.orderType === "dine_in" ? r.tableId : null; });
    }} />}
    {pay && order && <PayModal order={order} totals={totals} S={S} user={user} act={act} toast={toast} tables={tables} onClose={(tx) => { setPay(false); if (tx) { setSelId(null); openReceipt(tx.id, S.autoPrint && !tx.replay); } }} />}
  </div>);
}

function TablePicker({ tables, busy, current, allowTakeaway, onDone }) {
  return (<Modal onClose={() => onDone(null)}>
    <h2 className="serif">{allowTakeaway ? "Change table / type" : "New dine-in order"}</h2>
    {allowTakeaway && <div className="row" style={{ marginBottom: 12 }}><button className="ink-btn dark" onClick={() => onDone({ orderType: "takeaway" })}>Make takeaway</button></div>}
    <p className="muted small" style={{ marginBottom: 10 }}>{allowTakeaway ? "Or move to table:" : "Choose a table. Occupied tables open their current order."}</p>
    <div className="table-grid">{tables.filter((t) => t.active).map((t) => { const o = busy.get(t.id); return (
      <button key={t.id} className={"table-tile " + (o && o.id !== current?.id ? "busy" : "free")} onClick={() => onDone({ orderType: "dine_in", tableId: t.id })}><div className="lb">{t.label}</div><div className="small muted">{o ? "occupied" : "free"}</div></button>); })}</div>
    <div className="modal-actions"><button className="ink-btn-ghost plain" onClick={() => onDone(null)}>Back</button></div>
  </Modal>);
}

// Payment: one sale per order. A second click, or a retry, returns the existing sale.
function PayModal({ order, totals, S, user, act, toast, tables, onClose }) {
  const methods = S.paymentMethods.filter((m) => m.enabled);
  const [method, setMethod] = useState(methods[0]?.id);
  const [tendered, setTendered] = useState("");
  const [ref, setRef] = useState("");
  const [tin, setTin] = useState("");
  const [bname, setBname] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey()).current;
  const total = totals.totalCents;
  const t = parseAmount(tendered);
  const quick = [total, Math.ceil(total / 5000) * 5000, Math.ceil(total / 10000) * 10000, Math.ceil(total / 50000) * 50000].filter((v, i, a) => a.indexOf(v) === i);
  const confirm = async () => {
    setErr("");
    if (method === "cash" && tendered.trim() && (t === null || t < total)) return setErr("Amount received must be at least the total.");
    if (tin.trim() && !/^\d{10}$/.test(tin.trim())) return setErr("Buyer's TIN should be 10 digits.");
    setBusy(true);
    const tx = await act((c) => {
      const prior = c.txs().find((x) => x.orderId === order.id || x.key === key);
      if (prior) return { ...prior, replay: true };
      const o = c.getOrder(order.id);
      if (!ORDER_OPEN.includes(o.status)) throw new Error(`Order is ${o.status}; it cannot be paid.`);
      if (!o.items.length) throw new Error("The order has no items.");
      const calc = computeTotals(o.items);
      if (calc.totalCents !== total) throw new Error("The order changed while the bill was open. Check the total and confirm again.");
      const m = c.core.settings.paymentMethods.find((x) => x.id === method && x.enabled);
      if (!m) throw new Error("Choose a payment method.");
      const tend = method === "cash" && tendered.trim() ? t : calc.totalCents;
      const maxNo = Math.max(0, ...c.txs().map((x) => x.receiptNo));
      const receiptNo = Math.max(c.core.counters.receipt, maxNo + 1);
      c.core.counters.receipt = receiptNo + 1;
      const st = localStamp(new Date(), c.core.settings.timezone);
      const b = c.core.settings.business, r = c.core.settings.receipt;
      const tx = {
        id: receiptNo, receiptNo, key, orderId: o.id, createdAt: new Date().toISOString(), localDate: st.localDate, receiptDate: st.receiptDate, receiptTime: st.receiptTime,
        cashierName: user.name, orderType: o.orderType, tableLabel: o.orderType === "dine_in" ? (c.core.tables.find((x) => x.id === o.tableId)?.label || "") : "",
        buyerTin: tin.trim(), buyerName: bname.trim().slice(0, 40), netCents: calc.netCents, taxCents: calc.taxCents, totalCents: calc.totalCents,
        paymentMethod: m.id, paymentLabel: m.label, tenderedCents: tend, changeCents: tend - calc.totalCents, paymentRef: ref.trim().slice(0, 60),
        lines: calc.lines, taxGroups: calc.taxGroups, fiscalFsNo: "", status: "completed", prints: [],
        receiptSnapshot: { tin: b.tin, headerLines: b.headerLines, heading: r.heading, numberLabel: r.numberLabel, footerLines: r.footerLines, printOrderInfo: r.printOrderInfo },
      };
      c.putTx(tx);
      o.status = "paid"; o.updatedAt = tx.createdAt; c.putOrder(o);
      audit(c.core, user, "sale.created", { receiptNo, total: formatAmount(calc.totalCents), method: m.id });
      return tx;
    });
    setBusy(false);
    if (tx) { toast(`Sale saved — receipt ${pad8(tx.receiptNo)}${tx.replay ? " (already recorded)" : ""}`); onClose(tx); }
    else setErr("Not saved. Press Confirm again — the sale will not be duplicated.");
  };
  return (<Modal onClose={() => !busy && onClose(null)}>
    <h2 className="serif" style={{ fontSize: 28, marginBottom: 4 }}>Payment</h2>
    <div style={{ color: "#7a5e3a", marginBottom: 14 }}>Order #{order.id} · {orderLabel(order, tables)}</div>
    <div className="totals" style={{ marginBottom: 10 }}>
      {totals.taxGroups.map((g) => (<React.Fragment key={g.rateBp}><div><span>TXBL {g.index} ({formatRate(g.rateBp)}%)</span><span className="mono">{formatAmount(g.taxableCents)}</span></div><div><span>TAX {g.index} ({formatRate(g.rateBp)}%)</span><span className="mono">{formatAmount(g.taxCents)}</span></div></React.Fragment>))}
    </div>
    <div className="serif" style={{ fontSize: 32, color: "#c8553d", textAlign: "center", marginBottom: 16 }}>ETB {money(total)}</div>
    <div className="pay-methods" style={{ marginBottom: 12 }}>{methods.map((m) => <button key={m.id} className={method === m.id ? "active" : ""} onClick={() => setMethod(m.id)}>{m.label}</button>)}</div>
    {method === "cash" ? (<>
      <Field label="Amount received (cash)"><input className="ink-input mono" inputMode="decimal" placeholder={formatAmount(total)} value={tendered} onChange={(e) => setTendered(e.target.value)} /></Field>
      <div className="row" style={{ marginBottom: 8 }}>{quick.map((q) => <button key={q} className="ink-btn-ghost btn-sm plain" onClick={() => setTendered(formatAmount(q))}>{formatAmount(q)}</button>)}</div>
      <div className="serif" style={{ fontSize: 20 }}>Change: {tendered.trim() === "" ? "0.00" : t === null ? "—" : t >= total ? formatAmount(t - total) : "amount too low"}</div>
    </>) : <Field label="Payment reference (optional)"><input className="ink-input" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>}
    <details style={{ margin: "12px 0" }}><summary className="small" style={{ cursor: "pointer" }}>Buyer details (printed as Buyer's TIN / NAME)</summary>
      <div style={{ marginTop: 10 }}><Field label="Buyer's TIN"><input className="ink-input mono" inputMode="numeric" maxLength={10} placeholder="10 digits (optional)" value={tin} onChange={(e) => setTin(e.target.value)} /></Field>
        <Field label="Buyer's name"><input className="ink-input" maxLength={40} placeholder="Optional" value={bname} onChange={(e) => setBname(e.target.value)} /></Field></div></details>
    <div className="err">{err}</div>
    <button className="ink-btn ok" style={{ width: "100%", padding: 14, fontSize: 15 }} disabled={busy} onClick={confirm}>{busy ? "Saving…" : "Confirm payment"}</button>
    <button className="ink-btn-ghost" style={{ width: "100%", padding: 12, marginTop: 6 }} disabled={busy} onClick={() => onClose(null)}>Cancel</button>
  </Modal>);
}

// ----------------------------------------------------------------------------- receipt view / printing
function ReceiptView({ state, user, isAdmin, act, toast, txId, autoPrint, onClose, setPage }) {
  const tx = state.txs.find((t) => t.id === txId);
  const cfg = getPrintCfg();
  const [msg, setMsg] = useState(null);
  const [ask, setAsk] = useState(null);
  const [working, setWorking] = useState(false);
  const printedOk = tx ? tx.prints.some((p) => p.status === "sent" && p.kind !== "test") : false;

  const record = (jobId, patch) => act((c) => { const t = c.getTx(txId); Object.assign(t.prints.find((p) => p.id === jobId), patch, { updatedAt: new Date().toISOString() }); c.putTx(t); });
  const startJob = (reason, mode, printer) => act((c) => {
    const t = c.getTx(txId);
    const copy = t.prints.some((p) => p.status === "sent" && p.kind !== "test");
    if (copy) {
      if (!isAdmin && !c.core.settings.cashierCanReprint) throw new Error("Reprinting is limited to administrators.");
      if (!reason) throw new Error("Give a reason for the reprint.");
      audit(c.core, user, "sale.reprint", { receiptNo: t.receiptNo, reason });
    }
    const job = { id: c.next("print"), kind: copy ? "copy" : "original", status: "pending", printer, mode, reason: reason || "", error: "", user: user.name, at: new Date().toISOString() };
    t.prints.push(job); c.putTx(t);
    return { job, copy, tx: t };
  });

  const doPrint = async (reason = "") => {
    const cfg = getPrintCfg(); // read now: the printer may have been changed since this window opened
    if (!cfg.printer) { setMsg({ bad: true, text: "No printer selected on this computer. Open The Press, detect printers and save one." }); return; }
    setWorking(true); setMsg({ text: "Sending to printer…" });
    const s = await startJob(reason, cfg.mode, cfg.printer);
    if (!s) { setWorking(false); setMsg(null); return; }
    try {
      await qzSend({ ...cfg, openDrawer: cfg.openDrawer && !s.copy && s.tx.paymentMethod === "cash" }, txReceiptLines(s.tx, s.copy, cfg));
      await record(s.job.id, { status: "sent" });
      setMsg({ ok: true, text: s.copy ? "Copy sent to the printer." : "Receipt sent to the printer." });
    } catch (e) {
      await record(s.job.id, { status: "failed", error: e.message });
      setMsg({ bad: true, text: e.message + " — The sale is saved. Fix the problem and press Print again; this will not create another sale." });
    }
    setWorking(false);
  };
  const doBrowser = async (reason = "") => {
    const cfg = getPrintCfg();
    const s = await startJob(reason, "browser-fallback", "browser dialog");
    if (!s) return;
    await browserPrint(txReceiptLines(s.tx, s.copy, cfg), cfg);
    setAsk({ kind: "confirmBrowser", jobId: s.job.id });
  };
  const ran = useRef(false);
  useEffect(() => { if (autoPrint && tx && !ran.current) { ran.current = true; doPrint(""); } }, [autoPrint, tx]);
  if (!tx) return null;
  const last = tx.prints.filter((p) => p.kind !== "test").slice(-1)[0];
  const lines = txReceiptLines(tx, printedOk, cfg);

  return (<Modal wide onClose={() => !working && onClose()}>
    <div className="spread"><h2 className="serif">Receipt {pad8(tx.receiptNo)}</h2><Badge s={tx.status} /></div>
    {tx.status === "voided" && <div className="notice bad">VOIDED: {tx.voidReason}</div>}
    {msg && <div className={"notice " + (msg.bad ? "bad" : msg.ok ? "ok" : "")}>{msg.bad && <b>Print failed: </b>}{msg.text}</div>}
    <div className="small muted">{tx.receiptDate} {tx.receiptTime} · {tx.orderType === "takeaway" ? "Takeaway" : "Table " + tx.tableLabel} · {tx.cashierName} · {tx.paymentLabel}{tx.paymentRef ? " ref " + tx.paymentRef : ""}</div>
    <div className="small muted">{tx.fiscalFsNo ? `Fiscal register FS No.: ${tx.fiscalFsNo}` : "No fiscal-register FS No. recorded."}</div>
    <div className="small" style={{ marginTop: 4 }}>{last ? `Last print: ${last.status.toUpperCase()} (${last.kind})${last.error ? " — " + last.error : ""}` : "Not printed yet."}</div>
    <div className="receipt-stage" style={{ margin: "12px 0" }}><ReceiptPaper lines={lines} cfg={cfg} caption={printedOk ? "Next print will be marked COPY" : "Receipt preview · what will print"} /></div>
    <div className="modal-actions">
      <button className="ink-btn-ghost plain" disabled={working} onClick={onClose}>Close</button>
      <button className="ink-btn-ghost plain" title="Fallback: the exact printer bytes as a file (as the hotel file offered)" onClick={() => { const c = getPrintCfg(); download(`receipt-${pad8(tx.receiptNo)}.bin`, "application/octet-stream", encodeEscPos(lines, { feedLines: c.feedLines, cut: c.cut, codePage: c.codePage })); }}>.bin</button>
      <button className="ink-btn-ghost plain" title="Browser print dialog — not QZ Tray" onClick={() => printedOk ? setAsk({ kind: "reason", then: doBrowser }) : doBrowser("")}>Browser print (fallback)</button>
      <button className="ink-btn-ghost plain" onClick={() => setAsk({ kind: "fs" })}>{tx.fiscalFsNo ? "Edit FS No." : "Record FS No."}</button>
      {isAdmin && tx.status !== "voided" && <button className="ink-btn-ghost" onClick={() => setAsk({ kind: "void" })}>Void sale</button>}
      <button className="ink-btn" disabled={working} onClick={() => printedOk ? setAsk({ kind: "reason", then: doPrint }) : doPrint("")}>{printedOk ? "Reprint (COPY)" : "Print (QZ)"}</button>
    </div>
    {ask?.kind === "reason" && <Ask title="Reprint receipt" label="Reason for reprint (recorded)" help="The original was already printed. The reprint is marked *** COPY ***." okLabel="Reprint" onDone={(v) => { const then = ask.then; setAsk(null); if (v) then(v); }} />}
    {ask?.kind === "fs" && <Ask title="Fiscal register FS No." label="FS No. printed by the fiscal cash register for this sale" required={false} initial={tx.fiscalFsNo} okLabel="Save" help="This file cannot create fiscal numbers. Record the number from the register's receipt so both records match." onDone={(v) => { setAsk(null); if (v === undefined) return; if (v && !/^[0-9A-Za-z-]{1,20}$/.test(v)) return toast("FS No. may contain only letters, digits and dashes.", "bad"); act((c) => { const t = c.getTx(txId); if (t.fiscalFsNo && !isAdmin) throw new Error("Only an administrator can change a recorded FS No."); audit(c.core, user, "sale.fs_recorded", { receiptNo: t.receiptNo, fs: v, previous: t.fiscalFsNo }); t.fiscalFsNo = v; c.putTx(t); }, "FS No. recorded."); }} />}
    {ask?.kind === "void" && <Ask title={`Void receipt ${pad8(tx.receiptNo)}`} label="Reason (recorded; the receipt number stays used)" okLabel="Void sale" onDone={(v) => { setAsk(null); if (v) act((c) => { const t = c.getTx(txId); if (t.status === "voided") throw new Error("Already voided."); t.status = "voided"; t.voidReason = v; t.voidedBy = user.name; t.voidedAt = new Date().toISOString(); c.putTx(t); audit(c.core, user, "sale.voided", { receiptNo: t.receiptNo, reason: v }); }, "Sale voided."); }} />}
    {ask?.kind === "confirmBrowser" && <Modal onClose={() => {}}><h2 className="serif">Browser print</h2><p>Did the receipt print correctly?</p><div className="modal-actions">
      <button className="ink-btn-ghost plain" onClick={() => { record(ask.jobId, { status: "failed", error: "Browser print not confirmed" }); setAsk(null); }}>No</button>
      <button className="ink-btn ok" onClick={() => { record(ask.jobId, { status: "sent" }); setAsk(null); }}>Yes, printed</button></div></Modal>}
  </Modal>);
}

// ----------------------------------------------------------------------------- Ledger (transactions)
function Ledger({ state, S, openReceipt, isAdmin }) {
  const today = todayLocal(S.timezone);
  const [from, setFrom] = useState(today); const [to, setTo] = useState(today);
  const [q, setQ] = useState(""); const [status, setStatus] = useState(""); const [method, setMethod] = useState("");
  const rows = state.txs.filter((t) => (!from || t.localDate >= from) && (!to || t.localDate <= to) && (!status || t.status === status) && (!method || t.paymentMethod === method)
    && (!q.trim() || [pad8(t.receiptNo), String(t.receiptNo), t.fiscalFsNo, t.buyerTin, t.buyerName, t.cashierName, t.tableLabel, ...t.lines.map((l) => l.name + " " + l.receiptName)].some((s) => String(s || "").toLowerCase().includes(q.trim().toLowerCase()))));
  const done = rows.filter((r) => r.status === "completed");
  const sum = (k) => done.reduce((a, r) => a + r[k], 0);
  return (<div style={{ maxWidth: 1200, margin: "0 auto", padding: "32px clamp(16px,4vw,48px)" }}>
    <H1 sub="Every sale: search, view or reprint its receipt, and record the fiscal register's FS number.">The Ledger</H1>
    <Card>
      <div className="row" style={{ marginBottom: 12 }}>
        <Field label="From"><input type="date" className="ink-input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" className="ink-input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Search"><input className="ink-input" placeholder="Receipt no., FS no., item, buyer, cashier, table" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 260 }} /></Field>
        <Field label="Status"><select className="ink-input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="completed">Completed</option><option value="voided">Voided</option></select></Field>
        <Field label="Payment"><select className="ink-input" value={method} onChange={(e) => setMethod(e.target.value)}><option value="">All</option>{S.paymentMethods.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></Field>
        {isAdmin && <button className="ink-btn-ghost btn-sm" onClick={() => exportTransactions(rows, from, to)}>Export CSV</button>}
      </div>
      <div className="muted small" style={{ marginBottom: 8 }}>{rows.length} transaction(s) · completed total ETB {money(sum("totalCents"))} (net {money(sum("netCents"))}, VAT {money(sum("taxCents"))})</div>
      <div className="table-scroll"><table className="list"><tbody>
        <tr>{["Receipt", "Date", "Time", "Order", "Cashier", "Payment", "FS No.", "Total", "Status", "Printed"].map((c, i) => <th key={c} className={i === 7 ? "num" : ""}>{c}</th>)}</tr>
        {rows.map((t) => (<tr key={t.id} className="click" onClick={() => openReceipt(t.id)}>
          <td className="mono">{pad8(t.receiptNo)}</td><td>{t.receiptDate}</td><td>{t.receiptTime}</td><td>{t.orderType === "takeaway" ? "Takeaway" : "Table " + t.tableLabel}</td><td>{t.cashierName}</td><td>{t.paymentLabel}</td>
          <td className="mono">{t.fiscalFsNo || "—"}</td><td className="num">{money(t.totalCents)}</td><td><Badge s={t.status} /></td><td>{t.prints.some((p) => p.status === "sent") ? "yes" : <span className="badge st-cancelled">no</span>}</td></tr>))}
      </tbody></table></div>
      {rows.length === 0 && <p className="muted" style={{ padding: "14px 0", fontStyle: "italic" }}>No transactions match.</p>}
    </Card>
  </div>);
}
function exportTransactions(rows, from, to) {
  const out = [["Receipt No", "Date", "Time", "Status", "Order type", "Table", "Cashier", "Payment", "Reference", "Net", "VAT", "Total", "Received", "Change", "Items", "Buyer TIN", "Buyer name", "Fiscal FS No", "Void reason"]];
  for (const r of [...rows].sort((a, b) => a.receiptNo - b.receiptNo)) out.push([pad8(r.receiptNo), r.localDate, r.receiptTime, r.status, r.orderType, r.tableLabel, r.cashierName, r.paymentLabel, r.paymentRef, formatAmount(r.netCents), formatAmount(r.taxCents), formatAmount(r.totalCents), formatAmount(r.tenderedCents), formatAmount(r.changeCents), r.lines.length, r.buyerTin, r.buyerName, r.fiscalFsNo, r.voidReason || ""]);
  download(`transactions_${from || "all"}_${to || "all"}.csv`, "text/csv;charset=utf-8", toCsv(out));
}

// ----------------------------------------------------------------------------- Reports
function Reports({ state, S }) {
  const today = todayLocal(S.timezone);
  const [from, setFrom] = useState(today); const [to, setTo] = useState(today);
  const inRange = state.txs.filter((t) => (!from || t.localDate >= from) && (!to || t.localDate <= to));
  const done = inRange.filter((t) => t.status === "completed");
  const voided = inRange.filter((t) => t.status === "voided");
  const group = (keyFn) => Object.values(done.reduce((a, t) => { const k = keyFn(t); a[k] = a[k] || { label: k, count: 0, net: 0, tax: 0, total: 0 }; a[k].count++; a[k].net += t.netCents; a[k].tax += t.taxCents; a[k].total += t.totalCents; return a; }, {}));
  const byDay = group((t) => t.localDate).sort((a, b) => a.label.localeCompare(b.label));
  const byMethod = group((t) => t.paymentLabel).sort((a, b) => b.total - a.total);
  const byCashier = group((t) => t.cashierName).sort((a, b) => b.total - a.total);
  const items = {};
  for (const t of done) for (const l of t.lines) { const k = l.name + "|" + l.unit; items[k] = items[k] || { label: l.name, unit: l.unit, qty: 0, net: 0 }; items[k].qty += l.qtyMilli; items[k].net += l.amountCents; }
  const byItem = Object.values(items).sort((a, b) => b.net - a.net);
  const sum = (k) => done.reduce((a, t) => a + t[k], 0);
  const d = (offset) => { const x = new Date(); x.setDate(x.getDate() + offset); return localStamp(x, S.timezone).localDate; };
  const now = new Date();
  const monday = d(-((now.getDay() + 6) % 7));
  const monthStart = today.slice(0, 8) + "01";
  const exportLines = () => {
    const out = [["Receipt No", "Date", "Status", "Item", "Receipt name", "Qty", "Unit", "Unit price (net)", "Amount (net)", "VAT rate %", "VAT", "Note"]];
    for (const r of [...inRange].sort((a, b) => a.receiptNo - b.receiptNo)) for (const l of r.lines) out.push([pad8(r.receiptNo), r.localDate, r.status, l.name, l.receiptName, (l.qtyMilli / 1000).toFixed(3), l.unit, formatAmount(l.unitPriceCents), formatAmount(l.amountCents), (l.taxRateBp / 100).toFixed(2), formatAmount(l.taxCents), l.note || ""]);
    download(`sale_lines_${from}_${to}.csv`, "text/csv;charset=utf-8", toCsv(out));
  };
  const T = ({ title, rows, cols }) => (<Card><h3 className="serif" style={{ fontSize: 20, marginBottom: 12 }}>{title}</h3>
    {rows.length ? <div className="table-scroll"><table className="list"><tbody><tr>{cols.map((c) => <th key={c[0]} className={c[2] ? "num" : ""}>{c[0]}</th>)}</tr>
      {rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c[0]} className={c[2] ? "num" : ""}>{c[1](r)}</td>)}</tr>)}</tbody></table></div>
      : <div style={{ color: "#9a7e5a", fontStyle: "italic" }}>No data yet</div>}</Card>);
  return (<div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px clamp(16px,4vw,48px)" }}>
    <H1 sub="Sales totals for any period. Voided sales are listed separately.">Reports</H1>
    <Card><div className="row">
      <Field label="From"><input type="date" className="ink-input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
      <Field label="To"><input type="date" className="ink-input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      <button className="ink-btn-ghost btn-sm plain" onClick={() => { setFrom(today); setTo(today); }}>Today</button>
      <button className="ink-btn-ghost btn-sm plain" onClick={() => { setFrom(d(-1)); setTo(d(-1)); }}>Yesterday</button>
      <button className="ink-btn-ghost btn-sm plain" onClick={() => { setFrom(monday); setTo(today); }}>This week</button>
      <button className="ink-btn-ghost btn-sm plain" onClick={() => { setFrom(monthStart); setTo(today); }}>This month</button>
      <button className="ink-btn" onClick={() => exportTransactions(inRange, from, to)}>Export transactions (CSV)</button>
      <button className="ink-btn-ghost" onClick={exportLines}>Export item lines (CSV)</button>
    </div></Card>
    <div className="grid stats">
      {[["Sales incl. VAT", money(sum("totalCents")), "ETB"], ["Net (taxable)", money(sum("netCents")), "ETB"], ["VAT", money(sum("taxCents")), "ETB"], ["Transactions", done.length, ""], ["Voided", voided.length, voided.length ? `(${money(voided.reduce((a, t) => a + t.totalCents, 0))})` : ""]].map(([l, v, u]) => (
        <div key={l} className="ink-card" style={{ padding: 24 }}><div className="stat-label">{l}</div><div className="stat-value">{v}{u && <small> {u}</small>}</div></div>))}
    </div>
    <div className="cols-2">
      <T title="By day" rows={byDay} cols={[["Date", (r) => r.label], ["Sales", (r) => r.count, 1], ["Net", (r) => money(r.net), 1], ["VAT", (r) => money(r.tax), 1], ["Total", (r) => money(r.total), 1]]} />
      <T title="By payment method" rows={byMethod} cols={[["Method", (r) => r.label], ["Sales", (r) => r.count, 1], ["Total", (r) => money(r.total), 1]]} />
      <T title="By item (net)" rows={byItem} cols={[["Item", (r) => r.label], ["Quantity", (r) => formatQty(r.qty, r.unit), 1], ["Net", (r) => money(r.net), 1]]} />
      <T title="By cashier" rows={byCashier} cols={[["Cashier", (r) => r.label], ["Sales", (r) => r.count, 1], ["Total", (r) => money(r.total), 1]]} />
    </div>
  </div>);
}

// ----------------------------------------------------------------------------- Bill of Fare (menu)
function BillOfFare({ state, S, isAdmin, act, user }) {
  const [edit, setEdit] = useState(null); // item or {} for new
  const [catFilter, setCatFilter] = useState("all");
  const [newCat, setNewCat] = useState("");
  const cats = state.core.categories;
  const items = state.core.menu.filter((m) => !m.archived && (catFilter === "all" || m.categoryId === catFilter));
  const setAvail = (m, v) => act((c) => { const x = c.core.menu.find((i) => i.id === m.id); x.available = v; audit(c.core, user, "menu.availability", `${x.name}: ${v ? "available" : "sold out"}`); });
  return (<div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px clamp(16px,4vw,48px)" }}>
    <H1 sub={isAdmin ? "The kitchen's offerings: categories, prices (net of VAT, as on the receipt) and availability." : "Mark dishes sold out or available. Prices are managed by an administrator."}>Bill of Fare</H1>
    {isAdmin && <Card style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <button className="ink-btn" onClick={() => setEdit({})}>+ Add item</button>
      <span style={{ flex: 1 }} />
      <input className="ink-input" style={{ width: 200 }} placeholder="New category name" value={newCat} onChange={(e) => setNewCat(e.target.value)} />
      <button className="ink-btn-ghost" onClick={() => { if (!newCat.trim()) return; act((c) => { c.core.categories.push({ id: c.next("category"), name: newCat.trim().slice(0, 40), active: true }); audit(c.core, user, "category.created", newCat); }, "Category added."); setNewCat(""); }}>Add category</button>
    </Card>}
    <div className="chips"><button className={"chip" + (catFilter === "all" ? " active" : "")} onClick={() => setCatFilter("all")}>All</button>
      {cats.map((c) => <button key={c.id} className={"chip" + (catFilter === c.id ? " active" : "")} onClick={() => setCatFilter(c.id)}>{c.name}{c.active ? "" : " (hidden)"}</button>)}
      {isAdmin && catFilter !== "all" && <button className="ink-btn-ghost btn-sm plain" onClick={() => act((c) => { const k = c.core.categories.find((x) => x.id === catFilter); k.active = !k.active; }, "Category updated.")}>{cats.find((c) => c.id === catFilter)?.active ? "Hide category" : "Show category"}</button>}
    </div>
    <div className="ink-card">
      {items.map((m) => (<div key={m.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "14px 20px", borderBottom: "1px dotted #cdb88a", alignItems: "center" }}>
        <div><div className="serif" style={{ fontSize: 17 }}>{m.name}</div>
          <div style={{ fontSize: 11, color: "#9a7e5a", letterSpacing: "0.1em", textTransform: "uppercase" }}>{cats.find((c) => c.id === m.categoryId)?.name} · {m.unit} · receipt: <span className="mono" style={{ textTransform: "none" }}>{m.receiptName}</span></div>
          {hasNonAscii(m.receiptName) && <div className="fail small">Receipt text has non-Latin characters: prints as “?” in ESC/POS mode.</div>}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ textAlign: "right" }}><div className="serif" style={{ color: "#c8553d", fontSize: 18 }}>{formatAmount(netToGrossCents(m.priceCents, m.taxRateBp))} ETB</div><div className="muted small">net {formatAmount(m.priceCents)} + VAT {formatRate(m.taxRateBp)}%</div></div>
          <button className={"ink-btn-ghost btn-sm" + (m.available ? " plain" : "")} onClick={() => setAvail(m, !m.available)}>{m.available ? "Available" : "Sold out"}</button>
          {isAdmin && <><button className="ink-btn-ghost btn-sm plain" onClick={() => setEdit(m)}>Edit</button>
            <button onClick={() => window.confirm(`Remove “${m.name}” from the menu? Past sales keep their records.`) && act((c) => { const x = c.core.menu.find((i) => i.id === m.id); x.archived = true; x.available = false; audit(c.core, user, "menu.removed", x.name); }, "Item removed.")} style={{ background: "transparent", border: "1px solid #c8553d", color: "#c8553d", padding: "4px 10px", borderRadius: 2, fontSize: 11 }}>Remove</button></>}
        </div>
      </div>))}
      {items.length === 0 && <div style={{ padding: 20, color: "#9a7e5a", fontStyle: "italic" }}>No items in this category.</div>}
    </div>
    {edit && <ItemEditor item={edit.id ? edit : null} cats={cats} S={S} onClose={() => setEdit(null)} onSave={(v) => act((c) => {
      if (v.id) { Object.assign(c.core.menu.find((i) => i.id === v.id), v); audit(c.core, user, "menu.updated", { name: v.name, price: formatAmount(v.priceCents) }); }
      else { const item = { ...v, id: c.next("menu"), archived: false }; c.core.menu.push(item); audit(c.core, user, "menu.created", { name: v.name, price: formatAmount(v.priceCents) }); }
    }, "Menu saved.").then(() => setEdit(null))} />}
  </div>);
}

function ItemEditor({ item, cats, S, onClose, onSave }) {
  const [f, setF] = useState({ name: item?.name || "", receiptName: item?.receiptName || "", categoryId: item?.categoryId || cats[0]?.id, unit: item?.unit || "pcs", net: item ? formatAmount(item.priceCents) : "", rate: formatRate(item?.taxRateBp ?? S.defaultTaxRateBp), gross: "", available: item ? item.available : true });
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const rateBp = parseAmount(String(f.rate).replace("%", ""));
  const net = parseAmount(f.net);
  const save = () => {
    if (!f.name.trim()) return setErr("Item name is required.");
    if (net === null) return setErr("Price must be an amount like 60.87 (at most 2 decimals).");
    if (rateBp === null || rateBp > 10000) return setErr("VAT rate must be a percentage such as 15.");
    onSave({ ...(item ? { id: item.id } : {}), name: f.name.trim().slice(0, 80), receiptName: (f.receiptName.trim() || f.name.trim()).slice(0, 64), categoryId: Number(f.categoryId), unit: f.unit, priceCents: net, taxRateBp: rateBp, available: !!f.available });
  };
  return (<Modal onClose={onClose}>
    <h2 className="serif">{item ? "Edit menu item" : "Add menu item"}</h2>
    <Field label="Name (shown to staff)"><input className="ink-input" value={f.name} onChange={set("name")} /></Field>
    <Field label="Receipt text" help="Printed on the receipt. Use Latin letters for ESC/POS printers; Amharic needs HTML print mode."><input className="ink-input mono" placeholder="Defaults to the name" value={f.receiptName} onChange={set("receiptName")} /></Field>
    <div className="cols-2"><Field label="Category"><select className="ink-input" value={f.categoryId} onChange={set("categoryId")}>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <Field label="Unit"><select className="ink-input" value={f.unit} onChange={set("unit")}><option value="pcs">pcs (counted)</option><option value="kg">kg (weighed)</option></select></Field></div>
    <div className="cols-2"><Field label="Unit price, net (excl. VAT)"><input className="ink-input mono" inputMode="decimal" value={f.net} onChange={set("net")} placeholder="e.g. 60.87" /></Field>
      <Field label="VAT rate %"><input className="ink-input" value={f.rate} onChange={set("rate")} /></Field></div>
    <Field label="…or calculate net from a price incl. VAT" help="Rounded to the cent — check it: the sample register used 2782.60 net for a 3200 item, where rounding gives 2782.61.">
      <input className="ink-input mono" inputMode="decimal" placeholder="e.g. 70.00" value={f.gross} onChange={(e) => { const g = parseAmount(e.target.value); setF({ ...f, gross: e.target.value, net: g !== null && rateBp !== null ? formatAmount(grossToNetCents(g, rateBp)) : f.net }); }} /></Field>
    {net !== null && rateBp !== null && <div className="muted small">Customer pays {formatAmount(netToGrossCents(net, rateBp))} incl. VAT per {f.unit === "kg" ? "kg" : "item"}.</div>}
    <label className="check"><input type="checkbox" checked={f.available} onChange={set("available")} />Available for ordering</label>
    <div className="err">{err}</div>
    <div className="modal-actions"><button className="ink-btn-ghost plain" onClick={onClose}>Back</button><button className="ink-btn" onClick={save}>Save</button></div>
  </Modal>);
}

// ----------------------------------------------------------------------------- The Press (QZ Tray)
function Press({ state, user, isAdmin, act, qzStatus, tryConnect, setPage }) {
  const [cfg, setCfg] = useState(getPrintCfg);
  const [printers, setPrinters] = useState([]);
  const [status, setStatus] = useState(null);
  const [ask, setAsk] = useState(false);
  const set = (k, num) => (e) => setCfg({ ...cfg, [k]: e.target.type === "checkbox" ? e.target.checked : num ? Number(e.target.value) : e.target.value });
  const show = (text, kind = "") => setStatus({ text, kind });
  const find = async () => { show("Searching for printers…"); try { await tryConnect(); const ps = await qz.printers.find(); const list = Array.isArray(ps) ? ps : [ps]; setPrinters(list); if (!list.length) return show("QZ Tray found no printers. Install the receipt printer in Windows (Settings → Printers & scanners) and print a Windows test page, then try again.", "bad"); if (!cfg.printer || !list.includes(cfg.printer)) { const pick = pickReceiptPrinter(list); const c = { ...getPrintCfg(), printer: pick }; savePrintCfg(c); setCfg({ ...cfg, printer: pick }); show(`Found ${list.length} printer(s). Selected and saved: ${pick}. Choose another in the list if needed.`, "ok"); } else show(`Found ${list.length} printer(s). Current printer: ${cfg.printer}.`, "ok"); } catch (e) { show(explainQZ(e), "bad"); } };
  const dflt = async () => { try { await tryConnect(); const p = await qz.printers.getDefault(); if (!p) return show("No default printer is set.", "bad"); setPrinters((x) => [...new Set([...x, p])]); setCfg({ ...cfg, printer: p }); show(`Default printer: ${p}. Press Save.`, "ok"); } catch (e) { show(explainQZ(e), "bad"); } };
  const save = () => {
    const c = { ...cfg, paperWidthMm: Math.min(120, Math.max(30, cfg.paperWidthMm || 58)), charsPerLine: Math.min(64, Math.max(24, cfg.charsPerLine || 32)), feedLines: Math.min(10, Math.max(0, cfg.feedLines || 0)) };
    c.printableWidthMm = Math.min(c.paperWidthMm, Math.max(20, cfg.printableWidthMm || 48));
    savePrintCfg(c); setCfg(c); show(c.printer ? `Saved for this computer: ${c.printer}` : "Saved. No printer selected yet.", "ok"); return c;
  };
  const logTest = (patch) => act((c) => { c.core.printLog = [{ at: new Date().toISOString(), user: user.name, ...patch }, ...(c.core.printLog || [])].slice(0, 50); });
  const test = async () => {
    const c = save(); if (!c.printer) return show("Select a printer first.", "bad");
    show("Sending test page…");
    const cols = c.charsPerLine; const ctr = (s) => " ".repeat(Math.max(0, Math.floor((cols - s.length) / 2))) + s;
    const lines = [{ text: ctr("PRINTER TEST"), bold: true }, { text: ctr("QZ Tray - " + (c.mode === "html" ? "HTML" : "raw ESC/POS")) }, { text: "" }, { text: "1234567890".repeat(7).slice(0, cols) }, { text: "-".repeat(cols) },
      { text: ("Paper " + c.paperWidthMm + "mm, " + cols + " chars").slice(0, cols) }, { text: new Date().toLocaleString("en-GB").slice(0, cols) }, { text: "-".repeat(cols) }, { text: "The ruler must fit on ONE line." }, { text: "" }, { text: ctr("NOT A RECEIPT"), bold: true }].map((l) => ({ ...l, text: l.text.slice(0, cols) }));
    try { await qzSend(c, lines); show("Test page sent. Check the ruler fits on one line.", "ok"); logTest({ kind: "test", status: "sent", printer: c.printer }); }
    catch (e) { show(e.message, "bad"); logTest({ kind: "test", status: "failed", printer: c.printer, error: e.message }); }
  };
  const recent = [
    ...state.txs.flatMap((t) => t.prints.map((p) => ({ ...p, receiptNo: t.receiptNo }))),
    ...(state.core.printLog || []).map((p) => ({ ...p, receiptNo: null })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 15);
  const options = [...new Set([...printers, cfg.printer].filter(Boolean))];

  return (<div style={{ maxWidth: 1000, margin: "0 auto", padding: "32px clamp(16px,4vw,48px)" }}>
    <H1>The Press</H1>
    <div className="divider-ornate" style={{ fontSize: 11, margin: "6px 0 22px", textAlign: "left", letterSpacing: "0.3em" }}>· QZ TRAY LIVE PRINT ·</div>
    <Card><div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
      <span className={"dot " + (qzStatus === "connected" ? "ok" : qzStatus === "connecting" ? "wait" : "bad")} style={{ width: 14, height: 14 }} />
      <div style={{ flex: 1, minWidth: 200 }}><div className="serif" style={{ fontSize: 22 }}>{qzStatus === "connected" ? "Printer Connected" : qzStatus === "connecting" ? "Connecting…" : "Printer Offline"}</div>
        <div style={{ fontSize: 12, color: "#7a5e3a", marginTop: 2 }}>Printer: <span className="mono">{getPrintCfg().printer || "(not configured)"}</span> · Paper: <span className="mono">{getPrintCfg().paperWidthMm}mm</span></div></div>
      {qzStatus !== "connected" ? <button className="ink-btn-ghost" onClick={() => tryConnect().then(() => show("Connected to QZ Tray.", "ok")).catch((e) => show(e.message, "bad"))}>Reconnect</button>
        : <button className="ink-btn-ghost plain" onClick={() => qz.websocket.disconnect()}>Disconnect</button>}
      <button className="ink-btn" onClick={test}>Test Print</button>
    </div>
    {status && <div className={"notice " + status.kind} style={{ marginTop: 14 }}>{status.text}</div>}</Card>
    <div className="cols-2">
      <Card><h3 className="serif" style={{ fontSize: 22, marginBottom: 14 }}>Receipt printer</h3>
        <div className="row" style={{ marginBottom: 12 }}><button className="ink-btn" onClick={find}>Detect QZ Printers</button><button className="ink-btn-ghost plain btn-sm" onClick={dflt}>Use system default</button><button className="ink-btn-ghost plain btn-sm" onClick={() => setAsk(true)}>Network printer (IP)…</button></div>
        <Field label="Printer" help="Saved as soon as you choose it."><select className="ink-input" value={cfg.printer} onChange={(e) => { const c = { ...getPrintCfg(), printer: e.target.value }; savePrintCfg(c); setCfg({ ...cfg, printer: e.target.value }); show(e.target.value ? `Printer saved: ${e.target.value}` : "No printer selected.", e.target.value ? "ok" : "bad"); }}><option value="">— pick a printer —</option>{options.map((p) => <option key={p} value={p}>{p}</option>)}</select></Field>
        <Field label="Print method"><select className="ink-input" value={cfg.mode} onChange={set("mode")}><option value="escpos">Raw ESC/POS (thermal receipt printers — recommended)</option><option value="html">HTML / pixel (any printer; prints Amharic)</option></select></Field>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}><span>Paper width:</span>
          <label className="check"><input type="radio" checked={cfg.paperWidthMm === 58} onChange={() => setCfg({ ...cfg, paperWidthMm: 58, printableWidthMm: 48, charsPerLine: 32 })} /> 58mm</label>
          <label className="check"><input type="radio" checked={cfg.paperWidthMm === 80} onChange={() => setCfg({ ...cfg, paperWidthMm: 80, printableWidthMm: 72, charsPerLine: 48 })} /> 80mm</label></div>
        <div className="cols-2"><Field label="Characters per line" help="32 on 58 mm, 48 (or 42) on 80 mm"><input className="ink-input" inputMode="numeric" value={cfg.charsPerLine} onChange={set("charsPerLine", true)} /></Field>
          <Field label="Printable width (mm)" help="HTML mode only"><input className="ink-input" inputMode="numeric" value={cfg.printableWidthMm} onChange={set("printableWidthMm", true)} /></Field></div>
        <div className="cols-2"><Field label="Feed lines before cut"><input className="ink-input" inputMode="numeric" value={cfg.feedLines} onChange={set("feedLines", true)} /></Field>
          <Field label="ESC/POS code page" help="0 = PC437"><input className="ink-input" inputMode="numeric" value={cfg.codePage} onChange={set("codePage", true)} /></Field></div>
        <label className="check"><input type="checkbox" checked={cfg.cut} onChange={set("cut")} />Cut paper after receipt</label>
        <label className="check"><input type="checkbox" checked={cfg.openDrawer} onChange={set("openDrawer")} />Open cash drawer on cash sales</label>
        <button className="ink-btn-ghost" style={{ marginTop: 8 }} onClick={save}>Save Settings</button>
        <div style={{ marginTop: 14, fontSize: 12, color: "#9a7e5a", lineHeight: 1.6, fontStyle: "italic" }}>Printer choice is saved on this computer. Auto-print after payment can be switched in Atelier.</div>
      </Card>
      <Card><h3 className="serif" style={{ fontSize: 22, marginBottom: 10 }}>If printing does not work</h3>
        <ol style={{ marginLeft: 18, lineHeight: 1.7, fontSize: 13 }}>
          <li>Install QZ Tray from qz.io/download and make sure it is running (tray icon near the clock). Press Reconnect.</li>
          <li>Chrome/Edge: allow “access other apps and services on this device” if asked (padlock → Site settings → Local network access).</li>
          <li>When QZ Tray asks to allow this page, click <b>Allow</b>.</li>
          <li>Printer missing: switch it on, check the cable and that it shows in Windows “Printers &amp; scanners”, then Detect and Save.</li>
          <li>Lines wrap or are cut: lower Characters per line. Blank paper at the end: lower Feed lines.</li>
          <li>Sales are saved before printing. Fix the problem, open the sale in the Ledger and press Print — no duplicate sale is created.</li>
          <li>Emergency only: “Browser print (fallback)” uses the browser’s print dialog, not QZ Tray.</li>
        </ol>
        <button className="ink-btn-ghost btn-sm" style={{ marginTop: 10 }} onClick={() => setPage("sample")}>Receipt layout check (sample)</button>
      </Card>
    </div>
    <Diagnostics state={state} qzStatus={qzStatus} />
    {isAdmin && <SigningCard show={show} tryConnect={tryConnect} />}
    <Card><h3 className="serif" style={{ fontSize: 22, marginBottom: 4 }}>Recent Print Attempts</h3>
      {recent.length === 0 ? <div style={{ color: "#9a7e5a", fontStyle: "italic", padding: "10px 0", fontSize: 13 }}>No print attempts yet.</div> : recent.map((p, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderBottom: "1px dotted #cdb88a", fontSize: 13 }}>
          <span><span style={{ color: p.status === "sent" ? "#5d8a52" : p.status === "failed" ? "#c8553d" : "#b8770b", fontWeight: 700 }}>{p.status === "sent" ? "✓" : p.status === "failed" ? "⚠" : "…"}</span> {p.receiptNo ? `№ ${pad8(p.receiptNo)} (${p.kind})` : "test page"} · {p.printer} {p.reason ? "· " + p.reason : ""} {p.error ? "· " + p.error : ""}</span>
          <span className="mono small">{new Date(p.at).toLocaleTimeString("en-GB", { hour12: false })}</span></div>))}
    </Card>
    {ask && <Ask title="Network receipt printer" label="IP address and port, e.g. 192.168.1.50:9100" help="For Ethernet/Wi-Fi ESC/POS printers. QZ Tray sends raw data to the printer's port (usually 9100)." okLabel="Use" onDone={(v) => { setAsk(false); if (!v) return; const p = "net://" + v.replace(/^net:\/\//, ""); if (!netPrinter(p)) return show("Enter an address like 192.168.1.50:9100", "bad"); setPrinters((x) => [...new Set([...x, p])]); setCfg({ ...cfg, printer: p, mode: "escpos" }); show(`Network printer ${p}. Press Save.`, "ok"); }} />}
  </div>);
}

// Everything needed to tell why a receipt did not print, in one block the user can copy and send.
function Diagnostics({ state, qzStatus }) {
  const [info, setInfo] = useState(null);
  const run = async () => {
    const cfg = getPrintCfg();
    const lastFailed = state.txs.flatMap((t) => t.prints.map((p) => ({ ...p, receiptNo: t.receiptNo }))).filter((p) => p.status === "failed").sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    const r = {
      "Checked at": new Date().toLocaleString("en-GB"),
      "QZ library in this file": window.qz ? qz.version : "MISSING",
      "QZ Tray connection": qzStatus,
      "QZ Tray version": "-",
      "Printers QZ Tray can see": "-",
      "Saved printer": cfg.printer || "(none — choose one above)",
      "Saved printer found": "-",
      "Print method": cfg.mode === "html" ? "HTML / pixel" : "Raw ESC/POS",
      "Paper / characters per line": `${cfg.paperWidthMm} mm / ${cfg.charsPerLine}`,
      "Silent printing (signing)": getSigning() ? "set up" : "not set up (QZ Tray asks to Allow)",
      "Hotel file printer in this browser": (() => { try { return localStorage.getItem("welkite_printer") || "(none)"; } catch { return "-"; } })(),
      "Last QZ error": lastQzError || "(none)",
      "Last failed receipt print": lastFailed ? `№ ${pad8(lastFailed.receiptNo)} at ${lastFailed.at}: ${lastFailed.error}` : "(none)",
      "Browser": navigator.userAgent,
    };
    try {
      await qzConnect();
      try { r["QZ Tray version"] = await qz.api.getVersion(); } catch {}
      const ps = await qz.printers.find(); const list = Array.isArray(ps) ? ps : [ps];
      r["Printers QZ Tray can see"] = list.length ? list.join(" | ") : "NONE — install the printer in Windows first";
      r["Saved printer found"] = netPrinter(cfg.printer) ? "network printer (not listed by Windows)" : cfg.printer ? (list.includes(cfg.printer) ? "yes" : "NO — choose the printer again") : "no printer saved";
    } catch (e) { r["QZ Tray connection"] = "FAILED: " + explainQZ(e); }
    setInfo(r);
  };
  const text = info ? Object.entries(info).map(([k, v]) => `${k}: ${v}`).join("\n") : "";
  return (<Card><h3 className="serif" style={{ fontSize: 22, marginBottom: 6 }}>Print diagnostics</h3>
    <p style={{ fontSize: 13, marginBottom: 10 }}>If a receipt does not print, press <b>Run check</b>. Problems are shown in capitals; you can copy the result and send it for support.</p>
    <div className="row"><button className="ink-btn dark" onClick={run}>Run check</button>{info && <button className="ink-btn-ghost plain" onClick={() => navigator.clipboard?.writeText(text)}>Copy result</button>}</div>
    {info && <pre className="mono small" style={{ whiteSpace: "pre-wrap", marginTop: 10, background: "#fffdf6", border: "1px dashed #cdb88a", padding: 10 }}>{text}</pre>}
  </Card>);
}

function SigningCard({ show, tryConnect }) {
  const cur = getSigning();
  const [cert, setCert] = useState(cur?.cert || "");
  const [key, setKey] = useState("");
  const save = async () => {
    try {
      if (!/BEGIN CERTIFICATE/.test(cert)) throw new Error("Paste the whole digital-certificate.txt, including the BEGIN/END CERTIFICATE lines.");
      const k = key.trim() || cur?.key;
      if (!k) throw new Error("Paste the private-key.pem.");
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await importSigningKey(k), new TextEncoder().encode("test"));
      localStorage.setItem(SIGN_KEY, JSON.stringify({ cert: cert.trim(), key: k.trim() }));
      signKeyCache = null; setKey("");
      if (window.qz && qz.websocket.isActive()) await qz.websocket.disconnect();
      await tryConnect();
      show("Signing saved for this computer and QZ Tray reconnected. Prints should no longer ask for permission.", "ok");
    } catch (e) { show(e.message || String(e), "bad"); }
  };
  const remove = async () => { localStorage.removeItem(SIGN_KEY); signKeyCache = null; setCert(""); if (window.qz && qz.websocket.isActive()) await qz.websocket.disconnect(); show("Signing removed. QZ Tray will ask to allow requests.", "ok"); };
  return (<Card><h3 className="serif" style={{ fontSize: 22, marginBottom: 6 }}>Silent printing (QZ Tray signing)</h3>
    <p style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 10 }}>{cur ? <b className="pass">Signing is set up on this computer.</b> : "Not set up: QZ Tray will ask to allow this page."} To set it up: open QZ Tray → Advanced → Site Manager → <b>+</b> → Create New, answer Yes to all. A “QZ Tray Demo Cert” folder appears on the desktop. Paste its two files below. They are stored only in this browser on this computer — not in this file and not in backups.</p>
    <Field label="digital-certificate.txt"><textarea className="ink-input mono" rows={3} value={cert} onChange={(e) => setCert(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" /></Field>
    <Field label={"private-key.pem" + (cur ? " (leave empty to keep the saved key)" : "")}><textarea className="ink-input mono" rows={3} value={key} onChange={(e) => setKey(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" /></Field>
    <div className="row"><button className="ink-btn" onClick={save}>Save signing</button>{cur && <button className="ink-btn-ghost" onClick={remove}>Remove</button>}</div>
  </Card>);
}

// ----------------------------------------------------------------------------- Sample receipt check
function SampleCheck({ S }) {
  const cfg = getPrintCfg();
  const src = SAMPLE_RECEIPT_SOURCE;
  const totals = computeTotals(src.items.map((i) => ({ ...i, taxRateBp: 1500 })));
  const refLines = layoutReceipt(sampleReferenceReceipt(totals), 32);
  const fake = { receiptNo: 0, receiptDate: src.date, receiptTime: src.time, buyerTin: src.buyerTin, buyerName: src.buyerName, lines: totals.lines.map((l) => ({ ...l, receiptName: l.name })), taxGroups: totals.taxGroups, totalCents: totals.totalCents, paymentLabel: "CASH", tenderedCents: totals.totalCents, changeCents: 0, status: "completed",
    receiptSnapshot: { tin: S.business.tin, headerLines: S.business.headerLines, heading: S.receipt.heading, numberLabel: S.receipt.numberLabel, footerLines: S.receipt.footerLines } };
  const appLines = layoutReceipt({ ...buildReceiptFromTransaction(fake), number: "SAMPLE", banner: "SAMPLE - NOT A SALE" }, cfg.charsPerLine);
  const checks = [["Taxable (TXBL 1 15%)", src.printed.txbl, totals.taxGroups[0].taxableCents], ["Tax (TAX 1 15%)", src.printed.tax, totals.taxCents], ["TOTAL", src.printed.total, totals.totalCents], ["CASH", src.printed.cash, totals.totalCents], ["ITEM count", src.printed.itemCount, totals.itemCount]];
  const [msg, setMsg] = useState(null);
  return (<div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px clamp(16px,4vw,48px)" }}>
    <H1 sub="The supplied receipt (FS No. 00000594) recalculated and laid out by this file. Sample values are never used for new sales.">Receipt layout check</H1>
    <Card><h3 className="serif" style={{ fontSize: 20, marginBottom: 8 }}>Calculation check</h3>
      <table className="list check-table"><tbody><tr><th>Line</th><th className="num">Printed on sample</th><th className="num">Calculated</th><th>Result</th></tr>
        {checks.map(([l, a, b]) => <tr key={l}><td>{l}</td><td className="num mono">{l === "ITEM count" ? a : formatAmount(a)}</td><td className="num mono">{l === "ITEM count" ? b : formatAmount(b)}</td><td className={a === b ? "pass" : "fail"}>{a === b ? "MATCH" : "DIFFERENT"}</td></tr>)}</tbody></table>
      <p className="small muted" style={{ marginTop: 8 }}>Prices are net; VAT 15% is rounded per line (417.39 + 7.83 + 10.44 + 9.13 = 444.79). VAT on the subtotal would give 444.78, which does not match the sample.</p></Card>
    <div className="side-by-side">
      <div className="receipt-stage"><ReceiptPaper lines={refLines} cfg={{ paperWidthMm: 58, printableWidthMm: 48, charsPerLine: 32 }} caption="Reference: sample receipt as scanned" watermark="REFERENCE" /></div>
      <div className="receipt-stage"><ReceiptPaper lines={appLines} cfg={cfg} caption={`This file's print layout (${cfg.paperWidthMm} mm / ${cfg.charsPerLine} chars)`} watermark="SAMPLE" /></div>
    </div>
    <div className="notice">Differences on purpose: this file prints its own receipt number ({S.receipt.numberLabel}) instead of the fiscal register's FS No., and prints “NON-FISCAL RECEIPT” instead of the ERCA / machine-number footer, because only the registered fiscal machine may issue those.</div>
    {msg && <div className={"notice " + (msg.bad ? "bad" : "ok")}>{msg.text}</div>}
    <div className="row"><button className="ink-btn" onClick={async () => { if (!cfg.printer) return setMsg({ bad: true, text: "Select a printer in The Press first." }); try { await qzSend(cfg, appLines); setMsg({ text: "Sample sent to the printer. Compare it with the original receipt." }); } catch (e) { setMsg({ bad: true, text: e.message }); } }}>Test-print sample (marked SAMPLE)</button>
      <button className="ink-btn-ghost plain" onClick={() => browserPrint(appLines, cfg)}>Browser print (fallback)</button></div>
  </div>);
}

// ----------------------------------------------------------------------------- Atelier (settings, admin)
function Atelier({ state, S, user, act, toast, setPage, refresh }) {
  const core = state.core;
  const [biz, setBiz] = useState({ displayName: S.business.displayName, tin: S.business.tin, header: S.business.headerLines.join("\n"), heading: S.receipt.heading, numberLabel: S.receipt.numberLabel, footer: S.receipt.footerLines.join("\n"), printOrderInfo: S.receipt.printOrderInfo });
  const [ops, setOps] = useState({ rate: formatRate(S.defaultTaxRateBp), tz: S.timezone, autoPrint: S.autoPrint, cashierCanReprint: S.cashierCanReprint, nextNo: String(Math.max(core.counters.receipt, Math.max(0, ...state.txs.map((t) => t.receiptNo)) + 1)), pm: S.paymentMethods.map((m) => ({ ...m })) });
  const [userEdit, setUserEdit] = useState(null);
  const [newTable, setNewTable] = useState("");
  const fileRef = useRef(null);
  const setB = (k) => (e) => setBiz({ ...biz, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const lines = (s, n) => s.split("\n").map((x) => x.trim().slice(0, 64)).filter(Boolean).slice(0, n);
  const saveBiz = () => act((c) => {
    c.core.settings.business = { displayName: biz.displayName.trim() || S.business.displayName, tin: biz.tin.trim().slice(0, 30), headerLines: lines(biz.header, 10) };
    c.core.settings.receipt = { heading: biz.heading.trim().slice(0, 32) || "INVOICE", numberLabel: biz.numberLabel.trim().slice(0, 16) || "RCPT No.:", footerLines: lines(biz.footer, 8), printOrderInfo: !!biz.printOrderInfo };
    audit(c.core, user, "settings.business");
  }, "Business details saved.");
  const saveOps = () => act((c) => {
    const r = parseAmount(ops.rate); if (r === null || r > 10000) throw new Error("Invalid VAT rate.");
    try { new Intl.DateTimeFormat("en-GB", { timeZone: ops.tz }); } catch { throw new Error("Unknown time zone."); }
    if (!ops.pm.some((m) => m.enabled)) throw new Error("Enable at least one payment method.");
    const n = Number(ops.nextNo); const maxNo = Math.max(0, ...c.txs().map((t) => t.receiptNo));
    if (!Number.isInteger(n) || n < 1 || n > 99999999) throw new Error("Next receipt number must be between 1 and 99999999.");
    if (n <= maxNo) throw new Error(`Next receipt number must be greater than the last issued number (${maxNo}).`);
    Object.assign(c.core.settings, { defaultTaxRateBp: r, timezone: ops.tz, autoPrint: !!ops.autoPrint, cashierCanReprint: !!ops.cashierCanReprint, paymentMethods: ops.pm.map((m) => ({ id: m.id, label: m.label.trim().toUpperCase().slice(0, 20) || m.id.toUpperCase(), enabled: !!m.enabled })) });
    c.core.counters.receipt = n;
    audit(c.core, user, "settings.operations");
  }, "Operations saved.");

  const exportBackup = () => act((c) => { c.core.lastBackupAt = new Date().toISOString(); }).then(() => {
    const snap = snapshot();
    download(`restaurant-backup-${todayLocal(S.timezone)}.json`, "application/json", JSON.stringify({ app: "hbm-restaurant-pos", version: 1, exportedAt: new Date().toISOString(), core: snap.core, orders: snap.orders, txs: snap.txs }));
    toast("Backup downloaded. Keep it on a USB drive or another computer.");
  });
  const restore = async (file) => {
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== "hbm-restaurant-pos" || !data.core || !Array.isArray(data.txs)) throw new Error("This is not a backup made by this restaurant file.");
      if (!window.confirm(`Replace ALL data on this computer with the backup from ${data.exportedAt}? (${data.txs.length} sales). Current data will be lost unless you made a backup.`)) return;
      await withLock(async () => { data.core.version = (state.core.version || 0) + 1; await writeChanges(data.core, data.orders || [], data.txs, true); });
      await loadState(); refresh(); channel?.postMessage("changed");
      toast("Backup restored. Please sign in again if your account changed.");
    } catch (e) { toast(e.message, "bad"); }
  };

  return (<div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px clamp(16px,4vw,48px)" }}>
    <H1 sub="Business particulars, receipt text, operations, users, tables and backups.">Atelier</H1>
    <div className="cols-2">
      <Card><h3 className="serif" style={{ fontSize: 22, marginBottom: 14 }}>Restaurant Particulars &amp; Receipt</h3>
        <Field label="Name shown in this app"><input className="ink-input" value={biz.displayName} onChange={setB("displayName")} /></Field>
        <Field label="TIN (printed as TIN:…)"><input className="ink-input mono" value={biz.tin} onChange={setB("tin")} /></Field>
        <Field label="Receipt header lines (one per line, centred)"><textarea className="ink-input mono" rows={6} value={biz.header} onChange={setB("header")} /></Field>
        <div className="cols-2"><Field label="Receipt heading"><input className="ink-input mono" value={biz.heading} onChange={setB("heading")} /></Field><Field label="Receipt number label"><input className="ink-input mono" value={biz.numberLabel} onChange={setB("numberLabel")} /></Field></div>
        <Field label="Footer lines (after NON-FISCAL RECEIPT)"><textarea className="ink-input mono" rows={3} value={biz.footer} onChange={setB("footer")} /></Field>
        <label className="check"><input type="checkbox" checked={biz.printOrderInfo} onChange={setB("printOrderInfo")} />Also print table/takeaway and cashier (not on the original)</label>
        <div className="row"><button className="ink-btn" onClick={saveBiz}>Save</button><button className="ink-btn-ghost plain" onClick={() => setPage("sample")}>Preview with sample</button></div>
      </Card>
      <Card><h3 className="serif" style={{ fontSize: 22, marginBottom: 14 }}>Operations</h3>
        <div className="cols-2"><Field label="Default VAT % for new items"><input className="ink-input" value={ops.rate} onChange={(e) => setOps({ ...ops, rate: e.target.value })} /></Field>
          <Field label="Next receipt number" help="Can only go up."><input className="ink-input mono" value={ops.nextNo} onChange={(e) => setOps({ ...ops, nextNo: e.target.value })} /></Field></div>
        <Field label="Time zone (receipt date/time)"><input className="ink-input" value={ops.tz} onChange={(e) => setOps({ ...ops, tz: e.target.value })} /></Field>
        <div className="stat-label" style={{ marginTop: 6 }}>Payment methods</div>
        {ops.pm.map((m, i) => (<div key={m.id} className="row" style={{ marginBottom: 6 }}><input type="checkbox" checked={m.enabled} onChange={(e) => { const pm = ops.pm.map((x) => ({ ...x })); pm[i].enabled = e.target.checked; setOps({ ...ops, pm }); }} /><input className="ink-input" style={{ flex: 1 }} value={m.label} onChange={(e) => { const pm = ops.pm.map((x) => ({ ...x })); pm[i].label = e.target.value; setOps({ ...ops, pm }); }} /></div>))}
        <label className="check"><input type="checkbox" checked={ops.autoPrint} onChange={(e) => setOps({ ...ops, autoPrint: e.target.checked })} />Print receipt automatically after payment</label>
        <label className="check"><input type="checkbox" checked={ops.cashierCanReprint} onChange={(e) => setOps({ ...ops, cashierCanReprint: e.target.checked })} />Cashiers may reprint (marked COPY, reason recorded)</label>
        <button className="ink-btn" onClick={saveOps}>Save</button>
      </Card>
    </div>
    <div className="cols-2">
      <Card><div className="spread"><h3 className="serif" style={{ fontSize: 22 }}>Users</h3><button className="ink-btn btn-sm" onClick={() => setUserEdit({})}>+ Add user</button></div>
        <p className="small muted" style={{ margin: "6px 0 10px" }}>Administrator: everything. Cashier: orders, payments, receipts, ledger, menu availability, printer.</p>
        <div className="table-scroll"><table className="list"><tbody><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th></th></tr>
          {core.users.map((u) => (<tr key={u.id}><td className="mono">{u.username}</td><td>{u.name}</td><td>{u.role}</td><td>{u.active ? "active" : <span className="fail">disabled</span>}</td>
            <td><div className="row"><button className="ink-btn-ghost btn-sm plain" onClick={() => setUserEdit(u)}>Edit</button>
              <button className="ink-btn-ghost btn-sm" onClick={() => act((c) => { const x = c.core.users.find((y) => y.id === u.id); if (x.role === "admin" && x.active && !c.core.users.some((y) => y.id !== x.id && y.role === "admin" && y.active)) throw new Error("At least one active administrator must remain."); x.active = !x.active; audit(c.core, user, "user.toggled", { u: x.username, active: x.active }); })}>{u.active ? "Disable" : "Enable"}</button></div></td></tr>))}
        </tbody></table></div>
      </Card>
      <Card><h3 className="serif" style={{ fontSize: 22, marginBottom: 10 }}>Tables</h3>
        <div className="table-grid" style={{ marginBottom: 12 }}>{core.tables.map((t) => (<button key={t.id} className={"table-tile " + (t.active ? "free" : "")} style={{ opacity: t.active ? 1 : 0.4 }} title={t.active ? "Click to hide" : "Click to show"} onClick={() => act((c) => { const x = c.core.tables.find((y) => y.id === t.id); x.active = !x.active; })}><div className="lb">{t.label}</div><div className="small muted">{t.active ? "in use" : "hidden"}</div></button>))}</div>
        <div className="row"><input className="ink-input" style={{ width: 120 }} placeholder="Label" value={newTable} onChange={(e) => setNewTable(e.target.value)} />
          <button className="ink-btn btn-sm" onClick={() => { const l = newTable.trim().slice(0, 12); if (!l) return; act((c) => { if (c.core.tables.some((t) => t.label === l)) throw new Error("A table with that label exists."); c.core.tables.push({ id: c.next("table"), label: l, active: true }); }, "Table added."); setNewTable(""); }}>Add table</button></div>
      </Card>
    </div>
    <Card><h3 className="serif" style={{ fontSize: 22, marginBottom: 10 }}>Backup</h3>
      <p style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 10 }}>All sales, orders, menu and users are stored <b>in this browser on this computer</b> ({state.txs.length} sales so far). They stay after closing or refreshing, but clearing browser data, a different browser or another computer will not have them. <b>Download a backup every day</b> and keep it on a USB drive or another computer. {core.lastBackupAt ? `Last backup: ${new Date(core.lastBackupAt).toLocaleString("en-GB")}.` : "No backup made yet."}</p>
      <div className="row"><button className="ink-btn" onClick={exportBackup}>Download backup</button>
        <button className="ink-btn-ghost" onClick={() => fileRef.current.click()}>Restore from backup…</button>
        <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) restore(f); }} /></div>
    </Card>
    {userEdit && <UserEditor u={userEdit.id ? userEdit : null} onClose={() => setUserEdit(null)} onSave={async (f) => {
      const ph = f.password ? await hashPassword(f.password) : null;
      const ok = await act((c) => {
        if (f.id) {
          const x = c.core.users.find((y) => y.id === f.id);
          if (x.role === "admin" && f.role !== "admin" && !c.core.users.some((y) => y.id !== x.id && y.role === "admin" && y.active)) throw new Error("At least one active administrator must remain.");
          x.name = f.name || x.username; x.role = f.role; if (ph) Object.assign(x, ph);
          audit(c.core, user, "user.updated", { u: x.username, role: f.role, passwordReset: !!ph });
        } else {
          if (c.core.users.some((y) => y.username === f.username)) throw new Error("That username is taken.");
          c.core.users.push({ id: c.next("user"), username: f.username, name: f.name || f.username, role: f.role, active: true, ...ph, createdAt: new Date().toISOString() });
          audit(c.core, user, "user.created", { u: f.username, role: f.role });
        }
        return true;
      }, "User saved.");
      if (ok) setUserEdit(null);
    }} />}
  </div>);
}

function UserEditor({ u, onClose, onSave }) {
  const [f, setF] = useState({ username: u?.username || "", name: u?.name || "", role: u?.role || "cashier", password: "" });
  const [err, setErr] = useState("");
  const save = () => {
    const username = f.username.trim().toLowerCase();
    if (!u && !/^[a-z0-9._-]{3,40}$/.test(username)) return setErr("Username: 3-40 letters, digits, dot, dash or underscore.");
    if (!u || f.password) { const p = pwProblem(f.password); if (p) return setErr(p); }
    onSave({ id: u?.id, username, name: f.name.trim().slice(0, 60), role: f.role, password: f.password });
  };
  return (<Modal onClose={onClose}>
    <h2 className="serif">{u ? "Edit user" : "Add user"}</h2>
    <Field label="Username"><input className="ink-input mono" disabled={!!u} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
    <Field label="Full name"><input className="ink-input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
    <Field label="Role"><select className="ink-input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="cashier">Cashier</option><option value="admin">Administrator</option></select></Field>
    <Field label={u ? "New password (leave blank to keep)" : "Password (at least 8 characters)"}><input className="ink-input" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
    <div className="err">{err}</div>
    <div className="modal-actions"><button className="ink-btn-ghost plain" onClick={onClose}>Back</button><button className="ink-btn" onClick={save}>Save</button></div>
  </Modal>);
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
