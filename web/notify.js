// Two things every module needs and nothing owns: tell the user something
// happened, and hand them a file.
//
// Both used to live in project.js, which meant six modules — interaction,
// references, tablature, tracing, voicing, and the Rocksmith export — imported
// the entire project lifecycle to pop a toast. Neither function touches a
// project, a lane or the store, so this module imports nothing at all and can
// be pulled into anything without dragging the app behind it.

let toastWrap = null;

// Keep a notification available while its text or copy button is in use.
function toastLifetime(element, ms) {
  let ready = false;
  let hovered = false;
  let focused = false;
  let timeout;
  let removal;
  function pause() {
    clearTimeout(timeout);
    clearTimeout(removal);
    element.classList.add("show");
  }
  function resume() {
    clearTimeout(timeout);
    clearTimeout(removal);
    if (!ready || hovered || focused) return;
    timeout = setTimeout(() => {
      element.classList.remove("show");
      removal = setTimeout(() => element.remove(), 250);
    }, ms);
  }
  element.addEventListener("mouseenter", () => { hovered = true; pause(); });
  element.addEventListener("mouseleave", () => { hovered = false; resume(); });
  element.addEventListener("focusin", () => { focused = true; pause(); });
  element.addEventListener("focusout", (event) => {
    if (element.contains(event.relatedTarget)) return;
    focused = false;
    resume();
  });
  return () => { ready = true; resume(); };
}

function addToastCopyButton(element, getText) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "toast-copy";
  button.textContent = "Copy";
  button.setAttribute("aria-label", "Copy notification text");
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      button.textContent = "Copied";
    } catch {
      // Clipboard access may be disabled in a desktop webview. Select the
      // message so the user can still copy it with the keyboard.
      const range = document.createRange();
      range.selectNodeContents(element.querySelector(".toast-text"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = "Press Ctrl+C";
    }
  });
  element.append(button);
}

// Transient bottom-centre notification. Deliberately unqueued and uncapped: at
// the rate a person can trigger these, stacking them reads fine, and a queue
// would delay the one that matters behind ones that no longer do.
//
// `status` is "ok" | "warn" | "error" and draws the 8px dot — the toast is one
// of the three places status colour is allowed to appear, and the dot is the
// whole of it: no coloured text, no left status bar.
export function toast(msg, ms = 2200, status = "") {
  if (!toastWrap) {
    toastWrap = document.createElement("div");
    toastWrap.className = "toasts";
    document.body.append(toastWrap);
  }
  const t = document.createElement("div");
  t.className = "toast";
  if (status) {
    const dot = document.createElement("span");
    dot.className = `dot ${status}`;
    t.append(dot);
  }
  const text = document.createElement("span");
  text.className = "toast-text";
  text.textContent = msg;
  t.append(text);
  if (status === "warn" || status === "error") addToastCopyButton(t, () => text.textContent);
  toastWrap.append(t);
  // Append first, then add the class on the next frame, so the browser has a
  // starting style to transition from — setting both in one go paints it
  // already-shown and the fade-in never runs.
  requestAnimationFrame(() => t.classList.add("show"));
  toastLifetime(t, ms)();
}

// Persistent processing notification: only its operation can complete it.
export function progressToast(title, detail, onCancel = null) {
  if (!toastWrap) {
    toastWrap = document.createElement("div");
    toastWrap.className = "toasts";
    document.body.append(toastWrap);
  }
  const element = document.createElement("div");
  element.className = "toast processing-toast";
  element.setAttribute("role", "status");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const context = document.createElement("span");
  context.className = "processing-context";
  context.textContent = detail;
  const stage = document.createElement("span");
  stage.className = "processing-stage";
  const bar = document.createElement("progress");
  bar.max = 1;
  bar.setAttribute("aria-label", title);
  const text = document.createElement("div");
  text.className = "toast-text processing-text";
  text.append(heading, context, stage);
  element.append(text, bar);
  let cancelButton = null;
  if (onCancel) {
    cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "toast-cancel";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", onCancel);
    element.append(cancelButton);
  }
  toastWrap.append(element);
  requestAnimationFrame(() => element.classList.add("show"));
  const finish = toastLifetime(element, 0);
  return {
    cancelling(value = true) {
      if (cancelButton) {
        cancelButton.disabled = value;
        cancelButton.textContent = value ? "Stopping…" : "Cancel";
      }
    },
    update(value) {
      if (cancelButton && ["done", "error", "cancelled"].includes(value.state)) {
        cancelButton.disabled = true;
        cancelButton.textContent = value.state === "cancelled" ? "Cancelled" : "Done";
      }
      const measured = Number.isFinite(value.fraction);
      if (measured) bar.value = value.fraction;
      else bar.removeAttribute("value");
      stage.textContent = (value.stage || "Preparing audio") +
        (measured ? ` · ${Math.round(value.fraction * 100)}%` : "") +
        (value.device ? ` · ${value.device === "cuda" ? "CUDA" : "CPU"}` : "");
    },
    finish,
  };
}

// Save bytes to disk through a synthetic link — the only way to do it from a
// page without a server round trip. The object URL is revoked immediately: the
// click has already handed the blob to the download manager by then.
export function downloadProjectBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
