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
    def test_generated_end_follows_audio_instead_of_last_note(self):
        arr = _compiled([_note(2.0, 2.125, 1, 5)])
        end = next(pi.start_time for pi in arr.phrase_iterations if arr.phrases[pi.phrase_id].name == "END")
        self.assertAlmostEqual(end, 25.0)  # 20 seconds of audio + 5 second lead-in

    def test_explicit_song_end_drives_the_checker_with_lead_in(self):
        for lead in (0, 5):
            with self.subTest(lead=lead):
                spec = _spec([_note(2, 2.125, 1, 5), _note(8, 8.125, 1, 7)], lead=lead)
                spec["songEnd"] = 7.5
                codes = _codes(spec)
                self.assertIn(("I16", 8.0), codes)
                self.assertIn(("I39", 8.0), codes)
                spec["songEnd"] = 10
                self.assertNotIn("I16", [code for code, _ in _codes(spec)])
                self.assertNotIn("I39", [code for code, _ in _codes(spec)])

    def test_end_section_sets_exact_terminal_time_without_becoming_riff(self):
        sections = [{"t": 7.537, "text": "End", "sectionType": "end"}]
        for lead in (0, 5):
            with self.subTest(lead=lead):
                built = _built([_note(2, 2.125, 1, 5), _note(8, 8.125, 1, 7)], lead=lead, sections=sections)
                arr = built.compiled.sng
                end = next(pi.start_time for pi in arr.phrase_iterations if arr.phrases[pi.phrase_id].name == "END")
                self.assertAlmostEqual(end, 7.537 + lead)
                self.assertFalse(any('not recognized' in text for text in built.compiled.warnings))
                spec = _spec([_note(2, 2.125, 1, 5), _note(8, 8.125, 1, 7)], lead=lead, sections=sections)
                self.assertIn(("I39", 8.0), _codes(spec))
                self.assertIn(("I16", 8.0), _codes(spec))
                spec["tracks"][0]["sections"] = [{"t": 10.123, "text": "End", "sectionType": "end"}]
                self.assertNotIn("I39", [code for code, _ in _codes(spec)], 'own-timing End takes precedence')

    def test_short_last_note_on_measure_boundary_precedes_generated_end(self):
        for chord in (False, True):
            for lead in (0, 5):
                with self.subTest(chord=chord, lead=lead):
                    notes = [_note(2.0, 2.125, 1, 5), _note(4.0, 4.125, 1, 7)]
                    if chord:
                        notes.append(_note(4.0, 4.125, 2, 7))
                    spec = _spec(notes, lead=lead, toneMarkers=[{"t": 0.0, "tone": "lead"}])
                    codes = [code for code, _ in _codes(spec)]
                    self.assertNotIn("I16", codes, "generated No Guitar must start after the last onset")
                    self.assertNotIn("I39", codes, "generated END must start after the last onset")

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

    def test_chord_fingers_are_the_editors(self):
        """Em as the editor fingers it (2 and 3); open strings carry no finger (0 would be the thumb)."""
        em = _chord(2.0, 3.0, "022000", s5={"finger": 2}, s4={"finger": 3})
        song = _compiled(em)
        self.assertEqual(song.chords[0].fingers, [-1, 2, 3, -1, -1, -1])
        self.assertNotIn("I28", [c for c, _ in _codes(_spec(em, lead=5))])
        # The same grip fingered another way is another chord template.
        other = _chord(4.0, 5.0, "022000", s5={"finger": 1}, s4={"finger": 2})
        song = _compiled(em + other)
        self.assertEqual([c.fingers[1:3] for c in song.chords], [[2, 3], [1, 2]])

    def test_a_chosen_thumb_is_rocksmiths_thumb(self):
        """D/F# with the thumb on the low E: finger 0 there, -1 on the open D."""
        d = _chord(2.0, 3.0, "2x0232", s6={"finger": 0}, s3={"finger": 1}, s2={"finger": 3}, s1={"finger": 2})
        self.assertEqual(_compiled(d).chords[0].fingers, [0, -1, -1, 1, 3, 2])
        self.assertNotIn("I28", [c for c, _ in _codes(_spec(d, lead=5))])

    def test_a_chord_without_fingers_is_reported(self):
        warnings = []
        spec = builder._with_lead_in(_spec(_chord(2.0, 3.0, "022000")), 5)
        built = builder._compile_arrangement(spec, spec["tracks"][0], {"kind": "lead"}, 25.0, "KEY", warnings)
        self.assertEqual(built.compiled.sng.chords[0].fingers, [-1] * 6)
        self.assertIn(("finger", 7.0), built.compiled.fixes)

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

    def test_legato_slide_into_a_chord_links_to_its_note(self):
        # As EOF writes it: the chord goes out as single notes, so the slide's target is a Child.
        notes = [_note(2.0, 2.5, 3, 5, slide="legato"), *_chord(3.0, 4.0, "x02270")]
        [found] = builder.check_spec(_spec(notes, lead=5))
        self.assertEqual([i["code"] for i in found["issues"] if i["code"] not in ("hand", "finger")], [])
        source, *rest = _compiled(notes).levels[0].notes
        self.assertTrue(source.mask & S.SLIDE and source.mask & S.PARENT)
        self.assertEqual(source.slide_to, 2)     # the G string of x02270
        self.assertEqual(len(rest), 5, "the chord's five notes, one by one")
        self.assertEqual([n.parent_prev_note for n in rest].count(0), 1)

    def test_the_check_reports_the_silence_the_package_starts_with(self):
        # The editor shows it: the setting, or more when the first note comes early.
        [found] = builder.check_spec(_spec([_note(12.0, 12.5, 3, 5)], lead=5))
        self.assertEqual(found["leadIn"], 5.0)
        [found] = builder.check_spec(_spec([_note(2.0, 2.5, 3, 5)], lead=5))
        self.assertEqual(found["leadIn"], 8.0)    # first note at 10 s

    def test_the_silence_ends_with_a_count_in_measure(self):
        # As EOF's Add silence: a high tick on the downbeat of the measure before
        # the song's first beat, low ticks on the rest; COUNT on the first beat.
        [found] = builder.check_spec(_spec([_note(12.0, 12.5, 3, 5)], lead=10))
        self.assertEqual(found["count"], -10.0)
        ticks = [e for e in found["events"] if e["code"] in ("B0", "B1")]
        self.assertEqual(ticks, [{"t": -2.0, "code": "B0"}, {"t": -1.5, "code": "B1"},
                                 {"t": -1.0, "code": "B1"}, {"t": -0.5, "code": "B1"}])
        song = _compiled([_note(12.0, 12.5, 3, 5)], lead=10)
        self.assertEqual([code for _, code in song.events if code in ("B0", "B1")], ["B0", "B1", "B1", "B1"])

    def test_no_count_in_without_silence(self):
        [found] = builder.check_spec(_spec([_note(12.0, 12.5, 3, 5)], lead=0))
        self.assertEqual([e for e in found["events"] if e["code"] in ("B0", "B1")], [])

    def test_a_slide_off_its_string_is_shown_where_it_is(self):
        notes = [_note(2.0, 2.5, 3, 5, slide="shift"), _note(2.5, 3.0, 2, 7)]
        [found] = builder.check_spec(_spec(notes, lead=5))
        self.assertIn(("slide", 2.0), [(i["code"], i["time"]) for i in found["issues"]])

    def test_dead_notes_leave_chords_that_are_not_muted(self):
        partly = _chord(2.0, 3.0, "355xxx") + [_note(2.0, 3.0, 3, 5, fx={"dead": True})]
        fully = _chord(4.0, 5.0, "355xxx", s6={"fx": {"dead": True}}, s5={"fx": {"dead": True}},
                       s4={"fx": {"dead": True}})
        [found] = builder.check_spec(_spec(partly + fully, lead=5))
        self.assertEqual([(i["code"], i["time"], i["title"], i["important"]) for i in found["issues"]
                          if i["code"] not in ("hand", "finger")],
                         [("I29", 2.0, "Dead note left out of the chord", False)])
        song = _compiled(partly + fully)
        first, second = song.levels[0].notes
        self.assertEqual(song.chords[first.chord_id].frets, [3, 5, 5, -1, -1, -1])
        self.assertTrue(second.mask & S.FRETHANDMUTE, "a fully muted chord stays")

    def test_bend_points_at_the_same_moment_collapse(self):
        notes = [_note(2.0, 3.0, 3, 7, bend="custom", bendPoints=[[0, 0], [0.5, 2], [0.5, 2], [0.5004, 1], [1, 2]])]
        self.assertNotIn("I34", [c for c, _ in _codes(_spec(notes, lead=5))])
        values = _compiled(notes).levels[0].notes[0].bend_values
        self.assertEqual([(round(b.time, 3), b.step) for b in values], [(7.5, 1.0), (8.0, 1.0)])

    def test_hand_positions_are_the_editors(self):
        """Every hand position comes from the editor; the export only translates it."""
        hands = [5, 5, 10, 10, 2]
        notes = [_note(2.0 + i * 0.5, 2.4 + i * 0.5, 2, fret, hand=hand)
                 for i, (fret, hand) in enumerate(zip([5, 8, 12, 14, 2], hands))]
        anchors = _compiled(notes).levels[0].anchors
        self.assertEqual([(round(a.start_time, 3), a.fret, a.width) for a in anchors],
                         [(7.0, 5, 4), (8.0, 10, 5), (9.0, 2, 4)],   # 5 s of lead-in
                         "a position where the hand moves, four frets wide or as far as a note reaches")
        song = _compiled(notes)
        for note, hand in zip(song.levels[0].notes, hands):
            self.assertEqual(note.anchor_fret, hand)

    def test_hand_positions_count_from_the_nut_and_start_every_phrase(self):
        notes = [_note(2.0, 2.4, 2, 3, hand=3), _note(9.0, 9.4, 2, 3, hand=3)]
        song = _compiled(notes, capo=2, phraseBoundaries=[{"t": 8.0}])
        self.assertEqual([(round(a.start_time, 3), a.fret) for a in song.levels[0].anchors],
                         [(7.0, 5), (13.0, 5)], "capo added; the phrase at 8 s (13 s after the lead-in) starts with the hand in force")

    def test_a_note_without_a_hand_is_reported(self):
        built = builder._compile_arrangement(_spec([_note(2.0, 2.4, 2, 5)]),
                                             _spec([_note(2.0, 2.4, 2, 5)])["tracks"][0],
                                             {"track": 0, "kind": "lead"}, 20.0, "KEY", warnings := [])
        self.assertEqual(built.compiled.sng.levels[0].anchors[0].fret, 5)
        self.assertIn("hand", [code for code, _ in built.compiled.fixes])

    def test_slide_out_ends_before_the_next_position(self):
        notes = [_note(2.0, 2.5, 1, 3, slide="outUp"), _note(2.5, 3.0, 1, 12)]
        self.assertNotIn("I23", [c for c, _ in _codes(_spec(notes, lead=5))])
        # 1/32 of a 2 s measure before the next note, like every tail (chart._leave_note_gaps).
        self.assertAlmostEqual(_compiled(notes).levels[0].notes[0].sustain, 0.4375)

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
        self.assertEqual([i for i in built.issues() if i.code not in ("hand", "finger")], [])
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
