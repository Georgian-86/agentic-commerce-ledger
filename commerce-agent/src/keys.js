// Multi-party key material.
//
// WHY THIS FILE EXISTS
// --------------------
// The first version of this project signed mandates with a single
// server-side HMAC secret. That is a merchant signing its own
// permission slip: the party that benefits from the authorisation is
// also the only party that can mint it, so a "valid signature" proves
// nothing to anyone except the merchant itself.
//
// Here the roles are genuinely separated, the way AP2 separates them:
//
//   user      — the shopper's wallet. ISSUES Intent Mandates ("this
//               agent may spend up to X, on these categories, until T").
//               The merchant can verify these but can never mint one.
//   merchant  — the storefront. ISSUES Cart Mandates ("this exact cart
//               costs exactly this much") and Payment Mandates. VERIFIES
//               Intent Mandates against the user's public key.
//   agent     — the buyer agent's own identity. Mandates are bound to
//               an agent id, so a leaked mandate can't be replayed by a
//               different agent.
//
// Signatures are Ed25519. AP2 specifies ECDSA over P-256; Ed25519 is
// the same security level with a smaller, misuse-resistant API, and
// swapping curves is a one-line change to generateKeyPairSync below.
// That difference is stated here rather than buried.
//
// Private keys live in commerce-agent/data/keys.json (gitignored) and
// are generated on first boot. Public keys are served at
// GET /.well-known/agent-keys so a verifier can actually fetch them
// instead of being handed them out of band.
import { generateKeyPairSync, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sha256Hex, b64url, fromB64url } from "./canonical.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ACL_DATA_DIR || join(__dirname, "..", "data");
const KEYS_PATH = join(DATA_DIR, "keys.json");

export const ROLES = ["user", "merchant", "agent"];

function newKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** Stable, fingerprint-based key id — role-tagged so audit rows read clearly. */
function keyIdFor(role, publicKeyPem) {
  const raw = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return `${role}:${sha256Hex(raw).slice(0, 16)}`;
}

function loadOrCreate() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(KEYS_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(KEYS_PATH, "utf-8"));
      if (ROLES.every((r) => parsed[r]?.privateKeyPem && parsed[r]?.publicKeyPem)) return parsed;
    } catch {
      // Corrupt keyring — fall through and regenerate rather than boot
      // into a state where nothing verifies and the reason is opaque.
    }
  }
  const generated = {};
  for (const role of ROLES) {
    const pair = newKeyPair();
    generated[role] = { ...pair, key_id: keyIdFor(role, pair.publicKeyPem) };
  }
  writeFileSync(KEYS_PATH, JSON.stringify(generated, null, 2));
  return generated;
}

const keyring = loadOrCreate();

export function keyId(role) {
  return keyring[role].key_id;
}

export function publicKeyPem(role) {
  return keyring[role].publicKeyPem;
}

/** The trusted-issuer registry: key_id -> public key. A verifier only
 *  ever trusts a signature whose key_id resolves here. */
const registry = new Map(ROLES.map((role) => [keyring[role].key_id, keyring[role].publicKeyPem]));

export function resolvePublicKey(kid) {
  return registry.get(kid) || null;
}

/** Sign canonical bytes with a role's private key. Returns base64url. */
export function signAs(role, bytes) {
  return b64url(edSign(null, Buffer.from(bytes), keyring[role].privateKeyPem));
}

/**
 * Verify a base64url signature over `bytes` using whatever public key
 * `kid` resolves to. Returns false for an unknown key id rather than
 * throwing — an unrecognised issuer is a verification failure, not a
 * crash.
 */
export function verifyWithKeyId(kid, bytes, signatureB64) {
  const pem = resolvePublicKey(kid);
  if (!pem) return false;
  try {
    return edVerify(null, Buffer.from(bytes), pem, fromB64url(signatureB64));
  } catch {
    return false;
  }
}

/** Public JWKS-ish view, safe to serve over HTTP. Never includes secrets. */
export function publicKeyDirectory() {
  return {
    alg: "Ed25519",
    note: "AP2 specifies ECDSA P-256; this build uses Ed25519 at equivalent strength. Curve choice is isolated to keys.js.",
    keys: ROLES.map((role) => ({
      role,
      key_id: keyring[role].key_id,
      public_key_pem: keyring[role].publicKeyPem.trim(),
    })),
  };
}
