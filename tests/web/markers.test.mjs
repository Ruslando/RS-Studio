// Run: node tests/web/markers.test.mjs
// Section, phrase and tone markers: what is kept on load, and where sections land on export.
import assert from "node:assert/strict";
import { SECTION_GROUPS, SECTION_HELP, assignSectionsToBars, beatStartsFromScoreBars, normalizeCrowdEvents, normalizePhraseBoundaries, normalizeSectionMarkers, phraseName, sectionMarkersForExport, sectionMarkersFromScoreBars, sectionTypeLabel, validSectionType, withEndSection } from "../../web/section-marker-core.js";
import { normalizeToneMarkers, startTone, withStartTone, tonePresetMissing, tonePresetLabel } from "../../web/tone-marker-core.js";

import { SOUND_BASES } from "../../web/sound-presets-core.js";

// ---- section types --------------------------------------------------------
assert.equal(validSectionType("Verse 2"), "verse", "a numbered name is still its type");
assert.equal(validSectionType("pre-chorus"), validSectionType("PreChorus"));
assert.equal(validSectionType("zzz"), "riff");
assert.equal(validSectionType("zzz", "intro"), "intro");
assert.equal(sectionTypeLabel("chorus"), "Chorus");
assert.equal(validSectionType('End'), 'end');
assert.ok(SECTION_GROUPS.find(([name]) => name === 'Special')[1].some(([type]) => type === 'end'));
assert.ok(SECTION_HELP.end);
{
  const sections = withEndSection([{ t: 0, text: 'Intro', sectionType: 'intro' }], 18.237, 20);
  const end = sections.find(marker => marker.sectionType === 'end');
  assert.equal(end.t, 18.237, 'detected End retains its exact time');
  assert.equal(withEndSection(sections, 19, 20).find(marker => marker.sectionType === 'end').t, 18.237,
    'an existing End is preserved on reload');
  assert.equal(normalizeSectionMarkers([...sections, { t: 19, text: 'End', sectionType: 'end' }]).filter(marker => marker.sectionType === 'end').length, 1);
  assert.equal(sectionMarkersForExport(sections).at(-1).sectionType, 'end', 'End round-trips as a section type');
}

// ---- sections on load -----------------------------------------------------
{
  const got = normalizeSectionMarkers([
    { t: 30, text: "Chorus" }, { seconds: 5, name: " Verse 1 " }, { t: "x", text: "bad time" },
    { t: 8, text: "  " }, { t: -3, text: "My part", sectionType: "solo" }, { t: 99, text: "Outro" },
  ], 60);
  assert.deepEqual(got.map((m) => [m.t, m.text, m.sectionType, m.custom]), [
    [0, "My part", "solo", true], [5, "Verse 1", "verse", true], [30, "Chorus", "chorus", false], [60, "Outro", "outro", false],
  ], "sorted, clamped into the song, nameless and timeless ones dropped");
  assert.equal(new Set(got.map((m) => m.id)).size, 4);
  assert.deepEqual(normalizeSectionMarkers(null), []);
  assert.deepEqual(sectionMarkersForExport([{ t: 1, text: "Intro", id: "x" }]), [{ t: 1, text: "Intro", marker: "", sectionType: "intro" }]);
}

// ---- sections onto bars ---------------------------------------------------
{
  const bars = [0, 2, 4, 6].map((seconds) => ({ seconds, durationSeconds: 2, section: { text: "old" } }));
  const names = (list) => list.map((bar) => bar.section?.text || null);
  const { bars: placed, warnings } = assignSectionsToBars(bars, [{ t: 0.2, text: "Intro" }, { t: 4.9, text: "Verse" }]);
  assert.deepEqual(names(placed), ["Intro", null, "Verse", null], "each lands on the nearest bar; what was embedded is cleared");
  assert.deepEqual(warnings, []);
  assert.equal(bars[0].section.text, "old", "the source bars are not touched");

  // Two in one bar: the second moves on and says so; with no bar left it is reported, not dropped silently.
  const crowded = assignSectionsToBars(bars, [{ t: 4.1, text: "A" }, { t: 4.2, text: "B" }, { t: 6, text: "C" }, { t: 6.1, text: "D" }]);
  assert.deepEqual(names(crowded.bars), [null, null, "A", "B"]);
  assert.equal(crowded.warnings.length, 3);
  assert.match(crowded.warnings[0], /B.* moved to bar 4/);
  assert.match(crowded.warnings[2], /D.* could not be placed/);
  assert.deepEqual(assignSectionsToBars([], [{ t: 0, text: "A" }]), { bars: [], warnings: [] });

  // And back: sections embedded in a score's bars become markers at the bar starts.
  const back = sectionMarkersFromScoreBars([{ seconds: 0, section: { text: "Intro" } }, { seconds: 2 }, { seconds: 4, section: { marker: "Bridge-ish" } }]);
  assert.deepEqual(back.map((m) => [m.t, m.text, m.sectionType, m.custom]), [[0, "Intro", "intro", false], [4, "Bridge-ish", "riff", true]]);
  assert.deepEqual(beatStartsFromScoreBars([{ seconds: 0, durationSeconds: 2 }, { seconds: 2, durationSeconds: 3, timeSignatureNumerator: 3 }]),
    [0, 0.5, 1, 1.5, 2, 3, 4]);
}

// ---- phrase boundaries ----------------------------------------------------
assert.deepEqual(normalizePhraseBoundaries([{ t: 5 }, 2, { seconds: 2 }, { t: "x" }, { t: 80 }], 60).map((b) => b.t), [2, 5, 60],
  "sorted, clamped, two at the same time are one");
assert.equal(phraseName("Riff A-1"), "RiffA1", "letters and digits only");
for (const reserved of ["COUNT", "end", "mover2"]) assert.equal(phraseName(reserved), "", `${reserved} is the export's`);
assert.equal(phraseName("movers"), "movers");
assert.deepEqual(normalizePhraseBoundaries([{ id: "a", t: 1, name: "riff 1", solo: 1 }, { id: "b", t: 2, name: "END" }]),
  [{ id: "a", t: 1, name: "riff1", solo: true }, { id: "b", t: 2 }], "name and solo kept, cleaned");
assert.deepEqual(normalizeCrowdEvents([{ id: "b", t: 9, code: "E13" }, { id: "a", t: 2, code: "E3" },
  { t: 3, code: "B0" }, { t: "x", code: "e1" }, { id: "c", t: 99, code: "e2" }], 60),
  [{ id: "a", t: 2, code: "E3" }, { id: "b", t: 9, code: "E13" }, { id: "c", t: 60, code: "e2" }],
  "crowd codes only, sorted, clamped");

// ---- tone markers ---------------------------------------------------------
{
  const presets = [
    {id:'sound_guitar', fileId:'file:guitar-crunch.json', tone:SOUND_BASES.crunch},
    {id:'sound_bass', fileId:'file:bass-clean.json', tone:SOUND_BASES.bass},
  ];
  const got = normalizeToneMarkers([{ t: 4, tone: "Lead" }, { t: 0, preset: "clean" }, { t: 2, tone: "fuzz" }, { t: 4, tone: "crunch", id: "a" }, { t: 90, tone: "bass" }], 60);
  assert.deepEqual(got.map(m => [m.t, m.tone]), [[0,'clean'],[2,'fuzz'],[4,'crunch'],[60,'bass']],
    'unresolved references are retained; only duplicate times are collapsed');
  assert.equal(startTone({instrument:'bass'}, presets), 'sound_bass');
  assert.equal(startTone({instrument:'electric'}, presets), 'sound_guitar');
  assert.equal(startTone({instrument:'bass', rocksmithArrangement:'lead'}, presets), 'sound_guitar');
  assert.equal(startTone({instrument:'electric', rocksmithArrangement:'alt_bass'}, presets), 'sound_bass');
  const added = withStartTone([{t:3,tone:'lead'}], {instrument:'bass'}, presets);
  assert.deepEqual(added.map(m => [m.t,m.tone]), [[0,'sound_bass'],[3,'lead']]);
  assert.equal(added[0].toneData, undefined, 'available presets are references');
  const own = [{t:0,tone:'lead'}];
  assert.equal(withStartTone(own, {}, presets), own, 'removed presets are never replaced');
  assert.equal(tonePresetMissing('lead', presets), true);
  assert.equal(tonePresetMissing('sound_guitar', presets), false);
  assert.equal(tonePresetLabel('unknown'), 'unknown', 'unknown keys never become Lead');
  assert.deepEqual(withStartTone([], {}, []), [], 'no legacy default when the library is empty');

}
console.log("markers: ok");
