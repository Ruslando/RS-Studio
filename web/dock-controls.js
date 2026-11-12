import { nearestDock } from './edge-dock.js';

// Share drag capture, arrow-key docking and resize observation. Callers own the
// state update so additional fields (tabs/collapsed state) survive a drag.
export function wireDockControls(panel, handle, { bounds, move, setEdge, position, save, beforeMove = () => {} }) {
  let drag = null;
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); beforeMove();
    drag = { x: event.clientX, y: event.clientY, left: panel.offsetLeft, top: panel.offsetTop };
    handle.setPointerCapture(event.pointerId); panel.classList.add('docking');
  });
  handle.addEventListener('pointermove', event => {
    if (!drag) return;
    move(nearestDock(bounds(), drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y));
    position();
  });
  const finish = () => { if (drag) save(); drag = null; panel.classList.remove('docking'); };
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(event, finish);
  handle.addEventListener('keydown', event => {
    const edge = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom' }[event.key];
    if (!edge) return;
    event.preventDefault(); event.stopPropagation(); beforeMove();
    setEdge(edge); position(); save();
  });
  new ResizeObserver(position).observe(panel.parentElement);
  new ResizeObserver(position).observe(panel);
  new MutationObserver(position).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
}
