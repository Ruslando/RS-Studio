import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { convertGpScore } from '../../web/guitar-pro-core.js';
import { appendCreatedLanes, applyImportedProjection } from '../../web/guitar-pro-edit.js';
const alphaTab = createRequire(import.meta.url)('../../web/vendor/alphatab/alphaTab.min.js');
const settings = new alphaTab.Settings();
const load = data => alphaTab.importer.ScoreLoader.loadScoreFromBytes(data, settings);
const write = score => new alphaTab.exporter.Gp7Exporter().export(score, settings);

// Vibrato has independent start/end boundaries through created and source-preserving exports.
{
  const source = new alphaTab.model.Score();
  source.addMasterBar(new alphaTab.model.MasterBar());
  appendCreatedLanes(alphaTab, source, [{ name: 'Vibrato window', customTuning: 'E4 B3 G3 D3 A2 E2',
    gmProgram: 25, notes: [{ id: 'window', start: 0, end: 2, pitch: 45,
      pos: { string: 5, fret: 5 }, fx: { vibrato: true }, vibratoStart: .25, vibratoEnd: .75 }] }], [0, 2]);
  const score = load(write(source));
  const lane = convertGpScore(score, [0]).editLanes[0];
  assert.equal(lane.notes[0].vibratoStart, .25);
  assert.equal(lane.notes[0].vibratoEnd, .75);
  lane.notes[0].vibratoStart = .125;
  lane.notes[0].vibratoEnd = .5;
  applyImportedProjection(alphaTab, score, [lane], [0]);
  const changed = convertGpScore(load(write(score)), [0]).editLanes[0].notes[0];
  assert.equal(changed.vibratoStart, .125);
  assert.equal(changed.vibratoEnd, .5);
  console.log('gp-roundtrip: vibrato boundaries ok');
}
