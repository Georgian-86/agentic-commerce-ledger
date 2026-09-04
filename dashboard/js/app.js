// Bootstrap: fonts settle, first data loads, nav wires up, router
// starts, SSE connects, first-run onboarding fires.

import { api } from "./api.js";
import { store } from "./store.js";
import { connectSSE, sse } from "./sse.js";
import { defineRoute, initRouter, navigate, currentPath } from "./router.js";
import { icons } from "./ui/icons.js";
import { toast } from "./ui/toast.js";
import { $, $$ } from "./ui/dom.js";
import { runOnboarding, runGuidedTour } from "./onboarding.js";

/* -------- theme -------- */
const themeToggle = $("#theme-toggle");
function currentTheme() {
  return document.documentElement.getAttribute("data-theme")
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("acl.theme", t); } catch {}
  themeToggle.innerHTML = `<span style="display:grid;place-items:center">${t === "dark" ? icons.sun : icons.moon}</span>`;
}
try {
  const saved = localStorage.getItem("acl.theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
} catch {}
applyTheme(currentTheme());
themeToggle.addEventListener("click", () => applyTheme(currentTheme() === "dark" ? "light" : "dark"));

/* -------- nav active state -------- */
function syncNav(path) {
  $$(".nav-link").forEach((a) => {
    const to = a.getAttribute("href").slice(1);
    a.classList.toggle("active", to === path || (to !== "/" && path.startsWith(to)));
  });
}

$("#replay-tour").addEventListener("click", () => runGuidedTour());

/* -------- rail pill (demo / live) -------- */
function syncRail(health) {
  const pill = $("#rail-pill");
  if (!health) return;
  if (health.demo_mode) {
    pill.className = "pill demo";
    pill.innerHTML = `<span class="dot"></span>DEMO MODE`;
  } else {
    pill.className = "pill live";
    pill.innerHTML = `<span class="dot"></span>RAZORPAY TEST`;
  }
}

/* -------- routes (lazy) -------- */
defineRoute("/",          () => import("./views/landing.js"));
defineRoute("/console",   () => import("./views/console.js"));
defineRoute("/ledger",    () => import("./views/ledger.js"));
defineRoute("/mandates",  () => import("./views/mandates.js"));
defineRoute("/agents",    () => import("./views/agents.js"));

/* -------- scroll reveal (shared) --------
   Enabled only after JS is confirmed running, and every observed
   element has a hard timeout fallback so nothing can stay hidden. */
document.documentElement.classList.add("js-reveal");
const scrollRoot = $("#app");
const revealObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) { e.target.classList.add("in"); revealObserver.unobserve(e.target); }
  }
}, { root: scrollRoot, threshold: 0, rootMargin: "0px 0px -6% 0px" });

window.__reveal = (root = document) => {
  root.querySelectorAll("[data-reveal]").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.top < innerHeight * 1.05) { el.classList.add("in"); return; }
    revealObserver.observe(el);
    setTimeout(() => el.classList.add("in"), 2200);
  });
};

/* -------- boot -------- */
const boot = $("#boot");
const bootMsg = $("#boot-msg");

async function bootstrap() {
  // wait a beat for webfonts so the first paint isn't a flash of fallback
  if (document.fonts?.ready) { try { await Promise.race([document.fonts.ready, wait(1200)]); } catch {} }

  bootMsg.textContent = "loading mandates & metrics…";
  const [health, metrics, mandates, chain] = await Promise.allSettled([
    api.health(), api.metrics(), api.mandates(), api.verifyChain(),
  ]);

  if (health.status === "fulfilled") { store.set("health", health.value); syncRail(health.value); }
  if (metrics.status === "fulfilled") store.set("metrics", metrics.value);
  if (mandates.status === "fulfilled") {
    store.set("mandates", mandates.value);
    if (mandates.value[0]) store.set("currentMandateId", mandates.value[0].mandate_id);
  }
  if (chain.status === "fulfilled") store.set("chain", { ...chain.value, seq: chain.value.length - 1 });

  if (health.status === "rejected") {
    toast("Backend unreachable", "Start it with `npm run dev`, then reload.", "crit", 0);
  }

  connectSSE();
  sse.onStatus((s) => {
    // reflected per-view; also keep a subtle global cue via the rail pill dot
  });
  sse.onAudit((ev) => {
    // keep chain head fresh globally
    store.set("chain", { ...(store.get("chain") || {}), seq: ev.seq, hash: ev.hash });
  });

  // periodic light refresh of metrics + health + mandate balances
  setInterval(async () => {
    try {
      const [m, hh, mm] = await Promise.all([api.metrics(), api.health(), api.mandates()]);
      store.set("metrics", m); store.set("health", hh); store.set("mandates", mm); syncRail(hh);
    } catch {}
  }, 9000);

  // reveal nav, start router
  $("#nav").hidden = false;
  initRouter($("#app"), { onChange: (p) => syncNav(p) });
  syncNav(currentPath());

  boot.classList.add("gone");
  setTimeout(() => boot.remove(), 400);

  // first-run onboarding (skippable) — only on the landing route
  if (currentPath() === "/") runOnboarding();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
bootstrap();
