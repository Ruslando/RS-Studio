"""Concert pitch: songs that are not at A440 (estimate, grid, detection, export)."""
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf

from rs_studio import pipeline
from rs_studio.rocksmith import builder
from rs_studio.rocksmith.psarc import read_psarc

SR = 22050
A432 = 1200 * np.log2(432 / 440)   # -31.8 ct


def _tone(path, hz, seconds=3.0):
    t = np.arange(int(seconds * SR)) / SR
    sf.write(path, sum(np.sin(2 * np.pi * hz * k * t) / k for k in (1, 2, 3)) * 0.3, SR)


class ConcertPitchTests(unittest.TestCase):
    def test_estimate_finds_a432_and_the_dead_band_keeps_a440(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "a432.wav"
            _tone(path, 432.0)
            self.assertAlmostEqual(pipeline.estimate_tuning(path), A432, delta=3)
        self.assertEqual(pipeline.suggested_reference(-2.0), 0.0)
        self.assertEqual(pipeline.suggested_reference(None), 0.0)
        self.assertEqual(pipeline.suggested_reference(-31.0), -31.0)

    def test_spectrogram_rows_follow_the_reference(self):
        """A 432 Hz A4 lights the A4 row's middle line only once the grid moves with it."""
        from PIL import Image
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "a432.wav"
            _tone(path, 432.0)

            def peak_row(cents):
                png = Path(folder) / f"{cents}.png"
                pipeline.compute_spectrogram(path, png, view="fine", cents=cents)
                rows = np.asarray(Image.open(png).convert("L"), dtype=float).sum(axis=1)[::-1]  # bottom = C1
                return int(np.argmax(rows[:(pipeline.N_BINS - 12) * 3]))  # below the 2nd harmonic

            a4_centre = (69 - pipeline.MIDI_LOW) * 3 + 1
            self.assertEqual(peak_row(0.0), a4_centre - 1)   # a third of a semitone low
            self.assertEqual(peak_row(A432), a4_centre)

    def test_detection_hears_the_audio_at_a440_and_keeps_song_time(self):
        heard = {}

        def fake(path):
            info = sf.info(str(path))
            heard["rate"] = info.samplerate
            return [{"start": 1.0, "end": 2.0, "pitch": 69}], None

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "a432.wav"
            _tone(path, 432.0)
            with patch.dict(pipeline.DETECTORS, {"fake": {"fn": fake}}):
                notes, _ = pipeline.detect(path, "fake", cents=A432)
        speed = heard["rate"] / SR
        self.assertAlmostEqual(speed, 440 / 432, places=3)   # played faster: up to A440
        self.assertAlmostEqual(notes[0]["start"], speed)
        self.assertAlmostEqual(notes[0]["end"], 2 * speed)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required")
    def test_shifted_audio_keeps_its_length_and_moves_its_pitch(self):
        from rs_studio.audio_channels import pitch_shift
        with tempfile.TemporaryDirectory() as folder:
            source, out = Path(folder) / "a432.wav", Path(folder) / "a440.wav"
            _tone(source, 432.0)
            pitch_shift(source, out, -A432, ["-c:a", "pcm_s16le"])
            self.assertAlmostEqual(sf.info(str(out)).duration, 3.0, delta=0.05)
            self.assertAlmostEqual(pipeline.estimate_tuning(out), 0.0, delta=3)

    def test_rocksmith_is_told_reference_plus_shift(self):
        guitar = [64, 59, 55, 50, 45, 40]
        spec = {"metadata": {"title": "Song", "artist": "Band"},
                "grid": {"bpm": 120, "offset": 0.0, "tsNum": 4, "tsDen": 4}, "duration": 20.0,
                "tracks": [{"name": "Gtr", "tuning": guitar,
                            "notes": [{"start": 2.0, "end": 2.5, "pitch": 40, "string": 6, "fret": 0}]}],
                "rocksmith": {"arrangements": [{"track": 0, "kind": "lead"}]},
                "tuning": {"reference": -31.8, "shift": 12, "estimate": -31.8}}
        files, _, _ = builder.build_cdlc(spec, None, _wems=(b"a", b"b"), _song_length=20.0)
        [attrs] = [next(iter(json.loads(blob)["Entries"].values()))["Attributes"]
                   for path, blob in read_psarc(files).items() if path.endswith(".json")]
        self.assertAlmostEqual(attrs["CentOffset"], -19.8)
        self.assertEqual(builder._concert_pitch({"tuning": {"reference": "x", "shift": 900}}), (0.0, 50.0))


class TuningRouteTests(unittest.TestCase):
    def test_route_validates_saves_and_versions_urls(self):
        from fastapi import HTTPException
        from rs_studio import server
        manifest = {"job": "pitchtest", "stems": [{"id": "mix", "name": "Mix", "spectrogram": {}}],
                    "tuning": {"estimate": -31.8, "reference": -31.8, "shift": 0}}
        with patch.object(server, "_read_manifest", return_value=manifest), \
             patch.object(server, "_write_manifest"):
            with self.assertRaises(HTTPException):
                server.api_project_tuning("pitchtest", {"shift": 51})
            body = json.loads(server.api_project_tuning("pitchtest", {"reference": -20}).body)
        self.assertEqual(body["tuning"], {"estimate": -31.8, "reference": -20.0, "shift": 0.0})
        self.assertTrue(body["stems"][0]["spectrogram"]["url"].endswith("?cents=-20.0"))
        self.assertFalse(body["stems"][0]["audio_url"].endswith("shift=0.0"))
        # Imported manifests are untrusted; old ones have no tuning at all.
        self.assertEqual(server._tuning({"tuning": {"reference": 900, "shift": "x"}}),
                         {"estimate": None, "reference": 50.0, "shift": 0.0})
        self.assertEqual(server._tuning({}), {"estimate": None, "reference": 0.0, "shift": 0.0})


if __name__ == "__main__":
    unittest.main()
