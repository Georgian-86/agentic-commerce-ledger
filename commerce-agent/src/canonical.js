// Deterministic JSON serialisation + hashing.
//
// Everything that gets signed or hash-chained in this project goes
// through canonicalize() first. Without a canonical form, two
// semantically identical objects with different key insertion order
// produce different signatures, and verification becomes a coin flip
// that passes in dev and fails on stage. JCS (RFC 8785) is the real
// standard here; this is the same idea at the subset of JSON we
// actually emit (no floats beyond integers, no unusual escapes).
import { createHash } from "node:crypto";

/** Recursively sort object keys so serialisation is order-independent. */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    out[key] = canonicalize(value[key]);
  }
  return out;
}

/** Canonical JSON string — the exact bytes we sign and hash. */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** Content hash of any object, stable across key ordering. */
export function hashObject(value) {
  return sha256Hex(canonicalJson(value));
}

export function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export function fromB64url(str) {
  return Buffer.from(str, "base64url");
}
