// Start the restaurant POS server.
//   PORT (default 3000), HOST (default 0.0.0.0 = reachable from other computers on the network)
//   DATA_DIR (default ./data), TLS_CERT + TLS_KEY (optional, enables HTTPS)
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const tlsCert = process.env.TLS_CERT || null;
const tlsKey = process.env.TLS_KEY || null;
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";

const app = createApp({ dataDir, tlsCert, tlsKey, secureCookies: !!(tlsCert && tlsKey) });
const server = await app.listen(port, host);
const scheme = tlsCert && tlsKey ? "https" : "http";
console.log(`Restaurant POS running. Database: ${path.join(dataDir, "restaurant.db")}`);
console.log(`  On this computer:  ${scheme}://localhost:${port}`);
for (const addrs of Object.values(os.networkInterfaces())) {
  for (const a of addrs || []) if (a.family === "IPv4" && !a.internal) console.log(`  On the network:    ${scheme}://${a.address}:${port}`);
}
const stop = () => { server.close(); try { app.db.close(); } catch {} process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
