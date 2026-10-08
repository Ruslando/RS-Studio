// Stable id generation for notes ("n123") and lanes ("edit_5") from the shared
// uid counter, plus the loaded-project id bump/repair helpers that keep freshly
// minted ids from colliding with a reopened project's saved ids.

import { S } from "./store.js";

// Every id in the project is `<prefix><n>` drawn from one counter, so
// syncUidPastLoaded below can bump past the highest number it sees regardless of
// which kind it belongs to. Mint ids through these — `shape_${S.uid++}` was
// spelled out at two call sites in edit.js and is the same thing said twice.
export const nid = () => "n" + (S.uid++);

export const laneId = () => "edit_" + (S.uid++);

export const shapeId = () => "shape_" + (S.uid++);

// Note ids ("n123") and lane ids ("edit_5") both draw from `uid`. A loaded project
// keeps its saved ids, so `uid` must be bumped past the highest one or freshly
// created notes/lanes would reuse ids and collide with loaded content (corrupting
// selection, references, and undo, which all key off ids). Call after applyProject.
export function syncUidPastLoaded() {
  let max = 0;
  const consider = (id) => {
    const m = typeof id === "string" && id.match(/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  };
  const lanes = S.state.editLanes;
  for (const lane of lanes) {
    consider(lane.id);
    for (const n of lane.notes) { consider(n.id); consider(n.shapeId); }
  }
  S.uid = Math.max(S.uid, max + 1);
}

// Repair duplicate ids baked into an older project by the uid-reset bug (a reloaded
// session restarted uid at 1, so a freshly added lane/note could reuse a loaded id).
// Duplicate LANE ids are the corrupting case: undo snapshots key by lane id, so two
// lanes sharing one id get the same notes restored — silently overwriting one with
// the other. Mint a fresh id for every later duplicate. Run AFTER syncUidPastLoaded
// so the replacements can't collide either. Returns how many ids were repaired.
export function dedupeIds() {
  const seen = new Set();
  let fixed = 0;
  const uniq = (obj, mint) => {
    if (seen.has(obj.id)) { obj.id = mint(); fixed++; }
    seen.add(obj.id);
  };
  const lanes = S.state.editLanes;
  for (const lane of lanes) uniq(lane, laneId);
  for (const lane of lanes) for (const n of lane.notes) uniq(n, nid);
  return fixed;
}
