// Money formatting, in one place.
//
// Amounts are integer paise everywhere internally — never rupees, never
// floats. Currency arithmetic in a float is how you end up with an
// order that totals ₹1,999.9999999998, and there is no good place to
// discover that for the first time.
export function formatPaise(paise) {
  const rupees = Math.trunc(paise / 100);
  const remainder = Math.abs(paise % 100);
  const base = `₹${rupees.toLocaleString("en-IN")}`;
  return remainder === 0 ? base : `${base}.${String(remainder).padStart(2, "0")}`;
}

export function toPaise(rupees) {
  return Math.round(Number(rupees) * 100);
}
