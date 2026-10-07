// End-to-end API workflow against a real server and database file.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rpos-test-"));
let app, server, base;

async function start() {
  app = createApp({ dataDir, setupToken: "TESTCODE01", log: () => {} });
  server = await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${server.address().port}`;
}
async function stop() { await new Promise((r) => server.close(r)); app.db.close(); }

function client() {
  let cookie = "";
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return { get: (u) => call("GET", u), post: (u, b = {}) => call("POST", u, b), put: (u, b = {}) => call("PUT", u, b), patch: (u, b = {}) => call("PATCH", u, b), del: (u) => call("DELETE", u, {}) };
}

test.before(start);
test.after(async () => { await stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const admin = client();
const cashier = client();
const anon = client();
let menu, orderId, tx1;

test("first-run setup requires the setup code and creates the administrator", async () => {
  assert.equal((await anon.get("/api/state")).data.setupRequired, true);
  assert.ok(fs.readFileSync(path.join(dataDir, "SETUP-TOKEN.txt"), "utf8").includes("TESTCODE01"));
  assert.equal((await anon.post("/api/setup", { setupCode: "WRONG", username: "owner", password: "longpassword" })).status, 403);
  assert.equal((await anon.post("/api/setup", { setupCode: "TESTCODE01", username: "owner", password: "short" })).status, 400);
  const r = await admin.post("/api/setup", { setupCode: "testcode01", username: "owner", name: "Owner", password: "owner-pass-1" });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, "admin");
  assert.equal((await anon.post("/api/setup", { setupCode: "TESTCODE01", username: "x2", password: "longpassword" })).status, 409);
  assert.equal(fs.existsSync(path.join(dataDir, "SETUP-TOKEN.txt")), false);
  assert.equal((await anon.get("/api/state")).data.setupRequired, false);
});

test("login, wrong password, and role permissions", async () => {
  assert.equal((await anon.get("/api/orders")).status, 401);
  assert.equal((await admin.post("/api/users", { username: "selam", name: "Selam", role: "cashier", password: "cashier-pass-1" })).status, 200);
  assert.equal((await cashier.post("/api/login", { username: "selam", password: "nope" })).status, 401);
  const r = await cashier.post("/api/login", { username: "Selam", password: "cashier-pass-1" });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  // cashier may not manage menu prices, settings, users, reports, exports or backups
  for (const [m, u, b] of [["post", "/api/menu", { name: "X", categoryId: 1, price: "1" }], ["put", "/api/settings", {}], ["get", "/api/users"], ["get", "/api/reports/summary"], ["get", "/api/export/transactions.csv"], ["get", "/api/backup/database"]]) {
    assert.equal((await cashier[m](u, b)).status, 403, `${m} ${u}`);
  }
  // but may mark an item sold out
  menu = (await cashier.get("/api/menu")).data;
  assert.equal((await cashier.post(`/api/menu/${menu[1].id}/availability`, { available: false })).status, 200);
  assert.equal((await cashier.post(`/api/menu/${menu[1].id}/availability`, { available: true })).status, 200);
  // non-JSON writes are refused (CSRF defence)
  const res = await fetch(base + "/api/logout", { method: "POST", body: "x" });
  assert.equal(res.status, 415);
});

test("admin edits the menu; prices are validated", async () => {
  assert.equal((await admin.post("/api/menu", { name: "Bad", categoryId: menu[0].categoryId, price: "12.345" })).status, 400);
  const r = await admin.post("/api/menu", { name: "Shiro", receiptName: "Shiro", categoryId: menu[0].categoryId, unit: "pcs", price: "156.52", taxRateBp: 1500 });
  assert.equal(r.status, 200);
  assert.equal((await admin.patch(`/api/menu/${r.data.id}`, { price: "160.00" })).status, 200);
  const item = (await admin.get("/api/menu")).data.find((m) => m.id === r.data.id);
  assert.equal(item.priceCents, 16000);
  assert.equal((await admin.del(`/api/menu/${r.data.id}`)).status, 200);
  assert.ok(!(await admin.get("/api/menu")).data.some((m) => m.id === r.data.id));
  menu = (await admin.get("/api/menu")).data;
});

test("dine-in order reproduces the sample receipt totals", async () => {
  const tables = (await cashier.get("/api/tables")).data;
  assert.equal((await cashier.post("/api/orders", { orderType: "dine_in" })).status, 400); // table required
  const o = await cashier.post("/api/orders", { orderType: "dine_in", tableId: tables[2].id, note: "window seat" });
  assert.equal(o.status, 200);
  orderId = o.data.id;
  const by = (rn) => menu.find((m) => m.receiptName === rn);
  await cashier.post(`/api/orders/${orderId}/items`, { menuItemId: by("1k tibs2").id, qty: 1000 });
  await cashier.post(`/api/orders/${orderId}/items`, { menuItemId: by("Mabaya").id });
  await cashier.post(`/api/orders/${orderId}/items`, { menuItemId: by("Mabaya").id }); // merges to qty 2
  await cashier.post(`/api/orders/${orderId}/items`, { menuItemId: by("2  Liter water").id, qty: "3" });
  let r = await cashier.post(`/api/orders/${orderId}/items`, { menuItemId: by("Sofet derink").id, note: "cold" });
  const water = r.data.items.find((i) => i.receiptName === "2  Liter water");
  r = await cashier.patch(`/api/orders/${orderId}/items/${water.id}`, { qty: 1000 }); // edit quantity
  assert.equal(r.status, 200);
  // add and remove a line
  r = await cashier.post(`/api/orders/${orderId}/items`, { menuItemId: by("1k tibs2").id, qty: 500, note: "extra" });
  const extra = r.data.items.find((i) => i.note === "extra");
  r = await cashier.del(`/api/orders/${orderId}/items/${extra.id}`);
  assert.equal(r.data.items.length, 4);
  assert.equal(r.data.items.find((i) => i.receiptName === "Mabaya").qtyMilli, 2000);
  assert.equal(r.data.totals.netCents, 296522);
  assert.equal(r.data.totals.taxCents, 44479);
  assert.equal(r.data.totals.totalCents, 341001);
  // occupied tables
  const dash = (await cashier.get("/api/dashboard")).data;
  assert.equal(dash.occupiedTables, 1);
  assert.equal(dash.unpaidOrders, 1);
});

test("order states: open -> submitted -> ready; cashier cannot cancel after kitchen", async () => {
  assert.equal((await cashier.post(`/api/orders/${orderId}/status`, { status: "paid" })).status, 409);
  assert.equal((await cashier.post(`/api/orders/${orderId}/status`, { status: "submitted" })).data.status, "submitted");
  assert.equal((await cashier.post(`/api/orders/${orderId}/status`, { status: "ready" })).data.status, "ready");
  assert.equal((await cashier.post(`/api/orders/${orderId}/status`, { status: "cancelled", reason: "test" })).status, 403);
  // takeaway order cancelled while open, reason required
  const t = (await cashier.post("/api/orders", { orderType: "takeaway" })).data;
  assert.equal((await cashier.post(`/api/orders/${t.id}/status`, { status: "cancelled" })).status, 400);
  assert.equal((await cashier.post(`/api/orders/${t.id}/status`, { status: "cancelled", reason: "customer left" })).data.status, "cancelled");
  assert.equal((await cashier.post(`/api/orders/${t.id}/items`, { menuItemId: menu[0].id })).status, 409);
});

test("payment creates one transaction; retries and double clicks do not duplicate", async () => {
  assert.equal((await cashier.post(`/api/orders/${orderId}/pay`, { idempotencyKey: "k-123456789", method: "cash", tendered: "3000.00" })).status, 400); // too little
  assert.equal((await cashier.post(`/api/orders/${orderId}/pay`, { idempotencyKey: "k-123456789", method: "cash", expectedTotalCents: 1 })).status, 409); // order changed
  const body = { idempotencyKey: "k-123456789", method: "cash", tendered: "3500", buyerTin: "0003168982", buyerName: "IASD", expectedTotalCents: 341001 };
  const [a, b] = await Promise.all([cashier.post(`/api/orders/${orderId}/pay`, body), cashier.post(`/api/orders/${orderId}/pay`, body)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.data.id, b.data.id);
  assert.ok(a.data.replay !== b.data.replay);
  tx1 = a.data.replay ? b.data : a.data;
  assert.equal(tx1.receiptNo, 1);
  assert.equal(tx1.totalCents, 341001);
  assert.equal(tx1.taxCents, 44479);
  assert.equal(tx1.changeCents, 8999);
  assert.match(tx1.receiptDate, /^\d{2}\/\d{2}\/\d{4}$/);
  // a different key for the same order still returns the same sale
  const c = await cashier.post(`/api/orders/${orderId}/pay`, { idempotencyKey: "another-key-1", method: "card" });
  assert.equal(c.data.id, tx1.id);
  assert.equal(c.data.replay, true);
  // order now locked
  assert.equal((await cashier.post(`/api/orders/${orderId}/items`, { menuItemId: menu[0].id })).status, 409);
  const all = (await admin.get("/api/transactions")).data;
  assert.equal(all.length, 1);
});

test("receipt numbers are unique and sequential", async () => {
  const nums = [tx1.receiptNo];
  for (let i = 0; i < 3; i++) {
    const o = (await cashier.post("/api/orders", { orderType: "takeaway" })).data;
    await cashier.post(`/api/orders/${o.id}/items`, { menuItemId: menu[1].id, qty: 1000 });
    const t = await cashier.post(`/api/orders/${o.id}/pay`, { idempotencyKey: "seq-key-" + i, method: "mobile", reference: "TB" + i });
    nums.push(t.data.receiptNo);
  }
  assert.deepEqual(nums, [1, 2, 3, 4]);
  // admin can raise the next number but never reuse one
  assert.equal((await admin.put("/api/settings", { nextReceiptNo: 3 })).status, 400);
  assert.equal((await admin.put("/api/settings", { nextReceiptNo: 1000 })).status, 200);
  const o = (await cashier.post("/api/orders", { orderType: "takeaway" })).data;
  await cashier.post(`/api/orders/${o.id}/items`, { menuItemId: menu[1].id });
  assert.equal((await cashier.post(`/api/orders/${o.id}/pay`, { idempotencyKey: "seq-key-x", method: "cash" })).data.receiptNo, 1000);
});

test("a failed print keeps the sale; retry is still the original; later prints are copies", async () => {
  const before = (await admin.get("/api/transactions")).data.length;
  let j = await cashier.post(`/api/transactions/${tx1.id}/print-jobs`, { printer: "POS-58", mode: "escpos" });
  assert.equal(j.data.copy, false);
  await cashier.patch(`/api/print-jobs/${j.data.jobId}`, { status: "failed", error: "QZ Tray is not reachable" });
  j = await cashier.post(`/api/transactions/${tx1.id}/print-jobs`, { printer: "POS-58", mode: "escpos" });
  assert.equal(j.data.copy, false, "retry after a failure is still the original");
  await cashier.patch(`/api/print-jobs/${j.data.jobId}`, { status: "sent" });
  assert.equal((await cashier.patch(`/api/print-jobs/${j.data.jobId}`, { status: "failed" })).status, 409);
  assert.equal((await cashier.post(`/api/transactions/${tx1.id}/print-jobs`, { printer: "POS-58" })).status, 400, "reprint needs a reason");
  j = await cashier.post(`/api/transactions/${tx1.id}/print-jobs`, { printer: "POS-58", reason: "customer copy" });
  assert.equal(j.data.copy, true);
  assert.equal((await admin.get("/api/transactions")).data.length, before, "printing never creates sales");
  const t = (await cashier.get(`/api/transactions/${tx1.id}`)).data;
  assert.deepEqual(t.prints.map((p) => [p.kind, p.status]), [["original", "failed"], ["original", "sent"], ["copy", "pending"]]);
  // admin can forbid cashier reprints
  await admin.put("/api/settings", { cashierCanReprint: false });
  assert.equal((await cashier.post(`/api/transactions/${tx1.id}/print-jobs`, { reason: "again" })).status, 403);
  assert.equal((await admin.post(`/api/transactions/${tx1.id}/print-jobs`, { reason: "again" })).status, 200);
  await admin.put("/api/settings", { cashierCanReprint: true });
});

test("fiscal FS number recording, void, search, reports and exports", async () => {
  assert.equal((await cashier.post(`/api/transactions/${tx1.id}/fiscal`, { fiscalFsNo: "00000595" })).data.fiscalFsNo, "00000595");
  assert.equal((await cashier.post(`/api/transactions/${tx1.id}/fiscal`, { fiscalFsNo: "1" })).status, 403);
  assert.equal((await cashier.post(`/api/transactions/${tx1.id}/void`, { reason: "x" })).status, 403);
  const found = (await cashier.get("/api/transactions?q=00000595")).data;
  assert.equal(found.length, 1);
  assert.equal((await cashier.get("/api/transactions?q=tibs2")).data.length, 1);
  assert.deepEqual((await cashier.get("/api/transactions?q=00000001")).data.map((t) => t.receiptNo), [1]);
  const r = (await admin.get("/api/reports/summary")).data;
  assert.equal(r.totals.count, 5);
  const v = await admin.post(`/api/transactions/${tx1.id}/void`, { reason: "entered twice" });
  assert.equal(v.data.status, "voided");
  const r2 = (await admin.get("/api/reports/summary")).data;
  assert.equal(r2.totals.count, 4);
  assert.equal(r2.voided.count, 1);
  const csv = await admin.get("/api/export/transactions.csv");
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-disposition"), /attachment/);
  assert.match(csv.data, /00000001,.*voided/);
  const lines = await admin.get("/api/export/lines.csv");
  assert.match(lines.data, /1k tibs2/);
  const backup = await fetch(base + "/api/backup/database", { headers: { Cookie: "" } });
  assert.equal(backup.status, 401);
});

test("records persist after the server restarts", async () => {
  await stop();
  await start();
  const again = client();
  assert.equal((await again.post("/api/login", { username: "owner", password: "owner-pass-1" })).status, 200);
  const txs = (await again.get("/api/transactions")).data;
  assert.equal(txs.length, 5);
  const t = txs.find((x) => x.receiptNo === 1);
  assert.equal(t.totalCents, 341001);
  assert.equal(t.fiscalFsNo, "00000595");
  assert.equal(t.status, "voided");
  assert.equal(t.receiptSnapshot.tin, "0038779012");
  // the next sale continues numbering after the restart
  const o = (await again.post("/api/orders", { orderType: "takeaway" })).data;
  await again.post(`/api/orders/${o.id}/items`, { menuItemId: menu[1].id });
  assert.equal((await again.post(`/api/orders/${o.id}/pay`, { idempotencyKey: "after-restart", method: "cash" })).data.receiptNo, 1001);
});

test("QZ signing endpoint signs with the server key only for signed-in users", async () => {
  const crypto = await import("node:crypto");
  const qzDir = path.join(dataDir, "qz");
  fs.mkdirSync(qzDir, { recursive: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(path.join(qzDir, "private-key.pem"), privateKey.export({ type: "pkcs8", format: "pem" }));
  fs.writeFileSync(path.join(qzDir, "digital-certificate.txt"), "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n");
  const c = client();
  assert.equal((await c.post("/api/qz/sign", { request: "abc" })).status, 401);
  await c.post("/api/login", { username: "owner", password: "owner-pass-1" });
  assert.deepEqual((await c.get("/api/qz/status")).data, { certificate: true, privateKey: true });
  const sig = await c.post("/api/qz/sign", { request: "hello-qz" });
  assert.equal(sig.status, 200);
  assert.ok(crypto.verify("sha512", Buffer.from("hello-qz"), publicKey, Buffer.from(sig.data, "base64")));
  const cert = await c.get("/api/qz/certificate");
  assert.match(cert.data, /BEGIN CERTIFICATE/);
  // the private key is never served as a static file
  const leak = await fetch(base + "/data/qz/private-key.pem");
  assert.ok(!(await leak.text()).includes("PRIVATE KEY"));
});
