// A tiny reactive store. No framework — just a shared object plus a
// pub/sub so any view or component can react to state it cares about.
//
// Views subscribe on mount and unsubscribe on unmount (the router
// calls view.destroy()). Keys are dotted paths, e.g. "metrics" or
// "session".

const state = {
  health: null,
  metrics: null,
  mandates: [],
  chain: { seq: -1, hash: null, ok: null, detail: "" },
  session: null,          // { sessionId, mandate, ... }
  currentMandateId: null,
  events: [],             // audit events, newest last
  traces: new Map(),      // trace_id -> { goal, plan, spans:[], started, ended, status }
  stage: null,            // pipeline stage
  onboarded: safeGet("acl.onboarded") === "1",
};

const subs = new Map(); // key -> Set<fn>

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

export const store = {
  get: (k) => k ? deep(state, k) : state,

  set(k, v) {
    setDeep(state, k, v);
    emit(k, v);
  },

  patch(k, partial) {
    const cur = deep(state, k) || {};
    const next = { ...cur, ...partial };
    setDeep(state, k, next);
    emit(k, next);
  },

  on(k, fn) {
    if (!subs.has(k)) subs.set(k, new Set());
    subs.get(k).add(fn);
    return () => subs.get(k)?.delete(fn);
  },

  markOnboarded() {
    state.onboarded = true;
    safeSet("acl.onboarded", "1");
  },
  resetOnboarding() {
    state.onboarded = false;
    try { localStorage.removeItem("acl.onboarded"); } catch {}
  },
};

function deep(obj, path) {
  return path.split(".").reduce((o, p) => (o == null ? o : o[p]), obj);
}
function setDeep(obj, path, val) {
  const parts = path.split(".");
  const last = parts.pop();
  const target = parts.reduce((o, p) => (o[p] ??= {}), obj);
  target[last] = val;
}
function emit(k, v) {
  subs.get(k)?.forEach((fn) => { try { fn(v, state); } catch (e) { console.error(e); } });
  // bubble to parent keys so "metrics" listeners fire on "metrics.llm"
  const parts = k.split(".");
  while (parts.length > 1) {
    parts.pop();
    const pk = parts.join(".");
    subs.get(pk)?.forEach((fn) => { try { fn(deep(state, pk), state); } catch (e) { console.error(e); } });
  }
}
