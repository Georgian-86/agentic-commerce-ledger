import { h, clear, esc, hlJson, fmtPaise } from "../ui/dom.js";
import { icons } from "../ui/icons.js";
import { store } from "../store.js";
import { sse } from "../sse.js";
import { api } from "../api.js";
import { toast } from "../ui/toast.js";
import { openModal } from "../ui/modal.js";
import { skelLines } from "../ui/skeleton.js";

let offs = [];
let selected = null;

export default {
  async render(mount) {
    const mandates = store.get("mandates") || [];
    selected = store.get("currentMandateId") || mandates[0]?.mandate_id;

    const layout = h("div.mandate-layout.page");

    const personaList = h("div.persona-list#persona-list");
    const detail = h("div.stack.gap-3#mandate-detail");

    layout.append(
      h("div.stack.gap-3", {},
        h("div", {}, h("span.eyebrow", { text: "Credentials" }), h("h2", { style: { marginTop: ".4rem" }, text: "Signed by the shopper" })),
        personaList,
      ),
      detail,
    );
    mount.appendChild(layout);

    renderPersonas();
    await renderDetail();

    offs.push(sse.onAudit((ev) => { if (ev.mandate_id === selected) refreshBalances(); }));
    offs.push(store.on("mandates", () => { renderPersonas(); refreshBalances(); }));
  },
  destroy() { offs.forEach((f) => f()); offs = []; },
};

function renderPersonas() {
  const list = document.querySelector("#persona-list");
  if (!list) return;
  clear(list);
  for (const m of store.get("mandates") || []) {
    const c = m.constraints || {};
    list.appendChild(h("button.persona", {
      class: m.mandate_id === selected ? "on" : "",
      onclick: () => { selected = m.mandate_id; store.set("currentMandateId", m.mandate_id); renderPersonas(); renderDetail(); },
    },
      h("div.p-name", { text: m.label.split("—")[0].trim() }),
      h("div.p-meta", { text: `${fmtPaise(c.max_amount_paise)} cap · ${(c.allowed_categories || []).join(", ")}` }),
    ));
  }
}

async function renderDetail() {
  const host = document.querySelector("#mandate-detail");
  if (!host) return;
  clear(host);
  host.append(h("section.panel", {}, skelLines(4, ["50", "80", "70", "60"])));

  const m = (store.get("mandates") || []).find((x) => x.mandate_id === selected);
  if (!m) return;

  let cred;
  try { cred = await api.credential(selected); } catch { cred = null; }

  clear(host);

  /* balance ring + legend */
  const b = m.balance || {};
  host.append(
    h("section.panel", {},
      h("div.panel-head", {}, h("h3", { text: "Balance" }), h("span.label", { text: m.mandate_id })),
      h("div.cred-ring-wrap", {},
        ringSvg(b),
        h("div.cred-legend", {},
          legend("var(--ok)", "Settled", fmtPaise(b.spent_paise)),
          legend("var(--warn)", "On hold", fmtPaise(b.held_paise)),
          legend("var(--iris-bright)", "Available", fmtPaise(b.available_paise)),
          legend("var(--line-bright)", "Cap", fmtPaise(b.cap_paise)),
        ),
      ),
    ),
    h("section.panel", {},
      h("div.panel-head", {},
        h("h3", { text: "The credential" }),
        h("span.label", { text: cred?.mandate?.proof?.key_id || "" })),
      h("p.faint", { style: { fontSize: ".8rem", margin: "-.4rem 0 .7rem" },
        text: "Ed25519 detached signature. The merchant verifies this against the user's public key — it can't produce one." }),
      h("div.code#cred-json", { html: cred ? hlJson(cred.mandate) : "unavailable" }),
      h("div.cart-actions", { style: { marginTop: ".8rem" } },
        h("button.btn.btn-danger.btn-sm#tamper-btn", { onclick: () => runTamper(m) }, iconSpan(icons.alert), " Tamper & present it"),
        h("button.btn.btn-ghost.btn-sm", { text: "Show clean credential", onclick: () => renderDetail() }),
      ),
      h("div#tamper-verdict"),
    ),
    h("section.panel", {},
      h("div.panel-head", {}, h("h3", { text: "This mandate's records" }), h("span.label#mh-count", { text: "" })),
      h("div.feed#mandate-history", skelLines(3, ["80", "60", "70"])),
    ),
  );

  loadHistory();
}

function ringSvg(b) {
  const total = b.cap_paise || 1;
  const spent = (b.spent_paise || 0) / total;
  const held = (b.held_paise || 0) / total;
  const C = 2 * Math.PI * 54;
  const seg = (frac, offset, color) => {
    const n = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    n.setAttribute("cx", 70); n.setAttribute("cy", 70); n.setAttribute("r", 54);
    n.setAttribute("fill", "none"); n.setAttribute("stroke", color); n.setAttribute("stroke-width", 14);
    n.setAttribute("stroke-dasharray", `${frac * C} ${C}`);
    n.setAttribute("stroke-dashoffset", -offset * C);
    n.setAttribute("transform", "rotate(-90 70 70)");
    n.style.transition = "stroke-dasharray .7s cubic-bezier(.16,1,.3,1)";
    return n;
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 140 140");
  svg.classList.add("cred-ring");
  const track = seg(1, 0, "var(--surface-3)");
  svg.append(track, seg(1 - spent - held, spent + held, "var(--iris-bright)"), seg(held, spent, "var(--warn)"), seg(spent, 0, "var(--ok)"));
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("x", 70); label.setAttribute("y", 66); label.setAttribute("text-anchor", "middle");
  label.setAttribute("fill", "var(--text)"); label.setAttribute("font-size", "17"); label.setAttribute("font-family", "var(--font-display)"); label.setAttribute("font-weight", "600");
  label.textContent = Math.round((1 - spent - held) * 100) + "%";
  const sub = document.createElementNS("http://www.w3.org/2000/svg", "text");
  sub.setAttribute("x", 70); sub.setAttribute("y", 82); sub.setAttribute("text-anchor", "middle");
  sub.setAttribute("fill", "var(--text-faint)"); sub.setAttribute("font-size", "8"); sub.setAttribute("font-family", "var(--font-mono)");
  sub.textContent = "available";
  svg.append(label, sub);
  return svg;
}

function legend(color, label, val) {
  return h("div.cl", {}, h("i", { style: { background: color } }), h("span.dim", { text: label }), h("strong", { style: { marginLeft: "auto" }, text: val }));
}

async function runTamper(m) {
  const btn = document.querySelector("#tamper-btn");
  btn.disabled = true;
  try {
    const res = await api.tamper(m.mandate_id, {
      field: "max_amount_paise", value: 99999900,
      items: [{ product_id: "sku-014", qty: 1 }],
    });

    // show forged credential with the field highlighted
    const cred = await api.credential(m.mandate_id);
    const forged = JSON.parse(JSON.stringify(cred.mandate));
    forged.constraints.max_amount_paise = 99999900;
    let html = hlJson(forged).replace(
      /<span class="n">99999900<\/span>/,
      '<span class="tampered">99999900</span> <span class="n">// changed — signature NOT re-signed</span>'
    );
    document.querySelector("#cred-json").innerHTML = html;

    const verdict = document.querySelector("#tamper-verdict");
    clear(verdict);
    const r = res.result;
    verdict.appendChild(h("div.cart-decision", { class: r.decision, style: { marginTop: ".8rem" },
      text: `Presented to the Gate → ${r.decision.toUpperCase()}: ${r.reason}` }));

    toast("Tampered mandate rejected", "Cap forged to ₹9,99,999, signature untouched. The Gate verified it against the user key and refused.", "ok");
  } catch (e) {
    toast("Tamper demo failed", e.message, "crit");
  } finally {
    btn.disabled = false;
  }
}

async function loadHistory() {
  const box = document.querySelector("#mandate-history");
  if (!box) return;
  try {
    const events = await api.audit(`mandate_id=${encodeURIComponent(selected)}&limit=40`);
    clear(box);
    document.querySelector("#mh-count").textContent = events.length + " records";
    if (!events.length) { box.appendChild(h("div.empty", { text: "No records for this mandate yet — start a session in the console." })); return; }
    for (const ev of events.slice().reverse()) {
      box.appendChild(h("div.ev", {},
        h("div.ev-top", {},
          h("span.ev-seq", { text: "#" + ev.seq }),
          h("span.chip", { class: ev.decision, text: ev.decision }),
          h("span.ev-type", { text: ev.event_type })),
        h("div.ev-reason", { text: ev.reason })));
    }
  } catch {
    clear(box).appendChild(h("div.empty", { text: "Couldn't load history." }));
  }
}

async function refreshBalances() {
  try {
    const mandates = await api.mandates();
    store.set("mandates", mandates);
  } catch {}
}

function iconSpan(svg) { const s = h("span"); s.style.cssText = "display:inline-grid;place-items:center"; s.innerHTML = svg; const g = s.firstElementChild; if (g) { g.setAttribute("width", "1em"); g.setAttribute("height", "1em"); } return s; }
