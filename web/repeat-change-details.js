// Human-readable, exact note differences. The columns always read first -> current.
import { copyEffects, effectSignatureFields, FX_LABELS } from './note-effects.js';
import { noteName } from './util.js';
import { bendCurve, slideRibbon, slideInOf, slideEndOf, slideStartOf, vibratoStartOf, vibratoEndOf } from './bend.js';
import { whammyCurve } from './whammy.js';
const human = value => String(value).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
const number = value => Number(value.toFixed(2)).toString();
const NAMES = { slide: 'Slide', slideIn: 'Slide in', slideStart: 'Slide starts', slideEnd: 'Slide ends', slideFrets: 'Slide distance',
  vibratoStart: 'Vibrato starts', vibratoEnd: 'Vibrato ends', bend: 'Bend', bendPoints: 'Bend curve',
  whammy: 'Whammy', whammyPoints: 'Whammy curve', harmonic: 'Harmonic', grace: 'Grace note', trill: 'Trill',
  tremPick: 'Tremolo picking', slap: 'Picking technique', stroke: 'Strum', ornament: 'Ornament' };
const VALUES = { shift: 'Shift slide', legato: 'Legato slide', inBelow: 'From below', inAbove: 'From above', outDown: 'Out down', outUp: 'Out up',
  pickDown: 'Pick scrape down', pickUp: 'Pick scrape up', quarter: 'Quarter tone', half: 'Half step', full: 'Whole step',
  onehalf: '1½ steps', twostep: '2 steps', release: 'Bend and release', prebend: 'Pre-bend', prebendRelease: 'Pre-bend and release',
  bendReleaseBend: 'Bend, release, bend', natural: 'Natural', artificial: 'Artificial', pinch: 'Pinch', tap: 'Tap', slap: 'Slap', pop: 'Pop',
  whole: 'Whole step', origin: 'Start of hammer-on / pull-off', dest: 'End of hammer-on / pull-off', both: 'Both ends', dip: 'Dip', dive: 'Dive' };
const clean = value => {
  if (typeof value === 'number') return Math.round(value * 1e6) / 1e6;
  if (value == null || value === false) return null;
  if (Array.isArray(value)) return value.map(clean);
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => clean(value[k]) != null).map(k => [k, clean(value[k])]));
  return value;
};
export function curveSummary(points) {
  if (!points?.length) return 'Off';
  const values = points.map(([, pitch]) => pitch), lo = Math.min(...values), hi = Math.max(...values);
  if (lo === hi) return lo === 0 ? 'Flat' : `${number(lo)} st held`;
  if (lo < 0 && hi <= 0) return `${number(Math.abs(lo))} st ${values.at(-1) < 0 ? 'dive' : 'dip'}`;
  if (lo >= 0) return `${number(hi)} st bend`;
  return `${number(lo)}…+${number(hi)} st`;
}
// A shared range keeps a two-semitone dip visibly deeper than a one-semitone dip.
export function curveGraph(points, low, high) {
  const span = Math.max(1, high - low);
  const y = value => Number((25 - (value - low) / span * 22).toFixed(2));
  return { baseline: y(0), path: (points || []).map(([time, value], i) =>
    `${i ? 'L' : 'M'}${Number((3 + time * 90).toFixed(2))},${y(value)}`).join(' ') };
}
function format(key, value) {
  if (value == null || value === false) return 'Off';
  if (value === true) return 'On';
  if (['slideStart', 'slideEnd', 'vibratoStart', 'vibratoEnd'].includes(key)) return `${number(Number(value) * 100)}% of note`;
  if (['bendPoints', 'whammyPoints'].includes(key) && Array.isArray(value))
    return curveSummary(value);
  if (typeof value === 'number') return `${number(value)}${key === 'slideFrets' ? ' frets' : ''}`;
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${human(k)}: ${format(k, v)}`).join('; ');
  return VALUES[value] || human(value);
}
export function effectiveTechniqueFields(note) {
  const fields = effectSignatureFields(note);
  // Compare what is played: implicit preset curves and default effect timings
  // are real values, rather than an effect being off.
  fields.bendPoints = bendCurve(note);
  fields.whammyPoints = whammyCurve(note);
  fields.slideStart = slideStartOf(note);
  fields.slideEnd = slideInOf(note) ? slideEndOf(note, note.end - note.start) : null;
  fields.vibratoStart = note.fx?.vibrato ? vibratoStartOf(note) : null;
  fields.vibratoEnd = note.fx?.vibrato ? vibratoEndOf(note) : null;
  return fields;
}
export function techniqueChangeRows(first, current) {
  const a = effectiveTechniqueFields(first), b = effectiveTechniqueFields(current), rows = [];
  const add = (key, before, after, label, path = key) => {
    if (JSON.stringify(clean(before)) === JSON.stringify(clean(after))) return;
    const row = { key: path, label, before: format(key, before), after: format(key, after) };
    if (key === 'bendPoints' || key === 'whammyPoints') row.curves = { before: before || [], after: after || [] };
    rows.push(row);
  };
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'fx') {
      for (const flag of new Set([...Object.keys(a.fx || {}), ...Object.keys(b.fx || {})]))
        add(flag, a.fx?.[flag], b.fx?.[flag], FX_LABELS[flag] || human(flag), `fx.${flag}`);
    } else add(key, a[key], b[key], NAMES[key] || human(key));
  }
  return rows;
}
export function noteChangeRows(first, current, { beatAt = t => t, firstBeat = 0, currentBeat = 0, fingers = null } = {}) {
  if (!first && !current) return [];
  if (!first) return [{ key: 'presence', label: 'Note', before: 'Not present', after: noteName(current.pitch) }];
  if (!current) return [{ key: 'presence', label: 'Note', before: noteName(first.pitch), after: 'Missing' }];
  const rows = [], add = (key, label, before, after) => { if (before !== after) rows.push({ key, label, before, after }); };
  add('pitch', 'Pitch', noteName(first.pitch), noteName(current.pitch));
  const length = n => beatAt(n.end) - beatAt(n.start);
  if (Math.abs(length(first) - length(current)) > 1 / 32 + 1e-9) add('length', 'Length', `${number(length(first))} ${length(first) === 1 ? 'beat' : 'beats'}`, `${number(length(current))} ${length(current) === 1 ? 'beat' : 'beats'}`);
  if (Math.abs(firstBeat - currentBeat) > 1 / 32 + 1e-9) add('onset', 'Onset in passage', `${number(firstBeat)} ${firstBeat === 1 ? 'beat' : 'beats'}`, `${number(currentBeat)} ${currentBeat === 1 ? 'beat' : 'beats'}`);
  const position = n => n.pos ? `S${n.pos.string + 1} · F${n.pos.fret}` : 'Not set';
  if (first.pitch === current.pitch) add('position', 'Position', position(first), position(current));
  const finger = n => {
    const f = fingers?.has(n.id) ? fingers.get(n.id) : n.finger;
    return f === 0 ? 'Thumb' : f > 0 ? String(f) : 'Not set';
  };
  add('finger', 'Finger', finger(first), finger(current));
  return [...rows, ...techniqueChangeRows(first, current)];
}

// Describe the actual note even when every occurrence plays it identically.
// Only active techniques are shown, keeping the card compact.
export function noteCharacteristicRows(note, { beatAt = t => t, fingers = null, onset = null } = {}) {
  if (!note) return [{ key: 'presence', label: 'Note', value: 'Missing' }];
  const length = beatAt(note.end) - beatAt(note.start);
  const finger = fingers?.has(note.id) ? fingers.get(note.id) : note.finger;
  const rows = [
    { key: 'pitch', label: 'Pitch', value: noteName(note.pitch) },
    { key: 'length', label: 'Length', value: `${number(length)} ${Math.abs(length - 1) < 1e-9 ? 'beat' : 'beats'}` },
    { key: 'position', label: 'Position', value: note.pos ? `S${note.pos.string + 1} · F${note.pos.fret}` : 'Not set' },
    { key: 'finger', label: 'Finger', value: finger === 0 ? 'Thumb' : finger > 0 ? String(finger) : 'Not set' },
  ];
  if (Number.isFinite(onset)) rows.splice(2, 0, { key: 'onset', label: 'Onset in passage', value: `${number(onset)} ${Math.abs(onset - 1) < 1e-9 ? 'beat' : 'beats'}` });
  const fields = effectiveTechniqueFields(note);
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'fx') {
      for (const [flag, active] of Object.entries(value || {})) if (clean(active) != null)
        rows.push({ key: `fx.${flag}`, label: FX_LABELS[flag] || human(flag), value: format(flag, active) });
    } else if (key === 'slideStart' && !note.slide) {
      continue;
    } else if (clean(value) != null && !(Array.isArray(value) && !value.length)) {
      const row = { key, label: NAMES[key] || human(key), value: format(key, value) };
      if (key === 'bendPoints' || key === 'whammyPoints') row.curve = value;
      rows.push(row);
    }
  }
  return rows;
}

// Suggestions always select an existing value: lower numeric median, or the
// middle occurrence in song order for categorical fields and curves.
// Missing notes vote on presence but do not vote on a present note's fields.
export function noteInstanceRows(instances, selected, { beatAt = t => t, fingers = null, activeIndex = null } = {}) {
  const item = instances[selected];
  if (!item) return [];
  const present = instances.filter(instance => instance.note);
  const rows = noteCharacteristicRows(item.note, { beatAt, fingers, onset: item.onset });
  if (item.note && instances.some(peer => Object.hasOwn(peer, 'handAnchor')))
    rows.push({ key: 'handAnchor', label: 'Hand anchor', value: item.handAnchor > 0 ? `F${item.handAnchor}` : 'Not set' });
  if (item.note && present.length !== instances.length)
    rows.unshift({ key: 'presence', label: 'Note', value: 'Present' });
  const differenceCache = new WeakMap();
  const differences = (a, b) => {
    let cache = differenceCache.get(a);
    if (!cache) differenceCache.set(a, cache = new WeakMap());
    if (!cache.has(b)) cache.set(b, new Set(noteChangeRows(a.note, b.note, {
      beatAt, fingers, firstBeat: a.onset ?? 0, currentBeat: b.onset ?? 0,
    }).map(row => row.key)));
    return cache.get(b);
  };
  if (item.note) for (const other of present) {
    for (const change of noteChangeRows(item.note, other.note, { beatAt, fingers, firstBeat: item.onset ?? 0, currentBeat: other.onset ?? 0 })) {
      if (!rows.some(row => row.key === change.key))
        rows.push({ key: change.key, label: change.label, value: change.before, curve: change.curves?.before });
    }
  }
  const slidePoints = peer => peer.slideCurve ?? (peer.note ? slideRibbon(peer.note, null)?.points : null) ?? [];
  if (item.note && present.some(peer => peer.note.slide || peer.note.slideIn))
    rows.push({ key: 'slideCurve', label: 'Slide curve', value: '', curve: slidePoints(item) });
  for (const row of rows) {
    const peers = row.key === 'presence' ? instances : row.key === 'position' ? present.filter(peer => peer.note.pitch === item.note.pitch) : present;
    const curveKey = row.key === 'bendPoints' || row.key === 'whammyPoints';
    const same = (a, b) => row.key === 'presence' ? !!a.note === !!b.note : row.key === 'handAnchor' ? (a.handAnchor ?? null) === (b.handAnchor ?? null) : row.key === 'slideCurve' ? JSON.stringify(clean(slidePoints(a))) === JSON.stringify(clean(slidePoints(b))) : !differences(a, b).has(row.key);
    const numeric = {
      length: peer => beatAt(peer.note.end) - beatAt(peer.note.start),
      onset: peer => peer.onset ?? 0,
      pitch: peer => peer.note.pitch,
      finger: peer => fingers?.has(peer.note.id) ? fingers.get(peer.note.id) : peer.note.finger ?? -1,
      handAnchor: peer => peer.handAnchor ?? -1,
    }[row.key];
    const ordered = numeric ? [...peers].sort((a,b) => numeric(a) - numeric(b)) : peers;
    const middle = ordered[Math.floor((ordered.length - 1) / 2)];
    row.uncommon = !!middle && !same(item, middle);
    if (row.uncommon) row.commonIndex = instances.indexOf(peers.find(peer => same(peer, middle)) || middle);
    if (row.key === 'length' && row.uncommon) {
      row.commonLength = numeric(middle);
      row.commonDisplay = `${number(row.commonLength)} ${Math.abs(row.commonLength - 1) < 1e-9 ? 'beat' : 'beats'}`;
    }
    if (curveKey && peers.some(peer => !same(item, peer) &&
      curveSummary(effectiveTechniqueFields(peer.note)[row.key]) === row.value)) row.curveVaries = true;
    if (row.curve?.length) {
      const values = present.flatMap(peer => (row.key === 'slideCurve' ? slidePoints(peer) : noteCharacteristicRows(peer.note, { beatAt, fingers })
        .find(candidate => candidate.key === row.key)?.curve)?.map(([, value]) => value) || []);
      row.curveRange = [Math.min(0, ...values), Math.max(0, ...values)];
    }
  }
  return rows.filter(row => !['whammy', 'bend', 'slide', 'slideIn', 'slideStart', 'slideEnd', 'slideFrets'].includes(row.key));
}

// Copy one displayed change, leaving unrelated note properties alone. Curves
// include their enabling effect so the copied shape is actually played.
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
export function applyNoteCounterpart(key, source, target, {
  beatAt = t => t, timeAt = b => b, sourceOrigin = 0, targetOrigin = 0, fingers = null,
} = {}) {
  if (!source || !target) return false;
  const before = JSON.stringify(target), fields = effectiveTechniqueFields(source);
  const set = (field, value) => { if (value == null || value === false) delete target[field]; else target[field] = clone(value); };
  if (key === 'pitch') {
    if (Number.isFinite(target.soundingPitch)) target.soundingPitch += source.pitch - target.pitch;
    target.pitch = source.pitch;
  } else if (key === 'length') {
    target.end = timeAt(beatAt(target.start) + beatAt(source.end) - beatAt(source.start));
  } else if (key === 'onset') {
    const length = beatAt(target.end) - beatAt(target.start);
    target.start = timeAt(targetOrigin + beatAt(source.start) - sourceOrigin);
    target.end = timeAt(beatAt(target.start) + length);
  } else if (key === 'position') {
    if (source.pos) target.pos = { ...target.pos, string: source.pos.string, fret: source.pos.fret };
    else delete target.pos;
  } else if (key === 'finger') {
    const finger = fingers?.has(source.id) ? fingers.get(source.id) : source.finger;
    set('finger', Number.isInteger(finger) && finger >= 0 && finger <= 4 ? finger : null);
  } else if (key.startsWith('fx.')) {
    const flag = key.slice(3), value = source.fx?.[flag];
    const fx = { ...target.fx, [flag]: clone(value) };
    if (value == null || value === false) delete fx[flag];
    if (Object.keys(fx).length) target.fx = fx; else delete target.fx;
  } else if (key === 'slideCurve') {
    for (const field of ['slide', 'slideIn', 'slideStart', 'slideEnd', 'slideFrets']) set(field, source[field]);
  } else if (key === 'bend' || key === 'bendPoints') {
    set('bend', source.bend); set('bendPoints', fields.bendPoints);
  } else if (key === 'whammy' || key === 'whammyPoints') {
    set('whammy', source.whammy); set('whammyPoints', fields.whammyPoints);
  } else if (Object.hasOwn(NAMES, key)) {
    if (key === 'vibratoStart' || key === 'vibratoEnd') {
      const fx = { ...target.fx };
      if (source.fx?.vibrato) fx.vibrato = clone(source.fx.vibrato); else delete fx.vibrato;
      if (Object.keys(fx).length) target.fx = fx; else delete target.fx;
    }
    set(key, fields[key]);
  } else return false;
  return JSON.stringify(target) !== before;
}


export function applyPresenceCounterpart(lane, source, target, {
  beatAt = t => t, timeAt = b => b, sourceOrigin = 0, targetOrigin = 0, fingers = null, mintId, targetIds,
} = {}) {
  if (source && !target) {
    const start = timeAt(targetOrigin + beatAt(source.start) - sourceOrigin);
    const end = timeAt(beatAt(start) + beatAt(source.end) - beatAt(source.start));
    const note = copyEffects(clone(source), { id: mintId(), pitch: source.pitch, start, end });
    const finger = fingers?.has(source.id) ? fingers.get(source.id) : source.finger;
    if (Number.isInteger(finger) && finger >= 0 && finger <= 4) note.finger = finger;
    if (Number.isFinite(source.soundingPitch)) note.soundingPitch = source.soundingPitch;
    lane.notes.push(note); targetIds?.push(note.id);
    return { changed: true, note };
  }
  if (!source && target) {
    lane.notes = lane.notes.filter(note => note !== target);
    return { changed: true, note: null };
  }
  return { changed: false, note: target };
}
