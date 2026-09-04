// Guided tour — a spotlight overlay that steps through real UI.
//
// A step is:
//   { target: selector | () => el | null,   // null = centered card
//     title, body,
//     route?: "#/console",                   // navigate before showing
//     before?: async () => {},               // run before showing
//     waitFor?: () => boolean,               // poll until true before enabling Next
//     placement?: "auto"|"top"|"bottom"|"left"|"right",
//     spot?: number }                        // extra px around the target
//
// The tour survives route changes: it re-queries the target each frame
// so a step whose element only exists after navigation still locks on.

import { h } from "./dom.js";
import { navigate, currentPath } from "../router.js";

let active = null;

export function isTourActive() { return !!active; }

export function startTour(steps, { onDone } = {}) {
  if (active) active.abort();

  const scrim = h("div.tour-scrim");
  const mask = h("div.tour-mask");
  const pop = h("div.tour-pop");
  document.body.append(scrim, mask, pop);
  document.body.style.overflow = "hidden";

  let idx = -1;
  let raf = 0;
  let aborted = false;

  const state = { abort };

  function abort() {
    aborted = true;
    cancelAnimationFrame(raf);
    scrim.remove(); mask.remove(); pop.remove();
    document.body.style.overflow = "";
    active = null;
  }

  function finish() {
    abort();
    onDone?.();
  }

  async function go(n) {
    if (aborted) return;
    if (n < 0 || n >= steps.length) return finish();
    idx = n;
    const step = steps[idx];

    if (step.route && currentPath() !== step.route.replace("#", "")) {
      navigate(step.route.replace("#", ""));
      await sleep(360);
    }
    if (step.before) { try { await step.before(); } catch (e) { console.error(e); } }
    if (step.waitFor) await pollUntil(step.waitFor, 6000);

    renderPop(step);
    track(step);
  }

  function renderPop(step) {
    pop.innerHTML = "";
    pop.append(
      h("div.tour-step", { text: `Step ${idx + 1} of ${steps.length}` }),
      h("h4", { text: step.title }),
      h("p", { html: step.body }),
      h("div.tour-foot", {},
        h("button.btn.btn-ghost.btn-sm", { text: "Skip tour", onclick: finish }),
        h("div.row.gap-1", {},
          h("div.tour-dots", {}, ...steps.map((_, i) => h("i", { class: i === idx ? "on" : "" }))),
          idx > 0 && h("button.btn.btn-sm", { text: "Back", onclick: () => go(idx - 1) }),
          h("button.btn.btn-primary.btn-sm", {
            text: idx === steps.length - 1 ? "Finish" : "Next",
            onclick: () => go(idx + 1),
          }),
        ),
      ),
    );
  }

  function track(step) {
    cancelAnimationFrame(raf);
    const loop = () => {
      if (aborted) return;
      const el = resolveTarget(step.target);
      if (el) {
        const r = el.getBoundingClientRect();
        const pad = step.spot ?? 8;
        Object.assign(mask.style, {
          display: "block",
          top: `${r.top - pad}px`, left: `${r.left - pad}px`,
          width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
        });
        placePop(pop, r, step.placement || "auto");
      } else {
        // centered card, no spotlight
        mask.style.display = "none";
        Object.assign(pop.style, {
          top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        });
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  active = state;
  go(0);
  return state;
}

function resolveTarget(t) {
  if (!t) return null;
  try { return typeof t === "function" ? t() : document.querySelector(t); }
  catch { return null; }
}

function placePop(pop, r, placement) {
  const pw = pop.offsetWidth || 340;
  const ph = pop.offsetHeight || 200;
  const gap = 14;
  const vw = innerWidth, vh = innerHeight;

  let place = placement;
  if (place === "auto") {
    if (r.bottom + gap + ph < vh) place = "bottom";
    else if (r.top - gap - ph > 0) place = "top";
    else if (r.right + gap + pw < vw) place = "right";
    else place = "left";
  }

  let top, left;
  if (place === "bottom") { top = r.bottom + gap; left = r.left + r.width / 2 - pw / 2; }
  else if (place === "top") { top = r.top - gap - ph; left = r.left + r.width / 2 - pw / 2; }
  else if (place === "right") { top = r.top + r.height / 2 - ph / 2; left = r.right + gap; }
  else { top = r.top + r.height / 2 - ph / 2; left = r.left - gap - pw; }

  top = Math.max(12, Math.min(top, vh - ph - 12));
  left = Math.max(12, Math.min(left, vw - pw - 12));
  Object.assign(pop.style, { top: `${top}px`, left: `${left}px`, transform: "none" });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pollUntil(fn, timeout) {
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (fn() || Date.now() - start > timeout) { clearInterval(t); resolve(); }
    }, 120);
  });
}
