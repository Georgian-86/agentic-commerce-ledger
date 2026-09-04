// Inline SVG icons — 24x24, currentColor stroke. Kept small and local
// so the app needs no icon font and no network.

// Every icon ships with an explicit 1em box so an inline `html: icons.x`
// use renders at the container's font-size instead of collapsing to 0.
const s = (p) => `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

export const icons = {
  shield:   s('<path d="M12 2 4 5.5v6c0 5.2 3.4 9.7 8 11 4.6-1.3 8-5.8 8-11v-6L12 2Z"/><path d="m8.5 12 2.4 2.4 4.6-4.8"/>'),
  bolt:     s('<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>'),
  lock:     s('<rect x="4.5" y="10.5" width="15" height="10.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>'),
  link:     s('<path d="M9 15 15 9"/><path d="M11 6.5 12.5 5a4 4 0 0 1 5.7 5.7L16.5 12.5"/><path d="M12.5 17.5 11 19a4 4 0 0 1-5.7-5.7L7 11.5"/>'),
  cube:     s('<path d="M12 2.5 21 7v10l-9 4.5L3 17V7l9-4.5Z"/><path d="M3 7l9 4.5L21 7M12 21.5V11.5"/>'),
  mic:      s('<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4"/>'),
  send:     s('<path d="M4 12 20 4l-6 16-3-7-7-1Z"/>'),
  play:     s('<path d="M7 4v16l13-8L7 4Z"/>'),
  arrow:    s('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  x:        s('<path d="M6 6l12 12M18 6 6 18"/>'),
  check:    s('<path d="M5 13l4 4L19 7"/>'),
  alert:    s('<path d="M12 3 2 20h20L12 3Z"/><path d="M12 9v5M12 17.5v.5"/>'),
  sun:      s('<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8"/>'),
  moon:     s('<path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z"/>'),
  route:    s('<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8 16.5c8-1 8.5-1.5 9.5-9"/>'),
  ledger:   s('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
  gauge:    s('<path d="M4 15a8 8 0 0 1 16 0"/><path d="M12 15l4-4"/><circle cx="12" cy="15" r="1"/>'),
  people:   s('<circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 6a3 3 0 0 1 0 6M20.5 20a5.5 5.5 0 0 0-4-5.3"/>'),
  refresh:  s('<path d="M20 11A8 8 0 0 0 6 6M4 5v4h4M4 13a8 8 0 0 0 14 5M20 19v-4h-4"/>'),
  book:     s('<path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2V4Z"/><path d="M5 18a2 2 0 0 1 2-2h11"/>'),
  spark:    s('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>'),
};

export function icon(name, cls = "") {
  const span = document.createElement("span");
  span.className = cls;
  span.style.display = "inline-flex";
  span.innerHTML = icons[name] || "";
  const svg = span.firstElementChild;
  if (svg) { svg.setAttribute("width", "1em"); svg.setAttribute("height", "1em"); }
  return span;
}
