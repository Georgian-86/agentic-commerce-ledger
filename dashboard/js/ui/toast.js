import { h, clear } from "./dom.js";
import { icons } from "./icons.js";

let stack = null;
function ensure() {
  if (stack) return stack;
  stack = h("div.toast-stack", { role: "status", "aria-live": "polite" });
  document.body.appendChild(stack);
  return stack;
}

const ICO = { ok: icons.check, warn: icons.alert, crit: icons.alert, "": icons.spark };

export function toast(title, message = "", kind = "", ttl = 5200) {
  const el = h("div.toast", { class: kind },
    h("span.toast-ico", { html: ICO[kind] || ICO[""] }),
    h("div", {},
      h("div.toast-t", { text: title }),
      message && h("div.toast-m", { text: message }),
    ),
  );
  ensure().appendChild(el);
  const kill = () => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 260);
  };
  el.addEventListener("click", kill);
  if (ttl) setTimeout(kill, ttl);
  return kill;
}
