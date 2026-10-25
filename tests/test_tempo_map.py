"""Beats + downbeats -> grid (rs_studio/tempo_map.py), on hand-made beat lists."""
import json
import unittest
from unittest.mock import patch

import numpy as np

from rs_studio.tempo_map import tempo_map


def track(*sections, start=1.0, jitter=0.0, seed=0):
    """sections: (bars, meter, bpm). Returns (beats, downbeats) with optional jitter."""
    rng = np.random.default_rng(seed)
    beats, downs, t = [], [], start
    for bars, meter, bpm in sections:
        for k in range(bars * meter):
            if k % meter == 0:
                downs.append(t)
            beats.append(t)
            t += 60 / bpm
    beats = np.array(beats) + rng.uniform(-jitter, jitter, len(beats))
    return beats, np.array([beats[np.argmin(np.abs(beats - d))] for d in downs])


def meters(grid):
    return [grid["tsNum"]] + [m["tsNum"] for m in grid["tempoMap"]]


class TempoMapTests(unittest.TestCase):
    def test_steady_song_is_one_tempo_and_no_markers(self):
        grid = tempo_map(*track((32, 4, 128), jitter=0.01))
        self.assertAlmostEqual(grid["bpm"], 128, delta=0.1)
        self.assertAlmostEqual(grid["offset"], 1.0, delta=0.01)
        self.assertEqual((grid["tsNum"], grid["tsDen"], grid["tempoMap"]), (4, 4, []))

    def test_tempo_and_meter_changes_get_markers_on_their_downbeats(self):
        beats, downs = track((8, 4, 120), (8, 3, 120), (8, 4, 140))
        grid = tempo_map(beats, downs)
        self.assertEqual(meters(grid), [4, 3, 4])
        self.assertAlmostEqual(grid["tempoMap"][0]["t"], downs[8], delta=0.001)
        self.assertAlmostEqual(grid["tempoMap"][1]["t"], downs[16], delta=0.001)
        self.assertAlmostEqual(grid["tempoMap"][1]["bpm"], 140, delta=0.1)

    def test_a_drifting_tempo_gets_markers_only_where_the_grid_would_miss(self):
        beats, downs = track(*[(2, 4, bpm) for bpm in np.linspace(100, 130, 16)])
        grid = tempo_map(beats, downs)
        self.assertTrue(0 < len(grid["tempoMap"]) < 15)
        segments = [{"t": grid["offset"], "bpm": grid["bpm"]}] + grid["tempoMap"]
        for beat in beats:   # every beat stays within tolerance of the grid
            seg = ([s for s in segments if s["t"] <= beat + 0.05] or segments)[-1]
            step = 60 / seg["bpm"]
            phase = (beat - seg["t"]) / step
            self.assertLess(abs(phase - round(phase)) * step, 0.05)

    def test_beats_that_waver_do_not_get_markers_but_a_jump_does(self):
        """GO GHOST: +-30 ms of detector noise is one tempo; a lasting 60 ms jump is a marker."""
        beats, downs = track((40, 4, 150), jitter=0.03, seed=3)
        self.assertEqual(tempo_map(beats, downs)["tempoMap"], [])
        jump = beats.copy()
        jump[80:] += 0.06
        grid = tempo_map(jump, np.where(np.isin(downs, beats[80:]), downs + 0.06, downs))
        self.assertEqual(len(grid["tempoMap"]), 1)
        self.assertAlmostEqual(grid["tempoMap"][0]["t"], jump[80], delta=0.03)
        self.assertEqual(grid["tempoMap"][0]["bpm"], grid["bpm"])   # only the phase moved

    def test_a_misplaced_downbeat_is_not_a_meter_change(self):
        beats, downs = track((16, 4, 120))
        downs = np.delete(downs, 6)
        downs = np.sort(np.append(downs, beats[6 * 4 + 1]))   # bars 4,4,4,4,4,4,1,3... -> 4,5,3
        self.assertEqual(meters(tempo_map(beats, downs)), [4])

    def test_a_pickup_is_left_before_the_first_bar(self):
        beats, downs = track((1, 2, 100), (12, 4, 100))
        downs = downs[1:]   # the pickup's own downbeat is not one
        grid = tempo_map(beats, downs)
        self.assertAlmostEqual(grid["offset"], beats[2], delta=0.001)
        self.assertEqual(meters(grid), [4])

    def test_a_messy_ending_keeps_the_meter(self):
        beats, downs = track((12, 4, 110))
        downs = np.concatenate([downs[:-3], beats[[-11, -6, -3, -2]]])
        self.assertEqual(set(meters(tempo_map(beats, downs))), {4})

    def test_a_beat_left_over_at_the_end_is_a_short_last_bar(self):
        beats, downs = track((12, 4, 110), (1, 1, 110))   # the final hit counted as a bar
        self.assertEqual(meters(tempo_map(beats, downs)), [4])

    def test_without_usable_downbeats_it_is_four_four_from_the_first_beat(self):
        beats, _ = track((8, 3, 90))
        for downs in (None, beats):   # none, or every beat claimed as a downbeat
            grid = tempo_map(beats, downs)
            self.assertEqual(meters(grid), [4])
            self.assertAlmostEqual(grid["bpm"], 90, delta=0.1)


class TempoRouteTests(unittest.TestCase):
    def test_route_returns_the_detected_grid_unsaved(self):
        from pathlib import Path

        from rs_studio import server
        grid = {"bpm": 100.0, "offset": 0.5, "tsNum": 3, "tsDen": 4, "tempoMap": []}
        manifest = {"job": "tempotest", "stems": [{"id": "mix", "audio_rel": "mix.opus"}]}
        with patch.object(server, "_read_manifest", return_value=manifest), \
             patch.object(server, "_project_input", return_value=Path("input.wav")), \
             patch.object(server, "_write_manifest") as write, \
             patch.object(server.processing, "run", return_value=grid) as run:
            body = json.loads(server.api_project_tempo_map("tempotest", {}).body)
        self.assertEqual(body, grid)
        self.assertEqual(run.call_args.args[2], Path("input.wav"))
        write.assert_not_called()


if __name__ == "__main__":
    unittest.main()


class BundledWeightsTests(unittest.TestCase):
    def test_a_source_checkout_fetches_the_weights_once_and_checks_them(self):
        import hashlib
        import io
        import tempfile
        from pathlib import Path

        from rs_studio import pipeline
        payload = b"weights"
        with tempfile.TemporaryDirectory() as folder, \
             patch.object(pipeline, "resource_root", return_value=Path(folder)), \
             patch("urllib.request.urlopen", side_effect=lambda *a, **k: io.BytesIO(payload)) as fetch:
            with patch.object(pipeline, "BEAT_THIS_SHA256", "0" * 64):
                with self.assertRaises(ValueError):
                    pipeline.beat_this_checkpoint()
                self.assertEqual(list(Path(folder, "models").iterdir()), [], "nothing half-written stays")
            with patch.object(pipeline, "BEAT_THIS_SHA256", hashlib.sha256(payload).hexdigest()):
                path = pipeline.beat_this_checkpoint()
                self.assertEqual(path.read_bytes(), payload)
                pipeline.beat_this_checkpoint()
            self.assertEqual(fetch.call_count, 2, "fetched once more after the bad one, then reused")
