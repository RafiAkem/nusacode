/** Rupiah as shown everywhere in NusaCode: `Rp 1.234.567`. */
export function idr(n: number): string {
  return `Rp ${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

const MAX_AMOUNT = 1_000_000_000_000;
/** Words after a number: `5k`, `5rb` (ribu), `1.5m`, `2jt` (juta). */
const MULTIPLIERS: Record<string, number> = { k: 1_000, rb: 1_000, m: 1_000_000, jt: 1_000_000 };

/**
 * A rupiah amount typed by a person: `5000`, `5.000`, `5,000`, `Rp 5.000`, `5k`, `1.5m`, `2jt`.
 * Returns whole rupiah, or null when the text is not a clear positive amount. Without a
 * multiplier, dots and commas are thousands separators; with one, they are a decimal point.
 */
export function parseIdr(text: string): number | null {
  const cleaned = text.trim().toLowerCase().replace(/^rp\.?/, "").replace(/\s+/g, "");
  const grouped = /^\d{1,3}(?:[.,]\d{3})+$/.test(cleaned);
  const suffixed = /^(\d+(?:[.,]\d+)?)(k|rb|m|jt)$/.exec(cleaned);
  let value: number;
  if (suffixed) {
    value = Number(suffixed[1].replace(",", ".")) * MULTIPLIERS[suffixed[2]];
  } else if (grouped) {
    value = Number(cleaned.replace(/[.,]/g, ""));
  } else if (/^\d+$/.test(cleaned)) {
    value = Number(cleaned);
  } else {
    return null;
  }
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) > 1e-6 || rounded <= 0 || rounded > MAX_AMOUNT) return null;
  return rounded;
}
