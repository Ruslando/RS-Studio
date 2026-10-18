import json
from pathlib import Path
import tempfile
import unittest

from rs_studio.sound_presets import decode_presets, read_preset_folder, MAX_PRESET_BYTES

DEFAULTS = Path(__file__).resolve().parents[1] / "presets" / "sounds"


class SoundPresetFilesTests(unittest.TestCase):
    def test_six_defaults_validate_and_preserve_native_settings(self):
        files = list(DEFAULTS.glob("*.json"))
        self.assertEqual(len(files), 6)
        for path in files:
            with self.subTest(path=path.name):
                raw = json.loads(path.read_text("utf-8-sig"))
                tone, = decode_presets(path.read_bytes())
                self.assertEqual(tone["GearList"], raw["GearList"])
                self.assertEqual(float(tone["Volume"]), float(raw["Volume"]))

    def test_seed_reload_and_removed_defaults_do_not_overwrite_user_files(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory) / "presets"
            first = read_preset_folder(folder, DEFAULTS)
            self.assertEqual(len(first["presets"]), 6)
            clean = folder / "guitar-clean.json"
            raw = json.loads(clean.read_text("utf-8-sig")); raw["Name"] = "My replacement"
            clean.write_text(json.dumps(raw), encoding="utf-8")
            (folder / "bass-crunch.json").unlink()
            (folder / "extra.JSON").write_text(json.dumps(raw), encoding="utf-8")
            (folder / "broken.json").write_text("not json", encoding="utf-8")
            (folder / "not-a-tone.psarc").write_bytes(b"not read")
            again = read_preset_folder(folder, DEFAULTS)
            self.assertEqual(len(again["presets"]), 6)
            self.assertEqual(again["errors"][0]["file"], "broken.json")
            self.assertEqual(next(p for p in again["presets"] if p["file"] == clean.name)["tone"]["Name"], "My replacement")
            self.assertFalse((folder / "bass-crunch.json").exists())

    def test_libraries_and_arrays_validate_atomically(self):
        tone = json.loads((DEFAULTS / "guitar-clean.json").read_text("utf-8-sig"))
        for data in ([tone, tone], {"format": "rs-studio.sound-presets", "version": 1, "presets": [tone, tone]}):
            self.assertEqual(len(decode_presets(json.dumps(data).encode())), 2)
        for data in ([tone, {}], [], {"format": "rs-studio.sound-presets", "version": 9, "presets": [tone]}):
            with self.assertRaises(ValueError):
                decode_presets(json.dumps(data).encode())
        with self.assertRaisesRegex(ValueError, "1 MiB"):
            decode_presets(b" " * (MAX_PRESET_BYTES + 1))

    def test_folder_library_entries_have_unique_stable_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            tone = json.loads((DEFAULTS / "guitar-clean.json").read_text("utf-8-sig"))
            (folder / "library.json").write_text(json.dumps([tone, tone]), encoding="utf-8")
            result = read_preset_folder(folder, folder)
            self.assertEqual([p["id"] for p in result["presets"]], ["file:library.json:1", "file:library.json:2"])
