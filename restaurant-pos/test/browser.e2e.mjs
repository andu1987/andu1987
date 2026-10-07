// Browser workflow test with Playwright + Chromium (not part of `npm test`).
//   npm i -D playwright && npx playwright install chromium   (once)
//   node test/browser.e2e.mjs                 uses a recording stand-in for QZ Tray
//   QZ=real PRINTER="name" node test/browser.e2e.mjs   uses the QZ Tray running on this computer
// Screenshots are written to test-output/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createApp } from "../server/app.js";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || "/opt/node22/lib/node_modules/playwright")); }

const REAL = process.env.QZ === "real";
const NET_PRINTER = process.env.NET_PRINTER || ""; // e.g. 127.0.0.1:9100
const PRINT_DIR = process.env.PRINT_DIR || ""; // where the printer emulator saves jobs
const out = path.resolve("test-output");
fs.mkdirSync(out, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rpos-e2e-"));
const app = createApp({ dataDir, setupToken: "E2ESETUP01", log: () => {}, qzDir: process.env.QZ_DIR });
const server = await app.listen(0, "127.0.0.1");
// Use "localhost" so the page and QZ Tray share the loopback address space (no LNA prompt).
const base = `http://localhost:${server.address().port}`;

// Stand-in for qz-tray.js: records what the app sends; can be told to fail to test recovery.
const STUB = `window.qz = (function(){
  let active = false; window.__qzPrinted = []; window.__qzFail = null;
  const api = {
    websocket: { isActive: () => active, connect: async () => { if (window.__qzOffline) throw new Error("Unable to establish connection with QZ"); active = true; }, disconnect: async () => { active = false; }, setClosedCallbacks(){}, setErrorCallbacks(){} },
    security: { setCertificatePromise(){}, setSignaturePromise(){}, setSignatureAlgorithm(){} },
    api: { getVersion: async () => "stub" },
    printers: { find: async () => ["POS-58 Thermal (stub)", "Office Laser (stub)"], getDefault: async () => "POS-58 Thermal (stub)" },
    configs: { create: (p, o) => ({ printer: p, options: o }) },
    print: async (cfg, data) => { if (window.__qzFail) throw new Error(window.__qzFail); window.__qzPrinted.push({ cfg, data }); },
  };
  return api;
})();`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
if (!REAL) await ctx.route("**/vendor/qz-tray.js", (r) => r.fulfill({ contentType: "text/javascript", body: STUB }));
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|fonts\.g/.test(m.text())) errors.push(m.text()); });
const shot = (n) => page.screenshot({ path: path.join(out, n + ".png"), fullPage: true });
const step = (s) => console.log("•", s);

try {
  // ---- first-run setup
  await page.goto(base);
  await page.getByText("First-time setup").waitFor();
  await shot("01-setup");
  const inputs = page.locator(".login-card input");
  await inputs.nth(0).fill("E2ESETUP01");
  await inputs.nth(1).fill("Hailu");
  await inputs.nth(2).fill("owner");
  await inputs.nth(3).fill("owner-pass-1");
  await inputs.nth(4).fill("owner-pass-1");
  await page.getByRole("button", { name: "Create administrator" }).click();
  await page.getByRole("heading", { name: "Settings" }).waitFor();
  step("administrator created through the setup screen");
  await shot("02-settings");

  // ---- admin: add a cashier and a menu item
  await page.getByRole("button", { name: "+ Add user" }).click();
  const m = page.locator(".modal");
  await m.locator("input").nth(0).fill("selam");
  await m.locator("input").nth(1).fill("Selam");
  await m.locator("input").nth(2).fill("cashier-pass-1");
  await m.getByRole("button", { name: "Save" }).click();
  await page.getByRole("cell", { name: "selam", exact: true }).waitFor();
  step("cashier account created");

  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("button", { name: "+ Add item" }).click();
  await m.locator("input").nth(0).fill("Shiro");
  // inputs: 0 name, 1 receipt text, 2 net price, 3 VAT %, 4 price incl. VAT helper
  await m.locator("input").nth(4).fill("70");
  assert.equal(await m.locator("input").nth(2).inputValue(), "60.87");
  await m.getByRole("button", { name: "Save" }).click();
  await page.getByRole("cell", { name: "Shiro", exact: true }).first().waitFor();
  step("menu item added (net 60.87 from 70.00 incl. VAT)");
  await shot("03-menu");

  // ---- printer page: QZ connect, find printers, save
  await page.getByRole("button", { name: "Printer", exact: true }).click();
  await page.getByText(REAL ? /QZ Tray connected/ : /QZ Tray connected/).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Find printers" }).click();
  await page.locator(".notice").filter({ hasText: /Found \d+ printer|printer|QZ/ }).first().waitFor({ timeout: 20000 });
  await page.locator(".notice").filter({ hasNotText: "Searching" }).last().waitFor({ timeout: 20000 });
  step("Find printers: " + (await page.locator(".notice").filter({ hasNotText: "Searching" }).last().textContent()));
  const sel = page.locator("select").first();
  let target;
  if (NET_PRINTER) {
    await page.getByRole("button", { name: "Network printer (IP)…" }).click();
    await page.locator(".modal input").fill(NET_PRINTER);
    await page.locator(".modal").getByRole("button", { name: "Use" }).click();
    target = "net://" + NET_PRINTER;
  } else {
    const opts = await sel.locator("option").allTextContents();
    target = process.env.PRINTER || opts.find((o) => /POS|thermal|receipt/i.test(o)) || opts[1];
    await sel.selectOption(target);
  }
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Saved for this computer").waitFor();
  await page.getByRole("button", { name: "Test print" }).click();
  await page.getByText(/Test page sent/).waitFor({ timeout: 20000 });
  step(`QZ connected, printer "${target}" saved, test page sent`);
  await shot("04-printer");

  // ---- sample receipt check page
  await page.goto(base + "/#/sample");
  await page.getByText("Calculation check").waitFor();
  assert.equal(await page.locator("td.fail").count(), 0);
  assert.equal(await page.locator("td.pass").count(), 5);
  step("sample calculation check: 5/5 MATCH");
  await shot("05-sample-receipt");

  // ---- sign out, sign in as cashier
  await page.getByRole("button", { name: "Sign Out" }).click();
  await page.getByPlaceholder("Username").fill("selam");
  await page.getByPlaceholder("Password").fill("cashier-pass-1");
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.getByText("Good day.").waitFor();
  const nav = await page.locator(".nav button").allTextContents();
  assert.deepEqual(nav, ["Dashboard", "Orders", "Transactions", "Menu", "Printer"]);
  step("cashier signed in; admin pages hidden: " + nav.join(", "));

  // ---- dine-in order on table 3 with the sample items
  await page.getByRole("button", { name: "Orders" }).click();
  await page.getByRole("button", { name: "+ Dine-in order" }).click();
  await page.locator(".modal .table-tile").nth(2).click();
  await page.getByText(/Add to order #/).waitFor();
  const tile = (name) => page.locator(".menu-tile", { hasText: name });
  await tile("Tibs (per kg)").click();
  await page.locator(".modal input").fill("1.000");
  await page.locator(".modal").getByRole("button", { name: "Add" }).click();
  await page.locator(".order-line", { hasText: "Tibs" }).waitFor();
  await tile("Mabaya").click();
  await page.locator(".order-line", { hasText: "Mabaya" }).waitFor();
  await page.locator(".order-line", { hasText: "Mabaya" }).getByTitle("More").click();
  await page.locator(".order-line", { hasText: "2 x 26.09" }).waitFor();
  await page.getByRole("button", { name: "Beverages" }).click();
  await tile("Water 2 L").click();
  await page.locator(".order-line", { hasText: "Water" }).waitFor();
  await tile("Soft drink").click();
  await page.locator(".order-line", { hasText: "Soft drink" }).waitFor();
  await page.getByRole("button", { name: "Food", exact: true }).click();
  await tile("Shiro").click(); // add then remove
  await page.locator(".order-line", { hasText: "Shiro" }).getByRole("button", { name: "Remove" }).click();
  await page.locator(".order-line", { hasText: "Shiro" }).waitFor({ state: "detached" });
  await page.locator(".order-line", { hasText: "Soft drink" }).getByRole("button", { name: "Note" }).click();
  await page.locator(".modal input").fill("cold");
  await page.locator(".modal").getByRole("button", { name: "Save" }).click();
  await page.getByText("Note: cold").waitFor();
  const total = await page.locator(".totals .grand").textContent();
  assert.match(total, /3,410\.01/);
  step("order built: total " + total.replace(/\s+/g, " ").trim());
  await page.getByRole("button", { name: "Send to kitchen" }).click();
  await page.locator(".badge", { hasText: "submitted" }).first().waitFor();
  await page.getByRole("button", { name: "Mark ready" }).click();
  await page.locator(".badge", { hasText: "ready" }).first().waitFor();
  step("order states: open → submitted → ready");
  await shot("06-order");

  // ---- payment with a printer failure, then retry
  // Make the first print fail: stand-in raises an error; real QZ Tray is pointed at a closed port.
  const setPrinter = (p) => page.evaluate((p) => { const c = JSON.parse(localStorage.getItem("rpos_printer_config_v1")); c.printer = p; localStorage.setItem("rpos_printer_config_v1", JSON.stringify(c)); }, p);
  if (!REAL) await page.evaluate(() => { window.__qzFail = "Cannot find printer POS-58 Thermal (stub)"; });
  else if (NET_PRINTER) await setPrinter("net://127.0.0.1:9");
  await page.getByRole("button", { name: "Bill & pay" }).click();
  await page.locator(".modal").getByRole("button", { name: "3500.00" }).click();
  await page.getByText("Change: 89.99").waitFor();
  await page.locator(".modal details summary").click();
  await page.locator(".modal input[placeholder='10 digits (optional)']").fill("0003168982");
  await page.locator(".modal input[placeholder='Optional']").fill("IASD");
  await shot("07-payment");
  await page.getByRole("button", { name: "Confirm payment" }).click();
  await page.getByRole("heading", { name: "Receipt 00000001" }).waitFor();
  if (!REAL || NET_PRINTER) {
    await page.getByText("Print failed:").waitFor({ timeout: 30000 });
    step("auto-print failed (" + (REAL ? "real QZ Tray, printer port closed" : "simulated") + "); sale kept: " + (await page.locator(".notice.bad").first().textContent()).slice(0, 120) + "…");
    await shot("08-print-failed");
    if (REAL) await setPrinter(target); else await page.evaluate(() => { window.__qzFail = null; });
    await page.locator(".modal").getByRole("button", { name: "Print receipt" }).click();
  }
  await page.getByText(/Last print: SENT \(original\)/).waitFor({ timeout: 20000 });
  step("receipt printed on retry as the ORIGINAL (not a copy)");
  await shot("09-receipt");
  const previewText = await page.locator(".modal .rc").innerText();
  fs.writeFileSync(path.join(out, "receipt-preview.txt"), previewText);

  // ---- reprint requires reason and is a COPY
  await page.locator(".modal").getByRole("button", { name: "Reprint (COPY)" }).click();
  await page.locator(".modal").last().locator("input").fill("customer asked for a copy");
  await page.locator(".modal").last().getByRole("button", { name: "Reprint" }).click();
  await page.getByText(/Last print: SENT \(copy\)/).waitFor({ timeout: 20000 });
  step("reprint sent and marked COPY");

  if (REAL && PRINT_DIR) {
    const files = fs.readdirSync(PRINT_DIR).filter((f) => f.endsWith(".bin")).sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)));
    const jobs = files.map((f) => fs.readFileSync(path.join(PRINT_DIR, f)));
    // [0] test page, [1] original receipt, [2] copy
    assert.equal(jobs.length, 3, "printer received exactly 3 jobs: " + files.join(","));
    const original = jobs[1].toString("latin1");
    fs.writeFileSync(path.join(out, "receipt-original.escpos.bin"), jobs[1]);
    assert.ok(original.startsWith("\x1b@"));
    assert.ok(original.includes("TOTAL                   *3410.01"));
    assert.ok(original.includes("TAX 1(15%)               *444.79"));
    assert.ok(original.includes("RCPT No.:               00000001"));
    assert.ok(!original.includes("COPY"));
    assert.ok(jobs[2].toString("latin1").includes("*** COPY ***"));
    step(`printer emulator received ${jobs.length} raw jobs via real QZ Tray (receipt ${jobs[1].length} bytes)`);
  }
  if (!REAL) {
    const printed = await page.evaluate(() => window.__qzPrinted);
    // [0] test page, [1] original, [2] copy
    const decode = (p) => Buffer.from(p.data[0].data, "base64").toString("latin1");
    const original = decode(printed[1]);
    const copy = decode(printed[2]);
    fs.writeFileSync(path.join(out, "receipt-original.escpos.bin"), Buffer.from(printed[1].data[0].data, "base64"));
    assert.equal(printed[1].data[0].type, "raw");
    assert.equal(printed[1].data[0].flavor, "base64");
    assert.ok(original.includes("TOTAL                   *3410.01"));
    assert.ok(original.includes("TAX 1(15%)               *444.79"));
    assert.ok(original.includes("RCPT No.:               00000001"));
    assert.ok(!original.includes("COPY"));
    assert.ok(copy.includes("*** COPY ***"));
    step(`QZ print payloads checked (${printed.length} jobs, ${printed[1].data[0].data.length} base64 chars for the receipt)`);
  }
  await page.locator(".modal").getByRole("button", { name: "Close" }).click();

  // ---- persistence after reload; dashboard numbers
  await page.goto(base + "/#/dashboard");
  await page.reload();
  await page.getByText("Good day.").waitFor();
  const stats = await page.locator(".stat-value").allTextContents();
  assert.match(stats[0], /3,410\.01/);
  assert.match(stats[1], /^1/);
  assert.match(stats[2], /^0/);
  assert.match(stats[3], /^0 \/ 10/);
  step("after reload: sales 3,410.01, 1 transaction, 0 unpaid, 0/10 tables occupied");
  await shot("10-dashboard");

  // ---- transactions search as cashier
  await page.getByRole("button", { name: "Transactions", exact: true }).click();
  await page.getByPlaceholder(/Receipt no/).fill("tibs");
  await page.getByRole("button", { name: "Search" }).click();
  await page.locator("td.mono", { hasText: "00000001" }).waitFor();
  step("transaction search finds the sale");
  await shot("11-transactions");

  // ---- admin reports + export
  await page.getByRole("button", { name: "Sign Out" }).click();
  await page.getByPlaceholder("Username").fill("owner");
  await page.getByPlaceholder("Password").fill("owner-pass-1");
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.getByRole("button", { name: "Reports" }).click();
  await page.getByText("By payment method").waitFor();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export transactions CSV" }).click();
  const file = await dl;
  const csv = fs.readFileSync(await file.path(), "utf8");
  assert.match(csv, /00000001,.*3410\.01/);
  step("report shown and CSV exported (" + file.suggestedFilename() + ")");
  await shot("12-reports");

  assert.deepEqual(errors, [], "no browser errors");
  console.log("\nBROWSER WORKFLOW: ALL CHECKS PASSED" + (REAL ? " (real QZ Tray)" : " (QZ stand-in)"));
} catch (e) {
  await shot("zz-failure").catch(() => {});
  console.error("FAILED:", e.message, "\nbrowser errors:", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
  app.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
