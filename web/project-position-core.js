// Absolute project positions. Relative note effects and reference-box shapes
// are deliberately absent: translating a project never changes its rhythm.
export const projectStart = state => Math.max(0, Number(state?.projectStart) || 0);
export const songEnd = state => Math.max(projectStart(state), Math.min(Number(state?.duration) || Infinity,
  Number(state?.sectionMarkers?.find(marker => marker.sectionType === 'end')?.t
    ?? state?.duration ?? state?.scoreDuration ?? 0)));

export function projectShiftPlan(state, timings) {
  const writes = [], seen = new WeakMap();
  let first = projectStart(state), last = first;
  const position = (object, key, end = null) => {
    const value = object?.[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const keys = seen.get(object) || new Set();
    if (keys.has(key)) return;
    keys.add(key); seen.set(object, keys);
    first = Math.min(first, value); last = Math.max(last, end ?? value);
    writes.push(delta => { object[key] = value + delta; });
  };
  for (const lane of state.editLanes || []) {
    for (const note of lane.notes || []) {
      position(note, 'start'); position(note, 'end');
    }
    for (const field of ['toneMarkers', 'phraseBoundaries', 'handHolds'])
      for (const marker of lane[field] || []) position(marker, 't');
    for (const group of Object.values(lane.refBoxes || {}))
      for (let i = 0; i < (group?.anchors || []).length; i++) {
        const anchor = group.anchors[i];
        position(group.anchors, i, anchor + Math.max(0, Number(group.rt1) || 0));
        first = Math.min(first, anchor + Math.min(0, Number(group.rt0) || 0));
      }
  }
  for (const timing of timings) {
    position(timing.grid, 'offset');
    for (const marker of [...(timing.tempoMap || []), ...(timing.sectionMarkers || [])]) {
      // End belongs to the recording; moving chart contents leaves it in place.
      if (state.stems?.length && marker.sectionType === 'end') continue;
      position(marker, 't');
    }
    for (const bar of timing.scoreBars || []) position(bar, 'seconds');
  }
  const origin = projectStart(state), duration = state.duration;
  const scoreDuration = state.scoreDuration;
  const audio = !!state.stems?.length;
  return {
    origin,
    min: first > 0 ? -first : 0,
    max: audio ? Math.max(0, duration - last) : Infinity,
    apply(delta) {
      for (const write of writes) write(delta);
      state.projectStart = origin + delta;
      if (Number.isFinite(scoreDuration)) state.scoreDuration = scoreDuration + delta;
      if (!audio) {
        state.duration = duration + delta;
      }
    },
  };
}
