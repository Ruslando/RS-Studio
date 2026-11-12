import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';
import { findRepeats } from '../../web/repeats-core.js';
class Element extends EventTarget {
  style = {}; dataset = {};
  classList = { add() {} };
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
  'repeatVariation', 'repeatVariationNavigation', 'repeatInstance', 'repeatDrag',
  'repeatChangeNavigation', 'repeatChangePrevious', 'repeatChangeNext', 'repeatChangePosition', 'repeatHover', 'repeatHoverRows', 'repeatHoverTitle',
  'repeatNoteNavigation', 'repeatNoteFirst', 'repeatNoteCurrent', 'repeatNoteVersion', 'repeatNoteJump', 'repeatHoverClose', 'repeatClose'];
const controls = Object.fromEntries(ids.map(id => [id, new Element()]));
const riff = [40, 43, 45, 47, 45, 43, 40, 38];
const make = (start, pitches = riff) => pitches.map((pitch, i) => ({ id: `${start}:${i}`, start: start + i / 2, end: start + i / 2 + .4, pitch, pos: { string: 5, fret: pitch - 35 } }));
const lane = { id: 'edit', name: 'Bass', visible: true, notes: [...make(.3), ...make(10.3, [...riff.slice(0, 7), 36])], refBoxes: {} };
lane.notes[10].pos = { string: 4, fret: 10 };
const selection = new Set([lane.notes[10]]);
const S = { state: { editLanes: [lane], rowH: 10 }, selection, voicingRevision: 0 };
const stageScroll = { scrollLeft: 0, clientWidth: 500, clientHeight: 300, scrollWidth: 10000, scrollHeight: 1000, scrollTop: 0 };
let playhead = 0, playing = false, seekRounding = 0;
const seeks = [];
let active = lane, commits = 0, movements = 0, fretboardOpens = 0, worker;
const rectangles = [], badges = [], previews = [], anchors = [];
let generatedFingers = new Map(), noteUid = 0, lockedNoteId = null, modalIsOpen = false;
const ctx = { save() {}, restore() {}, setLineDash(dash) { this.dash = dash; }, strokeText() {}, fillText(text) { badges.push(text); }, fillRect() {},
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
    './playback.js': { transportPlaying: () => playing, playbackTime: () => playhead, seekPlayback(time) { seeks.push(time); playhead = time - seekRounding; return playhead; } },
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
    './note-render.js': { noteRibbon: () => null }, './constants.js': { stageUi: () => '11px sans-serif' },
    './stage-paint.js': { PAINT: { trace: 'blue', warn: 'orange', error: 'pink', accent: 'cyan', ok: 'green' }, halo: () => 'black' },
  }, { './repeat-picker.js': true, './repeats-core.js': true, './util.js': true, './repeat-change-details.js': true, './whammy.js': true, './note-effects.js': true });
  module.init_repeats({ ...{ setHandAnchor(lane, t, fret) { lane.handHolds = (lane.handHolds || []).filter(h => h.t !== t); if (fret != null) lane.handHolds.push({t, fret}); commit(); } }, ...{ previewFretboardNote: (...args) => previews.push(args), setFretboardVisible: on => { assert.equal(on, true); fretboardOpens++; } } });
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
  assert.ok(badges.includes('Group A · instance 1'), 'the first occurrence has no special comparison label');
  assert.ok(rectangles.some(r => r.color === 'orange'), 'the first occurrence is also marked when another differs');
  const inspectNote = note => {
    playhead = -1; module.syncRepeatPlayhead();
    playhead = note.start + .01; module.syncRepeatPlayhead();
    return !controls.repeatHover.hidden;
  };
  const rows = () => controls.repeatHoverRows.children.map(row => [row.children[0].textContent, row.children[1].children[0]?.textContent]);
  const action = key => controls.repeatHoverRows.children.flatMap(row => row.children)
    .flatMap(cell => cell.children).flatMap(child => [child, ...child.children])
    .find(button => button.dataset.change === key);
  // The playhead opens notes without any pointer hit targets or canvas draw.
  assert.equal(module.hoverRepeatDifference, undefined, 'mouse hover cannot open a comparison');
  playhead = lane.notes[1].start + .1; module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, true, 'unchanged notes do not open the floating preview');
  playhead = lane.notes[2].start + .1; module.renderRepeatNavigator();
  assert.equal(previews.at(-1)[1], lane.notes[2]);
  playing = true; module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, true, 'starting playback hides the note preview');
  assert.equal(previews.at(-1).length, 0, 'starting playback clears the fretboard preview');
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
  assert.equal(previews.at(-1)[1], third[2]);
  assert.equal(seeks.length, seekCount, 'following playback never seeks the transport back');
  const beforePreview = structuredClone(lane.notes), beforePreviewCommits = commits;
  assert.equal(inspectNote(lane.notes[2]), true);
  assert.equal(controls.repeatNoteVersion.textContent, '1 / 3');
  assert.ok(rows().some(row => row.join('|') === 'Position|S6 · F10'));
  assert.ok(rows().some(row => row[0] === 'Pitch'));
  assert.ok(rows().some(row => row[0] === 'Length'));
  assert.ok(!rows().some(row => row[0] === 'Slide starts'), 'inactive effects do not crowd the card');
  assert.equal(previews.at(-1)[1], lane.notes[2]);
  controls.repeatNoteCurrent.click();
  assert.equal(controls.repeatNoteVersion.textContent, '2 / 3');
  assert.equal(previews.at(-1)[1], lane.notes[10]);
  assert.ok(rows().some(row => row.join('|') === 'Position|S5 · F10'));
  assert.equal(module.repeatPreviewHiddenNote(), lane.notes[2]);
  assert.ok(action('position'), 'an uncommon position offers the common value');
  assert.equal(action('position').title, undefined, 'Apply has no visible explanatory tooltip');
  action('position').dispatchEvent(new Event('mouseenter'));
  assert.ok(rows().some(row => row.join('|') === 'Position|S6 · F10'), 'Apply hover previews a common scalar value too');
  action('position').dispatchEvent(new Event('mouseleave'));
  assert.ok(rows().some(row => row.join('|') === 'Position|S5 · F10'), 'leaving restores the scalar value');
  assert.equal(controls.repeatHoverRows.children.find(row => row.children[0].textContent === 'Position').children[1].className, 'repeat-uncommon', 'the one uncommon position is highlighted');
  controls.repeatNoteCurrent.click();
  assert.equal(controls.repeatNoteVersion.textContent, '3 / 3');
  assert.equal(previews.at(-1)[1], third[2]);
  assert.ok(rows().some(row => row.join('|') === 'Position|S6 · F10'));
  controls.repeatNoteCurrent.click();
  assert.equal(controls.repeatNoteVersion.textContent, '1 / 3', 'the note arrows wrap through all occurrences');
  assert.equal(module.repeatPreviewHiddenNote(), null);
  controls.repeatNoteFirst.click();
  assert.equal(controls.repeatNoteVersion.textContent, '3 / 3', 'backward navigation wraps too');
  const projected = module.repeatPreviewNote();
  assert.equal(projected.source, third[2]);
  assert.equal(projected.note.start, lane.notes[2].start);
  assert.equal(projected.alpha, .55);
  assert.notEqual(controls.repeatHoverRows.children.find(row => row.children[0].textContent === 'Position').children[1].className, 'repeat-uncommon', 'the common position is not highlighted');
  assert.deepEqual(lane.notes, beforePreview, 'previewing never edits notes');
  assert.equal(commits, beforePreviewCommits, 'previewing adds no undo steps');
  assert.equal(S.selection, selection);
  window.dispatchEvent(new Event('mousemove'));
  window.dispatchEvent(new Event('mousedown'));
  window.dispatchEvent(new Event('wheel'));
  assert.equal(controls.repeatHover.hidden, false, 'mouse activity does not dismiss the playhead comparison');

  module.hideRepeatHover();
  module.drawRepeats(); inspectNote(lane.notes[2]); controls.repeatNoteCurrent.click();
  const originalPosition = structuredClone(lane.notes[10].pos), countBeforeApply = commits;
  lockedNoteId = lane.notes[10].id;
  controls.repeatNoteCurrent.click(); controls.repeatNoteFirst.click();
  assert.equal(action('position').disabled, true, 'locked references cannot receive the common value');
  lockedNoteId = null;
  controls.repeatNoteCurrent.click(); controls.repeatNoteFirst.click();
  action('position').click();
  assert.deepEqual(lane.notes[10].pos, lane.notes[2].pos, 'Apply updates the displayed occurrence');
  assert.equal(commits, countBeforeApply + 1, 'the common value is one undoable edit');
  assert.equal(controls.repeatHover.hidden, true, 'resolving the last difference closes the preview');
  lane.notes[10].pos = originalPosition; S.voicingRevision++; module.renderRepeatNavigator();
  module.drawRepeats(); inspectNote(lane.notes[2]); controls.repeatNoteCurrent.click(); controls.repeatNoteJump.click();
  assert.equal(controls.repeatNoteVersion.textContent, '2 / 3');
  assert.equal(action('position'), undefined, 'the middle occurrence already matches its default suggestion');
  lane.notes[10].pos = originalPosition; S.voicingRevision++; controls.repeatPrevious.click(); module.renderRepeatNavigator();
  module.drawRepeats(); inspectNote(lane.notes[2]); controls.repeatNoteFirst.click();
  controls.repeatNoteJump.click(); module.renderRepeatNavigator();
  assert.equal(controls.repeatPosition.textContent, '3 / 3', 'jump activates the displayed instance');
  assert.equal(controls.repeatNoteVersion.textContent, '3 / 3');
  assert.equal(previews.at(-1)[1], third[2], 'jump keeps the corresponding note open on the fretboard');
  assert.equal(controls.repeatHover.hidden, false);
  assert.equal(module.repeatPreviewHiddenNote(), null, 'the destination is shown as its actual note');
  assert.deepEqual(lane.notes, beforePreview, 'jumping does not change notes');
  assert.equal(S.selection, selection, 'jumping preserves the selection');
  controls.repeatPrevious.click(); controls.repeatPrevious.click(); module.renderRepeatNavigator();

  third[0].fx = { vibrato: true }; S.voicingRevision++; module.renderRepeatNavigator();
  module.drawRepeats(); inspectNote(lane.notes[0]); controls.repeatNoteFirst.click();
  const direction = (key, target) => controls.repeatHoverRows.children.flatMap(row => row.children).flatMap(cell => cell.children)
    .find(button => button.dataset.change === key && button.dataset.target === String(target));
  const beforeVibrato = commits;
  direction('fx.vibrato', 0).click();
  assert.equal(lane.notes[0].fx.vibrato, true, 'the previewed vibrato can be applied to the opened note');
  assert.equal(third[0].fx.vibrato, true);
  assert.equal(commits, beforeVibrato + 1);
  delete lane.notes[0].fx; S.voicingRevision++; module.renderRepeatNavigator();
  module.drawRepeats(); inspectNote(lane.notes[0]); controls.repeatNoteFirst.click();
  direction('fx.vibrato', 2).click();
  assert.ok(!third[0].fx?.vibrato, 'the opened absence can remove vibrato from the previewed note');
  assert.equal(controls.repeatHover.hidden, true, 'resolving vibrato closes the preview');
  assert.equal(S.selection, selection);
  module.hideRepeatHover();
  const lengthNotes = [lane.notes[0], lane.notes[8], third[0]], oldEnds = lengthNotes.map(note => note.end);
  lengthNotes.forEach((note, i) => { note.end = note.start + [.4, .6, .8][i]; });
  S.voicingRevision++; module.renderRepeatNavigator(); module.drawRepeats(); inspectNote(lane.notes[0]); controls.repeatNoteFirst.click();
  controls.repeatNoteJump.click();
  const medianAction = action('length');
  medianAction.dispatchEvent(new Event('mouseenter'));
  assert.ok(rows().some(row => row.join('|') === 'Length|0.6 beats'), 'Apply previews the median length');
  assert.ok(Math.abs(third[0].end - third[0].start - .8) < 1e-9, 'hovering does not apply the length');
  medianAction.click();
  assert.ok(Math.abs(third[0].end - third[0].start - .6) < 1e-9, 'Apply sets the median length');
  lengthNotes.forEach((note, i) => { note.end = oldEnds[i]; }); S.voicingRevision++; controls.repeatPrevious.click(); controls.repeatPrevious.click(); module.renderRepeatNavigator();
  module.drawRepeats(); inspectNote(lane.notes[4]);
  const absentCurveHeading = controls.repeatHoverRows.children.find(row => row.children[0].textContent === 'Whammy curve').children[0];
  assert.equal(absentCurveHeading.className, 'repeat-curve-unavailable', 'an absent curve has a red label');
  assert.equal(absentCurveHeading.attributes['aria-label'], 'Whammy curve unavailable');
  module.hideRepeatHover();
  for (const note of [lane.notes[4], lane.notes[12]]) {
    note.whammy = 'dip'; note.whammyPoints = [[0, 0], [.4, -1], [1, 0]];
  }
  S.voicingRevision++; module.renderRepeatNavigator();
  module.drawRepeats(); assert.equal(inspectNote(lane.notes[4]), true, "whammy note is a hover target"); controls.repeatNoteFirst.click();
  const curveRow = controls.repeatHoverRows.children.find(row => row.children[0].textContent === 'Whammy curve');
  assert.ok(curveRow, JSON.stringify({rows: rows(), version: controls.repeatNoteVersion.textContent, preview: previews.at(-1)?.[1]}));
  assert.equal(curveRow.children[1].children[0].attributes.viewBox, '0 0 96 28');
  assert.equal(curveRow.children[1].children[0].children.filter(child => child.attributes.class === 'repeat-curve-point').length, 3, 'the curve shows each control point');
  assert.ok(!rows().some(row => row[0] === 'Whammy'), 'the separate whammy kind row is omitted');
  const priorPath = curveRow.children[1].children[0].children[1].attributes.d;
  const previewNotes = structuredClone(lane.notes), previewCommits = commits;
  action('whammyPoints').dispatchEvent(new Event('mouseenter'));
  assert.notEqual(curveRow.children[1].children[0].children[1].attributes.d, priorPath, 'Apply hover replaces the graph with the common curve');
  action('whammyPoints').dispatchEvent(new Event('mouseleave'));
  assert.equal(curveRow.children[1].children[0].children[1].attributes.d, priorPath, 'leaving Apply restores the current curve');
  assert.deepEqual(lane.notes, previewNotes, 'Apply hover does not mutate notes');
  assert.equal(commits, previewCommits, 'Apply hover adds no undo step');
  assert.equal(curveRow.children[1].className, 'repeat-uncommon', 'the unusual curve is highlighted');
  assert.ok(action('whammyPoints'), 'the uncommon curve offers the common curve');
  third[4].whammyPoints = [[0, 0], [.7, -1], [1, 0]]; S.voicingRevision++;
  module.renderRepeatNavigator(); rectangles.length = 0; module.drawRepeats();
  inspectNote(lane.notes[4]); controls.repeatNoteFirst.click();
  const updatedCurve = controls.repeatHoverRows.children.find(row => row.children[0].textContent === 'Whammy curve');
  assert.equal(updatedCurve.children[1].children[0].attributes.viewBox, '0 0 96 28');
  assert.equal(updatedCurve.children[1].className, 'repeat-uncommon', 'different curve timing remains highlighted');
  assert.ok(!updatedCurve.children[1].children.some(child => child.textContent === 'Points differ'), 'redundant difference text is omitted');
  assert.ok(rectangles.some(rect => rect.color === 'orange' && Math.abs(rect.rect[0] - (lane.notes[4].start * 10 - 2)) < 1e-5),
    'the stage indicates the different curve points');
  const curveBeforeApply = commits, sourceCurve = structuredClone(lane.notes[4].whammyPoints);
  action('whammyPoints').click();
  assert.deepEqual(third[4].whammyPoints, sourceCurve, 'Apply copies the common curve points');
  assert.notEqual(third[4].whammyPoints, lane.notes[4].whammyPoints, 'the curves do not share mutable data');
  assert.equal(commits, curveBeforeApply + 1);
  assert.equal(controls.repeatHover.hidden, true, 'matching the common curve closes the preview');
  module.hideRepeatHover();
  for (const note of [lane.notes[4], lane.notes[12]]) { delete note.whammy; delete note.whammyPoints; }
  third[4].whammyPoints = [[0, 0], [.5, -2], [1, 0]]; S.voicingRevision++;

  // A missing counterpart can be previewed, including its frequency.
  const manualReplacement = { ...missingThird, id: 'drawn-after-scan' };
  lane.notes.push(manualReplacement); S.voicingRevision++; module.renderRepeatNavigator();
  module.drawRepeats();
  assert.equal(inspectNote(lane.notes[3]), false, 'a matching replacement clears the missing-note preview');
  lane.notes = lane.notes.filter(note => note !== manualReplacement); S.voicingRevision++; module.renderRepeatNavigator();
  module.drawRepeats(); inspectNote(lane.notes[3]); controls.repeatNoteFirst.click();
  assert.equal(controls.repeatNoteVersion.textContent, '3 / 3');
  assert.deepEqual(rows(), [['Note', 'Missing']]);
  assert.equal(controls.repeatHoverRows.children[0].children[1].className, 'repeat-uncommon');
  assert.equal(previews.at(-1)[1], null);
  assert.ok(action('presence'), 'a missing note offers the common presence');
  const savedIds = lane.repeatGroups[0].copies[2];
  action('presence').click();
  const recreated = lane.notes.find(note => note.id.startsWith('new'));
  assert.ok(recreated, 'Apply adds a missing counterpart');
  assert.equal(recreated.start, missingThird.start);
  assert.equal(controls.repeatHover.hidden, true, 'filling the missing note closes the resolved preview');
  lane.notes = lane.notes.filter(note => note !== recreated);
  savedIds.splice(savedIds.indexOf(recreated.id), 1); S.voicingRevision++; module.renderRepeatNavigator();
  module.drawRepeats(); inspectNote(lane.notes[3]); controls.repeatNoteFirst.click();
  controls.repeatNoteJump.click(); module.renderRepeatNavigator();
  assert.equal(controls.repeatPosition.textContent, '3 / 3', 'jump reaches the occurrence with a missing note');
  assert.equal(controls.repeatHover.hidden, false, 'the missing note remains open after jumping');
  assert.deepEqual(rows(), [['Note', 'Missing']]);
  module.hideRepeatHover();
  assert.equal(controls.repeatPosition.textContent, '3 / 3');
  rectangles.length = 0; module.drawRepeats();
  const ghost = rectangles.find(r => r.color === 'orange' && r.dash.length);
  assert.ok(ghost, 'the missing note uses the same color with a dashed outline');
  assert.ok(rectangles.filter(r => r.color !== 'blue').every(r => r.color === 'orange'), 'all note differences use one color');
  assert.equal(inspectNote(missingThird), true);
  assert.deepEqual(rows(), [['Note', 'Missing']]);
  controls.repeatNoteCurrent.click();
  assert.equal(controls.repeatNoteVersion.textContent, '1 / 3');
  assert.equal(previews.at(-1)[1], lane.notes[3], 'a missing note can preview a present occurrence');
  controls.repeatNoteJump.click(); module.renderRepeatNavigator();
  assert.equal(controls.repeatPosition.textContent, '1 / 3', 'jump from a missing note reaches its present counterpart');
  assert.equal(controls.repeatHover.hidden, false);
  module.hideRepeatHover();

  // The common presence can also be absence when the other instances omit a note.
  const notesBeforeRemoval = lane.notes, uniqueNote = lane.notes[3], secondNoteId = lane.notes[11].id;
  lane.notes = lane.notes.filter(note => note.id !== secondNoteId); S.voicingRevision++; module.renderRepeatNavigator();
  module.drawRepeats(); inspectNote(uniqueNote);
  assert.equal(action('presence').attributes['aria-label'], 'Remove this note to match the common absence');
  const removalCommit = commits;
  action('presence').click();
  assert.ok(!lane.notes.includes(uniqueNote), 'Apply can match a common absence');
  assert.equal(commits, removalCommit + 1);
  assert.equal(controls.repeatHover.hidden, true, 'the card closes when no corresponding note remains');
  lane.notes = notesBeforeRemoval; S.voicingRevision++; module.renderRepeatNavigator();

  // Identical notes leave the floating preview closed.
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
  assert.equal(controls.repeatHover.hidden, true, 'an unchanged destination does not open a preview');
  assert.equal(playhead, identical[0].start);
  key('ArrowLeft', { altKey: true }); assert.equal(controls.repeatPosition.textContent, '1 / 2');
  module.drawRepeats(); assert.equal(inspectNote(lane.notes[0]), false, 'unchanged notes stay closed');
  assert.equal(S.selection, selection);
  module.hideRepeatHover();
  lane.notes[0].finger = 4; identical[0].finger = 3;
  lane.handHolds = [{ t: lane.notes[0].start, fret: 5 }, { t: identical[0].start, fret: 6 }];
  S.voicingRevision++; module.renderRepeatNavigator(); module.drawRepeats(); inspectNote(lane.notes[0]); controls.repeatNoteCurrent.click();
  assert.equal(controls.repeatChangeNavigation.hidden, false, 'navigation reappears after a new difference');
  const fieldCell = label => controls.repeatHoverRows.children.find(row => row.children[0].textContent === label).children[1];
  assert.equal(fieldCell('Finger').className, 'repeat-uncommon', 'a two-instance tie compares against the opened note');
  assert.ok(rows().some(row => row.join('|') === 'Hand anchor|F6'));
  assert.equal(fieldCell('Hand anchor').className, 'repeat-uncommon');
  action('handAnchor').click();
  assert.ok(lane.handHolds.some(h => h.t === identical[0].start && h.fret === 5), 'Apply copies the anchor to the displayed occurrence');
  assert.equal(action('handAnchor'), undefined);
  controls.repeatNoteJump.click(); module.renderRepeatNavigator(); controls.repeatNoteFirst.click();
  assert.ok(rows().some(row => row.join('|') === 'Finger|4'));
  assert.equal(fieldCell('Finger').className, 'repeat-uncommon', 'opening the other occurrence reverses the comparison');
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
  assert.equal(inspectNote(identical[0]), true);
  assert.deepEqual(rows(), [['Note', 'Missing']], 'the absent opening remains inspectable inside the phrase');
  identical[1].end += .2; S.voicingRevision++;
  module.hideRepeatHover(); module.drawRepeats(); assert.equal(inspectNote(identical[1]), true);
  assert.ok(rows().some(row => row.join('|') === 'Onset in passage|0.5 beats'), 'tooltip onset is relative to the phrase, not its first surviving attack');
  controls.repeatClose.click(); module.renderRepeatNavigator();
  lane.notes = withOpening; S.voicingRevision++;
  lane.repeatGroups = []; S.voicingRevision++; module.renderRepeatNavigator();
  assert.equal(controls.repeatNavigator.hidden, true);

  // Comparison suggestions and previews stay inside the chosen variation.
  const originalNotes = lane.notes;
  const versions = [60.3, 70.3, 80.3, 90.3].map(start => make(start));
  versions[0][0].fx = versions[3][0].fx = { vibrato: true };
  lane.notes = versions.flat(); S.voicingRevision++;
  module.runFindRepeats(lane); worker.finish();
  const group = lane.repeatGroups[0];
  group.variations = [{ id: 'variation_1', name: 'Variation A', copies: [versions[0][0].id, versions[3][0].id] },
    { id: 'variation_2', name: 'Variation B', copies: [versions[1][0].id, versions[2][0].id] }];
  S.voicingRevision++;
  controls.repeatVariation.value = 'variation_1'; controls.repeatVariation.dispatchEvent(new Event('change'));
  module.renderRepeatNavigator(); module.drawRepeats();
  assert.equal(controls.repeatPosition.textContent, '1 / 2 · #1');
  assert.equal(inspectNote(versions[0][0]), false, 'identical notes within a variation do not open a preview');
  const chooseVariation = value => {
    controls.repeatVariation.value = value; controls.repeatVariation.dispatchEvent(new Event('change')); module.renderRepeatNavigator();
  };
  chooseVariation('all'); module.drawRepeats(); inspectNote(versions[0][0]);
  assert.equal(controls.repeatNoteVersion.textContent, '1 / 4');
  assert.ok(action('fx.vibrato'), 'whole-group comparison can inspect differences between variations');
  chooseVariation('variation_1');
  controls.repeatNext.click(); module.renderRepeatNavigator();
  assert.equal(controls.repeatPosition.textContent, '2 / 2 · #4');
  const chooseInstance = value => {
    controls.repeatInstance.value = value; controls.repeatInstance.dispatchEvent(new Event('change')); module.renderRepeatNavigator();
  };
  const beforeMove = commits;
  chooseInstance('move:variation_2');
  assert.equal(commits, beforeMove + 1, 'manual assignment is one undoable annotation edit');
  assert.equal(lane.repeatGroups[0].variationMode, 'manual');
  assert.deepEqual(lane.repeatGroups[0].variations.map(v => v.copies.length), [1, 3]);
  assert.equal(controls.repeatPosition.textContent, '3 / 3 · #4');
  lane.locked = true; chooseInstance('move:new');
  assert.equal(commits, beforeMove + 1, 'locked layers cannot receive manual assignments');
  lane.locked = false;
  chooseVariation('all');
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
  assert.equal(controls.repeatInstance.children[1].children.some(option => option.dataset.focusKey === 'move:new'), true);
  assert.equal(controls.repeatVariation.children[1].children.some(option => option.dataset.focusKey?.startsWith('move:')), false);
  const visibilityCheckbox = controls.repeatInstance.children[1].children[0].children[1];
  assert.equal(visibilityCheckbox.type, 'checkbox');
  visibilityCheckbox.checked = false; visibilityCheckbox.dispatchEvent(new Event('change')); module.renderRepeatNavigator();
  assert.equal(controls.repeatChangeNavigation.hidden, false, 'the remaining seen counterpart still differs');
  chooseInstance(`toggle:${versions[1][0].id}`);
  assert.equal(controls.repeatChangeNavigation.hidden, true, 'unseen instances do not contribute differences');
  chooseInstance(versions[0][0].id);
  assert.equal(controls.repeatPosition.textContent, '1 / 4', 'unseen instances remain available in the instance dropdown');
  assert.equal(playhead, versions[0][0].start, 'the instance dropdown seeks to the chosen instance');
  assert.equal(controls.repeatChangeNavigation.hidden, true, 'an unseen active instance is inspectable without comparison suggestions');
  chooseVariation('toggle:variation_1');
  assert.equal(controls.repeatChangeNavigation.hidden, false, 'a partially seen variation can include all of its instances');
  chooseVariation('toggle:variation_1');
  assert.equal(controls.repeatChangeNavigation.hidden, true, 'a whole variation can be excluded');
  assert.equal(commits, beforeMove + 1, 'comparison visibility does not edit the project');
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
  assert.equal(controls.repeatHover.hidden, false, 'a missing note still opens the preview');
  playhead = navigationCopies[0][4].start + .01; module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, true, 'moving to an unchanged note closes the preview');
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
