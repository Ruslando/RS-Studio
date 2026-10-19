import assert from 'node:assert/strict';
import { projectShiftPlan, projectStart } from '../../web/project-position-core.js';

const timing = {
  grid: { offset: .2, bpm: 120 }, tempoMap: [{ t: 4, bpm: 160 }],
  sectionMarkers: [{ t: .2, text: 'Verse' }, { t: 7, text: 'Solo' }],
  scoreBars: [{ seconds: .2, durationSeconds: 2 }, { seconds: 8, durationSeconds: 2 }],
};
const ownTiming = { grid: { offset: .1, bpm: 90 }, tempoMap: [{ t: 3, bpm: 100 }] };
const state = {
  duration: 12, scoreDuration: 10, stems: [{ id: 'mix' }],
  editLanes: [{
    visible: false, locked: true,
    notes: [{ start: .25, end: 1, bend: [[0, 0], [1, 2]] }, { start: 9, end: 10 }],
    handHolds: [{ t: .25, fret: 3 }], toneMarkers: [{ t: 0, tone: 'clean' }],
    phraseBoundaries: [{ t: 6 }], refBoxes: { 1: { rt0: 0, rt1: 1, anchors: [.25, 6], locked: true } },
  }, { notes: [{ start: 2, end: 3 }], timing: 'own' }],
};
const before = structuredClone({ state, timing, ownTiming });
const plan = projectShiftPlan(state, [timing, ownTiming, timing]);
assert.equal(plan.min, 0, 'the project cannot start before zero');
assert.equal(plan.max, 2, 'the last note stays inside the fixed recording');
plan.apply(.375);
assert.equal(projectStart(state), .375);
assert.equal(state.duration, 12, 'audio and its duration stay fixed');
assert.equal(state.editLanes[0].notes[1].end, 10.375, 'later tempo spans move too');
assert.equal(state.editLanes[1].notes[0].start, 2.375, 'independent timing lanes move too');
assert.equal(ownTiming.grid.offset, .475);
assert.equal(timing.grid.offset, .575, 'shared timing objects move only once');
assert.equal(timing.tempoMap[0].t, 4.375);
assert.equal(timing.sectionMarkers[1].t, 7.375);
assert.equal(timing.scoreBars[1].seconds, 8.375);
assert.equal(timing.scoreBars[1].durationSeconds, 2, 'bar lengths stay intact');
assert.equal(state.editLanes[0].toneMarkers[0].t, .375);
assert.equal(state.editLanes[0].phraseBoundaries[0].t, 6.375);
assert.equal(state.editLanes[0].handHolds[0].t, .625);
assert.deepEqual(state.editLanes[0].refBoxes[1].anchors, [.625, 6.375]);
assert.equal(state.editLanes[0].refBoxes[1].rt1, 1, 'relative reference shapes stay intact');
assert.deepEqual(state.editLanes[0].notes[0].bend, [[0, 0], [1, 2]]);
plan.apply(.5);
assert.equal(state.editLanes[0].notes[0].start, .75, 'each update uses the original positions');
plan.apply(0);
assert.deepEqual({ state: { ...state, projectStart: undefined }, timing, ownTiming },
  { ...before, state: { ...before.state, projectStart: undefined } }, 'cancelling restores every original position');

const score = { projectStart: 1, duration: 5, scoreDuration: 5, stems: [], editLanes: [{ notes: [{ start: 1.5, end: 4 }] }] };
const scorePlan = projectShiftPlan(score, [{ grid: { offset: 1 } }]);
assert.equal(scorePlan.min, -1);
assert.equal(scorePlan.max, Infinity);
scorePlan.apply(3);
assert.equal(score.duration, 8, 'a score without audio expands rather than clipping');
assert.equal(score.scoreDuration, 8);
assert.equal(projectStart(score), 4);
scorePlan.apply(-1);
assert.equal(projectStart(score), 0);
assert.equal(score.editLanes[0].notes[0].start, .5);
assert.equal(projectStart(null), 0);
console.log('project position: ok');
