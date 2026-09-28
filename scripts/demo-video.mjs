// Record a short walkthrough video of the Trust Console, for the
// end-of-iteration demo (see docs/design/ITERATION_LOOP.md step 7).
//
//   npm run demo:video -- --out iter-01     # -> docs/design/demos/iter-01/
//
// Needs the server running. Records desktop (dark) and mobile (light)
// walkthroughs as .webm. Honest: it drives the real UI against the real
// server — nothing is staged.

import { mkdir, rename, readdir, rm } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outName = args.includes("--out") ? args[args.indexOf("--out") + 1] : "latest";
const outDir = resolve(root, "docs/design/demos", outName);
const base = (process.env.BASE_URL || "http://localhost:4200").replace(/\/$/, "");

await mkdir(outDir, { recursive: true });
const launchOpts = {};
if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(launchOpts);

async function record(name, viewport, theme, walk) {
  const tmp = join(outDir, `.tmp-${name}`);
  const ctx = await browser.newContext({
    viewport, colorScheme: theme,
    ignoreHTTPSErrors: process.env.SHOTS_IGNORE_HTTPS_ERRORS === "1",
    recordVideo: { dir: tmp, size: viewport },
  });
  await ctx.addInitScript((t) => {
    try { localStorage.setItem("acl.onboarded", "1"); localStorage.setItem("acl.theme", t); } catch {}
  }, theme);
  const page = await ctx.newPage();
  await walk(page);
  await ctx.close();
  const [file] = await readdir(tmp);
  await rename(join(tmp, file), join(outDir, `${name}.webm`));
  await rm(tmp, { recursive: true, force: true });
}

// Smoothly scroll the `.shell` scroll container (not the document).
async function scrollShell(page, ms = 2500) {
  await page.evaluate(async (dur) => {
    const s = document.querySelector(".shell") || document.scrollingElement;
    const max = s.scrollHeight - s.clientHeight;
    const t0 = performance.now();
    await new Promise((done) => {
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        s.scrollTop = max * (k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
        k < 1 ? requestAnimationFrame(step) : done();
      };
      requestAnimationFrame(step);
    });
  }, ms);
  await page.waitForTimeout(500);
}

async function go(page, view, dwell = 1400) {
  await page.goto(`${base}/#${view}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(dwell);
}

async function tryClick(page, selector, wait = 1200) {
  const el = page.locator(selector).first();
  if (await el.count() && await el.isVisible() && await el.isEnabled()) {
    await el.click();
    await page.waitForTimeout(wait);
    return true;
  }
  return false;
}

async function walkthrough(page) {
  await go(page, "/", 2000);
  await scrollShell(page, 4000);
  await go(page, "/console");
  // Iteration 01+ has suggested-prompt chips; fall back to Start session.
  if (!(await tryClick(page, ".prompt-chip, [data-prompt]", 6000))) {
    await tryClick(page, "#start-btn", 1500);
  }
  await page.waitForTimeout(1500);
  await go(page, "/ledger");
  await tryClick(page, "button:has-text('Verify chain')", 1500);
  await scrollShell(page, 1500);
  await go(page, "/mandates");
  await tryClick(page, "button:has-text('Tamper')", 2000);
  await scrollShell(page, 2000);
  await go(page, "/agents");
  await scrollShell(page, 2000);
}

await record("desktop-dark", { width: 1440, height: 900 }, "dark", walkthrough);
await record("mobile-light", { width: 390, height: 844 }, "light", walkthrough);
await browser.close();
console.log(`Saved demo videos to ${outDir}`);
