// Two scores' first tracks, compared field by field: every primitive field alphaTab
// has on each master bar, beat and note (none listed by hand), what links notes
// (ties, slides, hammer-ons), curves, and alphaTab's own playback (MIDI) of both.
import { alphaTab } from "./harness.mjs";

// Ids name things inside one score (chordId names a chord by its id): compared by what they point at instead.
const SKIP = new Set(["id", "index", "chordId"]);
const num = (v) => typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v;
function fields(o) {
  const out = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (!SKIP.has(k) && (v == null || typeof v !== "object")) out[k] = num(v);
  }
  return out;
}
const points = (list) => list?.length ? JSON.stringify(list.map((p) => [num(p.offset), num(p.value)])) : null;

// { key: { field: value } } for everything in the score's track `ti`, first staff.
export function snapshot(score, ti = 0) {
  const out = {};
  for (const mb of score.masterBars) out[`bar ${mb.index + 1}`] = { ...fields(mb),
    tempo: JSON.stringify((mb.tempoAutomations || []).map((a) => [num(a.ratioPosition), num(a.value)])),
    section: mb.section ? `${mb.section.marker}|${mb.section.text}` : null,
    fermata: mb.fermata?.size ? JSON.stringify([...mb.fermata].map(([t, f]) => [t, f.type, f.length])) : null,
    directions: mb.directions?.size ? [...mb.directions].sort().join(",") : null };
  const track = score.tracks[ti], staff = track.staves[0];
  out.track = { ...fields(track), ...Object.fromEntries(Object.entries(fields(track.playbackInfo)).map(([k, v]) => ["playback." + k, v])) };
  out.staff = { ...fields(staff), tuning: staff.stringTuning.tunings.join(" ") };
  const noteKey = (n) => `note ${n.beat.voice.bar.index + 1} v${n.beat.voice.index} @${n.beat.absolutePlaybackStart}${n.beat.graceType ? "g" + n.beat.index : ""} s${n.string}`;
  for (const bar of staff.bars) {
    const where = `bar ${bar.index + 1}`;
    out[`staffbar ${bar.index + 1}`] = fields(bar);
    for (const voice of bar.voices) {
      if (voice.isEmpty) continue;
      for (const beat of voice.beats) {
        const key = `beat ${bar.index + 1} v${voice.index} @${beat.absolutePlaybackStart}${beat.graceType ? "g" + beat.index : ""}`;
        out[key] = { ...fields(beat), where, whammy: points(beat.whammyBarPoints),
          lyrics: beat.lyrics?.length ? beat.lyrics.join("|") : null, chord: beat.chord?.name ?? null,
          automations: beat.automations?.length ? JSON.stringify(beat.automations.map((a) => [a.type, num(a.value)])) : null,
          tremolo: beat.tremoloPicking ? JSON.stringify(fields(beat.tremoloPicking)) : null,
          fermata: beat.fermata ? `${beat.fermata.type}:${beat.fermata.length}` : null,
          notes: beat.notes.length };
        for (const note of beat.notes) out[noteKey(note)] = { ...fields(note), where, bend: points(note.bendPoints),
          tieTo: note.tieDestination ? noteKey(note.tieDestination) : null,
          slideTo: note.slideTarget ? noteKey(note.slideTarget) : null,
          hammerTo: note.hammerPullDestination ? noteKey(note.hammerPullDestination) : null };
      }
    }
  }
  return out;
}

// Every MIDI event alphaTab generates for the track, as comparable strings.
export function midi(score, ti = 0) {
  const events = [];
  const handler = {
    addTimeSignature() {}, addRest() {}, finishTrack() {}, addTickShift() {},
    addTempo: (tick, bpm) => events.push(`tempo ${tick} ${num(bpm)}`),
    addControlChange: (track, tick, channel, controller, value) => events.push(`cc ${tick} ${controller} ${value}`),
    addProgramChange: (track, tick, channel, program) => events.push(`program ${tick} ${program}`),
    addNote: (track, start, length, key, velocity) => events.push(`note ${start} ${length} ${key} ${velocity}`),
    addBend: (track, tick, channel, value) => events.push(`bend ${tick} ${value}`),
    addNoteBend: (track, tick, channel, key, value) => events.push(`notebend ${tick} ${key} ${value}`),
  };
  const solo = alphaTab.model.JsonConverter.jsonToScore(alphaTab.model.JsonConverter.scoreToJson(score), new alphaTab.Settings());
  solo.tracks = [solo.tracks[ti]]; solo.tracks[0].index = 0;
  new alphaTab.midi.MidiFileGenerator(solo, new alphaTab.Settings(), handler).generate();
  return events.sort();
}

// What differs: [{ what: "note.vibrato", where: "bar 12", key, a, b }].
export function diff(a, b) {
  const out = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const kind = key.split(" ")[0];
    if (!(key in b)) { out.push({ what: `${kind} missing`, where: a[key].where || key, key }); continue; }
    if (!(key in a)) { out.push({ what: `${kind} extra`, where: b[key].where || key, key }); continue; }
    for (const field of new Set([...Object.keys(a[key]), ...Object.keys(b[key])]))
      if (field !== "where" && a[key][field] !== b[key][field])
        out.push({ what: `${kind}.${field}`, where: a[key].where || key, key, a: a[key][field], b: b[key][field] });
  }
  return out;
}

// Loudness alone (a note's velocity, from dynamics the editor does not hold) is
// counted apart from what plays when and at what pitch.
export function midiDiff(a, b) {
  const unvoiced = (list) => list.map((e) => e.startsWith("note ") ? e.split(" ").slice(0, 4).join(" ") : e);
  const out = midiCount(unvoiced(a), unvoiced(b));
  const loud = midiCount(a, b).filter((e) => e.includes(" note: ")).length / 2;
  return loud > out.filter((e) => e.includes(" note: ")).length / 2 ? [...out, `velocity: ${loud} notes`] : out;
}

function midiCount(a, b) {
  const count = (list) => list.reduce((m, e) => m.set(e, (m.get(e) || 0) + 1), new Map());
  const ca = count(a), cb = count(b), out = [];
  for (const e of new Set([...ca.keys(), ...cb.keys()])) {
    const d = (ca.get(e) || 0) - (cb.get(e) || 0);
    if (d) out.push(`${d > 0 ? "missing" : "extra"} ${e.split(" ")[0]}: ${e}`);
  }
  return out;
}
