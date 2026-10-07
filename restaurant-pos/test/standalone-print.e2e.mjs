// Printing set-up scenarios for restaurant-pos-standalone.html (file://), with a recording QZ stand-in:
//  A. A browser that already used the hotel file: its saved printer and 80 mm paper are reused,
//     and the first sale prints with no visit to The Press.
//  B. A fresh browser: the receipt printer is chosen automatically when QZ Tray connects.
//  C. The diagnostics panel reports the state.
//   node test/standalone-print.e2e.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || "/opt/node22/lib/node_modules/playwright")); }
const fileUrl = pathToFileURL(path.resolve("restaurant-pos-standalone.html")).href;
const exe = process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const out = path.resolve("test-output/standalone");
fs.mkdirSync(out, { recursive: true });

const stub = (printers) => `window.__qzPrinted = [];
Object.defineProperty(window, "qz", { configurable: true, get() { return window.__qzStub; }, set() {} });
window.__qzStub = (function(){ let active = false; return {
  version: "stub",
  api: { getVersion: async () => "2.2.6 (stub)" },
  websocket: { isActive: () => active, connect: async () => { active = true; }, disconnect: async () => { active = false; }, setClosedCallbacks(){}, setErrorCallbacks(){} },
  security: { setCertificatePromise(){}, setSignaturePromise(){}, setSignatureAlgorithm(){} },
  printers: { find: async () => ${JSON.stringify(printers)}, getDefault: async () => ${JSON.stringify(printers[0])} },
  configs: { create: (p, o) => ({ printer: p, options: o }) },
  print: async (cfg, data) => { window.__qzPrinted.push({ printer: cfg.printer, data }); },
}; })();`;

async function scenario(name, printers, beforeOpen, check) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "rpos-print-"));
  const ctx = await chromium.launchPersistentContext(profile, { executablePath: exe, viewport: { width: 1366, height: 900 } });
  await ctx.addInitScript(stub(printers));
  const page = ctx.pages()[0];
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await beforeOpen(page);
    await page.goto(fileUrl);
    const f = page.locator(".login-card input");
    await f.nth(0).fill("Hailu"); await f.nth(1).fill("owner"); await f.nth(2).fill("owner-pass-1"); await f.nth(3).fill("owner-pass-1");
    await page.getByRole("button", { name: "Create administrator" }).click();
    await page.getByRole("heading", { name: "Atelier" }).waitFor();
    // Straight to a sale — nobody opens The Press.
    await page.getByRole("button", { name: "Service", exact: true }).click();
    await page.getByRole("button", { name: "+ Takeaway order" }).click();
    await page.locator(".menu-tile", { hasText: "Mabaya" }).click();
    await page.locator(".order-line", { hasText: "Mabaya" }).waitFor();
    await page.getByRole("button", { name: "Settle Account" }).click();
    await page.locator(".modal").getByRole("button", { name: "Confirm payment" }).click();
    await page.getByText(/Last print: SENT \(original\)/).waitFor({ timeout: 15000 });
    const printed = await page.evaluate(() => window.__qzPrinted);
    const receipt = Buffer.from(printed[0].data[0].data, "base64").toString("latin1");
    await check({ page, printer: printed[0].printer, receipt });
    await page.screenshot({ path: path.join(out, `print-${name}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`• ${name}: printed to "${printed[0].printer}"`);
  } finally { await ctx.close(); fs.rmSync(profile, { recursive: true, force: true }); }
}

try {
  await scenario("A-hotel-printer-reused", ["Microsoft Print to PDF", "CN710 Receipt Printer"], async (page) => {
    await page.goto(fileUrl); // same file:// origin as the hotel file
    await page.evaluate(() => { localStorage.setItem("welkite_printer", "CN710 Receipt Printer"); localStorage.setItem("welkite_paper", "80"); });
  }, async ({ printer, receipt }) => {
    assert.equal(printer, "CN710 Receipt Printer");
    const ruler = receipt.split("\n").map((l) => l.replace(/\x1b[E@]./g, "")).find((l) => l.startsWith("TOTAL"));
    assert.equal(ruler.trimEnd().length, 48, "80 mm paper → 48 characters per line");
  });

  await scenario("B-auto-picked", ["Microsoft Print to PDF", "OneNote", "XP-80C Receipt"], async () => {}, async ({ page, printer, receipt }) => {
    assert.equal(printer, "XP-80C Receipt");
    assert.ok(receipt.includes("TOTAL"));
    await page.locator(".modal").getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "The Press", exact: true }).click();
    await page.getByRole("button", { name: "Run check" }).click();
    const diag = await page.locator("pre").textContent();
    for (const s of ["QZ Tray version: 2.2.6 (stub)", "Saved printer: XP-80C Receipt", "Saved printer found: yes", "Printers QZ Tray can see: Microsoft Print to PDF | OneNote | XP-80C Receipt"]) assert.ok(diag.includes(s), "diagnostics shows " + s);
    console.log("• diagnostics:\n" + diag.split("\n").slice(1, 8).map((l) => "    " + l).join("\n"));
  });
  console.log("\nPRINTER SET-UP SCENARIOS: ALL PASSED");
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
}
