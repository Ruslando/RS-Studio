// Native range input with a readable scale, snap points and a labelled default mark.
let nextId = 0;
export function parameterSlider(slider, {
  min, max, step, defaultValue, format = String, onDefault, showDefault = true, labels = {}, snapPoints = null,
}) {
  const wrap = document.createElement("div"); wrap.className = "parameter-slider";
  Object.assign(slider, { min, max, step });
  const ticks = document.createElement("datalist"); ticks.id = `parameter-ticks-${++nextId}`;
  const points = new Set([min, max, defaultValue, ...(snapPoints || [])]);
  if (!snapPoints) {
    for (let i = 1; i < 4; i++) {
      const value = min + Math.round((max - min) * i / 4 / step) * step;
      points.add(Number(value.toPrecision(12)));
    }
  }
  for (const value of [...points].sort((a, b) => a - b)) ticks.append(new Option(format(value), String(value)));
  slider.setAttribute("list", ticks.id);
  const at = value => (value - min) / (max - min);
  const markers = document.createElement("div"); markers.className = "parameter-markers"; markers.setAttribute("aria-hidden", "true");
  for (const value of points) {
    const mark = document.createElement("i"); mark.style.setProperty("--at", at(value));
    if (value === defaultValue) mark.className = "is-default";
    markers.append(mark);
  }
  const scale = document.createElement("div"); scale.className = "parameter-scale";
  const low = document.createElement("span"), high = document.createElement("span");
  low.textContent = labels[min] ?? format(min); high.textContent = labels[max] ?? format(max);
  scale.append(low, high);
  for (const [rawValue, label] of Object.entries(labels)) {
    const value = Number(rawValue);
    if (value <= min || value >= max) continue;
    const tick = document.createElement("span");
    tick.className = "parameter-scale-label";
    tick.textContent = label;
    tick.style.setProperty("--at", at(value));
    scale.append(tick);
  }
  if (showDefault) {
    // The default value sits under its own mark; clicking it restores that value.
    const reset = document.createElement("button"); reset.type = "button"; reset.className = "parameter-default";
    const f = at(defaultValue);
    reset.textContent = format(defaultValue); reset.style.setProperty("--at", f);
    reset.dataset.edge = f < .1 ? "start" : f > .9 ? "end" : "";
    reset.title = `Default ${format(defaultValue)}; click to reset`;
    reset.setAttribute("aria-label", `${slider.getAttribute("aria-label")} default ${format(defaultValue)}`);
    reset.addEventListener("click", onDefault);
    scale.append(reset);
  }
  wrap.append(slider, markers, ticks, scale);
  if (showDefault) overlaps.observe(scale);
  return wrap;
}
// Hide an end label the default label would overlap; widths change with the window.
const overlaps = new ResizeObserver(entries => {
  for (const { target } of entries) {
    const low = target.querySelector(":scope > span:first-child");
    const high = target.querySelector(":scope > span:nth-child(2)");
    const reset = target.querySelector(".parameter-default");
    if (!reset) continue;
    const mark = reset.getBoundingClientRect();
    for (const end of [low, high]) {
      const box = end.getBoundingClientRect();
      end.style.visibility = box.right + 4 > mark.left && box.left - 4 < mark.right ? "hidden" : "";
    }
  }
});
