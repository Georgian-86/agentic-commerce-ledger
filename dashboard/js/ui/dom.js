// Minimal DOM helpers used everywhere.

/** h("div.card#id", { onclick }, ...children)
 *  - A class token may contain spaces ("span.pill live") — each word
 *    becomes its own class.
 *  - The 2nd arg is treated as a props object ONLY when it's a plain
 *    object. A Node, array, string, number or nullish 2nd arg is the
 *    first child, so `h("div", someEl, otherEl)` works. */
function isProps(v) {
  return v != null && typeof v === "object" && !Array.isArray(v) && !v.nodeType
    && Object.getPrototypeOf(v) === Object.prototype;
}

export function h(spec, props, ...kids) {
  if (!isProps(props)) {
    if (props !== undefined) kids = [props, ...kids];
    props = null;
  }
  const [tag, ...rest] = spec.split(/(?=[.#])/);
  const el = document.createElement(tag || "div");
  for (const token of rest) {
    if (token[0] === ".") {
      token.slice(1).trim().split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
    } else if (token[0] === "#") {
      el.id = token.slice(1).trim();
    }
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className += " " + v;
      else if (k === "html") el.innerHTML = v;
      else if (k === "text") el.textContent = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el) { try { el[k] = v; } catch { el.setAttribute(k, v); } }
      else el.setAttribute(k, v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

export const fmtPaise = (p) => "₹" + Math.round((p || 0) / 100).toLocaleString("en-IN");
export const fmtPaiseExact = (p) => {
  const r = Math.trunc((p || 0) / 100), c = Math.abs((p || 0) % 100);
  return "₹" + r.toLocaleString("en-IN") + (c ? "." + String(c).padStart(2, "0") : "");
};
export const timeOf = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Animate a number from its current value to `to`. */
export function countTo(el, to, { dur = 900, fmt = (n) => Math.round(n).toLocaleString("en-IN"), prefix = "" } = {}) {
  const from = Number(el.__cv || 0);
  if (from === to) { el.textContent = prefix + fmt(to); return; }
  el.__cv = to;
  const start = performance.now();
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) { el.textContent = prefix + fmt(to); return; }
  function tick(now) {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = prefix + fmt(from + (to - from) * eased);
    if (t < 1 && el.__cv === to) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/** syntax-highlight a JSON string for .code blocks */
export function hlJson(obj) {
  const json = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return esc(json)
    .replace(/&quot;([\w-]+)&quot;:/g, '<span class="k">&quot;$1&quot;</span>:')
    .replace(/: &quot;([^&]*)&quot;/g, ': <span class="s">&quot;$1&quot;</span>')
    .replace(/: (-?\d+(?:\.\d+)?)/g, ': <span class="n">$1</span>')
    .replace(/&quot;(signature|proof|hash|prev_hash)&quot;/g, '<span class="sig">&quot;$1&quot;</span>');
}

export function copyToClipboard(text, btn) {
  navigator.clipboard?.writeText(text).then(() => {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = "copied";
    setTimeout(() => (btn.textContent = orig), 1200);
  });
}
