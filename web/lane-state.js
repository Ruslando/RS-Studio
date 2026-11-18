// Read-only lane selectors shared by editing, playback and rendering.
import { S } from "./store.js";

export const editLanes = () => S.state.editLanes;

export const activeLane = () => S.state.lanes.find((l) => l.active);

export function targetLane() {
  return activeLane() || editLanes()[0] || null;
}


// Split view shows each view's active layer only; the other layers' eyes wait for one view.
let onlyActive = false;
export const showOnlyActiveLane = (on) => { onlyActive = on; };
export const laneShown = (l) => !!(l && l.visible && (!onlyActive || l.active));

export const canEditLane = (l) => !!(l && l.visible && !l.locked);

export const curStemObj = () => S.state.stems.find((s) => s.id === S.state.curStem) || S.state.stems[0];


export const laneOf = (note) => editLanes().find((l) => l.notes.includes(note)) || null;
