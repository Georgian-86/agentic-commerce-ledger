// One EventSource for the whole app. The backend streams two named
// event types on /audit/stream: `audit` (ledger events) and `trace`
// (agent-loop spans). Everything that wants them subscribes here so we
// hold a single connection regardless of how many views are mounted.

import { store } from "./store.js";

const listeners = { audit: new Set(), trace: new Set(), status: new Set() };
let es = null;
let retry = 0;

export function connectSSE() {
  if (es) return;
  open();
}

function open() {
  es = new EventSource("/audit/stream");

  es.addEventListener("open", () => {
    retry = 0;
    listeners.status.forEach((fn) => fn("live"));
  });

  es.addEventListener("error", () => {
    listeners.status.forEach((fn) => fn("down"));
    // EventSource auto-reconnects, but if the server is truly gone we
    // back off our own status polling rather than hammering.
    es.close();
    es = null;
    retry = Math.min(retry + 1, 6);
    setTimeout(open, 1000 * retry);
  });

  es.addEventListener("audit", (e) => {
    const ev = JSON.parse(e.data);
    // keep the store's rolling event list current
    const events = store.get("events");
    events.push(ev);
    if (events.length > 400) events.splice(0, events.length - 400);
    store.set("events", events);
    store.set("chain", { seq: ev.seq, hash: ev.hash, ok: store.get("chain")?.ok, detail: store.get("chain")?.detail });
    listeners.audit.forEach((fn) => fn(ev));
  });

  es.addEventListener("trace", (e) => {
    const t = JSON.parse(e.data);
    applyTrace(t);
    listeners.trace.forEach((fn) => fn(t));
  });
}

function applyTrace(t) {
  const traces = store.get("traces");
  if (t.kind === "trace_start") {
    traces.set(t.trace_id, { trace_id: t.trace_id, goal: t.goal, plan: null, spans: [], started: t.ts, status: "running" });
  } else if (t.kind === "plan") {
    const tr = traces.get(t.trace_id); if (tr) tr.plan = t.steps;
  } else if (t.kind === "span_start") {
    const tr = traces.get(t.trace_id);
    if (tr) tr.spans.push({ id: t.span_id, name: t.name, type: t.type, started: t.ts, status: "running" });
  } else if (t.kind === "span_end") {
    const tr = traces.get(t.trace_id);
    const sp = tr?.spans.find((s) => s.id === t.span_id);
    if (sp) { sp.status = t.status; sp.duration_ms = t.duration_ms; }
  } else if (t.kind === "trace_end") {
    const tr = traces.get(t.trace_id);
    if (tr) { tr.ended = t.ts; tr.duration_ms = t.duration_ms; tr.status = t.status; }
  }
  store.set("traces", traces);
}

export const sse = {
  onAudit:  (fn) => { listeners.audit.add(fn);  return () => listeners.audit.delete(fn); },
  onTrace:  (fn) => { listeners.trace.add(fn);  return () => listeners.trace.delete(fn); },
  onStatus: (fn) => { listeners.status.add(fn); return () => listeners.status.delete(fn); },
};
