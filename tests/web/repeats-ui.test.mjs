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
  setAttribute(key, value) { this.attributes[key] = value; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
const ids = ['repeatNavigator', 'repeatGroup', 'repeatGroupPrevious', 'repeatGroupNext', 'repeatPosition', 'repeatPrevious', 'repeatNext',
  'repeatChangePrevious', 'repeatChangeNext', 'repeatChangePosition', 'repeatHover', 'repeatHoverRows', 'repeatHoverTitle',
  'repeatNoteNavigation', 'repeatNoteFirst', 'repeatNoteCurrent', 'repeatNoteVersion', 'repeatNoteJump', 'repeatHoverClose', 'repeatClose'];
const controls = Object.fromEntries(ids.map(id => [id, new Element()]));
const riff = [40, 43, 45, 47, 45, 43, 40, 38];
const make = (start, pitches = riff) => pitches.map((pitch, i) => ({ id: `${start}:${i}`, start: start + i / 2, end: start + i / 2 + .4, pitch, pos: { string: 5, fret: pitch - 35 } }));
const lane = { id: 'edit', name: 'Bass', visible: true, notes: [...make(.3), ...make(10.3, [...riff.slice(0, 7), 36])], refBoxes: {} };
lane.notes[10].pos = { string: 4, fret: 10 };
const selection = new Set([lane.notes[10]]);
const S = { state: { editLanes: [lane], rowH: 10 }, selection, voicingRevision: 0 };
const stageScroll = { scrollLeft: 0, clientWidth: 500, clientHeight: 300, scrollWidth: 10000, scrollHeight: 1000, scrollTop: 0 };
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
    const data = findRepeats(this.notes).map(r => ({ copies: r.copies.map(c => c.notes.map(n => n.note.id)) }));
    this.onmessage({ data });
  }
}
const original = { document: globalThis.document, window: globalThis.window, Worker: globalThis.Worker, URL: globalThis.URL };
try {
  globalThis.window = new EventTarget();
  globalThis.document = { getElementById: id => controls[id], createElement: () => new Element(), createElementNS: () => new Element(), activeElement: null, body: new Element() };
  globalThis.Worker = TestWorker;
  globalThis.URL = class extends original.URL {
    constructor(path, base) { super(path, String(base).startsWith('data:') ? 'file:///web/repeats.js' : base); }
  };
  const commit = () => { commits++; S.voicingRevision++; };
  const module = await mockImport(new original.URL('../../web/repeats.js', import.meta.url), {
    './store.js': { S },
    './edit.js': { snapshotEdit: () => ({}), commitStructure: commit, commit, setHandAnchor(lane, t, fret) { lane.handHolds = (lane.handHolds || []).filter(h => h.t !== t); if (fret != null) lane.handHolds.push({t, fret}); commit(); } },
    './dom.js': { scroll: stageScroll, sctx: ctx, stage: { getBoundingClientRect: () => ({ left: 20, top: 30 }) } },
    './geometry.js': { xOf: t => t * 10, yOf: pitch => 100 - pitch },
    './lanes.js': { activeLane: () => active, canEditLane: lane => !!lane?.visible && !lane.locked, refreshCounts() {} },
    './references.js': { boxOfNote: note => note?.id === lockedNoteId ? { group: { locked: true } } : null, laneClock: () => ({ beatAt: t => t, timeAt: b => b }), noteBounds: notes => ({ t0: Math.min(...notes.map(n => n.start)), t1: Math.max(...notes.map(n => n.end)), pLo: Math.min(...notes.map(n => n.pitch)), pHi: Math.max(...notes.map(n => n.pitch)) }) },
    './repaint.js': { draw() {} }, './notify.js': { toast() {} },
    './modal-focus.js': { modalOpen: () => modalIsOpen },
    './viewport-motion.js': { manualViewportNavigation() {}, moveViewportTo(x, y) { movements++; stageScroll.scrollLeft = Math.max(0, x); stageScroll.scrollTop = Math.max(0, y); } },
    './tablature.js': { refreshTabIfOpen() {}, laneFingering: async () => ({ fingers: new Map(generatedFingers) }) },
    './fretboard.js': { previewFretboardNote: (...args) => previews.push(args), setFretboardVisible: on => { assert.equal(on, true); fretboardOpens++; } },
    './escape-stack.js': { ESC_DEPTH: { transient: 20, popover: 100 }, registerEscapeLayer() {} },
    './tracing.js': { clearMatches() {} },
    './floating-position.js': { placeFloatingAvoiding: (...args) => anchors.push(args) }, './tooltip.js': { hideTooltip() {} },
    './ids.js': { nid: () => `new${++noteUid}` },
    './note-render.js': { noteRibbon: () => null }, './constants.js': { stageUi: () => '11px sans-serif' },
    './stage-paint.js': { PAINT: { trace: 'blue', warn: 'orange', error: 'pink', accent: 'cyan', ok: 'green' }, halo: () => 'black' },
  }, { './repeats-core.js': true, './util.js': true, './repeat-change-details.js': true, './whammy.js': true, './note-effects.js': true });
  module.init_repeats();
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
  assert.equal(controls.repeatGroup.children[0].textContent, 'Group 1');

  const third = make(20.3);
  third[4].whammy = 'dip'; third[4].whammyPoints = [[0, 0], [.5, -2], [1, 0]];
  const missingThird = third[3];
  lane.notes.push(...third.filter(note => note !== missingThird));
  lane.repeatGroups[0].copies.push(third.map(note => note.id)); S.voicingRevision++;
  module.renderRepeatNavigator(); module.drawRepeats();
  assert.ok(badges.includes('Group 1 · instance 1'), 'the first occurrence has no special comparison label');
  assert.ok(rectangles.some(r => r.color === 'orange'), 'the first occurrence is also marked when another differs');
  const hoverNote = note => module.hoverRepeatDifference(note.start * 10 + 1, 100 - note.pitch, 200, 200);
  const rows = () => controls.repeatHoverRows.children.map(row => [row.children[0].textContent, row.children[1].children[0]?.textContent]);
  const action = key => controls.repeatHoverRows.children.flatMap(row => row.children)
    .flatMap(cell => cell.children).flatMap(child => [child, ...child.children])
    .find(button => button.dataset.change === key);
  const beforePreview = structuredClone(lane.notes), beforePreviewCommits = commits;
  assert.equal(hoverNote(lane.notes[2]), true);
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
  module.scheduleRepeatHoverHide();
  await new Promise(resolve => setTimeout(resolve, 275));
  assert.equal(controls.repeatHover.hidden, false, 'preview arrows keep the card open');

  module.hideRepeatHover();
  module.drawRepeats(); hoverNote(lane.notes[2]); controls.repeatNoteCurrent.click();
  const originalPosition = structuredClone(lane.notes[10].pos), countBeforeApply = commits;
  lockedNoteId = lane.notes[10].id;
  controls.repeatNoteCurrent.click(); controls.repeatNoteFirst.click();
  assert.equal(action('position').disabled, true, 'locked references cannot receive the common value');
  lockedNoteId = null;
  controls.repeatNoteCurrent.click(); controls.repeatNoteFirst.click();
  action('position').click();
  assert.deepEqual(lane.notes[10].pos, lane.notes[2].pos, 'Apply updates the displayed occurrence');
  assert.equal(commits, countBeforeApply + 1, 'the common value is one undoable edit');
  assert.equal(controls.repeatHover.hidden, false);
  assert.equal(action('position'), undefined, 'the resolved value no longer offers Apply');
  lane.notes[10].pos = originalPosition; S.voicingRevision++; module.renderRepeatNavigator();
  module.drawRepeats(); hoverNote(lane.notes[2]); controls.repeatNoteCurrent.click(); controls.repeatNoteJump.click();
  assert.equal(controls.repeatNoteVersion.textContent, '2 / 3');
  assert.equal(action('position'), undefined, 'the middle occurrence already matches its default suggestion');
  lane.notes[10].pos = originalPosition; S.voicingRevision++; controls.repeatPrevious.click(); module.renderRepeatNavigator();
  module.drawRepeats(); hoverNote(lane.notes[2]); controls.repeatNoteFirst.click();
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
  module.drawRepeats(); hoverNote(lane.notes[0]); controls.repeatNoteFirst.click();
  const direction = (key, target) => controls.repeatHoverRows.children.flatMap(row => row.children).flatMap(cell => cell.children)
    .find(button => button.dataset.change === key && button.dataset.target === String(target));
  const beforeVibrato = commits;
  direction('fx.vibrato', 0).click();
  assert.equal(lane.notes[0].fx.vibrato, true, 'the previewed vibrato can be applied to the opened note');
  assert.equal(third[0].fx.vibrato, true);
  assert.equal(commits, beforeVibrato + 1);
  delete lane.notes[0].fx; S.voicingRevision++; module.renderRepeatNavigator();
  module.drawRepeats(); hoverNote(lane.notes[0]); controls.repeatNoteFirst.click();
  direction('fx.vibrato', 2).click();
  assert.ok(!third[0].fx?.vibrato, 'the opened absence can remove vibrato from the previewed note');
  assert.equal(controls.repeatHover.hidden, false);
  assert.equal(S.selection, selection);
  module.hideRepeatHover();
  const lengthNotes = [lane.notes[0], lane.notes[8], third[0]], oldEnds = lengthNotes.map(note => note.end);
  lengthNotes.forEach((note, i) => { note.end = note.start + [.4, .6, .8][i]; });
  S.voicingRevision++; module.renderRepeatNavigator(); module.drawRepeats(); hoverNote(lane.notes[0]); controls.repeatNoteFirst.click();
  controls.repeatNoteJump.click();
  const medianAction = action('length');
  medianAction.dispatchEvent(new Event('mouseenter'));
  assert.ok(rows().some(row => row.join('|') === 'Length|0.6 beats'), 'Apply previews the median length');
  assert.ok(Math.abs(third[0].end - third[0].start - .8) < 1e-9, 'hovering does not apply the length');
  medianAction.click();
  assert.ok(Math.abs(third[0].end - third[0].start - .6) < 1e-9, 'Apply sets the median length');
  lengthNotes.forEach((note, i) => { note.end = oldEnds[i]; }); S.voicingRevision++; controls.repeatPrevious.click(); controls.repeatPrevious.click(); module.renderRepeatNavigator();
  module.drawRepeats(); hoverNote(lane.notes[4]);
  const absentCurveHeading = controls.repeatHoverRows.children.find(row => row.children[0].textContent === 'Whammy curve').children[0];
  assert.equal(absentCurveHeading.className, 'repeat-curve-unavailable', 'an absent curve has a red label');
  assert.equal(absentCurveHeading.attributes['aria-label'], 'Whammy curve unavailable');
  module.hideRepeatHover();
  for (const note of [lane.notes[4], lane.notes[12]]) {
    note.whammy = 'dip'; note.whammyPoints = [[0, 0], [.4, -1], [1, 0]];
  }
  S.voicingRevision++; module.renderRepeatNavigator();
  module.drawRepeats(); assert.equal(hoverNote(lane.notes[4]), true, "whammy note is a hover target"); controls.repeatNoteFirst.click();
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
  hoverNote(lane.notes[4]); controls.repeatNoteFirst.click();
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
  assert.equal(controls.repeatHover.hidden, false);
  assert.equal(action('whammyPoints'), undefined, 'matching the common points clears Apply');
  module.hideRepeatHover();
  for (const note of [lane.notes[4], lane.notes[12]]) { delete note.whammy; delete note.whammyPoints; }
  third[4].whammyPoints = [[0, 0], [.5, -2], [1, 0]]; S.voicingRevision++;

  // A missing counterpart can be previewed, including its frequency.
  const manualReplacement = { ...missingThird, id: 'drawn-after-scan' };
  lane.notes.push(manualReplacement); S.voicingRevision++; module.renderRepeatNavigator();
  module.drawRepeats(); hoverNote(lane.notes[3]); controls.repeatNoteFirst.click();
  assert.equal(previews.at(-1)[1], manualReplacement, 'a manually drawn replacement appears in the instance preview');
  assert.ok(!rows().some(row => row.join('|') === 'Note|Missing'), 'the live tooltip clears the obsolete missing status');
  lane.notes = lane.notes.filter(note => note !== manualReplacement); S.voicingRevision++; module.renderRepeatNavigator();
  module.drawRepeats(); hoverNote(lane.notes[3]); controls.repeatNoteFirst.click();
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
  assert.equal(controls.repeatHover.hidden, false);
  lane.notes = lane.notes.filter(note => note !== recreated);
  savedIds.splice(savedIds.indexOf(recreated.id), 1); S.voicingRevision++; module.renderRepeatNavigator();
  module.drawRepeats(); hoverNote(lane.notes[3]); controls.repeatNoteFirst.click();
  controls.repeatNoteJump.click(); module.renderRepeatNavigator();
  assert.equal(controls.repeatPosition.textContent, '3 / 3', 'jump reaches the occurrence with a missing note');
  assert.equal(controls.repeatHover.hidden, false, 'the missing note remains open after jumping');
  assert.deepEqual(rows(), [['Note', 'Missing']]);
  module.hideRepeatHover();
  assert.equal(controls.repeatPosition.textContent, '3 / 3');
  rectangles.length = 0; module.drawRepeats();
  const ghost = rectangles.find(r => r.color === 'pink' && r.dash.length);
  assert.ok(ghost, 'the missing note is visible inside the third occurrence');
  assert.equal(module.hoverRepeatDifference(missingThird.start * 10 + 1, 100 - missingThird.pitch, 200, 200), true);
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
  module.drawRepeats(); hoverNote(uniqueNote);
  assert.equal(action('presence').attributes['aria-label'], 'Remove this note to match the common absence');
  const removalCommit = commits;
  action('presence').click();
  assert.ok(!lane.notes.includes(uniqueNote), 'Apply can match a common absence');
  assert.equal(commits, removalCommit + 1);
  assert.equal(controls.repeatHover.hidden, true, 'the card closes when no corresponding note remains');
  lane.notes = notesBeforeRemoval; S.voicingRevision++; module.renderRepeatNavigator();

  // Identical notes are available on hover too, with a complete description.
  module.drawRepeats(); assert.equal(hoverNote(lane.notes[0]), true);
  assert.ok(rows().some(row => row[0] === 'Pitch'));
  assert.ok(rows().some(row => row[0] === 'Position'));
  controls.repeatNoteCurrent.click();
  assert.equal(previews.at(-1)[1], lane.notes[8]);
  module.hideRepeatHover();

  // Changes are found relative to all the other instances, including the first.
  controls.repeatChangeNext.click(); module.renderRepeatNavigator();
  assert.equal(controls.repeatHover.hidden, false);
  assert.notEqual(controls.repeatChangePosition.textContent, '– / 0');
  assert.equal(S.selection, selection);
  const key = (key, extra = {}) => {
    const event = { key, target: { tagName: 'DIV' }, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
    const handled = module.handleRepeatNavigationKey(event); module.renderRepeatNavigator(); return { event, handled };
  };
  assert.equal(key('ArrowRight', { target: { tagName: 'INPUT' } }).handled, false);
  assert.equal(key('ArrowRight', { ctrlKey: true }).handled, false);
  modalIsOpen = true; assert.equal(key('ArrowRight').handled, false); modalIsOpen = false;
  const identical = lane.notes.slice(0, 8).map((note, i) => ({ ...structuredClone(note), id: `identical${i}`, start: 40.3 + i / 2, end: 40.7 + i / 2 }));
  lane.notes.push(...identical);
  lane.repeatGroups.push({ id: 'repeat_3', name: 'Already consistent', copies: [lane.repeatGroups[0].copies[0], identical.map(n => n.id)] });
  S.voicingRevision++; controls.repeatGroup.value = 'repeat_3'; controls.repeatGroup.dispatchEvent(new Event('change')); module.renderRepeatNavigator();
  assert.equal(controls.repeatChangeNext.disabled, false);
  assert.equal(controls.repeatPosition.textContent, '1 / 2');
  assert.equal(key('ArrowRight').handled, true);
  assert.equal(controls.repeatPosition.textContent, '2 / 2', 'arrows move through instances when there are no differences');
  assert.equal(controls.repeatHover.hidden, true);
  key('ArrowLeft'); assert.equal(controls.repeatPosition.textContent, '1 / 2');
  module.drawRepeats(); assert.equal(hoverNote(lane.notes[0]), true, 'an unchanged note can always be inspected');
  assert.ok(rows().some(row => row[0] === 'Pitch'));
  assert.equal(S.selection, selection);
  module.hideRepeatHover();
  lane.notes[0].finger = 4; identical[0].finger = 3;
  lane.handHolds = [{ t: lane.notes[0].start, fret: 5 }, { t: identical[0].start, fret: 6 }];
  S.voicingRevision++; module.renderRepeatNavigator(); module.drawRepeats(); hoverNote(lane.notes[0]); controls.repeatNoteCurrent.click();
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
  lane.repeatGroups = []; S.voicingRevision++; module.renderRepeatNavigator();
  assert.equal(controls.repeatNavigator.hidden, true);

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
