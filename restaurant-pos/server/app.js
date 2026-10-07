// HTTP API and static file server. No third-party dependencies.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDatabase, getSettings, setSetting, tx, DEFAULT_SETTINGS } from "./db.js";
import { hashPassword, verifyPassword, validatePassword, newToken, sha256, loginBlocked, recordLoginFailure, clearLoginFailures } from "./auth.js";
import { computeTotals, parseAmount, parseQty, formatAmount } from "../shared/money.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_HOURS = 12;
const COOKIE = "rpos_session";
const ORDER_EDITABLE = new Set(["open", "submitted", "ready"]);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const nowIso = () => new Date().toISOString();

export function createApp(options = {}) {
  const dataDir = options.dataDir || path.join(ROOT, "data");
  const db = options.db || openDatabase(options.dbFile || path.join(dataDir, "restaurant.db"));
  const log = options.log || ((...a) => console.log(...a));

  // ---------- first-run setup token ----------
  let setupToken = null;
  const userCount = () => db.prepare("SELECT COUNT(*) n FROM users").get().n;
  const tokenFile = path.join(dataDir, "SETUP-TOKEN.txt");
  function ensureSetupToken() {
    if (userCount() > 0) { setupToken = null; try { fs.rmSync(tokenFile, { force: true }); } catch {} return; }
    if (!setupToken) setupToken = options.setupToken || crypto.randomBytes(5).toString("hex").toUpperCase();
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(tokenFile, setupToken + "\n", { mode: 0o600 }); } catch {}
    log(`\n  FIRST-RUN SETUP: no administrator exists yet.\n  Open the app in a browser and enter this setup code: ${setupToken}\n  (also saved in ${tokenFile})\n`);
  }
  ensureSetupToken();

  // ---------- QZ Tray signing material (never sent to the browser) ----------
  const qzDir = options.qzDir || path.join(dataDir, "qz");
  const qzKeyPath = process.env.QZ_PRIVATE_KEY || path.join(qzDir, "private-key.pem");
  const qzCertPath = process.env.QZ_CERTIFICATE || path.join(qzDir, "digital-certificate.txt");
  const readIf = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };

  // ---------- helpers ----------
  const audit = (user, action, detail = "") =>
    db.prepare("INSERT INTO audit_log(at,user_id,user_name,action,detail) VALUES(?,?,?,?,?)").run(nowIso(), user?.id ?? null, user?.name ?? null, action, typeof detail === "string" ? detail : JSON.stringify(detail));

  function sessionUser(req) {
    const m = /(?:^|;\s*)rpos_session=([^;]+)/.exec(req.headers.cookie || "");
    if (!m) return null;
    const row = db.prepare("SELECT u.id,u.username,u.name,u.role,u.active,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?").get(sha256(m[1]));
    if (!row || !row.active || row.expires_at < nowIso()) return null;
    return { id: row.id, username: row.username, name: row.name, role: row.role };
  }

  function localStamp(date, tz) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date).map((p) => [p.type, p.value]));
    return { localDate: `${parts.year}-${parts.month}-${parts.day}`, receiptDate: `${parts.day}/${parts.month}/${parts.year}`, receiptTime: `${parts.hour}:${parts.minute}:${parts.second}` };
  }
  const today = () => localStamp(new Date(), getSettings(db).timezone).localDate;

  const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
  const int = (v) => (Number.isSafeInteger(Number(v)) ? Number(v) : null);
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

  function moneyIn(v, field) {
    // Accepts integer cents (number) or a decimal string ("2782.60").
    if (typeof v === "number") { if (Number.isSafeInteger(v) && v >= 0) return v; throw bad(`${field} is not a valid amount.`); }
    const c = parseAmount(v);
    if (c === null) throw bad(`${field} is not a valid amount (use e.g. 2782.60).`);
    return c;
  }
  function qtyIn(v) {
    const q = typeof v === "number" ? (Number.isSafeInteger(v) ? v : null) : parseQty(v);
    if (q === null || q <= 0 || q > 1_000_000) throw bad("Quantity must be greater than 0 (up to 3 decimals).");
    return q;
  }

  // ---------- serialisers ----------
  function orderJson(id) {
    const o = db.prepare("SELECT o.*, t.label table_label, u.name created_by_name FROM orders o LEFT JOIN dining_tables t ON t.id=o.table_id JOIN users u ON u.id=o.created_by WHERE o.id=?").get(id);
    if (!o) throw new HttpError(404, "Order not found.");
    const items = db.prepare("SELECT * FROM order_items WHERE order_id=? ORDER BY id").all(id).map((i) => ({
      id: i.id, menuItemId: i.menu_item_id, name: i.name, receiptName: i.receipt_name, unit: i.unit,
      unitPriceCents: i.unit_price_cents, taxRateBp: i.tax_rate_bp, qtyMilli: i.qty_milli, note: i.note,
    }));
    const totals = computeTotals(items);
    const t = db.prepare("SELECT id, receipt_no FROM transactions WHERE order_id=?").get(id);
    return {
      id: o.id, orderType: o.order_type, tableId: o.table_id, tableLabel: o.table_label, status: o.status, note: o.note,
      customerName: o.customer_name, createdBy: o.created_by_name, createdAt: o.created_at, updatedAt: o.updated_at,
      cancelReason: o.cancel_reason, items: totals.lines, totals: { netCents: totals.netCents, taxCents: totals.taxCents, totalCents: totals.totalCents, taxGroups: totals.taxGroups, itemCount: totals.itemCount },
      transactionId: t?.id ?? null, receiptNo: t?.receipt_no ?? null,
    };
  }

  function txJson(row) {
    if (!row) throw new HttpError(404, "Transaction not found.");
    const prints = db.prepare("SELECT id,kind,status,printer,mode,reason,error,user_name,created_at,updated_at FROM print_jobs WHERE transaction_id=? ORDER BY id").all(row.id);
    return {
      id: row.id, receiptNo: row.receipt_no, orderId: row.order_id, createdAt: row.created_at, localDate: row.local_date,
      receiptDate: row.receipt_date, receiptTime: row.receipt_time, cashierName: row.cashier_name, orderType: row.order_type,
      tableLabel: row.table_label, buyerTin: row.buyer_tin, buyerName: row.buyer_name, netCents: row.net_cents, taxCents: row.tax_cents,
      totalCents: row.total_cents, paymentMethod: row.payment_method, paymentLabel: row.payment_label, tenderedCents: row.tendered_cents,
      changeCents: row.change_cents, paymentRef: row.payment_ref, lines: JSON.parse(row.lines_json), taxGroups: JSON.parse(row.tax_groups_json),
      receiptSnapshot: JSON.parse(row.receipt_snapshot_json), fiscalFsNo: row.fiscal_fs_no, status: row.status, voidReason: row.void_reason,
      voidedAt: row.voided_at, prints, printedOk: prints.some((p) => p.status === "sent" && p.kind !== "test"),
    };
  }
  const getTx = (id) => txJson(db.prepare("SELECT * FROM transactions WHERE id=?").get(id));

  function requireEditable(orderId) {
    const o = db.prepare("SELECT status FROM orders WHERE id=?").get(orderId);
    if (!o) throw new HttpError(404, "Order not found.");
    if (!ORDER_EDITABLE.has(o.status)) throw new HttpError(409, `Order is ${o.status} and can no longer be changed.`);
  }
  const touch = (orderId) => db.prepare("UPDATE orders SET updated_at=? WHERE id=?").run(nowIso(), orderId);

  function txFilter(q) {
    const where = [];
    const args = [];
    if (isDate(q.from)) { where.push("local_date >= ?"); args.push(q.from); }
    if (isDate(q.to)) { where.push("local_date <= ?"); args.push(q.to); }
    if (q.status === "completed" || q.status === "voided") { where.push("status = ?"); args.push(q.status); }
    if (q.method) { where.push("payment_method = ?"); args.push(String(q.method)); }
    const text = str(q.q, 100);
    if (text) {
      const n = /^\d+$/.test(text) ? Number(text) : -1;
      where.push("(receipt_no = ? OR fiscal_fs_no = ? OR buyer_tin LIKE ? OR buyer_name LIKE ? OR cashier_name LIKE ? OR table_label = ? OR lines_json LIKE ?)");
      args.push(n, text, `%${text}%`, `%${text}%`, `%${text}%`, text, `%${text}%`);
    }
    return { sql: where.length ? "WHERE " + where.join(" AND ") : "", args };
  }

  const csvCell = (v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = (rows) => "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, access, handler) => routes.push({ method, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), access, handler });

  route("GET", "/api/state", null, ({ user }) => ({ setupRequired: userCount() === 0, user, version: 1 }));

  route("POST", "/api/setup", null, ({ body, res }) => {
    if (userCount() > 0) throw new HttpError(409, "Setup has already been completed.");
    if (!setupToken || str(body.setupCode).toUpperCase() !== setupToken) throw new HttpError(403, "Setup code is incorrect. It is shown in the server window and saved in data/SETUP-TOKEN.txt.");
    const username = str(body.username, 40).toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw bad("Username: 3-40 letters, digits, dot, dash or underscore.");
    const pwErr = validatePassword(body.password); if (pwErr) throw bad(pwErr);
    const name = str(body.name, 60) || username;
    const id = db.prepare("INSERT INTO users(username,name,role,pw_hash,created_at) VALUES(?,?,?,?,?)").run(username, name, "admin", hashPassword(body.password), nowIso()).lastInsertRowid;
    audit({ id, name }, "setup.admin_created", username);
    ensureSetupToken();
    return startSession(res, Number(id));
  });

  function startSession(res, userId) {
    const token = newToken();
    const exp = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
    db.prepare("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)").run(sha256(token), userId, nowIso(), exp);
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowIso());
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${options.secureCookies ? "; Secure" : ""}`);
    const u = db.prepare("SELECT id,username,name,role FROM users WHERE id=?").get(userId);
    return { user: { ...u } };
  }

  route("POST", "/api/login", null, ({ body, res, req }) => {
    const username = str(body.username, 40).toLowerCase();
    const key = username + "|" + (req.socket.remoteAddress || "");
    if (loginBlocked(key)) throw new HttpError(429, "Too many failed attempts. Wait 5 minutes and try again.");
    const u = db.prepare("SELECT * FROM users WHERE username=?").get(username);
    if (!u || !u.active || !verifyPassword(String(body.password || ""), u.pw_hash)) {
      recordLoginFailure(key);
      throw new HttpError(401, "Incorrect username or password.");
    }
    clearLoginFailures(key);
    audit(u, "login");
    return startSession(res, u.id);
  });

  route("POST", "/api/logout", null, ({ req, res }) => {
    const m = /(?:^|;\s*)rpos_session=([^;]+)/.exec(req.headers.cookie || "");
    if (m) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(sha256(m[1]));
    res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return { ok: true };
  });

  route("POST", "/api/me/password", "any", ({ user, body }) => {
    const u = db.prepare("SELECT pw_hash FROM users WHERE id=?").get(user.id);
    if (!verifyPassword(String(body.currentPassword || ""), u.pw_hash)) throw new HttpError(403, "Current password is incorrect.");
    const err = validatePassword(body.newPassword); if (err) throw bad(err);
    db.prepare("UPDATE users SET pw_hash=? WHERE id=?").run(hashPassword(body.newPassword), user.id);
    audit(user, "user.password_changed", user.username);
    return { ok: true };
  });

  // ----- users (admin) -----
  route("GET", "/api/users", "admin", () => db.prepare("SELECT id,username,name,role,active,created_at createdAt FROM users ORDER BY id").all());
  route("POST", "/api/users", "admin", ({ user, body }) => {
    const username = str(body.username, 40).toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw bad("Username: 3-40 letters, digits, dot, dash or underscore.");
    if (!["admin", "cashier"].includes(body.role)) throw bad("Role must be admin or cashier.");
    const err = validatePassword(body.password); if (err) throw bad(err);
    if (db.prepare("SELECT 1 FROM users WHERE username=?").get(username)) throw new HttpError(409, "That username is taken.");
    const id = db.prepare("INSERT INTO users(username,name,role,pw_hash,created_at) VALUES(?,?,?,?,?)").run(username, str(body.name, 60) || username, body.role, hashPassword(body.password), nowIso()).lastInsertRowid;
    audit(user, "user.created", `${username} (${body.role})`);
    return { id: Number(id) };
  });
  route("PATCH", "/api/users/:id", "admin", ({ user, params, body }) => {
    const target = db.prepare("SELECT * FROM users WHERE id=?").get(int(params.id));
    if (!target) throw new HttpError(404, "User not found.");
    const role = body.role ?? target.role;
    const active = body.active === undefined ? target.active : body.active ? 1 : 0;
    if (!["admin", "cashier"].includes(role)) throw bad("Role must be admin or cashier.");
    if (target.role === "admin" && (role !== "admin" || !active)) {
      const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1 AND id<>?").get(target.id).n;
      if (admins === 0) throw new HttpError(409, "At least one active administrator must remain.");
    }
    db.prepare("UPDATE users SET name=?, role=?, active=? WHERE id=?").run(str(body.name ?? target.name, 60) || target.username, role, active, target.id);
    if (body.password) {
      const err = validatePassword(body.password); if (err) throw bad(err);
      db.prepare("UPDATE users SET pw_hash=? WHERE id=?").run(hashPassword(body.password), target.id);
    }
    if (!active || body.password) db.prepare("DELETE FROM sessions WHERE user_id=?").run(target.id);
    audit(user, "user.updated", { id: target.id, role, active, passwordReset: !!body.password });
    return { ok: true };
  });

  // ----- settings -----
  route("GET", "/api/settings", "any", () => {
    const s = getSettings(db);
    const maxNo = db.prepare("SELECT MAX(receipt_no) m FROM transactions").get().m || 0;
    return { ...s, nextReceiptNo: Math.max(s.nextReceiptNo || 1, maxNo + 1) };
  });
  route("PUT", "/api/settings", "admin", ({ user, body }) => {
    const cur = getSettings(db);
    const lines = (a, n, max) => (Array.isArray(a) ? a : String(a ?? "").split("\n")).map((s) => str(s, max)).filter((s, i, arr) => s || i < arr.length - 1).slice(0, n);
    if (body.business) {
      setSetting(db, "business", {
        tin: str(body.business.tin, 30),
        headerLines: lines(body.business.headerLines, 10, 64).filter(Boolean),
        displayName: str(body.business.displayName, 80) || cur.business.displayName,
      });
    }
    if (body.receipt) {
      setSetting(db, "receipt", {
        heading: str(body.receipt.heading, 32) || "INVOICE",
        numberLabel: str(body.receipt.numberLabel, 16) || "RCPT No.:",
        footerLines: lines(body.receipt.footerLines, 8, 64).filter(Boolean),
        printOrderInfo: !!body.receipt.printOrderInfo,
      });
    }
    if (body.tax) {
      const r = int(body.tax.defaultRateBp);
      if (r === null || r < 0 || r > 10000) throw bad("Tax rate must be between 0 and 100%.");
      setSetting(db, "tax", { defaultRateBp: r });
    }
    if (body.timezone) {
      try { new Intl.DateTimeFormat("en-GB", { timeZone: body.timezone }); } catch { throw bad("Unknown time zone."); }
      setSetting(db, "timezone", body.timezone);
    }
    if (body.currency) setSetting(db, "currency", str(body.currency, 8));
    if (body.autoPrint !== undefined) setSetting(db, "autoPrint", !!body.autoPrint);
    if (body.cashierCanReprint !== undefined) setSetting(db, "cashierCanReprint", !!body.cashierCanReprint);
    if (Array.isArray(body.paymentMethods)) {
      const known = new Map(DEFAULT_SETTINGS.paymentMethods.map((m) => [m.id, m]));
      const pm = body.paymentMethods.filter((m) => known.has(m.id)).map((m) => ({ id: m.id, label: str(m.label, 20).toUpperCase() || known.get(m.id).label, enabled: !!m.enabled }));
      if (!pm.some((m) => m.enabled)) throw bad("Enable at least one payment method.");
      setSetting(db, "paymentMethods", pm);
    }
    if (body.nextReceiptNo !== undefined) {
      const n = int(body.nextReceiptNo);
      const maxNo = db.prepare("SELECT MAX(receipt_no) m FROM transactions").get().m || 0;
      if (n === null || n < 1 || n > 99_999_999) throw bad("Next receipt number must be between 1 and 99999999.");
      if (n <= maxNo) throw bad(`Next receipt number must be greater than the last issued number (${maxNo}).`);
      setSetting(db, "nextReceiptNo", n);
    }
    audit(user, "settings.updated", Object.keys(body).join(","));
    return { ok: true };
  });

  // ----- categories -----
  route("GET", "/api/categories", "any", () => db.prepare("SELECT id,name,kind,sort,active FROM categories ORDER BY sort,id").all());
  route("POST", "/api/categories", "admin", ({ user, body }) => {
    const name = str(body.name, 40); if (!name) throw bad("Category name is required.");
    const kind = ["food", "beverage", "other"].includes(body.kind) ? body.kind : "food";
    const id = db.prepare("INSERT INTO categories(name,kind,sort) VALUES(?,?,?)").run(name, kind, int(body.sort) ?? 0).lastInsertRowid;
    audit(user, "category.created", name);
    return { id: Number(id) };
  });
  route("PATCH", "/api/categories/:id", "admin", ({ user, params, body }) => {
    const c = db.prepare("SELECT * FROM categories WHERE id=?").get(int(params.id));
    if (!c) throw new HttpError(404, "Category not found.");
    const kind = ["food", "beverage", "other"].includes(body.kind) ? body.kind : c.kind;
    db.prepare("UPDATE categories SET name=?,kind=?,sort=?,active=? WHERE id=?").run(str(body.name ?? c.name, 40) || c.name, kind, int(body.sort ?? c.sort) ?? 0, body.active === undefined ? c.active : body.active ? 1 : 0, c.id);
    audit(user, "category.updated", c.id);
    return { ok: true };
  });

  // ----- menu -----
  const menuRow = (m) => ({ id: m.id, categoryId: m.category_id, name: m.name, receiptName: m.receipt_name, unit: m.unit, priceCents: m.price_cents, taxRateBp: m.tax_rate_bp, available: !!m.available, archived: !!m.archived, sort: m.sort, updatedAt: m.updated_at });
  route("GET", "/api/menu", "any", () => db.prepare("SELECT * FROM menu_items WHERE archived=0 ORDER BY category_id, sort, name").all().map(menuRow));
  function menuInput(body, cur = {}) {
    const name = str(body.name ?? cur.name, 80); if (!name) throw bad("Item name is required.");
    const categoryId = int(body.categoryId ?? cur.category_id);
    if (!categoryId || !db.prepare("SELECT 1 FROM categories WHERE id=?").get(categoryId)) throw bad("Choose a valid category.");
    const unit = body.unit ?? cur.unit ?? "pcs"; if (!["pcs", "kg"].includes(unit)) throw bad("Unit must be pcs or kg.");
    const price = body.priceCents !== undefined || body.price !== undefined ? moneyIn(body.priceCents ?? body.price, "Price") : cur.price_cents;
    if (price === undefined) throw bad("Price is required.");
    const rate = int(body.taxRateBp ?? cur.tax_rate_bp ?? getSettings(db).tax.defaultRateBp);
    if (rate === null || rate < 0 || rate > 10000) throw bad("Tax rate must be between 0 and 100%.");
    const receiptName = str(body.receiptName ?? cur.receipt_name, 64) || name;
    return { name, categoryId, unit, price, rate, receiptName, available: body.available === undefined ? cur.available ?? 1 : body.available ? 1 : 0, sort: int(body.sort ?? cur.sort) ?? 0 };
  }
  route("POST", "/api/menu", "admin", ({ user, body }) => {
    const m = menuInput(body);
    const id = db.prepare("INSERT INTO menu_items(category_id,name,receipt_name,unit,price_cents,tax_rate_bp,available,sort,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(m.categoryId, m.name, m.receiptName, m.unit, m.price, m.rate, m.available, m.sort, nowIso()).lastInsertRowid;
    audit(user, "menu.created", `${m.name} ${formatAmount(m.price)}`);
    return { id: Number(id) };
  });
  route("PATCH", "/api/menu/:id", "admin", ({ user, params, body }) => {
    const cur = db.prepare("SELECT * FROM menu_items WHERE id=? AND archived=0").get(int(params.id));
    if (!cur) throw new HttpError(404, "Menu item not found.");
    const m = menuInput(body, cur);
    db.prepare("UPDATE menu_items SET category_id=?,name=?,receipt_name=?,unit=?,price_cents=?,tax_rate_bp=?,available=?,sort=?,updated_at=? WHERE id=?").run(m.categoryId, m.name, m.receiptName, m.unit, m.price, m.rate, m.available, m.sort, nowIso(), cur.id);
    audit(user, "menu.updated", { id: cur.id, name: m.name, price: formatAmount(m.price), oldPrice: formatAmount(cur.price_cents), available: m.available });
    return { ok: true };
  });
  // Cashiers may mark items sold out / back in stock during service.
  route("POST", "/api/menu/:id/availability", "any", ({ user, params, body }) => {
    const cur = db.prepare("SELECT id,name FROM menu_items WHERE id=? AND archived=0").get(int(params.id));
    if (!cur) throw new HttpError(404, "Menu item not found.");
    db.prepare("UPDATE menu_items SET available=?, updated_at=? WHERE id=?").run(body.available ? 1 : 0, nowIso(), cur.id);
    audit(user, "menu.availability", `${cur.name}: ${body.available ? "available" : "sold out"}`);
    return { ok: true };
  });
  // Items are archived, not deleted, so past orders keep a valid reference.
  route("DELETE", "/api/menu/:id", "admin", ({ user, params }) => {
    const cur = db.prepare("SELECT id,name FROM menu_items WHERE id=? AND archived=0").get(int(params.id));
    if (!cur) throw new HttpError(404, "Menu item not found.");
    db.prepare("UPDATE menu_items SET archived=1, available=0, updated_at=? WHERE id=?").run(nowIso(), cur.id);
    audit(user, "menu.removed", cur.name);
    return { ok: true };
  });

  // ----- tables -----
  route("GET", "/api/tables", "any", () => db.prepare(`SELECT t.id,t.label,t.seats,t.active,
      (SELECT o.id FROM orders o WHERE o.table_id=t.id AND o.status IN ('open','submitted','ready') ORDER BY o.id LIMIT 1) openOrderId,
      (SELECT COUNT(*) FROM orders o WHERE o.table_id=t.id AND o.status IN ('open','submitted','ready')) openOrders
      FROM dining_tables t ORDER BY CAST(t.label AS INTEGER), t.label`).all().map((t) => ({ ...t, active: !!t.active, occupied: t.openOrders > 0 })));
  route("POST", "/api/tables", "admin", ({ user, body }) => {
    const label = str(body.label, 12); if (!label) throw bad("Table label is required.");
    if (db.prepare("SELECT 1 FROM dining_tables WHERE label=?").get(label)) throw new HttpError(409, "A table with that label exists.");
    const id = db.prepare("INSERT INTO dining_tables(label,seats) VALUES(?,?)").run(label, int(body.seats) || 4).lastInsertRowid;
    audit(user, "table.created", label);
    return { id: Number(id) };
  });
  route("PATCH", "/api/tables/:id", "admin", ({ user, params, body }) => {
    const t = db.prepare("SELECT * FROM dining_tables WHERE id=?").get(int(params.id));
    if (!t) throw new HttpError(404, "Table not found.");
    const label = str(body.label ?? t.label, 12) || t.label;
    if (label !== t.label && db.prepare("SELECT 1 FROM dining_tables WHERE label=?").get(label)) throw new HttpError(409, "A table with that label exists.");
    db.prepare("UPDATE dining_tables SET label=?,seats=?,active=? WHERE id=?").run(label, int(body.seats ?? t.seats) || 4, body.active === undefined ? t.active : body.active ? 1 : 0, t.id);
    audit(user, "table.updated", label);
    return { ok: true };
  });

  // ----- orders -----
  route("GET", "/api/orders", "any", ({ query }) => {
    let sql = "SELECT id FROM orders";
    const args = [];
    if (query.status === "active" || !query.status) sql += " WHERE status IN ('open','submitted','ready')";
    else if (["open", "submitted", "ready", "paid", "cancelled"].includes(query.status)) { sql += " WHERE status=?"; args.push(query.status); }
    sql += " ORDER BY id DESC LIMIT 200";
    return db.prepare(sql).all(...args).map((r) => orderJson(r.id));
  });
  route("GET", "/api/orders/:id", "any", ({ params }) => orderJson(int(params.id)));
  route("POST", "/api/orders", "any", ({ user, body }) => {
    const type = body.orderType === "takeaway" ? "takeaway" : "dine_in";
    let tableId = null;
    if (type === "dine_in") {
      tableId = int(body.tableId);
      const t = tableId && db.prepare("SELECT * FROM dining_tables WHERE id=? AND active=1").get(tableId);
      if (!t) throw bad("Choose a table for a dine-in order.");
    }
    const now = nowIso();
    const id = db.prepare("INSERT INTO orders(order_type,table_id,status,note,customer_name,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(type, tableId, "open", str(body.note, 300), str(body.customerName, 60), user.id, now, now).lastInsertRowid;
    audit(user, "order.created", { id: Number(id), type, tableId });
    return orderJson(Number(id));
  });
  route("PATCH", "/api/orders/:id", "any", ({ user, params, body }) => {
    const id = int(params.id);
    requireEditable(id);
    const o = db.prepare("SELECT * FROM orders WHERE id=?").get(id);
    const type = body.orderType ? (body.orderType === "takeaway" ? "takeaway" : "dine_in") : o.order_type;
    let tableId = type === "takeaway" ? null : body.tableId !== undefined ? int(body.tableId) : o.table_id;
    if (type === "dine_in" && !(tableId && db.prepare("SELECT 1 FROM dining_tables WHERE id=? AND active=1").get(tableId))) throw bad("Choose a table for a dine-in order.");
    db.prepare("UPDATE orders SET order_type=?, table_id=?, note=?, customer_name=?, updated_at=? WHERE id=?").run(type, tableId, body.note !== undefined ? str(body.note, 300) : o.note, body.customerName !== undefined ? str(body.customerName, 60) : o.customer_name, nowIso(), id);
    audit(user, "order.updated", id);
    return orderJson(id);
  });
  route("POST", "/api/orders/:id/items", "any", ({ user, params, body }) => {
    const id = int(params.id);
    return tx(db, () => {
      requireEditable(id);
      const m = db.prepare("SELECT * FROM menu_items WHERE id=? AND archived=0").get(int(body.menuItemId));
      if (!m) throw bad("Menu item not found.");
      if (!m.available) throw new HttpError(409, `${m.name} is marked unavailable.`);
      const qty = body.qty === undefined ? 1000 : qtyIn(body.qty);
      const note = str(body.note, 120);
      const existing = !note && db.prepare("SELECT * FROM order_items WHERE order_id=? AND menu_item_id=? AND note='' AND unit_price_cents=? AND tax_rate_bp=?").get(id, m.id, m.price_cents, m.tax_rate_bp);
      if (existing) db.prepare("UPDATE order_items SET qty_milli=qty_milli+? WHERE id=?").run(qty, existing.id);
      else db.prepare("INSERT INTO order_items(order_id,menu_item_id,name,receipt_name,unit,unit_price_cents,tax_rate_bp,qty_milli,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, m.id, m.name, m.receipt_name, m.unit, m.price_cents, m.tax_rate_bp, qty, note, nowIso());
      touch(id);
      audit(user, "order.item_added", { order: id, item: m.name, qty });
      return orderJson(id);
    });
  });
  route("PATCH", "/api/orders/:id/items/:itemId", "any", ({ user, params, body }) => {
    const id = int(params.id);
    return tx(db, () => {
      requireEditable(id);
      const it = db.prepare("SELECT * FROM order_items WHERE id=? AND order_id=?").get(int(params.itemId), id);
      if (!it) throw new HttpError(404, "Order line not found.");
      const qty = body.qty !== undefined ? qtyIn(body.qty) : it.qty_milli;
      const note = body.note !== undefined ? str(body.note, 120) : it.note;
      db.prepare("UPDATE order_items SET qty_milli=?, note=? WHERE id=?").run(qty, note, it.id);
      touch(id);
      audit(user, "order.item_changed", { order: id, item: it.name, qty, note });
      return orderJson(id);
    });
  });
  route("DELETE", "/api/orders/:id/items/:itemId", "any", ({ user, params }) => {
    const id = int(params.id);
    return tx(db, () => {
      requireEditable(id);
      const it = db.prepare("SELECT * FROM order_items WHERE id=? AND order_id=?").get(int(params.itemId), id);
      if (!it) throw new HttpError(404, "Order line not found.");
      db.prepare("DELETE FROM order_items WHERE id=?").run(it.id);
      touch(id);
      audit(user, "order.item_removed", { order: id, item: it.name, qty: it.qty_milli });
      return orderJson(id);
    });
  });
  route("POST", "/api/orders/:id/status", "any", ({ user, params, body }) => {
    const id = int(params.id);
    return tx(db, () => {
      const o = db.prepare("SELECT * FROM orders WHERE id=?").get(id);
      if (!o) throw new HttpError(404, "Order not found.");
      const to = body.status;
      const allowed = { open: ["submitted", "cancelled"], submitted: ["ready", "open", "cancelled"], ready: ["submitted", "cancelled"] };
      if (!allowed[o.status]?.includes(to)) throw new HttpError(409, `Cannot change an order from ${o.status} to ${to}.`);
      if (to === "submitted" && !db.prepare("SELECT 1 FROM order_items WHERE order_id=?").get(id)) throw bad("Add at least one item before submitting.");
      if (to === "cancelled") {
        const reason = str(body.reason, 200);
        if (!reason) throw bad("A reason is required to cancel an order.");
        if (user.role !== "admin" && o.status !== "open") throw new HttpError(403, "Only an administrator can cancel an order that has been sent to the kitchen.");
        db.prepare("UPDATE orders SET status='cancelled', cancelled_by=?, cancel_reason=?, updated_at=? WHERE id=?").run(user.id, reason, nowIso(), id);
      } else {
        db.prepare("UPDATE orders SET status=?, updated_at=? WHERE id=?").run(to, nowIso(), id);
      }
      audit(user, "order.status", { order: id, from: o.status, to, reason: body.reason });
      return orderJson(id);
    });
  });

  // Payment: creates exactly one transaction per order. Repeating the request (same key, or the
  // same order after a network failure) returns the existing transaction instead of a new sale.
  route("POST", "/api/orders/:id/pay", "any", ({ user, params, body }) => {
    const id = int(params.id);
    const key = str(body.idempotencyKey, 80);
    if (key.length < 8) throw bad("Missing payment request key.");
    const result = tx(db, () => {
      const prior = db.prepare("SELECT * FROM transactions WHERE idempotency_key=? OR order_id=?").get(key, id);
      if (prior) return { replay: true, row: prior };
      const o = db.prepare("SELECT o.*, t.label table_label FROM orders o LEFT JOIN dining_tables t ON t.id=o.table_id WHERE o.id=?").get(id);
      if (!o) throw new HttpError(404, "Order not found.");
      if (!ORDER_EDITABLE.has(o.status)) throw new HttpError(409, `Order is ${o.status}; it cannot be paid.`);
      const items = db.prepare("SELECT * FROM order_items WHERE order_id=? ORDER BY id").all(id);
      if (!items.length) throw bad("The order has no items.");
      const totals = computeTotals(items.map((i) => ({ name: i.name, receiptName: i.receipt_name, unit: i.unit, unitPriceCents: i.unit_price_cents, taxRateBp: i.tax_rate_bp, qtyMilli: i.qty_milli, note: i.note })));
      if (body.expectedTotalCents !== undefined && Number(body.expectedTotalCents) !== totals.totalCents) throw new HttpError(409, "The order changed while the bill was open. Review the total and confirm again.");
      const settings = getSettings(db);
      const method = settings.paymentMethods.find((m) => m.id === body.method && m.enabled);
      if (!method) throw bad("Choose a payment method.");
      let tendered = totals.totalCents;
      if (method.id === "cash" && body.tendered !== undefined && body.tendered !== "" && body.tendered !== null) {
        tendered = moneyIn(body.tendered, "Amount received");
        if (tendered < totals.totalCents) throw bad("Amount received is less than the total.");
      }
      const buyerTin = str(body.buyerTin, 20);
      if (buyerTin && !/^\d{10}$/.test(buyerTin)) throw bad("Buyer's TIN should be 10 digits.");
      const maxNo = db.prepare("SELECT MAX(receipt_no) m FROM transactions").get().m || 0;
      const receiptNo = Math.max(settings.nextReceiptNo || 1, maxNo + 1);
      const stamp = localStamp(new Date(), settings.timezone);
      const snapshot = { tin: settings.business.tin, headerLines: settings.business.headerLines, heading: settings.receipt.heading, numberLabel: settings.receipt.numberLabel, footerLines: settings.receipt.footerLines, printOrderInfo: settings.receipt.printOrderInfo };
      const info = db.prepare(`INSERT INTO transactions(receipt_no,order_id,idempotency_key,created_at,local_date,receipt_date,receipt_time,cashier_id,cashier_name,order_type,table_label,buyer_tin,buyer_name,net_cents,tax_cents,total_cents,payment_method,payment_label,tendered_cents,change_cents,payment_ref,lines_json,tax_groups_json,receipt_snapshot_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        receiptNo, id, key, nowIso(), stamp.localDate, stamp.receiptDate, stamp.receiptTime, user.id, user.name, o.order_type, o.table_label, buyerTin, str(body.buyerName, 40),
        totals.netCents, totals.taxCents, totals.totalCents, method.id, method.label, tendered, tendered - totals.totalCents, str(body.reference, 60),
        JSON.stringify(totals.lines), JSON.stringify(totals.taxGroups), JSON.stringify(snapshot));
      setSetting(db, "nextReceiptNo", receiptNo + 1);
      db.prepare("UPDATE orders SET status='paid', updated_at=? WHERE id=?").run(nowIso(), id);
      audit(user, "transaction.created", { receiptNo, order: id, total: formatAmount(totals.totalCents), method: method.id });
      return { replay: false, row: db.prepare("SELECT * FROM transactions WHERE id=?").get(info.lastInsertRowid) };
    });
    return { ...getTx(result.row.id), replay: result.replay };
  });

  // ----- transactions -----
  route("GET", "/api/transactions", "any", ({ query }) => {
    const f = txFilter(query);
    const limit = Math.min(500, int(query.limit) || 200);
    const rows = db.prepare(`SELECT * FROM transactions ${f.sql} ORDER BY receipt_no DESC LIMIT ${limit}`).all(...f.args);
    return rows.map(txJson);
  });
  route("GET", "/api/transactions/:id", "any", ({ params }) => getTx(int(params.id)));
  route("POST", "/api/transactions/:id/fiscal", "any", ({ user, params, body }) => {
    const t = db.prepare("SELECT * FROM transactions WHERE id=?").get(int(params.id));
    if (!t) throw new HttpError(404, "Transaction not found.");
    const fs = str(body.fiscalFsNo, 20);
    if (fs && !/^[0-9A-Za-z-]{1,20}$/.test(fs)) throw bad("FS number may contain only letters, digits and dashes.");
    if (t.fiscal_fs_no && user.role !== "admin") throw new HttpError(403, "Only an administrator can change a recorded FS number.");
    db.prepare("UPDATE transactions SET fiscal_fs_no=? WHERE id=?").run(fs, t.id);
    audit(user, "transaction.fiscal_fs_recorded", { receiptNo: t.receipt_no, fs, previous: t.fiscal_fs_no });
    return getTx(t.id);
  });
  route("POST", "/api/transactions/:id/void", "admin", ({ user, params, body }) => {
    const t = db.prepare("SELECT * FROM transactions WHERE id=?").get(int(params.id));
    if (!t) throw new HttpError(404, "Transaction not found.");
    if (t.status === "voided") throw new HttpError(409, "Already voided.");
    const reason = str(body.reason, 200); if (!reason) throw bad("A reason is required to void a sale.");
    db.prepare("UPDATE transactions SET status='voided', void_reason=?, voided_by=?, voided_at=? WHERE id=?").run(reason, user.id, nowIso(), t.id);
    audit(user, "transaction.voided", { receiptNo: t.receipt_no, reason });
    return getTx(t.id);
  });

  // ----- print jobs (printing is recorded separately from the sale) -----
  route("POST", "/api/transactions/:id/print-jobs", "any", ({ user, params, body }) => {
    const id = int(params.id);
    return tx(db, () => {
      const t = db.prepare("SELECT id,receipt_no FROM transactions WHERE id=?").get(id);
      if (!t) throw new HttpError(404, "Transaction not found.");
      const printedBefore = !!db.prepare("SELECT 1 FROM print_jobs WHERE transaction_id=? AND status='sent' AND kind<>'test'").get(id);
      const reason = str(body.reason, 200);
      if (printedBefore) {
        const s = getSettings(db);
        if (user.role !== "admin" && !s.cashierCanReprint) throw new HttpError(403, "Reprinting is limited to administrators.");
        if (!reason) throw bad("Give a reason for the reprint.");
      }
      const kind = printedBefore ? "copy" : "original";
      const jid = db.prepare("INSERT INTO print_jobs(transaction_id,kind,status,printer,mode,reason,user_id,user_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, kind, "pending", str(body.printer, 120), str(body.mode, 20), reason, user.id, user.name, nowIso(), nowIso()).lastInsertRowid;
      if (printedBefore) audit(user, "transaction.reprint", { receiptNo: t.receipt_no, reason });
      return { jobId: Number(jid), copy: printedBefore, kind };
    });
  });
  route("POST", "/api/print-jobs", "any", ({ user, body }) => {
    const jid = db.prepare("INSERT INTO print_jobs(transaction_id,kind,status,printer,mode,user_id,user_name,created_at,updated_at) VALUES(NULL,'test','pending',?,?,?,?,?,?)").run(str(body.printer, 120), str(body.mode, 20), user.id, user.name, nowIso(), nowIso()).lastInsertRowid;
    return { jobId: Number(jid) };
  });
  route("PATCH", "/api/print-jobs/:id", "any", ({ params, body }) => {
    const j = db.prepare("SELECT * FROM print_jobs WHERE id=?").get(int(params.id));
    if (!j) throw new HttpError(404, "Print job not found.");
    if (j.status !== "pending") throw new HttpError(409, "Print job already finished.");
    if (!["sent", "failed"].includes(body.status)) throw bad("Status must be sent or failed.");
    db.prepare("UPDATE print_jobs SET status=?, error=?, printer=COALESCE(NULLIF(?,''),printer), updated_at=? WHERE id=?").run(body.status, str(body.error, 500), str(body.printer, 120), nowIso(), j.id);
    return { ok: true };
  });
  route("GET", "/api/print-jobs", "any", () => db.prepare(`SELECT p.id,p.transaction_id transactionId,t.receipt_no receiptNo,p.kind,p.status,p.printer,p.mode,p.reason,p.error,p.user_name userName,p.created_at createdAt
      FROM print_jobs p LEFT JOIN transactions t ON t.id=p.transaction_id ORDER BY p.id DESC LIMIT 50`).all());

  // ----- dashboard -----
  route("GET", "/api/dashboard", "any", () => {
    const d = today();
    const sales = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) total, COALESCE(SUM(tax_cents),0) tax FROM transactions WHERE local_date=? AND status='completed'").get(d);
    const unpaid = db.prepare("SELECT COUNT(*) n FROM orders WHERE status IN ('open','submitted','ready')").get().n;
    const byStatus = Object.fromEntries(db.prepare("SELECT status, COUNT(*) n FROM orders WHERE status IN ('open','submitted','ready') GROUP BY status").all().map((r) => [r.status, r.n]));
    const tables = db.prepare("SELECT COUNT(*) n FROM dining_tables WHERE active=1").get().n;
    const occupied = db.prepare("SELECT COUNT(DISTINCT table_id) n FROM orders WHERE status IN ('open','submitted','ready') AND table_id IS NOT NULL").get().n;
    const unprinted = db.prepare("SELECT COUNT(*) n FROM transactions t WHERE local_date=? AND NOT EXISTS (SELECT 1 FROM print_jobs p WHERE p.transaction_id=t.id AND p.status='sent')").get(d).n;
    const recent = db.prepare("SELECT * FROM transactions ORDER BY id DESC LIMIT 8").all().map(txJson);
    return { date: d, salesCents: sales.total, taxCents: sales.tax, completed: sales.n, unpaidOrders: unpaid, ordersByStatus: byStatus, tables, occupiedTables: occupied, unprintedToday: unprinted, recent };
  });

  // ----- reports -----
  route("GET", "/api/reports/summary", "admin", ({ query }) => {
    const f = txFilter({ ...query, status: "completed" });
    const base = `FROM transactions ${f.sql}`;
    const totals = db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(net_cents),0) netCents, COALESCE(SUM(tax_cents),0) taxCents, COALESCE(SUM(total_cents),0) totalCents ${base}`).get(...f.args);
    const byMethod = db.prepare(`SELECT payment_label label, COUNT(*) count, SUM(total_cents) totalCents ${base} GROUP BY payment_label ORDER BY totalCents DESC`).all(...f.args);
    const byCashier = db.prepare(`SELECT cashier_name label, COUNT(*) count, SUM(total_cents) totalCents ${base} GROUP BY cashier_name ORDER BY totalCents DESC`).all(...f.args);
    const byDay = db.prepare(`SELECT local_date label, COUNT(*) count, SUM(net_cents) netCents, SUM(tax_cents) taxCents, SUM(total_cents) totalCents ${base} GROUP BY local_date ORDER BY local_date`).all(...f.args);
    const items = new Map();
    for (const r of db.prepare(`SELECT lines_json ${base}`).all(...f.args)) {
      for (const l of JSON.parse(r.lines_json)) {
        const k = l.name + "|" + l.unit;
        const cur = items.get(k) || { label: l.name, unit: l.unit, qtyMilli: 0, netCents: 0 };
        cur.qtyMilli += l.qtyMilli; cur.netCents += l.amountCents;
        items.set(k, cur);
      }
    }
    const fv = txFilter({ ...query, status: "voided" });
    const voided = db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(total_cents),0) totalCents FROM transactions ${fv.sql}`).get(...fv.args);
    return { from: query.from || null, to: query.to || null, totals, byMethod, byCashier, byDay, byItem: [...items.values()].sort((a, b) => b.netCents - a.netCents), voided };
  });
  route("GET", "/api/export/transactions.csv", "admin", ({ query, res }) => {
    const f = txFilter(query);
    const rows = db.prepare(`SELECT * FROM transactions ${f.sql} ORDER BY receipt_no`).all(...f.args);
    const out = [["Receipt No", "Date", "Time", "Status", "Order type", "Table", "Cashier", "Payment", "Reference", "Net", "VAT", "Total", "Received", "Change", "Items", "Buyer TIN", "Buyer name", "Fiscal FS No", "Void reason"]];
    for (const r of rows) out.push([String(r.receipt_no).padStart(8, "0"), r.local_date, r.receipt_time, r.status, r.order_type, r.table_label || "", r.cashier_name, r.payment_label, r.payment_ref, formatAmount(r.net_cents), formatAmount(r.tax_cents), formatAmount(r.total_cents), formatAmount(r.tendered_cents), formatAmount(r.change_cents), JSON.parse(r.lines_json).length, r.buyer_tin, r.buyer_name, r.fiscal_fs_no, r.void_reason || ""]);
    return fileResponse(res, `transactions_${query.from || "all"}_${query.to || "all"}.csv`, "text/csv; charset=utf-8", csv(out));
  });
  route("GET", "/api/export/lines.csv", "admin", ({ query, res }) => {
    const f = txFilter(query);
    const rows = db.prepare(`SELECT * FROM transactions ${f.sql} ORDER BY receipt_no`).all(...f.args);
    const out = [["Receipt No", "Date", "Status", "Item", "Receipt name", "Qty", "Unit", "Unit price (net)", "Amount (net)", "VAT rate %", "VAT", "Note"]];
    for (const r of rows) for (const l of JSON.parse(r.lines_json)) out.push([String(r.receipt_no).padStart(8, "0"), r.local_date, r.status, l.name, l.receiptName, (l.qtyMilli / 1000).toFixed(3), l.unit, formatAmount(l.unitPriceCents), formatAmount(l.amountCents), (l.taxRateBp / 100).toFixed(2), formatAmount(l.taxCents), l.note || ""]);
    return fileResponse(res, `sale_lines_${query.from || "all"}_${query.to || "all"}.csv`, "text/csv; charset=utf-8", csv(out));
  });

  // ----- backup -----
  route("GET", "/api/backup/database", "admin", ({ user, res }) => {
    const tmp = path.join(dataDir, `backup-${Date.now()}.db`);
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const buf = fs.readFileSync(tmp);
    fs.rmSync(tmp, { force: true });
    audit(user, "backup.database");
    return fileResponse(res, `restaurant-backup-${today()}.db`, "application/vnd.sqlite3", buf);
  });
  route("GET", "/api/backup/json", "admin", ({ user, res }) => {
    const dump = { exportedAt: nowIso(), schemaVersion: 1 };
    for (const t of ["settings", "categories", "menu_items", "dining_tables", "orders", "order_items", "transactions", "print_jobs", "audit_log"]) dump[t] = db.prepare(`SELECT * FROM ${t}`).all();
    dump.users = db.prepare("SELECT id,username,name,role,active,created_at FROM users").all();
    audit(user, "backup.json");
    return fileResponse(res, `restaurant-export-${today()}.json`, "application/json", JSON.stringify(dump, null, 1));
  });
  route("GET", "/api/audit", "admin", () => db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 200").all());

  // ----- QZ Tray signing -----
  route("GET", "/api/qz/status", "any", () => ({ certificate: !!readIf(qzCertPath), privateKey: !!readIf(qzKeyPath) }));
  route("GET", "/api/qz/certificate", "any", ({ res }) => {
    const cert = readIf(qzCertPath);
    if (!cert) throw new HttpError(404, "No QZ certificate installed (see README, QZ Tray signing).");
    res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end(cert);
    return undefined;
  });
  route("POST", "/api/qz/sign", "any", ({ body, res }) => {
    const key = readIf(qzKeyPath);
    if (!key) throw new HttpError(404, "No QZ private key installed (see README, QZ Tray signing).");
    const toSign = String(body.request ?? "");
    if (!toSign || toSign.length > 100_000) throw bad("Nothing to sign.");
    const signature = crypto.createSign("SHA512").update(toSign).sign(key, "base64");
    res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end(signature);
    return undefined;
  });

  function fileResponse(res, name, type, data) {
    res.writeHead(200, { "Content-Type": type, "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" });
    res.end(data);
    return undefined;
  }

  // ---------- static files ----------
  const STATIC = [["/shared/", path.join(ROOT, "shared")], ["/", path.join(ROOT, "public")]];
  const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
  function serveStatic(req, res, pathname) {
    for (const [prefix, dir] of STATIC) {
      if (!pathname.startsWith(prefix)) continue;
      let rel = decodeURIComponent(pathname.slice(prefix.length));
      if (!rel || rel.endsWith("/")) rel += "index.html";
      const file = path.resolve(dir, rel);
      if (!file.startsWith(dir + path.sep)) break;
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (!stat.isFile()) continue;
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
      fs.createReadStream(file).pipe(res);
      return true;
    }
    return false;
  }

  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    // QZ Tray listens on localhost (wss 8181/8282/8383/8484, ws 8182/8283/8384/8485).
    "connect-src 'self' wss://localhost:* ws://localhost:* wss://127.0.0.1:* ws://127.0.0.1:* wss://localhost.qz.io:* ws://localhost.qz.io:*",
    "frame-src 'self' about: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join("; ");

  async function handler(req, res) {
    const url = new URL(req.url, "http://x");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (url.pathname.startsWith("/api/")) {
        res.setHeader("Cache-Control", "no-store");
        const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
        if (!r) throw new HttpError(404, "Not found.");
        // CSRF defence: state-changing API calls must be JSON (forms cannot send that cross-site).
        if (req.method !== "GET" && !String(req.headers["content-type"] || "").startsWith("application/json")) throw new HttpError(415, "JSON body required.");
        let body = {};
        if (req.method !== "GET") {
          const chunks = [];
          let size = 0;
          for await (const c of req) { size += c.length; if (size > 1_000_000) throw new HttpError(413, "Request too large."); chunks.push(c); }
          const raw = Buffer.concat(chunks).toString("utf8");
          try { body = raw ? JSON.parse(raw) : {}; } catch { throw bad("Invalid JSON."); }
          if (!body || typeof body !== "object") body = {};
        }
        const user = sessionUser(req);
        if (r.access && !user) throw new HttpError(401, "Please sign in.");
        if (r.access === "admin" && user.role !== "admin") throw new HttpError(403, "Administrator access is required.");
        const params = r.re.exec(url.pathname).groups || {};
        const out = await r.handler({ req, res, user, body, params, query: Object.fromEntries(url.searchParams) });
        if (out !== undefined && !res.headersSent) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(out)); }
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
      res.setHeader("Content-Security-Policy", CSP);
      if (!serveStatic(req, res, url.pathname)) {
        // Single-page app: unknown paths load the app shell.
        if (!serveStatic(req, res, "/")) throw new HttpError(404, "Not found.");
      }
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) log("[error]", e);
      if (!res.headersSent) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: status === 500 ? "Server error: " + e.message : e.message })); }
      else res.end();
    }
  }

  function listen(port, host) {
    const tlsKey = options.tlsKey && readIf(options.tlsKey);
    const tlsCert = options.tlsCert && readIf(options.tlsCert);
    const server = tlsKey && tlsCert ? https.createServer({ key: tlsKey, cert: tlsCert }, handler) : http.createServer(handler);
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
  }

  return { db, handler, listen, get setupToken() { return setupToken; } };
}
