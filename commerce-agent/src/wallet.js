// The shopper's wallet — simulated, and labelled as simulated.
//
// In a real deployment this lives on the user's device: the user
// approves a spending authorisation, their device signs it with a
// hardware-backed key, and the merchant never sees the private key.
// Running it in-process here is the one place this project simulates
// rather than implements, so it is isolated to this single file and
// said out loud rather than blurred.
//
// What is NOT simulated: the signing role separation is real. Mandates
// minted here are signed with the `user` key, and the Gate verifies
// them against the user's *public* key like any other relying party.
// Deleting this file would remove the ability to issue mandates and
// change nothing about the ability to verify them.
import { issueIntentMandate, encodeToken } from "./mandate.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(__dirname, "..", "..", "seed", "mandates.json");

export const AGENT_ID = "shopper-agent-01";

// mandate_id -> { mandate, token, persona }
const issued = new Map();

/**
 * Mint the demo personas' mandates. Called at boot and again on every
 * demo reset — so it clears first. Without the clear, each reset
 * stacks a fresh set of persona mandates on top of the old ones and
 * the dashboard's mandate picker fills up with stale duplicates.
 */
export function issueSeedMandates() {
  issued.clear();
  const seeds = JSON.parse(readFileSync(SEED_PATH, "utf-8"));
  for (const seed of seeds) {
    const mandate = issueIntentMandate({
      // Stable id per persona — `seed.mandate_id` from mandates.json.
      // A demo reset or a redeploy re-signs the credential (new nonce)
      // but keeps the id, so an open console tab's picker still works.
      mandate_id: seed.mandate_id,
      label: seed.label,
      issued_to: { agent_id: AGENT_ID, agent_name: "In-app Shopper Agent", subject: seed.issued_to },
      max_amount_paise: seed.max_amount_paise,
      max_per_order_paise: seed.max_per_order_paise ?? null,
      allowed_categories: seed.allowed_categories,
      requires_confirmation_above_paise: seed.requires_confirmation_above_paise ?? null,
      ttl_hours: seed.expires_in_hours ?? 48,
    });
    issued.set(mandate.mandate_id, { mandate, token: encodeToken(mandate), persona: seed.persona_id || seed.mandate_id });
  }
  return listIssued();
}

/**
 * Issue a fresh mandate on demand — this is what an external AI buyer
 * calls when it has no credential yet. In production this request would
 * go to the shopper's own wallet app for approval, not to the merchant.
 */
export function issueForAgent({ agent_id, agent_name, subject, max_amount_paise, allowed_categories, ttl_hours = 2, max_per_order_paise = null }) {
  const mandate = issueIntentMandate({
    label: `Ad-hoc mandate for ${agent_name || agent_id}`,
    issued_to: { agent_id, agent_name: agent_name || agent_id, subject: subject || agent_id },
    max_amount_paise,
    max_per_order_paise,
    allowed_categories,
    ttl_hours,
  });
  const record = { mandate, token: encodeToken(mandate), persona: "external" };
  issued.set(mandate.mandate_id, record);
  return record;
}

export function getIssued(mandate_id) {
  return issued.get(mandate_id) || null;
}

export function listIssued() {
  return [...issued.values()];
}

export function resetWallet() {
  issued.clear();
}
