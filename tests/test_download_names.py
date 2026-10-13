import unittest
import urllib.parse

from starlette.responses import Response

from rs_studio.rocksmith.builder import _cdlc_filename, _package_version
from rs_studio.server import _attachment


class DownloadNameTests(unittest.TestCase):
    def test_non_latin_title_survives_the_header(self):
        name = "_トーテム-_-IA_v1_p.psarc"
        header = _attachment(name)
        # Starlette encodes headers as Latin-1; this raised UnicodeEncodeError before.
        Response(b"psarc", headers={"Content-Disposition": header})
        encoded = header.split("filename*=UTF-8''", 1)[1]
        self.assertEqual(urllib.parse.unquote(encoded), name)
        self.assertIn('filename="_', header)  # ASCII fallback for old clients

    def test_plain_name_is_unchanged(self):
        self.assertTrue(_attachment("Artist_Song_v1_p.psarc").startswith('attachment; filename="Artist_Song_v1_p.psarc"'))

    def test_export_version_reaches_the_file_name(self):
        self.assertEqual(_cdlc_filename("Artist", "Song", "k"), "Artist_Song_v1_p.psarc")
        self.assertEqual(_cdlc_filename("Artist", "Song", "k", 12), "Artist_Song_v12_p.psarc")
        self.assertEqual(_package_version({"rocksmith": {"version": 3}}), 3)
        for bad in (0, -2, 1.5, "4", True, None):   # only a positive whole number counts
            self.assertEqual(_package_version({"rocksmith": {"version": bad}}), 1)
        self.assertEqual(_package_version({}), 1)


if __name__ == "__main__":
    unittest.main()
