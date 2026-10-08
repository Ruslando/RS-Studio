// Expensive chord-arrangement enumeration and phrase scoring live in a worker
// so opening and using the chord preview never blocks the browser's UI thread.
import { diverseShapes, enumerateShapes, gripCostBreakdown, handProfileForTuning, overrideEffectKinds, scoreShapesAsDecided, shapeCost, shapeKey, voiceNotesFingered, voicingReviewMarks } from "./voicing-core.js";
// Also exported by voicing-core, and imported again when the re-voicing block
// below comes back: arrangementVoiceCounts, chordArrangementChoices.

const PER_SIZE = 12;
// const CONTEXTUAL_CANDIDATES = 18;   // pool cap while re-voicings were mixed in

self.onmessage = (ev) => {
  // `analysis` and `sourcePitches` are still sent and still part of the cache
  // key; only the re-voicing block that read them is switched off, so they come
  // back out of ev.data when it does. `influence` and `context` are sent for the
  // same reason — the scorer below stopped reading them when it moved to the
  // voicer's own bounded window, but they still key the cache.
  const { task = "alternatives", columns, focusIdx, tuning, current } = ev.data;
  // Where the bars are. The voicer plans the fretting hand a bar at a time
  // (planSeats) and has no tempo grid of its own, so every task that voices a lane
  // has to carry the song's bar lines in with it — including the two that only ask
  // about one column, or the board would price shapes against a hand the tab never
  // had. Absent, the plan simply does not run.
  const bars = ev.data.bars || [];
  // Which instrument, so the engine and the drawn neck agree on how many frets
  // there are. fretboardFor falls back to the electric when it is absent.
  const instrument = ev.data.instrument;
  // Where the player put the fretting hand, in seconds. Times and not notes, so a
  // hold survives retracing the passage under it — see holdsByColumn.
  const holds = ev.data.holds;
  if (task === "voice") {
    const notes = ev.data.notes || [];
    // The hand rides along with the positions: which finger took each note and which
    // fret it was anchored on. Same pass, so it costs nothing, and the board needs it
    // to say anything about WHY a position was chosen.
    const { voiced, fingers, seats } = voiceNotesFingered(notes, tuning, Infinity, { bars, instrument, holds });
    self.postMessage({
      task,
      positions: notes.map((note) => voiced.get(note) || null),
      fingers: notes.map((note) => fingers.get(note) ?? null),
      seats: notes.map((note) => seats.get(note) ?? null),
    });
    return;
  }
  if (task === "overrideEffects") {
    const notes = ev.data.notes || [];
    // Both marks a lane's notes can carry that need a whole-lane voicing pass to
    // know about, answered by one job: which fingerings an override moved, and
    // which ones the voicer reused out of its memory while a better shape was on
    // offer. Two jobs would mean two passes over the same lane.
    self.postMessage({
      task,
      kinds: overrideEffectKinds(notes, tuning, { bars, instrument, holds }),
      review: voicingReviewMarks(notes, tuning, { bars, instrument, holds }),
    });
    return;
  }
  const focusNotes = columns[focusIdx]?.notes || [];
  // ---- re-voicings: OFF ----
  // The other family of candidates: same chord, different notes — added tones,
  // dropped notes, other inversions. Switched off at the source rather than
  // filtered at the end, so nothing is enumerated and scored only to be thrown
  // away. Commented, not deleted: the engine still knows how, and turning it back
  // on is this block, its round-robin below, the two imports at the top, and the
  // group heading in voicing.js.
  //
  // const bySize = [];
  // if (analysis) {
  //   for (const count of arrangementVoiceCounts(analysis.pcs, sourcePitches.length, tuning.length)) {
  //     bySize.push(chordArrangementChoices(analysis.pcs, analysis.root, count, tuning, sourcePitches, PER_SIZE));
  //   }
  // }
  // What is left is exact-note placement only: the pitches that are written,
  // somewhere else on the neck.
  const pool = [], seen = new Set();
  if (current?.notes?.length && current.positions?.length === current.notes.length) {
    const notes = current.notes.map((n) => ({ pitch: n.pitch }));
    // `positions` stays index-aligned with `notes` and carries null for a note
    // the instrument cannot reach, so the shape map keeps only what is placed.
    const shape = new Map(notes.flatMap((n, i) => current.positions[i] ? [[n, current.positions[i]]] : []));
    seen.add(shapeKey(shape));
    pool.push({ notes, shape, kind: current.kind || "exact", current: true });
  }
  for (const shape of diverseShapes(enumerateShapes(focusNotes, tuning), PER_SIZE, handProfileForTuning(tuning))) {
    const key = shapeKey(shape);
    if (seen.has(key)) continue;
    seen.add(key); pool.push({ notes: focusNotes, shape, kind: "exact" });
  }
  // Round-robin the sizes, each with its own cursor. Every group is sorted by
  // cost, so its leading entries are very often shapes the exact-note pass
  // already found — and a shared rank index made those collisions cost the group
  // its turn, or (when a whole rank collided) end the fill outright. A plain
  // triad came back with its five exact placements and not one re-voicing.
  //
  // const cursors = bySize.map(() => 0);
  // for (let progress = true; progress && pool.length < CONTEXTUAL_CANDIDATES; ) {
  //   progress = false;
  //   for (let size = 0; size < bySize.length && pool.length < CONTEXTUAL_CANDIDATES; size++) {
  //     const group = bySize[size];
  //     while (cursors[size] < group.length && seen.has(shapeKey(group[cursors[size]].shape))) cursors[size]++;
  //     if (cursors[size] >= group.length) continue;
  //     const choice = group[cursors[size]++];
  //     seen.add(shapeKey(choice.shape));
  //     pool.push({ ...choice, kind: "arranged" });
  //     progress = true;
  //   }
  // }
  // Priced the way the voicer prices, in the window it actually decides the column
  // in — see scoreShapesAsDecided. It used to be scoreArrangementsInContext, whose
  // wider window gave the board a second opinion nothing in the app acted on.
  //
  // `influence` and `context` are no longer read here: voiceColumns reads an
  // override's influence off the notes themselves, and a bounded window needs no
  // phrase boundary handed to it. Both stay in the message because they are part of
  // the cache key on the other side.
  const profile = handProfileForTuning(tuning);
  const priced = scoreShapesAsDecided(pool.map((choice) => choice.shape), columns, focusIdx, tuning, { bars, instrument, holds });
  const choices = pool
    .map((choice, i) => ({ choice, priced: priced[i] }))
    .filter((x) => Number.isFinite(x.priced.cost))
    .sort((a, b) => a.priced.cost - b.priced.cost)
    .map(({ choice, priced: got }) => ({
      kind: choice.kind,
      current: !!choice.current,
      notes: choice.notes.map((n) => ({ pitch: n.pitch })),
      positions: choice.notes.map((n) => choice.shape.get(n) ?? null),
      // The hand this shape would be played with, from the same solve that priced it.
      seat: got.seat, fingers: got.fingers,
      costs: {
        grip: shapeCost(choice.shape, profile),
        gripParts: gripCostBreakdown(choice.shape, profile).parts,
        passage: got.cost,
      },
    }));
  self.postMessage({ choices });
};
