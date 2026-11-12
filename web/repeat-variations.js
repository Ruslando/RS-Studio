// Variations describe recurring note patterns within an already established
// passage family. Performance choices (fingers, positions, FX) are excluded.
export function alphabeticLabel(index) {
  let label = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label;
  return label;
}
const keyOf = copy => copy.ids?.[0] || copy.notes[0].note.id;
export function variationSimilarity(a, b, beatAt = t => t) {
  const used = new Set();
  let score = 0;
  for (const x of a.notes) {
    const candidates = b.notes.filter(y => !used.has(y) && Math.abs(x.beat - y.beat) <= .125 + 1e-9);
    const y = candidates.find(y => x.note.pitch === y.note.pitch) || candidates[0];
    if (!y) continue;
    used.add(y);
    if (x.note.pitch !== y.note.pitch) continue;
    const duration = n => beatAt(n.end) - beatAt(n.start);
    score += Math.max(0, 1 - (Math.abs(duration(x.note) - duration(y.note)) > 1 / 32 + 1e-9 ? .5 : 0)
      - (Math.abs(x.beat - y.beat) > 1 / 32 + 1e-9 ? .5 : 0));
  }
  return score / Math.max(a.notes.length, b.notes.length);
}
export function repeatVariations(group, beatAt = t => t) {
  const copies = group.copies, keys = copies.map(keyOf);
  if (!copies.length) return [];
  if (group.variations?.length) {
    const used = new Set();
    const saved = group.variations.map(v => ({ id: v.id, name: v.name,
      copies: v.copies.filter(key => keys.includes(key) && !used.has(key) && used.add(key)) })).filter(v => v.copies.length);
    let serial = Math.max(0, ...saved.map(v => Number(v.id.match(/(\d+)$/)?.[1]) || 0));
    for (const key of keys) if (!used.has(key)) {
      const index = ++serial;
      saved.push({ id: `variation_${index}`, name: `Variation ${alphabeticLabel(index - 1)}`, copies: [key] });
    }
    return saved;
  }
  if (copies.some(c => !c.notes)) return [];
  const scores = copies.map((a, i) => copies.map((b, j) => i === j ? 1 : variationSimilarity(a, b, beatAt)));
  let clusters = copies.map((_, i) => [i]);
  while (clusters.length > 1) {
    let best = null, score = .85 - 1e-9;
    for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
      const similarity = Math.min(...clusters[i].flatMap(a => clusters[j].map(b => Math.min(scores[a][b], scores[b][a]))));
      if (similarity > score) { score = similarity; best = [i, j]; }
    }
    if (!best) break;
    clusters[best[0]].push(...clusters[best[1]]); clusters.splice(best[1], 1);
  }
  // Only recurring patterns merit a subgroup. Collect unmatched patterns
  // together instead of giving every unique instance its own variation.
  const recurring = clusters.filter(c => c.length >= 2);
  const others = clusters.filter(c => c.length === 1).flat();
  if (!recurring.length || (recurring.length === 1 && !others.length)) return [];
  recurring.sort((a, b) => Math.min(...a) - Math.min(...b));
  const variations = recurring.map((cluster, i) => ({ id: `variation_${i + 1}`, name: `Variation ${alphabeticLabel(i)}`,
    copies: cluster.sort((a, b) => a - b).map(i => keys[i]) }));
  if (others.length) variations.push({ id: 'variation_other', name: 'Other variations', copies: others.sort((a, b) => a - b).map(i => keys[i]) });
  return variations;
}
