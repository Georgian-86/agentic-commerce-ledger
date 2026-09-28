// Capture every dashboard view at desktop + mobile, dark + light, for
// the design-iteration loop (see docs/design/ITERATION_LOOP.md).
//
//   npm run shots                     # -> docs/design/shots/latest/
//   npm run shots -- --out iter-03    # -> docs/design/shots/iter-03/
//   BASE_URL=https://agentic-bazaar.onrender.com npm run shots
//
// Needs the server running (npm run dev, DEMO_MODE=true is fine).
// Also fails loudly on console errors / failed requests, because a
// screenshot of a broken page is not a design review.

import { mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright is not installed. Run: npm install (it is a devDependency).");
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outName = args.includes("--out") ? args[args.indexOf("--out") + 1] : "latest";
const outDir = resolve(root, "docs/design/shots", outName);
const base = (process.env.BASE_URL || "http://localhost:4200").replace(/\/$/, "");

const VIEWS = ["/", "/console", "/ledger", "/mandates", "/agents"];
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
const THEMES = ["dark", "light"];

await mkdir(outDir, { recursive: true });

const launchOpts = {};
if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(launchOpts);
const problems = [];

for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
  for (const theme of THEMES) {
    const ctx = await browser.newContext({
      viewport, colorScheme: theme, deviceScaleFactor: 1,
      // For sandboxes behind a TLS-intercepting proxy (Google Fonts fails otherwise).
      ignoreHTTPSErrors: process.env.SHOTS_IGNORE_HTTPS_ERRORS === "1",
    });
    // Skip the first-run intro/tour so it doesn't cover every shot.
    await ctx.addInitScript((t) => {
      try {
        localStorage.setItem("acl.onboarded", "1");
        localStorage.setItem("acl.theme", t);
      } catch {}
    }, theme);
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error") problems.push(`[${vpName}/${theme}] console: ${m.text()}`); });
    page.on("pageerror", (e) => problems.push(`[${vpName}/${theme}] pageerror: ${e.message}`));
    page.on("requestfailed", (r) => problems.push(`[${vpName}/${theme}] requestfailed: ${r.url()}`));

    for (const view of VIEWS) {
      await page.goto(`${base}/#${view}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(900); // let view transitions + entrance motion settle
      // `.shell` (fixed, overflow-y:auto) is the scroll container, not the
      // document, so fullPage alone captures one viewport. Grow the
      // viewport to the shell's content height instead.
      const { contentH, wide } = await page.evaluate(() => {
        const shell = document.querySelector(".shell");
        const navH = shell ? shell.getBoundingClientRect().top : 0;
        const vw = window.innerWidth;
        // .shell clips overflow-x, so look for elements poking past the edge.
        // Skip canvases (nothing to clip) and anything already contained by a
        // scrolling/clipping ancestor (e.g. `.pipeline`'s intentional
        // horizontal scroller) — those aren't actually spilling onto the page.
        const clipsX = (el) => ["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(el).overflowX);
        const wide = [...document.querySelectorAll(".shell *")]
          .filter((el) => {
            if (el.tagName === "CANVAS") return false;
            const r = el.getBoundingClientRect();
            if (!(r.width > 0 && r.right > vw + 1)) return false;
            for (let a = el.parentElement; a && a !== shell; a = a.parentElement) {
              if (clipsX(a)) return false;
            }
            return true;
          })
          .slice(0, 3)
          .map((el) => el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""));
        return { contentH: Math.ceil(navH + (shell ? shell.scrollHeight : document.documentElement.scrollHeight)), wide };
      });
      if (wide.length) problems.push(`[${vpName}/${theme}] ${view}: content wider than viewport (may be clipped): ${wide.join(", ")}`);
      await page.setViewportSize({ width: viewport.width, height: Math.min(Math.max(contentH, viewport.height), 12000) });
      await page.waitForTimeout(300);
      const slug = view === "/" ? "landing" : view.slice(1);
      await page.screenshot({ path: `${outDir}/${slug}-${vpName}-${theme}.png` });
      await page.setViewportSize(viewport);
    }
    await ctx.close();
  }
}

await browser.close();
console.log(`Saved ${VIEWS.length * 4} screenshots to ${outDir}`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s) found:`);
  for (const p of problems) console.log("  - " + p);
  process.exitCode = 1;
}
