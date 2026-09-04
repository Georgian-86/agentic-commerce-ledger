import { h } from "./dom.js";

/** A few lines of shimmer, for text-ish content. */
export function skelLines(n = 3, widths = ["80", "60", "40"]) {
  const box = h("div");
  for (let i = 0; i < n; i++) {
    box.appendChild(h("div.skel.skel-line", { class: "w-" + (widths[i % widths.length]) }));
  }
  return box;
}

export function skelBlock(count = 1, cls = "skel-block") {
  const box = h("div.stack.gap-2");
  for (let i = 0; i < count; i++) box.appendChild(h("div.skel", { class: cls }));
  return box;
}

/** Skeleton shaped like a stat tile row. */
export function skelStats(count = 4) {
  const grid = h("div", { style: { display: "grid", gridTemplateColumns: `repeat(${count},1fr)`, gap: "1px", borderRadius: "var(--r-lg)", overflow: "hidden", border: "1px solid var(--line)" } });
  for (let i = 0; i < count; i++) {
    grid.appendChild(h("div", { style: { background: "var(--surface-1)", padding: "1.4rem 1.3rem" } },
      h("div.skel.skel-line.w-40"),
      h("div.skel.skel-line", { style: { height: "1.6rem", width: "70%", marginTop: ".5rem" } }),
    ));
  }
  return grid;
}
