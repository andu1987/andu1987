// Receipt template shared by the browser (preview, QZ printing) and the server (tests).
//
// One layout function turns a receipt into fixed-width text lines; every output format
// (ESC/POS bytes, on-screen preview, QZ pixel/HTML, browser-print fallback) renders those
// same lines, so the preview is exactly what the printer receives.
//
// Layout follows the supplied receipt (Attachment 1), top to bottom:
//   centred header (TIN, owner, trade name, address, phone) / blank / bold "INVOICE" /
//   number row / DATE + TIME row / Buyer's TIN / Buyer's NAME / blank /
//   item name line + "qty x price ........ *amount" line per item / dashed rule /
//   TXBL n(r%) / TAX n(r%) / dashed rule / bold TOTAL / payment / ITEM: count / blank / footer.

import { formatAmount, formatQty, formatRate } from "./money.js";

export const RECEIPT_DEFAULTS = Object.freeze({
  paperWidthMm: 58,
  printableWidthMm: 48,
  charsPerLine: 32,
});

const star = (cents) => "*" + formatAmount(cents);

// Printers in ESC/POS text mode only have single-byte code pages. Keep receipt text to
// printable ASCII and make substitutions visible rather than silently dropping characters.
export function toReceiptAscii(text) {
  return String(text ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ")
    .replace(/[^\x20-\x7E]/g, "?");
}

export function hasNonAscii(text) {
  return /[^\x20-\x7E]/.test(String(text ?? ""));
}

function wrap(text, cols) {
  // Keep the original spacing (e.g. "2  Liter water") whenever the text already fits.
  if (String(text).length <= cols) return [String(text)];
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = [];
  let cur = "";
  for (let w of words) {
    while (w.length > cols) {
      if (cur) { out.push(cur); cur = ""; }
      out.push(w.slice(0, cols));
      w = w.slice(cols);
    }
    if (!w) continue;
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= cols) cur += " " + w;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

function center(text, cols) {
  return wrap(text, cols).map((t) => " ".repeat(Math.floor((cols - t.length) / 2)) + t);
}

// Left label and right value on one line; if they cannot share a line, the value moves to
// the next line right-aligned so columns never break or clip.
function pair(left, right, cols) {
  left = String(left ?? "");
  right = String(right ?? "");
  if (left.length + right.length + 1 <= cols) return [left + " ".repeat(cols - left.length - right.length) + right];
  const lines = wrap(left, cols);
  for (const r of wrap(right, cols)) lines.push(" ".repeat(cols - r.length) + r);
  return lines;
}

// receipt: see buildReceiptFromTransaction() for the shape.
export function layoutReceipt(receipt, cols = RECEIPT_DEFAULTS.charsPerLine) {
  cols = Math.max(24, Math.min(64, Number(cols) || RECEIPT_DEFAULTS.charsPerLine));
  const t = receipt.ascii === false ? (s) => String(s ?? "") : toReceiptAscii;
  const lines = [];
  const push = (texts, style = {}) => { for (const text of [].concat(texts)) lines.push({ text, ...style }); };
  const blank = () => push("");
  const rule = () => push("-".repeat(cols));

  if (receipt.tin) push(center("TIN:" + t(receipt.tin), cols));
  for (const h of receipt.headerLines || []) if (String(h).trim()) push(center(t(h), cols));
  blank();
  push(center(t(receipt.heading || "INVOICE"), cols), { bold: true });
  if (receipt.copy) push(center("*** COPY ***", cols), { bold: true });
  if (receipt.banner) push(center(t(receipt.banner), cols), { bold: true });
  push(pair(t(receipt.numberLabel || "No.:"), t(receipt.number), cols));
  if (receipt.fiscalFsNo) push(pair("FS No.:", t(receipt.fiscalFsNo), cols));
  push(pair("DATE:" + t(receipt.date), "TIME:" + t(receipt.time), cols));
  if (receipt.buyerTin) push(pair("Buyer's TIN:", t(receipt.buyerTin), cols));
  if (receipt.buyerName) push(pair("Buyer's NAME:", t(receipt.buyerName), cols));
  for (const info of receipt.infoLines || []) push(pair(t(info[0]), t(info[1]), cols));
  blank();

  for (const l of receipt.lines) {
    push(wrap(t(l.name), cols));
    push(pair(formatQty(l.qtyMilli, l.unit) + " x " + formatAmount(l.unitPriceCents), star(l.amountCents), cols));
  }
  rule();
  for (const g of receipt.taxGroups) {
    push(pair(`TXBL ${g.index}(${formatRate(g.rateBp)}%)`, star(g.taxableCents), cols));
    push(pair(`TAX ${g.index}(${formatRate(g.rateBp)}%)`, star(g.taxCents), cols));
  }
  rule();
  push(pair("TOTAL", star(receipt.totalCents), cols), { bold: true });
  for (const p of receipt.payments || []) push(pair(t(p.label), star(p.amountCents), cols));
  if (receipt.changeCents > 0) push(pair("CHANGE", star(receipt.changeCents), cols));
  push(pair("ITEM:", String(receipt.itemCount ?? receipt.lines.length), cols));
  blank();

  for (const f of receipt.footer || []) {
    const style = { bold: !!f.bold, mark: !!f.mark };
    // A mark (screen-only symbol, ~2 characters wide) is drawn before the text, so centre in cols-2.
    push(center(t(f.text), cols - (f.mark ? 2 : 0)), style);
  }
  return lines;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Small slanted mark drawn on screen only, used in the reference reproduction of the sample.
const MARK_SVG = '<svg class="rc-mark" viewBox="0 0 28 12" aria-hidden="true"><path d="M2 11 L9 1 H27 L25 4 H11 L9 7 H22 L20 10 H6 Z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

export function receiptLinesToHtml(lines) {
  return lines
    .map((l) => {
      const text = escapeHtml(l.text) || "&nbsp;";
      const body = l.mark ? text.replace(/^(\s*)/, (m) => m + MARK_SVG) : text;
      return `<div class="rc-line${l.bold ? " rc-b" : ""}">${body}</div>`;
    })
    .join("");
}

// Font size that makes `cols` monospace characters fill the printable width exactly.
// Monospace advance is ~0.6em for the fonts in the stack below.
export function receiptFontSizeMm(printableWidthMm, cols) {
  return printableWidthMm / (cols * 0.6);
}

export const RECEIPT_FONT_STACK = "'Courier New', Courier, 'Liberation Mono', 'DejaVu Sans Mono', monospace";

// Self-contained HTML document for QZ pixel printing and the browser-print fallback.
// It contains nothing from the dashboard; @page sizing prevents scaling and blank pages.
export function receiptDocumentHtml(lines, opts = {}) {
  const paper = Number(opts.paperWidthMm) || RECEIPT_DEFAULTS.paperWidthMm;
  const printable = Number(opts.printableWidthMm) || RECEIPT_DEFAULTS.printableWidthMm;
  const cols = Number(opts.charsPerLine) || RECEIPT_DEFAULTS.charsPerLine;
  const fs = receiptFontSizeMm(printable, cols).toFixed(3);
  const side = ((paper - printable) / 2).toFixed(2);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(opts.title || "Receipt")}</title>
<style>
@page { size: ${paper}mm auto; margin: 0; }
html,body{margin:0;padding:0;background:#fff;color:#000}
.rc{width:${printable}mm;margin:0 ${side}mm;padding:2mm 0 4mm;font-family:${RECEIPT_FONT_STACK};font-size:${fs}mm;line-height:1.25}
.rc-line{white-space:pre;overflow:hidden}
.rc-b{font-weight:bold}
.rc-mark{height:0.9em;width:2.1em;vertical-align:-0.1em}
</style></head><body><div class="rc">${receiptLinesToHtml(lines)}</div></body></html>`;
}

// ---------- ESC/POS ----------
const ESC = 0x1b;
const GS = 0x1d;

export function encodeEscPos(lines, opts = {}) {
  const bytes = [];
  const add = (...b) => bytes.push(...b);
  const text = (s) => { for (const ch of toReceiptAscii(s)) bytes.push(ch.charCodeAt(0)); };
  add(ESC, 0x40); // initialise
  add(ESC, 0x74, Number(opts.codePage) || 0); // character code table (0 = PC437)
  add(ESC, 0x4d, opts.font === "B" ? 1 : 0); // font A (default) or B
  add(ESC, 0x61, 0); // left align: centring is already done with spaces for exact columns
  if (opts.openDrawer) add(ESC, 0x70, 0, 25, 250);
  let bold = false;
  for (const l of lines) {
    if (!!l.bold !== bold) { bold = !!l.bold; add(ESC, 0x45, bold ? 1 : 0); }
    text(l.text.replace(/\s+$/, ""));
    add(0x0a);
  }
  if (bold) add(ESC, 0x45, 0);
  add(ESC, 0x64, Math.max(0, Math.min(10, Number(opts.feedLines ?? 4)))); // feed before cut
  if (opts.cut !== false) add(GS, 0x56, 0x42, 0); // partial cut (ignored by printers without a cutter)
  return Uint8Array.from(bytes);
}

export function bytesToBase64(u8) {
  let bin = "";
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
}

// ---------- Build a receipt from saved records ----------

// tx: a saved transaction (server JSON). settings: receipt settings snapshot stored with it.
export function buildReceiptFromTransaction(tx, opts = {}) {
  const snap = tx.receiptSnapshot || {};
  const infoLines = [];
  if (snap.printOrderInfo) {
    infoLines.push(["ORDER:", tx.orderType === "takeaway" ? "TAKEAWAY" : "TABLE " + (tx.tableLabel || "")]);
    if (tx.cashierName) infoLines.push(["CASHIER:", tx.cashierName]);
  }
  const payments = [{ label: (tx.paymentLabel || tx.paymentMethod || "CASH").toUpperCase(), amountCents: tx.tenderedCents || tx.totalCents }];
  return {
    tin: snap.tin,
    headerLines: snap.headerLines || [],
    heading: snap.heading || "INVOICE",
    numberLabel: snap.numberLabel || "RCPT No.:",
    number: String(tx.receiptNo).padStart(8, "0"),
    fiscalFsNo: tx.fiscalFsNo || "",
    date: tx.receiptDate,
    time: tx.receiptTime,
    buyerTin: tx.buyerTin,
    buyerName: tx.buyerName,
    infoLines,
    lines: tx.lines.map((l) => ({ name: l.receiptName || l.name, qtyMilli: l.qtyMilli, unit: l.unit, unitPriceCents: l.unitPriceCents, amountCents: l.amountCents })),
    taxGroups: tx.taxGroups,
    totalCents: tx.totalCents,
    payments,
    changeCents: tx.changeCents || 0,
    itemCount: tx.lines.length,
    copy: !!opts.copy,
    banner: tx.status === "voided" ? "*** VOIDED ***" : opts.banner || "",
    footer: [
      { text: "NON-FISCAL RECEIPT", bold: true },
      ...(snap.footerLines || []).filter((s) => String(s).trim()).map((text) => ({ text })),
    ],
  };
}

// ---------- Sample transaction from Attachment 1 (layout/calculation check only) ----------
// Values below are transcribed from the scanned receipt. They are NEVER used for new sales.
export const SAMPLE_RECEIPT_SOURCE = Object.freeze({
  tin: "0038779012",
  headerLines: ["HAILU BEYENE MINDA", "RESTAURANT SERVICE", "HAWASSA S.C MENAL KETEMA", "K.ADDIS ABEBA H.NO.", "TEL.0912061331E.MOB140010169008"],
  fsNo: "00000594",
  date: "25/08/2026",
  time: "15:08:00",
  buyerTin: "0003168982",
  buyerName: "IASD",
  items: [
    { name: "1k tibs2", unit: "kg", qtyMilli: 1000, unitPriceCents: 278260 },
    { name: "Mabaya", unit: "pcs", qtyMilli: 2000, unitPriceCents: 2609 },
    { name: "2  Liter water", unit: "pcs", qtyMilli: 1000, unitPriceCents: 6957 },
    { name: "Sofet derink", unit: "pcs", qtyMilli: 1000, unitPriceCents: 6087 },
  ],
  printed: { txbl: 296522, tax: 44479, total: 341001, cash: 341001, itemCount: 4 },
  footer: ["ERCA", "CNA0023020", "SUPLIED BY JUPITER TRADING", "TEL.0462209771", "SALES WITH CONFIDENCE"],
});

// Reference reproduction of the scanned receipt, for on-screen comparison only.
export function sampleReferenceReceipt(totals) {
  const s = SAMPLE_RECEIPT_SOURCE;
  return {
    ascii: false,
    tin: s.tin,
    headerLines: s.headerLines,
    heading: "INVOICE",
    numberLabel: "FS No.:",
    number: s.fsNo,
    date: s.date,
    time: s.time,
    buyerTin: s.buyerTin,
    buyerName: s.buyerName,
    lines: totals.lines.map((l) => ({ name: l.name, qtyMilli: l.qtyMilli, unit: l.unit, unitPriceCents: l.unitPriceCents, amountCents: l.amountCents })),
    taxGroups: totals.taxGroups,
    totalCents: totals.totalCents,
    payments: [{ label: "CASH", amountCents: totals.totalCents }],
    itemCount: totals.itemCount,
    footer: [
      { text: s.footer[0], bold: true },
      { text: s.footer[1], mark: true },
      ...s.footer.slice(2).map((text) => ({ text })),
    ],
  };
}
