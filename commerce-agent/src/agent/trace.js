// Span tracing for the agent loop.
//
// "The agent did something and here is the text it produced" is a
// chatbot. An agent should be able to show its work: which step it was
// on, which tool it reached for, what came back, how long it took, and
// why it moved on. Every turn opens a trace; every model call, tool
// call, gate decision and critique becomes a span inside it.
//
// The dashboard subscribes to this bus and renders a live waterfall, so
// what a judge sees is the agent's actual execution, not a spinner
// followed by a paragraph.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

const bus = new EventEmitter();
bus.setMaxListeners(100);

const traces = new Map(); // trace_id -> trace record

export function onTraceEvent(listener) {
  bus.on("trace", listener);
  return () => bus.off("trace", listener);
}

function emit(payload) {
  bus.emit("trace", payload);
}

export function startTrace({ session_id, goal }) {
  const trace_id = `tr_${randomUUID().slice(0, 12)}`;
  const record = {
    trace_id,
    session_id,
    goal,
    started_at: Date.now(),
    spans: [],
    status: "running",
  };
  traces.set(trace_id, record);
  emit({ kind: "trace_start", trace_id, session_id, goal, ts: Date.now() });

  const api = {
    trace_id,

    /** Open a span. Call end() on the returned handle. */
    span(name, { type = "step", attrs = {} } = {}) {
      const span_id = `sp_${randomUUID().slice(0, 8)}`;
      const span = { span_id, name, type, attrs, started_at: Date.now(), status: "running" };
      record.spans.push(span);
      emit({ kind: "span_start", trace_id, span_id, name, type, attrs, ts: span.started_at });

      return {
        span_id,
        /** Attach detail while the span is still open (e.g. a plan). */
        note(extra) {
          Object.assign(span.attrs, extra);
          emit({ kind: "span_note", trace_id, span_id, attrs: extra, ts: Date.now() });
        },
        end(result = {}, status = "ok") {
          span.ended_at = Date.now();
          span.duration_ms = span.ended_at - span.started_at;
          span.status = status;
          span.result = summarise(result);
          emit({
            kind: "span_end",
            trace_id,
            span_id,
            name,
            type,
            status,
            duration_ms: span.duration_ms,
            result: span.result,
            ts: span.ended_at,
          });
          return result;
        },
      };
    },

    /** Announce the plan so the UI can render it before execution. */
    plan(steps) {
      record.plan = steps;
      emit({ kind: "plan", trace_id, steps, ts: Date.now() });
    },

    finish(status = "ok", summary = {}) {
      record.status = status;
      record.ended_at = Date.now();
      record.duration_ms = record.ended_at - record.started_at;
      emit({ kind: "trace_end", trace_id, status, duration_ms: record.duration_ms, summary, ts: record.ended_at });
      return record;
    },
  };

  return api;
}

/**
 * Trim tool results down to something loggable. A full catalogue dump
 * in every span turns the trace into noise and the SSE stream into a
 * bandwidth problem.
 */
function summarise(result) {
  if (result === null || result === undefined) return null;
  if (typeof result !== "object") return result;
  const out = {};
  for (const [key, value] of Object.entries(result)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      out[key] = value.length <= 3 ? value.map(shallow) : { count: value.length, sample: value.slice(0, 2).map(shallow) };
    } else if (typeof value === "object") {
      out[key] = shallow(value);
    } else if (typeof value === "string" && value.length > 220) {
      out[key] = `${value.slice(0, 220)}…`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function shallow(value) {
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== null && typeof v === "object") continue;
    if (typeof v === "string" && v.length > 120) {
      out[k] = `${v.slice(0, 120)}…`;
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function getTrace(trace_id) {
  return traces.get(trace_id) || null;
}

export function recentTraces(limit = 10) {
  return [...traces.values()].slice(-limit);
}

export function resetTraces() {
  traces.clear();
}
