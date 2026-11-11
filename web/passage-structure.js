// Structural evidence for polyphonic passages. A chord attack is one event,
// regardless of how many strings it uses. Consecutive attacks of one harmony
// form a block; their beat pattern distinguishes grooves with similar chords.
const TOL = 1 / 24;
const harmony = event => [...new Set(event.notes.map(n => ((n.pitch % 12) + 12) % 12))].sort((a, b) => a - b).join(',');

function rhythmSimilarity(a, b) {
  const end = Math.min(a.at(-1), b.at(-1));
  const aa = a.filter(t => t <= end + TOL), bb = b.filter(t => t <= end + TOL);
  if (Math.min(aa.length, bb.length) < 3) return 0;
  const matched = aa.filter(t => bb.some(u => Math.abs(t - u) <= TOL)).length;
  return matched / Math.max(aa.length, bb.length);
}

export function passageStructure(events, beatAt) {
  const blocks = [], breaks = [];
  let section = 0;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.breakBefore) { section++; breaks.push(i); }
    if (event.notes.length < 3) continue;
    const key = harmony(event), last = blocks.at(-1);
    if (last && last.key === key && last.section === section) last.attacks.push(i);
    else blocks.push({ from: i, key, attacks: [i], section });
  }
  const grooves = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    block.to = Math.min(blocks[i + 1]?.from ?? events.length, breaks.find(j => j > block.from) ?? events.length);
    const attacks = block.attacks.length >= 3 ? block.attacks :
      Array.from({ length: block.to - block.from }, (_, j) => block.from + j);
    const kind = block.attacks.length >= 3 ? 'strummed' : 'picked';
    block.rhythm = attacks.map(j => events[j].beat - events[block.from].beat);
    // Isolated hits and very sparse fills do not establish a rhythmic texture.
    if (block.rhythm.length < 4 || block.rhythm.at(-1) > 16) continue;
    let groove = grooves.find(g => g.kind === kind && rhythmSimilarity(g.rhythm, block.rhythm) >= .8);
    if (!groove) { groove = { kind, rhythm: block.rhythm, id: grooves.length }; grooves.push(groove); }
    block.groove = groove.id;
  }
  const regions = [];
  let region = null;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i], previous = blocks[i - 1];
    const gap = previous && events[block.from].beat - Math.max(...events.slice(previous.from, previous.to)
      .flatMap(e => e.notes.map(n => beatAt(n.end))));
    // One different ending/fill is not a new texture. Require the next block
    // to confirm a changed groove before cutting a continuous passage.
    const changed = block.groove != null && region?.groove != null && block.groove !== region.groove &&
      blocks[i + 1]?.groove === block.groove;
    if (!region || previous?.section !== block.section || gap >= 8 || changed) {
      region = { from: block.from, to: block.to, groove: block.groove, blocks: [] };
      regions.push(region);
    }
    region.blocks.push(block); region.to = block.to;
    if (region.groove == null && block.groove != null) region.groove = block.groove;
  }
  return { blocks, regions: regions.filter(r => r.groove != null && r.blocks.length >= 4 &&
    new Set(r.blocks.map(b => b.key)).size >= 3 &&
    r.blocks.filter(b => b.groove === r.groove).length >= r.blocks.length * .65 &&
    events[r.to - 1].beat - events[r.from].beat >= 16) };
}
