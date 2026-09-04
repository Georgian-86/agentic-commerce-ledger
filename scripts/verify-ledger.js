// Verify the audit chain from disk, without the server.
//
// Point of this being a separate script: chain verification does not
// depend on the process that wrote the chain. Anyone with the file can
// check it. Run it, edit one character of any event in
// commerce-agent/data/audit-log.jsonl, run it again.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(__dirname, "..", "commerce-agent", "data", "audit-log.jsonl");
const GENESIS = "0".repeat(64);

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    out[key] = canonicalize(value[key]);
  }
  return out;
}

if (!existsSync(LOG_PATH)) {
  console.log("No ledger file yet — nothing to verify.");
  process.exit(0);
}

const events = readFileSync(LOG_PATH, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

let expectedPrev = GENESIS;
for (const event of events) {
  const { hash, ...body } = event;
  const recomputed = createHash("sha256").update(JSON.stringify(canonicalize(body))).digest("hex");

  if (event.prev_hash !== expectedPrev) {
    console.error(`\n  BROKEN at seq ${event.seq}`);
    console.error(`  prev_hash is ${event.prev_hash.slice(0, 16)}… but the previous event hashes to ${expectedPrev.slice(0, 16)}…`);
    console.error("  An event was inserted, removed, or reordered.\n");
    process.exit(1);
  }
  if (recomputed !== hash) {
    console.error(`\n  BROKEN at seq ${event.seq}  (${event.event_type})`);
    console.error(`  stored hash     ${hash.slice(0, 32)}…`);
    console.error(`  recomputed hash ${recomputed.slice(0, 32)}…`);
    console.error(`  This event's contents were changed after it was written.`);
    console.error(`  Reason field currently reads: "${String(event.reason).slice(0, 120)}"\n`);
    process.exit(1);
  }
  expectedPrev = hash;
}

console.log(`\n  Ledger intact — ${events.length} events verify from genesis.`);
console.log(`  Head: ${expectedPrev.slice(0, 32)}…\n`);
