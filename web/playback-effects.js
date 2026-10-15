// Sample articulations. Times remain in song seconds until the audio scheduler.
import { noteOffsetAt, slideTargets, trillOffsetAt } from "./bend.js";

import { whammyAt } from "./whammy.js";

const interval = (v) => v === "whole" ? 2 : v === "half" ? 1 : 0;
export function articulation(n) {
  const fx = n.fx || {};
  let velocity = fx.accent ? 1 : 0.72;
  if (fx.ghost) velocity *= 0.35;
  if (fx.hammer || n.slap === "tap") velocity *= 0.75;
  if (n.slap === "slap") velocity = 0.95;
  if (n.slap === "pop") velocity = 1;
  return { velocity, release: fx.dead ? 0.012 : fx.palmMute ? 0.035 : fx.staccato ? 0.025 : 0.15,
    attack: fx.hammer || n.slap === "tap" ? 0.012 : 0,
    filter: fx.dead ? ["bandpass", 1200, 0.5] : fx.palmMute ? ["lowpass", 900, 0.7]
      : n.harmonic ? ["bandpass", 0, 5] : n.slap === "slap" || n.slap === "pop" ? ["highpass", 650, 0.7] : null };
}

// Natural harmonics use the touched fret's node. At the octave fret the heard
// pitch is already the written pitch; a pinch is approximated by its octave.
export function harmonicOffset(n) {
  if (n.harmonic === "pinch") return 12;
  if (n.harmonic !== "natural") return 0;
  const fret = n.pos?.fret;
  const partial = { 3: 7, 4: 5, 5: 4, 7: 3, 9: 5, 12: 2, 16: 5, 19: 3, 24: 4 }[fret];
  return partial ? 12 * Math.log2(partial) - fret : 0;
}

export function eventOffsetAt(event, sec) {
  const t = event.start + sec;
  const seg = event.segments.find((s) => t < s.end - 1e-8) || event.segments.at(-1);
  const n = seg.note, local = Math.max(0, t - n.start), own = n.end - n.start;
  const u = own > 0 ? Math.min(1, local / own) : 0;
  const whammy = whammyAt(n.whammy, u);
  const trill = trillOffsetAt(n, local, seg.bpm);
  return n.pitch - event.pitch + harmonicOffset(n) + whammy + trill
    + noteOffsetAt(n, local, own, seg.slide);
}

export function playbackEvents(notes, bpmAt = () => 120, songEnd = Infinity) {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const slides = slideTargets(sorted), into = new Map(), onward = new Map();
  const columns = [], columnOf = new Map(), nextSame = new Map(), future = new Map();
  for (const n of sorted) {
    if (!columns.length || n.start - columns.at(-1)[0].start >= 1e-4) columns.push([]);
    const column = columns.at(-1);
    column.push(n); columnOf.set(n, column);
  }
  const voice = (n) => n.pos?.string != null ? `s${n.pos.string}` : `p${n.pitch}`;
  for (let i = columns.length - 1; i >= 0; i--) {
    for (const n of columns[i]) nextSame.set(n, future.get(voice(n)));
    for (const n of columns[i]) future.set(voice(n), n);
  }
  for (const n of sorted) {
    let target = n.slide === "legato" ? slides.get(n) : null;
    const next = nextSame.get(n);
    if (!target && next?.fx?.hammer && Math.abs(next.start - n.end) < 0.03) target = next;
    if (target && !into.has(target)) { onward.set(n, target); into.set(target, n); }
  }
  const events = [];
  for (const n of sorted) {
    if (into.has(n)) continue;
    const segments = [];
    let cur = n;
    do {
      const bpm = Math.max(1, bpmAt(cur.start) || 120), target = slides.get(cur);
      segments.push({ note: cur, end: cur.end, bpm,
        slide: { to: target ? target.pitch - cur.pitch : 0, eighth: 30 / bpm } });
      cur = onward.get(cur);
    } while (cur && segments.length < sorted.length);
    const last = segments.at(-1), fx = n.fx || {};
    let end = last.end;
    if (fx.letRing) {
      const next = nextSame.get(last.note);
      end = Math.min(next?.start ?? end + 2, songEnd);
      last.end = end;
    }
    let duration = Math.max(0.01, end - n.start);
    if (fx.staccato) duration = Math.min(duration * 0.45, 0.18);
    if (fx.palmMute) duration = Math.min(duration, 0.16);
    if (fx.dead) duration = Math.min(duration, 0.045);
    if (n.slap === "slap") duration = Math.min(duration, 0.22);
    const chord = columnOf.get(n), rank = chord.indexOf(n);
    const spread = n.stroke ? Math.min(0.025, duration / Math.max(2, chord.length * 2))
      * (n.stroke === "up" ? chord.length - 1 - rank : rank) : 0;
    const style = articulation(n), base = { note: n, pitch: n.pitch, segments, ...style };
    const step = ["8", "16", "32"].includes(n.tremPick) ? 240 / (segments[0].bpm * Number(n.tremPick)) : duration;
    for (let offset = 0, count = 0; offset < duration - 1e-8 && count < 8192; offset += step, count++) {
      events.push({ ...base, start: n.start + spread + offset,
        duration: Math.min(step, duration - offset), release: n.tremPick ? 0.015 : style.release });
    }
    if (interval(n.grace)) {
      const lead = Math.min(0.08, 15 / segments[0].bpm, Math.max(0, n.start));
      if (lead > 0) {
        const grace = { ...n, start: n.start - lead, end: n.start,
          pitch: n.pitch - Math.min(interval(n.grace), n.pos?.fret ?? interval(n.grace)), grace: undefined };
        events.push({ ...base, note: grace, pitch: grace.pitch, start: grace.start, duration: lead,
          velocity: style.velocity * 0.65, release: 0.01,
          segments: [{ note: grace, end: n.start, bpm: segments[0].bpm, slide: {} }] });
      }
    }
  }
  return events.sort((a, b) => a.start - b.start);
}

// Each note owns its source, envelope and filter: chord members never change
// their neighbours' timbre. Keep sources in Sampler's map for pause/releaseAll.
export function playSampleEvent(synth, event, when, heardAt, r = 1) {
  const name = Tone.Frequency(event.pitch, "midi").toNote();
  const dur = event.duration / r;
  const oldAttack = synth.attack;
  synth.attack = event.attack / r;
  try { synth.triggerAttack(name, when, event.velocity); }
  finally { synth.attack = oldAttack; }
  const src = synth._activeSources?.get(Math.round(event.pitch))?.at(-1);
  if (!src) { synth.triggerRelease(name, when + dur); return; }
  src.fadeOut = event.release / r;
  // Only automate moving pitches; long plain notes need no sampled curve.
  const param = src.playbackRate;
  const moves = event.segments.some(({ note: n }) => n.pitch !== event.pitch
    || n.bend || n.fx?.vibrato || n.slide || n.whammy || n.trill || n.harmonic);
  if (param && moves) {
    const base = param.value, steps = Math.max(2, Math.ceil(dur * 200));
    const curve = Float32Array.from({ length: steps + 1 },
      (_, k) => base * 2 ** (eventOffsetAt(event, k / steps * event.duration) / 12));
    param.setValueAtTime(curve[0], when);
    param.setValueCurveAtTime(curve, Math.max(heardAt, when), dur);
  }
  if (event.filter) {
    const [type, frequency, Q] = event.filter;
    const filter = new Tone.Filter({ type, frequency: frequency || Tone.Frequency(
      event.pitch + eventOffsetAt(event, 0), "midi").toFrequency(), Q });
    src.disconnect(); src.connect(filter); filter.connect(synth.output);
    const ended = src.onended;
    src.onended = (...args) => {
      try { ended(...args); }
      finally {
        // Offline's scheduling clock runs before rendering; disconnecting here
        // would remove the filter from the graph before any audio is rendered.
        if (!synth.context?.isOffline) filter.dispose();
      }
    };
  }
  src.stop(Math.max(heardAt, when) + dur);
}
