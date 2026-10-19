import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';

class Target extends EventTarget {
  hidden = true;
  value = 0;
  checked = false;
  matches() { return false; }
}
let seconds = 0, scheduler;
const calls = [];
const audio = Object.assign(new Target(), { paused: true, currentTime: 0, playbackRate: 1, duration: 10,
  play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); },
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); },
});
const lane = { id: 'guitar', volume: 1, notes: [
  { pitch: 64, start: 2, end: 2.03 },
  { pitch: 65, start: 2.06, end: 2.09 }, // just beyond the short loop
], _synth: { volume: { value: 0 }, onsetSec: 0 } };
const S = { state: { duration: 10, stems: [], lanes: [lane] }, voicingRevision: 0,
  scoreTime: 2, scorePlaying: false, detectRegion: { t0: 2, t1: 2.05 }, toneReady: true };
const windowTarget = new Target();
const transportEvents = [];
windowTarget.addEventListener('cw-transport', event => transportEvents.push(event.detail));
const tone = { getContext: () => ({ currentTime: seconds, rawContext: { outputLatency: 0 } }) };
const saved = Object.fromEntries(['window', 'document', 'Tone', 'performance', 'requestAnimationFrame', 'setInterval', 'clearInterval', 'CustomEvent'].map(key => [key, globalThis[key]]));
try {
  Object.assign(globalThis, { window: windowTarget, document: { hidden: false }, Tone: tone,
    performance: { now: () => seconds * 1000 }, requestAnimationFrame() {},
    setInterval(fn) { scheduler = fn; return 1; }, clearInterval() {},
    CustomEvent: class extends Event { constructor(type, options) { super(type); this.detail = options.detail; } },
  });
  windowTarget.Tone = tone;
  const noop = () => {};
  const dom = Object.fromEntries(['editorEl', 'metroOn', 'playBtn', 'scroll', 'seek', 'speedSel', 'timeEl'].map(key => [key, new Target()]));
  const playback = await mockImport(new URL('../../web/playback.js', import.meta.url), {
    './dom.js': { ...dom, audio, $: () => null },
    './store.js': { S }, './repaint.js': { draw: noop, drawNow: noop },
    './grid.js': { gridSegments: () => [], gridAt: () => ({ bpm: 120 }) },
    './lanes.js': { editLanes: () => [lane], releaseLaneSynth: noop, applyLaneVolume: noop },
    './volume.js': { busLevel: () => 1 },
    './viewport-motion.js': { viewportFollowing: () => false, stopViewportMotion: noop },
    './playback-effects.js': {
      playbackEvents: notes => notes, playSampleEvent: (synth, event) => calls.push(event.pitch),
    },
  }, { './constants.js': true, './util.js': true, './region-loop.js': true, './keymap.js': true });
  playback.init_playback();
  await playback.playTransport();
  assert.equal(transportEvents.at(-1), 'play', 'score transport announces playback');
  scheduler();
  assert.deepEqual(calls, [64], 'first lookahead excludes notes beyond the loop');
  seconds += .08;
  scheduler();
  assert.equal(S.scoreAnchorSong, 2, 'loop restarts exactly at its first attack');
  assert.deepEqual(calls, [64, 64], 'first attack repeats without scheduling outside the loop');
  seconds += .08;
  scheduler();
  assert.deepEqual(calls, [64, 64, 64], 'short loops keep the scheduler capped on every pass');
  playback.seekPlayback(5);
  seconds += .08;
  scheduler();
  assert.ok(playback.playbackTime() > 5, 'seeking outside leaves playback outside');
  playback.pauseTransport();
  assert.equal(transportEvents.at(-1), 'pause', 'score pause announces the stopped state');
  // Media seeks must seed the scheduler from the media target, even while the
  // audible clock still reports the old position until the next clock tick.
  S.scorePlaying = false;
  S.state.stems = [{ id: 'master' }];
  S.mediaNode = {};
  audio.currentTime = 2;
  transportEvents.length = 0;
  await playback.playTransport();
  assert.equal(transportEvents.at(-1), 'play', 'audio transport announces playback too');
  audio.currentTime = 2.01; seconds += .01; scheduler();
  const beforeSeek = calls.length;
  playback.seekPlayback(2);
  audio.currentTime = 2.01; seconds += .01; scheduler();
  assert.equal(calls.length, beforeSeek + 1, 'audio-backed seek retains the boundary attack before seeked arrives');
  assert.equal(calls.at(-1), 64);
  audio.currentTime = 10;
  audio.pause();
  assert.equal(transportEvents.at(-1), 'pause', 'audio pause updates fretboard and tablature');
  audio.dispatchEvent(new Event('ended'));
  assert.equal(audio.currentTime, 2, 'song-end loops seek back into the range');
  assert.equal(audio.paused, false, 'song-end loops restart the media transport');
} finally { Object.assign(globalThis, saved); }
console.log('Playback loop integration passed');
