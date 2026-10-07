// QZ Tray integration (official qz-tray.js 2.3.0, vendored in /vendor).
// - Certificate and signatures come from the server (/api/qz/*); the private key never reaches the browser.
// - If no certificate is installed on the server, QZ Tray still works but shows an "Untrusted website"
//   prompt that the cashier must allow (see README, QZ Tray signing).
import { api } from "./api.js";

const listeners = new Set();
let state = { status: "offline", message: "Not connected", version: null, signing: null };
let securityReady = false;

function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}
export const qzState = () => state;
export function onQzState(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); }

const qz = () => window.qz;

async function setupSecurity() {
  if (securityReady || !qz()) return;
  let signing = { certificate: false, privateKey: false };
  try { signing = await api.get("/api/qz/status"); } catch { /* not signed in yet */ }
  set({ signing });
  if (signing.certificate) {
    qz().security.setCertificatePromise((resolve, reject) => {
      fetch("/api/qz/certificate", { cache: "no-store", credentials: "same-origin" })
        .then((r) => (r.ok ? r.text().then(resolve) : r.text().then(reject)))
        .catch(reject);
    });
  } else {
    // Anonymous connection: QZ Tray asks the user to allow each request.
    qz().security.setCertificatePromise((resolve) => resolve());
  }
  qz().security.setSignatureAlgorithm("SHA512");
  if (signing.privateKey) {
    qz().security.setSignaturePromise((toSign) => (resolve, reject) => {
      fetch("/api/qz/sign", { method: "POST", cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request: toSign }) })
        .then((r) => (r.ok ? r.text().then(resolve) : r.text().then(reject)))
        .catch(reject);
    });
  } else {
    qz().security.setSignaturePromise(() => (resolve) => resolve());
  }
  qz().websocket.setClosedCallbacks(() => set({ status: "offline", message: "QZ Tray connection closed", version: null }));
  qz().websocket.setErrorCallbacks((e) => set({ message: "QZ Tray error: " + errText(e) }));
  securityReady = true;
}

export function errText(e) {
  if (!e) return "Unknown error";
  if (typeof e === "string") return e;
  if (e.message) return e.message;
  if (e.target && e.type) return "WebSocket " + e.type;
  try { return JSON.stringify(e); } catch { return String(e); }
}

// Translate QZ/browser failures into instructions a cashier can act on.
export function explain(e) {
  const m = errText(e);
  if (/ConnectException|Connection refused|connect timed out|UnknownHost|No route to host/i.test(m)) {
    return "The network printer did not answer (" + m.replace(/^.*Exception:\s*/, "") + "). Check the printer is on and connected, and that its IP address and port are correct.";
  }
  if (/Unable to establish connection/i.test(m) || /not running|ECONNREFUSED|closed/i.test(m)) {
    return "QZ Tray is not reachable. Start QZ Tray on this computer (look for its tray icon), then press Connect. " +
      "If the browser asked to 'access other apps and services on this device', choose Allow (Chrome: padlock icon > Site settings > Local network access).";
  }
  if (/blocked|denied|rejected by user|untrusted/i.test(m)) return "The request was blocked in QZ Tray. Press Connect again and choose Allow in the QZ Tray window (tick 'Remember this decision' if it is available).";
  if (/printer.*not found|cannot find printer|PrintException|No printer/i.test(m)) return "The selected printer was not found. Check it is switched on and installed, then use 'Find printers' and save the correct one.";
  return m;
}

export async function connect() {
  if (!qz()) { set({ status: "offline", message: "The QZ Tray library did not load. Reload the page." }); throw new Error(state.message); }
  await setupSecurity();
  if (qz().websocket.isActive()) { set({ status: "connected" }); return state; }
  set({ status: "connecting", message: "Connecting to QZ Tray..." });
  try {
    await qz().websocket.connect({ retries: 2, delay: 1 });
    let version = null;
    try { version = await qz().api.getVersion(); } catch { /* old versions */ }
    set({ status: "connected", message: "Connected", version });
    return state;
  } catch (e) {
    set({ status: "offline", message: explain(e) });
    throw new Error(explain(e));
  }
}

export async function disconnect() {
  if (qz() && qz().websocket.isActive()) await qz().websocket.disconnect();
  set({ status: "offline", message: "Disconnected", version: null });
}

export async function findPrinters() {
  await connect();
  const list = await qz().printers.find();
  return Array.isArray(list) ? list : [list];
}

export async function defaultPrinter() {
  await connect();
  return qz().printers.getDefault();
}

async function withReconnect(fn) {
  await connect();
  try {
    return await fn();
  } catch (e) {
    // A stale socket (e.g. QZ Tray restarted) fails once; reconnect and retry exactly once.
    if (/websocket|connection|closed|not connect/i.test(errText(e))) {
      try { await qz().websocket.disconnect(); } catch { /* ignore */ }
      set({ status: "offline" });
      await connect();
      return fn();
    }
    throw e;
  }
}

// A printer is either an installed printer name, or "net://IP:PORT" for an Ethernet/Wi-Fi receipt
// printer that QZ Tray reaches directly over TCP (raw port, usually 9100).
export function parseNetworkPrinter(printer) {
  const m = /^net:\/\/([^:\/\s]+)(?::(\d{1,5}))?$/.exec(String(printer || "").trim());
  return m ? { host: m[1], port: Number(m[2] || 9100) } : null;
}
const target = (printer) => parseNetworkPrinter(printer) || printer;

// Raw ESC/POS: exact bytes, printer's built-in font, fastest and sharpest on thermal printers.
export function printRaw(printer, base64Data, copies = 1) {
  return withReconnect(() => {
    const cfg = qz().configs.create(target(printer), { copies, encoding: "ISO-8859-1" });
    return qz().print(cfg, [{ type: "raw", format: "command", flavor: "base64", data: base64Data }]);
  });
}

// Pixel (HTML): for printers without ESC/POS, or when Ethiopic characters must print.
export function printHtml(printer, html, paperWidthMm) {
  if (parseNetworkPrinter(printer)) return Promise.reject(new Error("HTML/pixel printing needs an installed printer driver. Use Raw ESC/POS for a network (IP) printer."));
  return withReconnect(() => {
    const cfg = qz().configs.create(printer, { units: "mm", size: { width: paperWidthMm, height: null }, margins: 0, scaleContent: false, rasterize: true, density: 203, colorType: "blackwhite" });
    return qz().print(cfg, [{ type: "pixel", format: "html", flavor: "plain", data: html, options: { pageWidth: paperWidthMm } }]);
  });
}
