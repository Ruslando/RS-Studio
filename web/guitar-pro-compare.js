// Musical/tablature comparison for alphaTab Score instances.
//
// Guitar Pro files are archives, so byte equality is not meaningful: alphaTab
// can rewrite the container while preserving the score exactly.  This module
// reduces two scores to a stable semantic model and reports field-level paths.
// It is DOM-free so the same comparison can run in Node regression tests and in
// future import diagnostics inside the app.

const scalar = (value) => value == null ? null : value;
const points = (value) => (value || []).map((point) => ({
  offset: scalar(point.offset ?? point.position),
  value: scalar(point.value),
}));

function automation(value) {
  return {
    type: scalar(value?.type), value: scalar(value?.value),
    ratioPosition: scalar(value?.ratioPosition), isLinear: !!value?.isLinear,
    text: value?.text || "",
  };
}

function section(value) {
  return value ? { marker: value.marker || "", text: value.text || "" } : null;
}

function beatLocation(beat) {
  const voice = beat?.voice, bar = voice?.bar, staff = bar?.staff, track = staff?.track;
  return beat ? [scalar(track?.index), scalar(staff?.index), scalar(bar?.index),
    scalar(voice?.index), scalar(beat.index)] : null;
}

function noteLocation(note) {
  if (!note) return null;
  const beat = beatLocation(note.beat);
  return beat ? [...beat, scalar(note.index)] : null;
}

function fermata(value) {
  return value ? { type: scalar(value.type), length: scalar(value.length) } : null;
}

function chord(value) {
  return {
    name: value?.name || "", firstFret: scalar(value?.firstFret), strings: [...(value?.strings || [])],
    barreFrets: [...(value?.barreFrets || [])], showName: value?.showName !== false,
    showDiagram: value?.showDiagram !== false, showFingering: value?.showFingering !== false,
  };
}

function tremoloPicking(beat) {
  const effect = beat?.tremoloPicking;
  if (!effect) return null;
  let duration = null;
  // alphaTab's effect models are version-specific; an older bundle may not
  // implement getDuration for this effect. A null duration compares as absent,
  // which is the right answer when we cannot ask.
  try { duration = effect.getDuration?.(beat.duration) ?? null; } catch { /* unsupported in this alphaTab */ }
  return { marks: scalar(effect.marks), duration };
}

function noteSnapshot(note) {
  return {
    pitch: scalar(note.realValueWithoutHarmonic), soundingPitch: scalar(note.realValue),
    string: scalar(note.string), fret: scalar(note.fret), octave: scalar(note.octave), tone: scalar(note.tone),
    tie: [!!note.isTieDestination, noteLocation(note.tieOrigin), noteLocation(note.tieDestination)],
    visible: note.isVisible !== false, dead: !!note.isDead, ghost: !!note.isGhost,
    showStringNumber: !!note.showStringNumber,
    letRing: !!note.isLetRing, palmMute: !!note.isPalmMute, staccato: !!note.isStaccato,
    hammerPull: [!!note.isHammerPullOrigin, noteLocation(note.hammerPullOrigin),
      noteLocation(note.hammerPullDestination)],
    slur: [!!note.isSlurDestination, noteLocation(note.slurOrigin), noteLocation(note.slurDestination)],
    effectSlur: [!!note.hasEffectSlur, !!note.isEffectSlurOrigin,
      noteLocation(note.effectSlurOrigin), noteLocation(note.effectSlurDestination)],
    slide: [scalar(note.slideInType), scalar(note.slideOutType),
      noteLocation(note.slideOrigin), noteLocation(note.slideTarget)],
    bend: [scalar(note.bendType), scalar(note.bendStyle), !!note.isContinuedBend,
      noteLocation(note.bendOrigin), points(note.bendPoints)],
    harmonic: [scalar(note.harmonicType), scalar(note.harmonicValue)],
    trill: [scalar(note.trillValue), scalar(note.trillSpeed)],
    vibrato: scalar(note.vibrato), accentuated: scalar(note.accentuated),
    ornament: scalar(note.ornament), accidentalMode: scalar(note.accidentalMode),
    fingers: [scalar(note.leftHandFinger), scalar(note.rightHandFinger)],
    dynamics: scalar(note.dynamics), durationPercent: scalar(note.durationPercent),
    leftHandTapped: !!note.isLeftHandTapped, percussionArticulation: scalar(note.percussionArticulation),
  };
}

function beatSnapshot(beat) {
  return {
    timing: [scalar(beat.absolutePlaybackStart), scalar(beat.playbackStart), scalar(beat.playbackDuration),
      scalar(beat.displayStart), scalar(beat.displayDuration), scalar(beat.overrideDisplayDuration)],
    rhythm: [scalar(beat.duration), scalar(beat.dots), scalar(beat.tupletNumerator),
      scalar(beat.tupletDenominator), scalar(beat.graceType)],
    state: [!!beat.isEmpty, !!beat.isRest, !!beat.isLetRing, !!beat.isPalmMute,
      !!beat.isLegatoOrigin, !!beat.isEffectSlurOrigin, !!beat.isContinuedWhammy],
    relations: [beatLocation(beat.effectSlurOrigin), beatLocation(beat.effectSlurDestination)],
    dynamics: scalar(beat.dynamics), pickStroke: scalar(beat.pickStroke),
    brush: [scalar(beat.brushType), scalar(beat.brushDuration)],
    tremoloPicking: tremoloPicking(beat),
    whammy: [scalar(beat.whammyBarType), scalar(beat.whammyStyle), points(beat.whammyBarPoints)],
    vibrato: scalar(beat.vibrato), crescendo: scalar(beat.crescendo), fade: scalar(beat.fade),
    slap: [!!beat.tap, !!beat.slap, !!beat.pop, !!beat.deadSlapped],
    effects: [scalar(beat.golpe), scalar(beat.rasgueado), scalar(beat.wahPedal), scalar(beat.ottava)],
    notation: [scalar(beat.beamingMode), !!beat.invertBeamDirection,
      scalar(beat.preferredBeamDirection), !!beat.slashed],
    barre: [scalar(beat.barreFret), scalar(beat.barreShape)],
    chordId: beat.chordId || "", text: beat.text || "",
    lyrics: (beat.lyrics || []).map((line) => line?.text ?? String(line ?? "")),
    fermata: fermata(beat.fermata),
    automations: (beat.automations || []).map(automation),
    notes: (beat.notes || []).map(noteSnapshot),
  };
}

function barSnapshot(bar) {
  return {
    clef: scalar(bar.clef), clefOttava: scalar(bar.clefOttava),
    key: [scalar(bar.keySignature), scalar(bar.keySignatureType)],
    simileMark: scalar(bar.simileMark),
    barLines: [scalar(bar.barLineLeft), scalar(bar.barLineRight)],
    sustainPedals: (bar.sustainPedals || []).map((pedal) => ({
      ratioPosition: scalar(pedal.ratioPosition), type: scalar(pedal.pedalType ?? pedal.type),
    })),
    voices: (bar.voices || []).map((voice) => ({
      empty: !!voice.isEmpty,
      beats: (voice.beats || []).map(beatSnapshot),
    })),
  };
}

function masterBarSnapshot(bar) {
  return {
    start: scalar(bar.start),
    timeSignature: [scalar(bar.timeSignatureNumerator), scalar(bar.timeSignatureDenominator),
      !!bar.timeSignatureCommon],
    repeat: [!!bar.isRepeatStart, scalar(bar.repeatCount), scalar(bar.alternateEndings)],
    tripletFeel: scalar(bar.tripletFeel),
    flags: [!!bar.isAnacrusis, !!bar.isDoubleBar, !!bar.isFreeTime],
    section: section(bar.section),
    directions: [...(bar.directions || [])].map(scalar).sort((a, b) => String(a).localeCompare(String(b))),
    tempos: (bar.tempoAutomations || []).map(automation),
  };
}

function trackSnapshot(track) {
  const playback = track.playbackInfo || {};
  return {
    name: track.name || "", shortName: track.shortName || "",
    playback: {
      program: scalar(playback.program), bank: scalar(playback.bank),
      volume: scalar(playback.volume), balance: scalar(playback.balance),
      port: scalar(playback.port), primaryChannel: scalar(playback.primaryChannel),
      secondaryChannel: scalar(playback.secondaryChannel), mute: !!playback.isMute, solo: !!playback.isSolo,
    },
    visibleOnMultiTrack: track.isVisibleOnMultiTrack !== false,
    staves: (track.staves || []).map((staff) => ({
      tuning: {
        values: [...(staff.stringTuning?.tunings || [])], name: staff.stringTuning?.name || "",
        standard: !!staff.stringTuning?.isStandard,
      },
      capo: scalar(staff.capo),
      transposition: [scalar(staff.transpositionPitch), scalar(staff.displayTranspositionPitch)],
      percussion: !!staff.isPercussion,
      notation: [staff.showStandardNotation !== false, staff.showTablature !== false,
        !!staff.showSlash, !!staff.showNumbered, scalar(staff.standardNotationLineCount)],
      chords: [...(staff.chords || new Map()).entries()]
        .map(([id, value]) => [String(id), chord(value)])
        .sort((a, b) => a[0].localeCompare(b[0])),
      bars: (staff.bars || []).map(barSnapshot),
    })),
  };
}

function guitarProSemanticSnapshot(score) {
  return {
    metadata: {
      title: score?.title || "", subTitle: score?.subTitle || "", artist: score?.artist || "",
      album: score?.album || "", words: score?.words || "", music: score?.music || "",
      copyright: score?.copyright || "", tab: score?.tab || "", instructions: score?.instructions || "",
      notices: score?.notices || "",
      tempo: scalar(score?.tempo),
    },
    masterBars: (score?.masterBars || []).map(masterBarSnapshot),
    tracks: (score?.tracks || []).map(trackSnapshot),
  };
}

function jsonClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function importedNoteSnapshot(note) {
  return {
    id: note.id, start: scalar(note.start), end: scalar(note.end),
    pitch: scalar(note.pitch), soundingPitch: scalar(note.soundingPitch),
    position: note.pos ? { string: scalar(note.pos.string), fret: scalar(note.pos.fret),
      scope: note.pos.scope || "" } : null,
    slide: note.slide ?? null, bend: note.bend ?? null, harmonic: note.harmonic ?? null,
    grace: note.grace ?? null, trill: note.trill ?? null, tremPick: note.tremPick ?? null,
    slap: note.slap ?? null, stroke: note.stroke ?? null, whammy: note.whammy ?? null,
    effects: jsonClone(note.fx ?? null), provenance: jsonClone(note.gp ?? null),
  };
}

function importedLaneSnapshot(lane) {
  return {
    id: lane.id, sourceTrackIndex: scalar(lane.sourceTrackIndex),
    sourceStaffIndex: scalar(lane.sourceStaffIndex), name: lane.name || "",
    instrument: lane.instrument || "", tone: lane.tone || "", gmProgram: scalar(lane.gmProgram),
    capo: scalar(lane.capo), transpositionPitch: scalar(lane.transpositionPitch),
    displayTranspositionPitch: scalar(lane.displayTranspositionPitch),
    tuning: lane.tuning || "", customTuning: lane.customTuning || "",
    fingeringMode: lane.fingeringMode || "", tablatureEnabled: lane.tablatureEnabled !== false,
    notes: (lane.notes || []).map(importedNoteSnapshot),
  };
}

// This is intentionally separate from score comparison. It checks that the
// app's persisted flat transcription and exact GP provenance equal a fresh
// conversion of the untouched source, so source fields cannot hide a broken
// import merely because score export begins from an original-score clone.
function guitarProImportSnapshot(value) {
  const gp = value?.guitarPro || {};
  return {
    lanes: (value?.editLanes || []).filter((lane) => lane.sourceTrackIndex != null)
      .map(importedLaneSnapshot),
    guitarPro: jsonClone({
      schemaVersion: gp.schemaVersion, alphaTabVersion: gp.alphaTabVersion,
      selectedTrackIndexes: gp.selectedTrackIndexes, selectedTracks: gp.selectedTracks,
      score: gp.score, projectionSignature: gp.projectionSignature,
      structuralSignature: gp.structuralSignature,
    }),
  };
}

function signature(value) {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}:${text.length}`;
}

function collectDifferences(expected, actual, path, report, maxDifferences) {
  if (Object.is(expected, actual)) return;
  const expectedObject = expected !== null && typeof expected === "object";
  const actualObject = actual !== null && typeof actual === "object";
  if (!expectedObject || !actualObject || Array.isArray(expected) !== Array.isArray(actual)) {
    report.differenceCount++;
    if (report.differences.length < maxDifferences) report.differences.push({ path, expected, actual });
    return;
  }
  if (Array.isArray(expected)) {
    if (expected.length !== actual.length) {
      report.differenceCount++;
      if (report.differences.length < maxDifferences)
        report.differences.push({ path: `${path}.length`, expected: expected.length, actual: actual.length });
    }
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index++)
      collectDifferences(expected[index], actual[index], `${path}[${index}]`, report, maxDifferences);
    return;
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of keys)
    collectDifferences(expected[key], actual[key], path ? `${path}.${key}` : key, report, maxDifferences);
}

function compareSnapshots(expected, actual, maxDifferences) {
  const report = { differenceCount: 0, differences: [] };
  collectDifferences(expected, actual, "", report, Math.max(0, Number(maxDifferences) || 0));
  return {
    equal: report.differenceCount === 0,
    differenceCount: report.differenceCount,
    truncated: report.differenceCount > report.differences.length,
    expectedSignature: signature(expected), actualSignature: signature(actual),
    differences: report.differences,
  };
}

export function compareGuitarProScores(expectedScore, actualScore, { maxDifferences = 100 } = {}) {
  return compareSnapshots(guitarProSemanticSnapshot(expectedScore),
    guitarProSemanticSnapshot(actualScore), maxDifferences);
}

export function compareGuitarProImportData(expectedConversion, actualProject, { maxDifferences = 100 } = {}) {
  return compareSnapshots(guitarProImportSnapshot(expectedConversion),
    guitarProImportSnapshot(actualProject), maxDifferences);
}
