"""Names the game's fonts cannot show go out as their Latin spelling."""
import json
import re
import unittest
from pathlib import Path

from rs_studio.rocksmith import builder, font
from rs_studio.rocksmith.psarc import read_psarc

ROOT = Path(__file__).resolve().parents[1]


def _names(metadata):
    spec = {"metadata": {"title": "Song", "artist": "Band", "album": "LP", "year": "2020", **metadata},
            "grid": {"bpm": 120, "offset": 0.0, "tsNum": 4, "tsDen": 4},
            "tracks": [{"name": "G", "tuning": [64, 59, 55, 50, 45, 40],
                        "notes": [{"start": 1, "end": 1.4, "pitch": 40, "string": 6, "fret": 0, "hand": 1}]}],
            "rocksmith": {"arrangements": [{"track": 0, "kind": "lead"}]}}
    data, warnings, name = builder.build_cdlc(spec, None, _wems=(b"a", b"b"), _song_length=20.0)
    attrs = next(next(iter(json.loads(b)["Entries"].values()))["Attributes"]
                 for p, b in read_psarc(data).items() if p.endswith(".json"))
    return attrs, warnings, name


class GameFontTests(unittest.TestCase):
    def test_the_editor_has_the_same_list(self):
        js = (ROOT / "web/game-font.js").read_text("utf-8")
        listed = json.loads(re.search(r'new Set\(("(?:[^"\\]|\\.)*")\);', js).group(1))
        self.assertEqual(frozenset(listed), font.GAME_FONT)
        self.assertEqual(len(font.GAME_FONT), 3419)

    def test_a_name_the_fonts_cannot_show_goes_out_as_its_latin_spelling(self):
        attrs, warnings, name = _names({"artist": "Кино", "artistLatin": "Kino", "title": "Dvořák", "titleLatin": "Dvorak"})
        self.assertEqual((attrs["ArtistName"], attrs["SongName"]), ("Kino", "Dvorak"))
        self.assertEqual((attrs["ArtistNameSort"], attrs["SongNameSort"]), ("Kino", "Dvorak"))
        self.assertEqual(name, "Kino_Dvorak_v1_p.psarc")
        self.assertFalse([w for w in warnings if "cannot show" in w])

    def test_japanese_is_shown_as_written(self):
        attrs, _, _ = _names({"title": "伊根", "titleLatin": "Ine", "artist": "Don’t Band"})
        self.assertEqual((attrs["SongName"], attrs["SongNameSort"], attrs["ArtistName"]), ("伊根", "Ine", "Don’t Band"))

    def test_without_a_latin_spelling_the_missing_characters_are_left_out(self):
        attrs, warnings, _ = _names({"title": "Dvořák Live"})
        self.assertEqual(attrs["SongName"], "Dvoák Live")
        self.assertIn("Rocksmith cannot show ř in the title; left out", warnings)

    def test_the_key_stays_made_from_the_name(self):
        """Shown names change nothing about ids: a song already in the game keeps them."""
        attrs, _, _ = _names({"artist": "Кино", "artistLatin": "Kino", "title": "Song"})
        self.assertEqual(attrs["DLCKey"], builder._dlc_key("Кино", "Song"))


if __name__ == "__main__":
    unittest.main()
