// Live marker views: rows retain only a key and resolve the current project
// object before every action, so normalization, undo and retiming cannot stale it.
import { $, scroll } from './dom.js';
import { S } from './store.js';
import { ownsSections, ownsTempo, timingData, timingIdOf } from './timing.js';
import { timingSegments } from './grid.js';
import { activateLane, canEditLane, renderLanes } from './lanes.js';
import { openMarkerPop, closeMarkerPop } from './markers.js';
import { openSectionMarkerPop, closeSectionMarkerPop } from './section-markers.js';
import { openPhraseMarkerPop, closePhraseMarkerPop } from './phrase-markers.js';
import { openToneMarkerPop, closeToneMarkerPop } from './tone-markers.js';
import { openHandAnchorPop, closeHandAnchorPop } from './hand-anchors.js';
import { handColumnAt, laneHandColumns } from './tablature.js';
import { sectionTypeLabel } from './section-marker-core.js';
import { tonePresetLabel, tonePresetMissing } from './tone-marker-core.js';
import { playbackTime, seekPlayback } from './playback.js';
import { adjacentMarkerTime } from './marker-navigation-core.js';
import { xOf, yOf } from './geometry.js';
import { openCommentPop, closeCommentPop } from './comments.js';
import { moveViewportTo, stopViewportMotion } from './viewport-motion.js';
import { stopArtifactPreview } from './artifact-preview.js';
import { draw } from './repaint.js';
import { icon } from './icons.js';

const categories = [['tempo', 'Tempo & meter'], ['section', 'Sections'], ['phrase', 'Phrases'], ['tone', 'Tone switches'], ['anchor', 'Hand anchors'], ['comment', 'Comments']];
const sections = new Map(), rows = new Map();
const chevron = '<svg class="side-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const setText = (element, text) => { if (element.textContent !== text) element.textContent = text; };
const markerTime = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}`;

export function markerArtifacts() {
  if (!S.state) return [];
  // Only the active layer and the timing it follows.
  const active = S.state.editLanes.find(lane => lane.active);
  if (!active) return [];
  const entries = [], lanes = [active];
  for (const [timing, lane] of [[timingIdOf(active), active]]) {
    const data = timingData(timing), name = owns => (owns(lane) ? lane.name : 'Song'), owner = name(ownsTempo);
    timingSegments(data).forEach((segment, index) => entries.push({
      key: `tempo:${timing}:${index}`, kind: 'tempo', timing, lane, owner,
      marker: segment, t: segment.t,
      name: `${+Number(segment.bpm).toFixed(2)} BPM · ${segment.tsNum}/${segment.tsDen}${segment.seg0 ? ' · Start' : ''}`,
    }));
    for (const marker of data.sectionMarkers || []) entries.push({
      key: `section:${timing}:${marker.id}`, kind: 'section', timing, lane, owner: name(ownsSections),
      marker, t: marker.t, name: marker.text || sectionTypeLabel(marker.sectionType),
    });
  }
  for (const lane of lanes) {
    // An anchor that cannot reach its note says so, as on its flag (hand-anchors.js).
    const reach = lane.handHolds?.length ? laneHandColumns(lane) : null;
    (lane.handHolds || []).forEach((marker, index) => {
      const column = handColumnAt(reach, marker.t);
      const lost = !!column && !column.choices.includes(Number(marker.fret));
      const fret = Math.round(marker.fret);
      entries.push({
        key: `anchor:${lane.id}:${index}`, kind: 'anchor', lane, owner: lane.name,
        marker, t: marker.t, name: `${lost ? '⚠ ' : ''}Fret ${fret}${lost ? " · can't reach" : ''}`,
        // Listed again under Errors (rocksmith-check.js), where every problem goes.
        issue: lost ? { tone: 'error', title: `Hand anchor on fret ${fret} can't reach its note`,
          help: 'The hand cannot play the note there, so the anchor is ignored. Move it or choose another fret.' } : null,
      });
    });
    [...lane.phraseBoundaries || []].sort((a, b) => a.t - b.t).forEach((marker, index) => entries.push({
      key: `phrase:${lane.id}:${marker.id}`, kind: 'phrase', lane, owner: lane.name,
      marker, t: marker.t, name: `Phrase ${index + 1}`,
    }));
    for (const marker of lane.toneMarkers || []) {
      const missing = tonePresetMissing(marker.tone, undefined, marker.toneData), label = tonePresetLabel(marker.tone, marker.toneData);
      entries.push({
        key: `tone:${lane.id}:${marker.id}`, kind: 'tone', lane, owner: lane.name,
        marker, t: marker.t, name: `${missing ? '⚠ ' : ''}${label}`,
        issue: missing ? { tone: 'warning', title: `Tone preset missing: ${label}`,
          help: "The preset this tone switch names isn't in your sound library. Choose another one or import it." } : null,
      });
    }
  }
  // Comments belong to the song, so they show whichever layer is active.
  for (const marker of S.state.comments || []) entries.push({
    key: `comment:${marker.id}`, kind: 'comment', owner: 'Song',
    marker, t: marker.t, name: marker.text.split('\n')[0] || 'Comment',
  });
  return entries.sort((a, b) => a.t - b.t || a.key.localeCompare(b.key));
}

function actOnMarker(key, edit, target, event) {
  stopArtifactPreview(); stopViewportMotion();
  // Commit an open editor while its original timing and layer still own it.
  closeMarkerPop(); closeSectionMarkerPop(); closePhraseMarkerPop(); closeToneMarkerPop(); closeHandAnchorPop(); closeCommentPop();
  const entry = markerArtifacts().find(item => item.key === key);
  if (!entry || (edit && ['tone', 'phrase', 'anchor'].includes(entry.kind) && !canEditLane(entry.lane))) return;
  const { lane, kind, marker, timing, t } = entry;
  if (lane) { lane.visible = true; activateLane(lane); renderLanes(); }
  if (!edit) {
    seekPlayback(t);
    moveViewportTo(xOf(t) - scroll.clientWidth * .2, kind === 'comment' ? yOf(marker.pitch) - scroll.clientHeight / 2 : scroll.scrollTop);
    draw(); return;
  }
  const rect = target.getBoundingClientRect();
  const x = event?.type === 'contextmenu' ? event.clientX : rect.left;
  const y = event?.type === 'contextmenu' ? event.clientY : rect.bottom;
  if (kind === 'tempo') openMarkerPop(x, y, marker, timing);
  else if (kind === 'section') openSectionMarkerPop(x, y, marker, timing);
  else if (kind === 'phrase') openPhraseMarkerPop(x, y, marker, lane);
  else if (kind === 'anchor') openHandAnchorPop(x, y, marker, lane);
  else if (kind === 'comment') openCommentPop(x, y, marker);
  else openToneMarkerPop(x, y, marker, lane);
  draw();
}

export function navigateMarker(direction) {
  if (!S.state) return;
  // Closing a marker editor commits its draft before resolving the live list.
  closeMarkerPop(); closeSectionMarkerPop(); closePhraseMarkerPop(); closeToneMarkerPop(); closeHandAnchorPop();
  const time = adjacentMarkerTime(markerArtifacts(), playbackTime(), direction, S.state.duration);
  if (time === null) return;
  stopArtifactPreview(); stopViewportMotion();
  seekPlayback(time);
  moveViewportTo(xOf(time) - scroll.clientWidth * .2, scroll.scrollTop);
  draw();
}

export function initMarkerArtifacts() {
  for (const [id, direction] of [['previousMarker', -1], ['nextMarker', 1]]) {
    $(id).addEventListener('click', event => {
      navigateMarker(direction);
      event.currentTarget.blur();
    });
  }
  const root = $('artifactMarkers');
  for (const [kind, label] of categories) {
    const head = document.createElement('div'); head.className = 'side-header';
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'side-label';
    toggle.innerHTML = chevron;
    const title = document.createElement('span'); title.textContent = label;
    const count = document.createElement('span'); count.className = 'artifact-count'; count.setAttribute('aria-live', 'polite');
    toggle.append(title, count);
    const body = document.createElement('div'); body.className = 'artifact-panel-body'; body.id = `artifact-${kind}-body`;
    const list = document.createElement('ul'); list.className = 'artifact-list'; list.dataset.markerKind = kind;
    body.append(list); head.append(toggle); root.append(head, body);
    const sync = () => {
      toggle.setAttribute('aria-controls', body.id); toggle.setAttribute('aria-expanded', String(!body.hidden));
      toggle.title = `${body.hidden ? 'Expand' : 'Collapse'} ${label.toLowerCase()}`;
      toggle.setAttribute('aria-label', toggle.title);
    };
    toggle.addEventListener('click', () => { body.hidden = !body.hidden; sync(); }); sync();
    sections.set(kind, {list, count, head, body});
  }
}

export function renderMarkerArtifacts() {
  if (!sections.size) return;
  const entries = markerArtifacts(), live = new Set(entries.map(entry => entry.key));
  for (const [id, direction] of [['previousMarker', -1], ['nextMarker', 1]])
    $(id).disabled = !S.state || adjacentMarkerTime(entries, playbackTime(), direction, S.state.duration) === null;
  for (const [key, row] of rows) if (!live.has(key)) { row.remove(); rows.delete(key); }
  for (const [kind, {list, count, head, body}] of sections) {
    const group = entries.filter(entry => entry.kind === kind);
    setText(count, String(group.length));
    head.classList.toggle('is-empty', !group.length); body.classList.toggle('is-empty', !group.length);
    group.forEach((entry, index) => {
      const key = entry.key;
      let row = rows.get(entry.key);
      if (!row) {
        row = document.createElement('li'); row.className = 'artifact-row artifact-marker-row'; row.dataset.markerKey = entry.key;
        // The name is drawn as its flag is on the stage; a hand anchor takes its layer's colour.
        row.dataset.kind = entry.kind;
        const copy = document.createElement('div'); copy.className = 'artifact-copy';
        const name = document.createElement('span'); name.className = 'artifact-name';
        const detail = document.createElement('span'); detail.className = 'artifact-detail artifact-time'; copy.append(name);
        const controls = document.createElement('div'); controls.className = 'artifact-marker-actions';
        for (const [edit, label, svg] of [[true, 'Edit', icon('edit', 14)], [false, 'Move to', icon('jump', 14)]]) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-btn icon-btn--compact';
          button.classList.add(edit ? 'artifact-marker-edit' : 'artifact-marker-jump'); button.innerHTML = svg;
          button.title = label; button.setAttribute('aria-label', label);
          button.addEventListener('click', event => actOnMarker(key, edit, button, event));
          controls.append(button);
        }
        // A click on the row itself moves there; the buttons stay for keyboard use.
        row.addEventListener('click', event => { if (!event.target.closest('button')) actOnMarker(key, false, row); });
        row.addEventListener('contextmenu', event => {
          event.preventDefault(); event.stopPropagation(); actOnMarker(key, true, row, event);
        });
        row.append(copy, detail, controls); rows.set(entry.key, row);
      }
      setText(row.querySelector('.artifact-name'), entry.name);
      setText(row.querySelector('.artifact-detail'), markerTime(entry.t));
      if (entry.kind === 'anchor') row.style.setProperty('--mark', entry.lane.color);
      row.querySelector('.artifact-marker-edit').disabled = ['tone', 'phrase', 'anchor'].includes(entry.kind) && !canEditLane(entry.lane);
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    });
  }
}

export function clearMarkerArtifacts() {
  for (const row of rows.values()) row.remove();
  rows.clear();
}
