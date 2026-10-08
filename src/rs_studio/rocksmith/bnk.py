"""Wwise soundbank (.bnk) generator, ported from Rocksmith2014.NET SoundBank.fs.

Little-endian (PC). Chunks: BKHD, DIDX, DATA (wem prefetch), HIRC (sound ->
actor mixer -> play action -> event), STID. The returned file id names the
.wem inside the psarc (audio/windows/<id>.wem).
"""
from __future__ import annotations

import struct


# Wwise's own 32-bit FNV-1 over the lowercased name. Every id in a soundbank is
# one of these, which is how a bank and the game agree on an object without
# either storing the name: hash "Play_MySong" on both sides, get the same number.
def fnv_hash(s: str) -> int:
    h = 2166136261
    for ch in s.lower():
        h = ((h * 16777619) & 0xFFFFFFFF) ^ ord(ch)
    return h


# Wwise ids only have to be unique within a bank and consistent between the
# objects that reference each other; Wwise itself derives them from names this
# way, which is why `file_id` below is already an fnv_hash. The other four were
# drawn at random, which meant no two builds of the same song were ever alike
# (R2) and the exporter could not be tested by building twice and diffing.
def _bnk_id(*parts: str) -> int:
    return fnv_hash("|".join(parts)) & 0x7FFFFFFF or 1


# A bank is a flat sequence of length-prefixed chunks: BKHD (header), DIDX
# (which wems are in it), DATA (their bytes), HIRC (the object graph), STID (the
# bank's own name). Nothing nests; every chunk is `name + int32 length + body`.
def _chunk(name: bytes, data: bytes) -> bytes:
    return name + struct.pack("<i", len(data)) + data


# Inside HIRC, each object is `type byte + int32 length + body`. The four types
# this file writes are 2=Sound, 7=ActorMixer, 3=Action, 4=Event, and they form a
# chain: the Event names an Action, the Action names a Sound, the Sound names an
# ActorMixer for its bus routing and a file id for its audio.
def _hierarchy_obj(type_id: int, body: bytes) -> bytes:
    return struct.pack("<bi", type_id, len(body)) + body


# The Sound object. Almost every field here is a Wwise default we have no reason
# to change; the ones that matter are the ids, the volume, and the handful that
# differ for the 30-second preview clip. The magic numbers are transcribed from
# Rocksmith2014.NET's SoundBank.fs — they are what the game's Wwise runtime
# expects, and there is no independent meaning to recover for most of them.
def _sound(sound_id, file_id, mixer_id, bus_id, volume, is_preview) -> bytes:
    return struct.pack(
        "<IIII I bbb III I bbb b bbb fii bbbbbb bb b h bbbb ihi",
        sound_id, 262145, 2, file_id,       # id, plugin (vorbis), streamed
        file_id,                            # source id
        0, 0, 0,                            # sfx, override parent, numFX
        bus_id, 65536,                      # parent bus, direct parent
        4178100890 if is_preview else 0,
        mixer_id,
        0, 0, 0,                            # priority overrides, midi
        3,                                  # param count
        0, 46, 47,                          # param types: volume, -, -
        volume, 1, 3,
        0, 0, 0, 0, 0, 0,                   # ranges, position, aux
        1, 1 if is_preview else 0,          # virtual queue, kill newest
        0,                                  # use virtual behavior
        1 if is_preview else 0,             # max instances
        0, 0,
        1 if is_preview else 0, 0,          # max-inst override, virtual-voice
        0, 0, 0,                            # state groups, rtpc, feedback bus
    )


def _actor_mixer(mixer_id, sound_id) -> bytes:
    return struct.pack(
        "<I bb IIII bb bb bbbbb bbb h bbbb ih ii",
        mixer_id, 0, 0,
        2616261673, 0, 0, 65792,
        0, 0,                               # priority
        0, 0,                               # numParam, numRange
        0, 0, 0, 0, 0,                      # position/aux
        0, 0, 0,                            # virtual queue, kill newest, virtual behavior
        0,                                  # max instances
        0, 0, 0, 0,
        0, 0,                               # state groups, rtpc
        1, sound_id,                        # one child
    )


def _action(action_id, sound_id, bank_id) -> bytes:
    return struct.pack("<Ibbibbbb I", action_id, 3, 4, sound_id, 0, 0, 0, 4, bank_id)


def generate(name: str, wem: bytes, volume: float, is_preview: bool) -> tuple[bytes, int]:
    """Build the .bnk for `name` (e.g. "MyKey" / "MyKey_Preview").

    Returns (bnk bytes, wem file id).
    """
    bank_id = _bnk_id(name, "bank")
    file_id = fnv_hash(name) & 0x7FFFFFFF or 1
    sound_id = _bnk_id(name, "sound")
    action_id = _bnk_id(name, "action")
    bus_id = _bnk_id(name, "bus")
    mixer_id = 650605636
    prefetch = wem[: 72000 if is_preview else 51200]

    header = struct.pack("<IIII", 91, bank_id, 0, 0) + bytes(12)
    didx = struct.pack("<iii", file_id, 0, len(prefetch))

    hirc = struct.pack("<I", 4)
    hirc += _hierarchy_obj(2, _sound(sound_id, file_id, mixer_id, bus_id, volume, is_preview))
    hirc += _hierarchy_obj(7, _actor_mixer(mixer_id, sound_id))
    hirc += _hierarchy_obj(3, _action(action_id, sound_id, bank_id))
    hirc += _hierarchy_obj(4, struct.pack("<III", fnv_hash(f"Play_{name}"), 1, action_id))

    bank_name = f"Song_{name}".encode("ascii")
    stid = struct.pack("<IIIb", 1, 1, bank_id, len(bank_name)) + bank_name

    bnk = (_chunk(b"BKHD", header) + _chunk(b"DIDX", didx) + _chunk(b"DATA", prefetch)
           + _chunk(b"HIRC", hirc) + _chunk(b"STID", stid))
    return bnk, file_id
