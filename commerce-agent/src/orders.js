// Order-draft store.
//
// In-memory is fine here: nothing about the trust guarantees depends on
// this being durable. The mandate chain is what proves authorisation and
// the hash-chained ledger is what proves history — both survive this
// map being empty. This is a cache of in-flight checkouts, not a system
// of record.
import { randomUUID } from "node:crypto";

const drafts = new Map();

export const STATUSES = [
  "drafted",
  "needs_confirmation",
  "blocked",
  "awaiting_payment",
  "paid",
  "failed",
  "expired",
  "refunded",
];

export function createDraft({ mandate_id, items, categories, total_paise, baseline_paise, trace_id = null, agent_id = null }) {
  const draft = {
    id: `order_${randomUUID().slice(0, 10)}`,
    mandate_id,
    agent_id,
    trace_id,
    items,
    categories,
    total_paise,
    baseline_paise,
    upsell_product_id: null,
    upsell_accepted: false,
    status: "drafted",
    cart_mandate: null,
    payment_mandate: null,
    payment_link: null,
    payment_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  drafts.set(draft.id, draft);
  return draft;
}

export function getDraft(id) {
  return drafts.get(id) || null;
}

export function updateDraft(id, patch) {
  const draft = drafts.get(id);
  if (!draft) return null;
  Object.assign(draft, patch, { updated_at: new Date().toISOString() });
  return draft;
}

/**
 * Resolve a payment callback or webhook back to its order. Razorpay
 * gives us reference_id (our own order id) on the happy path, but a
 * webhook that arrives with only the payment link id still has to find
 * its order — hence both lookups.
 */
export function findByReferenceOrLinkId(idOrRef) {
  if (!idOrRef) return null;
  return [...drafts.values()].find((d) => d.id === idOrRef || d.payment_link?.id === idOrRef) || null;
}

export function listDrafts({ mandate_id } = {}) {
  const all = [...drafts.values()];
  return mandate_id ? all.filter((d) => d.mandate_id === mandate_id) : all;
}

export function resetOrders() {
  drafts.clear();
}
