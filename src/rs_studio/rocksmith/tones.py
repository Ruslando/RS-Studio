"""Native Rocksmith tone validation against the pinned DLC Builder gear catalogue."""
from __future__ import annotations

from functools import lru_cache
from importlib import resources
import json
import math
import re


@lru_cache(maxsize=1)
def tone_catalog() -> dict:
    return json.loads(resources.files(__package__).joinpath("res", "tone-gear.json").read_text("utf-8"))


@lru_cache(maxsize=1)
def gear_catalog() -> dict:
    return {gear["Key"]: gear for gear in tone_catalog()["Gear"]}


def knob_range(key: str, device_key: str) -> tuple[float, float]:
    knob = next(knob for knob in gear_catalog()[device_key].get("Knobs", []) if knob["Key"] == key)
    return knob["MinValue"], knob["MaxValue"]


def custom_tone(raw: dict, key: str) -> dict:
    """Validate without clamping, guessing defaults, or discarding unknown knobs."""
    def fail(reason):
        raise ValueError(f"Invalid custom sound preset: {reason}")

    if not isinstance(raw, dict) or not isinstance(raw.get("GearList"), dict):
        fail("missing gear list")
    name = raw.get("Name")
    if not isinstance(name, str) or not name.strip() or len(name) > 80:
        fail("name must contain 1–80 characters")

    def volume_value(value, label):
        if isinstance(value, bool) or value is None:
            fail(f"invalid {label}")
        try:
            number = float(value)
        except (ValueError, TypeError):
            fail(f"invalid {label}")
        if not math.isfinite(number) or not -36 <= number <= 12:
            fail(f"{label} is out of range")
        return str(number)

    volume = volume_value(raw.get("Volume"), "volume")
    gear = {}
    for slot, device in raw["GearList"].items():
        if not isinstance(slot, str) or not re.fullmatch(r"Amp|Cabinet|PrePedal[1-4]|PostPedal[1-4]|Rack[1-4]", slot) or not isinstance(device, dict):
            fail("unknown gear slot")
        device_key = device.get("Key")
        definition = gear_catalog().get(device_key) if isinstance(device_key, str) else None
        expected_type = "Amps" if slot == "Amp" else "Cabinets" if slot == "Cabinet" else "Racks" if slot.startswith("Rack") else "Pedals"
        if definition is None or definition["Type"] != expected_type:
            fail(f"unknown or misplaced device in {slot}")
        values = device.get("KnobValues")
        definitions = definition.get("Knobs") or []
        if not isinstance(values, dict) or set(values) != {knob["Key"] for knob in definitions}:
            fail(f"missing or unknown parameters in {slot}")
        knobs = {}
        for knob in definitions:
            value = values[knob["Key"]]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                fail(f"{definition['Name']}: invalid {knob['Name']}")
            if not knob["MinValue"] <= value <= knob["MaxValue"] or (knob.get("EnumValues") and value != int(value)):
                fail(f"{definition['Name']}: {knob['Name']} must be within {knob['MinValue']}…{knob['MaxValue']}")
            knobs[knob["Key"]] = value
        gear[slot] = {"Key": definition["Key"], "Type": definition["Type"], "KnobValues": knobs}
        for optional in ("Category", "Skin"):
            if isinstance(device.get(optional), str):
                gear[slot][optional] = device[optional]
        skin_index = device.get("SkinIndex")
        if isinstance(skin_index, (int, float)) and not isinstance(skin_index, bool) and math.isfinite(skin_index):
            gear[slot]["SkinIndex"] = skin_index
    if "Amp" not in gear or "Cabinet" not in gear:
        fail("an amplifier and cabinet are required")
    if len(gear) > 6:
        fail("Rocksmith Tone Designer supports at most four effects")
    for prefix in ("PrePedal", "PostPedal", "Rack"):
        indices = sorted(int(slot[-1]) for slot in gear if slot.startswith(prefix))
        if indices != list(range(1, len(indices) + 1)):
            fail(f"gaps between {prefix} slots")
    descriptors = {entry["UIName"] for entry in tone_catalog()["Descriptors"]}
    description = raw.get("ToneDescriptors")
    if not isinstance(description, list) or not 1 <= len(description) <= 3 or any(not isinstance(value, str) or value not in descriptors for value in description):
        fail("choose one to three valid tone descriptions")
    result = {"GearList": gear, "Name": name.strip(), "Key": key, "Volume": volume,
              "ToneDescriptors": list(description),
              "NameSeparator": raw.get("NameSeparator") if isinstance(raw.get("NameSeparator"), str) else " - "}
    if raw.get("MacVolume") is not None:
        result["MacVolume"] = volume_value(raw["MacVolume"], "Mac volume")
    return result
