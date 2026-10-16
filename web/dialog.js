// Shared custom confirmation dialog for ordinary yes/no actions. Specialized
// multi-choice prompts (detect merge, paste mode) keep their own modal flows.

import {
  actionConfirmAccept,
  actionConfirmBackdrop,
  actionConfirmCancel,
  actionConfirmDiscard,
  actionConfirmMsg,
  actionConfirmModal,
  actionConfirmTitle,
} from "./dom.js";
import { rememberModalOpener } from "./modal-focus.js";

let closeActive = null;

// Resolves "confirm" | "alternative" | "discard" | "cancel". The left slot holds
// a destructive discard; with a neutral alternative there are two answers, so
// both stand on the right (alternative, then primary) and Cancel takes the left.
export function confirmChoice({ title, message, confirmLabel, cancelLabel = "Cancel", danger = false, discardLabel = "", alternativeLabel = "", signal = null }) {
  if (closeActive) closeActive("cancel");
  if (signal?.aborted) return Promise.resolve("cancel");

  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    rememberModalOpener(actionConfirmModal, previousFocus);
    actionConfirmTitle.textContent = title;
    actionConfirmMsg.textContent = message;
    actionConfirmAccept.textContent = confirmLabel;
    actionConfirmCancel.textContent = cancelLabel;
    actionConfirmAccept.classList.toggle("danger", danger);
    actionConfirmDiscard.hidden = !discardLabel && !alternativeLabel;
    actionConfirmDiscard.classList.toggle("danger", !!discardLabel);
    if (discardLabel || alternativeLabel) actionConfirmDiscard.textContent = discardLabel || alternativeLabel;
    const footer = actionConfirmDiscard.parentElement, actions = actionConfirmAccept.parentElement;
    if (alternativeLabel && !discardLabel) { footer.prepend(actionConfirmCancel); actions.append(actionConfirmDiscard, actionConfirmAccept); }
    actionConfirmBackdrop.hidden = false;

    let done = false;
    const finish = (choice) => {
      if (done) return;
      done = true;
      closeActive = null;
      actionConfirmBackdrop.hidden = true;
      actionConfirmDiscard.hidden = true;
      footer.prepend(actionConfirmDiscard); actions.prepend(actionConfirmCancel); actions.append(actionConfirmAccept);
      actionConfirmAccept.removeEventListener("click", onConfirm);
      actionConfirmCancel.removeEventListener("click", onCancel);
      actionConfirmDiscard.removeEventListener("click", onDiscard);
      window.removeEventListener("keydown", onKey, true);
      signal?.removeEventListener("abort", onAbort);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
      resolve(choice);
    };
    const onConfirm = () => finish("confirm");
    const onCancel = () => finish("cancel");
    const onDiscard = () => finish(discardLabel ? "discard" : "alternative");
    const onAbort = () => finish("cancel");
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };

    closeActive = finish;
    actionConfirmAccept.addEventListener("click", onConfirm);
    actionConfirmCancel.addEventListener("click", onCancel);
    actionConfirmDiscard.addEventListener("click", onDiscard);
    window.addEventListener("keydown", onKey, true);
    signal?.addEventListener("abort", onAbort, { once: true });
    actionConfirmCancel.focus();
  });
}

// Resolves true when the action is confirmed and false when it is cancelled.
// Opening a second confirmation cancels the first so listeners never stack.
export function confirmAction(options) {
  return confirmChoice(options).then((choice) => choice === "confirm");
}
