// Bindable editor actions reuse the same controllers as the visible controls.
import { KEY_COMMANDS, matchKey } from './keymap.js';
import { $, scroll, stage } from './dom.js';
import { S } from './store.js';
import { activeLane, activateLane, canEditLane, editLanes, laneOf } from './lanes.js';
import { playbackTime, seekPlayback } from './playback.js';
import { openSettingsModal } from './ui.js';
import { draw } from './repaint.js';
import { openDetectPanel, updateDetectStatus } from './detect.js';
import { refMenuEntry, detachSelection } from './references.js';
import { markSelectionAsMotif, selectEntireMotif, unmarkSelectedMotifs, setFxOnSelection } from './edit.js';
import { fxOn } from './note-effects.js';
import { runFindSimilar } from './tracing.js';
import { xOf } from './geometry.js';
import { moveViewportTo } from './viewport-motion.js';
import { songEnd } from './project-position-core.js';
import { toggleDrawingSettings, toggleDrawingSnap } from './drawing-settings.js';

const click = id => { const control = $(id); if (control && !control.disabled) control.click(); };
const layerControl = selector => document.querySelector(`#lanes .lane-row.active ${selector}`)?.click();
function stepLayer(direction) {
  const lanes = editLanes(), index = lanes.indexOf(activeLane());
  const lane = lanes[index + direction];
  if (lane) activateLane(lane);
}
function speed(direction) {
  const control = $('speed');
  control.selectedIndex = Math.max(0, Math.min(control.options.length - 1, control.selectedIndex + direction));
  control.dispatchEvent(new Event('change', { bubbles: true }));
}
function goTo(time) {
  if (!Number.isFinite(time)) return;
  seekPlayback(time);
  moveViewportTo(xOf(time) - scroll.clientWidth * .2, scroll.scrollTop);
  draw();
}
function withSelection(action) {
  const notes = [...S.selection].filter(note => laneOf(note));
  if (notes.length && notes.every(note => canEditLane(laneOf(note)))) action(notes);
}

export const EDITOR_COMMAND_HANDLERS = {
  sidebar: () => click('sidebarToggle'), artifacts: () => click('artifactsToggle'),
  zoomIn: () => click('zoomIn'), zoomOut: () => click('zoomOut'),
  drawingSnap: toggleDrawingSnap, drawingSettings: toggleDrawingSettings,
  slower: () => speed(-1), faster: () => speed(1),
  normalSpeed: () => { $('speed').value = '1'; $('speed').dispatchEvent(new Event('change', { bubbles: true })); },
  metronome: () => click('metro'),
  songStart: () => goTo(0), songEnd: () => goTo(songEnd(S.state)),
  rangeStart: () => goTo(S.detectRegion?.t0),
  clearRange: () => { S.detectRegion = null; updateDetectStatus(); draw(); },
  detectNotes: () => { const rect = stage.getBoundingClientRect(); openDetectPanel(rect.left + 40, rect.top + 40); },
  findSimilar: () => S.selection.size ? withSelection(runFindSimilar) : runFindSimilar(),
  groupReference: () => withSelection(notes => refMenuEntry(notes)?.fn()),
  detachReference: () => withSelection(detachSelection),
  markMotif: () => withSelection(markSelectionAsMotif), selectMotif: () => withSelection(selectEntireMotif),
  unmarkMotif: () => withSelection(unmarkSelectedMotifs),
  fretboardShape: () => click('fretboardShape'), applyFretboardShape: () => click('fretboardApply'),
  chooseFretboardAlternative: () => click('fretboardChoose'), autoFretboard: () => click('fretboardAuto'),
  ...Object.fromEntries(['palmMute', 'hammer', 'vibrato', 'dead', 'accent', 'letRing'].map(key =>
    [key, () => withSelection(notes => setFxOnSelection(key, !notes.every(note => fxOn(note, key))))])),
  previousLayer: () => stepLayer(-1), nextLayer: () => stepLayer(1), addLayer: () => click('addLane'),
  layerSettings: () => layerControl('.edit-btn'), layerVisible: () => layerControl('.vis-btn'),
  layerLock: () => layerControl('.lock-btn'),
  tablature: () => click('menuPreviewTab'), editorSettings: () => openSettingsModal('trace'),
  projectDetails: () => openSettingsModal('project'), tunings: () => openSettingsModal('tunings'),
  toneDesigner: () => openSettingsModal('sounds'), keyboardSettings: () => openSettingsModal('keys'),
  projectLibrary: () => click('openProjMenu'), closeProject: () => click('closeProj'),
  importGuitarPro: () => click('importGp'), attachAudio: () => click('attachAudio'),
  exportGuitarPro: () => click('menuExportModernGp'), exportLegacyGuitarPro: () => click('menuExportTab'),
  exportRocksmith: () => click('menuExportRocksmith'),
};

export function runEditorShortcut(event) {
  if (!S.state || S.drag) return false;
  const command = KEY_COMMANDS.find(command => EDITOR_COMMAND_HANDLERS[command.id] && matchKey(event, command.id));
  if (!command) return false;
  EDITOR_COMMAND_HANDLERS[command.id]();
  return true;
}
