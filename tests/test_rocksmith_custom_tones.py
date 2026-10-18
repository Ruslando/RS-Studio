import copy
import json
from pathlib import Path
import unittest

from rs_studio.rocksmith import builder, manifest
from rs_studio.rocksmith.tones import custom_tone, tone_catalog


class CustomToneTests(unittest.TestCase):
    def test_frontend_and_export_use_the_same_pinned_native_catalogue(self):
        source = (Path(__file__).resolve().parents[1] / "web/tone-gear.js").read_text(encoding="utf-8")
        frontend = json.loads(source.split("export const TONE_CATALOG = ", 1)[1].strip().removesuffix(";"))
        self.assertEqual(frontend, tone_catalog())
        self.assertEqual(len(frontend["Gear"]), 613)
        self.assertEqual(len(frontend["Descriptors"]), 32)

    def test_every_device_defaults_and_endpoints_validate_for_native_export(self):
        slots = {"Amps": "Amp", "Cabinets": "Cabinet", "Pedals": "PrePedal1", "Racks": "Rack1"}
        for definition in tone_catalog()["Gear"]:
            for field in ("DefaultValue", "MinValue", "MaxValue"):
                with self.subTest(device=definition["Key"], field=field):
                    tone = manifest.load_internal_tone("clean", "test")
                    slot = slots[definition["Type"]]
                    tone["GearList"][slot] = {"Key": definition["Key"], "Type": definition["Type"],
                                             "KnobValues": {knob["Key"]: knob[field] for knob in definition.get("Knobs") or []}}
                    normalized = custom_tone(tone, "test")
                    self.assertEqual(normalized["GearList"][slot]["KnobValues"], tone["GearList"][slot]["KnobValues"])

    def test_unknown_knobs_and_fractional_switch_positions_are_rejected(self):
        tone = manifest.load_internal_tone("bass", "test")
        tone["GearList"]["Rack1"]["KnobValues"]["Rack_StudioCompressor_Ratio"] = 1.5
        with self.assertRaisesRegex(ValueError, "Ratio"):
            custom_tone(tone, "test")
        tone = manifest.load_internal_tone("clean", "test")
        tone["GearList"]["Amp"]["KnobValues"]["Unknown"] = 1
        with self.assertRaisesRegex(ValueError, "unknown parameters"):
            custom_tone(tone, "test")

    def test_all_starting_points_are_accepted(self):
        for name in ("clean", "crunch", "lead", "bass"):
            with self.subTest(name=name):
                self.assertEqual(custom_tone(manifest.load_internal_tone(name, name), "key")["Key"], "key")

    def test_export_preserves_parameters_and_distinct_versions_of_one_preset(self):
        original = manifest.load_internal_tone("lead", "custom")
        original["Name"] = "My solo"
        changed = copy.deepcopy(original)
        changed["GearList"]["Amp"]["KnobValues"]["Amp_MarshallPlexi_Loudness1"] = 30
        track = {"toneMarkers": [
            {"t": 0, "tone": "sound_test", "toneData": original},
            {"t": 5, "tone": "sound_test", "toneData": changed},
            {"t": 10, "tone": "sound_test", "toneData": original},
        ]}
        warnings = []
        base, slots, events = builder._arrangement_tones(track, False, "song", "lead", 30, warnings)
        self.assertEqual(base["Name"], "My solo")
        self.assertEqual(len(slots), 2)
        self.assertNotEqual(base["Key"], slots[0]["Key"])
        self.assertEqual(slots[0]["GearList"]["Amp"]["KnobValues"]["Amp_MarshallPlexi_Loudness1"], 30)
        self.assertEqual(events, [(5, 0), (10, 1)])
        self.assertEqual(original["Key"], "custom")
        self.assertEqual(warnings, [])

    def test_invalid_snapshot_fails_export_instead_of_falling_back(self):
        invalid = manifest.load_internal_tone("clean", "custom")
        invalid["GearList"]["Amp"]["KnobValues"]["Amp_MarshallPlexi_Bass"] = float("nan")
        with self.assertRaisesRegex(ValueError, "Invalid custom sound"):
            builder._arrangement_tones({"toneMarkers": [{"t": 0, "tone": "sound_bad", "toneData": invalid}]}, False, "song", "lead", 30, [])

    def test_more_than_four_switchable_snapshots_are_rejected(self):
        markers = []
        for i in range(6):
            tone = manifest.load_internal_tone("clean", "custom")
            tone["Name"] = f"Sound {i}"
            markers.append({"t": i, "tone": f"sound_{i}", "toneData": tone})
        with self.assertRaisesRegex(ValueError, "four switchable"):
            builder._arrangement_tones({"toneMarkers": markers}, False, "song", "lead", 30, [])
