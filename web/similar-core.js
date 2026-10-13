// Similar-passage scoring, free of the DOM so it can be tested under Node.
//
// The search slides the spectrogram patch under the selection along the song.
// Comparing raw brightness matched the loud/quiet layout of a passage, not its
// pitches: a break with the same rhythm outscored a note-for-note repeat. So the
// loudness is taken out first. Each time column is rescaled on its own, leaving
// only which pitch stands out at that instant, and columns where nothing stands
// out (silence, noise) count for less.
//
// Loudness cannot be ignored altogether, though: rescaling makes the faint residue
// of a near-silent stretch look like notes. So a candidate must also HAVE the
// sound: where the selection has energy, the candidate needs most of it too.

const SMOOTH = 5;       // columns of time smoothing (~0.1 s): a slightly early/late note still lines up
const STD_FLOOR = 8;    // energy units (0..255): keeps a flat, noisy column from being blown up to full scale
const PRESENCE_FULL = 0.8;  // share of the selection's energy a candidate needs for its full score

/**
 * Score every candidate start column against the patch at column c0.
 * @param {Float64Array} band  energy, H rows x iw columns, row-major
 * @param {number} iw          columns in the song
 * @param {number} H           rows in the pitch band
 * @param {number} c0          first column of the selection's patch
 * @param {number} pw          patch width in columns
 * @param {number} stride      test every `stride`-th start column
 * @returns {Float64Array}     score per start column in -1..1 (untested columns are -1)
 */
export function similarScores(band, iw, H, c0, pw, stride = 1) {
  // Smooth along time, then normalise each column: (value - column mean) / column spread.
  const norm = new Float64Array(H * iw), loud = new Float64Array(iw), level = new Float64Array(iw);
  const half = SMOOTH >> 1, col = new Float64Array(H);
  for (let c = 0; c < iw; c++) {
    let mean = 0, lo = Infinity, hi = -Infinity;
    for (let r = 0; r < H; r++) {
      let v = 0;
      for (let k = -half; k <= half; k++) { const cc = c + k; if (cc >= 0 && cc < iw) v += band[r * iw + cc]; }
      v /= SMOOTH; col[r] = v; mean += v;
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    mean /= H;
    let sq = 0;
    for (let r = 0; r < H; r++) sq += (col[r] - mean) * (col[r] - mean);
    const std = Math.sqrt(sq / H) + STD_FLOOR;
    for (let r = 0; r < H; r++) norm[r * iw + c] = (col[r] - mean) / std;
    loud[c] = hi - lo;   // how clearly anything stands out in this column
    level[c] = mean;     // how much sound there is at all
  }

  const lastCs = iw - pw, out = new Float64Array(Math.max(0, lastCs + 1)).fill(-1);
  const w = new Float64Array(pw);
  let ownLevel = 0;
  for (let k = 0; k < pw; k++) ownLevel += level[c0 + k];
  for (let cs = 0; cs <= lastCs; cs += stride) {
    // A column counts by how clearly a pitch stands out in BOTH passages.
    let wsum = 0;
    for (let k = 0; k < pw; k++) { w[k] = Math.sqrt(loud[c0 + k] * loud[cs + k]); wsum += w[k]; }
    if (wsum < 1e-9) continue;
    let mt = 0, mx = 0;
    for (let r = 0; r < H; r++) {
      const tb = r * iw + c0, xb = r * iw + cs;
      for (let k = 0; k < pw; k++) { mt += norm[tb + k] * w[k]; mx += norm[xb + k] * w[k]; }
    }
    mt /= wsum * H; mx /= wsum * H;
    let dot = 0, vt = 0, vx = 0;
    for (let r = 0; r < H; r++) {
      const tb = r * iw + c0, xb = r * iw + cs;
      for (let k = 0; k < pw; k++) {
        const a = norm[tb + k] - mt, b = norm[xb + k] - mx;
        dot += a * b * w[k]; vt += a * a * w[k]; vx += b * b * w[k];
      }
    }
    const den = Math.sqrt(vt * vx);
    // Presence: column by column, how much of the selection's energy is also here.
    let shared = 0;
    for (let k = 0; k < pw; k++) shared += Math.min(level[cs + k], level[c0 + k]);
    const presence = ownLevel > 1e-9 ? Math.min(1, shared / ownLevel / PRESENCE_FULL) : 0;
    out[cs] = den > 1e-9 ? (dot / den) * presence : 0;
  }
  return out;
}
