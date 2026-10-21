// Chord names from pitches. DOM-free, so the musical policy is testable in Node.
// See docs/chord-engine.md for the rules and the reasons behind each one.
//
// A name is built from parts, not looked up: for each sounding pitch class taken
// as the root, the other tones are read as a third, a fifth, a seventh and
// tensions, and the parts are written the usual way. Every reading that holds
// together is a candidate; the simplest one is the name, the rest are offered.

// Roots and basses as guitar charts spell them: flats where flats are usual.
export const PC_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
export const pcName = (pc) => PC_NAMES[((pc % 12) + 12) % 12];
const norm = (p) => ((p % 12) + 12) % 12;

// How much more contrived than the name an alternative may be and still be offered.
const ALTERNATIVE_RANGE = 2.5;

// Costs that rank readings of the same tones. Lower is simpler.
const COST = {
  // The root is not the lowest note. What is there instead decides how usual the
  // inversion is: the third or fifth (C/E, C/G), the seventh (C7/Bb), a sixth or
  // major seventh (Cmaj7/B), a sus tone (Gsus4/C), or a tension, which is rarely
  // what anyone means.
  bass: { 3: 1, 4: 1, 6: 1, 7: 1, 8: 1, 10: 1.5, 9: 2.5, 11: 2.5, 2: 2.5, 5: 2.5 },
  tensionBass: 3,
  alteration: 1.5,    // each b5 #5 b9 #9 #11 b13 on a chord with a seventh or sixth (C7#9)
  bareAlteration: 2.5, // ...and on one without: rarer, so Ab(b13)add9/C loses to C7#5#9
  add: 1,             // each tension without the seventh it implies
  sus: 0.5,
  noThird: 1.5,       // a seventh chord without its third: C7(no3)
  noFifthTriad: 1,    // no fifth and no seventh: little left that says "chord"
  noFifth: 0.25,      // no fifth in a seventh chord: the usual guitar voicing
  unusual: 1,         // dim(maj7)
  foreignBass: 2,     // a chord over a bass note that is not part of it (F/G, Am/G)
  bassClash: 1.5,     // ...a semitone under one of its tones: C#m6/C is C7#5b9
  avoid11: 1,         // a natural 11 over a major third clashes with it: C6/9#11 beats D11/C
};

// One reading of interval set `iv` (semitones above the root, 0 excluded).
// Returns { suffix, cost, chordTones } or null when the tones do not form a chord
// on this root.
function reading(iv) {
  const has = (n) => iv.has(n);
  const used = new Set();
  const take = (n) => { used.add(n); return true; };
  let cost = 0, chordTones = new Set([0]);
  const tone = (n) => { take(n); chordTones.add(n); };

  // Third, or what stands in for it.
  let third = null;                  // "M" | "m" | "sus4" | "sus2" | null
  if (has(4)) { third = "M"; tone(4); }
  else if (has(3)) { third = "m"; tone(3); }
  else if (has(5)) { third = "sus4"; tone(5); }
  else if (has(2)) { third = "sus2"; tone(2); }

  // Fifth. A b5 or #5 is the fifth only when the perfect one is absent.
  let fifth = null;                  // "P" | "b" | "#" | null
  if (has(7)) { fifth = "P"; tone(7); }
  else if (has(6) && third !== "sus2") { fifth = "b"; tone(6); }
  else if (has(8) && third === "M") { fifth = "#"; tone(8); }

  // Seventh (or the sixth of a chord without one).
  let seventh = null;                // "7" | "maj7" | "dim7" | null
  if (has(10)) { seventh = "7"; tone(10); }
  else if (has(11)) { seventh = "maj7"; tone(11); }
  else if (has(9) && third === "m" && fifth === "b") { seventh = "dim7"; tone(9); }
  let sixth = false;
  if (!seventh && has(9)) { sixth = true; tone(9); }

  // Power chord: the root and its fifth, nothing else. Any other two tones are an
  // interval, not a chord, and get no name.
  if (!third && fifth === "P" && iv.size === 1) return { suffix: "5", cost: 0, chordTones };
  if (iv.size < 2) return null;

  // Tensions: what is left. A major third makes 3 a #9; a perfect fifth makes 6 a #11 and 8 a b13.
  const nat = [], alt = [];
  if (has(2) && !used.has(2)) { nat.push(9); take(2); }
  if (has(1)) { alt.push("b9"); take(1); }
  if (has(3) && !used.has(3) && third === "M") { alt.push("#9"); take(3); }
  if (has(5) && !used.has(5)) { nat.push(11); take(5); }
  if (has(6) && !used.has(6)) { alt.push(fifth === "P" ? "#11" : "b5"); take(6); }
  if (has(8) && !used.has(8)) { alt.push(fifth === "P" || fifth === "b" ? "b13" : "#5"); take(8); }
  if (has(9) && !used.has(9)) { nat.push(13); take(9); }
  if ([...iv].some((n) => !used.has(n))) return null;   // a tone nothing above can name

  // Without a third there must be something else that makes it a chord.
  if (!third) {
    if (fifth !== "P" || !seventh) return null;
    cost += COST.noThird;
  }
  if (third?.startsWith("sus")) {
    // A sus chord is root, 2 or 4, and fifth. Without the fifth, C D E would read
    // as D7sus2/C rather than Cadd9.
    if (fifth !== "P") return null;
    cost += COST.sus;
    if (sixth) cost += COST.unusual;   // C6sus4/G is F/G as anyone writes it
  }
  if (!fifth) cost += seventh || sixth ? COST.noFifth : COST.noFifthTriad;
  if (third === "M" && nat.includes(11)) cost += COST.avoid11;

  // Write it: [quality][seventh or extension][sus][alterations][adds][(no3)].
  const dimTriad = third === "m" && fifth === "b";
  const augTriad = third === "M" && fifth === "#";
  let core;
  const top = Math.max(0, ...nat);
  // A natural extension names the chord (C9, C13) when a seventh is there and a
  // ninth is too; the ninth may be altered (C13#9, C13b9), and a 13 may leave out
  // the 11. A b9 or #9 alone stays an alteration of the seventh (C7b9).
  let ext = null;
  if (seventh === "7" || seventh === "maj7") {
    const ninth = nat.includes(9) || alt.includes("b9") || alt.includes("#9");
    if (top === 13 && ninth) ext = 13;
    else if (top >= 11 && ninth && nat.includes(11)) ext = 11;
    else if (nat.includes(9)) ext = 9;
  }
  const absorbed = new Set(ext ? nat.filter((n) => n <= ext) : []);
  const adds = nat.filter((n) => !absorbed.has(n));
  const num = ext ? String(ext) : "7";
  if (dimTriad) {
    if (seventh === "dim7") core = "dim7";
    else if (seventh === "7") core = `m${num}b5`;
    else if (seventh === "maj7") { core = "dim(maj7)"; cost += COST.unusual; }
    else core = "dim";
  } else if (augTriad && !seventh) {
    core = "aug";
  } else {
    const q = third === "m" ? "m" : "";
    if (seventh === "7") core = q + num;
    else if (seventh === "maj7") core = (q ? "mMaj" : "maj") + num;
    else if (sixth) {
      // 6/9 is one name; a 9 beside a 6 is not an add.
      const nine = adds.indexOf(9);
      if (nine >= 0) { adds.splice(nine, 1); core = q + "6/9"; cost += COST.add / 2; }
      else core = q + "6";
    } else core = q;
    if (augTriad) alt.unshift("#5");
    if (fifth === "b" && third === "M") alt.unshift("b5");
  }
  const sus = third?.startsWith("sus") ? third : "";
  cost += alt.length * (seventh || sixth ? COST.alteration : COST.bareAlteration) + adds.length * COST.add;
  // Alterations follow a number directly (C7b9). With no number before them they
  // are bracketed, so "Cb5" cannot be read as a root of C flat.
  const altText = alt.length ? (/\d$/.test(core + sus) ? alt.join("") : `(${alt.join(",")})`) : "";
  const addText = adds.map((n) => `add${n}`).join("");
  const suffix = core + sus + altText + addText + (third ? "" : "(no3)");
  return { suffix, cost, chordTones };
}

// Every reading of `pitches` (MIDI numbers), simplest first. Empty for one pitch
// class, for two that are not a fifth apart, and for tones no reading explains.
function readings(pitches) {
  if (!pitches.length) return [];
  const low = Math.min(...pitches), bassPc = norm(low);
  const pcs = [...new Set(pitches.map(norm))];
  const out = [];
  for (const root of pcs) {
    const iv = new Set(pcs.filter((pc) => pc !== root).map((pc) => norm(pc - root)));
    const r = reading(iv);
    if (!r) continue;
    let cost = r.cost;
    let symbol = pcName(root) + r.suffix;
    if (root !== bassPc) {
      const degree = norm(bassPc - root);
      cost += r.chordTones.has(degree) ? COST.bass[degree] : COST.tensionBass;
      symbol += `/${pcName(bassPc)}`;
    }
    out.push({ symbol, root, bassPc, cost });
  }
  // The chord above the bass, with the bass as a note of its own: F A C over G is
  // F/G as charts write it, not Fadd9/G. Only when the bass's note is not also in
  // the chord, and the chord above has at least three tones.
  const upper = pitches.filter((p) => norm(p) !== bassPc);
  if (upper.length === pitches.length - 1 && new Set(upper.map(norm)).size >= 3) {
    const clash = upper.some((p) => norm(p - bassPc) === 1) ? COST.bassClash : 0;
    for (const r of readings(upper)) {
      if (r.foreign) continue;   // one foreign bass at a time
      const name = r.symbol.split("/")[0];
      out.push({ symbol: `${name}/${pcName(bassPc)}`, root: r.root, bassPc, foreign: true,
        cost: chordCost(upper, r) + COST.foreignBass + clash });
    }
  }
  out.sort((a, b) => a.cost - b.cost || a.symbol.length - b.symbol.length);
  return out.filter((r, i) => out.findIndex((o) => o.symbol === r.symbol) === i);
}

// A reading's cost without what its own inversion added: over a foreign bass the
// chord above is named in root position.
function chordCost(pitches, r) {
  const pcs = [...new Set(pitches.map(norm))];
  return reading(new Set(pcs.filter((pc) => pc !== r.root).map((pc) => norm(pc - r.root)))).cost;
}

// { symbol, root, bassPc, alternatives: [symbol…] } or null. One pitch class
// (a note and its octaves) is named by that note.
export function analyzeChord(pitches) {
  if (!pitches.length) return null;
  const pcs = new Set(pitches.map(norm));
  if (pcs.size === 1) {
    const pc = norm(pitches[0]);
    return { symbol: pcName(pc), root: pc, bassPc: pc, alternatives: [] };
  }
  const all = readings(pitches);
  if (!all.length) return null;
  // Readings much more contrived than the name are not worth offering.
  const near = all.slice(1).filter((r) => r.cost - all[0].cost <= ALTERNATIVE_RANGE);
  return { ...all[0], alternatives: near.slice(0, 5).map((r) => r.symbol) };
}

export const detectChord = (pitches) => analyzeChord(pitches)?.symbol || "";
