"""DLC Builder's project folder for an exported package (rocksmith/project_files.py)."""
import json
import unittest
import uuid
import xml.etree.ElementTree as ET

from rs_studio.rocksmith import arrangement_xml as ax
from rs_studio.rocksmith import builder
from rs_studio.rocksmith.project_files import _json, file_name
from rs_studio.rocksmith.psarc import read_psarc
from tests.test_rocksmith_package import BASS, DROP_D, WEMS, _spec, _track


def _export(**rocksmith):
    spec = _spec([_track("Gtr", DROP_D, [0, 3, 5, 7]), _track("Bass", BASS, [0, 3, 5])],
                 [{"track": 0, "kind": "lead", "tuning": DROP_D}, {"track": 1, "kind": "bass", "tuning": BASS}],
                 leadingSilence=12, version=4, **rocksmith)
    files = {}
    data, _, _ = builder.build_cdlc(spec, None, _wems=WEMS, _song_length=20.0, project_files=files)
    return files, read_psarc(data)


class ProjectFilesTests(unittest.TestCase):
    def test_the_folder_holds_what_dlc_builders_import_writes(self):
        files, package = _export(author="Charter")
        key = next(p for p in package if p.endswith(".xblock")).rsplit("/", 1)[1].removesuffix(".xblock")
        self.assertEqual(sorted(files), sorted(["cover.dds", "arr_showlights_RS2.xml", "arr_lead_RS2.xml",
                                                "arr_bass_RS2.xml", f"{key}.wem", f"{key}_preview.wem",
                                                ".phrase-levels", "Band_Song.rs2dlc"]))
        # Copied as the package carries them.
        self.assertEqual(files["cover.dds"], package[f"gfxassets/album_art/album_{key}_256.dds"])
        self.assertEqual(files["arr_showlights_RS2.xml"], package[f"songs/arr/{key}_showlights.xml"])
        self.assertEqual((files[f"{key}.wem"], files[f"{key}_preview.wem"]), WEMS)

    def test_the_arrangement_xml_carries_the_chart(self):
        files, package = _export()
        lead = ET.fromstring(files["arr_lead_RS2.xml"])
        self.assertEqual(lead.tag, "song")
        self.assertEqual(lead.get("version"), "8")
        self.assertEqual(lead.findtext("arrangement"), "Lead")
        self.assertEqual((lead.findtext("title"), lead.findtext("artistName"), lead.findtext("albumYear")), ("Song", "Band", "2020"))
        self.assertEqual(lead.find("tuning").get("string0"), "-2")
        levels = lead.find("levels").findall("level")
        hardest = levels[-1].find("notes").findall("note")
        self.assertEqual([n.get("fret") for n in hardest], ["0", "3", "5", "7"])
        self.assertEqual(int(lead.find("levels").get("count")), len(levels))
        self.assertEqual(lead.find("phraseIterations").get("count"), str(len(lead.find("phraseIterations"))))
        # Windows line ends and no BOM, as DLC Builder's XmlWriter writes them.
        self.assertTrue(files["arr_lead_RS2.xml"].startswith(b'<?xml version="1.0" encoding="utf-8"?>\r\n<song version="8">'))

    def test_the_project_file_points_at_the_folder(self):
        files, package = _export(author="Charter")
        project = json.loads(files["Band_Song.rs2dlc"])
        self.assertEqual((project["Version"], project["Author"], project["Year"]), ("4", "Charter", 2020))
        self.assertEqual(project["Title"], {"Value": "Song", "SortValue": "Song"})
        self.assertEqual(project["AlbumArtFile"], "cover.dds")
        arrangements = project["Arrangements"]
        self.assertEqual([a["Case"] for a in arrangements], ["Instrumental", "Instrumental", "Showlights"])
        lead, bass = (a["Fields"][0] for a in arrangements[:2])
        self.assertEqual((lead["XML"], lead["Name"], lead["RouteMask"], lead["Priority"]), ("arr_lead_RS2.xml", 0, 1, 0))
        self.assertEqual((bass["XML"], bass["Name"], bass["RouteMask"]), ("arr_bass_RS2.xml", 3, 4))
        self.assertEqual(lead["Tuning"], [-2, 0, 0, 0, 0, 0])
        manifest = json.loads(next(b for p, b in package.items() if p.endswith("_lead.json")))
        attrs = next(iter(manifest["Entries"].values()))["Attributes"]
        self.assertEqual(uuid.UUID(lead["PersistentID"]), uuid.UUID(attrs["PersistentID"]))
        self.assertEqual(lead["MasterID"], attrs["MasterID_RDV"])
        levels = json.loads(files[".phrase-levels"])
        self.assertIn(lead["PersistentID"], levels)
        self.assertNotIn("Author", json.loads(_export()[0]["Band_Song.rs2dlc"]), "no author, no field")

    def test_numbers_and_text_are_written_as_dotnet_writes_them(self):
        self.assertEqual([ax._time(t) for t in (0, 5, 42, 999, 1000, 123456)],
                         ["0.000", "0.005", "0.042", "0.999", "1.000", "123.456"])
        self.assertEqual(ax._ms(1.0005), 1000, "through float32, then ties to even")
        self.assertEqual([ax._float(v) for v in (0, 1.0, -31.6, 0.5)], ["0", "1", "-31.6", "0.5"])
        self.assertEqual(_json({"a": [], "b": {}, "c": -7.0, "d": 1.3, "e": "é<'"}, None),
                         '{"a":[],"b":{},"c":-7,"d":1.3,"e":"\\u00E9\\u003C\\u0027"}')
        self.assertEqual(file_name("Beyoncé & The  Band"), "Beyonce-The-Band")


if __name__ == "__main__":
    unittest.main()
