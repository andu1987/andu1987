// Administrator recovery tool (run on the server computer, with the server stopped or running):
//   node tools/admin.js list-users
//   node tools/admin.js reset-password <username>     prints a new random password
//   node tools/admin.js backup [file]                 consistent copy of the database
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../server/db.js";
import { hashPassword } from "../server/auth.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const db = openDatabase(path.join(dataDir, "restaurant.db"));
const [cmd, arg] = process.argv.slice(2);

if (cmd === "list-users") {
  console.table(db.prepare("SELECT id, username, name, role, active FROM users").all());
} else if (cmd === "reset-password" && arg) {
  const u = db.prepare("SELECT id FROM users WHERE username=?").get(arg.toLowerCase());
  if (!u) { console.error("No such user."); process.exit(1); }
  const pw = crypto.randomBytes(9).toString("base64url");
  db.prepare("UPDATE users SET pw_hash=?, active=1 WHERE id=?").run(hashPassword(pw), u.id);
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id);
  db.prepare("INSERT INTO audit_log(at,action,detail) VALUES(?,?,?)").run(new Date().toISOString(), "cli.reset_password", arg);
  console.log(`New password for ${arg}: ${pw}\nSign in and change it under your name (top right) > Change password.`);
} else if (cmd === "backup") {
  const out = path.resolve(arg || path.join(dataDir, "backups", `restaurant-${new Date().toISOString().replace(/[:.]/g, "-")}.db`));
  (await import("node:fs")).mkdirSync(path.dirname(out), { recursive: true });
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  console.log("Backup written to " + out);
} else {
  console.log("Usage: node tools/admin.js list-users | reset-password <username> | backup [file]");
}
db.close();
