import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';

// The other pane paints with its own view swapped in; afterwards the live editor
// must be exactly as it was, a click must swap the two views, and linked or
// synced playheads must follow the transport.
class Element extends EventTarget {
  hidden = true; checked = false; offsetHeight = 300; offsetLeft = 200; parentElement = null; scrollLeft = 0; scrollTop = 0; clientWidth = 400; offsetWidth = 200; attributes = {}; children = []; dataset = {}; style = { setProperty() {} };
  classList = { set: new Set(), add(...c) { c.forEach(x => this.set.add(x)); }, remove(...c) { c.forEach(x => this.set.delete(x)); },
    toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); }, contains(c) { return this.set.has(c); } };
  querySelector() { return new Element(); }
  querySelectorAll() { return (this.selects ||= [new Element(), new Element()]); }
  setAttribute(k, v) { this.attributes[k] = v; }
  toggleAttribute() {}
  contains(node) { return node === this; }
  replaceChildren(...c) { this.children = c; }
}
const els = {}, $ = id => (els[id] ||= new Element());
const editorEl = new Element(), live = { scroll: new Element(), name: 'live' };
let bound = live, shown = null, shownPlaying = false, time = 5, playing = false, fretboards = 0;
const lanes = [{ id: 'a', name: 'A', active: true }, { id: 'b', name: 'B', active: false }];
const stems = [{ id: 'mix', name: 'Mix', spec: 'mixSpec', audioUrl: 'mix.opus' }, { id: 'bass', name: 'Bass', spec: 'bassSpec', audioUrl: 'bass.opus' }];
const S = { zoomX: 2, zoomY: 1, pxPerSec: 200, stageHeight: 300, spectImg: 'mixImg', spectPixels: 'px', mouseX: 9, mouseY: 9,
  hoverNote: null, drag: null, marquee: null, matchHover: -1, refEdgeHover: null, refLockHover: null, rulerHover: null,
  state: { lanes, editLanes: lanes, stems, curStem: 'mix', spec: 'mixSpec', rowH: 10, duration: 100 } };
const followers = [], focuses = [], pairs = [];
let host = null, repeatSwaps = 0, zones = null;
globalThis.window = new EventTarget();
const store = {};
globalThis.localStorage = { getItem: key => store[key] ?? null, setItem(key, value) { store[key] = value; } };
globalThis.Image = class { decode() { return new Promise(() => {}); } };   // still decoding
globalThis.Option = class { constructor(text, value) { Object.assign(this, { text, value }); } };
globalThis.Audio = class { paused = true; currentTime = 0; playbackRate = 1; dataset = {}; constructor() { followers.push(this); }
  play() { this.paused = false; return Promise.resolve(); } pause() { this.paused = true; } };
const activeLane = () => lanes.find(l => l.active);
const split = await mockImport(new URL('../../web/split-view.js', import.meta.url), {
  './constants.js': { PX_PER_SEC: 100 },
  './dom.js': { $, audio: { playbackRate: 1 }, editorEl, liveViewport: live, bindViewport(v) { bound = v; } },
  './store.js': { S },
  './repaint.js': { draw() {} },
  './geometry.js': { layout() { S.stageHeight = 123; S.state.rowH = 4; }, syncRowHeight() {}, updateZoomLabels() {}, xOf: t => t * S.pxPerSec, yOf: p => p },
  './playback.js': { pauseTransport() { playing = false; }, playbackTime: () => shown ?? time, transportPlaying: () => (shown != null ? shownPlaying : playing),
    seekPlayback(t) { time = t; }, showPlayhead(t, p = false) { shown = t; shownPlaying = p; }, setPlaybackFocus(f) { focuses.push(f); } },
  './lanes.js': { activeLane, activateLane(lane) { lanes.forEach(l => { l.active = l === lane; }); }, editLanes: () => lanes },
  './project.js': { selectStem(id) { S.state.curStem = id; S.state.spec = stems.find(s => s.id === id).spec; }, spectrogramUrl: () => ({ href: '' }) },
  './tracing.js': { prepareSpectSample() {} },
  './timing.js': { timingIdOf: lane => lane.id, withTiming: (id, fn) => fn() },
  './fretboard.js': { layoutFretboard() {}, paintFretboardInto() { fretboards++; } },
  './splitters.js': { splitter() {} },
  './repeat-dock.js': { initRepeatDock() {} },
  './repeats.js': { connectRepeatSplit(h) { host = h; }, pairRepeats(on) { pairs.push(on); }, swapRepeatPane() { repeatSwaps++; if (zones) zones = { live: zones.other, other: zones.live }; }, holdRepeatPlayhead() {}, repeatZones: () => zones, withRepeatPane: fn => fn() },
  './volume.js': { busLevel: () => 1 },
  './util.js': { clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)), normLayerVolume: v => v ?? 1 },
});
const follower = followers[0];
split.init_split_view();
$('splitViewToggle').dispatchEvent(new Event('click'));
// A press in the other pane: it becomes live and the press is handed to what is under the pointer then.
const handed = [];
globalThis.document = { elementFromPoint: () => under };
const under = Object.assign(new EventTarget(), { contains: () => false });
under.addEventListener('pointerdown', e => handed.push(e.type));
globalThis.PointerEvent = class extends Event { constructor(type, init) { super(type); Object.assign(this, { clientX: init.clientX, clientY: init.clientY }); } };
const hoverOther = () => $('splitPane').dispatchEvent(Object.assign(new PointerEvent('pointerdown', { clientX: 5, clientY: 5 }), { button: 0 }));
const snapshot = () => JSON.stringify({ ...S, state: { ...S.state, lanes: lanes.map(l => l.active) } });

assert.deepEqual(focuses.at(-1), { stems: ['mix'], lanes: ['a'] }, 'independent: the live pane is heard as its own layers');
const before = snapshot();
let painted;
split.paintSplitPane(() => { painted = { bound, lane: activeLane().id, time: shown, zoomX: S.zoomX, mouseX: S.mouseX }; }, true);
assert.notEqual(painted.bound, live, 'the other pane paints into its own elements');
assert.equal(painted.time, 5, 'with its own playhead');
assert.equal(painted.mouseX, null, 'without the live pointer');
assert.equal(fretboards, 1, 'and its own fretboard');
assert.equal(bound, live); assert.equal(shown, null);
assert.equal(snapshot(), before, 'the live editor is untouched');

// Live pane moves on; clicking the other pane swaps the views.
time = 40; lanes[1].active = true; lanes[0].active = false; S.zoomX = 4;
hoverOther();
assert.deepEqual(handed, ['pointerdown'], 'the press that made the pane live reaches it');
assert.equal(activeLane().id, 'a', 'the other pane comes up with its layer');
assert.equal(time, 5, 'and its playhead'); assert.equal(S.zoomX, 2, 'and its zoom');
assert.ok(editorEl.classList.contains('live-second'));
split.paintSplitPane(() => { painted = { lane: activeLane().id, time: shown, zoomX: S.zoomX }; }, true);
assert.deepEqual(painted, { lane: 'b', time: 40, zoomX: 4 }, 'the pane left behind keeps its view');

// Linked: the offset holds while the transport moves, and the other pane is heard.
const setMode = value => { $('splitMode').value = value; $('splitMode').dispatchEvent(new Event('change')); };
setMode('link');
playing = true; time = 7; window.dispatchEvent(new Event('cw-transport'));
assert.equal(follower.paused, false, 'linked playback plays the other pane too');
assert.equal(follower.currentTime, 42, 'at its own position');
assert.equal(follower.src, 'mix.opus', 'from its own audio layer');
split.paintSplitPane(() => { painted = { time: shown, playing: shownPlaying }; }, false);
assert.deepEqual(focuses.at(-1), { stems: ['mix'], lanes: ['a'] }, 'linked: notes only from the live pane');
assert.deepEqual(painted, { time: 42, playing: true }, 'its playhead moves with the transport');
// Swapping while linked keeps playing, with the roles reversed.
hoverOther();
assert.equal(playing, true); assert.equal(time, 42);
split.paintSplitPane(() => { painted = shown; }, false);
assert.equal(painted, 7, 'the pane left behind keeps moving at its own position');
playing = false; window.dispatchEvent(new Event('cw-transport'));
assert.equal(follower.paused, true, 'pausing stops both');

// Synced: one playhead.
setMode('sync'); time = 60;
split.paintSplitPane(() => {}, true);
assert.deepEqual(focuses.at(-1).lanes, [activeLane().id], 'synced: notes only from the live pane too');
split.paintSplitPane(() => { painted = shown; }, true);
assert.equal(painted, 60, 'synced panes share the playhead');
playing = true; setMode('free'); const side = editorEl.classList.contains('live-second'); hoverOther();
assert.notEqual(editorEl.classList.contains('live-second'), side, 'a click activates the pane while playing too');
assert.equal(playing, true, 'without stopping the transport');
hoverOther(); playing = false; time = 70;
split.paintSplitPane(() => { painted = shown; }, true);
assert.equal(painted, 60, 'independent again, it stays where it was');
// An audio choice for the other pane that is still loading survives a swap.
const otherHead = heads => (editorEl.classList.contains('live-second') ? $('splitHead0') : $('splitHead1'));
const stemSelect = otherHead().querySelectorAll()[0];
stemSelect.value = S.state.curStem === 'mix' ? 'bass' : 'mix';
stemSelect.dispatchEvent(new Event('change'));
hoverOther();
assert.equal(S.state.curStem, stemSelect.value, 'the pane comes up with the audio layer chosen for it');
// Kept per project: closing the project keeps the split as it was, reopening brings it back.
S.state.job = 'song';
$('splitLayout').value = 'rows'; $('splitLayout').dispatchEvent(new Event('change'));
setMode('sync'); $('splitSyncView').checked = true; $('splitSyncView').dispatchEvent(new Event('change'));
const otherLane = lanes.find(l => !l.active).id;
window.dispatchEvent(new Event('cw-project-closed'));
const kept = JSON.parse(store['cw.split.song']);
assert.deepEqual([kept.open, kept.layout, kept.mode, kept.syncView, kept.other.laneId], [true, 'rows', 'sync', true, otherLane]);
assert.equal($('splitPane').hidden, true, 'a closed project closes the split');
$('splitLayout').value = 'columns'; $('splitMode').value = 'free';   // as another project would leave them
window.dispatchEvent(new Event('cw-project-opened'));
assert.equal($('splitPane').hidden, false, 'reopening the project reopens the split');
assert.ok(editorEl.classList.contains('rows')); assert.equal($('splitMode').value, 'sync'); assert.equal($('splitSyncView').checked, true);
split.paintSplitPane(() => { painted = activeLane().id; }, true);
assert.equal(painted, otherLane, 'with the other pane on its layer');
$('splitViewToggle').dispatchEvent(new Event('click'));
assert.equal(JSON.parse(store['cw.split.song']).open, false, 'closing the split is kept too');
store['cw.split.song'] = null; window.dispatchEvent(new Event('cw-project-opened'));
assert.equal($('splitPane').hidden, true, 'a project without a kept split opens without one');
assert.ok(!editorEl.classList.contains('rows'), 'and with the default settings');
// The repeat review: opening pairs it, a swap takes its selection along, and an
// instance it reveals moves the other pane there.
$('splitViewToggle').dispatchEvent(new Event('click'));
assert.equal(pairs.at(-1), true, 'opening the split pairs a running review');
const swapsBefore = repeatSwaps; hoverOther();
assert.equal(repeatSwaps, swapsBefore + 1, 'a swap swaps the review\'s panes too');
$('splitMode').value = 'free'; $('splitMode').dispatchEvent(new Event('change'));
host.reveal({ t0: 33, pitch: 50 });
split.paintSplitPane(() => { painted = shown; }, true);
assert.equal(painted, 33, 'the other pane goes to the instance it shows');
$('splitMode').value = 'sync'; $('splitMode').dispatchEvent(new Event('change'));
host.open('b');
assert.equal($('splitMode').value, 'link', 'comparing instances, synced gives way to linked');
host.reviewing(false);
split.paintSplitPane(() => { painted = activeLane().id; }, true);
assert.equal(painted, 'b', 'a scan shows its layer in the other pane');
$('splitMode').value = 'free'; $('splitMode').dispatchEvent(new Event('change'));
split.paintSplitPane(() => { painted = shown; }, true);
const resting = painted;
host.reveal({ t0: 50, pitch: 50 }, { linked: true });
split.paintSplitPane(() => { painted = shown; }, true);
assert.equal(painted, resting, 'independent, a linked-only reveal leaves the other pane alone');
$('splitMode').value = 'link'; $('splitMode').dispatchEvent(new Event('change'));
time = 10; host.reveal({ t0: 50, pitch: 50 }, { linked: true });
split.paintSplitPane(() => { painted = shown; }, true);
assert.equal(painted, 50, 'linked, it goes to its instance start');
// A shorter instance waits at its end while the live one plays on.
// Each linked playhead is the same distance into its own instance, whatever offset was kept.
zones = { live: { t0: 10, t1: 30 }, other: { t0: 50, t1: 55 } }; time = 13;
split.paintSplitPane(() => { painted = shown; }, true);
assert.equal(painted, 53, '3 s into one instance is 3 s into the other');
zones.live.t0 = 11;
split.paintSplitPane(() => { painted = shown; }, true);
assert.equal(painted, 52, 'measured from each instance start, not from a stored offset');
zones.live.t0 = 10; time = 13; hoverOther();
assert.equal(time, 53, 'the pane made live keeps its distance into its instance');
hoverOther();
assert.equal(time, 13, 'and so does the one left behind');
zones.live.t0 = 10; time = 17; playing = true; window.dispatchEvent(new Event('cw-transport'));
split.paintSplitPane(() => { painted = shown; }, false);
assert.equal(painted, 55, 'the linked playhead stops at its instance end');
assert.equal(follower.paused, true, 'and its audio with it');
time = 12; window.dispatchEvent(new Event('cw-transport'));
assert.equal(follower.paused, false, 'inside again, it plays');
playing = false; zones = null; window.dispatchEvent(new Event('cw-transport'));
$('splitViewToggle').dispatchEvent(new Event('click'));
assert.equal(pairs.at(-1), false, 'closing the split unpairs it');
console.log('split view OK');
