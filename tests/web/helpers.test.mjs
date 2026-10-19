// Run: node tests/web/helpers.test.mjs
// Note names and tunings, shortcuts, and which Rocksmith arrangement a layer defaults to.
import assert from "node:assert/strict";
import { conflictOf, eventKey, keyOf, keySnapshot, matchKey, resetKeys, restoreKeys, setKey, shortcutTitle } from "../../web/keymap.js";
import { assignRsKinds, defaultRsKind, isTablatureLane, rsKindFits, selectedTablatureLane } from "../../web/layer-role.js";
import { fmtTime, followerTrim, isAudioFile, isGuitarProFile, noteName, noteToMidi, onsetSec, parseTuning, playheadScrollLeft, songTimeToTabMs, tabMsToSongTime, tuningToNames, volumeToDb } from "../../web/util.js";

// ---- note names and tunings ----------------------------------------------
{
  assert.deepEqual([noteName(40), noteName(60), noteName(61), noteName(-1)], ["E2", "C4", "C#4", "B-2"]);
  assert.deepEqual([noteToMidi("E2"), noteToMidi("c#4"), noteToMidi("Db4"), noteToMidi(" A4 "), noteToMidi("H2"), noteToMidi("E")], [40, 61, 61, 69, null, null]);
  for (let p = 0; p < 128; p++) assert.equal(noteToMidi(noteName(p)), p);
  assert.deepEqual(parseTuning("E4 B3 G3 D3 A2 E2"), [64, 59, 55, 50, 45, 40]);
  assert.deepEqual(parseTuning("G2, D2,A1,E1"), [43, 38, 33, 28]);
  assert.equal(parseTuning("E4 B3"), null, "two strings are not an instrument");
  assert.equal(parseTuning("E4 B3 X3"), null);
  assert.equal(tuningToNames([64, 59, 55]), "E4 B3 G3");
}

// ---- time and playback helpers --------------------------------------------
{
  assert.deepEqual([fmtTime(0), fmtTime(65.9), fmtTime(600), fmtTime(NaN)], ["0:00", "1:05", "10:00", "0:00"]);
  assert.equal(tabMsToSongTime(songTimeToTabMs(12.5, 0.35, 0.98), 0.35, 0.98), 12.5);
  assert.equal(tabMsToSongTime(1000, 2, 0), 3, "a broken scale reads as none");
  // The view follows the playhead only once it leaves the visible part.
  assert.equal(playheadScrollLeft(5, 100, 800, 4000, 200), 200);
  assert.equal(playheadScrollLeft(15, 100, 800, 4000, 200), 1440);
  assert.equal(playheadScrollLeft(100, 100, 800, 4000, 200), 3200, "never past the end");
  assert.equal(playheadScrollLeft(15, 100, 800, 4000, 0, true), 1100);
  assert.equal(playheadScrollLeft(5, 100, 800, 4000, 200, false, "follow"), 440);
  assert.ok(Math.abs(playheadScrollLeft(5.1, 100, 800, 4000, 440, false, "follow") - 450) < 1e-9);
  assert.equal(playheadScrollLeft(0, 100, 800, 4000, 200, false, "follow"), 0);
  assert.equal(playheadScrollLeft(100, 100, 800, 4000, 0, false, "follow"), 3200);
  assert.equal(playheadScrollLeft(15, 100, 800, 4000, 200, false, "off"), 200);
  assert.equal(playheadScrollLeft(0, 100, 800, 4000, 200, false, "off"), 200);
  assert.equal(playheadScrollLeft(15, 100, 800, 4000, 0, true, "off"), 1100,
    "an explicit view switch can still reveal the playhead");
  assert.deepEqual([volumeToDb(1), volumeToDb(0), Math.round(volumeToDb(0.5))], [0, -80, -6]);
  // A sample's attack starts where it first reaches half its early peak, not at its noise.
  const sample = new Float32Array(1000); sample[100] = 0.02; sample[200] = 0.6; sample[300] = 1;
  assert.equal(onsetSec(sample, 1000), 0.2);
  assert.equal(onsetSec(new Float32Array(100), 1000), 0);
  assert.deepEqual([followerTrim(0.02), followerTrim(-0.02), followerTrim(0.001, 0.02), followerTrim(0.008, 0.02)], [-0.02, 0.02, 0, 0.02]);
  assert.ok(isAudioFile({ name: "a.bin", type: "audio/wav" }) && isAudioFile({ name: "Song.FLAC", type: "" }));
  assert.ok(!isAudioFile({ name: "a.gp5", type: "" }) && !isAudioFile(null));
  assert.ok(isGuitarProFile({ name: "a.GP5" }) && isGuitarProFile({ name: "a.gp" }) && !isGuitarProFile({ name: "a.gp6" }));
}

// ---- shortcuts ------------------------------------------------------------
{
  const key = (k, extra = {}) => ({ key: k, code: "", ...extra });
  assert.deepEqual([eventKey(key(" ")), eventKey(key("x", { code: "Space" })), eventKey(key("Backspace")), eventKey(key("m")), eventKey(key("ArrowLeft"))],
    ["Space", "Space", "Delete", "M", "ArrowLeft"]);
  assert.ok(matchKey(key("m"), "muteLayer"));
  assert.ok(!matchKey(key("m", { ctrlKey: true }), "muteLayer"), "Ctrl+M is somebody else's");
  assert.ok(matchKey(key("Backspace"), "delete"));
  assert.equal(conflictOf("F", "fretboard"), null, "a command does not conflict with itself");
  assert.equal(conflictOf("F", "muteLayer").id, "fretboard");
  assert.equal(conflictOf("S", "muteLayer").label, "Slice notes along a line", "fixed shortcuts are taken too");
  assert.equal(conflictOf("Q", "muteLayer"), null);
  setKey("muteLayer", "Q");
  assert.ok(matchKey(key("q"), "muteLayer") && !matchKey(key("m"), "muteLayer"));
  assert.equal(conflictOf("M", "fretboard"), null, "the old key is free again");
  resetKeys();
  assert.equal(keyOf("muteLayer"), "M");
  assert.ok(matchKey(key('+'), 'zoomIn') && matchKey(key('-'), 'zoomOut'));
  assert.ok(!matchKey(key('+', { ctrlKey: true }), 'zoomIn'), 'browser zoom remains separate');
  assert.equal(conflictOf('ArrowLeft', 'findSimilar').label, 'Previous / next chord — or match, while find-similar is live');
  assert.equal(keyOf('findSimilar'), null, 'new actions start unbound');
  setKey('findSimilar', 'Q');
  assert.ok(matchKey(key('q'), 'findSimilar'));
  const snapshot = keySnapshot();
  setKey('findSimilar', null);
  setKey('zoomIn', null);
  assert.equal(keyOf('zoomIn'), null, 'a default binding can also be removed');
  assert.ok(!matchKey(key('+'), 'zoomIn'));
  assert.equal(shortcutTitle('Zoom in', 'zoomIn'), 'Zoom in');
  restoreKeys(snapshot);
  assert.equal(keyOf('findSimilar'), 'Q');
  assert.equal(keyOf('zoomIn'), '+');
  setKey('muteLayer', 'B');
  assert.equal(keyOf('sidebar'), null, 'new defaults yield to existing custom bindings');
  assert.ok(matchKey(key('b'), 'muteLayer'));
  resetKeys();
}

// ---- which arrangement a layer exports as ---------------------------------
{
  const guitar = [64, 59, 55, 50, 45, 40], bass = [43, 38, 33, 28], bass5 = [43, 38, 33, 28, 23];
  const used = new Set();
  const kinds = [{ tuning: guitar }, { tuning: guitar }, { tuning: bass }, { tuning: bass5 }, { tuning: guitar, arrangement: "bonus_rhythm" }, { tuning: guitar }]
    .map((track) => defaultRsKind(track, used));
  assert.deepEqual(kinds, ["lead", "rhythm", "bass", "alt_bass", "bonus_rhythm", "alt_lead"],
    "each layer gets the next free type for its instrument; a chosen one is kept");
  assert.equal(defaultRsKind({ tuning: guitar, arrangement: "banjo" }, new Set()), "lead");
  assert.equal(defaultRsKind({ tuning: bass }, new Set(["bass", "alt_bass", "bonus_bass"])), "bass", "out of types: start over");

  // Every layer has an arrangement of its own. Lead first, then rhythm, then the list;
  // a bass neck takes the bass ones, in the same order.
  const kindsOf = (lanes) => { assignRsKinds(lanes, (lane) => lane.strings); return lanes.map((lane) => lane.rocksmithArrangement); };
  const g = (extra = {}) => ({ strings: guitar, ...extra }), b = (extra = {}) => ({ strings: bass, ...extra });
  assert.deepEqual(kindsOf([g(), g(), b(), g(), b()]), ["lead", "rhythm", "bass", "alt_lead", "alt_bass"]);
  assert.deepEqual(kindsOf([g(), g({ rocksmithArrangement: "lead" })]), ["rhythm", "lead"], "a chosen one is kept; the layer without one takes the next");
  assert.deepEqual(kindsOf([g({ rocksmithArrangement: "lead" }), g({ rocksmithArrangement: "lead" })]), ["lead", "rhythm"], "never the same twice: the first keeps it");
  assert.deepEqual(kindsOf([g({ rocksmithArrangement: "bass" }), b({ rocksmithArrangement: "lead" })]), ["lead", "bass"], "one the neck cannot play is replaced");
  assert.deepEqual(kindsOf([g({ rocksmithArrangement: "none" }), g({ tablatureEnabled: false }), g()]), ["none", "none", "lead"], "any number of layers may stay out");
  const seven = kindsOf(Array.from({ length: 7 }, () => g()));
  assert.deepEqual(seven, ["lead", "rhythm", "alt_lead", "alt_rhythm", "bonus_lead", "bonus_rhythm", "none"], "past the six guitar parts a layer is not exported");
  // The staves of one Guitar Pro track are one part.
  assert.deepEqual(kindsOf([g({ sourceTrackIndex: 0 }), g({ sourceTrackIndex: 0 }), g({ sourceTrackIndex: 1 })]), ["lead", "lead", "rhythm"]);
  const settled = [g(), b()];
  assert.equal(assignRsKinds(settled, (lane) => lane.strings), true);
  assert.equal(assignRsKinds(settled, (lane) => lane.strings), false, "nothing to do the second time");
  const out = g(); kindsOf([...Array.from({ length: 6 }, () => g()), out]);
  assert.equal(out.tablatureEnabled, false);
  assert.ok(rsKindFits("alt_bass", bass5) && !rsKindFits("bass", guitar) && !rsKindFits("lead", bass));
  assert.ok(isTablatureLane({}) && !isTablatureLane({ tablatureEnabled: false }) && !isTablatureLane({ rocksmithArrangement: "none" }));
  const off = { active: true, tablatureEnabled: false }, on = { active: true };
  assert.equal(selectedTablatureLane([{}, off]), null);
  assert.equal(selectedTablatureLane([{}, on]), on);
}
console.log("helpers: ok");
