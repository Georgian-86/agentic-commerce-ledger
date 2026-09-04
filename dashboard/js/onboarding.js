// First-run experience: an intro modal (3 slides) → optional guided
// tour. Both fully skippable. Replayable from the nav "Tour" button.

import { h } from "./ui/dom.js";
import { openModal } from "./ui/modal.js";
import { startTour } from "./ui/tour.js";
import { navigate } from "./router.js";
import { store } from "./store.js";
import { icons } from "./ui/icons.js";
import { createChain3D } from "./gl/chain3d.js";

const SLIDES = [
  {
    kicker: "The problem",
    title: "An AI agent is about to spend your money",
    body: "Agents can now browse a shop and check out on your behalf. The question every payments team is asking: how does the merchant know the agent is actually allowed to — and prove it afterwards?",
    art: "chain",
  },
  {
    kicker: "The answer",
    title: "Mandate → Gate → Ledger",
    body: "The agent carries a <b>signed mandate</b> — a spending cap, allowed categories, an expiry — signed by <i>your</i> wallet, not the shop. Every purchase is checked by a <b>Gate</b> written in code no prompt can talk around. Every decision lands in a <b>hash-chained ledger</b> you can verify.",
    art: "flow",
  },
  {
    kicker: "You can break it",
    title: "Nothing here asks for your trust",
    body: "Tamper with a mandate and watch the Gate reject it. Edit one byte of the ledger and watch verification name the broken record. Two independent parties, cryptographic proof, live.",
    art: "shield",
  },
];

export function runOnboarding({ force = false } = {}) {
  if (!force && store.get("onboarded")) return;

  let slide = 0;
  const artHost = h("div", { style: { height: "180px", margin: "-.5rem 0 1rem", borderRadius: "var(--r-md)", overflow: "hidden", background: "var(--surface-0)", border: "1px solid var(--line)" } });
  const kicker = h("div.eyebrow");
  const titleEl = h("h3", { style: { fontSize: "var(--step-2)", margin: ".3rem 0 .5rem" } });
  const bodyEl = h("p", { class: "dim", style: { fontSize: ".9rem", lineHeight: "1.6" } });
  const dots = h("div.tour-dots", { style: { justifyContent: "center", margin: "1.2rem 0 0" } },
    ...SLIDES.map(() => h("i")));

  const body = h("div", {}, artHost, kicker, titleEl, bodyEl, dots);

  let chain = null;
  function paint() {
    kicker.textContent = SLIDES[slide].kicker;
    titleEl.textContent = SLIDES[slide].title;
    bodyEl.innerHTML = SLIDES[slide].body;
    dots.querySelectorAll("i").forEach((d, i) => d.classList.toggle("on", i === slide));
    renderArt(SLIDES[slide].art);
    nextBtn.textContent = slide === SLIDES.length - 1 ? "Start the tour" : "Next";
    backBtn.style.visibility = slide === 0 ? "hidden" : "visible";
  }

  function renderArt(kind) {
    artHost.innerHTML = "";
    if (chain) { chain.destroy(); chain = null; }
    if (kind === "chain" || kind === "shield") {
      const cv = h("canvas", { style: { width: "100%", height: "100%" } });
      artHost.appendChild(cv);
      chain = createChain3D(cv, { count: kind === "shield" ? 5 : 6, size: 0.5, interactive: false, spin: 0.004 });
      chain.start();
      if (kind === "shield") setTimeout(() => chain?.addBlock(), 500);
    } else {
      artHost.appendChild(flowArt());
    }
  }

  const backBtn = h("button.btn.btn-ghost.btn-sm", { text: "Back", onclick: () => { slide = Math.max(0, slide - 1); paint(); } });
  const skipBtn = h("button.btn.btn-ghost.btn-sm", { text: "Skip", onclick: () => finish(false) });
  const nextBtn = h("button.btn.btn-primary.btn-sm", {
    text: "Next",
    onclick: () => {
      if (slide < SLIDES.length - 1) { slide++; paint(); }
      else finish(true);
    },
  });

  const m = openModal({
    title: "Welcome to Agentic Bazaar",
    subtitle: "90 seconds on what this is — skip any time.",
    body,
    wide: true,
    onClose: () => { if (chain) chain.destroy(); },
  });
  // custom footer
  m.modal.querySelector(".modal-foot")?.remove();
  m.modal.appendChild(h("div.modal-foot", {}, skipBtn, h("div.row.gap-1", {}, backBtn, nextBtn)));

  paint();

  function finish(startTheTour) {
    store.markOnboarded();
    m.close();
    if (startTheTour) setTimeout(() => runGuidedTour(), 260);
  }
}

export function runGuidedTour() {
  navigate("/");
  const steps = [
    {
      target: () => document.querySelector(".hero-canvas-wrap"),
      title: "The ledger, alive",
      body: "Each cube is one record. They're hash-linked — change any one and every cube after it stops matching. New records seal in here as they happen.",
      placement: "left",
      route: "#/",
    },
    {
      target: () => document.querySelector(".hero-cta .btn-primary"),
      title: "Two ways in",
      body: "The in-app agent you'll try in a second — and an <b>external</b> MCP endpoint any AI client can connect to and buy from. Same rules for both.",
      placement: "top",
    },
    {
      target: () => document.querySelector('.nav-link[href="#/console"]'),
      title: "The console",
      body: "Where you talk to the shopper agent and watch it plan, act, and get checked. Let's go there.",
      placement: "bottom",
    },
    {
      target: () => document.querySelector("#pipeline"),
      title: "Plan → Act → Gate → Reflect → Settle",
      body: "Every turn runs these five stages. This bar lights up as the agent moves through them — it's not a spinner, it's the real execution.",
      route: "#/console",
      placement: "bottom",
    },
    {
      target: () => document.querySelector("#chat-setup") || document.querySelector("#session-bar"),
      title: "Pick a shopper, start a session",
      body: "Each shopper has a different signed mandate — a gift budget, an all-category budget, a cautious one. The agent can only ever spend inside it.",
      placement: "bottom",
    },
    {
      target: () => document.querySelector("#trace-panel"),
      title: "The agent's working",
      body: "Plan, model calls, catalog tool calls, and a grounding check on the reply — each a span with real timings. If the agent quotes a price that wasn't in a tool result, the check bounces it.",
      placement: "left",
    },
    {
      target: () => document.querySelector("#mini-mandate"),
      title: "Held, not spent",
      body: "When you confirm a purchase the amount moves to <b>on&nbsp;hold</b> — it only becomes <b>settled</b> when a signed payment confirmation arrives. Abandon the checkout and the hold is released.",
      placement: "top",
    },
    {
      target: () => document.querySelector('.nav-link[href="#/mandates"]'),
      title: "Break it yourself",
      body: "On the Mandates page: change a mandate's cap, leave the signature untouched, present it to the Gate. Watch it get rejected — live.",
      route: "#/mandates",
      placement: "bottom",
    },
    {
      target: () => document.querySelector("#tamper-btn"),
      title: "Tamper &amp; present",
      body: "This forges the cap to ₹9,99,999 and sends it through the exact same Gate every real order uses. No special-casing.",
      placement: "top",
    },
    {
      target: () => document.querySelector('.nav-link[href="#/ledger"]'),
      title: "And verify the record",
      body: "The Ledger page verifies the whole hash chain from genesis on demand — and shows you how to break it so you can see the check actually work.",
      route: "#/ledger",
      placement: "bottom",
    },
    {
      target: null,
      title: "That's the tour",
      body: "You can replay it any time from <b>Tour</b> in the top bar. Go break something.",
    },
  ];
  startTour(steps, { onDone: () => navigate("/console") });
}

function flowArt() {
  const wrap = h("div.center", { style: { height: "100%", gap: "0", padding: "0 1rem" } });
  const node = (label, ico) => h("div.stack.center.gap-1", { style: { flex: "1" } },
    h("div", { style: { width: "42px", height: "42px", borderRadius: "12px", background: "var(--iris-ghost)", border: "1px solid var(--iris-line)", display: "grid", placeItems: "center", color: "var(--iris-bright)", fontSize: "20px" }, html: ico }),
    h("div.label", { text: label }),
  );
  const arrow = () => h("div", { style: { color: "var(--text-faint)", padding: "0 .5rem", fontSize: "18px", display: "grid", placeItems: "center" }, html: icons.arrow });
  wrap.append(node("Mandate", icons.lock), arrow(), node("Gate", icons.shield), arrow(), node("Ledger", icons.ledger));
  return wrap;
}
