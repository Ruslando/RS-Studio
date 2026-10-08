"""The walkthrough's demo bass line, synthesised rather than shipped.

The bass is written as both the full song and a prepared stem. The part is
known here, so the tutorial's separation is immediate — running Demucs on a
file we generated would be a slow way to rediscover what we just wrote.

Everything the walkthrough needs from the audio is a deliberate property of it:

- One phrase repeated four times, so there is a real repeat to find and to group
  into a reference.
- A lead-in of silence and a tempo that is not a round number of frames, so the
  detected BPM/offset is close but wrong, and the tempo-marker lesson has
  something to fix that the ear can hear against the metronome.

The tutorial generates WAV audio at runtime so its notes and timing are
reproducible without storing a recording in the source repository.
"""
from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

SR = 44100
BPM = 120.0
LEAD_IN = 0.35          # s of silence before the first beat — the offset lesson
BEAT = 60.0 / BPM

# One two-bar phrase, a quarter note a beat: up the scale and back down.
PHRASE = [40, 43, 45, 47, 50, 47, 45, 43]   # E2 G2 A2 B2 D3 B2 A2 G2
REPEATS = 4                                  # 4 x 2 bars = 8 bars = 16 s


def cached_bass_detection(start: float | None = None, end: float | None = None) -> list[dict]:
    """Prepared detector result for the generated bass in the walkthrough.

    Its pitches and onsets are fixed by PHRASE and LEAD_IN. Returning this
    result keeps the tutorial independent of local torchcrepe weights and CPU
    speed; normal projects still run the chosen model.
    """
    names = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
    notes = []
    for i, pitch in enumerate(PHRASE * REPEATS):
        onset = LEAD_IN + i * BEAT
        off = onset + BEAT * 0.9
        if start is not None and off <= start:
            continue
        if end is not None and onset >= end:
            continue
        notes.append({
            "start": round(max(onset, start) if start is not None else onset, 4),
            "end": round(min(off, end) if end is not None else off, 4),
            "pitch": pitch,
            "name": f"{names[pitch % 12]}{pitch // 12 - 1}",
            "confidence": 0.95,
        })
    return notes


def _pluck(midi: int, seconds: float, brightness: int, decay: float) -> np.ndarray:
    """A plucked note: a few harmonics under an exponential decay.

    `brightness` is how many harmonics survive. A few give the demo bass its
    rounded tone.
    """
    t = np.arange(int(SR * seconds)) / SR
    f = 440.0 * 2 ** ((midi - 69) / 12)
    tone = np.zeros_like(t)
    for k in range(1, brightness + 1):
        if f * k > SR / 2:
            break
        tone += np.sin(2 * np.pi * f * k * t) / k**1.4
    return tone * np.exp(-t * decay)


def _part(offsets_midi, brightness: int, decay: float, hold: float) -> np.ndarray:
    """Lay one part's notes onto a silent buffer at their beat positions."""
    total = LEAD_IN + BEAT * len(PHRASE) * REPEATS + 2 * BEAT
    out = np.zeros(int(SR * total))
    for beat_index, midi in offsets_midi:
        start = int(SR * (LEAD_IN + beat_index * BEAT))
        note = _pluck(midi, BEAT * hold, brightness, decay)
        end = min(len(out), start + len(note))
        out[start:end] += note[: end - start]
    return out


def _normalize(part: np.ndarray, peak: float) -> np.ndarray:
    top = np.abs(part).max()
    return part * (peak / top) if top else part


def _write_wav(path: Path, part: np.ndarray) -> None:
    pcm = (np.clip(part, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def write_audio(job_dir: Path) -> dict[str, Path]:
    """Write the bass as both the full song and its prepared stem.

    Returns {part: path}; "mix" and "bass" contain the same audio.
    """
    job_dir = Path(job_dir)
    job_dir.mkdir(parents=True, exist_ok=True)

    beats = [(i, midi) for i, midi in enumerate(PHRASE * REPEATS)]
    bass = _normalize(_part(beats, brightness=4, decay=3.2, hold=1.6), 0.85)

    paths = {
        "bass": job_dir / "tutorial_bass.wav",
        "mix": job_dir / "tutorial_mix.wav",
    }
    _write_wav(paths["bass"], bass)
    _write_wav(paths["mix"], bass)
    return paths
