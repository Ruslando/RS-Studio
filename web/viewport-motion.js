import { scroll } from "./dom.js";
import { motionTiming } from "./panel-motion.js";
import { draw } from "./repaint.js";

let frame = 0;
export const viewportMoving = () => !!frame;
export function stopViewportMotion() {
  cancelAnimationFrame(frame);
  frame = 0;
}

// Retarget from the currently visible position while scrubbing. Transport time
// changes immediately; only the viewport travels to the new position.
export function moveViewportTo(left) {
  stopViewportMotion();
  const target = Math.max(0, Math.min(scroll.scrollWidth - scroll.clientWidth, left));
  const from = scroll.scrollLeft;
  const { duration, ease } = motionTiming();
  if (!duration || Math.abs(target - from) < 1) { scroll.scrollLeft = target; draw(); return; }
  const started = performance.now();
  const step = now => {
    const progress = Math.min(1, (now - started) / duration);
    scroll.scrollLeft = from + (target - from) * ease(progress);
    draw();
    frame = progress < 1 ? requestAnimationFrame(step) : 0;
  };
  frame = requestAnimationFrame(step);
}
scroll.addEventListener("wheel", stopViewportMotion, { passive: true });
scroll.addEventListener("pointerdown", stopViewportMotion);
window.addEventListener("cw-project-closed", stopViewportMotion);
window.addEventListener("cw-project-opened", stopViewportMotion);
