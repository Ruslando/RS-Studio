import assert from 'node:assert/strict';
import { SOUND_BASES, cloneSound } from '../../web/sound-presets-core.js';
import { projectSoundPresets, projectSoundDirty, prepareProjectSoundEdits } from '../../web/project-sound-presets.js';

const fixture = () => {
  const tone = cloneSound(SOUND_BASES.clean);
  return { editLanes: [
    {id:'a', toneMarkers:[{id:'one',t:0,tone:'sound_test',toneData:cloneSound(tone)},
      {id:'variant',t:4,tone:'sound_test',toneData:{...cloneSound(tone),Name:'Variant'}}]},
    {id:'b', toneMarkers:[{id:'two',t:0,tone:'sound_test',toneData:cloneSound(tone)},
      {id:'missing',t:4,tone:'sound_missing'}]},
  ] };
};
assert.deepEqual(projectSoundPresets(null), []);
{
  const state = fixture();
  assert.deepEqual(projectSoundPresets(state, [{id:'sound_test',tone:SOUND_BASES.clean}]), [],
    'available app presets never become project copies');
}
{
  const state = fixture(), original = cloneSound(state), entries = projectSoundPresets(state);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].targets.length, 2, 'shared snapshots form one project preset');
  assert.equal(projectSoundDirty(entries), false);
  entries[0].tone.Name = ' Song tone ';
  entries[0].tone.Volume = '-7';
  assert.equal(projectSoundDirty(entries), true);
  const apply = prepareProjectSoundEdits(entries, state);
  assert.deepEqual(state, original, 'draft edits and validation do not mutate the project');
  assert.equal(apply(), 2);
  assert.equal(state.editLanes[0].toneMarkers[0].toneData.Name, 'Song tone');
  assert.equal(state.editLanes[1].toneMarkers[0].toneData.Volume, '-7');
  assert.equal(state.editLanes[0].toneMarkers[1].toneData.Name, 'Variant');
  assert.equal(state.editLanes[0].toneMarkers[0].tone, 'sound_test');
  assert.equal(projectSoundDirty(entries), false, 'Apply rebases the draft with normalized values');
  entries[0].tone.Volume = '-8';
  prepareProjectSoundEdits(entries, state)();
  assert.equal(state.editLanes[1].toneMarkers[0].toneData.Volume, '-8');
}
{
  const state = fixture(), entries = projectSoundPresets(state);
  entries[0].tone.Name = 'Stale edit';
  state.editLanes[1].toneMarkers[0].toneData.Name = 'Another edit';
  const original = cloneSound(state);
  assert.throws(() => prepareProjectSoundEdits(entries, state), /changed/);
  assert.deepEqual(state, original, 'a stale target prevents partial updates');
}
{
  const state = fixture(), original = cloneSound(state), entries = projectSoundPresets(state);
  entries[0].tone.Volume = '999';
  assert.throws(() => prepareProjectSoundEdits(entries, state), /Correct/);
  assert.deepEqual(state, original);
}
console.log('project sound presets: grouped versions, staged edits, validation and conflicts ok');
