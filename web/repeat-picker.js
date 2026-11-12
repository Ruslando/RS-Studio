export function renderRepeatPicker(picker, choices, value, { disabled = false } = {}) {
  const focused = picker.contains(document.activeElement) ? document.activeElement?.dataset.focusKey : null;
  const summary = document.createElement('summary'); summary.dataset.focusKey = 'summary';
  summary.textContent = choices.find(choice => choice.value === value)?.label || 'Scanning…';
  summary.setAttribute('aria-label', picker.getAttribute('aria-label'));
  summary.setAttribute('aria-disabled', String(disabled));
  summary.addEventListener('click', event => { if (disabled) event.preventDefault(); });
  const menu = document.createElement('div'); menu.className = 'repeat-picker-menu';
  const select = next => {
    picker.open = false; picker.value = next;
    picker.dispatchEvent(new Event('change')); picker.children[0]?.focus();
  };
  for (const choice of choices) {
    const row = document.createElement('div'); row.className = 'repeat-picker-row';
    const button = document.createElement('button'); button.type = 'button'; button.textContent = choice.label;
    button.dataset.focusKey = choice.value; button.disabled = disabled || !!choice.disabled;
    button.setAttribute('aria-current', String(choice.value === value));
    button.addEventListener('click', () => select(choice.value)); row.append(button);
    menu.append(row);
  }
  picker.replaceChildren(summary, menu); picker.value = value;
  picker.onkeydown = event => {
    if (event.key === 'Escape' && picker.open) {
      event.preventDefault(); event.stopPropagation(); picker.open = false; summary.focus(); return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || disabled) return;
    event.preventDefault(); event.stopPropagation(); picker.open = true;
    const items = [...menu.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  if (focused === 'summary') summary.focus();
  else if (focused) [...menu.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === focused)?.focus();
}
