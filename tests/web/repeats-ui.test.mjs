import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';
import { findRepeats } from '../../web/repeats-core.js';
import { noteName } from '../../web/util.js';
class Element extends EventTarget {
  style = {}; dataset = {};
  classList = { add() {}, toggle() {} };
  contains(node) { return this === node || this.children.some(c => c.contains(node)); }
  children = []; attributes = {}; textContent = ''; hidden = false; disabled = false; value = '';
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  getAttribute(key) { return this.attributes[key]; }
  focus() { document.activeElement = this; }
  querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]).filter(child => selector === '[data-focus-key]' ? child.dataset.focusKey : child.tagName === 'BUTTON' || child.tagName === 'INPUT'); }
  setAttribute(key, value) { this.attributes[key] = value; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
const ids = ['repeatNavigator', 'repeatGroup', 'repeatGroupPrevious', 'repeatGroupNext', 'repeatPosition', 'repeatPrevious', 'repeatNext',
  'repeatInstance', 'repeatDrag',
  'repeatChangeNavigation', 'repeatChangePrevious', 'repeatChangeNext', 'repeatChangePosition', 'repeatHover', 'repeatHoverRows',
  'repeatHoverHead', 'repeatHoverClose', 'repeatClose'];
const controls = Object.fromEntries(ids.map(id => [id, new Element()]));
const riff = [40, 43, 45, 47, 45, 43, 40, 38];
const make = (start, pitches = riff) => pitches.map((pitch, i) => ({ id: `${start}:${i}`, start: start + i / 2, end: start + i / 2 + .4, pitch, pos: { string: 5, fret: pitch - 35 } }));
const lane = { id: 'edit', name: 'Bass', visible: true, notes: [...make(.3), ...make(10.3, [...riff.slice(0, 7), 36])], refBoxes: {} };
lane.notes[10].pos = { string: 4, fret: 10 };
const selection = new Set([lane.notes[10]]);
const S = { state: { editLanes: [lane], rowH: 10 }, selection, voicingRevision: 0 };
const stageScroll = { scrollLeft: 0, clientWidth: 500, clientHeight: 300, scrollWidth: 10000, scrollHeight: 1000, scrollTop: 0 };
let playhead = 0, playing = false, seekRounding = 0, zone = null;
const seeks = [];
let active = lane, commits = 0, movements = 0, fretboardOpens = 0, worker;
const rectangles = [], badges = [], anchors = [];
let generatedFingers = new Map(), noteUid = 0, lockedNoteId = null, modalIsOpen = false;
const glows = [];
const ctx = { beginPath() {}, rect(x, y, w, h) { this.path = { x, y, w, h }; }, save() {}, restore() {}, setLineDash(dash) { this.dash = dash; }, strokeText() {}, fillText(text) { badges.push(text); }, fillRect() {},
  bezierCurveTo() { this.curvePainted = true; },
  measureText: text => ({ width: text.length * 5 }), beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  strokeRect(...rect) { rectangles.push({ rect, color: this.strokeStyle, dash: this.dash }); } };
class TestWorker {
  constructor() { worker = this; }
  terminate() { this.terminated = true; }
  postMessage(notes) { this.notes = notes; }
  finish() {
    const data = findRepeats(this.notes).map(r => ({ ...(r.phraseLength > 0 ? { phraseLength: r.phraseLength,
      offsets: r.copies.map(c => c.notes[0].beat) } : {}), copies: r.copies.map(c => c.notes.map(n => n.note.id)) }));
    this.onmessage({ data });
  }
}
const original = { document: globalThis.document, window: globalThis.window, Worker: globalThis.Worker, URL: globalThis.URL };
try {
  globalThis.window = new EventTarget();
  globalThis.document = { getElementById: id => controls[id], createElement: tag => Object.assign(new Element(), { tagName: tag.toUpperCase() }), createElementNS: () => new Element(), activeElement: null, body: new Element() };
  globalThis.Worker = TestWorker;
  globalThis.URL = class extends original.URL {
    constructor(path, base) { super(path, String(base).startsWith('data:') ? 'file:///web/repeats.js' : base); }
  };
  const commit = () => { commits++; S.voicingRevision++; };
  const module = await mockImport(new original.URL('../../web/repeats.js', import.meta.url), {
    './store.js': { S },
    './playback.js': { setPlaybackZone(fn) { zone = fn; }, transportPlaying: () => playing, playbackTime: () => playhead, seekPlayback(time) { seeks.push(time); playhead = time - seekRounding; return playhead; } },
    './repeat-dock.js': { initRepeatDock() {} },
    './edit-history.js': { snapshotEdit: () => ({}), commitStructure: commit, commit },

    './dom.js': { scroll: stageScroll, sctx: ctx, stage: { getBoundingClientRect: () => ({ left: 20, top: 30 }) } },
    './geometry.js': { xOf: t => t * 10, yOf: pitch => 100 - pitch },
    './lanes.js': { activeLane: () => active, canEditLane: lane => !!lane?.visible && !lane.locked, refreshCounts() {} },
    "./references.js": { boxOfNote: note => note?.id === lockedNoteId ? { group: { locked: true } } : null, noteBounds: notes => ({ t0: Math.min(...notes.map(n => n.start)), t1: Math.max(...notes.map(n => n.end)), pLo: Math.min(...notes.map(n => n.pitch)), pHi: Math.max(...notes.map(n => n.pitch)) }) },
    "./reference-clock.js": { laneClock: () => ({ beatAt: t => t, timeAt: b => b }) },
    './repaint.js': { draw() {} }, './notify.js': { toast() {} },
    './modal-focus.js': { modalOpen: () => modalIsOpen },
    './viewport-motion.js': { manualViewportNavigation() {}, moveViewportTo(x, y) { movements++; stageScroll.scrollLeft = Math.max(0, x); stageScroll.scrollTop = Math.max(0, y); } },
    "./tablature.js": { refreshTabIfOpen() {} },
    "./lane-fingering.js": { laneFingering: async () => ({ fingers: new Map(generatedFingers) }) },

    './escape-stack.js': { ESC_DEPTH: { transient: 20, popover: 100 }, registerEscapeLayer() {} },
    './tracing.js': { clearMatches() {} },
    './floating-position.js': { placeFloatingAvoiding: (...args) => anchors.push(args) }, './tooltip.js': { hideTooltip() {} },
    './ids.js': { nid: () => `new${++noteUid}` },
    './note-render.js': { noteRibbon: () => null }, './canvas-components.js': { paintNoteGlow(context, level) { glows.push({ ...context.path, level }); } }, './constants.js': { stageUi: () => '11px sans-serif' },
    './stage-paint.js': { PAINT: { trace: 'blue', warn: 'orange', error: 'pink', accent: 'cyan', ok: 'green' }, halo: () => 'black' },
  }, { './repeat-picker.js': true, './repeats-core.js': true, './util.js': true, './repeat-change-details.js': true, './whammy.js': true, './note-effects.js': true });
  module.init_repeats({ ...{ setHandAnchor(lane, t, fret) { lane.handHolds = (lane.handHolds || []).filter(h => h.t !== t); if (fret != null) lane.handHolds.push({t, fret}); commit(); } }, ...{ setFretboardVisible: on => { assert.equal(on, true); fretboardOpens++; } } });
  const changePosition = () => controls.repeatChangePosition.children.find(option => option.value === controls.repeatChangePosition.value)?.textContent.split(' · ')[0];
  const before = structuredClone(lane.notes);
  module.runFindRepeats(lane);
  module.renderRepeatNavigator();
  assert.equal(controls.repeatNavigator.attributes['aria-busy'], 'true');
  worker.finish(); module.renderRepeatNavigator();
  assert.equal(commits, 1, 'scan creates one annotation edit');
  assert.equal(fretboardOpens, 1, 'entering repeat comparison opens the fretboard');
  assert.deepEqual(lane.notes, before, 'scan keeps all positions');
  assert.equal(controls.repeatNavigator.hidden, false);
  assert.equal(controls.repeatPosition.textContent, '1 / 2');
  assert.equal(controls.repeatPosition.textContent, '1 / 2');
  assert.equal(S.selection, selection, 'scanning never changes the note selection');
  assert.equal(controls.repeatGroup.children[0].textContent, 'Group A');
  assert.equal(playhead, lane.notes[0].start, 'entering repeat review seeks to the first passage');

  const third = make(20.3);
  third[4].whammy = 'dip'; third[4].whammyPoints = [[0, 0], [.5, -2], [1, 0]];
  const missingThird = third[3];
  lane.notes.push(...third.filter(note => note !== missingThird));
  lane.repeatGroups[0].copies.push(third.map(note => note.id)); S.voicingRevision++;
  module.renderRepeatNavigator(); module.drawRepeats();
  assert.ok(badges.includes('Group A · instance 1'), 'a frame names its group and instance');
  assert.ok(badges.includes('Group A · instance 3'));
  assert.ok(rectangles.some(r => r.color === 'orange'), 'the first occurrence is also marked when another differs');
  const inspectNote = note => {
    playhead = -1; module.syncRepeatPlayhead();
    playhead = note.start + .01; module.syncRepeatPlayhead();
    return !controls.repeatHover.hidden;
  };
  // A card row: its label, the left value, the copy buttons, the right value.
  // A value cell: its value, and hidden, its preview (old value, arrow, new value).
  const shownIn = cell => cell?.children[0]?.children[0]?.children[0];
  const cellText = cell => shownIn(cell)?.textContent ?? '';
  const previewIn = cell => cell.children[0].children[1].children;
  const rows = () => controls.repeatHoverRows.children.map(row => [row.children[0].textContent, cellText(row.children[1]), cellText(row.children[3])]);
  const heads = () => controls.repeatHoverHead.children.map(cell => cell.textContent);
  const direction = (key, target) => controls.repeatHoverRows.children.flatMap(row => row.children[2]?.children || [])
    .find(button => button.dataset.change === key && button.dataset.target === String(target));
  // The playhead opens notes without any pointer hit targets or canvas draw.
  assert.equal(module.hoverRepeatDifference, undefined, 'mouse hover cannot open a comparison');
  playhead = lane.notes[1].start + .1; module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, true, 'unchanged notes do not open the floating preview');
  playhead = lane.notes[2].start + .1; module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, false, 'a differing note opens the card');
  playing = true; module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, true, 'starting playback hides the note preview');
  playhead = lane.notes[2].start + .1; module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, true, 'playback never reopens the preview');
  playing = false; module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, false, 'pausing restores inspection at the current note');
  controls.repeatHoverClose.click(); module.renderRepeatNavigator();
  window.dispatchEvent(new Event('mousemove')); module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, true, 'mouse movement and redraw leave a dismissed card closed');
  playhead = lane.notes[3].start + .1; module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, false, 'the next differing note under the playhead opens the card');
  playhead = lane.notes[2].end + .01; module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, true, 'the comparison closes in the gap between notes');
  const seekCount = seeks.length;
  playhead = third[2].start + .1; module.renderRepeatNavigator();
  assert.equal(controls.repeatInstance.value, third[0].id, 'an external seek follows the instance under the playhead');
  assert.equal(controls.repeatHover.hidden, false);
  assert.equal(seeks.length, seekCount, 'following playback never seeks the transport back');
  const beforePreview = structuredClone(lane.notes), beforePreviewCommits = commits;
  // The card puts the note beside the next instance where it differs, and shows only what differs.
  assert.equal(inspectNote(lane.notes[2]), true);
  assert.deepEqual(heads(), ['', 'Instance 1', '', 'Instance 2']);
  assert.deepEqual(rows(), [['Position', 'S6 · F10', 'S5 · F10']], 'only the differing values, side by side');
  const positionRow = controls.repeatHoverRows.children[0];
  direction('position', 1).dispatchEvent(new Event('mouseenter'));
  assert.equal(positionRow.children[3].dataset.preview, '', 'an arrow previews the cell it copies into');
  assert.deepEqual(previewIn(positionRow.children[3]).map(part => part.textContent), ['S5 · F10', '→', 'S6 · F10'],
    'the old value, then an arrow to the new one');
  assert.equal(positionRow.children[1].dataset.preview, undefined, 'the source cell stays as it is');
  direction('position', 1).dispatchEvent(new Event('mouseleave'));
  assert.equal(positionRow.children[3].dataset.preview, undefined, 'leaving restores it');
  assert.deepEqual(lane.notes, beforePreview, 'previewing never edits notes');
  assert.equal(commits, beforePreviewCommits, 'previewing adds no undo steps');
  assert.equal(S.selection, selection);
  window.dispatchEvent(new Event('mousemove'));
  window.dispatchEvent(new Event('mousedown'));
  window.dispatchEvent(new Event('wheel'));
  assert.equal(controls.repeatHover.hidden, false, 'mouse activity does not dismiss the playhead comparison');

  const originalPosition = structuredClone(lane.notes[10].pos), countBeforeApply = commits;
  lockedNoteId = lane.notes[10].id; module.hideRepeatHover(); inspectNote(lane.notes[2]);
  assert.equal(direction('position', 1).disabled, true, 'a locked reference cannot receive the value');
  lockedNoteId = null; module.hideRepeatHover(); inspectNote(lane.notes[2]);
  direction('position', 1).click(); module.renderRepeatNavigator();
  assert.deepEqual(lane.notes[10].pos, lane.notes[2].pos, '→ copies the left value to the right');
  assert.equal(commits, countBeforeApply + 1, 'a copy is one undoable edit');
  assert.equal(controls.repeatHover.hidden, true, 'resolving the last difference closes the card');
  lane.notes[10].pos = originalPosition; S.voicingRevision++; module.renderRepeatNavigator();
  module.hideRepeatHover(); inspectNote(lane.notes[2]);
  const ownPosition = structuredClone(lane.notes[2].pos);
  direction('position', 0).click(); module.renderRepeatNavigator();
  assert.deepEqual(lane.notes[2].pos, originalPosition, '← copies the right value to the left');
  assert.equal(heads()[3], 'Instance 3', 'the card moves on to the next instance that still differs');
  lane.notes[2].pos = ownPosition; S.voicingRevision++; module.renderRepeatNavigator(); module.hideRepeatHover();

  third[0].fx = { vibrato: true }; S.voicingRevision++; module.renderRepeatNavigator();
  module.drawRepeats(); inspectNote(lane.notes[0]);
  assert.deepEqual(rows()[0], ['Vibrato', 'Off', 'On']);
  assert.equal(heads()[3], 'Instance 3', 'an instance that matches is passed over');
  const beforeVibrato = commits;
  direction('fx.vibrato', 0).click();
  assert.equal(lane.notes[0].fx.vibrato, true, 'the compared vibrato can be copied to this note');
  assert.equal(commits, beforeVibrato + 1);
  delete lane.notes[0].fx; S.voicingRevision++; module.renderRepeatNavigator();
  module.hideRepeatHover(); module.drawRepeats(); inspectNote(lane.notes[0]);
  direction('fx.vibrato', 2).click(); module.renderRepeatNavigator();
  assert.ok(!third[0].fx?.vibrato, 'and this note\'s absence to the compared one');
  assert.equal(controls.repeatHover.hidden, true, 'resolving vibrato closes the card');
  assert.equal(S.selection, selection);

  // A curve is drawn; an absent one reads None.
  module.drawRepeats(); inspectNote(lane.notes[4]);
  const curveRow = controls.repeatHoverRows.children.find(row => row.children[0].textContent === 'Whammy curve');
  assert.ok(curveRow, JSON.stringify(rows()));
  assert.equal(cellText(curveRow.children[1]), 'None');
  assert.equal(shownIn(curveRow.children[3]).children[0].attributes.viewBox, '0 0 96 28');
  assert.equal(shownIn(curveRow.children[3]).children[0].children.filter(child => child.attributes.class === 'repeat-curve-point').length, 3, 'the curve shows each control point');
  assert.ok(!rows().some(row => row[0] === 'Whammy'), 'the separate whammy kind row is omitted');
  assert.ok(rectangles.some(rect => rect.color === 'orange' && Math.abs(rect.rect[0] - (lane.notes[4].start * 10 - 2)) < 1e-5),
    'the stage marks the different curve');
  const previewNotes = structuredClone(lane.notes), previewCommits = commits;
  direction('whammyPoints', 0).dispatchEvent(new Event('mouseenter'));
  assert.equal(curveRow.children[1].dataset.preview, '');
  const [oldCurve, , newCurve] = previewIn(curveRow.children[1]);
  assert.equal(oldCurve.textContent, 'None');
  assert.equal(newCurve.children[0].attributes.viewBox, '0 0 96 28', 'hovering ← previews the compared curve here');
  direction('whammyPoints', 0).dispatchEvent(new Event('mouseleave'));
  assert.deepEqual(lane.notes, previewNotes, 'hovering does not mutate notes');
  assert.equal(commits, previewCommits);
  direction('whammyPoints', 0).click();
  assert.deepEqual(lane.notes[4].whammyPoints, third[4].whammyPoints, 'the curve points are copied');
  assert.notEqual(lane.notes[4].whammyPoints, third[4].whammyPoints, 'the curves do not share mutable data');
  assert.equal(commits, previewCommits + 1);
  delete lane.notes[4].whammy; delete lane.notes[4].whammyPoints; S.voicingRevision++; module.renderRepeatNavigator(); module.hideRepeatHover();

  // A missing counterpart.
  const manualReplacement = { ...missingThird, id: 'drawn-after-scan' };
  lane.notes.push(manualReplacement); S.voicingRevision++; module.renderRepeatNavigator();
  module.drawRepeats();
  assert.equal(inspectNote(lane.notes[3]), false, 'a matching replacement clears the missing-note card');
  lane.notes = lane.notes.filter(note => note !== manualReplacement); S.voicingRevision++; module.renderRepeatNavigator();
  module.drawRepeats(); inspectNote(lane.notes[3]);
  assert.deepEqual(rows(), [['Note', 'B2', 'Missing']]);
  const savedIds = lane.repeatGroups[0].copies[2];
  direction('presence', 2).click();
  const recreated = lane.notes.find(note => note.id.startsWith('new'));
  assert.ok(recreated, '→ adds the missing counterpart');
  assert.equal(recreated.start, missingThird.start);
  module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, true, 'filling the missing note closes the card');
  lane.notes = lane.notes.filter(note => note !== recreated);
  savedIds.splice(savedIds.indexOf(recreated.id), 1); S.voicingRevision++; module.renderRepeatNavigator();
  // Where the note is missing, the playhead finds no note of this instance's;
  // the difference buttons still reach it.
  assert.equal(inspectNote(missingThird), false, 'the playhead opens only this instance\'s own notes');
  module.renderRepeatNavigator();
  assert.equal(controls.repeatPosition.textContent, '3 / 3');
  controls.repeatChangePosition.value = `${third[0].id}:${lane.notes[3].id}`;
  controls.repeatChangePosition.dispatchEvent(new Event('change')); module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, false, 'a missing note opens from the difference list');
  assert.deepEqual(heads(), ['', 'Instance 3', '', 'Instance 1']);
  assert.deepEqual(rows(), [['Note', 'Not present', 'B2']]);
  module.hideRepeatHover();
  rectangles.length = 0; module.drawRepeats();
  const ghost = rectangles.find(r => r.color === 'orange' && r.dash.length);
  assert.ok(ghost, 'the missing note uses the same color with a dashed outline');
  assert.ok(rectangles.filter(r => r.color !== 'blue').every(r => r.color === 'orange'), 'all note differences use one color');
  controls.repeatPrevious.click(); controls.repeatPrevious.click(); module.renderRepeatNavigator();
  assert.equal(controls.repeatPosition.textContent, '1 / 3');

  // An absence can be copied too: the note is removed.
  const notesBeforeRemoval = lane.notes, uniqueNote = lane.notes[3], secondNoteId = lane.notes[11].id;
  lane.notes = lane.notes.filter(note => note.id !== secondNoteId); S.voicingRevision++; module.renderRepeatNavigator();
  module.hideRepeatHover(); module.drawRepeats(); inspectNote(uniqueNote);
  assert.deepEqual(rows(), [['Note', 'B2', 'Missing']]);
  const removalCommit = commits;
  direction('presence', 0).click();
  assert.ok(!lane.notes.includes(uniqueNote), '← copies an absence');
  assert.equal(commits, removalCommit + 1);
  assert.equal(controls.repeatHover.hidden, true, 'the card closes when no corresponding note remains');
  lane.notes = notesBeforeRemoval; S.voicingRevision++; module.renderRepeatNavigator();

  // Identical notes leave the card closed.
  module.drawRepeats(); assert.equal(inspectNote(lane.notes[0]), false);
  module.hideRepeatHover();

  // Changes are found relative to all the other instances, including the first.
  controls.repeatChangeNext.click(); module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, false);
  assert.notEqual(changePosition(), '– / 0');
  assert.equal(controls.repeatChangeNavigation.hidden, false, 'changed-note navigation appears when differences exist');
  assert.ok(controls.repeatChangePosition.children.every(option => /^([0-9]+|–) \/ [0-9]+$/.test(option.textContent)), 'occurrence options contain only a position and count');
  assert.equal(S.selection, selection);
  const key = (key, extra = {}) => {
    const event = { key, target: { tagName: 'DIV' }, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
    const handled = module.handleRepeatNavigationKey(event); module.renderRepeatNavigator(); return { event, handled };
  };
  const notePlayhead = playhead;
  assert.equal(key('ArrowRight').handled, false, 'plain arrows pass through to individual-note navigation');
  assert.equal(key('ArrowLeft').handled, false);
  assert.equal(playhead, notePlayhead, 'repeat navigation does not seek on plain arrows');
  assert.equal(key('ArrowRight', { target: { tagName: 'INPUT' } }).handled, false);
  assert.equal(key('ArrowRight', { ctrlKey: true }).handled, false);
  modalIsOpen = true; assert.equal(key('ArrowRight').handled, false); modalIsOpen = false;
  const identical = lane.notes.slice(0, 8).map((note, i) => ({ ...structuredClone(note), id: `identical${i}`, start: 40.3 + i / 2, end: 40.7 + i / 2 }));
  lane.notes.push(...identical);
  lane.repeatGroups.push({ id: 'repeat_3', name: 'Already consistent', copies: [lane.repeatGroups[0].copies[0], identical.map(n => n.id)] });
  S.voicingRevision++; controls.repeatGroup.value = 'repeat_3'; controls.repeatGroup.dispatchEvent(new Event('change')); module.renderRepeatNavigator();
  assert.equal(controls.repeatChangeNavigation.hidden, true, 'identical instances do not duplicate the instance selector');
  assert.equal(controls.repeatPosition.textContent, '1 / 2');
  assert.equal(playhead, lane.notes[0].start, 'changing groups seeks to the selected passage');
  assert.equal(key('ArrowRight').handled, false);
  assert.equal(controls.repeatPosition.textContent, '1 / 2', 'plain arrows never fall back to instance navigation');
  assert.equal(key('ArrowRight', { altKey: true }).handled, true);
  assert.equal(controls.repeatPosition.textContent, '2 / 2', 'Alt+arrows move through instances');
  assert.equal(controls.repeatHover.hidden, true, 'an unchanged destination does not open a card');
  assert.equal(playhead, identical[0].start);
  key('ArrowLeft', { altKey: true }); assert.equal(controls.repeatPosition.textContent, '1 / 2');
  module.drawRepeats(); assert.equal(inspectNote(lane.notes[0]), false, 'unchanged notes stay closed');
  assert.equal(S.selection, selection);
  module.hideRepeatHover();
  lane.notes[0].finger = 4; identical[0].finger = 3;
  lane.handHolds = [{ t: lane.notes[0].start, fret: 5 }, { t: identical[0].start, fret: 6 }];
  S.voicingRevision++; module.renderRepeatNavigator(); module.drawRepeats(); inspectNote(lane.notes[0]);
  assert.equal(controls.repeatChangeNavigation.hidden, false, 'navigation reappears after a new difference');
  assert.deepEqual(rows(), [['Finger', '4', '3'], ['Hand anchor', 'F5', 'F6']]);
  direction('handAnchor', 1).click();
  assert.ok(lane.handHolds.some(h => h.t === identical[0].start && h.fret === 5), 'the anchor is copied across');
  assert.deepEqual(rows(), [['Finger', '4', '3']]);
  key('ArrowRight', { altKey: true }); module.hideRepeatHover(); inspectNote(identical[0]);
  assert.deepEqual(heads(), ['', 'Instance 2', '', 'Instance 1'], 'this instance is always the left column alone');
  assert.deepEqual(rows(), [['Finger', '3', '4']]);
  module.hideRepeatHover();
  const savedGroups = structuredClone(lane.repeatGroups);
  controls.repeatClose.click(); module.renderRepeatNavigator();
  assert.equal(controls.repeatNavigator.hidden, true, 'the close button exits repeat review');
  assert.deepEqual(lane.repeatGroups, savedGroups, 'closing leaves saved groups intact');

  // A one-off passage retains the toolbar without opening comparison cards.
  module.runFindRepeats(lane);
  worker.onmessage({ data: [{ copies: [identical.map(n => n.id)] }] });
  module.renderRepeatNavigator();
  assert.equal(controls.repeatNavigator.hidden, false);
  assert.equal(controls.repeatPosition.textContent, '1 / 1');
  assert.equal(controls.repeatChangeNavigation.hidden, true, 'a one-off passage has only one instance selector');
  assert.equal(controls.repeatPrevious.disabled, true);
  assert.equal(controls.repeatNext.disabled, true);
  module.drawRepeats(); assert.equal(inspectNote(identical[0]), false, 'a single instance has no differences to preview');
  controls.repeatClose.click(); module.renderRepeatNavigator();
  assert.equal(controls.repeatNavigator.hidden, true);

  // A delayed first attack must not shift every counterpart and hide the
  // genuinely missing opening of a structurally bounded passage.
  const withOpening = lane.notes;
  lane.notes = lane.notes.filter(n => n !== identical[0]); S.voicingRevision++;
  module.runFindRepeats(lane);
  worker.onmessage({ data: [{ phraseLength: 4, offsets: [0, .5], copies: [
    lane.notes.slice(0, 8).map(n => n.id), identical.slice(1).map(n => n.id),
  ] }] });
  module.renderRepeatNavigator(); controls.repeatNext.click(); module.renderRepeatNavigator(); module.drawRepeats();
  controls.repeatChangePosition.value = `${identical[1].id}:${lane.notes[0].id}`;
  controls.repeatChangePosition.dispatchEvent(new Event('change')); module.renderRepeatNavigator();
  assert.deepEqual(rows(), [['Note', 'Not present', 'E2']], 'the absent opening remains inspectable inside the phrase');
  identical[1].end += .2; S.voicingRevision++;
  module.hideRepeatHover(); module.drawRepeats(); assert.equal(inspectNote(identical[1]), true);
  assert.ok(rows().some(row => row[0] === 'Length'));
  assert.ok(!rows().some(row => row[0] === 'Onset in passage'), 'onset is relative to the phrase, not its first surviving attack');
  controls.repeatClose.click(); module.renderRepeatNavigator();
  lane.notes = withOpening; S.voicingRevision++;
  lane.repeatGroups = []; S.voicingRevision++; module.renderRepeatNavigator();
  assert.equal(controls.repeatNavigator.hidden, true);

  // Every instance of a group is in one list.
  const originalNotes = lane.notes;
  const versions = [60.3, 70.3, 80.3, 90.3].map(start => make(start));
  versions[0][0].fx = versions[3][0].fx = { vibrato: true };
  lane.notes = versions.flat(); S.voicingRevision++;
  module.runFindRepeats(lane); worker.finish();
  module.renderRepeatNavigator(); module.drawRepeats();
  assert.equal(controls.repeatPosition.textContent, '1 / 4', 'one list of every instance');
  assert.deepEqual(controls.repeatInstance.children[1].children.map(row => row.children[0].textContent),
    ['Instance 1', 'Instance 2', 'Instance 3', 'Instance 4']);
  assert.equal(controls.repeatInstance.children[1].children.some(row => row.dataset?.focusKey?.startsWith('move:')
    || row.children.some(el => el.dataset?.focusKey?.startsWith('move:') || el.type === 'checkbox')), false,
    'no variations to move to, nothing to include or exclude');
  inspectNote(versions[0][0]);
  assert.deepEqual(rows()[0], ['Vibrato', 'On', 'Off'], 'the comparison covers every instance of the group');
  const chooseInstance = value => {
    controls.repeatInstance.value = value; controls.repeatInstance.dispatchEvent(new Event('change')); module.renderRepeatNavigator();
  };
  const beforeMove = commits;
  chooseInstance(versions[3][0].id);
  delete versions[0][0].fx; delete versions[3][0].fx;
  versions[2][2].pitch++; versions[3][2].pitch++;
  S.voicingRevision++; module.renderRepeatNavigator();
  assert.equal(changePosition(), '– / 1', 'one changed note counts once across repeated comparison patterns');
  controls.repeatChangeNext.click(); module.renderRepeatNavigator();
  assert.equal(changePosition(), '1 / 1');
  assert.equal(playhead, versions[3][2].start, 'change navigation seeks to the changed note');
  const selectedChange = controls.repeatChangePosition.children[1].value;
  controls.repeatChangePosition.value = selectedChange; controls.repeatChangePosition.dispatchEvent(new Event('change'));
  module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, false, 'the dropdown opens the selected changed note');
  assert.equal(playhead, versions[3][2].start, 'the change dropdown seeks to the selected note');
  controls.repeatChangeNext.click(); module.renderRepeatNavigator();
  assert.equal(controls.repeatPosition.textContent, '4 / 4', 'change navigation stays on the active instance');
  assert.equal(commits, beforeMove, 'choosing instances does not edit the project');
  // Beside the split view, the two shown instances are compared with each other alone.
  let side = 0;
  const host = { revealed: [], liveSide: () => side, isOpen: () => true, open() {}, reviewing() {}, reveal(at, how) { this.revealed.push({ ...at, ...how }); } };
  module.connectRepeatSplit(host);
  chooseInstance(versions[3][0].id);
  const beforePair = commits;
  module.pairRepeats(true); await Promise.resolve();
  assert.equal(host.revealed.length, 1, 'pairing shows another instance in the other pane');
  assert.deepEqual(zone(), { t0: versions[3][0].start, t1: versions[3].at(-1).end }, 'the playhead is held inside the shown instance');
  // As the split view swaps them: the pane's selection and its own playhead.
  let otherPlayhead = playhead;
  const otherPane = fn => {
    module.swapRepeatPane(); const mine = playhead; playhead = otherPlayhead;
    try { fn(); } finally { otherPlayhead = playhead; playhead = mine; module.swapRepeatPane(); }
  };
  otherPane(() => chooseInstance(versions[2][0].id));
  module.renderRepeatNavigator();
  assert.equal(controls.repeatPosition.textContent, '4 / 4', 'the live pane keeps its own instance');
  assert.equal(controls.repeatChangeNavigation.hidden, true, 'two instances that match show no differences');
  otherPane(() => chooseInstance(versions[1][0].id));
  module.renderRepeatNavigator();
  assert.equal(controls.repeatChangeNavigation.hidden, false, 'a different partner brings its differences');
  const pairChanges = changePosition();
  // The card compares with the other pane's instance, each value on its pane's side.
  module.hideRepeatHover(); inspectNote(versions[3][2]);
  assert.deepEqual(heads(), ['', 'Instance 4', '', 'Instance 2'], 'beside the split view, the other pane\'s instance');
  assert.deepEqual(rows(), [['Pitch', noteName(versions[3][2].pitch), noteName(versions[1][2].pitch)]]);
  side = 1; module.hideRepeatHover(); inspectNote(versions[3][2]);
  assert.deepEqual(heads(), ['', 'Instance 2', '', 'Instance 4'], 'with this pane on the right, its value is on the right');
  assert.deepEqual(rows()[0].slice(1), [noteName(versions[1][2].pitch), noteName(versions[3][2].pitch)]);
  side = 0; module.hideRepeatHover();
  // Choosing an instance: a linked other pane goes to the start of its own.
  const revealedBefore = host.revealed.length;
  chooseInstance(versions[0][0].id); chooseInstance(versions[3][0].id);
  assert.deepEqual(host.revealed.slice(revealedBefore).map(r => [r.t0, r.linked]), [[versions[1][0].start, true], [versions[1][0].start, true]],
    'the other pane is asked to its instance start, if linked');
  // The note compared on this side lights up on the other.
  const selectionBefore = S.selection;
  S.selection = new Set([versions[3][5]]); glows.length = 0;
  const scrolled = stageScroll.scrollLeft;
  otherPane(() => { stageScroll.scrollLeft = 700; module.drawRepeats(); stageScroll.scrollLeft = scrolled; });   // the other pane's own view
  assert.deepEqual(glows.map(g => g.x), [versions[1][5].start * 10], 'the counterpart lights up in the other pane');
  glows.length = 0; module.drawRepeats();
  assert.equal(glows.length, 0, 'not in the pane where it is selected');
  S.selection = selectionBefore;
  otherPane(() => module.renderRepeatNavigator());
  assert.equal(controls.repeatPosition.textContent, '2 / 4', 'the other pane has its own instance');
  assert.equal(changePosition(), pairChanges, 'and sees the same differences from its side');
  module.renderRepeatNavigator();
  // The other pane's instance can't be chosen here as well.
  assert.deepEqual(controls.repeatInstance.children[1].children.map(row => row.children[0].disabled), [false, true, false, false],
    'the other pane\'s instance is disabled in the picker');
  chooseInstance(versions[1][0].id);
  assert.equal(controls.repeatPosition.textContent, '4 / 4', 'and is refused when chosen');
  controls.repeatPrevious.click(); controls.repeatPrevious.click(); module.renderRepeatNavigator();
  assert.equal(controls.repeatPosition.textContent, '1 / 4', 'stepping passes over it');
  chooseInstance(versions[3][0].id);
  module.pairRepeats(false); module.renderRepeatNavigator();
  assert.equal(controls.repeatNavigator.hidden, true, 'closing the split view ends the review');
  assert.equal(zone, null, 'and frees the playhead');
  module.connectRepeatSplit(null);
  assert.equal(commits, beforePair, 'pairing panes does not edit the project');
  controls.repeatClose.click();
  // Difference buttons visit every entry once and wrap, including overlapping
  // sustains and missing notes. Browser media clocks may round seek positions.
  const navigationCopies = [make(.3), make(10.3)];
  navigationCopies[0][0].end = 1.2;
  navigationCopies[1][0].end = 11.2;
  for (const note of navigationCopies[1].slice(0, 4)) note.fx = { vibrato: true };
  const missingNavigationNote = navigationCopies[0].splice(4, 1)[0];
  lane.notes = navigationCopies.flat(); lane.repeatGroups = []; S.voicingRevision++;
  module.runFindRepeats(lane);
  worker.onmessage({ data: [{ phraseLength: 4, copies: navigationCopies.map(notes => notes.map(n => n.id)) }] });
  module.renderRepeatNavigator();
  const differenceKeys = controls.repeatChangePosition.children.slice(1).map(option => option.value);
  assert.equal(differenceKeys.length, 5);
  for (const rounding of [0, .002]) {
    seekRounding = rounding;
    controls.repeatChangePosition.value = differenceKeys[0];
    controls.repeatChangePosition.dispatchEvent(new Event('change')); module.renderRepeatNavigator();
    assert.equal(changePosition(), '1 / 5');
    for (const [button, direction] of [[controls.repeatChangeNext, 1], [controls.repeatChangePrevious, -1]]) {
      for (let step = 1; step <= differenceKeys.length * 2; step++) {
        button.click(); module.renderRepeatNavigator(); module.renderRepeatNavigator();
        const expected = (step * direction % differenceKeys.length + differenceKeys.length) % differenceKeys.length;
        assert.equal(controls.repeatChangePosition.value, differenceKeys[expected],
          `difference navigation advances once and wraps, direction ${direction}, step ${step}, rounding ${rounding}`);
        assert.equal(controls.repeatHover.hidden, false);
        assert.equal(controls.repeatPosition.textContent, '1 / 2', 'difference navigation retains the active instance');
      }
    }
  }
  seekRounding = 0;
  playhead = missingNavigationNote.start + .01; module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, true, 'the playhead on a note missing here opens nothing');
  playhead = navigationCopies[0][3].start + .01; module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, false, 'this instance\'s own differing note does');
  playhead = navigationCopies[0][4].start + .01; module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, true, 'moving to an unchanged note closes the preview');
  controls.repeatClose.click();
  // Back to back, one note ends as the next begins. A seek to the second lands a
  // microsecond early (Chromium reports media time in whole microseconds); the
  // playhead is on the second note all the same.
  const legato = [make(.3), make(10.3)].map(copy => copy.map(note => ({ ...note, end: note.start + .5 })));
  legato[1][2].pitch++;   // the third note differs, the fourth does not
  lane.notes = legato.flat(); lane.repeatGroups = []; S.voicingRevision++;
  module.runFindRepeats(lane);
  worker.onmessage({ data: [{ phraseLength: 4, copies: legato.map(notes => notes.map(n => n.id)) }] });
  module.renderRepeatNavigator();
  playhead = legato[0][2].start - 1e-6; module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, false, 'a seek just short of the differing note opens it');
  assert.deepEqual(rows()[0], ['Pitch', noteName(legato[0][2].pitch), noteName(legato[1][2].pitch)]);
  playhead = legato[0][3].start - 1e-6; module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, true, 'and one just short of the next note leaves it');
  controls.repeatClose.click();
  // A note only the other instance has, under the playhead beside one of this
  // instance's own: the card is about this instance's note.
  const extra = [make(.3), make(10.3)];
  extra[1].push({ id: 'extra', start: extra[1][2].start, end: extra[1][2].end, pitch: 52, pos: { string: 3, fret: 7 } });
  lane.notes = extra.flat(); lane.repeatGroups = []; S.voicingRevision++;
  module.runFindRepeats(lane);
  worker.onmessage({ data: [{ phraseLength: 4, copies: extra.map(notes => notes.map(n => n.id)) }] });
  module.renderRepeatNavigator(); module.drawRepeats();
  assert.ok(rectangles.some(r => r.color === 'orange' && r.dash.length), 'the other instance\'s note is outlined here');
  playhead = extra[0][2].start + .01; module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, true, 'but this instance\'s matching note opens no card for it');
  extra[0][2].finger = 2; S.voicingRevision++; module.renderRepeatNavigator();
  assert.deepEqual(rows(), [['Finger', '2', 'Not set']], 'its own difference does');
  controls.repeatClose.click();
  lane.notes = originalNotes; lane.repeatGroups = []; S.voicingRevision++;

  module.runFindRepeats(lane);
  lane.notes[0].pitch++;
  const count = commits;
  worker.finish();
  assert.equal(commits, count, 'stale results cannot overwrite an edited layer');
  module.runFindRepeats(lane); S.state = { editLanes: [lane], rowH: 10 }; worker.finish();
  assert.equal(commits, count, 'results from a closed project cannot modify its replacement');
  module.runFindRepeats(lane);
  const pending = worker;
  controls.repeatClose.click(); module.renderRepeatNavigator();
  assert.equal(pending.terminated, true);
  assert.equal(controls.repeatNavigator.hidden, true, 'close hides the stage navigation');
  assert.equal(S.selection, selection, 'closing keeps the note selection');
  active = null; module.renderRepeatNavigator();
  assert.equal(controls.repeatNavigator.hidden, true);
} finally { Object.assign(globalThis, original); }
console.log('Spectrogram instance review and note characteristics passed');
