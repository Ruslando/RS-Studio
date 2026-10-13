"""A capo through both backend exports: frets arrive counted from the capo."""
import io
import unittest

import guitarpro as gp

from rs_studio.rocksmith import chart
from rs_studio.tab import build_gp5

STANDARD = [64, 59, 55, 50, 45, 40]                     # hi -> lo, as the editor sends it
GRID = {"bpm": 120, "offset": 0.0, "tsNum": 4, "tsDen": 4}


def _note(t, string, fret, pitch):
    return {"start": t, "end": t + 0.5, "pitch": pitch, "string": string, "fret": fret}


def _track(capo):
    # GP string 5 = A, 4 = D. Frets count from the capo: A "0" sounds at the capo.
    return {
        "name": "Guitar", "tuning": STANDARD, "capo": capo, "notes": [
            _note(1.0, 5, 0, 45 + capo),
            _note(2.0, 5, 3, 45 + capo + 3),
            _note(3.0, 5, 0, 45 + capo), _note(3.0, 4, 2, 50 + capo + 2),
        ],
    }


class CapoExportTests(unittest.TestCase):
    def test_rocksmith_counts_frets_from_the_nut_with_open_at_the_capo(self):
        sng = chart.compile_track(_track(2), GRID, 8.0).sng
        self.assertEqual(sng.metadata.capo_fret_id, 2)
        hardest = sng.levels[-1]
        self.assertEqual(sorted({n.fret for n in hardest.notes if n.chord_id < 0}), [0, 5])
        chord = next(c for c in sng.chords if sum(f >= 0 for f in c.frets) == 2)
        rs_a, rs_d = 1, 2                               # Rocksmith strings count from the lowest
        self.assertEqual((chord.frets[rs_a], chord.frets[rs_d]), (0, 4))
        self.assertEqual((chord.notes[rs_a], chord.notes[rs_d]), (47, 54), "an open string sounds at the capo")
        self.assertGreaterEqual(min(a.fret for a in hardest.anchors), 3, "no hand position behind the capo")

    def test_rocksmith_without_capo_is_unchanged(self):
        self.assertEqual(chart.compile_track(_track(0), GRID, 8.0).sng.metadata.capo_fret_id, -1)

    def test_gp5_writes_the_capo_and_keeps_frets_from_it(self):
        data, _ = build_gp5({"name": "t", "grid": GRID, "resolution": 4, "tracks": [_track(2)]})
        track = gp.parse(io.BytesIO(data)).tracks[0]
        self.assertEqual(track.offset, 2)
        frets = sorted(n.value for m in track.measures for v in m.voices for b in v.beats for n in b.notes)
        self.assertEqual(frets, [0, 0, 2, 3], "positions are kept, not refingered from the nut")

    def test_gp5_warns_when_the_tempo_is_rounded(self):
        _, warnings = build_gp5({"name": "t", "grid": GRID, "resolution": 4, "tracks": [_track(0)]})
        self.assertFalse(any("whole-number" in w for w in warnings))
        _, warnings = build_gp5({"name": "t", "grid": {**GRID, "bpm": 160.15}, "resolution": 4, "tracks": [_track(0)]})
        self.assertTrue(any("160.15 → 160" in w for w in warnings), warnings)


if __name__ == "__main__":
    unittest.main()
