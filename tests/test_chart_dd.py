"""Dynamic difficulty (dd.py): easier levels of each phrase, as DLC Builder makes them."""
import collections
import unittest

from rs_studio.rocksmith import chart, checker, dd, sng as S

GUITAR = [64, 59, 55, 50, 45, 40]
GRID = {"bpm": 120, "offset": 1.0, "tsNum": 4, "tsDen": 4}


def _n(start, string, fret, dur=0.2, **kw):
    return {"start": start, "end": start + dur, "string": string, "fret": fret, "hand": max(1, fret - 1), **kw}


def _riffs(bars=16, **extra):
    """Linked notes, a legato slide, a grip shape and a chord in every bar."""
    notes = []
    for bar in range(bars):
        b = 1.0 + bar * 2.0
        notes += [_n(b, 3, 5, 0.5, linkNext=True), _n(b + 0.5, 3, 5, 0.25, fx={"vibrato": True})]
        notes += [_n(b + 0.75, 2, 5, 0.25, slide="legato"), _n(b + 1.0, 2, 7, 0.25)]
        kind = "arpeggio" if bar % 2 else "handshape"
        for k, (s, f) in enumerate(((5, 3), (4, 5), (3, 5), (2, 4))):
            notes.append(_n(b + 1.25 + k * 0.125, s, f, 0.125, shapeId=f"s{bar}", shapeKind=kind, shapeName="C"))
        for s, f in ((6, 3), (5, 5), (4, 5), (3, 4)):
            notes.append(_n(b + 1.75, s, f, 0.25, chordName="G", fx={"hammer": "hammer"} if s == 3 else {}))
    return {"name": "g", "tuning": GUITAR, "notes": notes, **extra}


def _compiled(track=None, **kw):
    return chart.compile_track(track or _riffs(), GRID, 40.0, dynamic_difficulty=True, **kw)


def _key(note):
    return (round(note.time, 4), note.string, note.fret, note.mask, note.chord_id,
            round(note.sustain, 4), note.chord_notes_id, note.slide_to)


def _entity(time, *notes, chord_id=-1, sustain=0.0):
    return chart._Entity(time=time, sustain=sustain, notes=list(notes), chord_id=chord_id)


class LevelTests(unittest.TestCase):
    def test_off_unless_asked(self):
        self.assertIsNone(chart.compile_track(_riffs(), GRID, 40.0).dd_sng)

    def test_the_hardest_level_of_each_phrase_is_the_chart(self):
        c = _compiled()
        self.assertGreater(len(c.dd_sng.levels), 2)
        for k, pi in enumerate(c.dd_sng.phrase_iterations):
            top = c.dd_sng.phrases[pi.phrase_id].max_difficulty
            self.assertEqual([_key(n) for n in c.dd_sng.levels[top].notes if n.phrase_iteration_id == k],
                             [_key(n) for n in c.sng.levels[0].notes if n.phrase_iteration_id == k], k)

    def test_a_level_holds_only_phrases_that_reach_it(self):
        song = _compiled().dd_sng
        for level in song.levels:
            for note in level.notes:
                phrase = song.phrases[song.phrase_iterations[note.phrase_iteration_id].phrase_id]
                self.assertLessEqual(level.difficulty, phrase.max_difficulty)
        self.assertEqual(song.metadata.max_difficulty, len(song.levels) - 1)

    def test_every_level_passes_the_check(self):
        c = _compiled()
        found = collections.Counter(i.code for i in checker.check(c.dd_sng, is_bass=False))
        self.assertEqual(found, collections.Counter(i.code for i in checker.check(c.sng, is_bass=False)))

    def test_the_easiest_level_is_single_notes_without_links_or_slides(self):
        level = _compiled().dd_sng.levels[0]
        self.assertTrue(level.notes)
        self.assertFalse([n for n in level.notes if n.chord_id != -1])
        self.assertFalse([n for n in level.notes if n.mask & (S.PARENT | S.CHILD | S.SLIDE | S.VIBRATO)])

    def test_iterations_of_one_phrase_get_the_same_levels(self):
        sections = [{"t": 1.0 + k * 8.0, "name": "riff", "phraseName": "A"} for k in range(4)]
        track = _riffs(sections=sections)
        boundaries = [{"t": 1.0 + k * 8.0, "name": "A"} for k in range(4)]
        c = chart.compile_track(track, GRID, 40.0, section_markers=sections, phrase_boundaries=boundaries,
                                dynamic_difficulty=True)
        song = c.dd_sng
        named = [pi for pi in song.phrase_iterations if song.phrases[pi.phrase_id].name == "A"]
        self.assertGreater(len(named), 1)
        self.assertEqual(len({pi.difficulty for pi in named}), 1)

    def test_hero_levels_are_thirds(self):
        self.assertEqual(dd.hero_levels(0), (0, 0, 0))
        self.assertEqual(dd.hero_levels(1), (1, 1, 1), "two levels: all on the top one, or Score Attack crashes")
        self.assertEqual(dd.hero_levels(12), (4, 8, 12))
        self.assertEqual(dd.hero_levels(21), (7, 14, 21))
        song = _compiled().dd_sng
        for pi in song.phrase_iterations:
            self.assertEqual(pi.difficulty, dd.hero_levels(song.phrases[pi.phrase_id].max_difficulty))

    def test_notes_are_counted_at_the_hero_levels(self):
        c = _compiled()
        easy, medium, hard = c.note_counts
        self.assertEqual(hard, c.note_count)
        self.assertLess(easy, medium)
        self.assertLess(medium, hard)


class LevelGuardTests(unittest.TestCase):
    """A level cannot be fixed by hand: what the check reports must not be made by levelling."""

    def test_a_shape_whose_first_notes_are_left_out_sets_the_hand_at_its_start(self):
        shape = {"s": {"start": 1.0, "end": 2.0, "frets": [3, 5], "chord_id": 0, "kind": "handshape"}}
        late = _entity(1.5, (2, 5, {"hand": 3}))
        late.shape_id = "s"
        anchors = chart._hand_anchors([late], shape, 0, [0.0, 10.0], [])
        self.assertEqual(anchors[0][:2], (1.0, 3), "the hand moves at the shape's start, not inside it (I21)")

    def test_a_hammer_on_right_after_its_own_fret_is_picked_on_that_level(self):
        before = _entity(1.0, (3, 5, {}))
        hammer = _entity(1.5, (3, 5, {"fx": {"hammer": "hammer"}}))
        view = [before, hammer]
        chart._drop_same_fret_hopos(view, set())
        self.assertNotIn("hammer", view[1].notes[0][2]["fx"])
        self.assertIn("hammer", hammer.notes[0][2]["fx"], "the chart's own note is untouched")
        view = [before, hammer]
        chart._drop_same_fret_hopos(view, {(1.5, 3)})
        self.assertIn("hammer", view[1].notes[0][2]["fx"], "the chart's own I31 stays: the user sees it")
        between = _entity(1.25, (2, 7, {}))
        view = [before, between, hammer]
        chart._drop_same_fret_hopos(view, set())
        self.assertIn("hammer", view[2].notes[0][2]["fx"], "something picked between: fine")


class ScoreTests(unittest.TestCase):
    """NoteScorer: low is important, and comes in early."""
    BEATS = [(0, True), (500, False), (1000, False), (1500, False), (2000, True)]

    def _score(self, ms):
        return dd.score(_entity(ms / 1000, (0, 3, {})), self.BEATS, 0, 18000)

    def test_rhythm(self):
        self.assertEqual(self._score(0), 0, "first beat of a measure")
        self.assertEqual(self._score(1000) - dd._division_in_phrase(0, 18000, 1000), 2, "beat 3 of 4")
        self.assertEqual(self._score(500) - dd._division_in_phrase(0, 18000, 500), 4, "beat 2 of 4")
        self.assertEqual(self._score(250) - dd._division_in_phrase(0, 18000, 250), 20, "an eighth")
        self.assertEqual(self._score(125) - dd._division_in_phrase(0, 18000, 125), 40, "a sixteenth")

    def test_penalties(self):
        bend = _entity(0, (0, 3, {"bend": "full"}))
        mute = _entity(0, (0, 3, {"fx": {"dead": True}}))
        self.assertEqual(dd.score(bend, self.BEATS, 0, 18000), 10)
        self.assertEqual(dd.score(mute, self.BEATS, 0, 18000), 20)


class ChoiceTests(unittest.TestCase):
    def _templates(self, *frets):
        return dd.Templates([S.ChordTemplate(frets=list(f), fingers=[-1] * 6, notes=[-1] * 6, name="X") for f in frets])

    def test_easy_levels_lose_techniques_but_keep_bends_and_taps(self):
        note = {"fx": {"vibrato": True, "accent": True, "hammer": "hammer", "palmMute": True},
                "slide": "outDown", "tremPick": True, "harmonic": "pinch", "slap": "pop", "linkNext": True}
        e = _entity(0, (0, 3, note), sustain=0.5)
        removed = set()
        n = dd._copy_note(note)
        dd._prune(e, n, 0, 0.2, removed)
        self.assertEqual(n, {"fx": {"palmMute": True}})
        self.assertEqual((e.sustain, removed), (0.0, {0}))
        bend = {"bend": "full", "slap": "tap", "fx": {}}
        e = _entity(0, (0, 3, bend), sustain=0.5)
        n = dd._copy_note(bend)
        dd._prune(e, n, 0, 0.1, set())
        self.assertEqual((n["bend"], n["slap"], e.sustain), ("full", "tap", 0.5))

    def test_vibrato_goes_at_45_percent_even_after_tremolo(self):
        n = dd._copy_note({"tremPick": True, "fx": {"vibrato": True}})
        dd._prune(_entity(0, (0, 3, n)), n, 0, 0.3, set())
        self.assertEqual(n, {"fx": {}}, "DLC Builder keeps the vibrato here (elif)")

    def test_a_cut_stop_on_the_top_strings_keeps_the_same_notes_as_its_template(self):
        templates = self._templates([-1, -1, -1, 5, 5, 5])
        chord = _entity(0, (3, 5, {}), (4, 5, {}), (5, 5, {}), chord_id=0)
        [cut] = dd.choose(0.5, [chord], [0], templates, 3)
        self.assertEqual([s for s, _, _ in cut.notes], [4, 5])
        self.assertEqual(templates.list[cut.chord_id].frets, [-1, -1, -1, -1, 5, 5])
        self.assertEqual(templates.list[cut.chord_id].name, "X", "a cut chord keeps its name")

    def test_a_chord_becomes_its_lowest_note(self):
        templates = self._templates([3, 5, 5, -1, -1, -1])
        chord = _entity(0, (0, 3, {}), (1, 5, {}), (2, 5, {}), chord_id=0)
        [note] = dd.choose(0.2, [chord], [0], templates, 3)
        self.assertEqual((note.chord_id, note.notes[0][:2]), (-1, (0, 3)))

    def test_a_linked_note_goes_with_the_note_before_it(self):
        first = _entity(0, (2, 5, {"linkNext": True}))
        second = _entity(0.5, (2, 5, {}))
        third = _entity(1.0, (1, 3, {}))
        kept = dd.choose(0.5, [first, second, third], [40, 0, 0], dd.Templates([]), 0)
        self.assertEqual([e.time for e in kept], [1.0])


class CountTests(unittest.TestCase):
    def test_level_count_stays_within_dlc_builders_bounds(self):
        templates = dd.Templates([])
        single = [_entity(0, (0, 3, {}))]
        self.assertEqual(dd.level_count(single, templates.list, [(0, True)], 0, 1000), dd.MIN_LEVELS)
        self.assertEqual(dd.level_count([], templates.list, [], 0, 1000), 1)

    def test_a_repeat_is_what_is_played_not_editor_fields(self):
        plain = {"start": 0, "end": 1, "id": "a", "fx": {}}
        self.assertEqual(dd._signature(plain), dd._signature(dict(plain, start=2, id="b", finger=3, shapeId="s")))
        self.assertNotEqual(dd._signature(plain), dd._signature(dict(plain, bend=1)))
        self.assertNotEqual(dd._signature(plain), dd._signature(dict(plain, fx={"vibrato": True})))


if __name__ == "__main__":
    unittest.main()
