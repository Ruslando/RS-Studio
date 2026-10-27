// The similar-passage score must follow pitches, not loudness: a quieter repeat of
// the same notes has to outscore a passage with the same loud/quiet rhythm on
// different pitches. (The old raw-brightness score got this backwards.)
import assert from "node:assert/strict";
import { similarScores } from "../../web/similar-core.js";

const H = 9, iw = 700, pw = 60;
const band = new Float64Array(H * iw);
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (let i = 0; i < band.length; i++) band[i] = 40 + rnd() * 25;            // noise floor
// Three notes, 20 columns each, on the given rows; `gain` is how loud the passage is.
const riff = (c, rows, gain) => rows.forEach((r, n) => {
  for (let k = 2; k < 18; k++) band[r * iw + c + n * 20 + k] += 180 * gain;
});
riff(100, [2, 6, 3], 1);      // the selection
riff(300, [2, 6, 3], 0.4);    // the same notes, much quieter
riff(450, [5, 1, 7], 1);      // same rhythm and loudness, different notes
// A near-silent stretch carrying a faint trace of the same shape.
for (let r = 0; r < H; r++) for (let c = 510; c < 590; c++) band[r * iw + c] = 2 + rnd() * 2;
riff(520, [2, 6, 3], 0.03);

const s = similarScores(band, iw, H, 100, pw);
const best = (c) => Math.max(...[-2, -1, 0, 1, 2].map((d) => s[c + d]));
assert.ok(s[100] > 0.99, `the selection matches itself (${s[100]})`);
assert.ok(best(300) > 0.8, `a quieter repeat still scores high (${best(300)})`);
assert.ok(best(450) < 0.3, `same rhythm on other pitches scores low (${best(450)})`);
assert.ok(best(520) < 0.3, `near-silence does not match, whatever its shape (${best(520)})`);
assert.equal(similarScores(band, iw, H, 100, pw, 4)[101], -1, "stride skips columns");
// A wide band over a mix: the lows are always louder. That slope alone must not
// make unrelated spots match (it scored them ~85% before the row average came out).
{
  const H = 40, tilted = new Float64Array(H * iw);
  for (let r = 0; r < H; r++) for (let c = 0; c < iw; c++) tilted[r * iw + c] = 20 + (H - r) * 4 + rnd() * 25;
  const riff = (c, rows) => rows.forEach((r, n) => { for (let k = 2; k < 18; k++) tilted[r * iw + c + n * 20 + k] += 120; });
  riff(100, [12, 26, 15]); riff(300, [12, 26, 15]); riff(450, [25, 5, 33]);
  const t = similarScores(tilted, iw, H, 100, pw);
  const top = (c) => Math.max(...[-2, -1, 0, 1, 2].map((d) => t[c + d]));
  assert.ok(top(300) > 0.8, `a repeat under a tilt still scores high (${top(300)})`);
  assert.ok(top(450) < 0.3 && top(600) < 0.3, `the tilt alone does not match (${top(450)}, ${top(600)})`);
}
console.log("similar-core: ok");
