// Constants & lookup tables shared across the editor modules. Pure data plus the
// Tone.js instrument factories (Tone is read as a runtime global). A dependency
// sink: imported widely, imports nothing.

// ---- Runaway-loop ceilings ----
// Every unbounded `while` in the app carries one, and the convention is: hitting
// it is a bug, never a quiet truncation. Export paths throw — the user is
// waiting for a file, and a silently short file is worse than an error. Render
// paths warn and stop, because taking the canvas down over one pathological song
// is worse than drawing most of it. Sized so ordinary music cannot reach them:
// 10,000 bars is about eleven hours of 4/4 at 120bpm.
export const MAX_BARS_SCANNED = 10000;
export const MAX_TIE_CHAIN = 1024;
export const MAX_RHYTHM_PIECES = 512;
export const MAX_METRONOME_BEATS = 512;

export const PX_PER_SEC = 120;      // base time scale at 100% zoom (px per second)
export const STAGE_HEIGHT_DEFAULT = 520; // fallback viewport height while the shell is hidden
export const STAGE_HEIGHT_MIN = 360;

export const ZOOM_MIN_X = 0.25, ZOOM_MAX_X = 12;
export const ZOOM_MIN_Y = 1,    ZOOM_MAX_Y = 8;
export const ZOOM_STEP = 1.2;       // multiplicative step per wheel notch / button press
export const MINIMAP_H = 64;        // overview/minimap content height (spectrogram band, px)
export const MM_HEAD = 15;          // headroom strip atop the overview that carries the draggable playhead pin (px)
export const RULER_W = 44;
export const EDGE_PX = 6;
export const BEND_HANDLE_R = 4;     // px; bend control-point dot radius (grab radius is a touch wider)
export const MIN_DUR = 0.05;
export const MIN_REGION = 0.05;     // s; an Alt-drag narrower than this just clears the detect frame
export const REGION_GRAB = 6;       // px; how close to a frame edge counts as grabbing its resize handle
export const REGION_HANDLE_H = 44;  // px; visible drag-handle height centered on each frame edge
export const DRAG_THRESH = 4;
export const LOOKAHEAD = 0.12;      // s of note scheduling lookahead
export const TRACE_POINT_GAP = 3;   // px between stored guide points while tracing
export const TRACE_FALLBACK_STEP = 0.25;
export const AUTOSCROLL_ZONE = 48;  // px from a viewport edge where the timeline starts panning
export const AUTOSCROLL_MAX = 20;   // px/frame at the edge (ramps from 0 at the zone boundary)
export const SIMILAR_THRESHOLD = 0.6;   // min normalized cross-correlation (note band) to surface a passage
export const SIMILAR_GLOBAL_THRESHOLD = 0.7;  // higher bar for the wider harmonic band (less pitch-specific)
export const SIMILAR_MAX_MATCHES = 60;  // cap suggestions so a repetitive song can't flood the canvas
export const SIMILAR_PITCH_MARGIN = 2;  // semitones of spectrogram band padding around the selection
export const SIMILAR_HARMONIC_SPAN = 24; // semitones above the selection scored as a harmonic fallback band

// ---- Stage type ----
// No stylesheet reaches a canvas, so the two families from tokens.css are
// restated here — once, in one place, because the last time they were spelled
// out at each call site the app changed fonts and twenty string literals kept
// asking for 'Manrope' and 'JetBrains Mono', which stopped existing and fell
// through to whatever the OS had. Use mono for
// a value you can compare, sort or scrub; the selected UI font for anything that reads as a
// word.
//
// Size is the app's 11 with one exception, and the exception is the stage's
// alone: text anchored to a single note or pitch row is 9. A row is as tall as
// the pitch zoom makes it — 6px at the lowest — and a name inside a bar that
// short cannot be 11; the draw code already drops a label too wide for its note,
// so 11 there does not shrink the type, it deletes it. The stage uses
// its own colours for data; its note-anchored type is data at
// the same scale, and 9 is the only size below 11 in the system. Everything on
// the stage that floats free of a note — rails, flags, chips, the range readout
// — is chrome and stays at 11.
// Keep canvas text at the same 94% scale as the editor's DOM typography.
const EDITOR_TEXT_SCALE = .94;
export const stageUi = (px = 11, weight = 400) => `${weight} ${px * EDITOR_TEXT_SCALE}px 'Atkinson Hyperlegible Next', sans-serif`;
export const stageMono = (px = 11, weight = 400) => `${weight} ${px * EDITOR_TEXT_SCALE}px 'IBM Plex Mono', ui-monospace, monospace`;
export const STAGE_ANCHORED = 9;   // the note/row-anchored size, and the only one below 11

export const EDIT_PALETTE = ["#6ee7b7", "#fbbf72", "#a5b4fc", "#f9a8d4", "#67e8f9", "#fca5a5"];
export const OVERLAP_EPS = 1e-4;        // s; overlaps below this are float noise / abutting notes, not stacks
export const DEFAULT_LAYER_VOLUME = 1;   // per-layer synth playback gain, normalized 0..1

// Instrument voices feed the in-editor playback. All of them use real recorded
// samples (Tone.Sampler, files under web/vendor/samples/ — tonejs-instruments,
// CC-BY 3.0); each Sampler pitch-shifts from the nearest recording, so a sparse
// note set covers the whole range. Every factory returns an instrument already
// wired to the destination and exposing the Tone voice API (triggerAttackRelease
// / releaseAll / dispose), so the scheduler is untouched.
export const SAMPLE_BASE = "vendor/samples/";
export const _SAMPLES = {
  "guitar-electric": ["Ds3","Ds4","Ds5","E2","Fs2","Fs3","Fs4","Fs5","A2","A3","A4","A5","C3","C4","C5","C6","Cs2"],
  "guitar-acoustic": ["F4","Fs2","Fs3","Fs4","G2","G3","G4","Gs2","Gs3","Gs4","A2","A3","A4","As2","As3","As4","B2","B3","B4","C3","C4","C5","Cs3","Cs4","Cs5","D2","D3","D4","D5","Ds2","Ds3","E2","E3","E4","F2","F3"],
  "bass-electric":   ["As1","As2","As3","As4","Cs1","Cs2","Cs3","Cs4","E1","E2","E3","E4","G1","G2","G3","G4"],
};
// Filenames spell sharps with 's' (Cs2 = C#2); Tone wants the real pitch as key.
function sampleUrls(name) {
  const urls = {};
  for (const f of _SAMPLES[name]) urls[f.replace(/^([A-G])s/, "$1#")] = f + ".mp3";
  return urls;
}
function makeSampler(name, opts = {}) {
  return new Tone.Sampler({ urls: sampleUrls(name), baseUrl: SAMPLE_BASE + name + "/", release: 1, ...opts }).toDestination();
}
// Distortion guitar = the electric samples driven through overdrive + a tone
// rolloff. dispose() also tears down the effect nodes this voice owns.
function makeDistortionGuitar() {
  const dist = new Tone.Distortion({ distortion: 0.5, wet: 0.9 });
  const tone = new Tone.Filter(3400, "lowpass");
  const sampler = new Tone.Sampler({ urls: sampleUrls("guitar-electric"), baseUrl: SAMPLE_BASE + "guitar-electric/", release: 0.6 });
  sampler.chain(dist, tone, Tone.getDestination());
  const disposeSampler = sampler.dispose.bind(sampler);
  // Each stage disposes independently: one already-disposed node must not stop
  // the others being released, or the audio graph leaks on every project switch.
  sampler.dispose = () => {
    try { disposeSampler(); } catch { /* already disposed */ }
    try { dist.dispose(); } catch { /* already disposed */ }
    try { tone.dispose(); } catch { /* already disposed */ }
  };
  return sampler;
}
// A lane names two things, and they used to be one field. **The instrument is the
// object in your hands; the tone is what comes out of it.** One key said both, so
// "Electric Guitar" and "Distortion Guitar" were two instruments — which is a
// claim that a pedal changes the neck, and it left the fretboard panel with four
// instruments to draw three necks for.
//
// The instrument decides what is *fretted*: the neck the board draws, how many
// strings it has, and the default tuning. There are three because there are three
// necks (see FRETBOARDS in fretboard-core.js, which is keyed by these).
//
// `tone` is the sound it makes with no effect applied — what a lane gets when its
// instrument changes and nothing was chosen. It is a default, not a constraint:
// the two fields are independent afterwards, and a bass tone on an electric neck
// is legal. Odd, but legal, and the app has no business refusing it.
export const INSTRUMENTS = {
  electric: { label: "Electric guitar", tone: "electric", tuning: "guitar6" },
  acoustic: { label: "Acoustic guitar", tone: "acoustic", tuning: "guitar6" },
  bass:     { label: "Bass guitar",     tone: "bass",     tuning: "bass4" },
};
export const DEFAULT_INSTRUMENT = "electric";

// The tone is everything about the sound: the in-editor playback voice (make) and
// the exported Guitar Pro program (gm = General MIDI). Four, because an electric
// plays clean or dirty and that is a pedal rather than a different guitar — the
// one distinction the old single field could not make without inventing an
// instrument for it.
export const TONES = {
  electric:   { label: "Electric",   make: () => makeSampler("guitar-electric"), gm: 27 },
  distortion: { label: "Distortion", make: makeDistortionGuitar,                 gm: 30 },
  acoustic:   { label: "Acoustic",   make: () => makeSampler("guitar-acoustic"), gm: 25 },
  bass:       { label: "Bass",       make: () => makeSampler("bass-electric"),   gm: 33 },
};
export const DEFAULT_TONE = "electric";

// Projects saved before the split have one key naming both, so both normalizers
// read the old vocabulary: `guitar_dist` was never an instrument, it was an
// electric with a pedal on. Kept here rather than only in the project loader
// because every reader of these fields goes through these two functions, and a
// lane can also arrive from a Guitar Pro import or a paste.
const LEGACY = {
  guitar:      { instrument: "electric", tone: "electric" },
  guitar_dist: { instrument: "electric", tone: "distortion" },
  lead:        { instrument: "electric", tone: "electric" },
};
export function instrKey(k) {
  return INSTRUMENTS[k] ? k : LEGACY[k]?.instrument || DEFAULT_INSTRUMENT;
}
export function toneKey(k) {
  return TONES[k] ? k : LEGACY[k]?.tone || DEFAULT_TONE;
}
