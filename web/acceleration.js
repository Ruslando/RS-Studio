// Acceleration pane: whether this installation runs PyTorch on the graphics
// card, and adding the NVIDIA CUDA build later. Setup offers CUDA only on a
// machine that can use it, so this is where it is added once that changes.
// The server owns the answer (updates.py runtime); installing hands over to
// the launcher, which closes the app, installs and reopens it — like an update.

import { loadWithScreen } from "./project-loading.js";
import { confirmAction } from "./dialog.js";
import { $ } from "./dom.js";

const gb = (bytes) => `${(bytes / 2 ** 30).toFixed(2)} GB`;

function setStatus(message, error = false) {
  const el = $("accelStatus");
  el.textContent = message || "";
  el.hidden = !message;
  el.classList.toggle("error", !!message && error);
}

// One row in the Models pane's shape: dot, name, the fact, and a button that
// is disabled rather than missing when there is nothing to do (rule 8, rule 24).
function describe(state) {
  if (!state.supported) return { dot: "warn", fact: "", label: "Unavailable", why: "This copy was not installed with RS Studio Setup, which manages the CUDA build." };
  if (state.runtime === "cuda") return { dot: "ok", fact: (state.cuda && state.cuda.reason) || "", label: "Installed", why: "" };
  if (!state.cuda) return { dot: "warn", fact: "", label: "Unavailable", why: "This release has no CUDA build." };
  if (!state.cuda.useful) return { dot: "warn", fact: state.cuda.reason, label: "Unavailable", why: state.cuda.reason };
  const fact = `${state.cuda.reason} · +${gb(state.cuda.extra_bytes)}`;
  if (!state.can_install) return { dot: "warn", fact, label: "Unavailable", why: "Run the latest RS Studio Setup once on this installation to enable this." };
  return { dot: "warn", fact, label: "Install", install: true, why: "" };
}

async function install(state) {
  if (!await confirmAction({ title: "Install NVIDIA CUDA acceleration?",
    message: `RS Studio closes, downloads about ${gb(state.cuda.extra_bytes)} and reopens. Save your project first.`,
    confirmLabel: "Install" })) return;
  setStatus("");
  // The loading screen (design.md 4.17): RS Studio is about to close, so nothing
  // else may be started. If it is still here after half a minute, that is the failure.
  await loadWithScreen(async () => {
    const res = await fetch("/api/runtime/cuda", { method: "POST" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Could not start the installation");
    await new Promise((resolve) => setTimeout(resolve, 30000));
    throw new Error("RS Studio did not close. Close it yourself and the installation starts.");
  }, { title: "Closing RS Studio to install", failureTitle: "Could not install acceleration" });
}

export async function renderAcceleration() {
  try {
    const res = await fetch("/api/runtime");
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    const state = await res.json(), view = describe(state);
    const row = document.createElement("div");
    row.className = "list-row list-row--fields model-row";
    const dot = document.createElement("span");
    dot.className = `dot dot--${view.dot}`;
    const name = document.createElement("span");
    name.className = "model-name";
    name.innerHTML = '<span class="model-label">NVIDIA CUDA</span>';
    const fact = document.createElement("span");
    fact.className = "model-size";
    fact.textContent = view.fact;
    const go = document.createElement("button");
    go.type = "button";
    go.className = "model-get";
    go.textContent = view.label;
    go.disabled = !view.install;
    if (view.install) go.addEventListener("click", () => install(state));
    if (view.why) row.title = view.why;
    row.append(dot, name, fact, go);
    $("accelList").replaceChildren(row);
    setStatus("");
  } catch (error) {
    setStatus(error.message, true);
  }
}
