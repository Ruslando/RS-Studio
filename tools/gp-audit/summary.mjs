// Every kind of difference an audit report (audit.mjs --json) found, across all its
// tracks, per mode: how many tracks and places.
//   node tools/gp-audit/summary.mjs report.json
import { readFileSync } from "node:fs";
const report = JSON.parse(readFileSync(process.argv[2]));
const kinds = new Map();
for (const [track, modes] of Object.entries(report)) for (const [mode, r] of Object.entries(modes)) {
  if (mode === "file") continue;
  const add = (what, n, where) => {
    const k = kinds.get(what) || kinds.set(what, {}).get(what);
    (k[mode] ||= { tracks: 0, n: 0, where: [] }).tracks++; k[mode].n += n; k[mode].where.push(`${track.split(" :: ")[1]}: ${where}`);
  };
  if (r.error) add("ERROR " + r.error.slice(0, 80), 1, "");
  for (const [what, where] of Object.entries(r.fields || {})) add(what, where.length, [...new Set(where)].slice(0, 4).join(", "));
  const midi = new Map();
  for (const e of r.midi || []) (midi.get(e.split(":")[0]) || midi.set(e.split(":")[0], []).get(e.split(":")[0])).push(e.split(": ")[1]);
  for (const [what, events] of midi) add("MIDI " + what, events.length, `${events.length}× e.g. ${events[0]}`);
}
const MODES = ["source", "rebuilt", "seen", "editor"];
console.log("kind".padEnd(40) + MODES.map((m) => m.padStart(9)).join(""));
for (const [what, k] of [...kinds].sort()) console.log(what.padEnd(40) + MODES.map((m) => (k[m] ? `${k[m].tracks}t` : "·").padStart(9)).join(""));
if (process.argv[3]) for (const [what, k] of kinds) if (what.startsWith(process.argv[3]))
  for (const m of MODES) if (k[m]) console.log(`\\n${what} [${m}]\\n  ` + k[m].where.slice(0, 6).join("\\n  "));
