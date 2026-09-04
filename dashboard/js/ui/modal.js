import { h } from "./dom.js";
import { icons } from "./icons.js";

let openCount = 0;

/**
 * openModal({ title, subtitle, body: Node|string, actions: [{label, kind, onClick, closes}], wide })
 * Returns { close }. body/actions can be built by the caller.
 */
export function openModal({ title, subtitle, body, actions = [], wide = false, onClose } = {}) {
  const scrim = h("div.modal-scrim", { role: "dialog", "aria-modal": "true" });
  const modal = h("div.modal", { class: wide ? "wide" : "" });

  const closeBtn = h("button.modal-x", { "aria-label": "Close", html: icons.x, onclick: () => close() });
  const head = h("div.modal-head", {},
    h("div", {},
      h("h3", { text: title }),
      subtitle && h("div.modal-sub", { text: subtitle }),
    ),
    closeBtn,
  );

  const bodyEl = h("div.modal-body");
  if (body) bodyEl.append(body.nodeType ? body : h("div", { html: body }));

  modal.append(head, bodyEl);

  if (actions.length) {
    const foot = h("div.modal-foot");
    for (const a of actions) {
      const btn = h("button.btn", {
        class: a.kind === "primary" ? "btn-primary" : a.kind === "danger" ? "btn-danger" : a.kind === "ghost" ? "btn-ghost" : "",
        text: a.label,
        onclick: async () => {
          const keep = await a.onClick?.({ close, bodyEl });
          if (a.closes !== false && keep !== false) close();
        },
      });
      foot.appendChild(btn);
    }
    modal.appendChild(foot);
  }

  scrim.appendChild(modal);
  scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) close(); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(scrim);
  document.body.style.overflow = "hidden";
  openCount++;

  // focus trap-ish
  setTimeout(() => (modal.querySelector("button, a, input, select, textarea") || closeBtn).focus(), 30);

  function onKey(e) { if (e.key === "Escape") close(); }
  function close() {
    document.removeEventListener("keydown", onKey);
    scrim.classList.add("closing");
    modal.style.animation = "scale-in .18s ease reverse";
    setTimeout(() => {
      scrim.remove();
      if (--openCount <= 0) { document.body.style.overflow = ""; openCount = 0; }
      onClose?.();
    }, 170);
  }

  return { close, bodyEl, modal };
}
