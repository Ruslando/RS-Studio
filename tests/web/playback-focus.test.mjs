import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';
import { playbackEventFrom, playbackEvents } from '../../web/playback-effects.js';

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
const lane = (id, notes) => ({ id, volume: 1, notes, _synth: { volume: { value: 0 }, onsetSec: 0 } });
// Live layer a at the playhead; layer b holds 71 at the playhead and 70 five seconds on.
const a = lane('a', [{ pitch: 64, start: 2, end: 2.03 }]);
const b = lane('b', [{ pitch: 71, start: 2, end: 2.03 }, { pitch: 70, start: 7, end: 7.03 }]);
const S = { state: { duration: 10, stems: [], lanes: [a, b] }, voicingRevision: 0,
  scoreTime: 2, scorePlaying: false, detectRegion: null, toneReady: true };
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
    "./grid-read.js": { gridSegments: () => [], gridAt: () => ({ bpm: 120 }) },
    './lanes.js': { editLanes: () => [a, b], releaseLaneSynth: noop, applyLaneVolume: noop },
    './volume.js': { busLevel: () => 1 },
    './viewport-motion.js': { viewportFollowing: () => false, stopViewportMotion: noop },
    './playback-effects.js': {
      playbackEventFrom, playbackEvents, playSampleEvent: (synth, event) => calls.push(event.pitch),
    },
  }, { './constants.js': true, './util.js': true, './region-loop.js': true, './keymap.js': true });
  playback.init_playback();
  const heard = async (focus) => {
    playback.pauseTransport(); calls.length = 0; S.scoreTime = 2;
    playback.setPlaybackFocus(focus);
    await playback.playTransport(); scheduler();
    return [...calls].sort();
  };
  assert.deepEqual(await heard(null), [64, 71], 'no split view: every audible layer at the playhead');
  assert.deepEqual(await heard({ stems: [], lanes: [{ id: 'a', offset: 0 }] }), [64], 'only the focused layer is heard');
  assert.deepEqual(await heard({ stems: [], lanes: [{ id: 'a', offset: 0 }, { id: 'b', offset: 5 }] }), [64, 70],
    'a linked layer is heard at its own position');
} finally { Object.assign(globalThis, saved); }
console.log('Playback focus passed');
