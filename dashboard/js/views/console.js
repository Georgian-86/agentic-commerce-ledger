import { h, clear, esc, fmtPaise } from "../ui/dom.js";
import { icons } from "../ui/icons.js";
import { store } from "../store.js";
import { sse } from "../sse.js";
import { api } from "../api.js";
import { toast } from "../ui/toast.js";
import { navigate } from "../router.js";
import { skelLines } from "../ui/skeleton.js";

const STAGES = ["plan", "act", "gate", "reflect", "settle"];
let state = { sessionId: null, mandate: null, lastDraft: null, lastConfirm: null };
let offs = [];

export default {
  async render(mount) {
    state = { sessionId: null, mandate: null, lastDraft: null, lastConfirm: null };
    const mandates = store.get("mandates") || [];

    const grid = h("div.console-grid.page");

    /* ---- left: pipeline + chat ---- */
    const pipeline = h("div.pipeline#pipeline", ...STAGES.flatMap((s, i) => [
      h("div.pstep", { dataset: { step: s } }, h("span.pd"), s),
      i < STAGES.length - 1 && h("div.pline"),
    ].filter(Boolean)));

    const chatPanel = h("section.panel.chat-panel", {},
      h("div.panel-head", {}, h("h3", { text: "Shopper agent" }), h("span.label", { text: "plan · act · observe · reflect" })),
      chatSetup(mandates),
      h("div.stack.grow", { style: { minHeight: 0 } },
        h("div.chat-log#chat-log", { hidden: true }),
        h("div#chat-empty.empty", { html: "Pick a shopper above and press <strong>Start session</strong>.<br/>The agent can only spend inside that shopper's signed mandate." }),
      ),
      h("div#cart-slot"),
      chatInput(),
    );

    const main = h("div.console-main", {}, pipeline, chatPanel);

    /* ---- right: mini-mandate + trace ---- */
    const side = h("div.console-side", {},
      h("section.panel", {},
        h("div.panel-head", {},
          h("h3", { text: "Mandate balance" }),
          h("a.label", { href: "#/mandates", text: "inspect →" })),
        h("div.mini-mandate#mini-mandate",
          mm("Cap", "mm-cap"), mm("Settled", "mm-spent", "spent"),
          mm("On hold", "mm-held", "held"), mm("Available", "mm-avail", "avail")),
        h("div.meter", { style: { marginTop: ".7rem" } }, h("i.spent#mm-bar-s"), h("i.held#mm-bar-h")),
      ),
      h("section.panel#trace-panel", {},
        h("div.panel-head", {}, h("h3", { text: "Execution trace" }), h("span.label#trace-meta", { text: "idle" })),
        h("p.faint", { style: { fontSize: ".78rem", margin: "-.4rem 0 .7rem" }, text: "The agent's real work — plan, model calls, catalog tool calls, grounding check." }),
        h("div.trace-list#trace-list", h("div.empty", { text: "No turns yet." })),
      ),
    );

    grid.append(main, side);
    mount.appendChild(grid);

    paintMandate();
    renderTraces();

    offs.push(store.on("metrics", paintMandate));
    offs.push(store.on("mandates", paintMandate));
    offs.push(sse.onTrace(() => renderTraces()));

    const MANDATE_TOUCHING = new Set([
      "order_drafted", "checkout_approved", "checkout_blocked", "checkout_failed",
      "payment_verified", "payment_refunded", "hold_released", "hold_expired", "cart_repriced",
    ]);
    offs.push(sse.onAudit(async (ev) => {
      const stg = stageForEvent(ev.event_type);
      if (stg) setStage(stg);
      if (ev.event_type === "checkout_failed") toast("Checkout failed — handled", ev.reason, "crit");
      if (ev.event_type === "reply_rejected") toast("Reply corrected", "The agent quoted a figure not in any tool result; the grounding check bounced it.", "warn");
      if (ev.event_type === "prompt_injection_detected") toast("Prompt injection caught", "Instruction-shaped text in catalog data — treated as data. The Gate never reads it.", "crit");
      if (MANDATE_TOUCHING.has(ev.event_type)) {
        try { store.set("mandates", await api.mandates()); } catch {}
      }
      paintMandate();
    }));
  },
  destroy() { offs.forEach((f) => f()); offs = []; },
};

/* ---------- pieces ---------- */
function fillMandateOptions(sel, mandates) {
  const keep = sel.value;
  sel.innerHTML = "";
  for (const m of mandates) sel.appendChild(h("option", { value: m.mandate_id, text: m.label }));
  if (mandates.some((m) => m.mandate_id === keep)) sel.value = keep;
}

function chatSetup(mandates) {
  const sel = h("select.select#mandate-pick");
  fillMandateOptions(sel, mandates);
  const startBtn = h("button.btn.btn-primary#start-btn", { text: "Start session" });
  startBtn.addEventListener("click", () => startSession(sel.value));

  // Keep the picker in sync with the store — a demo reset or a redeploy
  // can change which mandates exist while this view is open.
  offs.push(store.on("mandates", (ms) => fillMandateOptions(sel, ms || [])));

  const setup = h("div.chat-setup#chat-setup", sel, startBtn);
  const bar = h("div.session-bar#session-bar", { hidden: true });
  return h("div", {}, setup, bar);
}

function chatInput() {
  const input = h("input#chat-input", { placeholder: "e.g. 'gifts under 1500', 'buy the candle duo'", disabled: true, autocomplete: "off" });
  const send = h("button.btn#send-btn", { disabled: true, html: `<span style="display:grid;place-items:center">${icons.send}</span>` });
  const mic = micButton(input, () => doSend(input));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSend(input); });
  send.addEventListener("click", () => doSend(input));
  const row = h("div.chat-input-row#chat-input-row", { hidden: true }, input, mic, send);
  return row;
}

function micButton(input, onFinal) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = h("button.icon-btn.tip", { "data-tip": "Voice input", "aria-label": "Voice input", html: `<span style="display:grid;place-items:center">${icons.mic}</span>` });
  if (!SR) { btn.style.display = "none"; return btn; }
  const rec = new SR(); rec.lang = "en-IN"; rec.interimResults = false;
  let on = false;
  btn.addEventListener("click", () => (on ? rec.stop() : rec.start()));
  rec.addEventListener("start", () => { on = true; btn.classList.add("on"); });
  rec.addEventListener("end", () => { on = false; btn.classList.remove("on"); });
  rec.addEventListener("result", (e) => { input.value = e.results[0][0].transcript; onFinal(); });
  return btn;
}

function mm(k, id, cls = "") {
  return h("div.mm", { class: cls }, h("div.k", { text: k }), h("div.v", { id, text: "—" }));
}

/* ---------- behaviour ---------- */
async function startSession(mandate_id, isRetry = false) {
  const btn = document.querySelector("#start-btn");
  btn.disabled = true; btn.textContent = "…";
  try {
    const res = await api.startSession({ mandate_id });
    state.sessionId = res.sessionId;
    state.mandate = res.mandate;
    store.set("currentMandateId", mandate_id);

    document.querySelector("#chat-setup").hidden = true;
    const bar = document.querySelector("#session-bar");
    bar.hidden = false;
    bar.innerHTML = "";
    bar.append(
      h("span", {}, h("span.who", { text: res.mandate.label }), " · ", h("span.key", { text: "signed by " + res.mandate.signed_by })),
      h("button.btn.btn-ghost.btn-sm", { text: "New session", onclick: () => navigate("/console") }),
    );

    document.querySelector("#chat-empty").hidden = true;
    const log = document.querySelector("#chat-log");
    log.hidden = false;
    if (res.memory?.length) addBubble(log, "sys", `Agent recalls ${res.memory.length} fact(s) about this shopper from earlier sessions.`);

    document.querySelector("#chat-input-row").hidden = false;
    const input = document.querySelector("#chat-input");
    input.disabled = false; document.querySelector("#send-btn").disabled = false;
    input.focus();
    setStage("plan");
  } catch (e) {
    btn.disabled = false; btn.textContent = "Start session";
    // Stale picker (a reset / redeploy rotated the mandate). Re-fetch the
    // list, rebuild the picker, and retry once against the matching one.
    if (!isRetry && /unknown mandate/i.test(e.message || "")) {
      try {
        const fresh = await api.mandates();
        store.set("mandates", fresh);
        const sel = document.querySelector("#mandate-pick");
        const match = fresh.find((m) => m.label === sel.options[sel.selectedIndex]?.text) || fresh[0];
        if (match) { sel.value = match.mandate_id; return startSession(match.mandate_id, true); }
      } catch {}
    }
    toast("Could not start session", e.message, "crit");
  }
}

async function doSend(input) {
  const text = input.value.trim();
  if (!text || !state.sessionId) return;
  input.value = "";
  const log = document.querySelector("#chat-log");
  addBubble(log, "user", text);

  const typing = h("div.typing", h("i"), h("i"), h("i"));
  log.appendChild(typing); log.scrollTop = log.scrollHeight;
  const send = document.querySelector("#send-btn");
  send.disabled = true; input.disabled = true;

  try {
    const r = await api.chat(state.sessionId, text);
    typing.remove();
    if (r.plan) addPlanCard(log, r.plan);
    addBubble(log, "agent", r.reply || "(no reply)");
    state.lastDraft = r.draft; state.lastConfirm = r.confirmation;
    renderCart(r.draft, r.confirmation);
    if (r.critique && !r.critique.ok) addBubble(log, "sys", `Grounding check flagged this reply; it was corrected before you saw it.`);
  } catch (e) {
    typing.remove();
    addBubble(log, "agent", "I couldn't reach my reasoning model just then. Nothing was charged.");
  } finally {
    send.disabled = false; input.disabled = false; input.focus();
  }
}

function addBubble(log, kind, text) {
  log.appendChild(h("div.bubble", { class: kind, text }));
  log.scrollTop = log.scrollHeight;
}
function addPlanCard(log, plan) {
  log.appendChild(h("div.plan-card", {},
    h("div.pc-intent", { text: "▸ " + plan.intent }),
    h("ol", {}, ...plan.steps.map((s) => h("li", {}, s.action, s.why ? h("span.why", { text: " — " + s.why }) : "" ))),
  ));
  log.scrollTop = log.scrollHeight;
}

function renderCart(draft, confirmation) {
  const slot = document.querySelector("#cart-slot");
  if (!slot) return;
  clear(slot);
  const c = confirmation || draft;
  if (!c || (!c.items && !c.total_paise)) return;
  const decision = c.decision || c.status;
  const items = c.items || [];

  const box = h("div.cart", {},
    h("div.cart-head", {}, h("span", { text: "Cart" }), h("span", { text: c.order_draft_id || "" })),
    ...items.map((i) => h("div.cart-line", {},
      h("span", {}, i.name, " ", h("span.q", { text: "×" + i.qty })),
      h("span", { text: fmtPaise(i.line_total_paise) }))),
    c.total_paise ? h("div.cart-total", {}, h("span", { text: "Total" }), h("span", { text: fmtPaise(c.total_paise) })) : "",
    h("div.cart-decision", { class: decision, text: c.reason || decision }),
  );

  if (c.upsell_suggestion) {
    box.appendChild(h("div.cart-upsell", {},
      `Suggested: ${c.upsell_suggestion.name} — ${fmtPaise(c.upsell_suggestion.price_paise)}`,
      h("div.rationale", { text: c.upsell_suggestion.rationale || c.upsell_suggestion.reason || "" })));
  }
  if (c.alternative) {
    box.appendChild(h("div.cart-upsell", { text: `Alternative: ${c.alternative.name} — ${fmtPaise(c.alternative.price_paise)}` }));
  }

  const actions = h("div.cart-actions");
  if ((c.status === "drafted" || decision === "approved" || decision === "needs_confirmation") && c.order_draft_id && !c.payment_link) {
    if (c.upsell_suggestion)
      actions.appendChild(h("button.btn.btn-sm", { text: "Add upsell & pay", onclick: () => confirmPay(c.order_draft_id, true) }));
    actions.appendChild(h("button.btn.btn-primary.btn-sm", { text: `Confirm & pay ${fmtPaise(c.total_paise)}`, onclick: () => confirmPay(c.order_draft_id, false) }));
  }
  if (c.payment_link)
    actions.appendChild(h("a.btn.btn-primary.btn-sm", { href: c.payment_link, target: "_blank", rel: "noopener", text: "Open payment page →" }));
  if (actions.children.length) box.appendChild(actions);

  slot.appendChild(box);
}

async function confirmPay(orderId, acceptUpsell) {
  setStage("settle");
  try {
    const r = await api.confirm(orderId, { sessionId: state.sessionId, accept_upsell: acceptUpsell });
    renderCart(null, r);
    if (r.status === "awaiting_payment") toast("Payment link created", "Budget is held, not spent. It settles on verified payment.", "ok");
    else if (r.status === "needs_confirmation") toast("Needs human approval", r.reason, "warn");
    else if (r.status === "blocked") toast("Blocked by the Gate", r.reason, "crit");
    else if (r.status === "failed") toast("Checkout failed — handled", r.reason, "crit");
  } catch (e) { toast("Confirm failed", e.message, "crit"); }
}

/* ---------- pipeline + trace ---------- */
function setStage(stage) {
  const i = STAGES.indexOf(stage);
  document.querySelectorAll("#pipeline .pstep").forEach((el) => {
    const j = STAGES.indexOf(el.dataset.step);
    el.classList.toggle("active", j === i);
    el.classList.toggle("done", j < i && i >= 0);
  });
}
function stageForEvent(t) {
  if (["session_started", "user_message", "turn_planned"].includes(t)) return "plan";
  if (["order_drafted", "buyer_policy_check", "cart_repriced", "checkout_blocked", "confirmation_required", "cart_mandate_rejected", "mandate_rejected"].includes(t)) return "gate";
  if (["reply_rejected", "prompt_injection_detected"].includes(t)) return "reflect";
  if (["checkout_approved", "payment_verified", "payment_duplicate_ignored", "checkout_failed", "hold_released", "payment_refunded"].includes(t)) return "settle";
  return null;
}

function renderTraces() {
  const list = document.querySelector("#trace-list");
  if (!list) return;
  const arr = [...store.get("traces").values()].slice(-5).reverse();
  const meta = document.querySelector("#trace-meta");
  const running = arr.find((t) => !t.ended);
  if (meta) meta.textContent = running ? `running · ${running.spans.length} spans` : "idle";

  if (!arr.length) { clear(list).appendChild(h("div.empty", { text: "No turns yet." })); return; }
  clear(list);
  for (const tr of arr) {
    const maxDur = Math.max(1, ...tr.spans.map((s) => s.duration_ms || 0));
    const turn = h("div.trace-turn", {},
      h("div.trace-turn-head", {},
        h("span.g", { text: tr.goal }),
        h("span.d", { text: tr.duration_ms != null ? (tr.duration_ms / 1000).toFixed(1) + "s" : "running…" })),
      tr.plan ? h("div.trace-plan", { text: "plan: " + tr.plan.join(" → ") }) : "",
      ...tr.spans.map((s) => {
        const w = s.duration_ms ? Math.max(4, (s.duration_ms / maxDur) * 100) : 30;
        return h("div.span-row", { class: s.status === "error" ? "err" : "" },
          h("span.span-dot", { class: s.type }),
          h("span.span-name", { html: `<span class="tag">${esc(s.type)}·</span>${esc(s.name)}` }),
          h("span.span-dur", { text: s.duration_ms != null ? s.duration_ms + "ms" : "···" }),
          h("span.span-bar", h("i", { style: { width: w + "%" } })),
        );
      }),
    );
    list.appendChild(turn);
  }
}

function paintMandate() {
  const id = store.get("currentMandateId");
  const m = (store.get("mandates") || []).find((x) => x.mandate_id === id) || (store.get("mandates") || [])[0];
  if (!m) return;
  const b = m.balance || {};
  const set = (sel, v) => { const el = document.querySelector(sel); if (el) el.textContent = v; };
  set("#mm-cap", fmtPaise(b.cap_paise));
  set("#mm-spent", fmtPaise(b.spent_paise));
  set("#mm-held", fmtPaise(b.held_paise));
  set("#mm-avail", fmtPaise(b.available_paise));
  const s = document.querySelector("#mm-bar-s"), hh = document.querySelector("#mm-bar-h");
  if (s && b.cap_paise) s.style.width = (100 * b.spent_paise / b.cap_paise) + "%";
  if (hh && b.cap_paise) hh.style.width = (100 * b.held_paise / b.cap_paise) + "%";
}
