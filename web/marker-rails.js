// Extension points for the marker rail above the note grid, and for the
// per-lane marker collections that feed it.
//
// Three rails register today: song sections, practice phrases and amp tone
// switches. They stay a registry rather than three hardcoded strips because a
// marker's meaning comes from whatever consumes it — the phrase and tone rails
// exist for the Rocksmith export and nothing else reads them, so the modules
// that own them keep their own drawing, hit-testing and menu entries.
//
// This was built so those two could live outside the app entirely, and they did
// for a while. The seam outlived the split: it is still what stops a rail's
// owner reaching into the stage's layout.
//
// Rails stack top-down in registration order, which is the order the app calls
// each module's init_* (see main.js). Sections register first, so they sit on
// top.
//
// Registering a lane field also hands the retiming job to this module when bars
// are inserted or removed. That is deliberately not left to the rail's owner: a
// collection that misses a retime silently desyncs from the score, and nobody
// notices until an export comes out wrong.

const rails = [];
const laneFields = new Map();
let origin = 0;
let hidden = false;

// An empty rail is not a rail. Flags float directly over the spectrogram;
// only occupied bands reserve space for their flags and hit targets.
// A rail declares `count()` and collapses to nothing at zero; one that declares
// none is always shown. The context menu is how the first marker of a kind gets added — the
// double-click band is gone with the strip, which is also what stops three
// collapsed rails from all answering to the same click.
const occupied = (rail) => typeof rail.count !== "function" || rail.count() > 0;

// The whole marker layer, off. It is an overlay rather than a gutter, so hiding
// it hands the covered spectrogram back. Session-only: a view toggle, like zoom.
export function railsHidden() {
  return hidden;
}

export function setRailsHidden(value) {
  hidden = !!value;
  // The state lands instantly; the animation is something a caller opts into by
  // rewinding the scale afterwards (ui.js does). Otherwise "hidden" would mean
  // "hidden except for whatever the last tween left behind", which is the kind of
  // state a test cannot set and a bug can.
  scale = hidden ? 0 : 1;
}

// Overlay reveal, 0..1. Clip the complete stack instead of shrinking individual
// bands, so full-size flags retain their spacing. ui.js owns animation frames.
let scale = 1;
export const railScale = () => scale;
export function setRailScale(value) {
  const v = Number(value);
  scale = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}
const railHeight = (rail) => rail.height;

// Overview annotations describe the song, independently of the editor overlay.
export const overviewMarkerRails = () => rails.filter(occupied);

// Where the rail stack begins, below the tempo/meter flag strip. Core sets this
// once; rails never hardcode it.
export function setRailOrigin(y) {
  origin = Number(y) || 0;
}

// rail: { id, height, draw?, drawMinimap?, cursorAt?, mouseDown?,
//          menuLabel?, addAt?(time, clientX, clientY) }
// menuLabel + addAt contribute an entry to the canvas right-click menu.
export function registerMarkerRail(rail) {
  if (!rail?.id) throw new Error("marker rail needs an id");
  if (rails.some((existing) => existing.id === rail.id))
    throw new Error(`duplicate marker rail: ${rail.id}`);
  rails.push(rail);
  return rail;
}

// The rails that are on screen — occupied, and the layer not hidden. This is
// what draw and the mousedown/cursor chains iterate, so an absent rail costs
// nothing anywhere. Registration order is preserved.
export function markerRails() {
  return hidden && scale <= 0 ? [] : rails.filter(occupied);
}

// Canvas right-click entries contributed by rails, in rail order. Built from the
// full registry, because an empty rail still has to be fillable — but not while
// the layer is hidden: a marker added to a strip nobody can see is a marker lost.
export function railMenuItems(atTime, clientX, clientY) {
  return (hidden ? [] : rails)
    .filter((rail) => rail.menuLabel && rail.addAt)
    .map((rail) => ({
      label: rail.menuLabel,
      fn: () => rail.addAt(atTime, clientX, clientY),
    }));
}

// Absolute local (unscrolled) y offset and height of one rail. A rail that is
// not on screen reports h 0, which is what collapses the ones below it upward.
export function railBand(id) {
  let y = origin;
  for (const rail of markerRails()) {
    if (rail.id === id) return { y, h: railHeight(rail) };
    y += railHeight(rail);
  }
  return { y: origin, h: 0 };
}

// Is a stage-local y inside a rail's strip, including the 2px grab margin every
// rail allows? h 0 answers false, so the collapsed rails — which all sit at the
// same y — cannot be hit. Written out six times across three files before this,
// once with the operands in a different order, which is how that margin drifts.
export function inRailBand(id, localY) {
  if (hidden || scale < 1) return false;
  const { y, h } = railBand(id);
  return h > 0 && localY >= y && localY <= y + h + 2;
}

export function railsBottom() {
  return markerRails().reduce((total, rail) => total + railHeight(rail), origin);
}

// ---- per-lane marker collections ----

// `aliases` carries pre-rename keys so the migration lives with the feature
// that owns it rather than in core's persistence code.
export function registerLaneField(name, { normalize, aliases = [] } = {}) {
  if (typeof normalize !== "function")
    throw new Error(`lane field ${name} needs a normalize function`);
  laneFields.set(name, { normalize, aliases });
}

function rawLaneField(lane, name, aliases) {
  for (const key of [name, ...aliases]) {
    const value = lane?.[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

// Normalized copies of every registered field, ready to spread into a lane.
// Returns {} when nothing registered a field, so a lane gains nothing.
export function normalizedLaneFields(lane, duration = Infinity) {
  const out = {};
  for (const [name, { normalize, aliases }] of laneFields)
    out[name] = normalize(rawLaneField(lane, name, aliases), duration);
  return out;
}

export function emptyLaneFields() {
  return Object.fromEntries([...laneFields.keys()].map((name) => [name, []]));
}

// Every registered time-carrying object across all lanes, so core retimes them
// alongside notes and tempo/section markers.
export function timedLaneMarkers(lanes) {
  const out = [];
  for (const lane of lanes || [])
    for (const name of laneFields.keys())
      for (const item of lane?.[name] || []) out.push(item);
  return out;
}
