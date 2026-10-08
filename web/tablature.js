// Guitar Pro export and the alphaTab tablature view. Exports consume all enabled
// tab layers, while preview builds a one-layer alphaTab score for the currently
// selected layer. alphaTab draws the playback cursor and handles click-to-seek;
// the app's own transport (song audio + lane synths) remains the sound engine.

import { INSTRUMENTS, TONES, instrKey, toneKey } from "./constants.js";
import { audio, tabRenderEl, tabScrollEl, tabViewBackdropEl, tabViewCloseEl, tabWarnEl, tsDenInput } from "./dom.js";
import { copyEffects } from "./note-effects.js";
import { beatsPerBar, exportResolution, gridBpm, gridOffset, gridSubdiv, minDur } from "./grid.js";
import { refOccurrences } from "./reference-core.js";
import { songBarStarts } from "./song-bars.js";
import { editLanes } from "./lanes.js";
import { exportSongName, metadataFromState, metadataPayload } from "./metadata.js";
import { ensureTone, pauseTransport, playbackTime, playTransport, revealPlaybackPosition, seekPlayback, transportPlaying } from "./playback.js";
import { downloadProjectBlob, toast } from "./notify.js";
import { S } from "./store.js";
import { scoreProjectionSignature } from "./guitar-pro-core.js";
import { normalizedLaneFields } from "./marker-rails.js";
import { sectionMarkersForExport } from "./section-marker-core.js";
import { isTablatureLane, selectedTablatureLane } from "./layer-role.js";
import { modernGpProjectionStatus, modernGpResult, projectedGpLaneScore } from "./guitar-pro-score.js";
import { parseTuning, songTimeToTabMs, tabMsToSongTime } from "./util.js";
import { arrangedNotes, representPickedOpenSlides, voiceNotesFingered } from "./voicing.js";

// ---- tablature (Guitar Pro export + alphaTab preview) ----
// Tuning presets: open-string MIDI in Guitar Pro order (string 1 = highest).
// The 6-string standard/drop presets step down chromatically E→D#→D→C#→C, each
// paired with its drop variant (lowest string dropped a further whole step) —
// the common metal/rock tuning ladder.
// `label` is shown inside an <optgroup> keyed by string count (see buildTuningOptions),
// so the instrument/count prefix lives on the group — options just name the variant.
export const TUNINGS = {
  bass4:   { label: "Standard (E A D G)",     tuning: [43, 38, 33, 28] },
  bass5:   { label: "Standard (B E A D G)",   tuning: [43, 38, 33, 28, 23] },
  guitar6: { label: "Standard (E A D G B E)", tuning: [64, 59, 55, 50, 45, 40] },
  guitar7: { label: "Standard (B E A D G B E)", tuning: [64, 59, 55, 50, 45, 40, 35] },
  ds_standard: { label: "D# Standard (D# G# C# F# A# D#)", tuning: [63, 58, 54, 49, 44, 39] },
  d_standard:  { label: "D Standard (D G C F A D)",        tuning: [62, 57, 53, 48, 43, 38] },
  cs_standard: { label: "C# Standard (C# F# B E G# C#)",   tuning: [61, 56, 52, 47, 42, 37] },
  c_standard:  { label: "C Standard (C F A# D# G C)",      tuning: [60, 55, 51, 46, 41, 36] },
  drop_d:  { label: "Drop D (D A D G B E)",         tuning: [64, 59, 55, 50, 45, 38] },
  drop_cs: { label: "Drop C# (C# G# C# F# A# D#)",  tuning: [63, 58, 54, 49, 44, 37] },
  drop_c:  { label: "Drop C (C G C F A D)",         tuning: [62, 57, 53, 48, 43, 36] },
  drop_b:  { label: "Drop B (B F# B E G# C#)",      tuning: [61, 56, 52, 47, 42, 35] },
  drop_as: { label: "Drop A# (A# F A# D# G C)",     tuning: [60, 55, 51, 46, 41, 34] },
};

// User-defined named tunings (typed as note strings, e.g. "G2 D2 A1 E1"),
// managed via the "Manage tunings…" option on the layer tuning select.
// Global + persisted, like keymap overrides — reusable across lanes/projects.
const LS = typeof localStorage !== "undefined" ? localStorage : null;   // Limitation: undefined under node test
const CUSTOM_TUNINGS_KEY = "cw.customTunings";
const loadCustomTunings = () => { try { return JSON.parse(LS && LS.getItem(CUSTOM_TUNINGS_KEY)) || []; } catch { return []; } };
const saveCustomTunings = () => { if (LS) LS.setItem(CUSTOM_TUNINGS_KEY, JSON.stringify(customTunings)); };
export let customTunings = loadCustomTunings();

export function addCustomTuning(name, notes) {
  const t = { id: "ct_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, notes };
  customTunings.push(t);
  saveCustomTunings();
  return t;
}
export function updateCustomTuning(id, patch) {
  const t = customTunings.find((c) => c.id === id);
  if (!t) return;
  Object.assign(t, patch);
  saveCustomTunings();
}
export function removeCustomTuning(id) {
  customTunings = customTunings.filter((t) => t.id !== id);
  saveCustomTunings();
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

// General-MIDI program for a lane's tone (the exported track's sound). A sound, so
// it comes off the tone and not off the neck.
function laneGm(lane) {
  if (Number.isFinite(lane.gmProgram)) return Math.max(0, Math.min(127, Math.round(lane.gmProgram)));
  return TONES[toneKey(lane.tone)].gm;
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
function tabLanes() {
  return editLanes().filter((lane) => isTablatureLane(lane) && lane.notes.length);
}

// Whole-lane voicing is pure CPU work. Cache completed position arrays by the
// lane object + edit revision, and run misses in the existing module worker so
// opening tablature never monopolizes the browser's main thread.
const laneVoicingCache = new WeakMap();

function laneVoicingKey(lane, tuning) {
  // The bar lines are part of the answer now — the voicer plans the hand a bar at a
  // time — and a meter-only grid edit changes them without touching a note, so it
  // never bumps voicingRevision. Keyed on the times themselves rather than a summary:
  // a tempo marker can move a bar without changing how many there are.
  return `${S.voicingRevision}:${tuning.join(",")}:${songBarStarts().join(",")}`;
}

const aborted = () => Object.assign(new Error("tablature generation cancelled"), { name: "AbortError" });

function voicedMap(notes, positions) {
  const voiced = new Map();
  positions.forEach((position, i) => { if (position && notes[i]) voiced.set(notes[i], position); });
  return voiced;
}

// Imported GP lanes already carry the authored string/fret. Keeping this path
// separate is the guardrail that prevents the MIDI-to-tab optimizer from
// silently rewriting the original transcription.
function exactVoicedMap(notes, laneName = "Imported track", stringCount = Infinity) {
  const voiced = new Map();
  for (const note of notes) {
    const string = Number(note.pos?.string), fret = Number(note.pos?.fret);
    if (!Number.isInteger(string) || string < 0 || string >= stringCount || !Number.isFinite(fret) || fret < 0)
      throw new Error(`${laneName} has a note without its original string/fret position`);
    voiced.set(note, { string, fret });
  }
  return voiced;
}

// Returns { voiced, fingers, seats }: the positions, and the hand that played them.
// The two extra maps are what the fretboard annotates the neck with — see
// voiceNotesFingered. They are absent on the exact-fingering path, where the
// positions are the transcriber's and there is no walk to have a hand.
async function voiceLaneAsync(lane, notes, tuning, signal) {
  const key = laneVoicingKey(lane, tuning);
  const cached = laneVoicingCache.get(lane);
  if (cached?.key === key && cached.positions.length === notes.length) return handedMap(notes, cached);
  if (signal?.aborted) throw aborted();

  // Headless callers and older embedded browsers retain the synchronous path.
  if (typeof Worker === "undefined") {
    const { voiced, fingers, seats } = voiceNotesFingered(notes, tuning, Infinity,
      { bars: songBarStarts(), instrument: lane.instrument,
        holds: lane.handHolds });
    const got = {
      positions: notes.map((note) => voiced.get(note) || null),
      fingers: notes.map((note) => fingers.get(note) ?? null),
      seats: notes.map((note) => seats.get(note) ?? null),
    };
    laneVoicingCache.set(lane, { key, ...got });
    return { voiced, fingers, seats };
  }

  const got = await new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL("./voicing-worker.js", import.meta.url), { type: "module" });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      fn(value);
    };
    const onAbort = () => finish(reject, aborted());
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (ev) => {
      if (ev.data.task !== "voice") return;
      finish(resolve, {
        positions: ev.data.positions || [],
        fingers: ev.data.fingers || [], seats: ev.data.seats || [],
      });
    };
    worker.onerror = () => finish(reject, new Error("automatic fingering worker failed"));
    worker.postMessage({ task: "voice", notes, tuning, bars: songBarStarts(),
      instrument: lane.instrument, holds: lane.handHolds });
  });
  if (signal?.aborted || laneVoicingKey(lane, tuning) !== key) throw aborted();
  laneVoicingCache.set(lane, { key, ...got });
  return handedMap(notes, got);
}

// The three index-aligned arrays back into maps on the caller's own note objects.
const handedMap = (notes, got) => ({
  voiced: voicedMap(notes, got.positions),
  fingers: new Map(notes.flatMap((note, i) => Number.isFinite(got.fingers?.[i]) ? [[note, got.fingers[i]]] : [])),
  seats: new Map(notes.flatMap((note, i) => Number.isFinite(got.seats?.[i]) ? [[note, got.seats[i]]] : [])),
});

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
    tracks: prepared.map(({ lane: l, exportNotes, voiced }) => {
      // The front-end is the source of truth for fingering: voice the lane here
      // and ship string+fret per note so the export matches the preview exactly.
      // string is 1-based GP order (string 1 = highest open), as the backend wants.
      const tuning = laneTuning(l);
      return {
        id: l.id,
        name: l.name,
        ...normalizedLaneFields(l),
        instrument: laneGm(l),
        tuning,
        notes: representPickedOpenSlides(exportNotes.map((n) => {
          const pos = voiced.get(n);
          return copyEffects(n, {
            start: n.start, end: n.end, pitch: n.pitch,
            string: pos ? pos.string + 1 : null, fret: pos ? pos.fret : null,
            ...(n.shapeId ? { shapeId: n.shapeId } : {}),
          });
        }), (note) => note),
      };
    }),
  };
}

// One lane's fingering: its tuning, its arranged notes, and the string/fret each
// one lands on. The two paths — an imported lane's authored positions and the
// optimizer's — are chosen here so every consumer gets the same answer.
//
// The fretboard view calls this too, which is the point of it being one function:
// what the neck shows a player and what the .gp5 contains are the same fingering,
// out of the same worker and the same cache.
export async function laneFingering(lane, signal) {
  const tuning = laneTuning(lane), notes = arrangedNotes(lane.notes);
  // An exact lane's positions are the transcriber's own, so there is no walk behind
  // them and no hand to report; the board falls back to reading a fingering off each
  // shape, which is all anyone can do for positions nobody's hand chose.
  const found = lane.fingeringMode === "exact"
    ? { voiced: exactVoicedMap(notes, lane.name, tuning.length), fingers: null, seats: null }
    : await voiceLaneAsync(lane, notes, tuning, signal);
  alignReferences(lane, notes, found);
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
  if (!groups || lane.fingeringMode === "exact") return;
  const { voiced, fingers, seats } = found;
  const minIn = minDur();
  for (const key of Object.keys(groups)) {
    const occurrences = refOccurrences(groups[key], notes, minIn);
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
    const { notes: exportNotes, voiced } = await laneFingering(lane, signal);
    return { lane, exportNotes, voiced };
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
    tabWarnEl.textContent = "building selected note layer…";
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
    tabWarnEl.textContent = warnings.length ? "⚠ " + warnings.join(" · ") : "";
  } catch (e) {
    tabLoadGuard = null;
    if (e?.name !== "AbortError") tabWarnEl.textContent = "error: " + e.message;
  } finally {
    if (tabBuildController === controller) tabBuildController = null;
  }
}

// Build and download the .gp5 immediately, without opening the tab view.
export async function exportTab() {
  if (!S.state) return;
  try {
    const spec = await buildTabSpecAsync();
    if (!spec.tracks.length) { toast("No tablature notes to export"); return; }
    const res = await fetch("/api/tab", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "tab build failed");
    const buf = await res.arrayBuffer();
    // The warning header is advisory; a malformed one must not fail the export
    // the user is already downloading.
    let warns = []; try { warns = JSON.parse(res.headers.get("X-Tab-Warnings") || "[]"); } catch { /* advisory only */ }
    const name = (S.state.name || S.state.filename || "tab").replace(/[^A-Za-z0-9._ -]+/g, "_");
    downloadProjectBlob(new Blob([buf], { type: "application/octet-stream" }), name + ".gp5");
    toast(warns.length ? `Exported ${name}.gp5 · ${warns.length} warning${warns.length === 1 ? "" : "s"}` : `Exported ${name}.gp5`,
          2200, warns.length ? "warn" : "ok");
  } catch (e) {
    toast("Export failed: " + e.message, 2200, "error");
  }
}

// Modern GP7+ export starts from the selected source hierarchy and applies the
// editor projection through the same alphaTab Score used by the app preview.
export async function exportModernGp() {
  if (!S.state) return;
  const status = modernGpProjectionStatus();
  if (!status.available || !status.exportable) { toast(status.reason, 4200); return; }
  try {
    await loadAlphaTab();
    const { bytes, warnings } = await modernGpResult(alphaTab);
    const meta = metadataFromState(S.state);
    const name = exportSongName(meta, S.state.name || S.state.filename || "score");
    downloadProjectBlob(new Blob([bytes], { type: "application/octet-stream" }), name + ".gp");
    toast(warnings.length ? `Exported ${name}.gp · ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : `Exported ${name}.gp`,
          2200, warnings.length ? "warn" : "ok");
  } catch (e) {
    toast("Modern Guitar Pro export failed: " + e.message, 4500, "error");
  }
}

export function init_tablature() {
  tabViewCloseEl?.addEventListener("click", () => setView("spec"));
  // Click-away on the scrim closes it, like every other window over the editor.
  tabViewBackdropEl?.addEventListener("mousedown", (event) => {
    if (event.target === tabViewBackdropEl) setView("spec");
  });
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
