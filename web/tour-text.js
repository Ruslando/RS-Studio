// Walkthrough instructions use text nodes, action labels, and input glyphs.
const ACTIONS = [
  "Export Rocksmith CDLC (.psarc)", "Export legacy Guitar Pro (.gp5)",
  "Export Guitar Pro (.gp)", "Group selection into reference", "Group selection into shape",
  "Edit note layer settings", "Find similar passage", "Rocksmith arrangement",
  "Add audio layer", "Note layers", "Audio layers", "Upload my own", "Detect notes", "Export .chart",
  "Palm mute", "Vibrato", "Slide", "Reset override", "Heat", "Snap", "Edit", "File",
];
const INPUTS = {
  "left mouse button": ["mouse", "LMB"],
  "right mouse button": ["mouse", "RMB"],
  "right-click": ["mouse", "RMB"],
  "double-click": ["mouse", "double"],
  "click": ["mouse", "LMB"],
  "left and right arrow keys": ["key", "← →"],
  "up and down arrows": ["key", "↑ ↓"],
};
const escapePattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = new RegExp(`\\[\\[(.*?)\\]\\]|\\b(${[...ACTIONS, ...Object.keys(INPUTS)]
  .sort((a, b) => b.length - a.length).map(escapePattern).join("|")})(?!\\w)`, "gi");
const KEYS = new Set(["S", "F", "L", "Alt", "Shift", "Ctrl", "Control", "Escape", "Space", "←", "→", "↑", "↓"]);

export function instructionParts(text) {
  const parts = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > offset) parts.push({ kind: "text", label: text.slice(offset, match.index) });
    const label = match[1] ?? match[2];
    const input = INPUTS[label.toLowerCase()];
    const mouse = ["LMB", "RMB"].includes(label) ? ["mouse", label] : input;
    parts.push(mouse ? { kind: mouse[0], label: mouse[1] }
      : { kind: KEYS.has(label) ? "key" : match[1] !== undefined || ACTIONS.includes(label) ? "action" : "text", label });
    offset = match.index + match[0].length;
  }
  if (offset < text.length) parts.push({ kind: "text", label: text.slice(offset) });
  return parts;
}

export function renderInstruction(element, text) {
  element.replaceChildren();
  for (const part of instructionParts(text)) {
    if (part.kind === "text") { element.append(document.createTextNode(part.label)); continue; }
    const node = document.createElement(part.kind === "key" ? "kbd" : "span");
    node.className = `tour-${part.kind}`;
    if (part.kind === "mouse") {
      const right = part.label === "RMB";
      const label = right ? "Right mouse click" : part.label === "double" ? "Double click" : "Left mouse button";
      node.setAttribute("role", "img"); node.setAttribute("aria-label", label); node.title = label;
      node.innerHTML = `<svg width="16" height="20" viewBox="0 0 16 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 2c-3 0-5 2-5 5v6a5 5 0 0 0 10 0V7c0-3-2-5-5-5Z"/><path d="M8 2v6M3 8h10"/><path d="${right ? "M8 2c3 0 5 2 5 5v1H8Z" : "M8 2C5 2 3 4 3 7v1h5Z"}" fill="currentColor" stroke="none"/></svg>`;
      if (part.label === "double") node.append(document.createTextNode("×2"));
    } else {
      node.textContent = part.label === "Shift" ? "⇧" : part.label;
      if (part.kind === "key") { node.title = part.label; node.setAttribute("aria-label", part.label); }
    }
    element.append(node);
  }
}
