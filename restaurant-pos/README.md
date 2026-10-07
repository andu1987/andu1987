# Restaurant POS — Hailu Beyene Minda Restaurant Service

A restaurant management and point-of-sale web application with QZ Tray receipt printing.
It is built from two references:

* **Attachment 1:** the restaurant's receipt (FS No. 00000594, 25/08/2026). Business details, receipt layout and billing rules come from it.
* **Attachment 2:** the Yejoka/Welkite hotel website. The look (colours, typefaces, cards, top bar) and the idea of a QZ printer page come from it. Its code was not reused (see "What changed from the hotel site").

## Two editions

| | **Single file** — `restaurant-pos-standalone.html` | **Server edition** — `npm start` |
|---|---|---|
| How to open | Double-click the file (Chrome or Edge), like the hotel file | Run the server, open `http://localhost:3000` |
| Needs | Nothing (React and QZ Tray library are inside the file; works offline) | Node.js 22.13+ |
| Where sales are stored | In this browser on this computer (IndexedDB) | One database on the server, shared by all devices |
| Several cashier computers | No: each computer has its own separate records | Yes |
| Backup | Atelier → Download backup / Restore (JSON file) | Settings → database backup |
| Silent QZ printing | Paste QZ Site Manager certificate + key in The Press (stored only on that computer) | Key stays on the server |

Both use the same receipt layout and VAT code (`shared/`), which is covered by `npm test`.

### Single-file edition: quick start
1. Copy `restaurant-pos-standalone.html` to the cashier computer, for example to `C:\Restaurant\`. Double-click it to open it in Chrome or Edge. Always open the **same file in the same browser**, because the data belongs to that browser.
2. On first open, create the administrator (name, username, password). No password is built into the file.
3. **Atelier:** check the restaurant particulars, add cashiers, and set up the tables.
4. **Bill of Fare:** edit the menu. Prices are entered before VAT, as on the receipt; the screen also shows the price including VAT.
5. **The Press:**
   * Install QZ Tray (<https://qz.io/download>), then press Reconnect and Detect QZ Printers. Select your printer, set 58 or 80 mm, then Save Settings and Test Print.
   * For printing **without "Allow" pop-ups**, as administrator: in QZ Tray go to Advanced → Site Manager → **+** → Create New, and answer Yes to all. Paste the two files from the "QZ Tray Demo Cert" desktop folder into "Silent printing", then press Save signing.
6. Every day: **Atelier → Download backup**, and keep the file on a USB drive. If the browser data is cleared, use Restore from backup.

Pages use the hotel file's naming:
* Salon: dashboard
* Service: orders and payment
* Ledger: all sales, receipts and reprints
* Bill of Fare: menu
* Reports
* The Press: printer
* Atelier: settings

To rebuild the file after editing `standalone/app.jsx` or `shared/*.js`, run `npm i --no-save @babel/standalone && npm run build:standalone`.
Test it with `node test/standalone.e2e.mjs`, which opens the file from disk. Add `QZ=real` to use a real QZ Tray.

## Contents
1. [Install and start](#1-install-and-start)
2. [Administrator setup](#2-administrator-setup)
3. [QZ Tray: connection and printer setup](#3-qz-tray-connection-and-printer-setup)
4. [Daily use](#4-daily-use)
5. [Receipts, VAT and the fiscal register](#5-receipts-vat-and-the-fiscal-register)
6. [Data storage, backup and restore](#6-data-storage-backup-and-restore)
7. [Testing](#7-testing)
8. [Measurements still needed](#8-measurements-still-needed)
9. [What changed from the hotel site](#9-what-changed-from-the-hotel-site)

---

## 1. Install and start

**Requirements:** Node.js **22.13 or newer** (24 LTS recommended) from <https://nodejs.org>. There are no other dependencies and no `npm install` step. The database is Node's built-in SQLite.

```bash
cd restaurant-pos
npm start
```

The server prints:

```
FIRST-RUN SETUP: ... setup code: 7F3A9C21B0
Restaurant POS running. Database: .../data/restaurant.db
  On this computer:  http://localhost:3000
  On the network:    http://192.168.1.20:3000
```

Open `http://localhost:3000` on the server computer.

Environment options:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Port to listen on |
| `HOST` | 0.0.0.0 | `127.0.0.1` allows only this computer |
| `DATA_DIR` | `./data` | Where the database, setup code and QZ keys live |
| `TLS_CERT`, `TLS_KEY` | (unset) | PEM files. When both are set, the app is served over HTTPS |

On Windows you can create a shortcut that runs `cmd /k "cd C:\restaurant-pos && npm start"`. You can also run it as a service with a tool such as NSSM, so it starts with the computer.

### Single-file version
`public/restaurant-pos.html` contains the whole interface in one HTML file: styles, scripts and the QZ Tray library. It is the same app, so it still needs the server for data. Start the server and open `http://localhost:3000/restaurant-pos.html`. If you open the file directly (double-click), it shows "Start the server first", because sales must be saved in the shared database, not in the browser. After changing any source file, rebuild it with `npm run build:html`.

### One computer or several?
* **One cashier computer:** run the server on it and use `http://localhost:3000`. QZ Tray then works without any extra browser settings.
* **Several computers** (cashier, manager, kitchen tablet): run the server on one computer. All devices then share the **same database**, so orders, sales and receipt numbers are shared. Each computer that prints needs its own QZ Tray and printer selection.
  Chrome/Edge 147+ do not let a plain `http://192.168.x.x` page talk to QZ Tray on `localhost` (Local Network Access rules). Serve the app over HTTPS instead:
  ```bash
  sh tools/make-tls-cert.sh 192.168.1.20        # the server computer's IP
  TLS_CERT=data/tls/server-cert.pem TLS_KEY=data/tls/server-key.pem npm start
  ```
  Then install `data/tls/server-cert.pem` as a trusted root certificate on each client. On Windows: double-click it, choose Install Certificate, Local Machine, "Trusted Root Certification Authorities". Browse to `https://192.168.1.20:3000`.

## 2. Administrator setup

1. On first start, no users exist. The server window shows a one-time **setup code**, which is also saved in `data/SETUP-TOKEN.txt`.
2. Open the app. Enter the setup code, the administrator's name, username and password (8 or more characters), then press **Create administrator**. The setup code is deleted once it has been used.
3. Go to **Settings**:
   * Check the business header lines (transcribed from the receipt; see §5).
   * Under **Users**, add each cashier with their own username and password.
   * Under **Tables**, adjust the table list (10 tables are created to start).
4. Go to **Menu**: edit or replace the four starter items (taken from the sample receipt) and add your full menu.
5. Go to **Printer** on each cashier computer (see §3).

No password is stored in the source code. Passwords are kept as scrypt hashes, and sessions use HttpOnly, SameSite=Strict cookies that expire after 12 hours. After 5 failed sign-ins, that user is locked out for 5 minutes.

**Forgotten admin password** (run on the server computer):
```bash
npm run users                        # list accounts
npm run reset-password -- owner      # prints a new random password for "owner"
```

### Roles
| | Administrator | Cashier |
|---|---|---|
| Orders, payments, receipts, transactions | ✓ | ✓ |
| Mark menu items sold out / available | ✓ | ✓ |
| Printer setup on their computer | ✓ | ✓ |
| Reprint (always marked COPY, reason recorded) | ✓ | ✓ (admin can switch this off) |
| Cancel an order already sent to the kitchen | ✓ | – (only orders still "open") |
| Void a sale, change a recorded FS No. | ✓ | – |
| Menu prices and categories, reports, exports, backups, settings, users | ✓ | – |

## 3. QZ Tray: connection and printer setup

QZ Tray is a free desktop program that lets the web page send print jobs straight to a local or network printer. It does this without the browser's print dialog.

### 3.1 Install
1. Download QZ Tray from <https://qz.io/download> and install it on **each computer that prints**. Use version 2.2.x or newer. QZ Tray includes its own Java.
2. Start it. A QZ icon appears in the system tray. It starts automatically with Windows.

### 3.2 Connect and choose the printer (in the app)
1. Install the receipt printer's Windows driver, or the "Generic / Text Only" driver, and print a Windows test page.
2. In the app, open **Printer** and press **Connect**. The status should turn green: "QZ Tray connected".
   * Chrome/Edge 147+ may ask to let the site "access other apps and services on this device". Choose **Allow**.
   * QZ Tray may ask whether to allow the site. Choose **Allow**. See §3.4 to stop this prompt.
3. Press **Find printers**, choose the receipt printer, then press **Save**.
   For an **Ethernet/Wi-Fi printer**, press **Network printer (IP)…** and enter, for example, `192.168.1.50:9100`.
4. Choose **Paper roll** (58 mm or 80 mm) and check **Characters per line**. Press **Test print**.
   The test page has a `1234567890…` ruler, which must fit on **one** line. If it wraps, lower Characters per line.
5. Open **Printer → Receipt layout check (sample)** and press **Test-print sample**. Compare the printout with the original receipt.

Printer choice and paper settings are saved **per computer** (in that browser), because each computer has its own printer.

### 3.3 Print methods
| Method | Use when | Notes |
|---|---|---|
| **Raw ESC/POS** (default) | Thermal receipt printers (Epson TM, Xprinter, Rongta, SPRT and similar) | Sends the exact bytes: printer font, bold, feed, cut, optional cash-drawer kick. Fastest and sharpest. Text must be Latin letters. Amharic prints as `?`. The menu editor warns about this. |
| **HTML / pixel** | Printers without ESC/POS (laser/inkjet), or when Amharic must print | QZ Tray renders the same receipt as an image. Set the paper and printable width correctly. |
| Browser print (**fallback only**) | QZ Tray unavailable in an emergency | Uses the browser's print dialog, **not** QZ Tray. It prints only the receipt (hidden frame, `@page` sized to the roll) and asks whether it printed. |

### 3.4 Signing (removes the "Allow" prompts)
Without a signing certificate, QZ Tray shows an "untrusted website" prompt that someone must allow. To print silently:

* **Free, per computer:** in QZ Tray, open **Advanced → Site Manager**, click **+**, then **Create New**. Answer **Yes** to all three questions (create, install, copy to `override.crt`). A `QZ Tray Demo Cert` folder appears on the desktop. Copy its `digital-certificate.txt` and `private-key.pem` into the server's **`data/qz/`** folder. If you have several cashier computers, repeat the Site Manager step on each one. This trusts the same certificate: use **Site Manager → +** and choose that `digital-certificate.txt`, or add it to each computer's `override.crt`.
* **Commercial certificate:** buy a QZ Tray support plan and generate the certificate and key in the qz.io portal. Place both files in `data/qz/`. This is trusted by every QZ Tray install without per-computer steps.

The **private key stays on the server**. Browsers get a signature from `POST /api/qz/sign`, which only signed-in staff can use, and the certificate from `GET /api/qz/certificate`. Signatures are SHA512 RSA, as required by QZ Tray 2.1+. Another location can be set with `QZ_PRIVATE_KEY` and `QZ_CERTIFICATE`. **Settings → QZ Tray signing** shows whether keys are installed.

QZ Tray licensing: QZ Tray is free open-source software (LGPL 2.1). Silent printing on many computers without per-computer steps needs a paid certificate from QZ Industries.

### 3.5 Recovery (also shown on the Printer page)
| Symptom | Fix |
|---|---|
| "QZ Tray is not reachable" | Start QZ Tray (Start menu → QZ Tray), then press Connect. Check that no firewall blocks ports 8181/8182. |
| Connection blocked by the browser | Padlock icon → Site settings → Local network access → Allow, then reload. On LAN setups, use HTTPS (§1). |
| "Request was blocked in QZ Tray" | Press Connect again and choose Allow. Install signing keys (§3.4). |
| "Selected printer was not found" | Turn the printer on and check the cable or driver. Then Find printers → Save. |
| "Network printer did not answer" | Check the printer's IP and port (print its self-test page) and that it is on the same network. |
| Lines wrap or are cut off | Lower Characters per line (32 for 58 mm, 48 or 42 for 80 mm). |
| Too much blank paper | Lower "Feed lines before cut". |

**A failed print never loses or duplicates a sale.** The sale is saved first. Open it from the receipt window or **Transactions** and press **Print** again. A retry after a failed print is still the original. Once a receipt has printed, every later print is marked `*** COPY ***` and needs a reason, which is recorded.

## 4. Daily use

* **Dashboard:** today's sales (incl. VAT), completed transactions, unpaid orders, occupied tables, the table map (tap a free table to start an order) and recent sales. It warns if any sale today has not printed.
* **Orders:**
  * Start a dine-in order (choose a table) or a takeaway order.
  * Tap menu items to add them. Weighed (kg) items ask for the weight.
  * Change quantities with − / + or by typing. Add a kitchen note per line, or remove a line. Add an order note.
  * States: **open → submitted (sent to kitchen) → ready → paid**, or **cancelled** with a reason. Orders can be moved to another table or switched to takeaway.
* **Bill & pay:**
  * Shows TXBL / TAX / TOTAL. Choose Cash (amount received, change shown), Card, Mobile money or Bank transfer (reference).
  * Buyer's TIN and name are optional and printed as on the sample.
  * Confirming saves the sale with the next receipt number. The receipt then prints automatically (switchable in Settings).
  * Pressing Confirm twice, or again after a network error, returns the same sale.
* **Transactions:** search by date range, receipt number, FS No., item, buyer, cashier or table. Filter by status or payment. Open any sale to preview, print or reprint (COPY), or record the fiscal register's FS No.; administrators can also void it.
* **Menu:** categories, items, net price, VAT rate, unit (pcs or kg), receipt text and availability. Removing an item archives it, so past sales keep their data.
* **Reports** (admin): totals, net, VAT, count and voids for any period, broken down by day, payment method, item and cashier. CSV export of transactions and of item lines (opens in Excel).

## 5. Receipts, VAT and the fiscal register

### What was read from the receipt
| Kind | Content |
|---|---|
| **Fixed business info** (default receipt header, editable in Settings) | `TIN:0038779012` · `HAILU BEYENE MINDA` · `RESTAURANT SERVICE` · `HAWASSA S.C MENAL KETEMA` · `K.ADDIS ABEBA H.NO.` · `TEL.0912061331E.MOB140010169008` |
| **Fixed layout** | `INVOICE` heading (bold) · number row · `DATE:dd/mm/yyyy` + `TIME:hh:mm:ss` row · `Buyer's TIN:` / `Buyer's NAME:` · per item a name line then `qty x price ... *amount` (kg items as `1.000kg`) · dashed rule · `TXBL 1(15%)` / `TAX 1(15%)` · dashed rule · bold `TOTAL` · payment line (`CASH`) · `ITEM:` count · centred footer |
| **Per sale** | Number, date, time, buyer TIN/name, items, quantities, prices, totals, payment |
| **Sample only** (used for checks, never for new sales) | FS No. `00000594`, 25/08/2026 15:08:00, buyer `0003168982` / `IASD`, the four items |
| **Fiscal device / supplier** | `ERCA`, logo, `CNA0023020` (machine registration number), `SUPLIED BY JUPITER TRADING`, `TEL.0462209771`, `SALES WITH CONFIDENCE` |

Readability notes:
* The trade-name line is damaged between "S" and "VICE". **"SERVICE"** is the evident reading.
* `TEL.0912061331E.MOB140010169008` is transcribed exactly as printed, although it looks garbled. Correct it in Settings if needed.

### Calculation rules established from the sample
* Unit prices on the receipt are **net (VAT-exclusive)**: 2782.60 + 52.18 + 69.57 + 60.87 = **2965.22** = TXBL.
* **VAT 15% is rounded per line**, then summed: 417.39 + 7.83 + 10.44 + 9.13 = **444.79**. Calculating 15% of the subtotal would give 444.78, which does not match.
* TOTAL = TXBL + TAX = **3410.01**. No service charge, discount or cash rounding appears, so none is applied.
* `ITEM: 4` counts receipt lines, not units (units total 5).

All money is integer cents. Weights are integer grams (3 decimals). There is no floating-point arithmetic. The server recomputes every total at payment and stores each sale's lines, prices, VAT, payment, timestamp and a snapshot of the header text. Editing the menu or settings later never changes past receipts.

**Prices and VAT, an ambiguity to confirm:**
* Three sample prices match round(price incl. VAT ÷ 1.15): 30 → 26.09, 80 → 69.57, 70 → 60.87.
* Tibs does not: 3200 ÷ 1.15 = 2782.61, but the receipt shows **2782.60**.
* So the register stores net prices directly, and the app does the same: the **net price you enter is authoritative**. The menu editor has a helper that calculates net from a VAT-inclusive price; check its result.
* Customers pay 3410.01, not a round 3410.

### Fiscal receipts
The FS number and the ERCA/MRC block are produced by the restaurant's ERCA-registered fiscal cash register (supplied by Jupiter Trading). There is **no supported public integration** for this application to obtain FS numbers from that device, and a web app must not imitate a fiscal receipt. Therefore:

* The app prints its **own receipt number**, labelled `RCPT No.:` by default (unique, sequential and never reused, even for voided sales).
* The footer always prints **`NON-FISCAL RECEIPT`** where the ERCA block was, followed by your own footer lines (default "THANK YOU").
* The ERCA logo, machine number and supplier lines are **not** printed. They appear only in the on-screen *reference* reproduction on the **Receipt layout check** page.
* After the fiscal register prints the legal receipt, record its FS No. on the sale (**Record FS No.**). It is then printed as an extra `FS No.:` row and is searchable.
* If the register supplier (Jupiter Trading) provides a documented PC interface (for example, a serial or USB protocol for the sales register), it can be added later. That is the only proper way to automate fiscal numbering.

**Paper width.** The sample's longest line is 31 characters, and the dashed rule fills about 32. That matches a **58 mm roll at 32 characters per line**, which is the default. The physical width cannot be measured reliably from the scan, so see §8.

## 6. Data storage, backup and restore

* All records live in **one SQLite database on the server computer**: `data/restaurant.db` (WAL mode, `synchronous=FULL`). Every connected device reads and writes the same data. Records survive page refreshes, browser restarts and server restarts.
* Printer selection and paper settings are stored per browser (see §3).
* **Backups** (admin, Settings → Backup & export):
  * **Download database backup** gives a consistent `.db` copy made while the app is running.
  * **Export everything (JSON)** gives a readable export of all tables, without password hashes.
  * From the command line, `npm run backup` writes `data/backups/restaurant-<time>.db`. You can schedule this daily with Windows Task Scheduler.
* **Restore:** stop the server, replace `data/restaurant.db` with the backup file (delete any `restaurant.db-wal` and `restaurant.db-shm` next to it), then start the server.
* Keep copies off the server computer (USB drive or cloud folder). The `data/` folder is excluded from git.

## 7. Testing

```bash
npm test     # 20 tests: billing maths, receipt layout, ESC/POS bytes, full API workflow, persistence, QZ signing
```

Browser workflow (Playwright + Chromium), driving the real UI end to end:

```bash
npm i -D playwright && npx playwright install chromium
node test/browser.e2e.mjs                       # with a recording stand-in for QZ Tray
QZ=real NET_PRINTER=192.168.1.50:9100 node test/browser.e2e.mjs   # with the real QZ Tray on this computer
```

**Testing on your computer with the real printer:**
1. Install QZ Tray and the printer (§3.1). Run `npm start` and open `http://localhost:3000`.
2. Printer page: Connect → Find printers → select → Save → **Test print**. Check that the ruler fits on one line.
3. Receipt layout check page → **Test-print sample**. Lay it beside the original receipt and compare the columns, bold lines and spacing. Adjust Characters per line or Paper width if needed.
4. Make a test order and pay it. The receipt prints automatically. Reprint it and check that it says `*** COPY ***`.
5. Unplug the printer or close QZ Tray, then pay another order. You should see "Print failed… The sale is saved". Reconnect, press Print, and check that **Transactions** shows only one sale.
6. Void the test sales (admin) or start from an empty database before going live. To start empty, stop the server and move `data/restaurant.db*` away.

## 8. Measurements still needed

To match the original exactly, please measure from the receipt or the printer's specification:
1. **Paper roll width**: 58 mm or 80 mm. A ruler across the original receipt is enough.
2. **Characters per line** of the printer's Font A: print the test page and see where the ruler wraps.
3. **Printable width in mm**, only for HTML/pixel mode: about 48 mm on 58 mm printers and 72 mm on 80 mm printers. It is in the printer manual.
4. The **printer model**, so ESC/POS support can be confirmed: whether it has a cutter, a drawer port and a code page.

## 9. What changed from the hotel site

The hotel site's code was inspected and **not reused**, because it could not keep reliable or lawful records:
* Sales were kept only in page memory, so they were lost on refresh.
* User passwords were hard-coded in the page source and shown on the login screen.
* An "FS" number counter was **seeded to an arbitrary value** (156733) in the browser.
* Every receipt printed a **fixed date (03/09/2026)** regardless of the real date, and the reprint screen allowed **editing the printed date and time**.
* It printed an **ERCA mark and machine number**.
* QZ security was set to resolve with no certificate. A failed print downloaded a `.bin` file instead of keeping a retryable record.

None of those behaviours are carried over. Kept from the hotel site: the palette, typefaces, card and button styles, top-bar navigation with printer status, and the idea of a printer page with a test print and a reprint log. These were reimplemented with persistent storage, signing and logged print jobs.

## Project layout
```
server/      index.js (start), app.js (API, static files, QZ signing), db.js (schema), auth.js
shared/      money.js (VAT/rounding), receipt.js (receipt layout, ESC/POS, HTML) – used by server and browser
public/      index.html, restaurant-pos.html (single-file build), css/, js/ (app, qz, printing, api, ui), vendor/ (qz-tray.js 2.3.0, qz-lna)
tools/       admin.js (users, password reset, backup), make-tls-cert.sh, build-single-html.mjs
test/        billing.test.js, api.test.js, browser.e2e.mjs
data/        (created at runtime, not in git) restaurant.db, qz/ keys, tls/
```
