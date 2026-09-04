// The ledger: a hash-chained, tamper-evident audit trail.
//
// An append-only JSONL file is only append-only by convention — open it
// in an editor and it isn't. Since the whole claim of this project is
// that every money action is explainable and provable after the fact,
// the trail itself has to be verifiable.
//
// Each event carries:
//   seq        monotonic position in the chain
//   prev_hash  the hash of the event before it
//   hash       sha256 over this event's canonical body + prev_hash
//
// Change any byte of any historical event and every subsequent hash
// stops matching. GET /audit/verify walks the chain and reports the
// exact sequence number where it broke. That turns "trust our log"
// into something a judge can falsify in ten seconds by editing the
// file and hitting refresh.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { canonicalJson, sha256Hex } from "./canonical.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// ACL_DATA_DIR lets a deploy point this at a mounted persistent disk so
// the hash chain and keys survive a redeploy. Unset → local ./data.
const DATA_DIR = process.env.ACL_DATA_DIR || join(__dirname, "..", "data");
const LOG_PATH = join(DATA_DIR, "audit-log.jsonl");

const GENESIS_HASH = "0".repeat(64);

mkdirSync(DATA_DIR, { recursive: true });

const bus = new EventEmitter();
bus.setMaxListeners(100);

/** Hash of an event, computed over everything except the hash itself. */
function computeHash(event) {
  const { hash, ...rest } = event;
  return sha256Hex(canonicalJson(rest));
}

function loadChain() {
  if (!existsSync(LOG_PATH)) return [];
  return readFileSync(LOG_PATH, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const events = loadChain();

function head() {
  return events.length ? events[events.length - 1] : null;
}

/**
 * Record one structured audit event and link it into the chain.
 *
 * `reason` must always be a specific, genuine sentence — it is the
 * field that makes a decision explainable, and it is written once,
 * server-side, at the moment of the decision. Nothing downstream
 * (least of all the language model) gets to author it after the fact.
 */
export function recordEvent({
  actor,
  mandate_id = null,
  order_draft_id = null,
  event_type,
  decision,
  reason,
  severity = null,
  trace_id = null,
  raw_context = {},
}) {
  const prev = head();
  const body = {
    event_id: randomUUID(),
    seq: prev ? prev.seq + 1 : 0,
    ts: new Date().toISOString(),
    actor,
    mandate_id,
    order_draft_id,
    event_type,
    decision,
    reason,
    severity: severity || defaultSeverity(decision),
    trace_id,
    raw_context,
    prev_hash: prev ? prev.hash : GENESIS_HASH,
  };
  const event = { ...body, hash: computeHash(body) };

  events.push(event);
  appendFileSync(LOG_PATH, JSON.stringify(event) + "\n");
  bus.emit("event", event);
  return event;
}

function defaultSeverity(decision) {
  if (decision === "blocked" || decision === "failed") return "critical";
  if (decision === "needs_confirmation") return "warn";
  return "info";
}

/**
 * Walk the chain from genesis. Returns the first position where either
 * a hash doesn't match its own contents (the event was edited) or a
 * prev_hash doesn't match the previous event (an event was inserted,
 * removed or reordered).
 */
export function verifyChain() {
  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.prev_hash !== expectedPrev) {
      return {
        ok: false,
        length: events.length,
        broken_at: event.seq,
        event_id: event.event_id,
        detail: `Event seq ${event.seq} claims prev_hash ${short(event.prev_hash)}, but the previous event hashes to ${short(expectedPrev)}. An event was inserted, removed or reordered.`,
      };
    }
    const recomputed = computeHash(event);
    if (recomputed !== event.hash) {
      return {
        ok: false,
        length: events.length,
        broken_at: event.seq,
        event_id: event.event_id,
        detail: `Event seq ${event.seq} hashes to ${short(recomputed)} but stores ${short(event.hash)}. Its contents were modified after it was written.`,
      };
    }
    expectedPrev = event.hash;
  }
  return {
    ok: true,
    length: events.length,
    head_hash: expectedPrev === GENESIS_HASH ? null : expectedPrev,
    detail: events.length
      ? `All ${events.length} events verify against the chain. Head is ${short(expectedPrev)}.`
      : "Ledger is empty — nothing to verify yet.",
  };
}

function short(hash) {
  return hash ? `${hash.slice(0, 12)}…` : "—";
}

export function listEvents({ mandate_id, since_seq, limit } = {}) {
  let out = events;
  if (mandate_id) out = out.filter((e) => e.mandate_id === mandate_id);
  if (typeof since_seq === "number") out = out.filter((e) => e.seq > since_seq);
  if (limit) out = out.slice(-limit);
  return out;
}

export function chainHead() {
  const h = head();
  return h ? { seq: h.seq, hash: h.hash } : { seq: -1, hash: GENESIS_HASH };
}

export function onEvent(listener) {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}

/** Truncate the ledger. Demo-reset only — never called at runtime. */
export function resetLedger() {
  events.length = 0;
  writeFileSync(LOG_PATH, "");
}
