// Device-shaped views over plain inputs: dials, faders and an EQ curve.
// The native range/number inputs stay the source of truth, so keyboard access,
// exact entry and validation work the same in every view.
const SVG = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
function setInput(input, value) {
  const before = input.value; input.value = String(value);
  if (input.value !== before) input.dispatchEvent(new Event("input", { bubbles: true }));
}
function defaultButton(slider, defaultValue, label, onDefault) {
  const reset = document.createElement("button"); reset.type = "button"; reset.className = "parameter-default";
  reset.textContent = label; reset.title = `Default ${label}; click to reset`;
  reset.setAttribute("aria-label", `${slider.getAttribute("aria-label")} default ${label}`);
  reset.addEventListener("click", onDefault); return reset;
}

// A 270° dial. Drag up/down (Shift for fine steps), arrow keys on the hidden
// range input, double-click or the default label to reset.
const SWEEP = 135, C = 32, R = 25;
const polar = (r, deg) => [C + r * Math.sin(deg * Math.PI / 180), C - r * Math.cos(deg * Math.PI / 180)];
function arc(from, to) {
  const [x1, y1] = polar(R, from), [x2, y2] = polar(R, to);
  return `M${x1} ${y1}A${R} ${R} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}
export function dial(slider, { min, max, defaultValue, onDefault }) {
  const wrap = document.createElement("div"); wrap.className = "sound-dial";
  const angle = value => -SWEEP + 2 * SWEEP * clamp((value - min) / (max - min), 0, 1);
  const face = svg("svg", { viewBox: "0 0 64 64", "aria-hidden": "true", class: "sound-dial-face" });
  const fill = svg("path", { class: "dial-fill" }), pointer = svg("line", { class: "dial-pointer" });
  const [mx1, my1] = polar(R - 5, angle(defaultValue)), [mx2, my2] = polar(R + 5, angle(defaultValue));
  face.append(svg("path", { d: arc(-SWEEP, SWEEP), class: "dial-track" }), fill,
    svg("line", { x1: mx1, y1: my1, x2: mx2, y2: my2, class: "dial-default" }),
    svg("circle", { cx: C, cy: C, r: R - 8, class: "dial-cap" }), pointer);
  // Bipolar ranges (dB, pitch) fill from zero; the rest from the minimum.
  const origin = angle(min < 0 && max > 0 ? 0 : min);
  const sync = () => {
    const a = angle(Number(slider.value));
    fill.setAttribute("d", Math.abs(a - origin) < .5 ? "" : arc(Math.min(a, origin), Math.max(a, origin)));
    const [x1, y1] = polar(7, a), [x2, y2] = polar(R - 11, a);
    Object.entries({ x1, y1, x2, y2 }).forEach(([key, value]) => pointer.setAttribute(key, value));
  };
  let drag = null;
  face.addEventListener("pointerdown", event => {
    if (event.button) return;
    event.preventDefault(); slider.focus({ preventScroll: true });
    face.setPointerCapture(event.pointerId); drag = { y: event.clientY, value: Number(slider.value) };
  });
  face.addEventListener("pointermove", event => {
    if (!drag) return;
    const pixels = event.shiftKey ? 800 : 160;
    setInput(slider, drag.value + (drag.y - event.clientY) / pixels * (max - min));
  });
  for (const type of ["pointerup", "pointercancel"]) face.addEventListener(type, () => { drag = null; });
  face.addEventListener("dblclick", onDefault);
  slider.classList.add("sound-hidden-range");
  const reset = defaultButton(slider, defaultValue, String(defaultValue), onDefault);
  // The default label sits just outside the ring at the default mark, growing
  // away from the dial so longer values never cover the mark.
  const at = angle(defaultValue), [lx, ly] = polar(R + 8, at);
  reset.style.left = `${lx}px`; reset.style.top = `${ly}px`;
  reset.dataset.side = at < -30 ? "left" : at > 30 ? "right" : "top";
  const box = document.createElement("div"); box.className = "sound-dial-box";
  box.append(face, reset);
  wrap.append(slider, box); wrap.sync = sync; sync(); return wrap;
}

// A vertical fader for graphic EQ bands: a rotated native range input.
export function fader(slider, { min, max, defaultValue, onDefault }) {
  const wrap = document.createElement("div"); wrap.className = "sound-fader";
  slider.classList.add("sound-fader-input");
  const track = document.createElement("div"); track.className = "sound-fader-track";
  const mark = document.createElement("i"); mark.className = "sound-fader-default";
  mark.style.setProperty("--at", (defaultValue - min) / (max - min));
  const reset = defaultButton(slider, defaultValue, String(defaultValue), onDefault);
  reset.style.setProperty("--at", (defaultValue - min) / (max - min));
  track.append(mark, slider, reset); wrap.append(track); wrap.sync = () => {}; return wrap;
}

// Parametric EQ curve. Each band is { gain, freq, gainKnob, freqKnob, scale, q }:
// gain/freq are the band's number inputs, the knobs their catalogue ranges, scale
// converts the freq unit to Hz and q() reads the band's Q. Dragging writes the inputs.
const W = 960, H = 200, PAD = 16, LO = 20, HI = 20000, DB = 15, FS = 48000;
const xOf = f => Math.log(f / LO) / Math.log(HI / LO) * W;
const fOf = x => LO * (HI / LO) ** (x / W);
const yOf = g => H / 2 - g / DB * (H / 2 - PAD);
const gOf = y => (H / 2 - y) / (H / 2 - PAD) * DB;
// RBJ cookbook biquads at 48 kHz. ponytail: shelf/peak shapes are an assumption;
// Rocksmith's DSP is undocumented, so the curve illustrates rather than measures.
function biquad(kind, f0, gain, q) {
  const A = 10 ** (gain / 40), w = 2 * Math.PI * f0 / FS, cos = Math.cos(w), sin = Math.sin(w);
  if (kind === "peak") {
    const alpha = sin / (2 * q);
    return [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
  }
  const alpha = sin / Math.SQRT2, root = 2 * Math.sqrt(A) * alpha, sign = kind === "low" ? 1 : -1;
  return [A * ((A + 1) - sign * (A - 1) * cos + root), sign * 2 * A * ((A - 1) - sign * (A + 1) * cos),
    A * ((A + 1) - sign * (A - 1) * cos - root), (A + 1) + sign * (A - 1) * cos + root,
    -sign * 2 * ((A - 1) + sign * (A + 1) * cos), (A + 1) + sign * (A - 1) * cos - root];
}
function decibels([b0, b1, b2, a0, a1, a2], f) {
  const w = 2 * Math.PI * f / FS, c1 = Math.cos(w), c2 = Math.cos(2 * w), s1 = Math.sin(w), s2 = Math.sin(2 * w);
  const num = (b0 + b1 * c1 + b2 * c2) ** 2 + (b1 * s1 + b2 * s2) ** 2;
  const den = (a0 + a1 * c1 + a2 * c2) ** 2 + (a1 * s1 + a2 * s2) ** 2;
  return 10 * Math.log10(num / den);
}
export function eqGraph(bands) {
  const graph = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "sound-eq-graph", role: "img", "aria-label": "Equalizer curve" });
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    graph.append(svg("line", { x1: xOf(f), x2: xOf(f), y1: 0, y2: H, class: "eq-grid" }));
    const text = svg("text", { x: xOf(f) + 3, y: H - 4, class: "eq-label" }); text.textContent = f >= 1000 ? `${f / 1000}k` : f;
    graph.append(text);
  }
  for (const g of [-12, -6, 0, 6, 12]) {
    graph.append(svg("line", { x1: 0, x2: W, y1: yOf(g), y2: yOf(g), class: g ? "eq-grid" : "eq-zero" }));
    const text = svg("text", { x: 4, y: yOf(g) - 3, class: "eq-label" }); text.textContent = `${g > 0 ? "+" : ""}${g} dB`;
    graph.append(text);
  }
  const area = svg("path", { class: "eq-area" }), curve = svg("path", { class: "eq-curve" });
  graph.append(area, curve);
  const value = input => Number(input.value);
  const nodes = bands.map((band, i) => {
    const node = svg("g", { class: "eq-node" });
    const label = svg("text", { class: "eq-node-label", "text-anchor": "middle", y: 4 }); label.textContent = i + 1;
    node.append(svg("circle", { r: 9 }), label); graph.append(node);
    node.addEventListener("pointerdown", event => {
      if (event.button) return;
      event.preventDefault(); node.setPointerCapture(event.pointerId); node.dataset.drag = "true";
    });
    node.addEventListener("pointermove", event => {
      if (!node.dataset.drag) return;
      const box = graph.getBoundingClientRect();
      const x = (event.clientX - box.left) * W / box.width, y = (event.clientY - box.top) * H / box.height;
      const snap = ({ MinValue: min, MaxValue: max, ValueStep: step }, raw) =>
        Number(clamp(min + Math.round((raw - min) / step) * step, min, max).toPrecision(12));
      setInput(band.freq, snap(band.freqKnob, fOf(x) / band.scale));
      setInput(band.gain, snap(band.gainKnob, gOf(y)));
    });
    for (const type of ["pointerup", "pointercancel"]) node.addEventListener(type, () => { delete node.dataset.drag; });
    return node;
  });
  const sync = () => {
    const filters = bands.map((band, i) => biquad(i === 0 ? "low" : i === bands.length - 1 ? "high" : "peak",
      value(band.freq) * band.scale, value(band.gain) || 0, band.q?.() ?? 1));
    let path = "";
    for (let x = 0; x <= W; x += 4) {
      const db = filters.reduce((sum, filter) => sum + decibels(filter, fOf(x)), 0);
      path += `${x ? "L" : "M"}${x} ${clamp(yOf(db), 0, H).toFixed(1)}`;
    }
    curve.setAttribute("d", path); area.setAttribute("d", `${path}L${W} ${yOf(0)}L0 ${yOf(0)}Z`);
    bands.forEach((band, i) => nodes[i].setAttribute("transform",
      `translate(${xOf(clamp(value(band.freq) * band.scale, LO, HI))} ${clamp(yOf(value(band.gain) || 0), 0, H)})`));
  };
  graph.sync = sync; sync(); return graph;
}

// A segmented switch over native radios, for short discrete choices.
// options: [{ text, value, checked, isDefault }]; onPick(value) on change.
let switchId = 0;
export function segmented(title, ariaLabel, options, onPick) {
  const group = document.createElement("div"); group.className = "sound-switch";
  group.setAttribute("role", "radiogroup"); group.setAttribute("aria-label", ariaLabel);
  const name = `sound-switch-${++switchId}`;
  const heading = document.createElement("span"); heading.className = "sound-control-name"; heading.textContent = title;
  const row = document.createElement("div"); row.className = "sound-switch-options";
  for (const option of options) {
    const label = document.createElement("label"), input = document.createElement("input"), text = document.createElement("span");
    Object.assign(input, { type: "radio", name, value: String(option.value), checked: !!option.checked });
    input.addEventListener("change", () => { onPick(option.value); group.dispatchEvent(new Event("input", { bubbles: true })); });
    text.textContent = option.text;
    if (option.isDefault) { label.dataset.default = "true"; label.title = "Default"; }
    label.append(input, text); row.append(label);
  }
  group.append(heading, row); return group;
}
