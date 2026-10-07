// Money and tax arithmetic shared by the server (authoritative) and the browser (live preview).
// All amounts are integer cents; quantities are integer thousandths ("milli") so that weighed
// items such as "1.000kg" are exact. No floating-point money arithmetic is used anywhere.
//
// Rules established from the sample receipt (FS No. 00000594, 25/08/2026):
//   * Unit prices on the receipt are tax-EXCLUSIVE (net). 2782.60 + 52.18 + 69.57 + 60.87 = 2965.22 = TXBL.
//   * Line amount = qty x unit price, rounded to the cent.
//   * VAT is calculated per line and rounded half-up per line, then summed:
//       417.39 + 7.83 + 10.44 + 9.13 = 444.79   (15% of the 2965.22 total would give 444.78)
//   * TOTAL = TXBL + TAX = 3410.01. No service charge, discount or cash rounding appears on the receipt.
//   * "ITEM: 4" counts receipt lines, not units (quantities sum to 5).

export const DEFAULT_TAX_RATE_BP = 1500; // 15.00 % expressed in basis points

// Integer division rounding half away from zero (amounts here are never negative in practice).
export function divRoundHalfUp(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError("divRoundHalfUp requires safe integers and a positive denominator");
  }
  const sign = numerator < 0 ? -1 : 1;
  const n = Math.abs(numerator);
  const q = Math.floor(n / denominator);
  const r = n - q * denominator;
  return sign * (r * 2 >= denominator ? q + 1 : q);
}

export function lineAmountCents(unitPriceCents, qtyMilli) {
  return divRoundHalfUp(unitPriceCents * qtyMilli, 1000);
}

export function lineTaxCents(amountCents, rateBp) {
  return divRoundHalfUp(amountCents * rateBp, 10000);
}

// Suggest a net unit price from a VAT-inclusive shelf price (round half-up). This is only a helper
// for the menu editor: the sample's 26.09 / 69.57 / 60.87 match 30 / 80 / 70 incl. VAT this way, but
// 2782.60 does not match 3200 (which gives 2782.61), so the register stores net prices directly and
// the net price saved on each menu item is authoritative. See README "Prices and VAT".
export function grossToNetCents(grossCents, rateBp) {
  return divRoundHalfUp(grossCents * 10000, 10000 + rateBp);
}

export function netToGrossCents(netCents, rateBp) {
  return netCents + lineTaxCents(netCents, rateBp);
}

// Parse a decimal string like "2782.6" / "2,782.60" into integer units of 10^-decimals without floats.
export function parseDecimal(input, decimals) {
  const s = String(input ?? "").trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) {
    // Reject silently-truncating input rather than guessing.
    if (/[^0]/.test(frac.slice(decimals))) return null;
  }
  const value = Number(whole) * 10 ** decimals + Number((frac + "0".repeat(decimals)).slice(0, decimals) || 0);
  return Number.isSafeInteger(value) ? value : null;
}

export const parseAmount = (s) => parseDecimal(s, 2);
export const parseQty = (s) => parseDecimal(s, 3);

export function formatDecimal(value, decimals) {
  const neg = value < 0;
  const abs = Math.abs(value);
  const base = 10 ** decimals;
  const whole = Math.floor(abs / base);
  const frac = String(abs - whole * base).padStart(decimals, "0");
  return (neg ? "-" : "") + whole + (decimals ? "." + frac : "");
}

// "2782.60" — the receipt prints amounts without thousands separators.
export const formatAmount = (cents) => formatDecimal(cents, 2);

// Thousands separators for the dashboard only.
export function formatMoneyDisplay(cents) {
  const [w, f] = formatAmount(cents).split(".");
  return w.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + f;
}

// Receipt quantity style: weighed units print with three decimals and the unit ("1.000kg");
// countable units print as an integer ("2"), or with the needed decimals if fractional.
export function formatQty(qtyMilli, unit) {
  if (unit && unit !== "pcs") return formatDecimal(qtyMilli, 3) + unit;
  if (qtyMilli % 1000 === 0) return String(qtyMilli / 1000);
  return formatDecimal(qtyMilli, 3).replace(/0+$/, "");
}

export function formatRate(rateBp) {
  return formatDecimal(rateBp, 2).replace(/\.?0+$/, "");
}

// lines: [{ unitPriceCents, qtyMilli, taxRateBp, ... }]
// Returns per-line amounts plus totals grouped by tax rate (receipt "TXBL n(r%)" / "TAX n(r%)").
export function computeTotals(lines) {
  const out = [];
  const groups = new Map();
  let netCents = 0;
  let taxCents = 0;
  for (const line of lines) {
    const amountCents = lineAmountCents(line.unitPriceCents, line.qtyMilli);
    const rate = line.taxRateBp ?? DEFAULT_TAX_RATE_BP;
    const tax = lineTaxCents(amountCents, rate);
    netCents += amountCents;
    taxCents += tax;
    if (!groups.has(rate)) groups.set(rate, { rateBp: rate, taxableCents: 0, taxCents: 0 });
    const g = groups.get(rate);
    g.taxableCents += amountCents;
    g.taxCents += tax;
    out.push({ ...line, taxRateBp: rate, amountCents, taxCents: tax });
  }
  // Highest rate first so the standard 15% VAT group is "1" as on the sample receipt.
  const taxGroups = [...groups.values()].sort((a, b) => b.rateBp - a.rateBp).map((g, i) => ({ ...g, index: i + 1 }));
  return { lines: out, taxGroups, netCents, taxCents, totalCents: netCents + taxCents, itemCount: out.length };
}
