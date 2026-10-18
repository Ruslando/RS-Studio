// A reloaded project can have the same lane id, note count and edit revision,
// but its notes are new objects. Never reuse grips that still target old notes.
const identities = new WeakMap();
let nextIdentity = 0;
const identityOf = object => {
  if (!identities.has(object)) identities.set(object, ++nextIdentity);
  return identities.get(object);
};

export function fretboardHandKey(lane, revision, tempo) {
  return `${identityOf(lane)}:${identityOf(lane.notes)}:${lane.id}:${revision}:${lane.notes.length}:${lane.instrument}:${lane.tuning}:${lane.transpositionPitch || 0}:${lane.capo || 0}:${tempo}`;
}
