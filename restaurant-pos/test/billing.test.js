import test from "node:test";
import assert from "node:assert/strict";
import { computeTotals, divRoundHalfUp, parseAmount, parseQty, formatAmount, formatQty, grossToNetCents, lineTaxCents } from "../shared/money.js";
import { layoutReceipt, sampleReferenceReceipt, SAMPLE_RECEIPT_SOURCE, encodeEscPos, buildReceiptFromTransaction, receiptDocumentHtml, toReceiptAscii } from "../shared/receipt.js";

const sampleTotals = () => computeTotals(SAMPLE_RECEIPT_SOURCE.items.map((i) => ({ ...i, taxRateBp: 1500 })));

test("sample receipt totals are reproduced exactly", () => {
  const t = sampleTotals();
  assert.deepEqual(t.lines.map((l) => l.amountCents), [278260, 5218, 6957, 6087]);
  assert.equal(t.netCents, 296522); // TXBL 1(15%) *2965.22
  assert.equal(t.taxCents, 44479); // TAX 1(15%) *444.79
  assert.equal(t.totalCents, 341001); // TOTAL / CASH *3410.01
  assert.equal(t.itemCount, 4); // ITEM: 4 (lines, not units)
  assert.equal(t.taxGroups.length, 1);
  assert.equal(t.taxGroups[0].index, 1);
});

test("VAT is rounded per line, not on the subtotal", () => {
  const t = sampleTotals();
  assert.deepEqual(t.lines.map((l) => l.taxCents), [41739, 783, 1044, 913]);
  assert.equal(lineTaxCents(t.netCents, 1500), 44478); // the subtotal method would differ by one cent
  assert.notEqual(lineTaxCents(t.netCents, 1500), t.taxCents);
});

test("integer arithmetic and rounding", () => {
  assert.equal(divRoundHalfUp(5, 2), 3);
  assert.equal(divRoundHalfUp(4, 2), 2);
  assert.equal(divRoundHalfUp(14999, 10000), 1);
  assert.equal(divRoundHalfUp(15000, 10000), 2);
  // 0.1 + 0.2 style float errors cannot occur
  const t = computeTotals([{ unitPriceCents: 10, qtyMilli: 1000, taxRateBp: 1500 }, { unitPriceCents: 20, qtyMilli: 1000, taxRateBp: 1500 }]);
  assert.equal(t.netCents, 30);
  // weighed quantity: 0.750 kg x 2782.60 = 2086.95
  assert.equal(computeTotals([{ unitPriceCents: 278260, qtyMilli: 750, taxRateBp: 1500 }]).netCents, 208695);
});

test("parsing and formatting", () => {
  assert.equal(parseAmount("2782.6"), 278260);
  assert.equal(parseAmount("2,782.60"), 278260);
  assert.equal(parseAmount("0.005"), null); // would silently truncate
  assert.equal(parseAmount("abc"), null);
  assert.equal(parseAmount("-1"), null);
  assert.equal(parseQty("1"), 1000);
  assert.equal(parseQty("0.75"), 750);
  assert.equal(formatAmount(5218), "52.18");
  assert.equal(formatAmount(5), "0.05");
  assert.equal(formatQty(1000, "kg"), "1.000kg");
  assert.equal(formatQty(2000, "pcs"), "2");
  assert.equal(formatQty(1500, "pcs"), "1.5");
  assert.equal(grossToNetCents(3000, 1500), 2609);
  assert.equal(grossToNetCents(8000, 1500), 6957);
  assert.equal(grossToNetCents(7000, 1500), 6087);
});

test("reference layout matches the scanned receipt line by line (32 columns)", () => {
  const lines = layoutReceipt(sampleReferenceReceipt(sampleTotals()), 32).map((l) => l.text.trimEnd());
  const expected = [
    "         TIN:0038779012",
    "       HAILU BEYENE MINDA",
    "       RESTAURANT SERVICE",
    "    HAWASSA S.C MENAL KETEMA",
    "      K.ADDIS ABEBA H.NO.",
    "TEL.0912061331E.MOB140010169008",
    "",
    "            INVOICE",
    "FS No.:                 00000594",
    "DATE:25/08/2026    TIME:15:08:00",
    "Buyer's TIN:          0003168982",
    "Buyer's NAME:               IASD",
    "",
    "1k tibs2",
    "1.000kg x 2782.60       *2782.60",
    "Mabaya",
    "2 x 26.09                 *52.18",
    "2  Liter water",
    "1 x 69.57                 *69.57",
    "Sofet derink",
    "1 x 60.87                 *60.87",
    "-".repeat(32),
    "TXBL 1(15%)             *2965.22",
    "TAX 1(15%)               *444.79",
    "-".repeat(32),
    "TOTAL                   *3410.01",
    "CASH                    *3410.01",
    "ITEM:                          4",
    "",
    "              ERCA",
    "          CNA0023020",
    "   SUPLIED BY JUPITER TRADING",
    "         TEL.0462209771",
    "     SALES WITH CONFIDENCE",
  ];
  assert.deepEqual(lines, expected);
});

test("no line exceeds the configured width; long text wraps instead of clipping", () => {
  const t = sampleTotals();
  for (const cols of [24, 32, 42, 48]) {
    const r = sampleReferenceReceipt(t);
    r.lines[0].name = "A very long dish name that certainly does not fit on one receipt line";
    for (const l of layoutReceipt(r, cols)) assert.ok(l.text.length <= cols, `${cols}: "${l.text}"`);
  }
});

const fakeTx = (over = {}) => {
  const t = sampleTotals();
  return {
    id: 1, receiptNo: 17, receiptDate: "07/10/2026", receiptTime: "12:00:00", buyerTin: "", buyerName: "", status: "completed",
    lines: t.lines, taxGroups: t.taxGroups, totalCents: t.totalCents, paymentLabel: "CASH", tenderedCents: 350000, changeCents: 350000 - t.totalCents,
    receiptSnapshot: { tin: "0038779012", headerLines: ["HAILU BEYENE MINDA"], heading: "INVOICE", numberLabel: "RCPT No.:", footerLines: ["THANK YOU"] },
    ...over,
  };
};

test("app receipts: own number, non-fiscal footer, COPY marking, change line", () => {
  const text = layoutReceipt(buildReceiptFromTransaction(fakeTx()), 32).map((l) => l.text);
  assert.ok(text.includes("RCPT No.:               00000017"));
  assert.ok(!text.some((l) => l.includes("ERCA")));
  assert.ok(text.some((l) => l.trim() === "NON-FISCAL RECEIPT"));
  assert.ok(text.includes("CASH                    *3500.00"));
  assert.ok(text.includes("CHANGE                    *89.99"));
  assert.ok(!text.some((l) => l.includes("COPY")));
  const copy = layoutReceipt(buildReceiptFromTransaction(fakeTx(), { copy: true }), 32).map((l) => l.text.trim());
  assert.ok(copy.includes("*** COPY ***"));
  const fs = layoutReceipt(buildReceiptFromTransaction(fakeTx({ fiscalFsNo: "00000595" })), 32).map((l) => l.text);
  assert.ok(fs.includes("FS No.:                 00000595"));
});

test("ESC/POS output: init, bold, ASCII only, feed and cut", () => {
  const lines = layoutReceipt(buildReceiptFromTransaction(fakeTx()), 32);
  const b = encodeEscPos(lines, { feedLines: 3 });
  assert.deepEqual([...b.slice(0, 2)], [0x1b, 0x40]);
  assert.deepEqual([...b.slice(-4)], [0x1d, 0x56, 0x42, 0x00]);
  const s = Buffer.from(b).toString("latin1");
  assert.ok(s.includes("\x1bE\x01" + "            INVOICE\n")); // bold heading
  assert.ok(s.includes("\x1bd\x03"));
  for (const byte of b) assert.ok(byte < 0x80, "only 7-bit bytes are sent");
  assert.equal(toReceiptAscii("ጥብስ Tibs"), "??? Tibs");
  const noCut = encodeEscPos(lines, { cut: false });
  assert.notDeepEqual([...noCut.slice(-4)], [0x1d, 0x56, 0x42, 0x00]);
});

test("HTML receipt document is self-contained and sized to the paper", () => {
  const html = receiptDocumentHtml(layoutReceipt(buildReceiptFromTransaction(fakeTx()), 32), { paperWidthMm: 58, printableWidthMm: 48, charsPerLine: 32 });
  assert.match(html, /@page \{ size: 58mm auto; margin: 0; \}/);
  assert.match(html, /width:48mm/);
  assert.ok(!/<script/i.test(html));
});
