// Audit real Guitar Pro files: every guitar and bass track is imported and exported
// the four ways harness.mjs knows, and each result is compared with the file.
//   node tools/gp-audit/audit.mjs song.gp [more.gp …] [--json report.json]
import { asFile, importableTracks, loadFile, roundTrip } from "./harness.mjs";
import { diff, midi, midiDiff, snapshot } from "./compare.mjs";
import { writeFileSync } from "node:fs";

export const MODES = ["source", "rebuilt", "seen", "editor"];

// Bars whose notes run past the bar's end: a faulty file. The overflow lands on the
// next bar's first notes, so what differs there is the file's doing, filed apart.
export function overfullBars(score, ti) {
  const out = [];
  for (const bar of score.tracks[ti].staves[0].bars) {
    const length = bar.masterBar.calculateDuration();
    if (bar.voices.some((v) => !v.isEmpty && v.beats.filter((b) => !b.graceType).reduce((sum, b) => sum + b.playbackDuration, 0) > length))
      out.push(bar.index + 1);
  }
  return out;
}

// The file's track `ti` against each mode's export: { mode: { what: [where…] }, midi }.
export async function auditTrack(score, ti) {
  const file = asFile(score);
  const want = snapshot(file, ti), sound = midi(file, ti), result = {};
  const overfull = overfullBars(file, ti), faulty = new Set(overfull.flatMap((n) => [`bar ${n}`, `bar ${n + 1}`, `staffbar ${n}`, `staffbar ${n + 1}`]));
  if (overfull.length) result.file = { overfull };
  for (const mode of MODES) {
    try {
      const { score: out, warnings } = await roundTrip(file, ti, mode);
      const found = {};
      for (const d of diff(want, snapshot(out))) (found[(faulty.has(d.where) ? "[overfull bar] " : "") + d.what] ||= []).push(d.where);
      result[mode] = { fields: found, midi: midiDiff(sound, midi(out)), warnings };
    } catch (error) { result[mode] = { error: String(error?.stack || error).split("\n").slice(0, 3).join(" | ") }; }
  }
  return result;
}

export function summarize(result) {
  const lines = [];
  for (const [mode, r] of Object.entries(result)) {
    if (mode === "file") { lines.push(`  file: overfull bars ${r.overfull.join(", ")} (notes past the bar's end)`); continue; }
    if (r.error) { lines.push(`  ${mode}: ERROR ${r.error}`); continue; }
    const fields = Object.entries(r.fields).sort((x, y) => y[1].length - x[1].length);
    lines.push(`  ${mode}: ${fields.length ? fields.length + " kinds of difference" : "identical"}; sound: ${r.midi.length ? r.midi.length + " MIDI events differ" : "identical"}${r.warnings.length ? "; warnings: " + r.warnings.join(" / ") : ""}`);
    for (const [what, where] of fields) lines.push(`    ${what.padEnd(34)} ${String(where.length).padStart(5)}  ${[...new Set(where)].slice(0, 8).join(", ")}${new Set(where).size > 8 ? ", …" : ""}`);
    const kinds = r.midi.reduce((m, e) => m.set(e.split(":")[0], (m.get(e.split(":")[0]) || 0) + 1), new Map());
    for (const [k, n] of kinds) lines.push(`    MIDI ${k.padEnd(29)} ${String(n).padStart(5)}  e.g. ${r.midi.find((e) => e.startsWith(k)).split(": ")[1]}`);
  }
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), json = args.indexOf("--json");
  const out = json >= 0 ? args.splice(json, 2)[1] : null, report = {};
  for (const path of args) {
    const score = loadFile(path);
    for (const [ti, name] of importableTracks(score)) {
      const result = await auditTrack(score, ti);
      report[`${path} :: ${name}`] = result;
      console.log(`\n## ${path.split("/").pop()} :: track ${ti} ${name}\n${summarize(result)}`);
    }
  }
  if (out) writeFileSync(out, JSON.stringify(report, null, 1));
}
