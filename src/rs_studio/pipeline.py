"""Core analysis pipeline: audio -> (optional stem) -> spectrogram + notes.

Heavy deps (librosa, demucs, basic_pitch) are imported lazily inside the
functions so that `--help` and the web server import fast and don't crash if a
single backend is missing.
"""
from __future__ import annotations

from . import processing

import contextlib
import io
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from .audio_runtime import prepare_ffmpeg

# Source runs and frozen builds must resolve the same audio dependencies.
prepare_ffmpeg()

# --- Display / analysis constants -------------------------------------------
# One CQT bin per semitone. The range covers most guitar/bass material so the
# spectrogram rows line up exactly with MIDI pitches for note overlay. The floor
# is C1 (32.7 Hz) so bass fundamentals are visible — a 4-string bass's open E1
# (41 Hz) and A1 (55 Hz) sit below C2, so a higher floor clips them and only
# their octave-up harmonics show, leading to notes traced an octave too high.
MIDI_LOW = 24   # C1
MIDI_HIGH = 96  # C7
N_BINS = MIDI_HIGH - MIDI_LOW + 1  # inclusive -> 73 semitone bins (C1..C7)
BINS_PER_OCTAVE = 12
HOP_LENGTH = 512
SAMPLE_RATE = 22050

# Demucs downloads htdemucs_6s to its standard torch cache on first use
# (~/.cache/torch/hub/checkpoints) — the recommended path, no manual placement.
DEMUCS_MODEL = "htdemucs_6s"  # 6-source bag: drums/bass/other/vocals/guitar/piano

# Stem views surfaced to the editor, in tab order. "mix" is the full song (the
# uploaded file); the rest are separator outputs. htdemucs_6s yields all six
# SEPARABLE_STEMS in one pass; the caller picks which to render (transcode + CQT)
# via analyze(stems=...). Unrendered stems' wavs stay on disk (separation already
# paid for), so they can be surfaced later without re-separating.
MIX_STEM = ("mix", "Full song")
SEPARABLE_STEMS = [
    ("vocals", "Vocals"), ("drums", "Drums"), ("bass", "Bass"),
    ("guitar", "Guitar"), ("piano", "Piano"), ("other", "Other"),
]
DEFAULT_STEMS = ["guitar", "bass"]            # surfaced when the caller doesn't pick
STEM_LABELS = dict([MIX_STEM, *SEPARABLE_STEMS])


@dataclass
class StemView:
    """One switchable view: its own playback audio + spectrogram backdrop."""
    id: str
    name: str
    audio_path: Path
    spectrogram: dict


@dataclass
class AnalysisResult:
    duration: float
    sample_rate: int
    tempo: float | None
    offset: float | None
    stems: list[StemView]
    separated: bool
    warnings: list[str] = field(default_factory=list)
    separator: str | None = None  # backend that produced the stems, when separated


def _to_playback(src: Path, out: Path) -> bool:
    """Render `src` to an Opus file for browser playback. Returns True on success.

    Playback audio doesn't need to be lossless — the spectrogram (the thing that
    must stay bit-exact) is computed from the lossless source separately, so the
    file the browser holds and the .chart bundle carries can be small. Opus at
    128 kbps is transparent for listening yet roughly 10x smaller than FLAC,
    which is what shrinks the saved project. Crucially it still seeks
    sample-accurately (Ogg granule positions carry sample offsets), unlike VBR
    MP3 whose byte-estimated seeking lands at the wrong spot and desyncs playback
    from the spectrogram. Chrome/Edge/Firefox all play Ogg/Opus in <audio>.

    `-ar 48000` is required: libopus only accepts 48/24/16/12/8 kHz, so without
    it a 44.1 kHz source (i.e. most music) errors out and we'd fall back to the
    big lossless file. 48 kHz is libopus's native rate; resampling keeps the
    duration in seconds identical, so seeking stays time-accurate.
    """
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(src), "-map", "a",
             "-c:a", "libopus", "-b:a", "128k", "-ar", "48000", str(out)],
            check=True, capture_output=True, text=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        return out.exists()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def _save_audio_soundfile(wav, path, samplerate, **kwargs) -> None:
    """Write a Demucs stem as 16-bit PCM WAV via soundfile.

    Replaces Demucs' default ``torchaudio.save``, which routes through
    torchcodec and can't load in a frozen (PyInstaller) build. Demucs reads
    audio via an ffmpeg subprocess, so with this swap torchcodec is never used.
    """
    import numpy as np
    import soundfile as sf

    data = wav.detach().cpu().numpy()
    if data.ndim == 2:           # (channels, samples) -> (samples, channels)
        data = data.T
    sf.write(str(path), np.clip(data, -1.0, 1.0), int(samplerate), subtype="PCM_16")


def _select_device() -> str:
    """Pick the fastest available Torch device for separation.

    Order: CUDA → DirectML → CPU. DirectML (AMD/Intel/NVIDIA GPUs on Windows) is
    used only when the optional `torch-directml` package is installed; the import
    is guarded, so a machine without it behaves exactly as before (CPU). To enable
    it: `pip install torch-directml` (note it pins a specific torch version).
    Demucs's DirectML op coverage isn't guaranteed, so treat it as best-effort.
    """
    try:
        import torch
    except Exception:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    try:
        import torch_directml

        if torch_directml.is_available():
            return str(torch_directml.device())  # e.g. "privateuseone:0"
    except Exception:
        pass
    return "cpu"


def separate_stems(input_path: Path, out_dir: Path) -> tuple[dict[str, Path], str | None]:
    """Run Demucs htdemucs_6s ONCE and return every stem it produced.

    Demucs downloads the model to its standard torch cache on first use, so no
    manual checkpoint placement is needed. Returns ({stem_name: wav_path},
    warning); empty dict + warning on failure. The 6-source bag yields drums/
    bass/other/vocals/guitar/piano in a single pass, so callers keep what they need.
    """
    device = _select_device()

    # Run Demucs in-process (not as a `python -m demucs` subprocess): when the
    # app is frozen into a standalone build, sys.executable is the app itself,
    # not a Python interpreter, so the subprocess form would never work.
    args = [
        "-n", DEMUCS_MODEL,
        "--device", device,
        "-o", str(out_dir),
        str(input_path),
    ]
    sink = processing.SeparationOutput(device)
    processing.report("Loading separation model", device=device)
    try:
        import demucs.separate as _demucs_separate
        from demucs.separate import main as demucs_main
        _demucs_separate.save_audio = _save_audio_soundfile  # avoid torchaudio/torchcodec on save
        # Demucs prints input paths and model progress. A Windows windowed
        # app or legacy console must not fail on a Unicode song filename.
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            demucs_main(args)
    except ImportError:
        return {}, "Demucs is not installed."
    except SystemExit as exc:  # argparse/CLI error path raises SystemExit
        if exc.code:
            output = sink.getvalue().strip()
            detail = f":\n{output}" if output else ""
            return {}, f"Demucs separation failed (exit code {exc.code}){detail}."
    except Exception as exc:
        return {}, f"Demucs separation failed (model download or processing error): {exc}"

    stem_dir = out_dir / DEMUCS_MODEL / input_path.stem
    stems = {p.stem: p for p in stem_dir.glob("*.wav")}
    if not stems:
        return {}, "Demucs ran but produced no stems."
    return stems, None


def _magma(values) -> "np.ndarray":
    """Map an array of floats in [0,1] to an RGB uint8 image (magma-ish)."""
    import numpy as np

    # A handful of control points approximating the magma colormap.
    stops = np.array([
        [0.00, 0, 0, 4],
        [0.15, 28, 16, 68],
        [0.30, 79, 18, 123],
        [0.45, 129, 37, 129],
        [0.60, 181, 54, 122],
        [0.75, 229, 80, 100],
        [0.88, 251, 135, 97],
        [1.00, 252, 253, 191],
    ])
    xs = stops[:, 0]
    r = np.interp(values, xs, stops[:, 1])
    g = np.interp(values, xs, stops[:, 2])
    b = np.interp(values, xs, stops[:, 3])
    return np.stack([r, g, b], axis=-1).astype("uint8")


def compute_spectrogram(audio_path: Path, png_out: Path, with_tempo: bool = False) -> dict:
    """Compute a semitone-aligned CQT, render it to a PNG, return metadata.

    `with_tempo` runs beat tracking (only worth doing once per song, on the mix).
    """
    import librosa
    import numpy as np
    from PIL import Image

    y, sr = librosa.load(str(audio_path), sr=SAMPLE_RATE, mono=True)
    duration = float(len(y) / sr)

    fmin = librosa.midi_to_hz(MIDI_LOW)
    cqt = np.abs(
        librosa.cqt(
            y, sr=sr, fmin=fmin, n_bins=N_BINS,
            bins_per_octave=BINS_PER_OCTAVE, hop_length=HOP_LENGTH,
        )
    )
    db = librosa.amplitude_to_db(cqt, ref=np.max)  # (n_bins, n_frames)
    lo, hi = db.min(), db.max()
    norm = (db - lo) / (hi - lo + 1e-9)

    # Image: row 0 = top = highest pitch, so flip vertically.
    rgb = _magma(norm)                 # (n_bins, n_frames, 3)
    rgb = np.flipud(rgb)
    Image.fromarray(rgb, "RGB").save(png_out)

    # Tempo + first-beat estimate, so the UI can lay down a beat grid.
    # Best-effort: a bad estimate shouldn't break analysis, and the user can
    # override both values anyway.
    tempo = None
    offset = None
    if with_tempo:
        try:
            bpm, beats = librosa.beat.beat_track(y=y, sr=sr, hop_length=HOP_LENGTH)
            tempo = round(float(np.atleast_1d(bpm)[0]), 2)
            if len(beats):
                beat_times = librosa.frames_to_time(beats, sr=sr, hop_length=HOP_LENGTH)
                offset = round(float(beat_times[0]), 3)
        except Exception:
            pass

    n_frames = db.shape[1]
    return {
        "image": png_out.name,
        "width": int(n_frames),
        "height": int(N_BINS),
        "midi_low": MIDI_LOW,
        "midi_high": MIDI_HIGH,
        "hop_length": HOP_LENGTH,
        "sample_rate": int(sr),
        "duration": duration,
        "tempo": tempo,
        "offset": offset,
    }


def detect_notes(audio_path: Path) -> tuple[list[dict], str | None]:
    """Run Basic Pitch and return a list of note dicts (+ optional warning)."""
    try:
        import librosa
        from basic_pitch import FilenameSuffix, build_icassp_2022_model_path
        from basic_pitch.inference import predict
    except Exception as exc:  # pragma: no cover - import guard
        return [], f"Basic Pitch unavailable: {exc}"

    # Run the ONNX copy of the ICASSP-2022 model explicitly. basic-pitch ships
    # weights for several backends; pinning ONNX lets us run on onnxruntime
    # (~15 MB) instead of TensorFlow (~1 GB), which is otherwise dead weight
    # since the rest of the stack (demucs, RoFormer) is PyTorch.
    onnx_model = build_icassp_2022_model_path(FilenameSuffix.onnx)
    try:
        _model_out, _midi, note_events = predict(str(audio_path), onnx_model)
    except Exception as exc:
        return [], f"Basic Pitch failed: {exc}"

    notes: list[dict] = []
    for ev in note_events:
        start, end, pitch, amplitude = ev[0], ev[1], int(ev[2]), float(ev[3])
        if pitch < MIDI_LOW or pitch > MIDI_HIGH:
            continue
        notes.append({
            "start": float(start),
            "end": float(end),
            "pitch": pitch,
            "name": librosa.midi_to_note(pitch, unicode=False),
            "confidence": round(amplitude, 3),
        })
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    return notes, None


# MR-MT3 runs through mt3-infer. It's fast (~57x real-time) and tolerant of
# isolated separated stems, so it's the only mt3-infer model the editor keeps.
# The heavier official MT3 (kunato port) and YourMT3+ checkpoints were tried but
# dropped: each needed its own venv on a conflicting transformers pin, and both
# underperformed MR-MT3 on the isolated/separated stems this tool feeds them.
MT3_MODEL = "mr_mt3"

# mt3-infer resolves its checkpoint against `Path.cwd()` unless this variable is
# set, so where the 175 MB file lands — and whether the Models pane can find the
# one you already have — depended on which directory the app was launched from.
# Pinning it beside models/ makes the pane and the detector name the same file,
# and it is the path the existing download is already at.
# Read the variable before writing it: someone who set it meant it, and a
# setdefault would have left mt3-infer loading their file while the pane
# reported on ours. One value, both readers.
MT3_CHECKPOINT_DIR = Path(os.environ.get("MT3_CHECKPOINT_DIR")
                          or Path(__file__).resolve().parents[2] / ".mt3_checkpoints")
os.environ["MT3_CHECKPOINT_DIR"] = str(MT3_CHECKPOINT_DIR)


def mt3_checkpoint_path() -> Path:
    """The one file MR-MT3 needs. Absent means the detector is unavailable."""
    return MT3_CHECKPOINT_DIR / MT3_MODEL / "mt3.pth"


def detect_notes_mt3(audio_path: Path) -> tuple[list[dict], str | None]:
    """Run MR-MT3 (fast multi-instrument transcription) and return note dicts.

    Same note shape as detect_notes, so the result drops straight into the
    selected edit lane. It's a transformer, so heavier/slower than Basic Pitch.
    """
    try:
        import contextlib
        import io

        import librosa
        import pretty_midi
        from mt3_infer import transcribe
    except Exception as exc:  # pragma: no cover - import guard
        return [], f"MR-MT3 unavailable: {exc}"

    try:
        # mt3-infer models are trained at 16 kHz mono; resample to match.
        audio, _ = librosa.load(str(audio_path), sr=16000, mono=True)
        # mt3_infer prints a success marker after the (one-time) checkpoint
        # download; on a cp1252 Windows console that can raise UnicodeEncodeError
        # mid-download and abort it. Funnel its stdout/stderr into a unicode-safe
        # in-memory buffer so the download completes and the progress spam stays
        # out of the server log.
        sink = io.StringIO()
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            # auto_download=False: the Models pane is the only place a model
            # arrives. Detect is not a download button, and a 175 MB fetch
            # starting because someone picked an entry in a dropdown is exactly
            # the surprise that pane exists to remove. list_detectors() already
            # marks this model unavailable when the file is missing, so this is the
            # backstop for the file disappearing between the two calls.
            midi = transcribe(audio, model=MT3_MODEL, sr=16000, auto_download=False)
    except Exception as exc:
        return [], f"MR-MT3 failed: {exc}"

    # transcribe() returns a mido.MidiFile; route it through pretty_midi (already
    # a dep) for robust tick->seconds note timing.
    try:
        buf = io.BytesIO()
        midi.save(file=buf)
        buf.seek(0)
        pm = pretty_midi.PrettyMIDI(buf)
    except Exception as exc:
        return [], f"MR-MT3 MIDI parse failed: {exc}"

    notes: list[dict] = []
    for inst in pm.instruments:
        if inst.is_drum:  # multi-instrument model may emit drums; not notes/tab
            continue
        for n in inst.notes:
            pitch = int(n.pitch)
            if pitch < MIDI_LOW or pitch > MIDI_HIGH:
                continue
            notes.append({
                "start": float(n.start),
                "end": float(n.end),
                "pitch": pitch,
                "name": librosa.midi_to_note(pitch, unicode=False),
                # mt3-infer has no per-note confidence; use velocity as a stand-in
                # so the editor's confidence shading still has something to show.
                "confidence": round(n.velocity / 127.0, 3),
            })
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    return notes, None


def _contour_to_notes(
    pitch_hz,
    confidence,
    hop_seconds: float,
    min_dur: float = 0.06,
    min_conf: float = 0.0,
) -> list[dict]:
    """Segment a per-frame f0 contour into discrete note dicts.

    Shared by the monophonic pitch detectors (torchcrepe, PESTO): they each
    produce one f0 value per frame plus a 0..1 confidence; the note shape and the
    "hold the rounded semitone until it changes" segmentation are identical, so
    they live here.

    `pitch_hz` is Hz per frame with unvoiced frames as 0 / NaN; `confidence` is
    the matching periodicity/voicing weight. Frames are grouped while their
    nearest-semitone MIDI pitch stays constant; a run becomes a note when it is
    at least `min_dur` long, lands in [MIDI_LOW, MIDI_HIGH], and averages at least
    `min_conf`. Returns the usual {start,end,pitch,name,confidence} dicts.
    """
    import librosa
    import numpy as np

    notes: list[dict] = []
    cur_pitch: int | None = None
    start_i = 0
    confs: list[float] = []

    def flush(end_i: int) -> None:
        nonlocal cur_pitch, start_i, confs
        if cur_pitch is not None:
            dur = (end_i - start_i) * hop_seconds
            mean_conf = float(np.mean(confs)) if confs else 0.0
            if dur >= min_dur and MIDI_LOW <= cur_pitch <= MIDI_HIGH and mean_conf >= min_conf:
                notes.append({
                    "start": round(start_i * hop_seconds, 4),
                    "end": round(end_i * hop_seconds, 4),
                    "pitch": cur_pitch,
                    "name": librosa.midi_to_note(cur_pitch, unicode=False),
                    "confidence": round(mean_conf, 3),
                })
        cur_pitch = None
        confs = []

    for i, f in enumerate(pitch_hz):
        voiced = bool(np.isfinite(f)) and f > 0
        midi = int(round(float(librosa.hz_to_midi(f)))) if voiced else None
        if cur_pitch is not None and midi != cur_pitch:
            flush(i)
        if voiced and cur_pitch is None:
            cur_pitch = midi
            start_i = i
        if cur_pitch is not None:
            confs.append(float(confidence[i]))
    flush(len(pitch_hz))

    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    return notes


# torchcrepe is CREPE's native 10 ms frame rate at 16 kHz mono (the rate the
# model was trained on). Frames below this periodicity are treated as unvoiced so
# bass rests/decays don't smear into phantom notes; tune up if it over-detects.
TORCHCREPE_SR = 16000
TORCHCREPE_HOP = 160  # 16000 / 100 -> 10 ms frames
TORCHCREPE_MIN_PERIODICITY = 0.5


def detect_notes_torchcrepe(audio_path: Path) -> tuple[list[dict], str | None]:
    """Run torchcrepe (monophonic CREPE pitch tracking) and segment into notes.

    Built for single-line stems (bass, a lead melody): CREPE tracks one f0 at a
    time, so it's cleaner than the polyphonic detectors on those, but it will
    only ever return one note at a time. Pure PyTorch (weights ship in the
    package), so no TensorFlow and no download.
    """
    try:
        import librosa
        import torch
        import torchcrepe
    except Exception as exc:  # pragma: no cover - import guard
        return [], f"torchcrepe unavailable: {exc}"

    try:
        audio, _ = librosa.load(str(audio_path), sr=TORCHCREPE_SR, mono=True)
        if audio.size == 0:
            return [], None
        audio_t = torch.from_numpy(audio)[None]  # (1, samples)
        device = "cuda" if torch.cuda.is_available() else "cpu"
        # CREPE's model spans ~C1..C7; clamp the search to our display range so it
        # matches the spectrogram. fmax must stay strictly *below* torchcrepe's
        # MAX_FMAX (2006 Hz) — passing the ceiling exactly pins the decoder to the
        # top bin and returns zero periodicity (no notes). midi_to_hz(MIDI_HIGH)
        # is already above 2006, so the cap below is what actually applies.
        fmin = float(librosa.midi_to_hz(MIDI_LOW))
        fmax = min(float(librosa.midi_to_hz(MIDI_HIGH)), float(torchcrepe.MAX_FMAX) - 1.0)
        # Bound CNN activations independently of the Viterbi decoding window.
        # Keeping the old 2048-frame decoder window preserves its temporal context.
        batch_size = 256 if device == "cuda" else 64
        total_frames = 1 + audio.size // TORCHCREPE_HOP
        completed = 0
        pending = []
        pending_frames = 0
        results = []
        processing.report("Tracking pitch", 0, total_frames, device)
        with torch.inference_mode():
            for frames in torchcrepe.preprocess(
                audio_t, TORCHCREPE_SR, TORCHCREPE_HOP, batch_size, device, True
            ):
                probabilities = torchcrepe.infer(frames, "full", device, embed=False)
                probabilities = probabilities.reshape(1, -1, torchcrepe.PITCH_BINS).transpose(1, 2).cpu()
                pending.append(probabilities)
                pending_frames += probabilities.shape[-1]
                if pending_frames >= 2048:
                    processing.report("Decoding pitch", completed, total_frames, device)
                    results.append(torchcrepe.postprocess(
                        torch.cat(pending, dim=2), fmin, fmax,
                        torchcrepe.decode.viterbi, False, True
                    ))
                    pending = []
                    pending_frames = 0
                completed += probabilities.shape[-1]
                processing.report("Tracking pitch", completed, total_frames, device)
            if pending:
                processing.report("Decoding pitch", completed, total_frames, device)
                results.append(torchcrepe.postprocess(
                    torch.cat(pending, dim=2), fmin, fmax,
                    torchcrepe.decode.viterbi, False, True
                ))
        pitch = torch.cat([item[0] for item in results], dim=1)
        periodicity = torch.cat([item[1] for item in results], dim=1)
        processing.report("Smoothing detected notes", device=device)
        # Light smoothing, then null out low-confidence (unvoiced) frames so they
        # don't seed notes. threshold.At zeros sub-threshold pitches.
        periodicity = torchcrepe.filter.median(periodicity, 3)
        pitch = torchcrepe.filter.mean(pitch, 3)
        pitch = torchcrepe.threshold.At(TORCHCREPE_MIN_PERIODICITY)(pitch, periodicity)
    except Exception as exc:
        return [], f"torchcrepe failed: {exc}"

    pitch = pitch.squeeze(0).cpu().numpy()
    periodicity = periodicity.squeeze(0).cpu().numpy()
    notes = _contour_to_notes(pitch, periodicity, TORCHCREPE_HOP / TORCHCREPE_SR)
    return notes, None


# Kong/ByteDance high-resolution piano transcription. The package fetches its
# ~172 MB CRNN checkpoint itself on first use — by shelling out to `wget`
# (os.system), which a stock Windows desktop build does not have. The Models
# pane fetches the exact file to the exact path the package checks, so that
# branch is never reached: the detector cannot be selected until the file is there.
PIANO_CKPT_URL = (
    "https://zenodo.org/record/4034264/files/"
    "CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1"
)
PIANO_SR = 16000  # the model's training rate (piano_transcription_inference.sample_rate)


def piano_checkpoint_path() -> "Path":
    """The package's own default checkpoint location (models.py reports on it)."""
    return (
        Path.home()
        / "piano_transcription_inference_data"
        / "note_F1=0.9677_pedal_F1=0.9186.pth"
    )


def detect_notes_piano(audio_path: Path) -> tuple[list[dict], str | None]:
    """Run Kong/ByteDance piano transcription and return note dicts.

    Polyphonic onset/offset regression — the one ready-weights model in that
    family. Built for the piano stem, but the same checkpoint is the basis for
    the guitar zero-shot experiment, so it's worth selecting on a guitar stem to
    A/B against Basic Pitch / MR-MT3. Pure PyTorch, no TensorFlow; the ~172 MB
    checkpoint comes from Settings -> Models and never from here.
    """
    # Handing PianoTranscription a path that isn't there is what makes it shell
    # out to wget, so the check has to happen before the constructor, not inside
    # it. The size rule is the package's own: a truncated file is not a model.
    ckpt = piano_checkpoint_path()
    if not ckpt.exists() or ckpt.stat().st_size < 1.6e8:
        # No arrow: this string can reach a cp1252 Windows console, which is the
        # same encode error that used to abort the MT3 download mid-flight.
        return [], "Piano transcription weights aren't installed - get them in Settings > Models."

    try:
        import contextlib
        import io

        import librosa
        import torch
        from piano_transcription_inference import PianoTranscription
    except Exception as exc:  # pragma: no cover - import guard
        return [], f"piano transcription unavailable: {exc}"

    try:
        audio, _ = librosa.load(str(audio_path), sr=PIANO_SR, mono=True)
        if audio.size == 0:
            return [], None
        device = "cuda" if torch.cuda.is_available() else "cpu"
        # The package prints checkpoint path / device / per-segment progress;
        # funnel it into a buffer so it stays out of the server log (same as MT3).
        sink = io.StringIO()
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            transcriptor = PianoTranscription(
                device=torch.device(device), checkpoint_path=str(ckpt)
            )
            # midi_path=None skips the MIDI write; we read est_note_events directly.
            result = transcriptor.transcribe(audio, None)
    except Exception as exc:
        return [], f"piano transcription failed: {exc}"

    notes: list[dict] = []
    for ev in result.get("est_note_events", []):
        pitch = int(ev["midi_note"])
        if pitch < MIDI_LOW or pitch > MIDI_HIGH:
            continue
        notes.append({
            "start": float(ev["onset_time"]),
            "end": float(ev["offset_time"]),
            "pitch": pitch,
            "name": librosa.midi_to_note(pitch, unicode=False),
            # No per-note confidence; regressed velocity (0..128) stands in so the
            # editor's confidence shading has something to show, like MT3.
            "confidence": round(min(float(ev.get("velocity", 0)) / 128.0, 1.0), 3),
        })
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    return notes, None


# --- Detector registry -------------------------------------------------------
# On-demand note detectors, selectable per stem in the editor. Each takes an
# audio path and returns (notes, warning). All return the same note shape, so a
# result drops straight into the selected edit lane. Add more here (pYIN, CREPE, ...).
# `ready` prevents a selectable entry from triggering a surprise download. A
# detector with missing weights remains visible but disabled. Omit it when the
# model ships inside its own package, so there is nothing to be ready for.
DETECTORS: dict[str, dict] = {
    "basic_pitch": {"label": "Basic Pitch (polyphonic model)", "fn": detect_notes},
    "mt3": {"label": "MR-MT3 (multi-instrument model)", "fn": detect_notes_mt3,
            "ready": lambda: mt3_checkpoint_path().exists()},
    "torchcrepe": {"label": "torchcrepe (bass / melody model)", "fn": detect_notes_torchcrepe},
    "piano": {"label": "Piano Transcription (piano model)", "fn": detect_notes_piano,
              "ready": lambda: piano_checkpoint_path().exists()},
}


def list_detectors() -> list[dict]:
    """Every detector for the editor's per-stem model dropdown.

    Missing weights make a detector unavailable instead of hiding it, matching
    the separator picker. Detection never downloads weights implicitly; users
    install them explicitly from Settings > Models.
    """
    return [
        {
            "id": detector_id,
            "label": entry["label"],
            "available": bool(entry.get("ready", _always_ready)()),
        }
        for detector_id, entry in DETECTORS.items()
    ]


def _always_ready() -> bool:
    return True


def detect(
    audio_path: Path,
    model: str,
    start: float | None = None,
    end: float | None = None,
) -> tuple[list[dict], str | None]:
    """Run one registered detector by id on an audio file.

    With `start`/`end` (seconds) the detector runs on just that time slice and
    the returned note times are offset back to absolute song time — so the
    editor can detect within a selected frame instead of the whole stem.
    """
    entry = DETECTORS.get(model)
    if entry is None:
        return [], f"Unknown detector: {model}"
    if start is None and end is None:
        return entry["fn"](audio_path)

    # Region-scoped: extract the slice to a temp WAV, detect on it, then shift
    # every note back into absolute time. librosa.load reads only [offset, +dur)
    # and copes with whatever the stem audio is (wav/opus/mp3), unlike a raw
    # soundfile read.
    import os
    import tempfile

    import librosa
    import soundfile as sf

    start = max(0.0, float(start or 0.0))
    dur = None if end is None else max(0.0, float(end) - start)
    if dur is not None and dur <= 0:
        return [], None
    y, sr = librosa.load(str(audio_path), sr=None, mono=True, offset=start, duration=dur)
    if y.size == 0:
        return [], None
    fd, tmp_name = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        sf.write(str(tmp), y, int(sr))
        notes, warn = entry["fn"](tmp)
    finally:
        tmp.unlink(missing_ok=True)
    for n in notes:
        n["start"] = float(n["start"]) + start
        n["end"] = float(n["end"]) + start
    return notes, warn


def list_separators() -> list[dict]:
    """[{id, label, available, stems}] for the analyze-time separator dropdown.

    `stems` is the set of separable layers a backend can produce (excluding the
    always-present full mix), shaped as [{id, label}] for the new-project picker.
    """
    from . import roformer

    demucs_stems = [{"id": sid, "label": label} for sid, label in SEPARABLE_STEMS]
    rofo_stems = [
        {"id": sid, "label": STEM_LABELS.get(sid, sid.title())}
        for sid in roformer.instruments()
    ]
    return [
        {"id": "demucs", "label": "Demucs (6-stem model)", "available": True,
         "stems": demucs_stems},
        {"id": "roformer", "label": "BS-RoFormer (6-stem model)", "available": roformer.available(),
         "stems": rofo_stems},
    ]


def _run_separator(
    separator: str, input_path: Path, out_dir: Path, wanted: list[str]
) -> tuple[dict[str, Path], str | None]:
    if separator == "roformer":
        from . import roformer

        return roformer.separate(input_path, out_dir, wanted=tuple(wanted))
    return separate_stems(input_path, out_dir)


def _separated_wav(job_dir: Path, separator: str, input_path: Path, stem_id: str) -> Path | None:
    """Path to an already-separated stem wav left on disk by a prior run, or None."""
    if separator == "roformer":
        p = job_dir / "stems" / "roformer" / f"{stem_id}.wav"
    else:
        p = job_dir / "stems" / DEMUCS_MODEL / input_path.stem / f"{stem_id}.wav"
    return p if p.exists() else None


def add_stem(
    job_dir: Path, input_path: Path, separator: str, stem_id: str, out_id: str | None = None,
    work_dir: Path | None = None,
) -> tuple[StemView, str | None]:
    """Render one extra separable stem on demand (transcode + CQT → a StemView).

    Reuses the separated wav already on disk when present — Demucs' 6-source pass
    yields every stem in one go, so adding "drums" later costs only a transcode +
    spectrogram. Falls back to re-running the separator for just this stem.

    `stem_id` is the separable part to extract (e.g. "guitar"); `out_id` is the id
    it's stored/served under, defaulting to `stem_id`. They differ when a project
    mixes backends and needs two different "guitar" extractions to coexist (the
    New Project modal's per-stem backend picker) — each call mints its own out_id
    so the results don't collide.
    """
    job_dir = Path(job_dir)
    destination = Path(work_dir) if work_dir is not None else job_dir
    out_id = out_id or stem_id
    warn: str | None = None
    src = _separated_wav(job_dir, separator, input_path, stem_id)
    if src is None:
        produced, warn = _run_separator(separator, input_path, destination / "stems", [stem_id])
        src = produced.get(stem_id)
        if src is None:
            raise ValueError(warn or f"Could not produce stem '{stem_id}'.")
    processing.report("Encoding separated audio")
    playback = destination / f"playback_{out_id}.opus"
    audio_path = playback if _to_playback(src, playback) else src
    # Spectrogram is computed from the lossless separated wav, not the lossy
    # playback, so the CQT stays accurate even though playback is compressed.
    processing.report("Building spectrogram")
    spec = compute_spectrogram(src, destination / f"spectrogram_{out_id}.png")
    name = STEM_LABELS.get(stem_id, stem_id.title())
    return StemView(id=out_id, name=name, audio_path=audio_path, spectrogram=spec), warn


def ingest_stem(
    src_path: Path, job_dir: Path, stem_id: str, name: str, with_tempo: bool = False
) -> StemView:
    """Register an audio file as a stem view with no separation step — either the
    full song (with_tempo=True) or a stem the user already separated themselves
    and is uploading directly (the New Project modal's "Upload my own" path).
    """
    job_dir = Path(job_dir)
    playback = job_dir / f"playback_{stem_id}.opus"
    audio_path = playback if _to_playback(src_path, playback) else src_path
    spec = compute_spectrogram(src_path, job_dir / f"spectrogram_{stem_id}.png", with_tempo=with_tempo)
    return StemView(id=stem_id, name=name, audio_path=audio_path, spectrogram=spec)


def analyze(
    input_path: Path,
    job_dir: Path,
    separate: bool = True,
    separator: str = "demucs",
    stems: list[str] | None = None,
) -> AnalysisResult:
    """Separate into stems and render playback audio + spectrogram per stem.

    `separator` selects the backend ("demucs" or "roformer"). `stems` is the list
    of separable stem ids to surface (e.g. ["guitar", "bass", "vocals"]); the full
    mix is always surfaced. Note detection is NOT run here — it's an on-demand,
    per-stem action (see the detector registry / detect endpoint).
    """
    job_dir.mkdir(parents=True, exist_ok=True)
    warnings: list[str] = []

    # Which separable stems to surface, in the canonical SEPARABLE_STEMS order.
    requested = stems if stems is not None else list(DEFAULT_STEMS)
    wanted = [sid for sid, _ in SEPARABLE_STEMS if sid in requested]

    # Source audio per stem id (lossless), before transcoding to lossy playback.
    sources: dict[str, Path] = {MIX_STEM[0]: input_path}
    names: dict[str, str] = {MIX_STEM[0]: MIX_STEM[1]}
    separated = False
    if separate and wanted:
        produced, warn = _run_separator(separator, input_path, job_dir / "stems", wanted)
        if produced:
            separated = True
            for sid in wanted:
                if sid in produced:
                    sources[sid] = produced[sid]
                    names[sid] = STEM_LABELS.get(sid, sid.title())
            if warn:  # produced stems but with a note (e.g. RoFormer GPU->CPU fallback)
                warnings.append(warn)
        elif warn:
            warnings.append(warn + " Falling back to the full mix only.")

    views: list[StemView] = []
    tempo: float | None = None
    offset: float | None = None
    order = [MIX_STEM[0]] + wanted
    for sid in order:
        src = sources.get(sid)
        if src is None:
            continue
        # Render lossy Opus playback (small, seeks sample-accurately). The
        # spectrogram below is computed from the lossless `src`, so compression
        # never touches the CQT.
        playback = job_dir / f"playback_{sid}.opus"
        audio_path = src
        if _to_playback(src, playback):
            audio_path = playback
        elif sid == MIX_STEM[0]:
            warnings.append("Could not render playback audio (ffmpeg missing?); seeking may be imprecise.")

        want_tempo = sid == MIX_STEM[0]  # beat-track once, on the full song
        spec = compute_spectrogram(src, job_dir / f"spectrogram_{sid}.png", with_tempo=want_tempo)
        if want_tempo:
            tempo = spec.get("tempo")
            offset = spec.get("offset")
        views.append(StemView(id=sid, name=names[sid], audio_path=audio_path, spectrogram=spec))

    return AnalysisResult(
        duration=views[0].spectrogram["duration"],
        sample_rate=views[0].spectrogram["sample_rate"],
        tempo=tempo,
        offset=offset,
        stems=views,
        separated=separated,
        warnings=warnings,
        separator=separator if separated else None,
    )
