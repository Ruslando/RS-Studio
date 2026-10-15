// Deliberate hand-driven deformations, separate from ordinary pick brightness.
// x/contact/end are normalized along the visible string; time is song seconds.
export function popPreparation(note, t, lead = 0.1) {
  if (note?.slap !== "pop") return 0;
  const age = t - note.start;
  if (age < -lead || age >= 0.12) return 0;
  if (age >= 0) return Math.exp(-age / 0.022);
  const u = (age + lead) / lead;
  return u * u * (3 - 2 * u);
}

export function fingerWaveAt(x, contact, age, kind) {
  if (kind === "slap" && x <= contact) return 0;
  const duration = kind === "slap" ? 0.24 : 0.18;
  if (age < 0 || age >= duration) return 0;
  const progress = age / duration;
  const center = kind === "slap" ? 1 - progress : progress;
  const distance = kind === "slap" ? (1 - x) : Math.abs(x - contact);
  const front = kind === "slap" ? 1 - center : center;
  const packet = Math.exp(-(((distance - front) / 0.095) ** 2));
  const node = kind === "slap" ? 1 : 1 - Math.exp(-(((x - contact) / 0.04) ** 2));
  return node * packet * Math.sin((distance - front) * 30) * (1 - progress) * (kind === "slap" ? 0.5 : 0.32) || 0;
}

export const bendSnapAt = (age) => age >= 0 && age < 0.18
  ? Math.exp(-age / 0.04) * Math.cos(2 * Math.PI * 14 * age) : 0;
