// Drives restaurant-pos-standalone.html opened directly from disk (file://), like a user double-clicking it.
//   node test/standalone.e2e.mjs
// With a real QZ Tray and a network printer (or emulator) on 127.0.0.1:9100:
//   QZ=real NET_PRINTER=127.0.0.1:9100 PRINT_DIR=/where/the/emulator/saves QZ_CERT=cert.txt QZ_KEY=key.pem node test/standalone.e2e.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || "/opt/node22/lib/node_modules/playwright")); }

const REAL = process.env.QZ === "real";
const NET_PRINTER = process.env.NET_PRINTER || "";
const PRINT_DIR = process.env.PRINT_DIR || "";
const out = path.resolve("test-output/standalone");
fs.mkdirSync(out, { recursive: true });
const fileUrl = pathToFileURL(path.resolve("restaurant-pos-standalone.html")).href;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "rpos-standalone-"));

const STUB = `window.__qzPrinted = []; window.__qzFail = null;
Object.defineProperty(window, "qz", { configurable: true, get() { return window.__qzStub; }, set() {} });
window.__qzStub = (function(){ let active = false; return {
  websocket: { isActive: () => active, connect: async () => { active = true; }, disconnect: async () => { active = false; }, setClosedCallbacks(){}, setErrorCallbacks(){} },
  security: { setCertificatePromise(){}, setSignaturePromise(){}, setSignatureAlgorithm(){} },
  printers: { find: async () => ["POS-58 Thermal (stub)"], getDefault: async () => "POS-58 Thermal (stub)" },
  configs: { create: (p, o) => ({ printer: p, options: o }) },
  print: async (cfg, data) => { if (window.__qzFail) throw new Error(window.__qzFail); window.__qzPrinted.push({ cfg, data }); },
}; })();`;

const ctx = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", viewport: { width: 1366, height: 900 }, acceptDownloads: true });
if (!REAL) await ctx.addInitScript(STUB);
const page = ctx.pages()[0] || (await ctx.newPage());
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|ERR_|favicon/.test(m.text())) errors.push(m.text()); });
const shot = (n) => page.screenshot({ path: path.join(out, n + ".png"), fullPage: true });
const step = (s) => console.log("•", s);
const btn = (name, exact = true) => page.getByRole("button", { name, exact });

try {
  await page.goto(fileUrl);
  await page.getByText("First-time setup").waitFor();
  await shot("01-setup");
  const f = page.locator(".login-card input");
  await f.nth(0).fill("Hailu"); await f.nth(1).fill("owner"); await f.nth(2).fill("owner-pass-1"); await f.nth(3).fill("owner-pass-1");
  await btn("Create administrator").click();
  await page.getByRole("heading", { name: "Atelier" }).waitFor();
  step("opened from file://; administrator created");

  await btn("+ Add user").click();
  const m = page.locator(".modal");
  await m.locator("input").nth(0).fill("selam"); await m.locator("input").nth(1).fill("Selam"); await m.locator("input").nth(2).fill("cashier-pass-1");
  await m.getByRole("button", { name: "Save" }).click();
  await page.getByRole("cell", { name: "selam", exact: true }).waitFor();
  step("cashier created");

  await btn("Bill of Fare").click();
  await btn("+ Add item").click();
  await m.locator("input").nth(0).fill("Shiro");
  await m.locator("input").nth(4).fill("70");
  assert.equal(await m.locator("input").nth(2).inputValue(), "60.87");
  await m.getByRole("button", { name: "Save" }).click();
  await page.getByText("Shiro", { exact: true }).first().waitFor();
  step("menu item added (70.00 incl. VAT → 60.87 net)");

  await btn("The Press").click();
  if (REAL && process.env.QZ_CERT) {
    const card = page.locator(".ink-card", { hasText: "Silent printing" });
    await card.locator("textarea").nth(0).fill(fs.readFileSync(process.env.QZ_CERT, "utf8"));
    await card.locator("textarea").nth(1).fill(fs.readFileSync(process.env.QZ_KEY, "utf8"));
    await card.getByRole("button", { name: "Save signing" }).click();
    await page.getByText("Signing saved for this computer").waitFor({ timeout: 20000 });
    step("QZ signing certificate + key saved; QZ Tray reconnected with signed requests");
  }
  await page.getByText("Printer Connected").waitFor({ timeout: 20000 });
  await btn("Detect QZ Printers").click();
  await page.locator(".notice").filter({ hasText: /Found \d+ printer|QZ|printer/ }).first().waitFor({ timeout: 20000 });
  step("Detect printers: " + (await page.locator(".notice").first().textContent()));
  if (NET_PRINTER) {
    await btn("Network printer (IP)…").click();
    await m.locator("input").fill(NET_PRINTER);
    await m.getByRole("button", { name: "Use" }).click();
  } else {
    await page.locator("select").first().selectOption("POS-58 Thermal (stub)");
  }
  await btn("Save Settings").click();
  await btn("Test Print").click();
  await page.getByText(/Test page sent/).waitFor({ timeout: 20000 });
  step("printer saved and test page sent through QZ");
  await shot("02-press");

  await btn("Receipt layout check (sample)").click();
  await page.getByText("Calculation check").waitFor();
  assert.equal(await page.locator("td.pass").count(), 5);
  step("sample receipt check: 5/5 MATCH");
  await shot("03-sample");

  await btn("Sign Out").click();
  await page.getByPlaceholder("Username").fill("selam");
  await page.getByPlaceholder("Password").fill("cashier-pass-1");
  await btn("Sign In").click();
  await page.getByText("Good day.").waitFor();
  assert.deepEqual(await page.locator(".nav button").allTextContents(), ["Salon", "Service", "Ledger", "Bill of Fare", "The Press"]);
  step("cashier signed in; admin pages hidden");

  // order from the table map on the Salon
  await page.locator(".table-tile").nth(2).click();
  await page.getByText(/Adding to order #1/).waitFor();
  const tile = (n) => page.locator(".menu-tile", { hasText: n });
  await tile("Tibs (per kg)").click();
  await m.locator("input").fill("1.000");
  await m.getByRole("button", { name: "Add" }).click();
  await page.locator(".order-line", { hasText: "Tibs" }).waitFor();
  await tile("Mabaya").click();
  await page.locator(".order-line", { hasText: "Mabaya" }).getByTitle("More").click();
  await page.locator(".order-line", { hasText: "2 x 26.09" }).waitFor();
  await btn("Beverages").click();
  await tile("Water 2 L").click();
  await page.locator(".order-line", { hasText: "Water" }).waitFor();
  await tile("Soft drink").click();
  await page.locator(".order-line", { hasText: "Soft drink" }).getByRole("button", { name: "Note" }).click();
  await m.locator("input").fill("cold");
  await m.getByRole("button", { name: "Save" }).click();
  await page.getByText("Note: cold").waitFor();
  await btn("Food").click();
  await tile("Shiro").click();
  await page.locator(".order-line", { hasText: "Shiro" }).getByRole("button", { name: "Remove" }).click();
  await page.locator(".order-line", { hasText: "Shiro" }).waitFor({ state: "detached" });
  const total = await page.locator(".ink-card", { hasText: "Order #1" }).getByText(/ETB 3,410\.01/).textContent();
  step("order built on table 3: " + total);
  await btn("Send to kitchen").click(); await page.locator(".badge", { hasText: "in kitchen" }).first().waitFor();
  await btn("Mark ready").click(); await page.locator(".badge", { hasText: "ready" }).first().waitFor();
  step("states: open → in kitchen → ready");
  await shot("04-order");

  // first print fails (stub error / real closed port), then succeeds
  const setPrinter = (p) => page.evaluate((p) => { const c = JSON.parse(localStorage.getItem("hbm_rpos_printer_v1")); c.printer = p; localStorage.setItem("hbm_rpos_printer_v1", JSON.stringify(c)); }, p);
  if (REAL) await setPrinter("net://127.0.0.1:9"); else await page.evaluate(() => { window.__qzFail = "Cannot find printer POS-58"; });
  await btn("Settle Account").click();
  await m.getByRole("button", { name: "3500.00" }).click();
  await page.getByText("Change: 89.99").waitFor();
  await m.locator("details summary").click();
  await m.getByPlaceholder("10 digits (optional)").fill("0003168982");
  await m.getByPlaceholder("Optional", { exact: true }).fill("IASD");
  await shot("05-payment");
  await m.getByRole("button", { name: "Confirm payment" }).click();
  await page.getByRole("heading", { name: "Receipt 00000001" }).waitFor();
  await page.getByText("Print failed:").waitFor({ timeout: 30000 });
  step("auto-print failed; sale kept: " + (await page.locator(".notice.bad").first().textContent()).slice(0, 110) + "…");
  await shot("06-print-failed");
  if (REAL) await setPrinter("net://" + NET_PRINTER); else await page.evaluate(() => { window.__qzFail = null; });
  await page.locator(".modal").getByRole("button", { name: "Print (QZ)" }).click();
  await page.getByText(/Last print: SENT \(original\)/).waitFor({ timeout: 20000 });
  step("printed on retry as the ORIGINAL");
  await shot("07-receipt");
  await page.locator(".modal").getByRole("button", { name: "Reprint (COPY)" }).click();
  await page.locator(".modal").last().locator("input").fill("customer copy");
  await page.locator(".modal").last().getByRole("button", { name: "Reprint" }).click();
  await page.getByText(/Last print: SENT \(copy\)/).waitFor({ timeout: 20000 });
  step("reprint marked COPY");

  let original, copy;
  if (REAL && PRINT_DIR) {
    const files = fs.readdirSync(PRINT_DIR).filter((x) => x.endsWith(".bin")).sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)));
    assert.equal(files.length, 3, "printer got test page, original and copy: " + files);
    original = fs.readFileSync(path.join(PRINT_DIR, files[1])).toString("latin1");
    copy = fs.readFileSync(path.join(PRINT_DIR, files[2])).toString("latin1");
    fs.copyFileSync(path.join(PRINT_DIR, files[1]), path.join(out, "receipt-original.escpos.bin"));
  } else if (!REAL) {
    const printed = await page.evaluate(() => window.__qzPrinted);
    original = Buffer.from(printed[1].data[0].data, "base64").toString("latin1");
    copy = Buffer.from(printed[2].data[0].data, "base64").toString("latin1");
  }
  if (original) {
    for (const s of ["TIN:0038779012", "RCPT No.:               00000001", "1.000kg x 2782.60       *2782.60", "TAX 1(15%)               *444.79", "TOTAL                   *3410.01", "CASH                    *3500.00", "CHANGE                    *89.99", "NON-FISCAL RECEIPT"]) assert.ok(original.includes(s), "receipt contains " + s);
    assert.ok(!original.includes("COPY")); assert.ok(copy.includes("*** COPY ***"));
    step("printed bytes verified (totals, VAT, change, non-fiscal footer, COPY on reprint)");
  }
  await page.locator(".modal").getByRole("button", { name: "Close" }).click();

  // a second order paid twice quickly must create one sale
  await btn("Service").click();
  await btn("+ Takeaway order").click();
  await tile("Mabaya").click();
  await page.locator(".order-line", { hasText: "Mabaya" }).waitFor();
  await btn("Settle Account").click();
  await m.getByRole("button", { name: "CARD", exact: true }).click();
  await m.getByRole("button", { name: "Confirm payment" }).dblclick();
  await page.getByRole("heading", { name: "Receipt 00000002" }).waitFor();
  await page.locator(".modal").getByRole("button", { name: "Close" }).click();

  // persistence: close the browser completely and reopen the file
  await ctx.close();
  const ctx2 = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", viewport: { width: 1366, height: 900 }, acceptDownloads: true });
  if (!REAL) await ctx2.addInitScript(STUB);
  const p2 = ctx2.pages()[0] || (await ctx2.newPage());
  p2.on("pageerror", (e) => errors.push(e.message));
  await p2.goto(fileUrl);
  await p2.getByPlaceholder("Username").fill("owner");
  await p2.getByPlaceholder("Password").fill("owner-pass-1");
  await p2.getByRole("button", { name: "Sign In" }).click();
  await p2.getByText("Good day.").waitFor();
  const stats = await p2.locator(".stat-value").allTextContents();
  assert.match(stats[0], /3,440\.01/); // 3410.01 + 30.00
  assert.match(stats[1], /^2/);
  assert.match(stats[2], /^0/);
  step("browser closed and reopened: 2 sales, ETB 3,440.01, 0 unpaid — data persisted, no duplicate sale");
  await p2.screenshot({ path: path.join(out, "08-salon-after-reopen.png"), fullPage: true });

  await p2.getByRole("button", { name: "Ledger", exact: true }).click();
  await p2.getByPlaceholder(/Receipt no/).fill("tibs");
  assert.equal(await p2.locator("table.list tr.click").count(), 1);
  step("ledger search finds the sale");
  await p2.getByRole("button", { name: "Reports", exact: true }).click();
  const dl = p2.waitForEvent("download");
  await p2.getByRole("button", { name: "Export transactions (CSV)" }).click();
  const csv = fs.readFileSync(await (await dl).path(), "utf8");
  assert.match(csv, /00000001,.*3410\.01/); assert.match(csv, /00000002,.*30\.00/);
  step("report CSV exported");
  await p2.getByRole("button", { name: "Atelier", exact: true }).click();
  const dl2 = p2.waitForEvent("download");
  await p2.getByRole("button", { name: "Download backup" }).click();
  const backup = JSON.parse(fs.readFileSync(await (await dl2).path(), "utf8"));
  assert.equal(backup.txs.length, 2);
  assert.ok(!JSON.stringify(backup).includes("PRIVATE KEY"), "signing key is not in backups");
  step("backup downloaded (2 sales, no signing key inside)");
  await p2.screenshot({ path: path.join(out, "09-atelier.png"), fullPage: true });
  await ctx2.close();

  assert.deepEqual(errors, [], "no browser errors");
  console.log("\nSTANDALONE FILE: ALL CHECKS PASSED" + (REAL ? " (real QZ Tray)" : " (QZ stand-in)"));
} catch (e) {
  await shot("zz-failure").catch(() => {});
  console.error("FAILED:", e.message, "\nbrowser errors:", errors);
  process.exitCode = 1;
  await ctx.close().catch(() => {});
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
