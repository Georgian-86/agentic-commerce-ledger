// Episodic memory.
//
// A chatbot starts every conversation from nothing. An agent that
// shops for you should remember that you bought a candle set for your
// sister last month, that you walked away from the ₹2,499 earbuds, and
// that you keep asking for things "under ₹1,500".
//
// Memory here is derived deterministically from what actually happened
// — tool results and gate decisions — not summarised by a model. That
// matters for two reasons: it can't hallucinate a preference the
// shopper never expressed, and every remembered fact can be traced to
// the specific event that produced it. Each entry carries the evidence
// that created it, so the dashboard can show "the agent believes X
// because Y happened" rather than asking anyone to take it on faith.
//
// Keyed on the mandate's `issued_to` subject, so memory follows the
// shopper across sessions and mandates rather than dying with a chat
// window.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ACL_DATA_DIR || join(__dirname, "..", "..", "data");
const MEM_PATH = join(DATA_DIR, "memory.json");

mkdirSync(DATA_DIR, { recursive: true });

const MAX_FACTS_PER_SUBJECT = 24;

function load() {
  if (!existsSync(MEM_PATH)) return {};
  try {
    return JSON.parse(readFileSync(MEM_PATH, "utf-8"));
  } catch {
    return {};
  }
}

let store = load();

function persist() {
  writeFileSync(MEM_PATH, JSON.stringify(store, null, 2));
}

function subjectRecord(subject) {
  if (!store[subject]) store[subject] = { subject, facts: [], updated_at: null };
  return store[subject];
}

/**
 * Record one observation. `key` deduplicates: re-observing the same
 * fact updates its recency and confidence instead of appending a
 * near-duplicate, so the memory stays small enough to read.
 */
export function remember(subject, { key, kind, statement, evidence, confidence = 0.7 }) {
  if (!subject) return null;
  const record = subjectRecord(subject);
  const existing = record.facts.find((f) => f.key === key);
  const now = new Date().toISOString();

  if (existing) {
    existing.observations += 1;
    existing.last_seen = now;
    existing.statement = statement;
    existing.evidence = evidence;
    // Repetition raises confidence, with a ceiling — three sightings of
    // the same preference is meaningfully stronger than one, thirty is
    // not meaningfully stronger than three.
    existing.confidence = Math.min(0.95, existing.confidence + 0.08);
  } else {
    record.facts.push({
      key,
      kind,
      statement,
      evidence,
      confidence,
      observations: 1,
      first_seen: now,
      last_seen: now,
    });
  }

  record.facts.sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));
  if (record.facts.length > MAX_FACTS_PER_SUBJECT) record.facts.length = MAX_FACTS_PER_SUBJECT;
  record.updated_at = now;
  persist();
  return record;
}

export function recall(subject) {
  if (!subject) return [];
  return subjectRecord(subject).facts;
}

/** Compact, model-facing rendering. Only high-confidence facts, so a
 *  weak signal never becomes an instruction the agent acts on. */
export function recallForPrompt(subject, { min_confidence = 0.6, limit = 6 } = {}) {
  const facts = recall(subject)
    .filter((f) => f.confidence >= min_confidence)
    .slice(0, limit);
  if (!facts.length) return null;
  return facts.map((f) => `- ${f.statement}`).join("\n");
}

/* ------------------------------------------------------------------ */
/*  Deterministic extractors — the only writers into memory            */
/* ------------------------------------------------------------------ */

const PRICE_CEILING = /(?:under|below|less than|upto|up to|within|max(?:imum)?(?: of)?)\s*(?:₹|rs\.?|inr)?\s*([\d,]+)/i;

export function observeUserMessage(subject, text) {
  if (!subject || !text) return;
  const ceiling = text.match(PRICE_CEILING);
  if (ceiling) {
    const rupees = Number(ceiling[1].replace(/,/g, ""));
    if (Number.isFinite(rupees) && rupees > 0) {
      remember(subject, {
        key: "price_ceiling",
        kind: "preference",
        statement: `Tends to shop with a stated ceiling around ₹${rupees.toLocaleString("en-IN")}.`,
        evidence: `Shopper wrote: "${text.slice(0, 120)}"`,
        confidence: 0.65,
      });
    }
  }

  for (const [category, pattern] of Object.entries({
    gifting: /\bgift|present|hamper|birthday|anniversar/i,
    audio: /\bearbud|headphone|speaker|audio|mic\b/i,
    home: /\blamp|mug|cushion|blanket|coaster|home\b/i,
    apparel: /\btee|shirt|cap|jacket|socks|apparel|wear\b/i,
  })) {
    if (pattern.test(text)) {
      remember(subject, {
        key: `interest:${category}`,
        kind: "interest",
        statement: `Shops the "${category}" category.`,
        evidence: `Mentioned in: "${text.slice(0, 90)}"`,
        confidence: 0.6,
      });
    }
  }
}

export function observePurchase(subject, { items, total_paise }) {
  if (!subject || !items?.length) return;
  for (const item of items) {
    remember(subject, {
      key: `bought:${item.product_id}`,
      kind: "purchase",
      statement: `Has bought ${item.name} (₹${Math.round(item.price_paise / 100).toLocaleString("en-IN")}).`,
      evidence: `Settled order totalling ₹${Math.round(total_paise / 100).toLocaleString("en-IN")}.`,
      confidence: 0.9,
    });
  }
}

export function observeAbandonment(subject, { items }) {
  if (!subject || !items?.length) return;
  const item = items[0];
  remember(subject, {
    key: `walked_away:${item.product_id}`,
    kind: "signal",
    statement: `Drafted ${item.name} but did not complete the purchase — treat as price-sensitive on this item.`,
    evidence: "Order draft expired or was blocked before payment.",
    confidence: 0.6,
  });
}

export function observeBlock(subject, { reason_code, amount_paise }) {
  if (!subject) return;
  if (reason_code !== "over_budget") return;
  remember(subject, {
    key: "hits_budget_ceiling",
    kind: "signal",
    statement: `Has hit their mandate's budget ceiling before — lead with in-budget options rather than showing what they can't buy.`,
    evidence: `A ₹${Math.round(amount_paise / 100).toLocaleString("en-IN")} order was blocked as over budget.`,
    confidence: 0.7,
  });
}

export function forget(subject) {
  delete store[subject];
  persist();
}

export function resetMemory() {
  store = {};
  persist();
}

export function allSubjects() {
  return Object.values(store);
}
