// Reset demo state to a clean, honest empty.
//
// This exists because of a specific failure: a judge opens the console
// and the "live" audit feed is already full of last night's rehearsal.
// An empty state you can trust is worth more than a busy one you can't.
//
// Works with the server running (via /debug/reset-demo) or stopped
// (by clearing the files directly). Signing keys are kept — regenerating
// them would invalidate every mandate token already printed on a slide.
import { unlinkSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "commerce-agent", "data");
const PORT = process.env.COMMERCE_AGENT_PORT || 4200;

const KEEP_KEYS = process.argv.includes("--rotate-keys") ? false : true;

async function viaServer() {
  const res = await fetch(`http://localhost:${PORT}/debug/reset-demo`, { method: "POST" });
  if (!res.ok) throw new Error(`server returned ${res.status}`);
  return res.json();
}

function viaFiles() {
  writeFileSync(join(DATA_DIR, "audit-log.jsonl"), "");
  for (const file of ["memory.json", ...(KEEP_KEYS ? [] : ["keys.json"])]) {
    const path = join(DATA_DIR, file);
    if (existsSync(path)) unlinkSync(path);
  }
}

try {
  const result = await viaServer();
  console.log("Demo reset via the running server.");
  console.log(`  audit chain head: seq ${result.chain.seq}`);
  console.log("  ledger cleared, orders dropped, metrics zeroed, mandates reissued.");
  console.log("  shopper memory kept — reset it with the server stopped if you want a cold start.");
} catch {
  viaFiles();
  console.log("Server not reachable — cleared state files directly.");
  console.log("  audit-log.jsonl truncated");
  console.log("  memory.json removed");
  console.log(KEEP_KEYS ? "  keys.json kept (pass --rotate-keys to regenerate)" : "  keys.json removed — new keys on next boot");
}
