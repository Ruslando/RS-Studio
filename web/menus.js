// One menu controller for the app bar, project actions and panel options.
import { placeFloating } from './floating-position.js';
let viewportListeners = false;

export function closeMenus() {
  const focused = document.activeElement.closest?.('.menu-list');
  const trigger = focused?.parentElement.querySelector('.menu-btn');
  document.querySelectorAll('.menu-anchor .menu-list').forEach((list) => { list.hidden = true; });
  document.querySelectorAll('.menu-anchor .menu-btn').forEach((button) => button.setAttribute('aria-expanded', 'false'));
  trigger?.focus();
}

export function wireMenuAnchors(root, onOpen = () => {}) {
  if (!viewportListeners) {
    viewportListeners = true;
    const closeFloating = () => {
      if (document.querySelector('[data-floating-menu] .menu-btn[aria-expanded="true"]')) closeMenus();
    };
    // A fixed popup must not remain behind when its project row moves.
    document.addEventListener('scroll', closeFloating, true);
    window.addEventListener('resize', closeFloating);
  }
  for (const menu of root.querySelectorAll('.menu-anchor')) {
    const button = menu.querySelector('.menu-btn'), list = menu.querySelector('.menu-list');
    if (!button || !list) continue;
    const items = () => [...list.querySelectorAll('.menu-item')].filter((item) => !item.disabled && !item.hidden);
    const open = () => {
      closeMenus(); onOpen(); list.hidden = false; button.setAttribute('aria-expanded', 'true');
      if (menu.hasAttribute('data-floating-menu')) {
        const rect = button.getBoundingClientRect();
        placeFloating(list, rect.right - list.offsetWidth, rect.bottom, 4);
      }
    };
    button.addEventListener('click', (event) => { event.stopPropagation(); if (list.hidden) open(); else closeMenus(); });
    button.addEventListener('mouseenter', () => {
      if (root.querySelector('.menu-btn[aria-expanded="true"]')) open();
    });
    button.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault(); open(); (event.key === 'ArrowDown' ? items()[0] : items().at(-1))?.focus();
    });
    list.addEventListener('keydown', (event) => {
      const options = items(), index = options.indexOf(document.activeElement);
      let target;
      if (event.key === 'ArrowDown') target = options[(index + 1) % options.length];
      if (event.key === 'ArrowUp') target = options[(index - 1 + options.length) % options.length];
      if (event.key === 'Home') target = options[0];
      if (event.key === 'End') target = options.at(-1);
      if (event.key === 'Escape') { event.preventDefault(); closeMenus(); return; }
      if (target) { event.preventDefault(); target.focus(); }
    });
    // Restore the anchor before a feature opens a dialog from this menu item.
    list.addEventListener('click', closeMenus, true);
  }
}
