import { h, clear, esc, hlJson, timeOf } from "../ui/dom.js";
import { icons } from "../ui/icons.js";
import { store } from "../store.js";
import { sse } from "../sse.js";
import { api } from "../api.js";
import { toast } from "../ui/toast.js";
import { openModal } from "../ui/modal.js";
import { createChain3D } from "../gl/chain3d.js";
import { skelLines } from "../ui/skeleton.js";

let chain = null;
let offs = [];
let filter = "all";

export default {
  async render(mount) {
    filter = "all";
    const page = h("div.page", { style: { paddingBlock: "1.5rem 3rem" } });

    page.append(
      h("div.section-head", { style: { marginBottom: "1rem" } },
        h("span.eyebrow", { text: "The Ledger" }),
        h("h2", { text: "Hash-chained, and you can prove it" }),
        h("p.lede", { text: "Every trust-layer decision, linked to the one before it. Verify the chain from genesis on demand — or break it yourself and watch the check catch it." })),
      h("div.ledger-hero", {},
        h("canvas#ledger-canvas", { "aria-hidden": "true" }),
        h("div.lh-overlay", { id: "lh-overlay", text: "chain height —" })),
      h("div.chain-status.ok#chain-status", {},
        h("span#chain-text", { text: "verifying…" }),
        h("span.hh#chain-head", { text: "" })),
      h("div.ledger-toolbar", {},
        h("button.btn.btn-sm", { onclick: doVerify }, iconSpan(icons.check), " Verify chain"),
        h("button.btn.btn-sm.btn-danger", { onclick: showBreakGuide }, iconSpan(icons.alert), " How to break it"),
        h("div.grow"),
        h("div.ledger-filter#ledger-filter"),
      ),
      h("section.panel", {},
        h("div.panel-head", {}, h("h3", { text: "Events" }), h("span.label#feed-count", { text: "" })),
        h("div.feed#feed", skelLines(6, ["90", "70", "80", "60", "85", "70"])),
      ),
    );
    mount.appendChild(page);

    // 3D banner
    const cv = page.querySelector("#ledger-canvas");
    chain = createChain3D(cv, { count: 8, size: 0.5, spin: 0.0016, arc: 0.2 });
    chain.start();

    buildFilter(page);
    await loadEvents();
    await doVerify(true);

    offs.push(sse.onAudit((ev) => {
      chain?.addBlock();
      prependEvent(ev, true);
      const cnt = document.querySelector("#feed-count");
      if (cnt) cnt.textContent = (ev.seq + 1) + " records";
      const ov = document.querySelector("#lh-overlay");
      if (ov) ov.textContent = "chain height " + (ev.seq + 1);
    }));
  },
  destroy() { chain?.destroy(); chain = null; offs.forEach((f) => f()); offs = []; },
};

const CATS = [
  ["all", "All"],
  ["blocked", "Blocked"],
  ["needs_confirmation", "Gated"],
  ["approved", "Approved"],
  ["failed", "Failed"],
];

function buildFilter(root) {
  const wrap = root.querySelector("#ledger-filter");
  clear(wrap);
  CATS.forEach(([val, label]) => {
    wrap.appendChild(h("button.btn.btn-sm", {
      class: filter === val ? "btn-primary" : "",
      text: label,
      onclick: () => { filter = val; buildFilter(root); repaintFeed(); },
    }));
  });
}

async function loadEvents() {
  try {
    const events = await api.audit("limit=200");
    store.set("events", events);
    repaintFeed();
    const cnt = document.querySelector("#feed-count");
    if (cnt) cnt.textContent = (events[events.length - 1]?.seq + 1 || 0) + " records";
    const ov = document.querySelector("#lh-overlay");
    if (ov) ov.textContent = "chain height " + (events[events.length - 1]?.seq + 1 || 0);
  } catch (e) {
    const feed = document.querySelector("#feed");
    if (feed) clear(feed).appendChild(h("div.empty", { text: "Couldn't load the ledger. Is the server running?" }));
  }
}

function repaintFeed() {
  const feed = document.querySelector("#feed");
  if (!feed) return;
  clear(feed);
  const events = (store.get("events") || []).slice().reverse()
    .filter((e) => filter === "all" || e.decision === filter);
  if (!events.length) { feed.appendChild(h("div.empty", { text: "No records match this filter yet." })); return; }
  for (const ev of events.slice(0, 160)) feed.appendChild(evRow(ev));
}

function prependEvent(ev, flash) {
  if (filter !== "all" && ev.decision !== filter) return;
  const feed = document.querySelector("#feed");
  if (!feed) return;
  if (feed.querySelector(".empty")) clear(feed);
  const row = evRow(ev, flash);
  feed.prepend(row);
  while (feed.children.length > 180) feed.lastChild.remove();
}

function evRow(ev, flash) {
  const critical = ev.severity === "critical" || ev.decision === "blocked" || ev.decision === "failed";
  const row = h("div.ev", { class: `${critical ? "crit" : ""} ${flash ? "flash" : ""}` },
    h("div.ev-top", {},
      h("span.ev-seq", { text: "#" + ev.seq }),
      h("span.chip", { class: ev.decision, text: ev.decision }),
      h("span.ev-type", { text: ev.event_type }),
      h("span.ev-actor", { text: ev.actor })),
    h("div.ev-reason", { text: ev.reason }),
    h("div.ev-hash", { text: ev.hash ? `${ev.hash.slice(0, 18)}…  ◂ prev ${ev.prev_hash.slice(0, 10)}…` : "" }),
    h("div.ev-json.code", { html: hlJson(ev) }),
  );
  row.addEventListener("click", () => row.classList.toggle("open"));
  return row;
}

async function doVerify(silent) {
  try {
    const v = await api.verifyChain();
    store.set("chain", { ...v, seq: (v.length || 1) - 1 });
    const el = document.querySelector("#chain-status");
    if (el) {
      el.className = "chain-status " + (v.ok ? "ok" : "bad");
      document.querySelector("#chain-text").textContent = v.detail;
      document.querySelector("#chain-head").textContent = v.head_hash ? "head " + v.head_hash.slice(0, 14) + "…" : "";
    }
    if (!silent) toast(v.ok ? "Chain intact" : "CHAIN BROKEN", v.detail, v.ok ? "ok" : "crit");
  } catch (e) {
    if (!silent) toast("Verify failed", e.message, "crit");
  }
}

function showBreakGuide() {
  const body = h("div.stack.gap-3", {},
    h("p.dim", { style: { fontSize: ".9rem", lineHeight: "1.6" },
      html: "The ledger is an ordinary append-only file. Its integrity comes from the hash chain, not from being hidden. Break it in three steps:" }),
    h("ol", { style: { paddingLeft: "1.2rem", fontSize: ".88rem", lineHeight: "1.7", color: "var(--text-dim)" } },
      h("li", {}, "Open ", h("code", { text: "commerce-agent/data/audit-log.jsonl" }), " in any editor."),
      h("li", {}, "Change one character inside any record's ", h("code", { text: '"reason"' }), " — a typo will do."),
      h("li", {}, "Save, come back here, and hit ", h("strong", { text: "Verify chain" }), ".")),
    h("div.code", { text: "$ npm run verify:ledger    # or the button here\n\n  BROKEN at seq 14  (order_drafted)\n  stored hash     8f3a…   recomputed 21c9…\n  This event's contents were changed after it was written." }),
    h("p.faint", { style: { fontSize: ".82rem" }, text: "Because every later record's hash folds in this one, the chain stays broken from that point on — you can't fix it by editing just the hash." }),
  );
  openModal({
    title: "Break the ledger",
    subtitle: "Then watch verification name the exact record.",
    body,
    actions: [{ label: "Verify now", kind: "primary", onClick: () => doVerify(false) }, { label: "Close", kind: "ghost" }],
  });
}

function iconSpan(svg) { const s = h("span"); s.style.cssText = "display:inline-grid;place-items:center"; s.innerHTML = svg; const g = s.firstElementChild; if (g) { g.setAttribute("width", "1em"); g.setAttribute("height", "1em"); } return s; }
