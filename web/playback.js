// In-editor playback: a Tone.js sampler voice per edit lane, the transport + seek,
// the metronome, and the per-stem mixer.

import { LOOKAHEAD, MAX_METRONOME_BEATS, TONES, toneKey } from "./constants.js";
import { audio, editorEl, metroOn, playBtn, scroll, seek, speedSel, timeEl } from "./dom.js";
import { draw, drawNow } from "./repaint.js";
import { gridSegments, segBeatSec } from "./grid.js";
import { applyLaneVolume, disposeLaneSynth, editLanes, releaseLaneSynth, targetLane } from "./lanes.js";
import { refreshSaveState, renderStemTabs } from "./project.js";
import { S } from "./store.js";
import { clamp, fmtTime, followerTrim, normLayerVolume, onsetSec, playheadScrollLeft, schedWindow } from "./util.js";
import { viewportMoving } from "./viewport-motion.js";

export let scheduled = new Set();   // notes scheduled in the current play cycle

export let scheduledBeats = new Set(); // metronome beat indices scheduled this cycle

function hasAudioTransport() { return !!S.state?.stems?.length; }

export function transportPlaying() {
  return hasAudioTransport() ? !audio.paused : !!S.scorePlaying;
}

function scorePauseCleanup() {
  cancelPassagePreview(); clearPreview();
  playBtn.innerHTML = PLAY_ICON; playBtn.title = "Play (Space)";
  if (S.state) for (const lane of S.state.lanes) releaseLaneSynth(lane);
  setSynthsMuted(true);
}

export function pauseTransport() {
  if (hasAudioTransport()) { audio.pause(); return; }
  if (!S.scorePlaying) return;
  S.scoreTime = playbackTime(); S.scorePlaying = false;
  scorePauseCleanup();
  window.dispatchEvent(new CustomEvent("cw-transport", { detail: "pause" }));
}

export function playTransport() {
  if (!S.state) return Promise.resolve();
  if (hasAudioTransport()) return audio.play();
  if (S.scorePlaying) return Promise.resolve();
  const duration = Number(S.state.duration) || 0;
  if ((S.scoreTime || 0) >= duration) S.scoreTime = 0;
  S.scoreAnchorSong = S.scoreTime || 0; S.scoreAnchorClock = performance.now() / 1000; S.scorePlaying = true;
  playBtn.innerHTML = PAUSE_ICON; playBtn.title = "Pause (Space)";
  setSynthsMuted(false); resetSchedule(); tick();
  window.dispatchEvent(new CustomEvent("cw-transport", { detail: "play" }));
  return Promise.resolve();
}

// Where the next scheduling window starts (song s). Each pass hands its horizon to
// the next (see schedWindow), so a tick that stalls past the lookahead (a long
// main-thread task still delays the worker's message) doesn't drop the notes
// that fell in the gap.
let notesFrom = 0, metroFrom = 0;

// Scheduling window size. Foreground: small — notes handed to Tone can't be
// recalled (see setSynthsMuted), so a seek/speed change strands at most this
// much stale audio. Hidden tab: no interaction can happen, so trade that for a
// window big enough to ride out browser timer throttling (~1s clamps).
const lookahead = () => (document.hidden ? 1.5 : LOOKAHEAD);

// ---- synth playback (edit lanes only) ----
function laneSynth(lane) {
  if (!window.Tone) return null;
  if (lane._synth) return lane._synth;
  // The voice follows the lane's tone, not its instrument: the neck decides what is
  // fretted and the tone decides what is heard. A legacy silent layer (instrument
  // "none") arrives from the loader muted, so there is no third state here.
  const def = TONES[toneKey(lane.tone)];
  if (!def.make) return null;
  lane._synth = def.make();   // factories self-connect to the destination
  applyLaneVolume(lane);
  return lane._synth;
}

export function disposeSynths() {
  if (!S.state) return;
  for (const l of S.state.editLanes) disposeLaneSynth(l);
}

// Eagerly build the open edit lanes' voices so the sample mp3s start downloading
// before the first play (sampled guitars are silent until loaded). Safe before
// Tone.start(): buffers fetch even while the audio context is still suspended.
export function warmSynths() {
  if (!window.Tone || !S.state) return;
  for (const l of S.state.editLanes) laneSynth(l);
}

// Mute / unmute every voice (lanes + metronome) at the output. Used on pause:
// notes already scheduled inside the LOOKAHEAD window can't be unscheduled —
// Tone drops the source handle on triggerAttackRelease, so the pause-time
// releaseAll() has nothing left to stop — so they'd still sound after the
// playhead stopped. Muting the voices makes those orphans (and any held note we
// just cut) inaudible until playback resumes. previewNotes lifts the mute, since
// auditioning is an explicit request for sound.
function setSynthsMuted(muted) {
  if (!S.state) return;
  for (const l of S.state.lanes) {
    if (!l._synth || !l._synth.volume) continue;
    if (muted) { try { l._synth.volume.value = -Infinity; } catch { /* ignore */ } }
    else applyLaneVolume(l);
  }
  if (S.metro && S.metro.volume) { try { S.metro.volume.value = muted ? -Infinity : -4; } catch { /* ignore */ } }
}

// Play the currently-dragged notes through their lane synth so you hear the
// pitch under the cursor while moving. Called once per row crossing. A
// multi-note selection plays back as a little phrase — each note offset by its
// real spacing relative to the earliest one — so you preview the rhythm/melody,
// not a blunt chord. clearPreview + releaseAll drop the prior pass so fast
// vertical scrubbing restarts cleanly instead of piling up.
export let previewTimers = [];

export let passagePreviewToken = 0;

export function clearPreview() {
  for (const t of previewTimers) clearTimeout(t);
  previewTimers = [];
}

export function cancelPassagePreview(opts = {}) {
  passagePreviewToken++;
  if (S.passagePreviewTimer) clearTimeout(S.passagePreviewTimer);
  const hadPreview = S.passagePreviewActive || !!S.passagePreviewTimer;
  S.passagePreviewTimer = 0;
  S.passagePreviewActive = false;
  if (opts.pauseAudio && hadPreview && audio && !audio.paused) audio.pause();
}

export function previewNotes(notes, lane) {
  if (!window.Tone || !S.toneReady) return;
  const synth = laneSynth(lane);
  if (!synth) return;
  setSynthsMuted(false); // auditioning is an explicit request for sound — lift any pause mute
  clearPreview();
  try { synth.releaseAll(); } catch { /* ignore */ }
  // Earliest-first, capped so a huge selection can't schedule a runaway swarm.
  const playable = [...notes].sort((a, b) => a.start - b.start).slice(0, 64);
  if (!playable.length) return;
  const t0 = playable[0].start;
  const fire = (p, dur) => {
    try { synth.triggerAttackRelease(Tone.Frequency(p, "midi").toNote(), dur, undefined, 0.7); }
    catch { /* ignore */ }
  };
  for (const n of playable) {
    const dur = Math.max(0.05, n.end - n.start);
    const delayMs = Math.max(0, (n.start - t0) * 1000);
    if (delayMs < 1) fire(n.pitch, dur);
    else previewTimers.push(setTimeout(() => fire(n.pitch, dur), delayMs));
  }
}

// Play a single note's pitch the moment you click/select it, so you can confirm
// by ear what you're about to edit — not only while dragging. Falls back to the
// active/first lane's voice if none is passed. ensureTone() resolves once audio
// is unlocked on this gesture.
export function auditionNote(note, lane) {
  const voiceLane = lane || targetLane();
  if (!voiceLane) return;
  ensureTone().then(() => previewNotes([note], voiceLane));
}

// Raw AudioContext clock (NO Tone lookAhead) — this is what audio.currentTime
// maps onto, so notes fire exactly when the playhead crosses them.
export const ctxNow = () => (window.Tone ? Tone.getContext().currentTime : 0);

export const rate = () => audio.playbackRate || 1;

// ---- the playback clock ----
// audio.currentTime is authoritative but unusable raw: it advances in coarse,
// jittery steps (worse on slow machines) and sits frozen through the decode/
// output spin-up after play()/seek. So the schedulers and the playhead read a
// smooth estimate instead — song position as a linear map of the audio-context
// clock (anchorSong + (ctxNow − anchorCtx) · rate) — and updateClock() servos
// that map toward the media clock a few ms per scheduler tick. Two rules keep it honest:
//   arm  — after play/seek/rate-change, don't anchor until currentTime actually
//          moves; that's the moment sound is truly flowing, so synths can't
//          lead the stems by the spin-up gap.
//   slew — ongoing error (time-stretch drift at speed ≠ 1, decoder wander) is
//          smoothed (EMA) and bled off capped at 3ms/tick; never snapped, so
//          the pin stays visually still and note timing can't jitter.
let clockArmed = false;  // waiting for the media clock to move before anchoring
let armSong = 0;         // currentTime snapshot taken when armed
let clockErr = 0;        // EMA of (media clock − estimate), s

function updateClock() {
  if (!window.Tone || !hasAudioTransport()) return;
  const ct = audio.currentTime;
  if (clockArmed) {
    if (ct !== armSong) {
      S.anchorCtx = ctxNow(); S.anchorSong = ct; clockArmed = false; clockErr = 0;
      // Master just truly started flowing — re-align the followers to it now, so
      // the spin-up delta between the elements can't linger as a steady flam.
      syncFollowerTimes();
    }
    return;
  }
  const err = ct - (S.anchorSong + (ctxNow() - S.anchorCtx) * rate());
  if (Math.abs(err) > 0.3) { clockArmed = true; armSong = ct; return; } // gross jump (media stall): re-lock
  clockErr = clockErr * 0.85 + err * 0.15;
  const step = Math.max(-0.003, Math.min(0.003, clockErr * 0.1));
  S.anchorSong += step; clockErr -= step;
}

function resetSchedule() {
  scheduled.clear();
  scheduledBeats.clear();
  const current = playbackTime();
  notesFrom = metroFrom = current;
  clearPreview(); // drop any pending drag-preview notes so they don't leak into playback
  if (hasAudioTransport()) {
    clockArmed = true; armSong = audio.currentTime; clockErr = 0;
  } else {
    clockArmed = false; S.anchorSong = current; S.anchorCtx = ctxNow(); clockErr = 0;
  }
  if (S.state) for (const l of S.state.lanes) releaseLaneSynth(l);
}

function metroSynth() {
  if (!window.Tone) return null;
  if (S.metro) return S.metro;
  S.metro = new Tone.MembraneSynth({
    pitchDecay: 0.006, octaves: 1.5,
    envelope: { attack: 0.001, decay: 0.1, sustain: 0, release: 0.02 },
  }).toDestination();
  S.metro.volume.value = -4;
  return S.metro;
}

function scheduleMetro() {
  if (clockArmed) return; // no valid clock to schedule against yet
  // Tight grace: a late click is worse than a missed one — it lands off the grid.
  const [from, horizon] = schedWindow(metroFrom, playbackTime(), lookahead(), 0.05);
  metroFrom = horizon;   // advance even while the metronome is off, so enabling it mid-play can't backfire old beats
  if (!window.Tone || !S.state || !metroOn.checked) return;
  const segs = gridSegments();
  if (!segs[0].bpm) return;
  const synth = metroSynth();
  if (!synth) return;
  // Walk each tempo/meter segment's beats within the schedule window; beats are
  // keyed by rounded time (not a global index, which isn't uniform across
  // segments) so dedupe survives a tempo change. Each segment restarts its bar
  // count at its marker, so the downbeat accents track the local meter.
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si], beatDur = segBeatSec(seg);
    if (!beatDur) continue;
    const segEnd = si + 1 < segs.length ? segs[si + 1].t : horizon + beatDur;
    const bpb = parseInt(seg.tsNum, 10) || 4;
    for (let b = Math.max(0, Math.ceil((Math.max(from, seg.t) - seg.t) / beatDur - 1e-9)), guard = 0; guard < MAX_METRONOME_BEATS; guard++, b++) {
      const bt = seg.t + b * beatDur;
      if (bt >= horizon || bt >= segEnd - 1e-9) break;
      if (bt < from) continue;
      const key = Math.round(bt * 1000);
      if (scheduledBeats.has(key)) continue;
      scheduledBeats.add(key);
      const accent = b % bpb === 0;
      const when = Math.max(S.anchorCtx + (bt - S.anchorSong) / rate(), ctxNow());
      try { synth.triggerAttackRelease(accent ? "C5" : "G4", "32n", when, accent ? 1 : 0.55); } catch { /* ignore */ }
    }
  }
}

// A sampled voice's heard attack lags its trigger by the leading silence baked
// into its files (mp3 encoder padding + the recording's pre-attack). Measured
// once per voice from the decoded buffers — median first −40dB crossing — and
// scheduleNotes pre-fires by it so the attack lands on the note. Measuring the
// decoded data (not the files) stays correct whatever the browser's decoder
// strips.
function synthOnset(synth) {
  if (synth.onsetSec === undefined) {
    if (!synth.loaded || !synth._buffers) return 0; // buffers still fetching — measure on a later tick
    try {
      const on = [];
      synth._buffers._buffers.forEach((b) => on.push(onsetSec(b.getChannelData(0), b.sampleRate)));
      on.sort((a, b) => a - b);
      synth.onsetSec = on.length ? on[on.length >> 1] : 0;
    } catch { synth.onsetSec = 0; } // Limitation: reads private Tone internals — on breakage, no compensation
  }
  return synth.onsetSec;
}

function scheduleNotes() {
  if (!window.Tone || !S.state || clockArmed) return;
  const [from, horizon] = schedWindow(notesFrom, playbackTime(), lookahead());
  notesFrom = horizon;   // advance during passage previews too — their notes are meant to be skipped, not queued
  if (S.passagePreviewActive) return; // similar-passage previews audition the stem slice only
  for (const lane of editLanes()) {
    // Per-lane control: mute the lane, or drop its volume to zero.
    if (lane.muted || normLayerVolume(lane.volume) <= 0) continue;
    const synth = laneSynth(lane);
    if (!synth) continue;
    const onset = synthOnset(synth); // real output-path seconds (samples play at 1×), so not divided by rate
    for (const n of lane.notes) {
      if (n.start >= from && n.start < horizon && !scheduled.has(n)) {
        scheduled.add(n);
        const r = rate();
        const when = Math.max(S.anchorCtx + (n.start - S.anchorSong) / r - onset, ctxNow());
        try {
          synth.triggerAttackRelease(
            Tone.Frequency(n.pitch, "midi").toNote(), Math.max(0.05, (n.end - n.start) / r), when);
        } catch { /* ignore */ }
      }
    }
  }
}

export async function ensureTone() {
  if (!window.Tone) return;
  if (!S.toneReady) { try { await Tone.start(); S.toneReady = true; } catch { return; } }
  // Route the backing <audio> through the SAME audio context as the synths, so
  // the track and the synth share one output path/clock — they stay matched
  // without any manual latency compensation. (createMediaElementSource can only
  // be called once per element, hence the guard.)
  if (!S.mediaNode) {
    try {
      const ctx = Tone.getContext().rawContext;
      S.mediaNode = ctx.createMediaElementSource(audio);
      S.mediaNode.connect(ctx.destination);
    } catch { S.mediaNode = "skip"; }
  }
  ensureStemMixer();
}

// ---- stem mixer ----
// The full song (stem 0) is the master: its element (#audio) is the clock and the
// transport everything else reads. Each *separated* stem plays through its own
// slaved <audio> "follower" routed via a GainNode, so several stems can sound at
// once (guitar + bass, no vocals…). Media elements — not buffer sources — so the
// pitch-preserving Speed control keeps working; followers are nudged back onto the
// master's time in tick() to fight decoder drift.
export const stemNodes = new Map();      // stem.id -> { el, src, gain }  (master excluded)

export let masterGain = null;

export const masterStem = () => (S.state && S.state.stems[0]) || null;

export const isMasterStem = (stem) => { const m = masterStem(); return !!m && stem.id === m.id; };

export const separatedStems = () => (S.state ? S.state.stems.filter((stem) => !isMasterStem(stem)) : []);

export const masterStemAudible = () => {
  const m = masterStem();
  return !!m && !m.muted;
};

export function resetStemMixer() {
  // Tearing down media elements: any of them may already be detached.
  for (const { el } of stemNodes.values()) { try { el.pause(); el.src = ""; } catch { /* already detached */ } }
  stemNodes.clear();
}

// A stem's audio was replaced/recreated in place (same id, new bytes on disk) —
// point its already-built element at the fresh (cache-busted) URL instead of
// waiting for ensureStemMixer, which skips ids it already has a node for.
export function refreshStemAudio(stem, url) {
  stem.audioUrl = url;
  if (isMasterStem(stem)) {
    const wasPlaying = !audio.paused;
    audio.pause(); audio.src = url; audio.load();
    if (wasPlaying) audio.play().catch(() => {});
  } else {
    const node = stemNodes.get(stem.id);
    if (node) { node.el.pause(); node.el.src = url; node.el.load(); }
  }
}

export function ensureStemMixer() {
  if (!S.toneReady || !S.state || !S.mediaNode || S.mediaNode === "skip") return;
  const ctx = Tone.getContext().rawContext;
  // Re-route the master through a gain we control (ensureTone wired it straight to
  // the destination — splice mediaNode -> masterGain -> destination once).
  if (!masterGain) {
    try {
      S.mediaNode.disconnect();
      masterGain = ctx.createGain();
      S.mediaNode.connect(masterGain); masterGain.connect(ctx.destination);
    } catch { /* leave master on its direct connection */ }
  }
  for (const stem of S.state.stems) {
    if (isMasterStem(stem) || stemNodes.has(stem.id)) continue;
    const el = new Audio();
    el.src = stem.audioUrl; el.preload = "auto"; el.playbackRate = audio.playbackRate;
    el.preservesPitch = true; if ("webkitPreservesPitch" in el) el.webkitPreservesPitch = true;
    let src = null, gain = null;
    try {
      src = ctx.createMediaElementSource(el);
      gain = ctx.createGain();
      src.connect(gain); gain.connect(ctx.destination);
    } catch { /* fall back to element.muted below */ }
    stemNodes.set(stem.id, { el, src, gain });
  }
  applyStemGains();
}

// Full song is the default audible source. When it is muted, separated stems
// solo restricts the audible group, but mute always silences its own stem.
function stemAudible(stem) {
  if (isMasterStem(stem)) return !stem.muted;
  if (masterStemAudible()) return false;
  const soloed = separatedStems().some((s) => s.solo);
  return !stem.muted && (!soloed || !!stem.solo);
}

export function applyStemGains() {
  if (!S.state) return;
  for (const stem of S.state.stems) {
    const on = stemAudible(stem);
    if (isMasterStem(stem)) {
      if (masterGain) {
        audio.muted = false;
        masterGain.gain.value = on ? 1 : 0;
      } else {
        audio.muted = !on;
      }
    } else {
      const node = stemNodes.get(stem.id);
      if (!node) continue;
      if (node.gain) {
        node.el.muted = false;
        node.gain.gain.value = on ? 1 : 0;
      } else {
        node.el.muted = !on;
      }
    }
  }
}

function startFollowers() {
  for (const f of stemNodes.values()) {
    // .catch too: try/catch misses the async rejection when a pause interrupts play().
    // Follower resync is best-effort per element: seeking a stem that has not
    // loaded yet throws, and it will be resynced on the next tick anyway.
    try { f.err = 0; f.trim = 0; f.el.currentTime = audio.currentTime; f.el.playbackRate = audio.playbackRate; f.el.play().catch(() => {}); } catch { /* not ready; next tick retries */ }
  }
}

function pauseFollowers() { for (const { el } of stemNodes.values()) { try { el.pause(); } catch { /* not ready */ } } }

function syncFollowerTimes() { for (const f of stemNodes.values()) { try { f.err = 0; f.el.currentTime = audio.currentTime; } catch { /* not ready */ } } }

function syncFollowerRate() { for (const f of stemNodes.values()) { try { f.trim = 0; f.el.playbackRate = audio.playbackRate; } catch { /* not ready */ } } }

// Keep the follower stems locked to the master. The raw error is smoothed first;
// real drift then engages a small fixed vari-speed trim (see followerTrim) that
// reels the stem in and disengages near zero — playbackRate is only written when
// the trim state changes, never per frame.
// The old scheme let stems sit up to 80ms apart (an audible flam), then hard-seeked:
// a glitch that landed late by its own seek latency — the "slightly off… now it's
// fine again" feel. A hard seek remains only for gross drift.
function resyncFollowers() {
  if (audio.paused || clockArmed) return; // master still spinning up — nothing meaningful to compare
  const mt = audio.currentTime, r = audio.playbackRate;
  for (const f of stemNodes.values()) {
    try {
      const raw = f.el.currentTime - mt;   // >0: follower runs ahead of the master
      f.err = (f.err || 0) * 0.8 + raw * 0.2;
      if (Math.abs(f.err) > 0.25) { f.el.currentTime = mt; f.el.playbackRate = r; f.err = 0; f.trim = 0; continue; }
      const trim = followerTrim(f.err, f.trim || 0);
      if (trim !== f.trim) { f.trim = trim; f.el.playbackRate = r * (1 + trim); }
    } catch { /* element not ready; the next resync corrects it */ }
  }
}

export function toggleStemSolo(stem) {
  if (!S.state || !stem || isMasterStem(stem)) return;
  const master = masterStem();
  if (master) master.muted = true;
  stem.solo = !stem.solo;
  applyStemGains(); renderStemTabs(); refreshSaveState();
}

export function togglePlay() {
  if (!S.state) return;
  cancelPassagePreview();
  // .catch: a pause landing before play() resolves rejects the promise (harmless).
  if (transportPlaying()) pauseTransport(); else playTransport().catch(() => {});
}

// Slow-down / speed-up, preserving pitch (so the key doesn't change by ear).
export function applyPreservePitch() {
  audio.preservesPitch = true;
  if ("webkitPreservesPitch" in audio) audio.webkitPreservesPitch = true;
}

// Smooth, ear-aligned playback position. While playing through the audio
// context we use its high-resolution clock (audio.currentTime only updates in
// coarse steps -> choppy) and subtract the output latency so the line sits
// where the sound actually is, not where the decoder is. Paused/scrubbing
// falls back to the element's reported time.
export function playbackTime() {
  if (S.state && !hasAudioTransport()) {
    const elapsed = S.scorePlaying ? (performance.now() / 1000 - (S.scoreAnchorClock || 0)) * rate() : 0;
    const base = (S.scorePlaying ? S.scoreAnchorSong : S.scoreTime) || 0;
    return clamp(base + elapsed, 0, Number(S.state.duration) || 0);
  }
  if (S.state && !audio.paused && !clockArmed && S.toneReady && S.mediaNode && S.mediaNode !== "skip") {
    const raw = Tone.getContext().rawContext;
    const lat = raw.outputLatency || raw.baseLatency || 0;
    const r = rate();
    const heard = S.anchorSong + (ctxNow() - S.anchorCtx - lat) * r;
    return Math.max(0, Math.min(S.state.duration, heard));
  }
  return audio ? audio.currentTime : 0;
}

// One transport seek path for the spectrogram, overview, hidden range control,
// and alphaTab. Updating the readout and scheduler here prevents a view-specific
// cursor from moving while the actual playback clock remains somewhere else.
export function seekPlayback(t) {
  const fallback = Number.isFinite(t) ? Math.max(0, t) : 0;
  const limit = S.state?.duration || (Number.isFinite(audio.duration) ? audio.duration : fallback);
  const next = clamp(fallback, 0, Math.max(0, limit));
  if (!hasAudioTransport()) {
    S.scoreTime = next; S.scoreAnchorSong = next; S.scoreAnchorClock = performance.now() / 1000;
    if (S.state?.duration) seek.value = Math.round((next / S.state.duration) * 1000);
    timeEl.textContent = `${fmtTime(next)} / ${fmtTime(S.state?.duration || 0)}`;
    if (S.scorePlaying) resetSchedule();
    window.dispatchEvent(new CustomEvent("cw-transport", { detail: "seek" }));
    draw(); return next;
  }
  try { audio.currentTime = next; } catch { return audio.currentTime || 0; }
  if (audio.duration) seek.value = Math.round((next / audio.duration) * 1000);
  timeEl.textContent = `${fmtTime(next)} / ${fmtTime(audio.duration || S.state?.duration || 0)}`;
  if (!audio.paused) resetSchedule();
  draw();
  return next;
}

// Reveal the authoritative transport position in the spectrogram. View switches
// center it; continuous playback retains the familiar left-side lead-in.
export function revealPlaybackPosition({ center = false, redraw = true } = {}) {
  if (viewportMoving() || S.mmSeeking || S.mmDragging) return;
  if (!S.state || !scroll.clientWidth) return;
  scroll.scrollLeft = playheadScrollLeft(
    playbackTime(), S.pxPerSec, scroll.clientWidth, scroll.scrollWidth,
    scroll.scrollLeft, center,
  );
  if (redraw) draw();
}

// The audio-critical pass: clock servo, note + metronome scheduling, follower
// resync. It must NOT ride rAF — hidden tabs freeze rAF outright and heavy
// paints (zooming) starve it, which silenced/desynced the synth notes while the
// stems (fire-and-forget media elements) played on. A worker's setInterval is
// exempt from both, so this runs a steady ~20Hz whatever the page is doing.
function schedulerTick() {
  if (!S.state || !transportPlaying()) return;
  updateClock();
  scheduleNotes();
  scheduleMetro();
  resyncFollowers();
}

let schedWorker = null; // module-level ref: an unreferenced Worker may be GC'd (= terminated)
let schedTimer = 0;     // ...and the fallback timer's id, for the same reason: without
                        // a handle it can never be cleared, and a second startScheduler()
                        // would leave two tickers running for the life of the page.

function startScheduler() {
  stopScheduler();
  try {
    schedWorker = new Worker(URL.createObjectURL(new Blob(["setInterval(()=>postMessage(0),50)"], { type: "text/javascript" })));
    schedWorker.onmessage = schedulerTick;
  } catch {
    // Limitation: blob workers blocked (CSP) → main-thread timer. Hidden tabs then
    // tick at ~1Hz, which the 1.5s hidden lookahead still covers.
    schedTimer = setInterval(schedulerTick, 50);
  }
}

function stopScheduler() {
  if (schedWorker) { schedWorker.terminate(); schedWorker = null; }
  if (schedTimer) { clearInterval(schedTimer); schedTimer = 0; }
}

// The render loop: playhead readout, seek slider, canvas, follow-scroll. Purely
// visual, so rAF throttling/freezing is fine here.
function tick() {
  if (!S.state) return;
  const ct = playbackTime();
  const duration = Number(S.state.duration) || Number(audio.duration) || 0;
  timeEl.textContent = `${fmtTime(ct)} / ${fmtTime(duration)}`;
  // :active = the thumb is being dragged — don't yank it back between input events.
  if (duration && !seek.matches(":active")) seek.value = Math.round((ct / duration) * 1000);
  // The hidden spectrogram has a zero-width viewport. Drawing/layouting it while
  // tablature is active used to shrink and clear its backing canvas, producing a
  // black frame when switching back.
  if (!editorEl.hidden) {
    drawNow();
    revealPlaybackPosition({ redraw: false });
  }
  if (!hasAudioTransport() && S.scorePlaying && ct >= duration) pauseTransport();
  else if (transportPlaying()) requestAnimationFrame(tick);
}

// Filled monochrome glyphs (design §7: play = filled triangle, no stroke).
const PLAY_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
const PAUSE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`;

export function init_playback() {
  startScheduler();
  playBtn.addEventListener("click", async () => { await ensureTone(); togglePlay(); });
  audio.addEventListener("play", () => { playBtn.innerHTML = PAUSE_ICON; playBtn.title = "Pause (Space)"; setSynthsMuted(false); ensureStemMixer(); startFollowers(); resetSchedule(); tick(); });
  audio.addEventListener("pause", () => {
    cancelPassagePreview();
    clearPreview();
    pauseFollowers();
    playBtn.innerHTML = PLAY_ICON; playBtn.title = "Play (Space)";
    if (S.state) for (const l of S.state.lanes) releaseLaneSynth(l);
    setSynthsMuted(true); // silence notes already scheduled in the LOOKAHEAD window (releaseAll can't recall them)
  });
  audio.addEventListener("seeked", () => {
    syncFollowerTimes();
    if (!audio.paused) resetSchedule();
    timeEl.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration)}`;   // paused seeks update the readout too
    draw();
  });
  audio.addEventListener("loadedmetadata", () => { timeEl.textContent = `0:00 / ${fmtTime(audio.duration)}`; });
  seek.addEventListener("input", () => {
    const duration = Number(S.state?.duration) || Number(audio.duration) || 0;
    if (duration) seekPlayback((seek.value / 1000) * duration);
  });
  speedSel.addEventListener("change", () => {
    const scoreTime = !hasAudioTransport() ? playbackTime() : 0;
    audio.playbackRate = parseFloat(speedSel.value) || 1;
    applyPreservePitch();
    syncFollowerRate();
    if (!hasAudioTransport()) seekPlayback(scoreTime);
    if (transportPlaying()) resetSchedule(); // re-anchor + reschedule synth/metro at the new rate
  });
  applyPreservePitch();
}
