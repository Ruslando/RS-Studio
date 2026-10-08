// Canvas panels use the same duration and easing tokens as CSS panels.
export function motionTiming(durationToken = "--dur-panel", easeToken = "--ease-panel") {
  const css = getComputedStyle(document.documentElement);
  const duration = matchMedia("(prefers-reduced-motion: reduce)").matches
    ? 0 : parseFloat(css.getPropertyValue(durationToken));
  const [x1, y1, x2, y2] = css.getPropertyValue(easeToken).match(/[\d.]+/g).map(Number);
  const coordinate = (t, a, b) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
  const ease = (progress) => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (coordinate(mid, x1, x2) < progress) lo = mid;
      else hi = mid;
    }
    return progress <= 0 ? 0 : progress >= 1 ? 1 : coordinate((lo + hi) / 2, y1, y2);
  };
  return { duration, ease };
}
export const panelMotion = () => motionTiming();
