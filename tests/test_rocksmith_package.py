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
    notes = [{"start": 1 + i * 0.5, "end": 1.4 + i * 0.5, "pitch": tuning[-1] + fret, "string": low, "fret": fret}
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
                     leadingSilence=5, version=4)
        files, songs, warnings, name = _build(spec)
        self.assertEqual(warnings, [])
        self.assertEqual(name, "Band_Song_v4_p.psarc")
        self.assertIn(b"Package Version: 4\n", files["toolkit.version"])
        self.assertEqual(sorted(songs), ["Bass", "Lead"])
        lead, bass = songs["Lead"], songs["Bass"]
        self.assertEqual((lead["SongName"], lead["ArtistName"], lead["AlbumName"], lead["SongYear"]), ("Song", "Band", "LP", 2020))
        self.assertEqual((lead["NotesHard"], bass["NotesHard"]), (4, 3))
        self.assertEqual(lead["SongLength"], 25.0, "20 s of audio behind 5 s of silence")
        self.assertEqual(lead["Tuning"]["string0"], -2, "the low string is tuned down to D")
        self.assertEqual(set(bass["Tuning"].values()), {0})
        self.assertNotIn("CapoFret", lead)
        # Both audio files are in, under the ids their sound banks point at.
        wems = sorted(blob for path, blob in files.items() if path.endswith(".wem"))
        self.assertEqual(wems, sorted(WEMS))
        for path, blob in files.items():
            if path.endswith(".sng"):
                self.assertGreater(len(sng.unpack(blob)), len(blob), path)

    def test_capo_chosen_for_the_export_replaces_the_layers_own(self):
        tracks = [_track("Gtr", GUITAR, [0, 3], capo=2)]
        own = _build(_spec(tracks, [{"track": 0, "kind": "lead", "tuning": GUITAR}]))[1]["Lead"]
        self.assertEqual(own["CapoFret"], 2)
        chosen = _build(_spec(tracks, [{"track": 0, "kind": "lead", "tuning": GUITAR, "capo": 4}]))[1]["Lead"]
        self.assertEqual(chosen["CapoFret"], 4)
        removed = _build(_spec(tracks, [{"track": 0, "kind": "lead", "tuning": GUITAR, "capo": 0}]))[1]["Lead"]
        self.assertNotIn("CapoFret", removed)

    def test_tone_switches_become_tone_slots(self):
        markers = [{"t": 0, "tone": "clean"}, {"t": 2.0, "tone": "lead"}, {"t": 3.0, "tone": "clean"}]
        tracks = [_track("Gtr", GUITAR, [0, 3], toneMarkers=markers)]
        lead = _build(_spec(tracks, [{"track": 0, "kind": "lead", "tuning": GUITAR}]))[1]["Lead"]
        self.assertTrue(lead["Tone_Base"].endswith("clean_tone"), lead["Tone_Base"])
        self.assertTrue(lead["Tone_A"].endswith("lead_tone"), lead["Tone_A"])
        # Going back to the first tone is a switch like any other: it takes a slot.
        self.assertTrue(lead["Tone_B"].endswith("clean_tone"), lead["Tone_B"])
        self.assertEqual(lead["Tone_C"], "")

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
