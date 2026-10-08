// One desktop focus lifecycle for every modal, including nested tuning dialogs.
// Feature controllers still own Save, Cancel, Escape and their draft state.
const explicitOpeners = new WeakMap();
export function rememberModalOpener(dialog, opener) {
  explicitOpeners.set(dialog, opener);
}
export function initModalFocus() {
  const priorFocus = new Map();
  const priorInert = new Map();
  let open = [];
  const visible = (el) => !el.closest('[hidden]') && el.getClientRects().length > 0;
  const focusable = (dialog) => [...dialog.querySelectorAll(
    'button, input:not([type="hidden"]), select, textarea, a[href], [tabindex]'
  )].filter((el) => !el.disabled && el.tabIndex >= 0 && visible(el));
  // The walkthrough must stay operable while it explains an open settings dialog.
  // A confirmation still owns the whole interaction until answered.
  const interactionRoots = (top) => {
    const tour = document.body.classList.contains('tour-active') &&
      top.getAttribute('role') !== 'alertdialog'
      ? document.querySelector('.tour-card') : null;
    return tour ? [top, tour] : [top];
  };
  function sync() {
    const next = [...document.querySelectorAll('[aria-modal="true"]')].filter(visible);
    for (const child of priorInert.keys()) {
      if (!child.isConnected) priorInert.delete(child);
    }
    const closed = open.filter((dialog) => !next.includes(dialog));
    for (const dialog of next) {
      if (!open.includes(dialog)) priorFocus.set(dialog, explicitOpeners.get(dialog) || document.activeElement);
    }
    // Preserve opening order: the most recently opened dialog owns focus.
    open = [...open.filter((dialog) => next.includes(dialog)), ...next.filter((dialog) => !open.includes(dialog))];
    const top = open.at(-1);
    const roots = top ? interactionRoots(top) : [];
    for (const child of document.body.children) {
      if (!priorInert.has(child)) priorInert.set(child, child.inert);
      const inert = top ? !child.matches(".toasts") && !roots.some((root) => child.contains(root)) : priorInert.get(child);
      // Reapplying inert can dismiss native select popups in WebView2.
      // Leave the active control untouched while unrelated UI redraws.
      if (child.inert !== inert) child.inert = inert;
    }
    const returnTarget = priorFocus.get(closed.at(-1));
    if (top && returnTarget && roots.some((root) => root.contains(returnTarget)) && visible(returnTarget)) {
      returnTarget.focus({ preventScroll: true });
    }
    if (top && !roots.some((root) => root.contains(document.activeElement))) {
      const controls = focusable(top);
      // Confirmations start on Cancel; ordinary forms start in their first field.
      const target = top.getAttribute('role') === 'alertdialog'
        ? controls.find((el) => /cancel/i.test(el.id))
        : controls.find((el) => el.matches('input, select, textarea'));
      (target || controls[0] || top).focus({ preventScroll: true });
    }
    if (!top && closed.length) {
      const target = priorFocus.get(closed[0]);
      if (target?.isConnected && visible(target) && !target.closest('[inert]')) target.focus({ preventScroll: true });
    }
    for (const dialog of closed) {
      priorFocus.delete(dialog);
      explicitOpeners.delete(dialog);
    }
  }
  document.addEventListener('keydown', (event) => {
    const top = open.at(-1);
    if (!top || event.key !== 'Tab') return;
    const controls = interactionRoots(top).flatMap(focusable);
    const index = controls.indexOf(document.activeElement);
    if (!controls.length) { event.preventDefault(); return; }
    if (event.shiftKey && index <= 0) {
      event.preventDefault(); controls.at(-1).focus();
    } else if (!event.shiftKey && (index < 0 || index === controls.length - 1)) {
      event.preventDefault(); controls[0].focus();
    }
  }, true);
  new MutationObserver(sync).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'aria-modal', 'role'] });
  // Walkthroughs may start or end while a dialog remains open.
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  sync();
}
