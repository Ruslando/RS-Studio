// Models pane: what each backend runs on, and fetching the weights that aren't
// here yet. The server owns the inventory (models.py); this renders it and polls
// while a download is in flight.
//
// Rule 17: a window stages its values, but an action inside it fires. Download
// is a job with its own progress — it runs when pressed and does not wait for
// Apply.

import { $ } from "./dom.js";

const POLL_MS = 1000;
let pollTimer = null;

// Rule 8: state is a dot, never coloured text. Ready and bundled are the same
// answer to the only question the row asks — can I use this now.
const DOT = { ready: "ok", bundled: "ok", missing: "warn", downloading: "warn",
              paused: "warn", error: "error" };

// Rule 6: a size is a value, so it is mono — and MB throughout, because a column
// that switches units stops being comparable, which is the point of the column.
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

// Speed is measured here rather than on the server: the poll already carries
// the byte count and the clock, so the server would only be re-deriving what
// two consecutive responses already say. Keyed by model id, since two can run.
const seen = new Map();

function speed(model) {
  const now = performance.now();
  const last = seen.get(model.id);
  seen.set(model.id, { at: now, done: model.done });
  if (!last || model.done <= last.done) return "";
  const rate = ((model.done - last.done) / (now - last.at)) * 1000;
  // A resumed transfer jumps by whatever was already on disk, which is not a
  // rate anyone can act on. Nothing here goes faster than a gigabit line.
  if (!Number.isFinite(rate) || rate > 2e8) return "";
  return ` · ${(rate / 1e6).toFixed(1)} MB/s`;
}

function setModelStatus(root, message, error = false) {
  const el = root.querySelector(".model-status");
  el.textContent = message || "";
  el.hidden = !message;
  el.classList.toggle("error", !!message && error);
}

// The value column is what the model weighs, and nothing else: a row that says
// "55.0 MB" beside one that says "in app" is two different columns pretending to
// be one. What the app has to do about the model is the button's job.
const percent = (model) => (model.size ? Math.floor((model.done / model.size) * 100) : 0);

// How far, out of how much, and how fast. The percent is the glance and the
// fraction is the answer to "will this finish before I need the machine" — on a
// 699 MB model over an unreliable line those are different questions, so the
// megabytes are not redundant with the percentage and both stay.
function progress(model) {
  return `${percent(model)}% · ${(model.done / 1e6).toFixed(1)} / ${mb(model.size)}`;
}

function modelValue(model) {
  if (model.state === "downloading") return progress(model) + speed(model);
  // Stopped part-way, by a pause or a dropped connection — same row either way,
  // because the bytes are kept either way and Resume continues from them.
  if (model.state === "paused" || (model.state === "error" && model.done)) {
    return progress(model);
  }
  return model.size ? mb(model.size) : "";
}

// Every row ends in a button, and a state you cannot act on says so by being
// disabled rather than by going missing — an empty slot reads as "still
// loading", which is the one thing none of these are.
//
// "Installed", not "Downloaded": the row answers whether the model is here, and
// where it came from is not the question. It also stops the disabled label from
// being the enabled one plus two letters, which at --hint contrast is a button
// that looks broken rather than a state that reads.
// `act` is what pressing it does, so a running download is not a dead label any
// more: it is the one row state whose button stops the work rather than starting
// it. Resume and Retry are the same job — continue from the bytes on disk — and
// they are named apart only because one of them was the user's own decision.
const ACTIONS = {
  ready:       { label: "Installed", act: null },
  bundled:     { label: "Included", act: null },
  downloading: { label: "Pause", act: "pause" },
  paused:      { label: "Resume", act: "download" },
  missing:     { label: "Download", act: "download" },
  error:       { label: "Retry", act: "download" },
};

// A state this build has no label for means the page and the server disagree —
// a Python change needs a restart while the JS reloads on its own, so the pair
// can be one version apart. It has to say that, not fall back to some other
// state's label: falling back to `missing` is what drew a dead "Download" on a
// model that was sitting on disk the whole time.
const UNKNOWN = { label: "Unavailable", act: false };

// Warnings travel with the wrapping name and keep their full explanation in
// the tooltip and accessible name; the row may grow with its content.
// The tooltip goes on a wrapping span with role/aria-label, never as title= on
// the <svg>, where the attribute is inert and leaves the mark unnamed.
function warnMark(text) {
  const span = document.createElement("span");
  span.className = "model-warn";
  span.title = text;
  span.setAttribute("role", "img");
  span.setAttribute("aria-label", text);
  span.innerHTML =
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M8 2.5 15 14H1z"/><path d="M8 6.5v3.5"/><path d="M8 12h.01"/></svg>';
  return span;
}

// Rule 24: an explanation belongs to the control it describes. Each of these is
// the sentence the button would need if it were allowed one.
function modelTitle(model) {
  if (!ACTIONS[model.state]) {
    return "This page and the running app are different versions. Restart the app.";
  }
  if (model.state === "error") return `${model.detail}\nWhat arrived is kept — Retry continues from there.`;
  if (model.state === "paused") return "Stopped part-way. Resume continues from what is on disk.";
  if (model.state === "bundled") return "Bundled with the app.";
  if (model.state === "missing" && !model.downloadable) {
    return `No download exists for this one. Put ${(model.files || []).join(" and ")} in ${model.dir}.`;
  }
  if (model.state === "ready") return (model.files || []).join("\n");
  return "";
}

export function modelRow(model, root) {
  const row = document.createElement("div");
  row.className = "list-row list-row--fields model-row";

  const dot = document.createElement("span");
  dot.className = `dot dot--${DOT[model.state] || "warn"}`;

  // The mark rides with the name rather than in a column of its own: given a
  // flexible name track, its own column lands wherever the slack ends, which
  // put the triangle adrift in the middle of the row pointing at nothing.
  const name = document.createElement("span");
  name.className = "model-name";
  const label = document.createElement("span");
  label.className = "model-label";
  label.textContent = model.label;
  name.append(label);
  if (model.warning) name.append(warnMark(model.warning));

  const value = document.createElement("span");
  value.className = "model-size";
  value.textContent = modelValue(model);

  const action = ACTIONS[model.state] || UNKNOWN;
  const go = document.createElement("button");
  go.type = "button";
  go.className = "model-get";
  // A model with no URL can't be fetched however missing it is, so its button
  // states what it wants instead of offering something that would fail.
  const usable = action.act && (model.downloadable || action.act === "pause");
  go.textContent = usable || model.state !== "missing" ? action.label : "Not installed";
  go.disabled = !usable;
  if (usable) go.addEventListener("click", () => post(model.id, action.act, root));

  row.append(dot, name, value, go);

  // What it needs to run belongs to every row, not just the warned ones: rule
  // 24's explanation-on-demand, and the answer to "installed, but will it be
  // usable" — which is a different question from the one the dot answers.
  const title = [modelTitle(model), model.needs].filter(Boolean).join("\n");
  if (title) row.title = title;
  return row;
}

function render(list, root) {
  if (root.closest("[hidden]")) return;
  const panes = {
    "Stem separation": root.querySelector(".model-list-separation"),
    "Note detection": root.querySelector(".model-list-detection"),
  };
  for (const el of Object.values(panes)) el.replaceChildren();
  for (const model of list) panes[model.kind]?.append(modelRow(model, root));

  const busy = list.some((m) => m.state === "downloading");
  clearTimeout(pollTimer);
  pollTimer = busy ? setTimeout(() => renderModels(root), POLL_MS) : null;
}

export async function renderModels(root = $("spModels")) {
  try {
    const res = await fetch("/api/models");
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    setModelStatus(root, "");
    render(await res.json(), root);
  } catch (error) {
    setModelStatus(root, error.message, true);
  }
}

export function stopModelPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

async function post(id, verb, root) {
  setModelStatus(root, "");
  seen.delete(id);  // a fresh transfer, so the old byte count is not a rate
  try {
    const res = await fetch(`/api/models/${id}/${verb}`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `${verb} failed`);
    render(await res.json(), root);
  } catch (error) {
    setModelStatus(root, error.message, true);
  }
}

