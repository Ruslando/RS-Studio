import unittest

from rs_studio.rocksmith import sng as S
from rs_studio.rocksmith.chart import compile_track


def _compile(**fields):
    note = {"string": 5, "fret": 7, "start": 1.0, "end": 2.0, "pitch": 52, **fields}
    track = {"name": "Lead", "tuning": [64, 59, 55, 50, 45, 40], "notes": [note]}
    compiled = compile_track(track, {"bpm": 120, "offset": 0, "tsNum": 4}, 10.0)
    return compiled.sng.levels[-1].notes, [code for code, _ in compiled.fixes]


class WhammyAsSlidesTest(unittest.TestCase):
    def test_dip_slides_down_and_back_up(self):
        (down, up), _ = _compile(whammy="dip")
        self.assertEqual((down.fret, down.slide_to), (7, 5))
        self.assertTrue(down.mask & S.PARENT)
        self.assertTrue(up.mask & S.CHILD, "the way back is not picked again")
        self.assertEqual((up.fret, up.slide_unpitch_to), (5, 7))

    def test_held_part_after_the_slide_is_linked(self):
        (down, held), _ = _compile(whammy="custom", whammyPoints=[[0, 0], [0.25, -1], [1, -1]])
        self.assertEqual((down.slide_to, held.fret), (6, 6))
        self.assertTrue(held.mask & S.CHILD)

    def test_curve_ending_early_holds_to_the_note_end(self):
        notes, _ = _compile(whammy="dip", whammyPoints=[[0, 0], [0.4, -2], [0.6, 0]])
        self.assertEqual([n.fret for n in notes], [7, 5, 7])
        self.assertAlmostEqual(notes[-1].time, 1.6)
        self.assertTrue(notes[-1].mask & S.CHILD, "the held end is not picked again")

    def test_open_string_cannot_go_lower(self):
        notes, fixes = _compile(fret=0, pitch=45, whammy="dip")
        self.assertEqual(len(notes), 1)
        self.assertIn("whammy", fixes)


class TrillAsHammersTest(unittest.TestCase):
    def test_sixteenths_hammered_and_pulled(self):
        notes, _ = _compile(end=1.6, trill="whole")   # 120 bpm: a sixteenth is 0.125 s
        self.assertEqual([n.fret for n in notes], [7, 9, 7, 9, 7])
        self.assertEqual([round(n.time, 3) for n in notes], [1.0, 1.125, 1.25, 1.375, 1.5])
        self.assertFalse(notes[0].mask & (S.HAMMERON | S.PULLOFF))
        self.assertTrue(all(n.mask & S.HAMMERON for n in notes[1::2]))
        self.assertTrue(all(n.mask & S.PULLOFF for n in notes[2::2]))

    def test_too_short_is_reported(self):
        notes, fixes = _compile(end=1.2, trill="half")
        self.assertEqual(len(notes), 1)
        self.assertIn("trill", fixes)



class AdditionalTechniquesTest(unittest.TestCase):
    def test_pick_slides_are_tapped_muted_unpitched_slides(self):
        for kind, fret, target in (("pickDown", 22, 17), ("pickUp", 17, 22)):
            with self.subTest(kind=kind):
                notes, fixes = _compile(slide=kind)
                self.assertEqual(len(notes), 1)
                self.assertEqual((notes[0].fret, notes[0].slide_unpitch_to), (fret, target))
                self.assertTrue(notes[0].mask & S.TAP)
                self.assertTrue(notes[0].mask & S.MUTE)
                self.assertNotIn("slide", fixes)

    def test_ghost_note_is_visible_but_ignored(self):
        notes, _ = _compile(fx={"ghost": True})
        self.assertEqual(len(notes), 1)
        self.assertTrue(notes[0].mask & S.IGNORE)

    def test_ghost_note_stays_ignored_across_late_effect_pieces(self):
        notes, _ = _compile(fx={"ghost": True}, slide="outDown", slideStart=0.75)
        self.assertGreater(len(notes), 1)
        self.assertTrue(all(n.mask & S.IGNORE for n in notes))

    def test_pick_slide_stays_muted_across_late_effect_pieces(self):
        notes, _ = _compile(slide="pickDown", slideStart=0.75)
        self.assertGreater(len(notes), 1)
        self.assertTrue(all(n.mask & S.MUTE for n in notes))

    def test_artificial_harmonic_uses_pinch_flag(self):
        notes, _ = _compile(harmonic="artificial")
        self.assertTrue(notes[0].mask & S.PINCHHARMONIC)
        self.assertFalse(notes[0].mask & S.HARMONIC)

    def test_dead_slap_keeps_both_flags(self):
        notes, _ = _compile(slap="slap", fx={"dead": True})
        self.assertTrue(notes[0].mask & S.SLAP)
        self.assertTrue(notes[0].mask & S.MUTE)

    def test_all_ornament_figures(self):
        for kind, expected in {"upperMordent": [7, 9, 7], "lowerMordent": [7, 6, 7],
                               "turn": [9, 7, 6, 7], "invertedTurn": [6, 7, 9, 7]}.items():
            with self.subTest(kind=kind):
                notes, fixes = _compile(ornament=kind)
                self.assertEqual([n.fret for n in notes], expected)
                self.assertTrue(all(n.mask & (S.HAMMERON | S.PULLOFF) for n in notes[1:]))
                self.assertNotIn("ornament", fixes)

    def test_ornament_that_cannot_fit_has_a_warning(self):
        from rs_studio.rocksmith.checker import fixed
        for fields in ({"end": 1.05}, {"fret": 0}):
            notes, fixes = _compile(ornament="turn", **fields)
            self.assertEqual(len(notes), 1)
            self.assertIn("ornament", fixes)
        self.assertEqual(fixed("ornament", 1).tone, "warning")

    def test_checker_separates_notes_loss_and_broken_gameplay(self):
        from rs_studio.rocksmith.checker import _issue, fixed
        self.assertEqual(fixed("hand", 1).tone, "note")
        self.assertEqual(fixed("unvoiced", 1).tone, "warning")
        self.assertEqual(_issue("I04", 1000).tone, "warning")
        for code in ("I18", "I21", "I25", "I30", "I36"):
            self.assertEqual(_issue(code, 1000).tone, "error")


if __name__ == "__main__":
    unittest.main()
