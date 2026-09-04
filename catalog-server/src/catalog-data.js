import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(__dirname, "..", "..", "seed");

export const products = JSON.parse(readFileSync(join(SEED_DIR, "catalog.json"), "utf-8"));
export const policies = JSON.parse(readFileSync(join(SEED_DIR, "policies.json"), "utf-8"));

const byId = new Map(products.map((p) => [p.id, p]));

export function getProduct(id) {
  return byId.get(id) || null;
}

export function searchProducts({ query, category, max_price_paise } = {}) {
  const q = (query || "").trim().toLowerCase();
  return products.filter((p) => {
    if (category && p.category !== category) return false;
    if (typeof max_price_paise === "number" && p.price_paise > max_price_paise) return false;
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q)
    );
  });
}

export function checkInventory(productId, qty) {
  const product = byId.get(productId);
  if (!product) return { available: false, stock_qty: 0, reason: "unknown_product" };
  return { available: product.stock_qty >= qty, stock_qty: product.stock_qty };
}

export function getPolicy(topic) {
  return policies[topic] || null;
}

export function getRelatedProducts(productId) {
  const product = byId.get(productId);
  if (!product) return [];
  return (product.related_skus || [])
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((p) => ({
      id: p.id,
      name: p.name,
      price_paise: p.price_paise,
      reason: `Frequently bought with ${product.name}`,
    }));
}

// Runtime-mutable stock, used by the debug endpoint for the
// deliberate-failure demo moment (Track 1's "one failure handled
// gracefully" requirement).
export function setStock(productId, qty) {
  const product = byId.get(productId);
  if (!product) return false;
  product.stock_qty = qty;
  return true;
}
