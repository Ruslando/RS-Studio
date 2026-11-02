// The feature matrix: everything a Guitar Pro file can say about a note, a beat, a bar
// or a track, each tried on its own, and what of it the app keeps.
//
// Nothing here is a list of Guitar Pro features. They come from data:
//   - the fields: every field alphaTab's own JSON form of a score has (JsonConverter),
//   - the values: each field's alphaTab enum (matched by name), every value real files
//     use (the corpus given on the command line), and a few probes for numbers,
//   - what a file can hold: a value counts only if it survives alphaTab writing a .gp
//     file and reading it back.
// Each surviving value goes on a note in a small base score in several places (alone,
// in a chord, on a tied part…) and through the app (audit.mjs MODES); what differs from
// the base score's own result is what the app loses of it.
//
//   node tools/gp-audit/matrix.mjs [corpus.gp …] [--json out.json] [--only note.vibrato]
import { readFileSync, writeFileSync } from "node:fs";
import { alphaTab, asFile, loadFile, roundTrip } from "./harness.mjs";
import { diff, midi, midiDiff, snapshot } from "./compare.mjs";

const J = alphaTab.model.JsonConverter;
const settings = () => new alphaTab.Settings();
const toJson = (score) => JSON.parse(J.scoreToJson(score));
const fromJson = (json) => J.jsonToScore(JSON.stringify(json), settings());

// A plain base: single notes with neighbours, a chord, a tied note, rests, four bars.
const BASE_TEX = `\\tempo 120 . \\track "Base" \\instrument 27
  :4 5.3 7.3 (5.3 7.2 5.1) r |
  :4 5.3 7.3 (5.3 7.2 5.1) 9.3 |
  :2 5.3 5.3{t} |
  :4 7.3 r 5.2 r`;
export function baseScore() {
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(BASE_TEX, settings());
  return asFile(importer.readScore());
}

// Where a value goes: a path into the score JSON to one object of each kind.
const beats = (bar, voice = 0) => ["tracks", 0, "staves", 0, "bars", bar, "voices", voice, "beats"];
export const PLACES = {
  note: { "single note": [...beats(1), 1, "notes", 0], "chord note": [...beats(1), 2, "notes", 1],
    "tie origin": [...beats(2), 0, "notes", 0], "tied part": [...beats(2), 1, "notes", 0] },
  beat: { "note beat": [...beats(1), 1], "chord beat": [...beats(1), 2], "rest": [...beats(3), 1], "tied beat": [...beats(2), 1] },
  bar: { "bar": ["masterbars", 1] },
  staffbar: { "staff bar": ["tracks", 0, "staves", 0, "bars", 1] },
  voice: { "voice": ["tracks", 0, "staves", 0, "bars", 1, "voices", 0] },
  staff: { "staff": ["tracks", 0, "staves", 0] },
  track: { "track": ["tracks", 0] },
  playback: { "track playback": ["tracks", 0, "playbackinfo"] },
};
// Containers and what alphaTab derives, not values to try.
const STRUCTURE = new Set(["notes", "beats", "voices", "bars", "staves", "tracks", "masterbars", "id", "playbackinfo",
  "start", "displaystart", "playbackstart", "displayduration", "playbackduration", "stringtuning"]);

// Links between notes by id: what they mean is tried through the flags that make them.
const isStructure = (field) => STRUCTURE.has(field) || /noteid$/.test(field);
const at = (json, path) => path.reduce((o, k) => o?.[k], json);
function* objects(json, kind) {   // every object of a kind in a score JSON
  const tracks = json.tracks || [];
  if (kind === "bar") yield* json.masterbars || [];
  for (const t of tracks) {
    if (kind === "track") yield t;
    if (kind === "playback") yield t.playbackinfo;
    for (const st of t.staves || []) {
      if (kind === "staff") yield st;
      for (const b of st.bars || []) {
        if (kind === "staffbar") yield b;
        for (const v of b.voices || []) {
          if (kind === "voice") yield v;
          for (const bt of v.beats || []) { if (kind === "beat") yield bt; for (const n of bt.notes || []) if (kind === "note") yield n; }
        }
      }
    }
  }
}

// alphaTab's enums by lower-case name: an object of numbers with a reverse mapping.
const ENUMS = Object.fromEntries(Object.entries(alphaTab.model).filter(([, v]) => v && typeof v === "object"
  && Object.values(v).some((x) => typeof x === "number") && Object.keys(v).some((k) => /^\d+$/.test(k)))
  .map(([name, v]) => [name.toLowerCase(), Object.keys(v).filter((k) => /^\d+$/.test(k)).map(Number)]));
const enumFor = (field) => ENUMS[field] || ENUMS[field + "type"] || ENUMS[field.replace(/type$/, "")]
  || Object.entries(ENUMS).find(([name]) => name.startsWith(field) && field.length > 4)?.[1];

export function candidates(base, corpus) {
  const out = [];
  for (const [kind, places] of Object.entries(PLACES)) {
    const sample = at(base, Object.values(places)[0]);
    const seen = new Map();
    for (const json of corpus) for (const o of objects(json, kind)) for (const [k, v] of Object.entries(o || {})) {
      if (isStructure(k)) continue;
      const key = JSON.stringify(v), m = seen.get(k) || seen.set(k, new Map()).get(k);
      m.set(key, (m.get(key) || 0) + 1);
    }
    // Fields the base has, and those only real files set (alphaTab leaves defaults out of its JSON).
    for (const field of new Set([...Object.keys(sample), ...seen.keys()])) {
      const def = sample[field];
      if (isStructure(field)) continue;
      const values = new Map();
      const add = (v, from) => { const key = JSON.stringify(v); if (key !== JSON.stringify(def) && !values.has(key)) values.set(key, { value: v, from }); };
      if (typeof def === "boolean") add(!def, "boolean");
      if (typeof def === "number") {
        for (const v of enumFor(field) || []) add(v, "alphaTab enum");
      }
      // What real files use, most common first.
      for (const [key] of [...(seen.get(field) || new Map())].sort((a, b) => b[1] - a[1]).slice(0, 6)) add(JSON.parse(key), "corpus");
      if (typeof def === "number" && !enumFor(field)) for (const v of [def + 1, def + 2, 1, 3]) add(v, "probe");
      for (const { value, from } of values.values()) out.push({ kind, field, value, from });
    }
  }
  return out;
}

// The base with one value set at one place; null when a .gp file cannot hold it.
export function withValue(base, path, field, value) {
  const json = structuredClone(base);
  const target = at(json, path);
  if (!target) return null;
  target[field] = value;
  let file;
  try { file = asFile(fromJson(json)); } catch { return null; }
  const back = at(toJson(file), path);
  return back && JSON.stringify(back[field]) === JSON.stringify(value) ? file : null;
}

// A value that breaks the base score (a bar no longer adds up, two notes on one string at
// once) tests the score, not the app.
export function broken(score) {
  for (const bar of score.tracks[0].staves[0].bars) {
    const length = bar.masterBar.calculateDuration();
    for (const voice of bar.voices) {
      if (voice.isEmpty) continue;
      const sum = voice.beats.filter((b) => !b.graceType).reduce((n, b) => n + b.playbackDuration, 0);
      if (Math.abs(sum - length) > 1) return `bar ${bar.index + 1} lasts ${sum} of ${length} ticks`;
      for (const beat of voice.beats) {
        if (new Set(beat.notes.map((n) => n.string)).size < beat.notes.length) return `two notes on one string in bar ${bar.index + 1}`;
        for (const n of beat.notes) {
          const strings = score.tracks[0].staves[0].stringTuning.tunings.length;
          if (n.fret < 0 || n.string < 1 || n.string > strings) return `a note off the neck in bar ${bar.index + 1}`;
          const o = n.tieOrigin;
          if (n.isTieDestination && (!o || o.string !== n.string || o.fret !== n.fret
            || o.beat.absolutePlaybackStart + o.beat.playbackDuration !== n.beat.absolutePlaybackStart))
            return `a tie between different notes in bar ${bar.index + 1}`;
        }
      }
    }
  }
  return null;
}

const MODES = ["rebuilt", "seen", "editor"];
async function results(score) {
  const want = snapshot(score), sound = midi(score), out = {};
  for (const mode of MODES) {
    try {
      const { score: got } = await roundTrip(score, 0, mode);
      out[mode] = [...diff(want, snapshot(got)).map((d) => `${d.what} @${d.key}`), ...midiDiff(sound, midi(got)).map((e) => "MIDI " + e)];
    } catch (error) { out[mode] = [`ERROR ${String(error?.message || error).slice(0, 120)}`]; }
  }
  return out;
}

// Text from real files (names, lyrics) is not kept in the repo: the same kind of value
// with placeholder letters tests the same thing.
const anonymous = (v) => typeof v === "string" ? (v ? "x".repeat(Math.min(v.length, 8)) : v)
  : Array.isArray(v) ? v.map(anonymous) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, anonymous(x)])) : v;

export function casesOf(corpusPaths) {
  const seen = new Set();
  return candidates(toJson(baseScore()), corpusPaths.map((p) => toJson(loadFile(p))))
    .flatMap((c) => Object.keys(PLACES[c.kind]).map((place) => ({ ...c, value: anonymous(c.value), place })))
    .filter((c) => { const key = JSON.stringify([c.kind, c.field, c.value, c.place]); return !seen.has(key) && seen.add(key); });
}

export async function runCases(cases) {
  const base = baseScore(), baseJson = toJson(base);
  const baseline = await results(base);
  const rows = [];
  for (const c of cases) {
    const row = { kind: c.kind, field: c.field, value: c.value, from: c.from, place: c.place };
    rows.push(row);
    const file = withValue(baseJson, PLACES[c.kind][c.place], c.field, c.value);
    if (!file) { row.status = "not in .gp"; continue; }
    const why = broken(file);
    if (why) { row.status = "breaks the score"; row.why = why; continue; }
    const got = await results(file);
    for (const mode of MODES) row[mode] = got[mode].filter((d) => !baseline[mode].includes(d));
    row.status = row.rebuilt.length ? "lost after edits" : row.seen.length ? "only in the stored original"
      : row.editor.length ? "hidden data only" : "kept";
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const out = opt("--json"), only = opt("--only"), save = opt("--save");
  const rows = await runCases(casesOf(args).filter((c) => !only || `${c.kind}.${c.field}` === only));
  if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
  // The cases with what the app does with each: the regression test's expectation
  // (tests/web/gp-matrix.test.mjs).
  if (save) writeFileSync(save, JSON.stringify(rows.map(({ kind, field, value, from, place, status }) =>
    ({ kind, field, value, from, place, status })), null, 0).replace(/\},\{/g, "},\n{") + "\n");
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log(JSON.stringify(counts));
  for (const r of rows.filter((r) => !["kept", "not in .gp", "breaks the score"].includes(r.status)))
    console.log(`${r.status.padEnd(22)} ${r.kind}.${r.field} = ${JSON.stringify(r.value).slice(0, 40)} (${r.from}) @ ${r.place}\n    ${(r.rebuilt.length ? r.rebuilt : r.seen.length ? r.seen : r.editor).slice(0, 3).join("\n    ")}`);
}
