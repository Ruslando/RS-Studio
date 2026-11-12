import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { mockImport } from './mock-import.mjs';

const jobs = [];
class Worker {
  constructor(url, options) {
    assert.equal(url.pathname.endsWith('/voicing-worker.js'), true);
    assert.equal(options.type, 'module');
    jobs.push(this);
  }
  postMessage(message) { this.request = message; }
  terminate() { this.terminated = true; }
  finish(fret) { this.onmessage({ data: { task: 'voice', positions: [{ string: 0, fret }], fingers: [2], seats: [fret] } }); }
}
const saved = { Worker: globalThis.Worker, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
const S = { voicingRevision: 1 };
const lane = { tuning: 'guitar6', instrument: 'electric', notes: [{ id: 'n', start: 0, end: 1, pitch: 64 }] };
let releaseDrag;
try {
  globalThis.Worker = Worker;
  globalThis.setInterval = fn => { releaseDrag = fn; return 1; };
  globalThis.clearInterval = () => {};
  const { laneFingering } = await mockImport(new URL('../../web/lane-fingering.js', import.meta.url), {
    './store.js': { S }, './song-bars.js': { songBarStarts: () => [0, 4] },
    './timing.js': { onLiveTiming: () => true },
    './voicing-core.js': { arrangedNotes: notes => notes, isChosenFinger: () => false, chordColumns: () => [] },
  }, { './lane-tuning.js': true, './fretboard-cache.js': true });

  const controller = new AbortController();
  const cancelled = laneFingering(lane, controller.signal);
  const rejected = assert.rejects(cancelled, { name: 'AbortError' });
  const shared = laneFingering(lane);
  assert.equal(jobs.length, 1, 'simultaneous callers share one worker');
  controller.abort();
  await rejected;
  assert.equal(jobs[0].terminated, undefined, 'cancelling one caller preserves the shared calculation');
  jobs[0].finish(3);
  assert.equal((await shared).voiced.get(lane.notes[0]).fret, 3);
  assert.equal(jobs[0].terminated, true);
  assert.equal((await laneFingering(lane)).voiced.get(lane.notes[0]).fret, 3);
  assert.equal(jobs.length, 1, 'completed results are reused');

  S.voicingRevision++;
  const stale = laneFingering(lane);
  const staleRejected = assert.rejects(stale, { name: 'AbortError' });
  S.voicingRevision++;
  const current = laneFingering(lane);
  assert.equal(jobs.length, 2, 'a newer key waits for the running worker');
  jobs[1].finish(4);
  await staleRejected;
  await setImmediate();
  assert.equal(jobs.length, 3);
  jobs[2].finish(5);
  assert.equal((await current).voiced.get(lane.notes[0]).fret, 5, 'stale answers never reach the newer caller');

  S.voicingRevision++; S.drag = {};
  const moving = laneFingering(lane);
  const movingRejected = assert.rejects(moving, { name: 'AbortError' });
  assert.equal(jobs.length, 3, 'no worker starts during a drag');
  S.voicingRevision++; S.drag = null;
  releaseDrag();
  await movingRejected;
  assert.equal(jobs.length, 3, 'an outdated request waiting for a drag is discarded');

  const failed = laneFingering(lane);
  const failure = assert.rejects(failed, /automatic fingering worker failed/);
  jobs[3].onerror();
  await failure;
  assert.equal(jobs[3].terminated, true);
  await setImmediate();
  const retry = laneFingering(lane);
  assert.equal(jobs.length, 5, 'a failed worker does not block retries');
  jobs[4].finish(6);
  assert.equal((await retry).voiced.get(lane.notes[0]).fret, 6);
} finally { Object.assign(globalThis, saved); }
