// Hand technique cues, separate from ordinary pick brightness.
// x/contact/end are normalized along the visible string; time is song seconds.
export function popPreparation(note, t, lead = 0.18) {
  if (note?.slap !== "pop") return 0;
  const age = t - note.start;
  if (age < -lead || age >= 0.12) return 0;
  if (age >= 0) return Math.exp(-age / 0.035) * Math.cos(2 * Math.PI * 18 * age);
  const u = (age + lead) / lead;
  return u * u * (3 - 2 * u);
}

// Depth is shown by thickness in the top view, strongest at the pulling finger.
export function popThicknessAt(x, contact, amount, anchor = 0) {
  const shape = x <= contact ? (x - anchor) / Math.max(0.001, contact - anchor)
    : (1 - x) / Math.max(0.001, 1 - contact);
  return 1 + 1.8 * amount * Math.max(0, Math.min(1, shape));
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
