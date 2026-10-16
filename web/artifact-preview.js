// Each reference card previews one occurrence; only one audition plays at a time.
import { stageMono, STAGE_ANCHORED } from "./constants.js";
import { ensureTone, clearPreview, pauseTransport, previewNotes } from "./playback.js";
import { releaseLaneSynth } from "./lanes.js";
import { toast } from "./notify.js";
import { laneClock, noteBounds, notesInBox, occurrenceBox, shiftOf } from "./references.js";
import { PAINT } from "./stage-paint.js";
import { S } from "./store.js";
import { dpr, fmtTime, noteName } from "./util.js";

let audition = null;
const previews = new Map(), positions = new Map();
import { motifGroups, motifLabel } from './motifs.js';
import { artifactName as names } from './artifact-names.js';
const artifactName = preview => names(preview.motif ? 'motif' : 'reference', preview.lane, preview.ref);
const PLAY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16l13-8Z"/></svg>';
const STOP_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>';
function groupFor(lane, preview) {
  if (!preview.motif) return lane?.refBoxes?.[preview.ref];
  const notes = motifGroups(lane?.notes).get(preview.ref);
  if (!notes?.length) return null;
  const box = noteBounds(notes);
  return {rt0: 0, rt1: box.t1 - box.t0, anchors: [box.t0], pLo: box.pLo, pHi: box.pHi};
}
const memberNotes = (preview, box, lane = preview.lane) => preview.motif
  ? motifGroups(lane.notes).get(preview.ref) || [] : notesInBox(box, lane.notes);
const refKey = (lane, ref) => `${lane.id}:${ref}`;
const arrowIcon = direction => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${direction < 0 ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6'}"/></svg>`;

function syncPreviewState(preview, playing) {
  preview.root.toggleAttribute('data-playing', playing);
  preview.play.innerHTML = playing ? STOP_ICON : PLAY_ICON;
  preview.play.setAttribute('aria-pressed', String(playing));
  preview.play.title = playing ? 'Stop preview' : 'Play preview';
  preview.play.setAttribute('aria-label', preview.play.title);
}

function visible(preview) {
  return preview.root.isConnected && preview.root.getClientRects().length > 0
    && !document.getElementById('artifactsContent').inert && !document.hidden;
}

export function stopArtifactPreviewFor(root) {
  if (audition?.preview.root === root) stopArtifactPreview();
}

export function removeArtifactPreview(root) {
  stopArtifactPreviewFor(root);
  for (const [canvas, preview] of previews) if (preview.root === root) previews.delete(canvas);
}

function updateOccurrence(preview) {
  const lane = S.state?.editLanes.find(item => item.id === preview.lane.id);
  const group = groupFor(lane, preview), ref = preview.ref;
  if (!group?.anchors?.length) return false;
  preview.lane = lane;
  preview.geometry = JSON.stringify([group, S.state.duration]);
  const occurrences = group.anchors.map((anchor, index) => ({anchor, index})).sort((a,b) => a.anchor-b.anchor);
  const position = Math.min(positions.get(refKey(lane, ref)) || 0, occurrences.length - 1);
  positions.set(refKey(lane, ref), position);
  preview.position = position;
  const index = occurrences[position].index, o = preview.motif ? null : occurrenceBox(group, index, laneClock(lane));
  preview.box = preview.motif
    ? { index, t0: Math.max(0, occurrences[position].anchor + group.rt0),
      t1: Math.min(S.state.duration, occurrences[position].anchor + group.rt1), pLo: group.pLo, pHi: group.pHi }
    : { ...o, index, t0: Math.max(0, o.t0), t1: Math.min(S.state.duration, o.t1) };
  const shift = preview.motif ? 0 : shiftOf(group, index);
  preview.root.dataset.instance = String(position + 1);
  preview.label.textContent = `${position + 1} / ${occurrences.length} · ${fmtTime(preview.box.t0)}–${fmtTime(preview.box.t1)}${shift ? ` · ${shift > 0 ? '+' : '−'}${Math.abs(shift)}` : ''}`;
  preview.previous.disabled = position === 0;
  preview.next.disabled = position === occurrences.length - 1;
  preview.previous.hidden = preview.next.hidden = occurrences.length === 1;
  preview.stage.toggleAttribute('data-single', occurrences.length === 1);
  preview.key = '';
  syncPreviewState(preview, false);
  return true;
}

export function stopArtifactPreview() {
  const current = audition;
  if (!current) return;
  audition = null;
  clearTimeout(current.timer); cancelAnimationFrame(current.frame);
  if (current.player) { current.player.pause(); current.player.removeAttribute('src'); current.player.load(); current.player.remove(); }
  else { clearPreview(); releaseLaneSynth(current.preview.lane); }
  syncPreviewState(current.preview, false);
  paintArtifactPreviews();
}

async function playPreview(preview) {
  const wasPlaying = audition?.preview === preview;
  stopArtifactPreview();
  if (wasPlaying) return;
  if (!updateOccurrence(preview)) return;
  pauseTransport();
  const state = S.state, { lane, box } = preview;
  const stem = state.stems.find(item => item.id === state.curStem) || state.stems[0];
  const current = { preview, source: stem?.audioUrl || null, player: null, timer: 0, frame: 0, started: 0, noteSig: JSON.stringify(memberNotes(preview, box, lane)) };
  audition = current; syncPreviewState(preview, true);
  try {
    if (stem) {
      const player = new Audio(stem.audioUrl); current.player = player;
      player.className = 'artifact-audio'; player.hidden = true;
      preview.root.append(player); player.currentTime = box.t0;
      player.addEventListener('timeupdate', () => {
        if (audition === current && player.currentTime >= box.t1) stopArtifactPreview();
      });
      player.addEventListener('ended', () => { if (audition === current) stopArtifactPreview(); });
      await player.play();
    } else {
      await ensureTone();
      if (window.Tone) await Tone.loaded();
      if (audition !== current || S.state !== state) return;
      const notes = memberNotes(preview, box, lane).map(note => ({ ...note,
        start: Math.max(box.t0, note.start), end: Math.min(box.t1, note.end) }));
      previewNotes(notes, lane, { start: box.t0 });
    }
    if (audition !== current || S.state !== state) return;
    current.started = performance.now();
    const animate = () => {
      if (audition !== current) return;
      if (!visible(preview)) { stopArtifactPreview(); return; }
      paintArtifactPreviews();
      if (audition === current) current.frame = requestAnimationFrame(animate);
    };
    animate();
    if (audition !== current) return;
    current.timer = setTimeout(stopArtifactPreview, Math.max(0, box.t1 - box.t0) * 1000);
  } catch (error) {
    if (audition !== current) return;
    stopArtifactPreview();
    toast('Could not play reference preview: ' + (error.message || error), 3000, 'error');
  }
}

export function resetArtifactPreviews(clearSelection = false) {
  stopArtifactPreview(); previews.clear();
  if (clearSelection) positions.clear();
}

export function referencePreview(lane, ref, moveTo, motif = false) {
  const root = document.createElement('section'); root.className = 'artifact-preview artifact-occurrences';
  root.setAttribute('aria-label', `${motif ? motifLabel(ref) : `Reference #${ref}`} preview`);
  const label = document.createElement('div'); label.className = 'artifact-time artifact-preview-title';
  label.setAttribute('aria-live', 'polite');
  const stage = document.createElement('div'); stage.className = 'artifact-preview-stage';
  const canvas = document.createElement('canvas'); canvas.className = 'artifact-preview-canvas'; canvas.setAttribute('role', 'img');
  const previous = document.createElement('button'), next = document.createElement('button');
  const play = document.createElement('button'); play.type = 'button'; play.className = 'icon-btn icon-btn--compact artifact-preview-play';
  play.addEventListener('click', () => playPreview(preview));
  const preview = {lane, ref, motif, root, label, stage, previous, next, play, geometry: '', position: 0, box: null, key: '', image: null};
  const change = delta => {
    stopArtifactPreviewFor(root);
    positions.set(refKey(lane, ref), preview.position + delta);
    updateOccurrence(preview); paintArtifactPreviews();
  };
  for (const [button, delta, name] of [[previous,-1,'Previous'],[next,1,'Next']]) {
    button.type = 'button'; button.className = `icon-btn icon-btn--compact artifact-instance-${delta < 0 ? 'previous' : 'next'}`;
    button.innerHTML = arrowIcon(delta); button.title = `${name} instance of ${artifactName(preview)}`;
    button.setAttribute('aria-label', button.title); button.addEventListener('click', () => change(delta));
  }
  const move = document.createElement('button'); move.type = 'button'; move.className = 'btn btn--compact btn--ghost artifact-jump';
  move.textContent = 'Move to'; move.title = `Move to displayed instance of ${artifactName(preview)}`; move.setAttribute('aria-label', move.title);
  move.addEventListener('click', () => moveTo(preview.box.index));
  root.tabIndex = 0;
  root.title = 'Space plays the preview; right-click for actions';
  root.addEventListener('keydown', event => {
    if (event.target !== root) return;
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); playPreview(preview); }
    else if (event.key === 'Escape') stopArtifactPreviewFor(root);
    else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault(); const rect = root.getBoundingClientRect();
      root.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: rect.left + 16, clientY: rect.top + 16}));
    }
  });
  const footer = document.createElement('div'); footer.className = 'artifact-preview-footer'; footer.append(play, label, move);
  stage.append(canvas, previous, next); root.append(stage, footer);
  previews.set(canvas, preview); updateOccurrence(preview);
  return root;
}

export function paintArtifactPreviews() {
  if (!S.state?.spec || document.getElementById("artifactsContent").inert) return;
  const stem = S.state.stems.find(item => item.id === S.state.curStem) || S.state.stems[0];
  if (audition && audition.source !== (stem?.audioUrl || null)) { stopArtifactPreview(); return; }
  for (const [canvas, preview] of previews) {
    const lane = S.state.editLanes.find(item => item.id === preview.lane.id);
    const group = groupFor(lane, preview);
    if (!group?.anchors?.length) continue;
    preview.lane = lane;
    if (preview.geometry !== JSON.stringify([group, S.state.duration])) {
      preview.geometry = JSON.stringify([group, S.state.duration]);
      stopArtifactPreviewFor(preview.root); updateOccurrence(preview);
    }
    const box = preview.box;
    const width = Math.round(canvas.clientWidth), height = canvas.clientHeight, dp = dpr();
    if (!width || !height || box.t1 <= box.t0) continue;
    const notes = memberNotes(preview, box, lane);
    if (audition?.preview === preview && audition.noteSig !== JSON.stringify(notes)) {
      stopArtifactPreview(); return;
    }
    canvas.setAttribute("aria-label", `${artifactName(preview)}, instance ${preview.position + 1} in ${lane.name}, ${notes.length} notes`);
    const playhead = audition?.preview === preview && audition.started ? (audition.player ? audition.player.currentTime
      : box.t0 + (performance.now() - audition.started) / 1000) : null;
    const key = JSON.stringify([width, height, dp, PAINT.ground, lane.color, playhead,
      S.state.curStem, box, S.state.spec, notes.map(n => [n.start, n.end, n.pitch])]);
    if (key === preview.key && preview.image === S.spectImg) continue;
    preview.key = key; preview.image = S.spectImg;
    canvas.width = Math.round(width * dp); canvas.height = Math.round(height * dp);
    const ctx = canvas.getContext("2d"); ctx.scale(dp, dp);
    ctx.fillStyle = PAINT.ground; ctx.fillRect(0, 0, width, height);
    const lo = Math.max(S.state.spec.midi_low, box.pLo - 2), hi = Math.min(S.state.spec.midi_high, box.pHi + 2);
    const rows = hi - lo + 1, rowH = height / rows;
    if (S.spectImg) {
      const image = S.spectImg, specRows = S.state.spec.midi_high - S.state.spec.midi_low + 1;
      ctx.drawImage(image, box.t0 / S.state.duration * image.width,
        (S.state.spec.midi_high - hi) / specRows * image.height,
        (box.t1 - box.t0) / S.state.duration * image.width, rows / specRows * image.height,
        0, 0, width, height);
    }
    const x = t => (t - box.t0) / (box.t1 - box.t0) * width;
    ctx.strokeStyle = PAINT.gridSub; ctx.lineWidth = 1;
    for (let p = lo; p <= hi; p++) {
      const y = (hi - p) * rowH;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    ctx.font = stageMono(STAGE_ANCHORED); ctx.textBaseline = "middle";
    for (const note of notes) {
      const left = Math.max(0, x(note.start)), right = Math.min(width, x(note.end));
      const y = (hi - note.pitch) * rowH;
      ctx.fillStyle = lane.color; ctx.globalAlpha = .3;
      ctx.fillRect(left, y, Math.max(1, right - left), rowH);
      ctx.globalAlpha = 1; ctx.strokeStyle = lane.color;
      ctx.strokeRect(left + .5, y + .5, Math.max(1, right - left - 1), Math.max(1, rowH - 1));
      if (right - left > 24 && rowH >= 10) {
        ctx.fillStyle = PAINT.text; ctx.fillText(noteName(note.pitch), left + 4, y + rowH / 2);
      }
    }
    if (playhead != null) {
      ctx.strokeStyle = PAINT.accent;
      ctx.beginPath(); ctx.moveTo(x(playhead), 0); ctx.lineTo(x(playhead), height); ctx.stroke();
    }
  }
}
