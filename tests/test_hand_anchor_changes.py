"""Saved editor hand changes remain authoritative in Rocksmith and every DD level."""
import unittest

from rs_studio.rocksmith.chart import compile_track


TUNING = [64, 59, 55, 50, 45, 40]
GRID = {"bpm": 120, "offset": 0, "tsNum": 4, "tsDen": 4}


def note(time, fret, hand):
    return {"start": time, "end": time + .3, "pitch": 64 + fret,
            "string": 1, "fret": fret, "hand": hand}


def active(anchors, time):
    return next(a for a in reversed(anchors) if a.start_time <= time + 1e-6)


class HandAnchorChangesTests(unittest.TestCase):
    def test_every_note_inherits_the_saved_range(self):
        notes = [note(1.13, 5, 4), note(2.77, 5, 4), note(4.49, 7, 5)]
        compiled = compile_track({"name": "Lead", "tuning": TUNING, "notes": notes, "handAnchorVersion": 1}, GRID, 8)
        anchors = compiled.sng.levels[0].anchors
        self.assertEqual([active(anchors, n["start"]).fret for n in notes], [4, 4, 5])
        self.assertFalse(any(abs(a.start_time - 2.77) < 1e-6 for a in anchors), "an inherited value needs no extra anchor")

    def test_a_saved_change_on_open_strings_is_not_lost(self):
        notes = [note(1, 0, 4), note(2, 0, 6), note(3, 7, 6)]
        compiled = compile_track({"name": "Lead", "tuning": TUNING, "notes": notes, "handAnchorVersion": 1}, GRID, 8)
        self.assertEqual([active(compiled.sng.levels[0].anchors, n["start"]).fret for n in notes], [4, 6, 6])

    def test_all_difficulties_keep_the_same_hand_timeline(self):
        notes = [note(1 + i * .25, 7 if i < 32 else 9, 4 if i < 32 else 6) for i in range(64)]
        compiled = compile_track({"name": "Lead", "tuning": TUNING, "notes": notes, "handAnchorVersion": 1},
                                 GRID, 20, dynamic_difficulty=True)
        self.assertGreater(len(compiled.dd_sng.levels), 1)
        full = compiled.sng.levels[0].anchors
        for level in compiled.dd_sng.levels:
            for anchor in level.anchors:
                expected = active(full, anchor.start_time)
                self.assertEqual((anchor.fret, anchor.width), (expected.fret, expected.width))
            for emitted in level.notes:
                self.assertEqual(emitted.anchor_fret, active(full, emitted.time).fret)


if __name__ == "__main__":
    unittest.main()
