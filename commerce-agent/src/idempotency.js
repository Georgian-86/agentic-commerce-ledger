// Idempotency keys.
//
// Three separate things in this system can legitimately arrive twice:
//   - confirm_checkout, because an agent retries on a timeout
//   - the browser payment-callback, because a human presses F5 on the
//     success page (this one is not hypothetical — the callback URL is
//     a plain GET with all its parameters in the query string)
//   - a Razorpay webhook, because Razorpay's own docs say webhooks may
//     be delivered more than once and out of order
//
// In each case the correct behaviour is the same: perform the effect
// once, and return the *original* result to every later caller. Doing
// nothing on the retry is not enough — the caller needs the answer.
const store = new Map(); // `${scope}:${key}` -> { status, value, ts }
const TTL_MS = 6 * 60 * 60 * 1000;

function k(scope, key) {
  return `${scope}:${key}`;
}

function sweep() {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, rec] of store) {
    if (rec.ts < cutoff) store.delete(key);
  }
}

/**
 * Run `fn` at most once per (scope, key). Concurrent callers await the
 * same in-flight promise rather than both executing — without this,
 * two simultaneous confirms would both pass the "have I seen this?"
 * check before either finished.
 *
 * `shouldCache` decides whether an outcome is worth remembering. This
 * matters more than it looks: only results that *did something*
 * belong in the cache. A "needs_confirmation" is not a completed
 * effect, it is a request for more input — caching it means that once
 * a human approves, the retry returns the stale refusal forever and
 * the purchase can never complete. Same for a stock-out: restock and
 * retry should genuinely re-evaluate. Cache effects, not answers.
 */
export async function once(scope, key, fn, shouldCache = () => true) {
  sweep();
  const id = k(scope, key);
  const existing = store.get(id);
  if (existing) {
    const value = await existing.value;
    return { replayed: true, value };
  }

  const promise = (async () => fn())();
  store.set(id, { value: promise, ts: Date.now() });
  try {
    const value = await promise;
    // A retriable outcome is evicted so the next attempt runs for real.
    if (!shouldCache(value)) store.delete(id);
    return { replayed: false, value };
  } catch (err) {
    // A thrown failure must not be cached either — the caller should be
    // able to retry a transient failure and get a real second attempt.
    store.delete(id);
    throw err;
  }
}

export function seen(scope, key) {
  sweep();
  return store.has(k(scope, key));
}

export function resetIdempotency() {
  store.clear();
}
