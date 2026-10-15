// The volume control of a layer row and of the two sidebar headers (design.md
// 4.18): the speaker and the level. A click mutes, a sideways drag sets the level
// (like the marker's Position field), the arrow keys step it by 5 %.
//
// The headers are the two buses: every note layer plays through S.state.mix.notes,
// every audio layer through S.state.mix.audio. A layer's level is multiplied by
// its bus's (busLevel).

import { icon } from "./icons.js";
import { S } from "./store.js";
import { clamp, normLayerVolume } from "./util.js";

export const BUSES = ["notes", "audio"];

export function normMix(raw) {
  return Object.fromEntries(BUSES.map((kind) => [kind,
    { volume: normLayerVolume(raw?.[kind]?.volume), muted: !!raw?.[kind]?.muted }]));
}

export function busLevel(kind) {
  const bus = S.state?.mix?.[kind];
  return !bus ? 1 : bus.muted ? 0 : normLayerVolume(bus.volume);
}

// The bus control, at the right end of its sidebar header. Rebuilt with the rows
// under it, so it always shows the loaded project's bus.
// apply(): make the bus heard; rerender(): repaint the rows; done(): mark dirty.
export function mountBus(kind, sec, name, { apply, rerender, done }) {
  const header = document.querySelector(`.side-label[data-sec="${sec}"]`)?.parentElement;
  if (!header || !S.state) return;
  const bus = (S.state.mix ||= normMix())[kind];
  header.querySelector(".vol")?.remove();
  header.append(volumeControl(bus, { name, onChange: apply, onDone: done,
    onMute: () => { bus.muted = !bus.muted; apply(); rerender(); done(); } }));
}

const PER_PX = 0.005;   // 200 px for the whole range; Shift: a fifth of that
const STEP = 0.05;

// target: an object with `volume` and `muted` (a lane, a stem, a bus).
// onChange(): the level moved — make it heard. onMute(): toggle the mute.
// onDone(): one gesture ended — the place to mark the project dirty.
export function volumeControl(target, { name, onChange, onMute, onDone }) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "vol" + (target.muted ? " on" : "");
  b.setAttribute("aria-pressed", String(!!target.muted));
  b.innerHTML = icon(target.muted ? "speakerOff" : "speaker", 14);
  const pct = document.createElement("span");
  pct.className = "vol-pct";
  b.append(pct);
  const show = () => {
    const level = Math.round(normLayerVolume(target.volume) * 100);
    pct.textContent = String(level);
    const text = `${level}%`;
    b.title = `${name}: ${text}${target.muted ? ", muted" : ""}. Click to ${target.muted ? "unmute" : "mute"}, drag sideways for the volume`;
    b.setAttribute("aria-label", b.title);
  };
  show();
  const set = (v) => { target.volume = clamp(v, 0, 1); show(); onChange(); };

  let drag = null, dragged = false;
  // mousedown's default would start the row's own drag (reordering) or a selection.
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { x0: e.clientX, v0: normLayerVolume(target.volume), live: false };
    dragged = false;
    b.setPointerCapture(e.pointerId);
  });
  b.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.live) {
      if (Math.abs(e.clientX - drag.x0) < 3) return;
      drag.live = dragged = true;
      document.body.classList.add("scrubbing");
    }
    set(drag.v0 + (e.clientX - drag.x0) * PER_PX * (e.shiftKey ? 0.2 : 1));
  });
  const end = () => {
    if (drag?.live) { document.body.classList.remove("scrubbing"); onDone(); }
    drag = null;
  };
  b.addEventListener("pointerup", end);
  b.addEventListener("pointercancel", end);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dragged) { dragged = false; return; }
    onMute();
  });
  b.addEventListener("keydown", (e) => {
    const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (!dir) return;
    e.preventDefault(); e.stopPropagation();   // the editor's arrows move notes
    set(normLayerVolume(target.volume) + dir * STEP);
    onDone();
  });
  return b;
}
