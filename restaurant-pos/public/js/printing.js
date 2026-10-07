// Receipt printing. A sale is always saved on the server before anything is printed; each print
// attempt is logged as a separate print job, so a failed or repeated print never creates a sale.
import { api } from "./api.js";
import * as qzs from "./qz.js";
import { layoutReceipt, encodeEscPos, bytesToBase64, receiptDocumentHtml, buildReceiptFromTransaction, RECEIPT_DEFAULTS } from "/shared/receipt.js";

const KEY = "rpos_printer_config_v1";
export const PRINT_DEFAULTS = {
  printer: "",
  mode: "escpos", // "escpos" (raw) or "html" (pixel)
  paperWidthMm: RECEIPT_DEFAULTS.paperWidthMm,
  printableWidthMm: RECEIPT_DEFAULTS.printableWidthMm,
  charsPerLine: RECEIPT_DEFAULTS.charsPerLine,
  feedLines: 4,
  cut: true,
  openDrawer: false,
  codePage: 0,
};

// Printer settings belong to the computer the printer is attached to, so they are stored per browser.
export function getPrintConfig() {
  try { return { ...PRINT_DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY)) || {}) }; } catch { return { ...PRINT_DEFAULTS }; }
}
export function savePrintConfig(cfg) {
  const clean = { ...PRINT_DEFAULTS, ...cfg };
  clean.paperWidthMm = clamp(clean.paperWidthMm, 30, 120, PRINT_DEFAULTS.paperWidthMm);
  clean.printableWidthMm = clamp(clean.printableWidthMm, 20, clean.paperWidthMm, Math.min(clean.paperWidthMm, PRINT_DEFAULTS.printableWidthMm));
  clean.charsPerLine = clamp(clean.charsPerLine, 24, 64, PRINT_DEFAULTS.charsPerLine);
  clean.feedLines = clamp(clean.feedLines, 0, 10, 4);
  clean.codePage = clamp(clean.codePage, 0, 255, 0);
  try { localStorage.setItem(KEY, JSON.stringify(clean)); } catch { throw new Error("This browser blocked saving settings (private window?)."); }
  return clean;
}
function clamp(v, lo, hi, dflt) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt; }

export function receiptLines(tx, opts = {}) {
  const cfg = opts.config || getPrintConfig();
  return layoutReceipt(buildReceiptFromTransaction(tx, { copy: opts.copy }), cfg.charsPerLine);
}

async function send(lines, cfg) {
  if (cfg.mode === "html") {
    await qzs.printHtml(cfg.printer, receiptDocumentHtml(lines, cfg), cfg.paperWidthMm);
  } else {
    const bytes = encodeEscPos(lines, { feedLines: cfg.feedLines, cut: cfg.cut, openDrawer: cfg.openDrawer, codePage: cfg.codePage });
    await qzs.printRaw(cfg.printer, bytesToBase64(bytes));
  }
}

// Print a saved transaction through QZ Tray. Returns { ok, copy, error }.
export async function printTransaction(tx, { reason = "", openDrawer = false } = {}) {
  const cfg = getPrintConfig();
  if (!cfg.printer) return { ok: false, error: "No printer is selected on this computer. Open Printer, find printers and save one." };
  let job;
  try {
    job = await api.post(`/api/transactions/${tx.id}/print-jobs`, { reason, printer: cfg.printer, mode: cfg.mode });
  } catch (e) {
    return { ok: false, error: e.message, needsReason: e.status === 400 && /reason/i.test(e.message) };
  }
  const lines = receiptLines(tx, { copy: job.copy, config: cfg });
  try {
    await send(lines, { ...cfg, openDrawer: openDrawer && cfg.openDrawer && !job.copy });
    await api.patch(`/api/print-jobs/${job.jobId}`, { status: "sent" }).catch(() => {});
    return { ok: true, copy: job.copy };
  } catch (e) {
    const msg = qzs.explain(e);
    await api.patch(`/api/print-jobs/${job.jobId}`, { status: "failed", error: msg }).catch(() => {});
    return { ok: false, copy: job.copy, error: msg };
  }
}

export async function testPrint() {
  const cfg = getPrintConfig();
  if (!cfg.printer) throw new Error("Select and save a printer first.");
  const job = await api.post("/api/print-jobs", { printer: cfg.printer, mode: cfg.mode });
  const cols = cfg.charsPerLine;
  const ruler = "1234567890".repeat(7).slice(0, cols);
  const now = new Date();
  const lines = [
    { text: center("PRINTER TEST", cols), bold: true },
    { text: center("QZ Tray - " + (cfg.mode === "html" ? "HTML/pixel" : "raw ESC/POS"), cols) },
    { text: "" },
    { text: ruler },
    { text: "-".repeat(cols) },
    { text: pair("Paper", cfg.paperWidthMm + "mm", cols) },
    { text: pair("Characters/line", String(cols), cols) },
    { text: pair("Printer", cfg.printer.slice(0, cols - 9), cols) },
    { text: pair("Time", now.toLocaleString("en-GB"), cols) },
    { text: "-".repeat(cols) },
    { text: "The ruler above must fit on ONE" },
    { text: "line. If it wraps, lower the" },
    { text: "characters per line." },
    { text: "" },
    { text: center("NOT A RECEIPT", cols), bold: true },
  ].map((l) => ({ ...l, text: l.text.slice(0, cols) }));
  try {
    await send(lines, cfg);
    await api.patch(`/api/print-jobs/${job.jobId}`, { status: "sent" });
  } catch (e) {
    const msg = qzs.explain(e);
    await api.patch(`/api/print-jobs/${job.jobId}`, { status: "failed", error: msg }).catch(() => {});
    throw new Error(msg);
  }
}
const center = (s, c) => " ".repeat(Math.max(0, Math.floor((c - s.length) / 2))) + s;
const pair = (a, b, c) => a + " ".repeat(Math.max(1, c - a.length - b.length)) + b;

// FALLBACK ONLY: the browser's own print dialog (not QZ Tray). Prints the receipt document alone
// in a hidden frame so no dashboard content can appear on paper.
export function browserPrintLines(lines, cfg = getPrintConfig()) {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    frame.srcdoc = receiptDocumentHtml(lines, cfg);
    frame.onload = () => {
      setTimeout(() => {
        try { frame.contentWindow.focus(); frame.contentWindow.print(); } finally {
          setTimeout(() => { frame.remove(); resolve(); }, 500);
        }
      }, 150);
    };
    document.body.appendChild(frame);
  });
}

export async function browserPrintTransaction(tx, { reason = "" } = {}) {
  const cfg = getPrintConfig();
  const job = await api.post(`/api/transactions/${tx.id}/print-jobs`, { reason, printer: "browser dialog", mode: "browser-fallback" });
  await browserPrintLines(receiptLines(tx, { copy: job.copy, config: cfg }), cfg);
  return job;
}

export function finishBrowserJob(jobId, printed) {
  return api.patch(`/api/print-jobs/${jobId}`, printed ? { status: "sent" } : { status: "failed", error: "Browser print not confirmed" });
}
