"""The whole Rocksmith package, built without the audio converter and read back."""
import json
import os
import unittest

from rs_studio.rocksmith import builder, sng, manifest
from rs_studio.rocksmith.psarc import build_psarc, read_psarc
from rs_studio.rocksmith.tones import gear_catalog

GUITAR = [64, 59, 55, 50, 45, 40]                       # hi -> lo, as the editor sends it
DROP_D = [64, 59, 55, 50, 45, 38]
BASS = [43, 38, 33, 28]
WEMS = (b"RIFF main audio", b"RIFF preview audio")


def _track(name, tuning, frets, **extra):
    low = len(tuning)                                   # the lowest string
    # The hand as the editor sends it: the index on the first fretted note, reaching up.
    hand = min([f for f in frets if f > 0], default=1)
    notes = [{"start": 1 + i * 0.5, "end": 1.4 + i * 0.5, "pitch": tuning[-1] + fret, "string": low, "fret": fret,
              "hand": hand}
             for i, fret in enumerate(frets)]
    return {"name": name, "tuning": tuning, "notes": notes, **extra}


def _spec(tracks, arrangements, **rocksmith):
    return {"metadata": {"title": "Song", "artist": "Band", "album": "LP", "year": "2020"},
            "grid": {"bpm": 120, "offset": 0.0, "tsNum": 4, "tsDen": 4}, "tracks": tracks,
            "rocksmith": {"arrangements": arrangements, **rocksmith}}


def _build(spec):
    data, warnings, name = builder.build_cdlc(spec, None, _wems=WEMS, _song_length=20.0)
    files = read_psarc(data)
    songs = {}
    for path, blob in files.items():
        if path.endswith(".json"):
            attributes = next(iter(json.loads(blob)["Entries"].values()))["Attributes"]
            songs[attributes["ArrangementName"]] = attributes
    return files, songs, warnings, name


class RocksmithPackageTests(unittest.TestCase):
    def test_package_carries_every_arrangement_and_the_audio(self):
        spec = _spec([_track("Gtr", DROP_D, [0, 3, 5, 7]), _track("Bass", BASS, [0, 3, 5])],
                     [{"track": 0, "kind": "lead", "tuning": DROP_D}, {"track": 1, "kind": "bass", "tuning": BASS}],
                     leadingSilence=12, version=4)
        files, songs, warnings, name = _build(spec)
        self.assertEqual(warnings, [])
        self.assertEqual(name, "Band_Song_v4_p.psarc")
        self.assertIn(b"Package Version: 4\n", files["toolkit.version"])
        self.assertEqual(sorted(songs), ["Bass", "Lead"])
        lead, bass = songs["Lead"], songs["Bass"]
        self.assertEqual((lead["SongName"], lead["ArtistName"], lead["AlbumName"], lead["SongYear"]), ("Song", "Band", "LP", 2020))
        self.assertEqual((lead["NotesHard"], bass["NotesHard"]), (4, 3))
        self.assertEqual(lead["SongLength"], 32.0, "20 s of audio behind 12 s of silence")
        self.assertEqual(lead["Tuning"]["string0"], -2, "the low string is tuned down to D")
        self.assertEqual(set(bass["Tuning"].values()), {0})
        self.assertNotIn("CapoFret", lead)
        # Both audio files are in, under the ids their sound banks point at.
        wems = sorted(blob for path, blob in files.items() if path.endswith(".wem"))
        self.assertEqual(wems, sorted(WEMS))
        for path, blob in files.items():
            if path.endswith(".sng"):
                self.assertGreater(len(sng.unpack(blob)), len(blob), path)

    def test_sort_names_and_file_name_as_dlc_builder(self):
        """convertToSortField: articles go, official artist names apply, the album stays."""
        for artist, title, album, sorts, name in [
                ("The Beatles", "A Day in the Life", "The White Album",
                 ("Beatles", "Day in the Life", "The White Album"), "Beatles_Day-in-the-Life_v1_p.psarc"),
                ("Mötley Crüe", "An Ode", "Dr. Feelgood", ("Motley Crue", "Ode", "Dr. Feelgood"), "Motley-Crue_Ode_v1_p.psarc"),
                ("Theory", "Andromeda", "Anthology", ("Theory", "Andromeda", "Anthology"), "Theory_Andromeda_v1_p.psarc")]:
            with self.subTest(artist):
                spec = _spec([_track("Gtr", GUITAR, [0, 3])], [{"track": 0, "kind": "lead"}])
                spec["metadata"].update(artist=artist, title=title, album=album)
                _, songs, _, file_name = _build(spec)
                lead = songs["Lead"]
                self.assertEqual((lead["ArtistNameSort"], lead["SongNameSort"], lead["AlbumNameSort"]), sorts)
                self.assertEqual(file_name, name)

    def test_partition_counts_arrangements_of_one_name(self):
        """DLC Builder's Partitioner: Lead 1, Lead 2 …, in the SNG and the manifest alike."""
        spec = _spec([_track("Gtr", GUITAR, [0, 3]), _track("Gtr2", GUITAR, [5, 7]), _track("Bass", BASS, [0, 3])],
                     [{"track": 1, "kind": "bonus_lead"}, {"track": 0, "kind": "lead"}, {"track": 2, "kind": "bass"}])
        files, _, _, _ = _build(spec)
        parts = {}
        for path, blob in files.items():
            if path.endswith(".json"):
                attrs = next(iter(json.loads(blob)["Entries"].values()))["Attributes"]
                stem = path.rsplit("/", 1)[1].removesuffix(".json")
                plain = sng.unpack(files[f"songs/bin/generic/{stem}.sng"])
                # MetaData ends: part int16, song length, tuning count + 6 int16, first note twice, max difficulty.
                part = int.from_bytes(plain[-(2 + 4 + 4 + 12 + 12):-(4 + 4 + 12 + 12)], "little")
                parts[stem.split("_", 1)[1]] = (attrs["SongPartition"], part)
        self.assertEqual(parts, {"lead": (1, 1), "lead2": (2, 2), "bass": (1, 1)})

    def test_package_details_as_dlc_builder_and_the_toolkit_write_them(self):
        """File names lead, lead2; FullName Key_Lead; ArrangementSort 0; IsCustom tones;
        an xblock with a byte order mark; and "Remastered", which CFSM looks for."""
        spec = _spec([_track("Gtr", GUITAR, [0, 3]), _track("Gtr2", GUITAR, [5, 7])],
                     [{"track": 0, "kind": "lead"}, {"track": 1, "kind": "alt_lead"}])
        files, _, _, _ = _build(spec)
        key = next(p for p in files if p.endswith(".xblock")).rsplit("/", 1)[1].removesuffix(".xblock")
        self.assertEqual(sorted(p for p in files if p.endswith(".sng")),
                         [f"songs/bin/generic/{key}_lead.sng", f"songs/bin/generic/{key}_lead2.sng"])
        attrs = [next(iter(json.loads(b)["Entries"].values()))["Attributes"] for p, b in files.items() if p.endswith(".json")]
        self.assertEqual({a["FullName"].split("_", 1)[1] for a in attrs}, {"Lead"})
        self.assertEqual({a["ArrangementSort"] for a in attrs}, {0})
        self.assertTrue(all(t["IsCustom"] is True for a in attrs for t in a["Tones"]))
        self.assertTrue(files[f"gamexblocks/nsongs/{key}.xblock"].startswith(b"\xef\xbb\xbf<?xml"))
        self.assertTrue(files["toolkit.version"].endswith(b"Package Comment: Remastered"))
        # No DNA, as DLC Builder and the Toolkit build from EOF: none in the SNG, 0 s in the manifest.
        self.assertEqual({(a["DNA_Riffs"], a["DNA_Chords"], a["DNA_Solo"]) for a in attrs}, {(0.0, 0.0, 0.0)})
        song = builder._compile_arrangement(spec, spec["tracks"][0], {"kind": "lead"}, 20.0, "KEY", []).compiled.sng
        self.assertEqual(song.dnas, [])
        self.assertIn(f"{key}_lead2.json".encode(), files[f"{key}_aggregategraph.nt"])
        # The ids still come from the internal tags: songs exported before keep their progress.
        dlc_key = attrs[0]["DLCKey"]
        self.assertEqual({a["PersistentID"] for a in attrs},
                         {manifest.stable_uuid(dlc_key, tag).hex.upper() for tag in ("lead", "alt_lead")})

    def test_capo_chosen_for_the_export_replaces_the_layers_own(self):
        tracks = [_track("Gtr", GUITAR, [0, 3], capo=2)]
        own = _build(_spec(tracks, [{"track": 0, "kind": "lead", "tuning": GUITAR}]))[1]["Lead"]
        self.assertEqual(own["CapoFret"], 2)
        chosen = _build(_spec(tracks, [{"track": 0, "kind": "lead", "tuning": GUITAR, "capo": 4}]))[1]["Lead"]
        self.assertEqual(chosen["CapoFret"], 4)
        removed = _build(_spec(tracks, [{"track": 0, "kind": "lead", "tuning": GUITAR, "capo": 0}]))[1]["Lead"]
        self.assertNotIn("CapoFret", removed)

    def test_scroll_speed_is_each_arrangements_own(self):
        spec = _spec([_track("Gtr", GUITAR, [0, 3]), _track("Bass", BASS, [0, 3])],
                     [{"track": 0, "kind": "lead", "tuning": GUITAR, "scrollSpeed": 2.04},
                      {"track": 1, "kind": "bass", "tuning": BASS}])
        songs = _build({**spec, "rocksmith": {**spec["rocksmith"], "dynamicDifficulty": False}})[1]
        self.assertEqual(songs["Lead"]["DynamicVisualDensity"], [2.0] * 20, "one level: the speed throughout")
        self.assertEqual(songs["Bass"]["DynamicVisualDensity"], [1.3] * 20, "unset: the usual 1.3")
        # With levels: from 5.0 at the easiest down to the speed at the hardest (createDynamicVisualDensity).
        levelled = _build(spec)[1]["Lead"]
        self.assertEqual(levelled["DynamicVisualDensity"][0], 5.0)
        self.assertEqual(levelled["DynamicVisualDensity"][levelled["MaxPhraseDifficulty"]:], [2.0] * (20 - levelled["MaxPhraseDifficulty"]))
        self.assertEqual(builder._scroll_speed(0.1), 0.5)
        self.assertEqual(builder._scroll_speed(9), 5.0)

    def test_picked_bass_is_marked_as_dlc_builder_marks_it(self):
        spec = _spec([_track("Gtr", GUITAR, [0, 3]), _track("Bass", BASS, [0, 3])],
                     [{"track": 0, "kind": "lead", "tuning": GUITAR, "bassPicked": True},
                      {"track": 1, "kind": "bass", "tuning": BASS, "bassPicked": True}])
        files, songs, _, _ = _build(spec)
        self.assertEqual(songs["Bass"]["ArrangementProperties"]["bassPick"], 1)
        self.assertEqual(songs["Lead"]["ArrangementProperties"]["bassPick"], 0, "a guitar is never picked bass")
        header = {e["Attributes"]["ArrangementName"]: e["Attributes"]
                  for e in json.loads(next(b for p, b in files.items() if p.endswith(".hsan")))["Entries"].values()}
        self.assertEqual(header["Bass"]["BassPick"], 1)
        self.assertNotIn("BassPick", header["Lead"], "left out unless picked, as DLC Builder leaves it null")
        fingered = _build(_spec([_track("Bass", BASS, [0, 3])], [{"track": 0, "kind": "bass", "tuning": BASS}]))[1]
        self.assertEqual(fingered["Bass"]["ArrangementProperties"]["bassPick"], 0)

    def test_difficulty_levels_are_made_unless_turned_off(self):
        tracks = [_track("Gtr", GUITAR, [0, 3, 5, 7, 5, 3, 0, 3, 5, 7, 8, 10])]
        arrangements = [{"track": 0, "kind": "lead", "tuning": GUITAR}]
        lead = _build(_spec(tracks, arrangements))[1]["Lead"]
        self.assertGreater(lead["MaxPhraseDifficulty"], 0)
        self.assertLess(lead["NotesEasy"], lead["NotesHard"])
        self.assertEqual(lead["NotesHard"], 12)
        self.assertAlmostEqual(lead["EasyMastery"], lead["NotesEasy"] / 12, places=9)
        flat = _build(_spec(tracks, arrangements, dynamicDifficulty=False))[1]["Lead"]
        self.assertEqual((flat["MaxPhraseDifficulty"], flat["NotesEasy"], flat["EasyMastery"]), (0, 12, 1.0))

    def test_phrases_with_fewer_levels_than_last_time_are_reported(self):
        tracks = [_track("Gtr", GUITAR, [0, 3, 5, 7, 5, 3, 0, 3, 5, 7, 8, 10])]
        arrangements = [{"track": 0, "kind": "lead", "tuning": GUITAR}]
        levels = {}
        builder.build_cdlc(_spec(tracks, arrangements), None, _wems=WEMS, _song_length=20.0, phrase_levels=levels)
        self.assertTrue(levels["lead"])
        name = next(n for n, top in levels["lead"].items() if top > 0)
        levels["lead"][name] += 3
        _, warnings, _ = builder.build_cdlc(_spec(tracks, arrangements), None, _wems=WEMS, _song_length=20.0,
                                            phrase_levels=levels)
        self.assertTrue(any("fewer difficulty levels" in w and name in w for w in warnings), warnings)
        _, warnings, _ = builder.build_cdlc(_spec(tracks, arrangements), None, _wems=WEMS, _song_length=20.0,
                                            phrase_levels=levels)
        self.assertFalse(any("fewer difficulty levels" in w for w in warnings), "compared with the last export")

    def test_the_author_is_the_one_given(self):
        def author(name):
            files = _build(_spec([_track("Gtr", GUITAR, [0, 3])], [{"track": 0, "kind": "lead", "tuning": GUITAR}],
                                 **({"author": name} if name is not None else {})))[0]
            return files["toolkit.version"].split(b"\n")[1]
        self.assertEqual(author("Ruslan Ñ"), "Package Author: Ruslan Ñ".encode())
        self.assertEqual(author("  two\nlines\x00 "), b"Package Author: two lines", "one line, no control characters")
        self.assertEqual(author(None), b"Package Author: ")
        self.assertEqual(author("x" * 200), b"Package Author: " + b"x" * 100)

    def test_chords_carry_the_names_the_editor_sent(self):
        # E5 on the two low strings, then the same grip with no name sent.
        def chord(start, **name):
            return [{"start": start, "end": start + 0.4, "pitch": p, "string": s, "fret": f, "hand": 1, "finger": g, **name}
                    for p, s, f, g in ((40, 6, 0, -1), (47, 5, 2, 1))]
        track = {"name": "Gtr", "tuning": GUITAR, "notes": chord(1.0, chordName="E5") + chord(2.0) + chord(3.0, chordName="Power ✓")}
        lead = _build(_spec([track], [{"track": 0, "kind": "lead", "tuning": GUITAR}]))[1]["Lead"]
        # One template per name; the unnamed one is in the SNG but, nameless, not listed.
        self.assertEqual(sorted(t["ChordName"] for t in lead["ChordTemplates"]), ["E5", "Power ✓"])

    def test_tone_switches_become_tone_slots(self):
        markers = [{"t": 0, "tone": "clean"}, {"t": 2.0, "tone": "lead"}, {"t": 3.0, "tone": "clean"}]
        tracks = [_track("Gtr", GUITAR, [0, 3], toneMarkers=markers)]
        lead = _build(_spec(tracks, [{"track": 0, "kind": "lead", "tuning": GUITAR}]))[1]["Lead"]
        self.assertTrue(lead["Tone_Base"].endswith("clean_tone"), lead["Tone_Base"])
        # Tone A is the base tone (id 0), as EOF writes it and the Toolkit requires.
        self.assertEqual(lead["Tone_A"], lead["Tone_Base"])
        self.assertTrue(lead["Tone_B"].endswith("lead_tone"), lead["Tone_B"])
        self.assertEqual(lead["Tone_C"], "")
        self.assertEqual(len(lead["Tones"]), 2)

    def test_custom_tone_parameters_reach_the_packaged_manifest(self):
        tone = manifest.load_internal_tone("lead", "ignored")
        tone["Name"] = "My solo"
        tone["GearList"]["Amp"]["KnobValues"]["Amp_MarshallPlexi_Bass"] = 23
        markers = [{"t": 0, "tone": "sound_solo", "toneData": tone}, {"t": 2, "tone": "clean"}]
        lead = _build(_spec([_track("Gtr", GUITAR, [0, 3], toneMarkers=markers)], [{"track": 0, "kind": "lead"}]))[1]["Lead"]
        custom = next(t for t in lead["Tones"] if t["Key"] == lead["Tone_Base"])
        self.assertEqual(custom["Name"], "My solo")
        self.assertEqual(custom["GearList"]["Amp"]["KnobValues"]["Amp_MarshallPlexi_Bass"], 23)

    def test_full_catalogue_rig_survives_the_psarc_manifest(self):
        def device(key):
            definition = gear_catalog()[key]
            return {"Key": key, "Type": definition["Type"], "KnobValues": {
                knob["Key"]: knob["DefaultValue"] for knob in definition.get("Knobs") or []}}
        tone = {"Name": "Native rig", "Volume": "-18.5", "NameSeparator": " - ",
                "ToneDescriptors": ["$[35724]LEAD", "$[35755]HIGH GAIN"],
                "GearList": {"Amp": device("Amp_MarshallJCM800"),
                             "Cabinet": device("Cab_Marshall1936_Ribbon_OffAxis"),
                             "Rack1": device("Rack_StudioCompressor"),
                             "PrePedal1": device("Pedal_MultiPitch")}}
        tone["GearList"]["Rack1"]["KnobValues"]["Rack_StudioCompressor_Ratio"] = 3
        tone["GearList"]["PrePedal1"]["KnobValues"]["Pedal_MultiPitch_Pitch1"] = -7.5
        markers = [{"t": 0, "tone": "sound_native", "toneData": tone}]
        lead = _build(_spec([_track("Gtr", GUITAR, [0, 3], toneMarkers=markers)], [{"track": 0, "kind": "lead"}]))[1]["Lead"]
        saved = next(tone for tone in lead["Tones"] if tone["Key"] == lead["Tone_Base"])
        self.assertEqual(saved["GearList"], tone["GearList"])
        self.assertEqual(saved["ToneDescriptors"], tone["ToneDescriptors"])
        self.assertEqual(float(saved["Volume"]), -18.5)

    def test_requests_the_game_cannot_load_are_refused(self):
        guitar, bass = _track("Gtr", GUITAR, [0]), _track("Bass", BASS, [0])
        lead = {"track": 0, "kind": "lead", "tuning": GUITAR}
        for tracks, arrangements, reason in (
            ([guitar, guitar], [lead, {**lead, "track": 1}], "unique"),
            ([guitar], [{"track": 0, "kind": "bass", "tuning": GUITAR}], "4-string bass"),
            ([bass], [{"track": 0, "kind": "lead", "tuning": BASS}], "6-string guitar"),
            ([guitar], [{**lead, "track": 5}], "unknown lane"),
            ([guitar], [{**lead, "kind": "banjo"}], "Unknown Rocksmith arrangement"),
            ([], [lead], "No lanes"),
        ):
            with self.subTest(reason), self.assertRaisesRegex(ValueError, reason):
                _build(_spec(tracks, arrangements))


def _chords(tuning, *grips, name="X"):
    """One chord per second; a grip lists frets from the lowest string up, None = unplayed."""
    n = len(tuning)
    notes = []
    for k, grip in enumerate(grips):
        fretted = [f for f in grip if f]
        for low, fret in enumerate(grip):
            if fret is not None:
                notes.append({"start": 1 + k, "end": 1.2 + k, "pitch": tuning[n - 1 - low] + fret,
                              "string": n - low, "fret": fret, "hand": min(fretted, default=1),
                              "chordName": name})
    return notes


def _properties(tuning, kind, *grips, name="X"):
    """(arrangement properties, manifest attributes) of one arrangement of these chords."""
    track = {"name": "L", "tuning": tuning, "notes": _chords(tuning, *grips, name=name)}
    _, songs, _, _ = _build(_spec([track], [{"track": 0, "kind": kind}]))
    attrs = next(iter(songs.values()))
    return attrs["ArrangementProperties"], attrs


class ArrangementPropertyTests(unittest.TestCase):
    """Chord properties as EOF writes them into the XML DLC Builder reads."""

    def test_power_chord_on_two_neighbouring_strings(self):
        props, _ = _properties(GUITAR, "lead", [0, 2, None, None, None, None])        # E5
        self.assertEqual((props["powerChords"], props["doubleStops"], props["barreChords"],
                          props["dropDPower"], props["openChords"]), (1, 1, 0, 0, 1))

    def test_power_chord_with_its_octave(self):
        props, _ = _properties(GUITAR, "lead", [3, 5, 5, None, None, None])           # G5 with octave
        self.assertEqual((props["powerChords"], props["doubleStops"]), (1, 0))

    def test_major_chord_is_no_power_chord(self):
        props, _ = _properties(GUITAR, "lead", [None, 3, 2, 0, 1, 0])                 # C
        self.assertEqual((props["powerChords"], props["barreChords"], props["openChords"]), (0, 0, 1))

    def test_barre_chord(self):
        props, _ = _properties(GUITAR, "lead", [1, 3, 3, 2, 1, 1])                    # F barre
        self.assertEqual(props["barreChords"], 1)

    def test_open_string_after_the_barre_fret_is_no_barre(self):
        props, _ = _properties(GUITAR, "lead", [2, 0, 4, 4, 2, None])
        self.assertEqual(props["barreChords"], 0)

    def test_drop_d_power_chord(self):
        props, attrs = _properties(DROP_D, "lead", [0, 0, 0, None, None, None])       # D5 in drop D
        self.assertEqual((props["powerChords"], props["dropDPower"]), (1, 1))
        self.assertEqual(attrs["Tuning"]["string0"], -2)

    def test_unnamed_chord_is_non_standard(self):
        props, _ = _properties(GUITAR, "lead", [None, 3, 2, 0, 1, 0], name="")
        self.assertEqual(props["nonStandardChords"], 1)
        props, _ = _properties(GUITAR, "lead", [None, 3, 2, 0, 1, 0], name="C")
        self.assertEqual(props["nonStandardChords"], 0)

    def test_bass_reports_octaves_and_double_stops_as_fifths_and_octaves(self):
        props, _ = _properties(BASS, "bass", [3, None, 5, None])                      # G octave
        self.assertEqual((props["fifthsAndOctaves"], props["doubleStops"]), (1, 0))
        props, _ = _properties(BASS, "bass", [3, 5, None, None])                      # G5 double stop
        self.assertEqual((props["fifthsAndOctaves"], props["doubleStops"]), (1, 0))

    def test_difficulty_counts_as_dlc_builder(self):
        """Barre (3) and nothing else; at most 5 gets 4 more, as calculateDifficulties does."""
        props, attrs = _properties(GUITAR, "lead", [1, 3, 3, 2, 1, 1], [1, 3, 3, 2, 1, 1])
        self.assertEqual([k for k, v in props.items() if v and not k.startswith(("represent", "path", "route", "standard"))],
                         ["barreChords"])
        self.assertAlmostEqual(attrs["SongDiffHard"], round(7 * 2 / attrs["SongLength"] / 100, 9), places=6)


class TechniqueMapTests(unittest.TestCase):
    """createTechniqueMap / Techniques.fs: technique ids per phrase iteration."""

    def _map(self, notes, tuning=GUITAR):
        _, songs, _, _ = _build(_spec([{"name": "L", "tuning": tuning, "notes": notes}], [{"track": 0, "kind": "lead"}]))
        return songs["Lead"]["Techniques"]

    def test_techniques_of_notes_and_chords(self):
        g = lambda start, string, fret, **fx: {"start": start, "end": start + 0.2, "pitch": GUITAR[string - 1] + fret,
                                               "string": string, "fret": fret, "hand": 1, **fx}
        barre = [g(4.0, 6 - i, f, finger=n, chordName="F") for i, (f, n) in enumerate(zip([1, 3, 3, 2, 1, 1], [1, 3, 4, 2, 1, 1]))]
        notes = [g(1.0, 3, 5, fx={"palmMute": True}), g(1.5, 3, 7, fx={"hammer": True}),
                 g(2.0, 2, 8, bend="full"), g(3.0, 6, 3, chordName="G5"), g(3.0, 5, 5, chordName="G5"), *barre]
        techniques = self._map(notes)
        top = str(len(techniques) - 1)   # one map per level; the hardest has every note
        self.assertEqual(list(techniques), [str(k) for k in range(len(techniques))])
        ids = set().union(*techniques[top].values())
        # 7 palm mute, 3 + 6 hammer-on, 1 bend, 35 power chord, 37 barre, 38 chord
        self.assertTrue({1, 3, 6, 7, 35, 37, 38} <= ids, ids)
        self.assertNotIn(33, ids, "a power chord is not counted as a double stop too")
        self.assertTrue(all(v == sorted(v) for v in techniques[top].values()))

    def test_a_note_on_a_phrase_start_counts_for_the_phrase_before(self):
        """DLC Builder's division: start < time <= end, and the last phrase is left out."""
        pis = [sng.PhraseIteration(0, 0.0, 1.0), sng.PhraseIteration(1, 1.0, 5.0), sng.PhraseIteration(2, 5.0, 6.0)]
        notes = [sng.Note(mask=sng.SINGLE | sng.PALMMUTE, time=t) for t in (1.0, 3.0)]
        notes += [sng.Note(mask=sng.SINGLE | sng.TAP, time=t) for t in (5.0, 5.5)]
        song = sng.SNG(phrase_iterations=pis, levels=[sng.Level(notes=notes)])
        self.assertEqual(manifest._technique_map(song), {"0": {"0": [7], "1": [7, 14]}})


class ShowlightTests(unittest.TestCase):
    """ShowLightGenerator: fog per section name, beams by pitch, lasers, a last fog."""

    def test_showlights_as_dlc_builder_makes_them(self):
        import re
        spec = _spec([_track("B", BASS, [0, 3]), _track("G", GUITAR, [0, 3, 5, 0, 0, 2])],
                     [{"track": 0, "kind": "bass"}, {"track": 1, "kind": "lead"}])
        spec["sections"] = [{"t": 1, "sectionType": "verse"}, {"t": 5, "sectionType": "solo"},
                            {"t": 9, "sectionType": "verse"}]
        files, songs, _, _ = _build(spec)
        xml = next(b for p, b in files.items() if p.endswith("showlights.xml")).decode()
        # Times in seconds with three decimals, as DLC Builder writes them.
        self.assertFalse(re.search(r'time="\d+"', xml), "a time without decimals is read as seconds")
        lights = [(int(s) * 1000 + int(ms), int(n)) for s, ms, n in re.findall(r'time="(\d+)\.(\d{3})" note="(\d+)"', xml)]
        self.assertTrue(lights)
        self.assertIn(f'count="{len(lights)}"', xml)
        self.assertEqual(lights, sorted(lights, key=lambda light: light[0]))
        fogs = [n for _, n in lights if 24 <= n <= 35]
        beams = [(t, n) for t, n in lights if 48 <= n <= 59]
        # The Lead's notes, not the Bass listed first: E G A E E F# on the low E string;
        # the repeated E gets no new beam.
        self.assertEqual([n for _, n in beams], [52, 55, 57, 52, 54])
        self.assertTrue(all(b - a >= 350 for (a, _), (b, _) in zip(beams, beams[1:])))
        self.assertEqual(fogs[0], fogs[2], "both verses share a fog colour")
        self.assertNotEqual(fogs[0], fogs[1])
        length = round(songs["Lead"]["SongLength"] * 1000)
        solo = next(t for t, n in lights if 24 <= n <= 35 and n == fogs[1])
        self.assertIn((solo, 67), lights, "lasers on at the solo")
        self.assertIn((length - 5000, 66), lights, "lasers off 5 s before the end")
        self.assertEqual(lights[-1], (length, 35), "a last fog at the end")
        files2, _, _, _ = _build(spec)
        self.assertEqual(xml.encode(), next(b for p, b in files2.items() if p.endswith("showlights.xml")),
                         "the same song gets the same lights")


class ContainerTests(unittest.TestCase):
    def test_archive_returns_what_was_put_in(self):
        # Larger than one compression block, incompressible, and tiny.
        entries = [("big/random.bin", os.urandom(300_000)), ("zeros.bin", bytes(200_000)), ("small.txt", b"x")]
        self.assertEqual(read_psarc(build_psarc(entries)), dict(entries))

    def test_packed_arrangement_unpacks_to_the_same_bytes(self):
        plain = os.urandom(5000) + bytes(5000)
        self.assertEqual(sng.unpack(sng.pack(plain)), plain)


if __name__ == "__main__":
    unittest.main()
