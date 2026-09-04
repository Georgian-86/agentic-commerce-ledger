import { h, countTo } from "../ui/dom.js";
import { icons } from "../ui/icons.js";
import { store } from "../store.js";
import { sse } from "../sse.js";
import { api } from "../api.js";
import { navigate } from "../router.js";
import { createChain3D } from "../gl/chain3d.js";
import { runGuidedTour } from "../onboarding.js";
import { toast } from "../ui/toast.js";

let chain = null;
let offAudit = null;
let offMetrics = null;

export default {
  async render(mount) {
    const m = store.get("metrics") || {};
    const health = store.get("health") || {};

    mount.append(
      hero(),
      section("how", "The mechanism",
        "Borrowed from the agent-payments protocols taking shape right now — AP2's signed mandates, NPCI's Unified Agent Protocol — cut to what a merchant actually needs.",
        flowGrid()),
      section("live", "Live from the running system",
        "These are real numbers off the server you're connected to, not a mockup.",
        ticker(m)),
      section("paths", "Two ways an agent buys here",
        "Same Gate, same ledger, whether the buyer is the shop's own agent or a stranger's.",
        pathsGrid(health)),
      foot(),
    );

    // 3D
    const cv = mount.querySelector("#hero-canvas");
    if (cv) {
      chain = createChain3D(cv, { count: 6, size: 0.6, spin: 0.0022 });
      chain.start();
      offAudit = sse.onAudit(() => chain?.addBlock());
    }

    // live ticker updates
    offMetrics = store.on("metrics", (mm) => paintTicker(mount, mm));
    paintTicker(mount, m);

    // reveal
    window.__reveal?.(mount);
  },

  destroy() {
    chain?.destroy(); chain = null;
    offAudit?.(); offMetrics?.();
  },
};

function hero() {
  const el = h("section.hero.page");
  el.append(
    h("div.hero-copy", {},
      h("span.eyebrow", { text: "Razorpay Buildathon · Track 01" }),
      h("h1", { html: `Money that moves <span class="accent">only when it's allowed to.</span>` }),
      h("p.lede", { text: "A merchant any AI agent can transact with — end to end, under a mandate signed by the shopper's wallet, over a ledger you can verify byte for byte." }),
      h("div.hero-cta", {},
        h("button.btn.btn-primary.btn-lg", { onclick: () => navigate("/console") },
          txt("Open the console"), ico(icons.arrow)),
        h("button.btn.btn-lg", { onclick: () => runGuidedTour() },
          ico(icons.play), txt("Take the 2-min tour")),
      ),
    ),
    h("div.hero-canvas-wrap", {},
      h("canvas#hero-canvas", { "aria-hidden": "true" }),
      h("div.hero-canvas-badge", { text: "hash-chained ledger · live" }),
    ),
  );
  return el;
}

function section(id, title, lede, content) {
  const s = h("section.section.page", { id });
  s.append(
    h("div.section-head", { dataset: { reveal: "" } },
      h("span.eyebrow", { text: title }),
      h("h2", { text: title === "The mechanism" ? "Mandate, Gate, Ledger" : title === "Live from the running system" ? "Not a mockup" : "One shop, two buyers" }),
      h("p.lede", { text: lede }),
    ),
    h("div", { dataset: { reveal: "" }, style: { "--reveal-delay": "80ms" } }, content),
  );
  return s;
}

function flowGrid() {
  const cards = [
    { n: "01", ico: icons.lock, t: "Mandate", d: "A signed credential the agent carries: a spending cap, allowed categories, an expiry. Signed by the shopper's wallet key — the merchant can verify it, and can never mint one.", diagram: "mandate" },
    { n: "02", ico: icons.shield, t: "Gate", d: "Server-side control flow between the agent and any payment. Category, per-order limit, available balance, an unattended-spend threshold. Code — not a prompt an agent can argue with.", diagram: "gate" },
    { n: "03", ico: icons.ledger, t: "Ledger", d: "Every decision, hash-chained. Each record's hash folds in the one before it. Edit any byte and verification names the exact record that broke.", diagram: "ledger" },
  ];
  const grid = h("div.flow-grid");
  cards.forEach((c) => {
    grid.appendChild(h("div.flow-card", {},
      h("span.flow-ico", { html: `<span style="display:grid;place-items:center">${c.ico}</span>` }),
      h("span.flow-n", { text: c.n }),
      h("h3", { text: c.t }),
      h("p", { text: c.d }),
      miniDiagram(c.diagram),
    ));
  });
  return grid;
}

function miniDiagram(kind) {
  const wrap = h("div.flow-diagram");
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 200 46");
  svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%");
  svg.style.overflow = "visible";
  const mk = (tag, attrs) => { const n = document.createElementNS(svgNS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };

  if (kind === "mandate") {
    const r = mk("rect", { x: 6, y: 8, width: 120, height: 30, rx: 6, fill: "var(--iris-ghost)", stroke: "var(--iris-line)" });
    const l1 = mk("line", { x1: 16, y1: 18, x2: 90, y2: 18, stroke: "var(--iris-bright)", "stroke-width": 2, "stroke-linecap": "round" });
    const l2 = mk("line", { x1: 16, y1: 26, x2: 70, y2: 26, stroke: "var(--text-faint)", "stroke-width": 2, "stroke-linecap": "round" });
    const seal = mk("circle", { cx: 150, cy: 23, r: 14, fill: "none", stroke: "var(--mint)", "stroke-width": 2, "stroke-dasharray": "4 4" });
    const anim = mk("animateTransform", { attributeName: "transform", type: "rotate", from: "0 150 23", to: "360 150 23", dur: "9s", repeatCount: "indefinite" });
    seal.appendChild(anim);
    svg.append(r, l1, l2, seal, mk("path", { d: "M143 23l5 5 9-10", fill: "none", stroke: "var(--mint)", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }));
  } else if (kind === "gate") {
    svg.append(
      mk("circle", { cx: 24, cy: 23, r: 6, fill: "var(--iris-bright)" }),
      mk("line", { x1: 30, y1: 23, x2: 84, y2: 23, stroke: "var(--line-bright)", "stroke-width": 2 }),
      mk("rect", { x: 84, y: 8, width: 30, height: 30, rx: 6, fill: "var(--surface-2)", stroke: "var(--iris)" }),
      mk("path", { d: "M92 23l5 5 9-10", fill: "none", stroke: "var(--ok)", "stroke-width": 2.4, "stroke-linecap": "round", "stroke-linejoin": "round" }),
      mk("line", { x1: 114, y1: 23, x2: 170, y2: 23, stroke: "var(--ok)", "stroke-width": 2, "stroke-dasharray": "3 4" }),
      mk("circle", { cx: 176, cy: 23, r: 6, fill: "var(--ok)" }),
    );
    const spark = mk("circle", { cx: 30, cy: 23, r: 2.6, fill: "var(--mint)" });
    spark.appendChild(mk("animate", { attributeName: "cx", values: "30;84;30", dur: "2.4s", repeatCount: "indefinite" }));
    svg.appendChild(spark);
  } else {
    for (let i = 0; i < 5; i++) {
      const g = mk("g", {});
      g.append(
        mk("rect", { x: 8 + i * 38, y: 12, width: 24, height: 24, rx: 5, fill: "var(--iris-ghost)", stroke: "var(--iris-line)" }),
      );
      if (i < 4) g.append(mk("line", { x1: 32 + i * 38, y1: 24, x2: 46 + i * 38, y2: 24, stroke: "var(--iris-deep)", "stroke-width": 2 }));
      svg.appendChild(g);
    }
    const spark = mk("circle", { cx: 8, cy: 24, r: 2.4, fill: "var(--mint)" });
    spark.appendChild(mk("animate", { attributeName: "cx", values: "20;172", dur: "2.8s", repeatCount: "indefinite" }));
    svg.appendChild(spark);
  }
  wrap.appendChild(svg);
  return wrap;
}

function ticker(m = {}) {
  const grid = h("div.ticker#ticker");
  const cell = (k, id, cls = "") => h("div.ticker-cell", {},
    h("div.k", { text: k }),
    h("div.v", { id, class: cls, text: "—" }));
  grid.append(
    cell("Settled GMV", "tk-gmv", "mint"),
    cell("Refused by the Gate", "tk-refused", "crit"),
    cell("Ledger height", "tk-chain", "iris"),
    cell("Agents connected", "tk-agents"),
  );
  return grid;
}

function paintTicker(root, m = {}) {
  const gmv = root.querySelector("#tk-gmv");
  const refused = root.querySelector("#tk-refused");
  const chainEl = root.querySelector("#tk-chain");
  const agents = root.querySelector("#tk-agents");
  const health = store.get("health") || {};
  if (gmv) countTo(gmv, (m.settled_gmv_paise || 0) / 100, { prefix: "₹" });
  if (refused) countTo(refused, (m.refused_spend_paise || 0) / 100, { prefix: "₹" });
  if (chainEl) countTo(chainEl, (m.chain?.seq ?? store.get("chain")?.seq ?? 0) + 1, { fmt: (n) => Math.round(n).toString() });
  if (agents) countTo(agents, health.external_agents_connected || 0, { fmt: (n) => Math.round(n).toString() });
}

function pathsGrid(health = {}) {
  const grid = h("div.paths");
  grid.append(
    h("div.path-card", {},
      h("h3", {}, ico(icons.spark), txt("In-app shopper agent")),
      h("p", { text: "The chat you'll use in the console. It plans every turn, calls the catalog over MCP, and never touches the payment rail itself — only the checkout engine does, behind the Gate." }),
      h("div.path-code", { text: "you → shopper agent → [Gate] → Razorpay test-mode" }),
    ),
    h("div.path-card", {},
      h("h3", {}, ico(icons.people), txt("External AI buyer")),
      h("p", { text: "Any MCP client — Claude Desktop, the Inspector, another team's agent — connects to the merchant endpoint, requests a signed mandate, and checks out. It shares no code with this shop." }),
      h("div.path-code", { text: `POST ${location.origin}/mcp\n  get_merchant_profile → request_mandate\n  → draft_order → confirm_checkout` }),
    ),
  );
  return grid;
}

function foot() {
  return h("footer.landing-foot.page", {},
    h("div", { text: "Agentic Bazaar · a Razorpay Buildathon Track 01 build" }),
    h("div.row.gap-2", {},
      h("a", { href: "#/ledger", text: "Verify the ledger" }),
      h("a", { href: "#/mandates", text: "Break a mandate" }),
      h("button.btn.btn-ghost.btn-sm", { text: "Replay tour", onclick: () => runGuidedTour() }),
    ),
  );
}

/* tiny helpers for inline icon + text inside buttons */
function ico(svg) { const s = h("span"); s.style.display = "inline-grid"; s.style.placeItems = "center"; s.innerHTML = svg; const g = s.firstElementChild; if (g) { g.setAttribute("width", "1em"); g.setAttribute("height", "1em"); } return s; }
function txt(t) { return document.createTextNode(t); }
