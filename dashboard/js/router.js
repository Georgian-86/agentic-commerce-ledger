// Hash router. Works from a static file, no server rewrites needed.
// Each route maps to a view module exporting { render(mount, params),
// destroy?() }. The router runs a crossfade between the outgoing and
// incoming view.

const routes = new Map();
let current = null;
let mountEl = null;
let onChange = null;

export function defineRoute(path, loader) {
  routes.set(path, loader);
}

export function initRouter(el, opts = {}) {
  mountEl = el;
  onChange = opts.onChange || null;
  window.addEventListener("hashchange", handle);
  handle();
}

export function navigate(path) {
  if (location.hash.slice(1) === path) { handle(); return; }
  location.hash = path;
}

export function currentPath() {
  return (location.hash.slice(1) || "/").split("?")[0];
}

function parseParams() {
  const q = (location.hash.split("?")[1]) || "";
  return Object.fromEntries(new URLSearchParams(q));
}

async function handle() {
  const path = currentPath();
  const loader = routes.get(path) || routes.get("/");
  if (!loader) return;

  const params = parseParams();

  // tear down the old view
  if (current?.destroy) { try { current.destroy(); } catch (e) { console.error(e); } }

  // outgoing fade — opacity only, no transform (see base.css note)
  const old = mountEl.firstElementChild;
  if (old) {
    old.style.transition = "opacity .14s ease";
    old.style.opacity = "0";
    await wait(130);
  }
  mountEl.innerHTML = "";

  const mod = await loader();
  const view = mod.default || mod;
  const node = document.createElement("div");
  node.className = "view-enter";
  mountEl.appendChild(node);

  current = view;
  try {
    await view.render(node, params);
  } catch (e) {
    console.error("view render failed", e);
    node.innerHTML = `<div class="page" style="padding-block:4rem"><div class="empty">This view hit an error. <button class="btn btn-sm" onclick="location.reload()">Reload</button></div></div>`;
  }

  // scroll the shell (our scroll container), not the document
  (mountEl.closest(".shell") || mountEl).scrollTo({ top: 0, behavior: "instant" });
  onChange?.(path, params);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
