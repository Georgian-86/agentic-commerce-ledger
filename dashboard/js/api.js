// Thin fetch wrappers around the commerce-agent HTTP API.
// Every call returns parsed JSON or throws an Error with a usable message.
//
// BASE is "" (same origin) for the normal single-deploy setup. If you
// CDN-host this dashboard separately, set `window.__API_BASE` to the
// deployed API origin (e.g. in a tiny inline <script> before app.js).
export const API_BASE = (typeof window !== "undefined" && window.__API_BASE) || "";
const BASE = API_BASE;

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    ...opts,
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body?.error || body?.detail || `${res.status} ${res.statusText}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

const post = (path, body) => req(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export const api = {
  health:        () => req("/health"),
  metrics:       () => req("/metrics"),
  mandates:      () => req("/mandates"),
  credential:    (id) => req(`/mandates/${id}/credential`),
  tamper:        (id, payload) => post(`/mandates/${id}/tamper`, payload),
  ledger:        () => req("/ledger"),
  audit:         (q = "") => req("/audit" + (q ? `?${q}` : "")),
  verifyChain:   () => req("/audit/verify"),
  traces:        () => req("/traces"),
  memory:        (subject) => req(`/memory/${encodeURIComponent(subject)}`),

  startSession:  (payload) => post("/session", payload),
  chat:          (sessionId, message) => post("/chat", { sessionId, message }),
  confirm:       (orderId, payload) => post(`/orders/${orderId}/confirm`, payload),
  abandon:       (orderId) => post(`/orders/${orderId}/abandon`, {}),

  setStock:      (product_id, qty) => post("/debug/set-stock", { product_id, qty }),
  replayWebhook: (order_draft_id, times) => post("/debug/replay-webhook", { order_draft_id, times }),
  resetDemo:     () => post("/debug/reset-demo", {}),
};
