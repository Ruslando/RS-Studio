"""The port of DLC Builder's arrangement checker (rocksmith/checker.py).

Parity with DLC Builder itself was established by building packages and running
Rocksmith2014.NET's own checker on them; these tests pin the cases down. The
first group goes through the exporter, the second builds SNG data by hand for
the issues the exporter cannot produce on its own.
"""
import json
import unittest

from rs_studio.rocksmith import builder, checker
from rs_studio.rocksmith import sng as S
from rs_studio.rocksmith.psarc import read_psarc

GUITAR = [64, 59, 55, 50, 45, 40]


def _note(start, end, string, fret, **effects):
    """string: 1 = highest, as the export spec has it."""
    return {"start": start, "end": end, "pitch": GUITAR[string - 1] + fret,
            "string": string, "fret": fret, **effects}


def _spec(notes, lead=0, **track):
    return {"metadata": {"title": "Song", "artist": "Band"},
            "grid": {"bpm": 120, "offset": 0.0, "tsNum": 4, "tsDen": 4},
            "duration": 20.0,
            "tracks": [{"name": "Gtr", "tuning": GUITAR, "notes": notes, **track}],
            "rocksmith": {"arrangements": [{"track": 0, "kind": "lead"}], "leadingSilence": lead}}


def _codes(spec):
    [found] = builder.check_spec(spec)
    return [(i["code"], i["time"]) for i in found["issues"]]


class ThroughTheExporter(unittest.TestCase):
    def test_the_export_keeps_the_first_phrase_empty(self):
        """However little silence is asked for, the first note leaves an empty COUNT measure."""
        notes = [_note(0.0, 0.5, 6, 3), _note(4.0, 4.5, 6, 5)]
        self.assertNotIn("I25", [c for c, _ in _codes(_spec(notes))])

    def test_times_come_back_in_editor_time(self):
        notes = [_note(2.0, 2.5, 4, 5), _note(4.0, 4.5, 4, 5)]
        spec = _spec(notes, lead=5, toneMarkers=[{"t": 4.0, "tone": "lead"}])
        self.assertIn(("I15", 4.0), _codes(spec))

    def test_content_issues(self):
        notes = [
            _note(2.0, 2.5, 3, 5), _note(2.5, 3.0, 3, 5, fx={"hammer": True}),   # I31
            _note(4.0, 5.0, 3, 12, harmonic="natural", bend="full"),             # I35
            _note(6.5, 7.0, 4, 5),                                               # I16
            _note(8.0, 9.0, 4, 7),
        ]
        spec = _spec(notes, lead=5, sections=[
            {"t": 2.0, "sectionType": "riff"}, {"t": 6.0, "sectionType": "noguitar"},
            {"t": 8.0, "sectionType": "riff"}])
        codes = _codes(spec)
        for expected in [("I31", 2.5), ("I35", 4.0), ("I16", 6.5)]:
            self.assertIn(expected, codes)

    def test_one_failing_arrangement_does_not_hide_the_others(self):
        spec = _spec([_note(2.0, 2.5, 6, 3)])
        spec["tracks"].append({"name": "Empty", "tuning": GUITAR, "notes": []})
        spec["rocksmith"]["arrangements"].append({"track": 1, "kind": "rhythm"})
        lead, rhythm = builder.check_spec(spec)
        self.assertIsNone(lead["error"])
        self.assertEqual(rhythm["error"], "No voiced notes to export")

    def test_export_warnings_carry_the_issues_in_editor_time(self):
        notes = [_note(4.0, 5.0, 3, 12, harmonic="natural", bend="full")]
        _, warnings, _ = builder.build_cdlc(_spec(notes), None, _wems=(b"a", b"b"), _song_length=20.0)
        self.assertIn("Lead: I35 at 0:04.000: Natural harmonic with bend", warnings)


def _chord(start, end, frets_lo_hi, **effects_by_string):
    """frets low->high like '022000'; effects keyed 's1'..'s6' (1 = highest)."""
    return [_note(start, end, 6 - i, int(f), **effects_by_string.get(f"s{6 - i}", {}))
            for i, f in enumerate(frets_lo_hi) if f != "x"]


def _built(notes, lead=5, kind="lead", **track):
    """What the export would ship for one lane."""
    spec = builder._with_lead_in(_spec(notes, lead, **track), lead)
    return builder._compile_arrangement(spec, spec["tracks"][0], {"kind": kind}, 20.0 + lead, "KEY", [])


def _compiled(notes, lead=5, **track):
    return _built(notes, lead, **track).compiled.sng


class ExporterFixes(unittest.TestCase):
    """Problems DLC Builder found in our packages, fixed at the source."""

    def test_open_strings_carry_no_finger(self):
        song = _compiled(_chord(2.0, 3.0, "022000"))
        fingers = song.chords[0].fingers
        self.assertEqual([fingers[s] for s in (0, 3, 4, 5)], [-1] * 4, "open strings")
        self.assertTrue(all(fingers[s] > 0 for s in (1, 2)), "fretted strings")
        self.assertNotIn("I28", [c for c, _ in _codes(_spec(_chord(2.0, 3.0, "022000"), lead=5))])

    def test_every_phrase_starts_with_an_anchor(self):
        # One hand position across two phrases (120 BPM: a phrase every 8 measures = 16 s).
        notes = [_note(2.0 + i, 2.5 + i, 3, 5) for i in range(20)]
        song = _compiled(notes, phraseBoundaries=[{"t": 10.0}])
        starts = [round(pi.start_time, 3) for pi in song.phrase_iterations]
        anchors = [round(a.start_time, 3) for a in song.levels[0].anchors]
        for start in starts[1:-1]:
            self.assertIn(start, anchors)

    def test_repeated_chords_restart_their_shape_at_a_phrase(self):
        chords = [n for i in range(12) for n in _chord(2.0 + i, 2.9 + i, "x355xx")]
        spec = _spec(chords, lead=5, phraseBoundaries=[{"t": 8.0}])
        codes = [c for c, _ in _codes(spec)]
        self.assertFalse({"I21", "I22"} & set(codes), codes)
        song = _compiled(chords, phraseBoundaries=[{"t": 8.0}])
        self.assertEqual(len(song.levels[0].handshapes), 2)

    def test_short_vibrato_and_tremolo_keep_a_tail(self):
        notes = [_note(2.0, 2.1, 3, 7, fx={"vibrato": True}), _note(3.0, 3.1, 3, 7, tremPick=True),
                 *_chord(4.0, 4.1, "x355xx", s4={"fx": {"vibrato": True}})]
        self.assertNotIn("I40", [c for c, _ in _codes(_spec(notes, lead=5))])
        sustains = [round(n.sustain, 3) for n in _compiled(notes).levels[0].notes]
        self.assertEqual(sustains, [0.1, 0.1, 0.1])

    def test_unscorable_notes_are_ignored(self):
        notes = [_note(2.0, 3.0, 3, 7, harmonic="natural"),       # held 7th fret harmonic
                 _note(4.0, 4.5, 1, 23),                          # fret 23
                 _note(6.0, 6.5, 2, 21), _note(6.0, 6.5, 1, 23),  # chord reaching fret 23
                 _note(8.0, 9.0, 3, 7, harmonic="pinch"),         # pinch: scored
                 _note(10.0, 10.5, 3, 5)]
        song = _compiled(notes)
        ignored = [bool(n.mask & S.IGNORE) for n in song.levels[0].notes]
        self.assertEqual(ignored, [True, True, True, False, False])
        self.assertEqual(song.metadata.max_notes_and_chords_real, 2.0)
        self.assertEqual(sum(song.levels[0].notes_in_pi_excl_ignored), 2)
        self.assertNotIn("I13", [c for c, _ in _codes(_spec(notes, lead=5))])

    def test_legato_slide_into_a_chord_is_not_linked(self):
        notes = [_note(2.0, 2.5, 3, 5, slide="legato"), *_chord(3.0, 4.0, "x02270")]
        [found] = builder.check_spec(_spec(notes, lead=5))
        self.assertNotIn("I03", [i["code"] for i in found["issues"]])
        self.assertIn("1 legato slide(s) end on a chord; Rocksmith cannot link a note to a chord, "
                      "so the chord is picked again", found["warnings"])
        source = _compiled(notes).levels[0].notes[0]
        self.assertTrue(source.mask & S.SLIDE)
        self.assertFalse(source.mask & S.PARENT)
        self.assertEqual(source.slide_to, 2)     # the G string of x02270

    def test_dead_notes_leave_chords_that_are_not_muted(self):
        partly = _chord(2.0, 3.0, "355xxx") + [_note(2.0, 3.0, 3, 5, fx={"dead": True})]
        fully = _chord(4.0, 5.0, "355xxx", s6={"fx": {"dead": True}}, s5={"fx": {"dead": True}},
                       s4={"fx": {"dead": True}})
        [found] = builder.check_spec(_spec(partly + fully, lead=5))
        self.assertNotIn("I29", [i["code"] for i in found["issues"]])
        self.assertIn("1 dead note(s) were left out of chords that are not fully muted", found["warnings"])
        song = _compiled(partly + fully)
        first, second = song.levels[0].notes
        self.assertEqual(song.chords[first.chord_id].frets, [3, 5, 5, -1, -1, -1])
        self.assertTrue(second.mask & S.FRETHANDMUTE, "a fully muted chord stays")

    def test_bend_points_at_the_same_moment_collapse(self):
        notes = [_note(2.0, 3.0, 3, 7, bend="custom", bendPoints=[[0, 0], [0.5, 2], [0.5, 2], [0.5004, 1], [1, 2]])]
        self.assertNotIn("I34", [c for c, _ in _codes(_spec(notes, lead=5))])
        values = _compiled(notes).levels[0].notes[0].bend_values
        self.assertEqual([(round(b.time, 3), b.step) for b in values], [(7.5, 1.0), (8.0, 1.0)])

    def test_position_shifts_before_a_pull_off(self):
        notes = [_note(2.0, 2.4, 1, 8), _note(2.5, 3.0, 1, 5, fx={"hammer": True})]
        self.assertNotIn("I33", [c for c, _ in _codes(_spec(notes, lead=5))])
        anchors = _compiled(notes).levels[0].anchors
        self.assertEqual([(round(a.start_time, 3), a.fret) for a in anchors], [(7.0, 5)])

    def test_a_slide_keeps_its_finger(self):
        notes = [_note(2.0, 2.4, 2, 5), _note(2.5, 3.0, 2, 7, slide="legato"), _note(3.0, 4.0, 2, 12)]
        self.assertNotIn("I32", [c for c, _ in _codes(_spec(notes, lead=5))])
        anchors = _compiled(notes).levels[0].anchors
        self.assertEqual([(round(a.start_time, 3), a.fret) for a in anchors], [(7.0, 5), (8.0, 10)],
                         "the third finger slides from fret 7 to 12")

    def test_slide_out_ends_before_the_next_position(self):
        notes = [_note(2.0, 2.5, 1, 3, slide="outUp"), _note(2.5, 3.0, 1, 12)]
        self.assertNotIn("I23", [c for c, _ in _codes(_spec(notes, lead=5))])
        self.assertAlmostEqual(_compiled(notes).levels[0].notes[0].sustain, 0.49)

    def test_low_tunings_stay_low(self):
        """A standard is seven steps down, not five up."""
        a_std = [p - 7 for p in GUITAR]
        notes = [{"start": 2.0, "end": 2.5, "pitch": a_std[5], "string": 6, "fret": 0}]
        self.assertEqual(_compiled(notes, tuning=a_std).metadata.tuning, (-7,) * 6)

    def test_low_bass_gets_dlc_builders_low_tuning_fix(self):
        b_std = [38, 33, 28, 23]
        notes = [{"start": 2.0, "end": 2.5, "pitch": 23, "string": 4, "fret": 0},
                 {"start": 3.0, "end": 3.5, "pitch": 28, "string": 4, "fret": 5},
                 {"start": 3.0, "end": 3.5, "pitch": 35, "string": 3, "fret": 7}]
        built = _built(notes, kind="bass", tuning=b_std)
        self.assertEqual(built.compiled.sng.metadata.tuning, (7, 7, 7, 7, 0, 0))
        self.assertEqual(built.cent_offset, -1200.0)
        self.assertEqual(built.issues(), [])
        # Template pitches follow the reported tuning, as DLC Builder writes them.
        self.assertEqual(built.compiled.sng.chords[0].notes, [40, 47, -1, -1, -1, -1])
        spec = _spec(notes, lead=5, tuning=b_std)
        spec["rocksmith"]["arrangements"] = [{"track": 0, "kind": "bass"}]
        files, _, _ = builder.build_cdlc(spec, None, _wems=(b"a", b"b"), _song_length=20.0)
        [attrs] = [next(iter(json.loads(blob)["Entries"].values()))["Attributes"]
                   for path, blob in read_psarc(files).items() if path.endswith(".json")]
        self.assertEqual(attrs["CentOffset"], -1200.0)


def _song(notes=(), chords=(), anchors=(), handshapes=(), phrases=("COUNT", "p1", "END"),
          iterations=(0.0, 1.0, 10.0), templates=(), tuning=(0,) * 6):
    return S.SNG(
        phrases=[S.Phrase(name=n) for n in phrases],
        phrase_iterations=[S.PhraseIteration(phrase_id=min(i, len(phrases) - 1), start_time=t, end_time=0.0)
                           for i, t in enumerate(iterations)],
        sections=[S.Section(name="riff", number=1, start_time=1.0, end_time=10.0, start_pi=1, end_pi=1,
                            string_mask=[0] * 36)],
        chords=list(templates),
        levels=[S.Level(notes=sorted([*notes, *chords], key=lambda n: n.time),
                        anchors=[S.Anchor(start_time=t, end_time=0, first_note_time=0, last_note_time=0,
                                          fret=f, width=4, phrase_iteration_id=0) for t, f in anchors],
                        handshapes=[S.FingerPrint(chord_id=c, start_time=a, end_time=b, first_note_time=a,
                                                  last_note_time=-1) for c, a, b in handshapes])],
        metadata=S.MetaData(song_length=12.0, tuning=tuning),
    )


def _single(time, string, fret, mask=0, sustain=0.0, **fields):
    return S.Note(mask=S.SINGLE | mask, time=time, string=string, fret=fret, sustain=sustain, **fields)


def _found(song, is_bass=False):
    return [(i.code, i.time) for i in checker.check(song, is_bass=is_bass)]


class HandBuiltArrangements(unittest.TestCase):
    def test_link_next_targets(self):
        missing = _single(2.0, 1, 5, S.PARENT, 0.5)
        self.assertIn(("I04", 2.0), _found(_song([missing])))
        gap = [_single(2.0, 1, 5, S.PARENT, 0.5), _single(3.0, 1, 5)]
        self.assertIn(("I08", 2.0), _found(_song(gap)))
        fret = [_single(2.0, 1, 5, S.PARENT, 1.0), _single(3.0, 1, 7)]
        self.assertIn(("I06", 3.0), _found(_song(fret)))
        slide = [_single(2.0, 1, 5, S.PARENT, 1.0, slide_to=9), _single(3.0, 1, 7)]
        self.assertIn(("I05", 2.0), _found(_song(slide)))
        fine = [_single(2.0, 1, 5, S.PARENT, 1.0, slide_to=7), _single(3.0, 1, 7)]
        self.assertEqual([c for c, _ in _found(_song(fine))], [])

    def test_linked_chord_without_linked_notes(self):
        template = S.ChordTemplate(frets=[3, 5, -1, -1, -1, -1], fingers=[1, 3, -1, -1, -1, -1], notes=[0] * 6)
        chord = S.Note(mask=S.CHORD | S.PARENT | S.CHORDPANEL, time=2.0, chord_id=0)
        self.assertIn(("I18", 2.0), _found(_song(chords=[chord], templates=[template])))

    def test_anchor_inside_handshape(self):
        template = S.ChordTemplate(frets=[3, 5, -1, -1, -1, -1], fingers=[1, 3, -1, -1, -1, -1], notes=[0] * 6)
        song = _song(anchors=[(1.0, 3), (3.0, 5)], handshapes=[(0, 2.0, 4.0)], templates=[template])
        self.assertIn(("I21", 3.0), _found(song))
        song = _song(anchors=[(1.0, 3), (3.0, 5)], handshapes=[(0, 2.0, 4.0)], templates=[template],
                     phrases=("COUNT", "p1", "p2", "END"), iterations=(0.0, 1.0, 3.0, 10.0))
        self.assertIn(("I22", 3.0), _found(song))

    def test_fingering_against_anchor(self):
        template = S.ChordTemplate(frets=[-1, 5, 7, 7, -1, -1], fingers=[-1, 2, 3, 4, -1, -1], notes=[0] * 6)
        song = _song(anchors=[(1.0, 5)], handshapes=[(0, 2.0, 3.0)], templates=[template])
        self.assertIn(("I20", 2.0), _found(song))

    def test_open_strings_are_not_fingered(self):
        """Finger 0 is the thumb: an open string marked 0 reads as a thumb barre."""
        template = S.ChordTemplate(frets=[0, 2, 2, 0, 0, 0], fingers=[0, 2, 3, 0, 0, 0], notes=[0] * 6)
        chord = S.Note(mask=S.CHORD | S.CHORDPANEL, time=2.0, chord_id=0)
        self.assertIn(("I28", 2.0), _found(_song(chords=[chord], templates=[template])))
        template.fingers = [-1, 2, 3, -1, -1, -1]
        self.assertNotIn(("I28", 2.0), _found(_song(chords=[chord], templates=[template])))

    def test_first_phrase_with_notes(self):
        self.assertIn(("I25", 0.5), _found(_song([_single(0.5, 1, 5)])))
        self.assertNotIn("I25", [c for c, _ in _found(_song([_single(2.0, 1, 5)]))])

    def test_strings_frets_and_phrases(self):
        self.assertIn(("I36", 2.0), _found(_song([_single(2.0, 4, 5)]), is_bass=True))
        self.assertIn(("I38", 2.0), _found(_song([_single(2.0, 1, 25)])))
        self.assertIn(("I26", None), _found(_song([_single(2.0, 1, 5)], phrases=("COUNT", "p1"))))
        many = tuple(float(i) for i in range(102))
        self.assertIn(("I30", None), _found(_song([_single(2.5, 1, 5)], iterations=many)))

    def test_low_bass_tuning(self):
        self.assertEqual([i.code for i in checker.check_bass_tuning([-5, -5, -5, -5], 0.0)], ["I41"])
        self.assertEqual(checker.check_bass_tuning([7, 7, 7, 7], -1200.0), [])
        self.assertEqual([i.code for i in checker.check_bass_tuning([-1, 0, 0, 0], -1200.0)], ["I42"])

    def test_times_round_like_dlc_builder(self):
        """Through float32, as the SNG stores them: 1.0005 s is 1000 ms, not 1001."""
        self.assertEqual(checker._ms(1.0005), 1000)
        self.assertEqual(checker._ms(2.25), 2250)


if __name__ == "__main__":
    unittest.main()
