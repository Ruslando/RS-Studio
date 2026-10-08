// App-wide preferences that survive reloads (localStorage), independent of the
// open project. Each setting has one authoritative input (the one feature code
// reads) plus an optional mirror copy in the Settings modal; the two stay in
// lock-step and changes are persisted by the input's id.

import { $ } from "./dom.js";
import { drawFretboard } from "./fretboard.js";
import { refreshStagePaint } from "./stage-paint.js";
import { draw } from "./repaint.js";

const KEY = "cw.settings";
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } };
const store = load();
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* private mode / quota */ } };

const get = (el, bool) => (bool ? el.checked : el.value);
const set = (el, bool, v) => { if (bool) el.checked = !!v; else el.value = v; };

// `main` is read by feature code; `mirror` (if any) just shadows it. The mirror
// dispatches main's native event on change so main's existing handlers run — so
// callers don't need to wire the mirror separately.
function persistSetting(main, { mirror = null, bool = false } = {}) {
  if (!main) return;
  const mirrors = (Array.isArray(mirror) ? mirror : [mirror]).filter(Boolean);
  const key = main.id, evt = bool ? "change" : "input";
  if (key in store) set(main, bool, store[key]);   // silent restore (read before init runs)
  main.addEventListener(evt, () => {
    store[key] = get(main, bool); persist();
    mirrors.forEach((el) => set(el, bool, store[key]));
  });
  mirrors.forEach((el) => {
    set(el, bool, get(main, bool));
    el.addEventListener(evt, () => { set(main, bool, get(el, bool)); main.dispatchEvent(new Event(evt)); });
  });
}

// ---- Light / dark theme ----
// Stored under its own key so the no-FOUC inline script in index.html can apply
// it before the module graph loads. Canvas colours follow the same theme.
const THEME_KEY = "cw.theme";

// Dark is the system default, so the root carries data-theme only for light.
function setTheme(t) {
  const v = t === "light" ? "light" : "dark";
  if (v === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  refreshStagePaint();
  draw();
  try { localStorage.setItem(THEME_KEY, v); } catch { /* private mode / quota */ }
  if ($("themeSelect").value !== v) $("themeSelect").value = v;
}

// A dropdown, not a segmented pill: rule 26 wants a set that will grow picked
// from a menu, because every theme added makes the pill's targets smaller.
function init_theme() {
  $("themeSelect").addEventListener("change", () => setTheme($("themeSelect").value));
  // The inline head script already set data-theme; reflect it in the control.
  setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
}

// Restore must happen before the feature inits read these inputs (see main.js).
export function init_settings() {
  persistSetting($("traceSnap"), { mirror: $("traceSnapM"), bool: true });
  persistSetting($("traceRange"), { mirror: $("traceRangeM") });
  persistSetting($("traceThreshold"), { mirror: $("traceThresholdM") });
  // The fretboard reads these two straight off the inputs while it draws, the way
  // the voicing engine reads its own preferences — so persisting them and repainting
  // is the whole wiring. These controls live in Editor options.
  persistSetting($("fretboardOnionEnabled"), { bool: true });
  for (const id of ["onionAlphaPrev", "onionAlphaNext"]) {
    persistSetting($(id));
    const show = () => {
      $(id + "Value").textContent = `${$(id).value}%`;
      drawFretboard();
    };
    $(id).addEventListener("input", show);
    show();
  }
  init_theme();
}
