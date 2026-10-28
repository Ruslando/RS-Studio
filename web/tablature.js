import { toneMarkersForExport } from "./tone-marker-core.js";
// Guitar Pro export and the alphaTab tablature view. Exports consume all enabled
// tab layers, while preview builds a one-layer alphaTab score for the currently
// selected layer. alphaTab draws the playback cursor and handles click-to-seek;
// the app's own transport (song audio + lane synths) remains the sound engine.

import { INSTRUMENTS, instrKey, toneOf } from "./constants.js";
import { fretboardFor } from "./fretboard-core.js";
import { audio, tabRenderEl, tabScrollEl, tabViewBackdropEl, tabViewCloseEl, tabWarnEl, tsDenInput } from "./dom.js";
import { copyEffects } from "./note-effects.js";
import { beatsPerBar, exportResolution, gridBpm, gridOffset, gridSubdiv, minDur } from "./grid.js";
import { refOccurrences } from "./reference-core.js";
import { boxMinIn, laneClock } from "./references.js";
import { songBarStarts } from "./song-bars.js";
import { fretboardHandKey } from "./fretboard-cache.js";
import { onLiveSections, onLiveTiming, timingData, timingIdOf } from "./timing.js";

// A layer's bar lines come from its own timing (web/timing.js).
const laneBars = (lane) => (onLiveTiming(lane) ? songBarStarts() : songBarStarts(timingData(timingIdOf(lane))));
import { editLanes } from "./lanes.js";
import { exportSongName, metadataFromState, metadataPayload } from "./metadata.js";
import { ensureTone, pauseTransport, playbackTime, playTransport, revealPlaybackPosition, seekPlayback, transportPlaying } from "./playback.js";
import { downloadProjectBlob, toast } from "./notify.js";
import { jobRequest } from "./operation-progress.js";
import { S } from "./store.js";
import { scoreProjectionSignature } from "./guitar-pro-core.js";
import { normalizedLaneFields } from "./marker-rails.js";
import { sectionMarkersForExport } from "./section-marker-core.js";
import { isTablatureLane, selectedTablatureLane } from "./layer-role.js";
import { modernGpProjectionStatus, modernGpResult, projectedGpLaneScore } from "./guitar-pro-score.js";
import { parseTuning, songTimeToTabMs, tabMsToSongTime } from "./util.js";
import { TUNINGS } from "./tunings.js";
import { arrangedNotes, chordColumns, handChoices, handProfileForTuning, isChosenFinger, keepVoicing, representPickedOpenSlides, voiceNotesFingered } from "./voicing.js";
import { draw } from "./repaint.js";

// ---- tablature (Guitar Pro export + alphaTab preview) ----
// Tuning presets live in tunings.js (no DOM), so guitar-pro-edit.js can read them too.
export { TUNINGS } from "./tunings.js";

// User-defined named tunings (note strings, e.g. "G2 D2 A1 E1"), managed via
// "Manage tunings…" on the layer tuning select. Global, reusable across projects,
// and kept by the server: the desktop window's own storage is wiped on every start.
// The window's storage only carries tunings made before that, into the server once.
const LS = typeof localStorage !== "undefined" ? localStorage : null;   // Limitation: undefined under node test
const OLD_TUNINGS_KEY = "cw.customTunings";
const saveCustomTunings = () => fetch("/api/tunings", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(customTunings) }).catch(() => {});
export let customTunings = [];

export async function loadCustomTunings() {
  try {
    const res = await fetch("/api/tunings");
    customTunings = res.ok ? await res.json() : [];
    const old = JSON.parse(LS?.getItem(OLD_TUNINGS_KEY) || "[]");
    if (old.length && !customTunings.length) { customTunings = old; await saveCustomTunings(); }
    LS?.removeItem(OLD_TUNINGS_KEY);
  } catch { /* offline: no tunings of your own this session */ }
}

export const newTuningId = () => "ct_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// The tuning manager edits a draft and hands the whole list over on Save.
export function replaceCustomTunings(list) {
  customTunings = list.map((t) => ({ id: t.id, name: t.name, notes: t.notes, ...(t.instrument ? { instrument: t.instrument } : {}) }));
  saveCustomTunings();
}
// A tuning IS its open strings: two with the same strings are the same tuning,
// whatever they are called. The built-in or one of yours with these strings, or null.
const sameStrings = (a, b) => a.length === b.length && a.every((p, i) => p === b[i]);
export function tuningKeyFor(midis) {
  if (!midis?.length) return null;
  return Object.keys(TUNINGS).find((key) => sameStrings(TUNINGS[key].tuning, midis))
    || customTunings.find((t) => sameStrings(parseTuning(t.notes) || [], midis))?.id || null;
}
// A lane's `tuning` field resolves against built-ins, a custom-tuning id, or
// (legacy) the literal "custom" sentinel paired with lane.customTuning.
export const isValidTuningKey = (key) =>
  !!(key && (TUNINGS[key] || key === "custom" || customTunings.some((t) => t.id === key)));

export let tabApi = null;            // alphaTab instance (created lazily)

// Tuning parsing lives in util.js so guitar-pro-edit.js can reach it without
// pulling in this module's DOM and alphaTab surface (it had its own copy).
// Re-exported here because this is where every tuning caller already looks.
export { noteToMidi, parseTuning, tuningToNames } from "./util.js";


// Resolve a lane's tab tuning (open-string MIDI, hi→lo) from its own settings.
export function laneTuning(lane) {
  if (TUNINGS[lane.tuning]) return TUNINGS[lane.tuning].tuning;
  const custom = customTunings.find((t) => t.id === lane.tuning);
  if (custom) return parseTuning(custom.notes) || TUNINGS.guitar6.tuning;
  if (lane.tuning === "custom") return parseTuning(lane.customTuning) || TUNINGS.guitar6.tuning;
  return TUNINGS[INSTRUMENTS[instrKey(lane.instrument)].tuning].tuning;
}

// The tuning positions are counted against: a note's pitch is this open pitch plus
// its fret. Frets count from the capo, as in Guitar Pro (alphaTab's pitch is
// fret + open + capo - transposition), so fret 0 is the capo itself.
export function laneFretTuning(lane) {
  const shift = (Number(lane.capo) || 0) - (Number(lane.transpositionPitch) || 0);
  return laneTuning(lane).map((open) => open + shift);
}

// How many frets there are above the capo: the neck's own, minus the capo's.
export const laneFretCount = (lane) => fretboardFor(lane.instrument).frets - (Number(lane.capo) || 0);

// General-MIDI program for a lane's tone (the exported track's sound). A sound, so
// it comes off the tone and not off the neck.
function laneGm(lane) {
  if (Number.isFinite(lane.gmProgram)) return Math.max(0, Math.min(127, Math.round(lane.gmProgram)));
  return toneOf(lane).gm;
}

// ---- the tablature window ----
// It was a second MAIN VIEW, swapped in over the editor by a pill in the
// toolbar. Both are gone: the tab is what you check the drawing against, so
// taking the drawing away to show it meant losing your place in order to answer
// a question about it. `setView` keeps its name and its two arguments because
// every caller means the same thing by them — show me the tab, take it away.
export const tabViewOn = () => !!tabViewBackdropEl && !tabViewBackdropEl.hidden;

export function setView(view) {
  if (!S.state) return;
  const tab = view === "tab";
  if (tab === tabViewOn()) return;
  tabViewBackdropEl.hidden = !tab;
  if (tab) { refreshTab(); tabLoop(); tabShowCursor(); }
  else tabBuildController?.abort();
  // The editor is never unmounted now, so there is no canvas to restore and no
  // double rAF to wait for: the spectrogram was there the whole time, behind it.
}

// Re-render the tab if its view is showing (e.g. after a lane edit or undo).
export function refreshTabIfOpen() {
  if (tabViewOn()) refreshTab();
}

// Apply the explicit output role before arranging or voicing. Eye visibility
// affects only the editor: a hidden tab track still exports, while a visible
// reference layer never invokes the potentially expensive fingering pass.
// One score has one tempo map, so the tab shows the layers that share the active
// layer's timing; a layer with its own shows when it is the active one.
function tabLanes() {
  return editLanes().filter((lane) => isTablatureLane(lane) && lane.notes.length && onLiveTiming(lane));
}

// Whole-lane voicing is pure CPU work. Cache completed position arrays by the
// lane object + edit revision, and run misses in the existing module worker so
// opening tablature never monopolizes the browser's main thread.
const laneVoicingCache = new WeakMap();

export function laneFingeringKey(lane, tuning = laneFretTuning(lane)) {
  // The bar lines are part of the answer now — the voicer plans the hand a bar at a
  // time — and a meter-only grid edit changes them without touching a note, so it
  // never bumps voicingRevision. Keyed on the times themselves rather than a summary:
  // a tempo marker can move a bar without changing how many there are.
  return fretboardHandKey(lane, S.voicingRevision, `${tuning.join(",")}:${laneBars(lane).join(",")}`);
}

const aborted = () => Object.assign(new Error("tablature generation cancelled"), { name: "AbortError" });

// THE HANDS EACH NOTE OR CHORD OF A LANE CAN BE PLAYED WITH: [{ t0, choices }] by
// onset (handChoices), from the lane's last fingering, which a hand anchor does not
// change, since anchors move no notes. Null until that fingering is in; asking
// starts it and redraws when it arrives.
const handColumnsCache = new WeakMap();
export function laneHandColumns(lane, { now = false } = {}) {
  const key = laneFingeringKey(lane);
  let cached = laneVoicingCache.get(lane);
  if (cached?.key !== key && now) {
    // Asked for an answer on the spot (an editor opening): voice the lane here.
    const notes = arrangedNotes(lane.notes), tuning = laneFretTuning(lane);
    const { voiced } = voiceNotesFingered(notes, tuning, Infinity,
      { bars: laneBars(lane), instrument: lane.instrument, capo: lane.capo, holds: lane.handHolds });
    cached = { key, positions: notes.map((note) => voiced.get(note) || null) };
  }
  if (cached?.key !== key) { laneFingering(lane).then(() => draw()).catch(() => {}); return null; }
  const memo = handColumnsCache.get(lane);
  if (memo?.key === key) return memo.columns;
  const notes = arrangedNotes(lane.notes), voiced = voicedMap(notes, cached.positions);
  const profile = handProfileForTuning(laneFretTuning(lane)), max = Math.max(1, laneFretCount(lane) - 3);
  const columns = chordColumns(notes).map((c) => ({
    t0: c.t0, choices: handChoices(new Map(c.notes.filter((n) => voiced.has(n)).map((n) => [n, voiced.get(n)])), profile, max) }));
  handColumnsCache.set(lane, { key, columns });
  return columns;
}

// The note or chord a hand anchor at `t` belongs to (the first at or after it).
export const handColumnAt = (columns, t) => columns?.find((c) => c.t0 >= Number(t) - 1e-6) ?? null;

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

// A track on another timing than the spec's (the live one) carries its own grid
// and sections; the Rocksmith builder charts each arrangement on its own beat grid.
function ownTimingFields(lane) {
  const t = timingData(timingIdOf(lane));
  return {
    ...(onLiveSections(lane) ? {} : { sections: sectionMarkersForExport(t.sectionMarkers || []) }),
    ...(onLiveTiming(lane) ? {} : { grid: { ...t.grid, tempoMap: (t.tempoMap || []).map((m) => ({ t: +m.t, bpm: +m.bpm, tsNum: +m.tsNum, tsDen: +m.tsDen, subdiv: +m.subdiv || t.grid.subdiv })) } }),
  };
}

function buildSpecFromPrepared(prepared) {
  const meta = metadataFromState(S.state);
  return {
    name: exportSongName(meta, S.state.name || S.state.filename || "tab"),
    metadata: metadataPayload(meta),
    sections: sectionMarkersForExport(S.state.sectionMarkers || []),
    grid: {
      bpm: gridBpm() || 120, offset: gridOffset(),
      tsNum: beatsPerBar(), tsDen: parseInt(tsDenInput.value, 10) || 4,
      subdiv: gridSubdiv(),
      // Extra tempo/meter markers → the .gp5 gets per-bar time signatures + tempo changes.
      tempoMap: (S.state.tempoMap || []).map((m) => ({ t: +m.t, bpm: +m.bpm, tsNum: +m.tsNum, tsDen: +m.tsDen, subdiv: +m.subdiv || gridSubdiv() })),
    },
    // Resolution is the finest grid required by the marker map, so on-grid notes
    // in denser later segments never merge into the coarser start segment.
    resolution: exportResolution(),
    tracks: prepared.map(({ lane: l, exportNotes, voiced, seats, fingers }) => {
      // The front-end is the source of truth for fingering: voice the lane here
      // and ship string+fret per note so the export matches the preview exactly.
      // string is 1-based GP order (string 1 = highest open), as the backend wants.
      const tuning = laneTuning(l);
      return {
        id: l.id,
        name: l.name,
        ...ownTimingFields(l),
        ...normalizedLaneFields(l),
        toneMarkers: toneMarkersForExport(l.toneMarkers),
        instrument: laneGm(l),
        tuning,
        // Frets below count from it; the .gp5 writer and Rocksmith both need it.
        capo: Number(l.capo) || 0,
        notes: representPickedOpenSlides(exportNotes.map((n) => {
          const pos = voiced.get(n), hand = seats?.get(n), finger = fingers?.get(n);
          return copyEffects(n, {
            start: n.start, end: n.end, pitch: n.pitch,
            string: pos ? pos.string + 1 : null, fret: pos ? pos.fret : null,
            // The fret the index stands on, as the fretboard shows it (counted from the
            // capo, like `fret`). Rocksmith's hand positions are exactly these.
            ...(Number.isFinite(hand) ? { hand } : {}),
            // The fretboard's finger on a fretted note (0 thumb, 1 index … 4 pinky).
            ...(pos?.fret > 0 && finger >= 0 && finger <= 4 ? { finger } : {}),
          });
        }), (note) => note),
      };
    }),
  };
}

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
  // A finger typed in by the player is shown and exported as typed: no check that a
  // hand can hold it. On an open string there is nothing to finger, so it waits.
  // Before the references, so a repeat takes it from its first time; after, so a
  // repeat's own typed finger still wins.
  const typed = () => { for (const n of notes) if (isChosenFinger(n.finger) && found.voiced.get(n)?.fret > 0) found.fingers.set(n, n.finger); };
  typed();
  alignReferences(lane, notes, found);
  typed();
  // What was just voiced stays put: the next edit voices only what is new or no
  // longer fits (keepVoicing). No undo step and no new revision — the answer is the
  // same, it is only remembered.
  // Only for the lane itself: previews voice a copy, and their answer is hypothetical.
  if (S.state?.editLanes?.includes(lane)) keepVoicing(lane.notes, found, tuning, lane.handHolds);
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

// The synchronous twin of buildSpecForLanesAsync below was deleted with its
// only caller: every export path is async, because voicing a lane runs in a
// worker.
// Exported for the Rocksmith export: it builds its spec from the same lanes
// and voicing pass the built-in Guitar Pro export uses.
export async function buildSpecForLanesAsync(lanes, signal) {
  const prepared = await Promise.all(lanes.map(async (lane) => {
    const { notes: exportNotes, voiced, seats, fingers } = await laneFingering(lane, signal);
    return { lane, exportNotes, voiced, seats, fingers };
  }));
  if (signal?.aborted) throw aborted();
  return buildSpecFromPrepared(prepared);
}

async function buildTabSpecAsync(signal) {
  return buildSpecForLanesAsync(tabLanes(), signal);
}

// Load the alphaTab bundle on demand (the first time the tab view opens),
// so its large script + music font stay off the initial page load.
export let alphaTabLoading = null;

export function loadAlphaTab() {
  if (window.alphaTab) return Promise.resolve();
  if (alphaTabLoading) return alphaTabLoading;
  alphaTabLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "vendor/alphatab/alphaTab.min.js";
    s.onload = () => resolve();
    s.onerror = () => { alphaTabLoading = null; reject(new Error("Failed to load alphaTab")); };
    document.head.appendChild(s);
  });
  return alphaTabLoading;
}

function ensureTabApi() {
  if (tabApi || !window.alphaTab) return tabApi;
  tabApi = new alphaTab.AlphaTabApi(tabRenderEl, {
    core: { fontDirectory: "vendor/alphatab/font/", useWorkers: false, engine: "svg" },
    // External-media player: alphaTab shows the cursor / handles click-to-seek and
    // delegates the actual transport to us — no soundfont, no second audio engine.
    // scrollElement must be an ANCESTOR of the render element (alphaTab's scroll
    // target math is relative to it) — same element would compound scrollTop.
    player: { playerMode: alphaTab.PlayerMode.EnabledExternalMedia, scrollElement: tabScrollEl },
    display: { scale: 1.0, staveProfile: alphaTab.StaveProfile.Tab },
    // The GP track also advertises a standard-notation staff. Automatic mode
    // therefore hides rhythm on the tab even though this preview is tab-only.
    notation: { rhythmMode: alphaTab.TabRhythmMode.ShowWithBars },
  });
  // One flat sync point at bar 0: our scores are constant-tempo, so alphaTab
  // extends it into an identity media↔score time mapping. Without ANY sync
  // points its external-media math is inconsistent at speed ≠ 1 (tick lookup
  // multiplies by playbackSpeed, media time is never divided by it), which
  // breaks the cursor as soon as playbackSpeed is set (see syncTabSpeed).
  tabApi.scoreLoaded.on((score) => {
    score.applyFlatSyncPoints([{ barIndex: 0, barOccurence: 0, barPosition: 0, millisecondOffset: 0 }]);
    // Render every track of the score, not just the first.
    tabApi.renderTracks(score.tracks);
  });
  // Surface load/render failures instead of leaving a silent blank panel.
  tabApi.error.on((err) => {
    tabLoadGuard = null;
    const msg = (err && (err.message || (err.error && err.error.message))) || String(err);
    tabWarnEl.textContent = "preview error: " + msg;
    console.error("alphaTab error:", err);
  });
  // Bridge alphaTab's transport to the app's: score time 0 = grid offset in the
  // song, and the master <audio> element is the clock (same one the synths follow).
  // seekTo ignores "echo" seeks — alphaTab re-syncing the media to its own position
  // inside a call WE made (pause/play/updatePosition). The app transport is the
  // source of truth; only real user seeks (clicking a beat) may move it.
  const handler = {
    get backingTrackDuration() { return Math.max(0, ((audio.duration || S.state?.duration || 0) - gridOffset()) * tabTimeScale() * 1000); },
    get playbackRate() { return audio.playbackRate || 1; },
    set playbackRate(v) { audio.playbackRate = v; },
    get masterVolume() { return 1; },
    set masterVolume(_) { /* mixer volumes live in the app's own UI */ },
    seekTo(ms) { if (!tabEcho && !tabLoadGuard) seekPlayback(tabMsToSongTime(ms, gridOffset(), tabTimeScale())); },
    play() { if (!tabLoadGuard) ensureTone().then(() => playTransport()).catch(() => {}); },
    pause() { if (!tabLoadGuard) pauseTransport(); },
  };
  const wire = () => {
    const out = tabApi.player && tabApi.player.output;
    if (out && "handler" in out) out.handler = handler;
    syncTabSpeed();   // speed may have been set before the tab view opened
    if (transportPlaying()) echo(() => tabApi.play());   // joined mid-playback
  };
  tabApi.playerReady.on(wire);
  wire();
  // postRenderFinished (bounds ready): fix rest-bar cursor anchors, park the cursor.
  tabApi.postRenderFinished.on(() => {
    anchorRestBars();
    if (tabLoadGuard) tabLoadGuard.rendered = true;
    settleTabLoad();
    tabTick(); tabShowCursor();
  });
  // The score usually ends before the song does. Reporting a position at/past the
  // score end trips alphaTab's "finished" handling, which pauses and rewinds OUR
  // transport — so clamp what we report: the cursor parks on the last beat and the
  // song plays on.
  // endTime arrives divided by alphaTab's playbackSpeed; multiply it back so
  // tabEndMs stays in score/media ms — the domain tabTick's clamp works in.
  tabApi.midiLoaded.on((e) => {
    tabEndMs = e.endTime * (tabApi.playbackSpeed || 1);
    if (tabLoadGuard) tabLoadGuard.midi = true;
    settleTabLoad();
  });
  return tabApi;
}

let tabEndMs = Infinity;   // score length in ms (from midiLoaded)

// The .gp5 can only store an integer tempo, but the grid BPM may be fractional
// (e.g. a detected 107.67). Score time runs at the rounded tempo, so scale real
// seconds accordingly or the cursor drifts ~0.3% per bar across the song.
const tabTimeScale = () => {
  const b = gridBpm(); return b ? b / Math.round(b) : 1;
};

// alphaTab sweeps the beat cursor between beat glyphs (onNotesX). In an empty
// bar the only glyph is the whole rest, drawn well inside the bar, so through
// empty stretches the cursor runs rest-glyph → rest-glyph and visibly misses
// the barlines. Re-anchor full-bar rests to their bar's left edge in the public
// bounds lookup so the sweep runs barline → barline, which is time-exact.
function anchorRestBars() {
  const bl = tabApi && tabApi.renderer && tabApi.renderer.boundsLookup;
  if (!bl) return;
  for (const sys of bl.staffSystems || [])
    for (const mb of sys.bars || [])
      for (const bar of mb.bars || [])
        for (const bb of bar.beats || [])
          if (bb.beat && bb.beat.isFullBarRest) bb.onNotesX = bar.visualBounds.x;
}

let tabEcho = false;       // true while we call into alphaTab (see handler.seekTo)
let tabLoadGuard = null;   // blocks alphaTab's asynchronous load/reset from seeking the real transport

// Runs an alphaTab call with the echo guard set so our own change events are
// ignored. Swallowing is the point: alphaTab throws from load/render on a score
// it cannot handle, and the caller checks the return value instead.
function echo(fn) { tabEcho = true; try { return fn(); } catch { return undefined; } finally { tabEcho = false; } }

function settleTabLoad() {
  const guard = tabLoadGuard;
  if (!guard || guard.settling || !guard.rendered || !guard.midi) return;
  guard.settling = true;
  // alphaTab completes parts of load/reset on deferred callbacks. Keep the guard
  // through two frames, repeatedly restore its cursor from the untouched audio
  // clock, then allow genuine user click-to-seek events again.
  tabTick();
  requestAnimationFrame(() => {
    if (tabLoadGuard !== guard) return;
    tabTick();
    requestAnimationFrame(() => {
      if (tabLoadGuard !== guard) return;
      tabTick(); tabShowCursor(); tabLoadGuard = null;
    });
  });
}

// alphaTab animates the beat cursor itself between our position pushes, scaling
// the sweep by ITS playbackSpeed — left at 1× it outruns slowed-down audio and
// overshoots up to a full beat ahead. Keep it told about the real media rate.
// Only safe because every loaded score gets sync points (see scoreLoaded):
// with playbackSpeed ≠ 1 and no sync points, alphaTab maps media time to the
// wrong ticks. echo(): the setter rescales alphaTab's internal position,
// which fires a seekTo back at our transport.
function syncTabSpeed() {
  if (!tabApi) return;
  echo(() => { tabApi.playbackSpeed = audio.playbackRate || 1; });
}

// Scroll the cursor row into view. alphaTab only auto-scrolls during playback,
// so opening the view (or a re-render) with the pin far down would show the top
// of the score otherwise. Double rAF: the cursor is placed via alphaTab's own
// deferred invoke, so wait a frame past it before asking where it is.
function tabShowCursor() {
  if (!tabApi) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try { if (tabViewOn()) tabApi.scrollToCursor(); } catch { /* no cursor yet */ }
  }));
}

// Push the transport position into alphaTab (cursor + auto-scroll). Runs per
// frame during playback via tabLoop; single pushes cover seeks and pauses.
function tabTick() {
  if (!tabViewOn() || !tabApi || !tabApi.player) return;
  const out = tabApi.player.output;
  if (!out || !out.updatePosition) return;
  const ms = songTimeToTabMs(playbackTime(), gridOffset(), tabTimeScale());
  echo(() => out.updatePosition(Math.max(0, Math.min(ms, tabEndMs - 1))));
}

function tabLoop() {
  tabTick();
  if (tabViewOn() && transportPlaying()) requestAnimationFrame(tabLoop);
}

let tabSpecJson = "";      // spec of the currently loaded score — unchanged spec ⇒ skip the reload
let tabBuildController = null;

async function refreshTab() {
  tabBuildController?.abort();
  const controller = new AbortController();
  tabBuildController = controller;
  const selected = editLanes().find((lane) => lane.active) || null;
  const lane = selectedTablatureLane(editLanes());
  if (!selected || !lane || !lane.notes?.length) {
    if (!selected) tabWarnEl.textContent = "Select a note layer to preview its tablature.";
    else if (!lane) tabWarnEl.textContent = `“${selected.name}” is not enabled as a tablature track.`;
    else tabWarnEl.textContent = `“${lane.name}” has no tablature notes yet.`;
    tabSpecJson = "";
    if (tabApi) echo(() => tabApi.tex(""));
    tabBuildController = null;
    return;
  }
  try {
    const timing = { bars: S.state.scoreBars || [], tempoMap: S.state.tempoMap || [],
      grid: S.appliedGrid || S.state.baseGrid || {} };
    const marker = `projected:${S.state.job}:${lane.id}:${scoreProjectionSignature([lane])}:${JSON.stringify(timing)}`;
    if (marker === tabSpecJson && tabApi) return;
    tabWarnEl.textContent = "";
    document.getElementById("tabBusy").hidden = false;
    await loadAlphaTab();
    const score = await projectedGpLaneScore(alphaTab, lane, controller.signal);
    if (controller.signal.aborted) return;
    const api = ensureTabApi();
    if (!api) throw new Error("alphaTab failed to load");
    tabLoadGuard = { rendered: false, midi: false, settling: false };
    const ok = echo(() => api.load(score, score.tracks.map((track) => track.index)));
    if (ok === false) throw new Error("alphaTab could not load the selected layer");
    tabSpecJson = marker;
    const warnings = score.cwWarnings || [];
    tabWarnEl.textContent = warnings.join(" · ");   // the dot says "warning"
    tabWarnEl.classList.add("status-line--warn");
  } catch (e) {
    tabLoadGuard = null;
    if (e?.name !== "AbortError") { tabWarnEl.textContent = e.message; tabWarnEl.classList.remove("status-line--warn"); }
  } finally {
    if (tabBuildController === controller) { tabBuildController = null; document.getElementById("tabBusy").hidden = true; }
  }
}

// Build and download the .gp5 immediately, without opening the tab view.
export async function exportTab() {
  if (!S.state) return;
  const name = (S.state.name || S.state.filename || "tab").replace(/[^A-Za-z0-9._ -]+/g, "_");
  // A job (design.md 4.17): fingering a long song takes a while, and until now
  // nothing on screen said the export had started.
  await jobRequest("Exporting Guitar Pro", name + ".gp5", async (panel) => {
    panel.update({ stage: "Calculating fingerings", fraction: null });
    const spec = await buildTabSpecAsync();
    if (!spec.tracks.length) { toast("No tablature notes to export"); return; }
    panel.update({ stage: "Writing the file", fraction: null });
    const res = await fetch("/api/tab", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "tab build failed");
    const buf = await res.arrayBuffer();
    // The warning header is advisory; a malformed one must not fail the export
    // the user is already downloading.
    let warns = []; try { warns = JSON.parse(res.headers.get("X-Tab-Warnings") || "[]"); } catch { /* advisory only */ }
    downloadProjectBlob(new Blob([buf], { type: "application/octet-stream" }), name + ".gp5");
    toast(warns.length ? `Exported ${name}.gp5 · ${warns.length} warning${warns.length === 1 ? "" : "s"}` : `Exported ${name}.gp5`,
          2200, warns.length ? "warn" : "ok");
  }).catch(() => { /* the panel's toast has said what failed */ });
}

// Modern GP7+ export starts from the selected source hierarchy and applies the
// editor projection through the same alphaTab Score used by the app preview.
export async function exportModernGp() {
  if (!S.state) return;
  const status = modernGpProjectionStatus();
  if (!status.available || !status.exportable) { toast(status.reason, 4200); return; }
  const name = exportSongName(metadataFromState(S.state), S.state.name || S.state.filename || "score");
  await jobRequest("Exporting Guitar Pro", name + ".gp", async (panel) => {
    panel.update({ stage: "Writing the file", fraction: null });
    await loadAlphaTab();
    const { bytes, warnings } = await modernGpResult(alphaTab);
    downloadProjectBlob(new Blob([bytes], { type: "application/octet-stream" }), name + ".gp");
    toast(warnings.length ? `Exported ${name}.gp · ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : `Exported ${name}.gp`,
          2200, warnings.length ? "warn" : "ok");
  }).catch(() => { /* the panel's toast has said what failed */ });
}

export function init_tablature() {
  // ponytail: not awaited; a project is opened by hand, long after this localhost round trip.
  loadCustomTunings();
  tabViewCloseEl?.addEventListener("click", () => setView("spec"));
  // Keep alphaTab's player state and cursor in step with the app transport. In
  // external-media mode play()/pause() round-trip through our handler back to the
  // same <audio> element, where they are no-ops — no feedback loop. The echo()
  // wrapper stops alphaTab's internal re-sync from seeking our transport.
  audio.addEventListener("play", () => { if (tabApi) echo(() => tabApi.play()); tabLoop(); });
  audio.addEventListener("pause", () => { if (tabApi) echo(() => tabApi.pause()); tabTick(); });
  audio.addEventListener("seeked", () => tabTick());
  audio.addEventListener("ratechange", () => { syncTabSpeed(); tabTick(); });
  window.addEventListener("cw-transport", (event) => {
    if (event.detail === "play") { if (tabApi) echo(() => tabApi.play()); tabLoop(); }
    else if (event.detail === "pause") { if (tabApi) echo(() => tabApi.pause()); tabTick(); }
    else tabTick();
  });
}
