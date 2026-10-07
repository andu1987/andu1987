// SQLite storage (built-in node:sqlite, no native add-ons to compile).
// One database file on the server computer is shared by every browser on the network.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','cashier')),
  pw_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'food' CHECK (kind IN ('food','beverage','other')),
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  receipt_name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'pcs' CHECK (unit IN ('pcs','kg')),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  tax_rate_bp INTEGER NOT NULL DEFAULT 1500 CHECK (tax_rate_bp >= 0 AND tax_rate_bp <= 10000),
  available INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dining_tables (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  seats INTEGER NOT NULL DEFAULT 4,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  order_type TEXT NOT NULL CHECK (order_type IN ('dine_in','takeaway')),
  table_id INTEGER REFERENCES dining_tables(id),
  status TEXT NOT NULL CHECK (status IN ('open','submitted','ready','paid','cancelled')),
  note TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancelled_by INTEGER REFERENCES users(id),
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  menu_item_id INTEGER REFERENCES menu_items(id),
  name TEXT NOT NULL,
  receipt_name TEXT NOT NULL,
  unit TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  tax_rate_bp INTEGER NOT NULL,
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS order_items_order ON order_items(order_id);

-- A completed sale. Rows are never deleted; voiding keeps the row and its receipt number.
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  receipt_no INTEGER NOT NULL UNIQUE,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  receipt_date TEXT NOT NULL,
  receipt_time TEXT NOT NULL,
  cashier_id INTEGER NOT NULL REFERENCES users(id),
  cashier_name TEXT NOT NULL,
  order_type TEXT NOT NULL,
  table_label TEXT,
  buyer_tin TEXT NOT NULL DEFAULT '',
  buyer_name TEXT NOT NULL DEFAULT '',
  net_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  payment_method TEXT NOT NULL,
  payment_label TEXT NOT NULL,
  tendered_cents INTEGER NOT NULL,
  change_cents INTEGER NOT NULL,
  payment_ref TEXT NOT NULL DEFAULT '',
  lines_json TEXT NOT NULL,
  tax_groups_json TEXT NOT NULL,
  receipt_snapshot_json TEXT NOT NULL,
  fiscal_fs_no TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
  void_reason TEXT,
  voided_by INTEGER REFERENCES users(id),
  voided_at TEXT
);
CREATE INDEX IF NOT EXISTS transactions_date ON transactions(local_date);

CREATE TABLE IF NOT EXISTS print_jobs (
  id INTEGER PRIMARY KEY,
  transaction_id INTEGER REFERENCES transactions(id),
  kind TEXT NOT NULL CHECK (kind IN ('original','copy','test')),
  status TEXT NOT NULL CHECK (status IN ('pending','sent','failed')),
  printer TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL REFERENCES users(id),
  user_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS print_jobs_tx ON print_jobs(transaction_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  user_id INTEGER,
  user_name TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
`;

// Business details below are transcribed from the supplied receipt and can be edited in Settings.
// "RESTAURANT SERVICE": the scan is damaged between "S" and "VICE"; "SERVICE" is the evident reading.
export const DEFAULT_SETTINGS = {
  business: {
    tin: "0038779012",
    headerLines: ["HAILU BEYENE MINDA", "RESTAURANT SERVICE", "HAWASSA S.C MENAL KETEMA", "K.ADDIS ABEBA H.NO.", "TEL.0912061331E.MOB140010169008"],
    displayName: "Hailu Beyene Minda Restaurant",
  },
  receipt: {
    heading: "INVOICE",
    numberLabel: "RCPT No.:",
    footerLines: ["THANK YOU"],
    printOrderInfo: false,
  },
  tax: { defaultRateBp: 1500 },
  timezone: "Africa/Addis_Ababa",
  currency: "ETB",
  autoPrint: true,
  cashierCanReprint: true,
  paymentMethods: [
    { id: "cash", label: "CASH", enabled: true },
    { id: "card", label: "CARD", enabled: true },
    { id: "mobile", label: "MOBILE MONEY", enabled: true },
    { id: "transfer", label: "BANK TRANSFER", enabled: true },
  ],
  nextReceiptNo: 1,
};

export function openDatabase(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
  db.exec(SCHEMA);
  const ver = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (!ver) db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
  const ins = db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)");
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, JSON.stringify(v));
  seedStarterData(db);
  return db;
}

// Starter categories, tables and the four items from the sample receipt (with their receipt prices),
// inserted only into an empty database so the administrator has something to edit.
function seedStarterData(db) {
  if (db.prepare("SELECT COUNT(*) n FROM categories").get().n > 0) return;
  const now = new Date().toISOString();
  const cat = db.prepare("INSERT INTO categories(name,kind,sort) VALUES(?,?,?)");
  const food = cat.run("Food", "food", 1).lastInsertRowid;
  const drinks = cat.run("Beverages", "beverage", 2).lastInsertRowid;
  const item = db.prepare("INSERT INTO menu_items(category_id,name,receipt_name,unit,price_cents,tax_rate_bp,sort,updated_at) VALUES(?,?,?,?,?,1500,?,?)");
  item.run(food, "Tibs (per kg)", "1k tibs2", "kg", 278260, 1, now);
  item.run(food, "Mabaya", "Mabaya", "pcs", 2609, 2, now);
  item.run(drinks, "Water 2 L", "2  Liter water", "pcs", 6957, 1, now);
  item.run(drinks, "Soft drink", "Sofet derink", "pcs", 6087, 2, now);
  const t = db.prepare("INSERT OR IGNORE INTO dining_tables(label,seats) VALUES(?,4)");
  for (let i = 1; i <= 10; i++) t.run(String(i));
}

export function getSettings(db) {
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const row of db.prepare("SELECT key, value FROM settings").all()) {
    try { out[row.key] = JSON.parse(row.value); } catch { /* keep default */ }
  }
  return out;
}

export function setSetting(db, key, value) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
}

// Run fn inside BEGIN IMMEDIATE so concurrent requests cannot interleave writes.
export function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}
