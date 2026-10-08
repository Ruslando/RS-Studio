// Pure chord-formula analysis. Kept DOM-free so musical policy is testable in
// Node. See docs/chord-engine.md before relaxing any recognition rule.

export const PC_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const pcName = (pc) => PC_NAMES[((pc % 12) + 12) % 12];

// A natural fifth may be absent only from formulas explicitly listing it as
// optional. Everything else in `intervals` is required evidence.
const CHORD_FORMULAS = [
  { suffix: "maj9", intervals: [0, 2, 4, 7, 11], optional: [7] },
  { suffix: "9", intervals: [0, 2, 4, 7, 10], optional: [7] },
  { suffix: "m9", intervals: [0, 2, 3, 7, 10], optional: [7] },
  { suffix: "6/9", intervals: [0, 2, 4, 7, 9], optional: [7] },
  { suffix: "7b9", intervals: [0, 1, 4, 7, 10], optional: [7] },
  { suffix: "7#9", intervals: [0, 3, 4, 7, 10], optional: [7] },
  { suffix: "maj7#11", intervals: [0, 4, 6, 7, 11], optional: [7] },
  { suffix: "m11", intervals: [0, 3, 5, 7, 10], optional: [7] },
  { suffix: "maj7", intervals: [0, 4, 7, 11], optional: [7] },
  { suffix: "7", intervals: [0, 4, 7, 10], optional: [7] },
  { suffix: "6", intervals: [0, 4, 7, 9], optional: [7] },
  { suffix: "mMaj7", intervals: [0, 3, 7, 11], optional: [7] },
  { suffix: "m7", intervals: [0, 3, 7, 10], optional: [7] },
  { suffix: "m6", intervals: [0, 3, 7, 9], optional: [7] },
  { suffix: "m7b5", intervals: [0, 3, 6, 10] },
  { suffix: "dim7", intervals: [0, 3, 6, 9] },
  { suffix: "7sus4", intervals: [0, 5, 7, 10], optional: [7] },
  { suffix: "add9", intervals: [0, 2, 4, 7], optional: [7] },
  { suffix: "madd9", intervals: [0, 2, 3, 7], optional: [7] },
  { suffix: "add11", intervals: [0, 4, 5, 7], optional: [7] },
  { suffix: "madd11", intervals: [0, 3, 5, 7], optional: [7] },
  { suffix: "7b5", intervals: [0, 4, 6, 10] },
  { suffix: "7#5", intervals: [0, 4, 8, 10] },
  { suffix: "", intervals: [0, 4, 7] },
  { suffix: "m", intervals: [0, 3, 7] },
  { suffix: "dim", intervals: [0, 3, 6] },
  { suffix: "aug", intervals: [0, 4, 8] },
  { suffix: "sus2", intervals: [0, 2, 7] },
  { suffix: "sus4", intervals: [0, 5, 7] },
  { suffix: "5", intervals: [0, 7] },
];

const norm = (p) => ((p % 12) + 12) % 12;

export function analyzeChord(pitches) {
  if (!pitches.length) return null;
  const bassPc = norm(Math.min(...pitches));
  const pcs = [...new Set(pitches.map(norm))].sort((a, b) => a - b);
  if (pcs.length === 1) return {
    root: pcs[0], suffix: "", pcs, fullPcs: pcs, missing: [], bassPc,
    symbol: pcName(pcs[0]), candidates: [],
  };
  const observed = new Set(pcs), matches = [];
  CHORD_FORMULAS.forEach((formula, formulaIndex) => {
    for (let root = 0; root < 12; root++) {
      const fullPcs = formula.intervals.map((iv) => (root + iv) % 12);
      const full = new Set(fullPcs);
      if (![...observed].every((pc) => full.has(pc))) continue;
      const missingIntervals = formula.intervals.filter((iv) => !observed.has((root + iv) % 12));
      const optional = new Set(formula.optional || []);
      if (missingIntervals.some((iv) => !optional.has(iv))) continue;
      // Omission inference needs three observed identity tones; this prevents a
      // C-B dyad from being inflated into Cmaj7(no5).
      if (missingIntervals.length && pcs.length < 3) continue;
      const missing = missingIntervals.map((iv) => ({ interval: iv, pc: (root + iv) % 12, label: iv === 7 ? "5" : String(iv) }));
      const omissionText = missing.length ? `(${missing.map((m) => `no${m.label}`).join(",")})` : "";
      const base = pcName(root) + formula.suffix + omissionText;
      const symbol = root === bassPc ? base : `${base}/${pcName(bassPc)}`;
      const score = missing.length * 1 + (root === bassPc ? 0 : 0.35) + formulaIndex * 1e-4;
      matches.push({ root, suffix: formula.suffix, pcs, fullPcs, missing, bassPc, symbol, score, formula });
    }
  });
  matches.sort((a, b) => a.score - b.score);
  if (!matches.length) return null;
  return { ...matches[0], candidates: matches };
}

export const detectChord = (pitches) => analyzeChord(pitches)?.symbol || "";

