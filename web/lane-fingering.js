// Shared fingering jobs/cache and authored-reference alignment. No tablature
// window, export controller or UI voicing module participates in this service.
import { laneFretTuning } from "./lane-tuning.js";
import { songBarStarts } from "./song-bars.js";
import { onLiveTiming, timingData, timingIdOf } from "./timing.js";
import { fretboardHandKey } from "./fretboard-cache.js";
import { paintMemo } from "./paint-memo.js";
import { arrangedNotes, chordColumns, isChosenFinger, keepVoicing, voiceNotesFingered } from "./voicing-core.js";
import { S } from "./store.js";
import { withoutDirtying } from "./save-state.js";
import { minDur } from "./grid-read.js";
import { refOccurrences } from "./reference-core.js";
import { boxMinIn, laneClock } from "./reference-clock.js";

const laneBars = (lane) => (onLiveTiming(lane) ? songBarStarts() : songBarStarts(timingData(timingIdOf(lane))));

// Whole-lane voicing is pure CPU work. Cache completed position arrays by the
// lane object + edit revision, and run misses in the existing module worker so
// opening tablature never monopolizes the browser's main thread.
const laneVoicingCache = new WeakMap();

export const laneFingeringKey = paintMemo(function laneFingeringKey(lane, tuning = laneFretTuning(lane)) {
  // The bar lines are part of the answer now — the voicer plans the hand a bar at a
  // time — and a meter-only grid edit changes them without touching a note, so it
  // never bumps voicingRevision. Keyed on the times themselves rather than a summary:
  // a tempo marker can move a bar without changing how many there are.
  return fretboardHandKey(lane, S.voicingRevision, `${tuning.join(",")}:${laneBars(lane).join(",")}`);
});

const aborted = () => Object.assign(new Error("tablature generation cancelled"), { name: "AbortError" });

function voicedMap(notes, positions) {
  const voiced = new Map();
  positions.forEach((position, i) => { if (position && notes[i]) voiced.set(notes[i], position); });
  return voiced;
}

// Returns { voiced, fingers, seats }: the positions, and the hand that played them.
// The two extra maps are what the fretboard annotates the neck with — see
// voiceNotesFingered. They are absent on the exact-fingering path, where the
// positions are the transcriber's and there is no walk to have a hand.
async function voiceLaneAsync(lane, notes, tuning, signal) {
  const key = laneFingeringKey(lane, tuning);
  const cached = laneVoicingCache.get(lane);
  if (cached?.key === key && cached.positions.length === notes.length) return handedMap(notes, cached);
  if (signal?.aborted) throw aborted();

  // Headless callers and older embedded browsers retain the synchronous path.
  if (typeof Worker === "undefined") {
    const { voiced, fingers, seats } = voiceNotesFingered(notes, tuning, Infinity,
      { bars: laneBars(lane), instrument: lane.instrument, capo: lane.capo,
        holds: lane.handHolds });
    const got = {
      positions: notes.map((note) => voiced.get(note) || null),
      fingers: notes.map((note) => fingers.get(note) ?? null),
      seats: notes.map((note) => seats.get(note) ?? null),
    };
    laneVoicingCache.set(lane, { key, ...got });
    return { voiced, fingers, seats };
  }

  // Nothing new starts mid-drag: the notes are still moving, so every answer would
  // be stale by the time it arrives. The release redraws and asks again.
  if (S.drag) {
    await afterDrag();
    if (signal?.aborted || laneFingeringKey(lane, tuning) !== key) throw aborted();
  }
  // One worker per lane at a time. The labels, the tab and the fretboard all ask
  // on every frame of a drag, each with a new key; a worker per ask piled up
  // hundreds of them until the renderer ran out of memory. A caller with a newer
  // key waits for the running job, then only the still-current key starts one.
  let job;
  while ((job = laneVoicingJobs.get(lane)) && job.key !== key) {
    await job.promise.catch(() => {});
    if (signal?.aborted || laneFingeringKey(lane, tuning) !== key) throw aborted();
    const done = laneVoicingCache.get(lane);
    if (done?.key === key && done.positions.length === notes.length) return handedMap(notes, done);
  }
  if (!job) {
    job = { key, promise: voiceInWorker(lane, notes, tuning) };
    laneVoicingJobs.set(lane, job);
    job.promise.then(got => laneVoicingCache.set(lane, { key, ...got }), () => {})
      .finally(() => { if (laneVoicingJobs.get(lane) === job) laneVoicingJobs.delete(lane); });
  }
  const got = await new Promise((resolve, reject) => {
    const onAbort = () => reject(aborted());
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    job.promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", onAbort));
  });
  if (signal?.aborted || laneFingeringKey(lane, tuning) !== key) throw aborted();
  return handedMap(notes, got);
}

const laneVoicingJobs = new WeakMap();
// One shared wait for the pointer to let go, however many askers pile up mid-drag.
// ponytail: polls S.drag every 50 ms; an event from interaction.js if that ever shows.
let dragEnd = null;
const afterDrag = () => dragEnd ||= new Promise(resolve => {
  const timer = setInterval(() => { if (!S.drag) { clearInterval(timer); dragEnd = null; resolve(); } }, 50);
});
function voiceInWorker(lane, notes, tuning) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./voicing-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (ev) => {
      if (ev.data.task !== "voice") return;
      worker.terminate();
      resolve({ positions: ev.data.positions || [], fingers: ev.data.fingers || [], seats: ev.data.seats || [] });
    };
    worker.onerror = () => { worker.terminate(); reject(new Error("automatic fingering worker failed")); };
    worker.postMessage({ task: "voice", notes, tuning, bars: laneBars(lane),
      instrument: lane.instrument, capo: lane.capo, holds: lane.handHolds });
  });
}

// The three index-aligned arrays back into maps on the caller's own note objects.
const handedMap = (notes, got) => ({
  voiced: voicedMap(notes, got.positions),
  fingers: new Map(notes.flatMap((note, i) => Number.isFinite(got.fingers?.[i]) ? [[note, got.fingers[i]]] : [])),
  seats: new Map(notes.flatMap((note, i) => Number.isFinite(got.seats?.[i]) ? [[note, got.seats[i]]] : [])),
});

// One lane's fingering: its tuning, its arranged notes, and the string/fret each
// one lands on. Imported positions are pins like any other, so every consumer — the
// fretboard, the tab, both Guitar Pro exports and Rocksmith — gets this one answer.
//
// The fretboard view calls this too, which is the point of it being one function:
// what the neck shows a player and what the .gp5 contains are the same fingering,
// out of the same worker and the same cache.
export async function laneFingering(lane, signal) {
  const tuning = laneFretTuning(lane), notes = arrangedNotes(lane.notes);
  const found = await voiceLaneAsync(lane, notes, tuning, signal);
  return finishLaneFingering(lane, notes, tuning, found, true);
}

// Clipboard capture is synchronous: a paste immediately after Copy must already
// contain the displayed fingers and hand, including automatically solved values.
export function laneFingeringNow(lane) {
  const tuning = laneFretTuning(lane), notes = arrangedNotes(lane.notes);
  const cached = laneVoicingCache.get(lane);
  const key = laneFingeringKey(lane, tuning), hit = cached?.key === key && cached.positions.length === notes.length;
  const found = hit ? handedMap(notes, cached) : voiceNotesFingered(notes, tuning, Infinity,
      { bars: laneBars(lane), instrument: lane.instrument, capo: lane.capo, holds: lane.handHolds });
  if (!hit) laneVoicingCache.set(lane, { key,
    positions: notes.map(n => found.voiced.get(n) || null),
    fingers: notes.map(n => found.fingers.get(n) ?? null), seats: notes.map(n => found.seats.get(n) ?? null) });
  return finishLaneFingering(lane, notes, tuning, found, false);
}

function finishLaneFingering(lane, notes, tuning, found, remember) {
  // A finger typed in by the player is shown and exported as typed: no check that a
  // hand can hold it. On an open string there is nothing to finger, so it waits.
  // Before the references, so a repeat takes it from its first time; after, so a
  // repeat's own typed finger still wins.
  const typed = () => {
    for (const n of notes) if (isChosenFinger(n.finger) && found.voiced.get(n)?.fret > 0) found.fingers.set(n, n.finger);
    // A chosen index finger defines the hand position just as the automatic
    // fingering does. Apply it to the whole chord, including its open strings.
    // Keep this over the cached answer: cancelling/resetting a finger then
    // restores the automatic hand without moving or revoicing any notes.
    for (const column of chordColumns(notes)) {
      const indexFrets = column.notes.filter(n => n.finger === 1 && !n.fx?.dead)
        .map(n => found.voiced.get(n)?.fret).filter(fret => fret > 0);
      if (!indexFrets.length) continue;
      const seat = Math.min(...indexFrets);
      for (const n of column.notes) found.seats.set(n, seat);
    }
  };
  typed();
  alignReferences(lane, notes, found);
  typed();
  // What was just voiced stays put: the next edit voices only what is new or no
  // longer fits (keepVoicing). No undo step and no new revision — the answer is the
  // same, it is only remembered.
  // Only for the lane itself: previews voice a copy, and their answer is hypothetical.
  if (remember && S.state?.editLanes?.includes(lane)) withoutDirtying((before) => keepVoicing(lane.notes, found, tuning, before));
  return { tuning, notes, ...found };
}

// A REFERENCE BOX IS THE PLAYER SAYING THESE ARE THE SAME PASSAGE, so its occurrences
// are played the same way. The voicer decides a register a bar at a time over the whole
// lane, so the same four bars arriving from different neighbours can come out on
// different strings — true of the music around them, and wrong about a repeat the user
// has explicitly marked as one.
//
// THIS IS NOT THE ENGINE READING THE BOXES, and that distinction is the whole reason it
// lives here. voicing-core.js is handed notes and nothing else: its job is to find the
// structure itself, and a repeat detector that works because someone drew a rectangle
// is not a repeat detector — it would also make every corpus measurement meaningless,
// since the fixtures carry boxes it would be reading the answer out of. What happens
// here is the editor honouring an annotation the user made by hand, after the engine
// has had its unaided say, on the way to the screen and the export.
//
// The FIRST occurrence is the template, because a repeat is played the way you played
// it the first time, and because "first in time" is an answer that never depends on
// which box you happened to touch last. A manual pin needs no special case: the mirror
// already copies `pos` across the group, so either every occurrence carries it or none
// does, and copying a position onto a note that is already pinned there changes nothing.
//
// Occurrences that are no longer the same notes are left alone. A box whose contents
// were edited on one side is not a statement about the other, and forcing a position
// from it would put a note on a fret that does not sound it.
function alignReferences(lane, notes, found) {
  const groups = lane.refBoxes;
  if (!groups) return;
  const { voiced, fingers, seats } = found;
  const minIn = minDur();
  for (const key of Object.keys(groups)) {
    const occurrences = refOccurrences(groups[key], notes, Math.min(minIn, ...(groups[key].anchors || []).map(boxMinIn)), laneClock(lane));
    const src = occurrences[0];
    if (!src?.length) continue;
    for (let i = 1; i < occurrences.length; i++) {
      const dst = occurrences[i];
      if (dst.length !== src.length || dst.some((n, k) => n.pitch !== src[k].pitch)) continue;
      for (let k = 0; k < src.length; k++) {
        const pos = voiced.get(src[k]);
        if (!pos) continue;
        voiced.set(dst[k], { ...pos });
        // The finger and the fret the hand stands on come with it. A repeat fingered
        // like its first time but with the numbers off a different hand is two answers
        // to one question, and the numbers are counted from the seat.
        const finger = fingers?.get(src[k]);
        if (finger != null) fingers.set(dst[k], finger);
        const seat = seats?.get(src[k]);
        if (seat != null) seats.set(dst[k], seat);
      }
    }
  }
}

