// Hand technique cues, separate from ordinary pick brightness.
// x/contact/end are normalized along the visible string; time is song seconds.
export function popPreparation(note, t, lead = 0.18) {
  if (note?.slap !== "pop") return 0;
  const age = t - note.start;
  if (age < -lead || age >= 0.14) return 0;
  if (age >= 0) {
    // Release quickly into the board, followed by a small damped rebound.
    if (age < 0.018) {
      const u = age / 0.018;
      return 1 - 1.4 * u * u * (3 - 2 * u);
    }
    const rebound = age - 0.018;
    return -0.4 * Math.exp(-rebound / 0.025) * Math.cos(2 * Math.PI * 20 * rebound);
  }
  const u = (age + lead) / lead;
  return u * u * (3 - 2 * u);
}

// The whole sounding segment lifts, with the fret and bridge fixed in place.
export function popLiftAt(x, contact, amount, anchor = 0) {
  const shape = x <= contact ? (x - anchor) / Math.max(0.001, contact - anchor)
    : (1 - x) / Math.max(0.001, 1 - contact);
  return amount * Math.max(0, Math.min(1, shape)) || 0;
}

export function popThicknessAt(x, contact, amount, anchor = 0) {
  return 1 + 1.8 * popLiftAt(x, contact, amount, anchor);
}

// A hammer lands once; a tap sends out a larger pair of concentric rings.
export function fingerPulseAt(mark, t) {
  const kind = mark.note?.slap === "tap" ? "tap" : mark.hammerMotion === "hammer" ? "hammer" : null;
  if (!kind || mark.dead || mark.releasing) return null;
  const age = t - mark.start, duration = kind === "tap" ? 0.4 : 0.3;
  if (age < 0 || age >= duration) return null;
  const u = age / duration;
  return { kind, progress: u, strength: (1 - u) ** 2,
    radius: 1.05 + (kind === "tap" ? 2.2 : 1.5) * u,
    rings: kind === "tap" ? 2 : 1 };
}

// Finger energy travels as light along the string, without displacing it.
export function fingerLightAt(x, contact, age, kind) {
  if (!["hammer", "tap"].includes(kind) || age < 0 || age >= 0.24
      || (kind === "hammer" && x < contact)) return 0;
  const progress = age / 0.24, distance = Math.abs(x - contact);
  return Math.exp(-(((distance - progress) / 0.065) ** 2)) * (1 - progress);
}

export function fingerWaveAt(x, contact, age, kind) {
  if (kind !== "slap" || x <= contact) return 0;
  const duration = 0.24;
  if (age < 0 || age >= duration) return 0;
  const progress = age / duration;
  const distance = 1 - x;
  const packet = Math.exp(-(((distance - progress) / 0.095) ** 2));
  return packet * Math.sin((distance - progress) * 30) * (1 - progress) * 0.5 || 0;
}

export const bendSnapAt = (age) => age >= 0 && age < 0.18
  ? Math.exp(-age / 0.04) * Math.cos(2 * Math.PI * 14 * age) : 0;
