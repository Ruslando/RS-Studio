// Normalize persisted comments without loading editor UI or project lifecycle.
export function normalizeComments(list) {
  return (Array.isArray(list) ? list : [])
    .filter(c => c && Number.isFinite(+c.t) && Number.isFinite(+c.pitch))
    .map(c => ({ id: String(c.id || `comment_${Math.random().toString(36).slice(2)}`), t: +c.t, pitch: Math.round(+c.pitch), text: String(c.text || '') }));
}
