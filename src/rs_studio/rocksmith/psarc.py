"""PSARC v1.4 archive writer/reader for Rocksmith 2014 (PC).

Layout (all integers big-endian):
  header(32) | AES-CFB-encrypted TOC (entries + block-size table) | data blocks
Each entry: md5(name)[16] + zIndex u32 + plainLength u40 + offset u40.
Data is stored in 64 KiB blocks, zlib per block; a block-size of 0 in the table
means a raw full-size block. Entry 0 is the nameless manifest (names joined
with "\n"). wem/sng/appid payloads are stored uncompressed like official files.
"""
from __future__ import annotations

import hashlib
import struct
import zlib

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms

try:  # cryptography >= 48 parks CFB in the decrepit namespace
    from cryptography.hazmat.decrepit.ciphers.modes import CFB
except ImportError:  # older releases
    from cryptography.hazmat.primitives.ciphers.modes import CFB

# Ships in the game binary. Like the SNG key in sng.py this protects nothing —
# it is how the format is defined, and the game will not open an archive
# encrypted any other way.
PSARC_KEY = bytes.fromhex("C53DB23870A1A2F71CAE64061FDD0E1157309DC85204D4C5BFDF25090DF2572C")
BLOCK = 65536
HEADER_LEN = 32
ENTRY_LEN = 30
# Stored uncompressed, matching official archives: wem and sng are already
# compressed formats (zlib would grow them), and the other two are a handful of
# bytes each.
_PLAIN_SUFFIXES = (".wem", ".sng", "appid", "7z")


def _toc_cipher() -> Cipher:
    return Cipher(algorithms.AES(PSARC_KEY), CFB(bytes(16)))


def _u40(value: int) -> bytes:
    """Five-byte big-endian. The TOC stores lengths and offsets this way — a
    1 TB ceiling in 2010, and 30 bytes per entry instead of 32."""
    return value.to_bytes(5, "big")


def build_psarc(entries: list[tuple[str, bytes]]) -> bytes:
    """Pack (name, data) entries into an encrypted-TOC PSARC archive."""
    manifest = "\n".join(name for name, _ in entries).encode("ascii")
    all_entries = [("", manifest)] + list(entries)

    # Three parallel structures, built in one pass and assembled below:
    #   stored    every block's bytes, in the order they appear in the file
    #   zlengths  each block's STORED size; a block is 64 KiB uncompressed, so
    #             this is the only way a reader knows how far to read
    #   protos    one row per entry, holding what its TOC record will need
    stored: list[bytes] = []
    zlengths: list[int] = []
    protos: list[tuple[bytes, int, int, int]] = []  # digest, zindex, plain len, stored len
    for name, data in all_entries:
        digest = hashlib.md5(name.encode("ascii")).digest() if name else bytes(16)
        zindex = len(zlengths)
        plain = any(name.endswith(s) for s in _PLAIN_SUFFIXES)
        total = 0
        for off in range(0, len(data), BLOCK):
            chunk = data[off:off + BLOCK]
            packed = chunk if plain else zlib.compress(chunk, 9)
            # Incompressible data comes back LARGER from zlib. Storing the raw
            # chunk instead is what a zero in the block table means (see below),
            # so this is a format feature, not an optimization.
            if len(packed) >= len(chunk):
                packed = chunk
            stored.append(packed)
            zlengths.append(len(packed))
            total += len(packed)
        protos.append((digest, zindex, len(data), total))

    toc_length = HEADER_LEN + len(all_entries) * ENTRY_LEN + len(zlengths) * 2
    header = struct.pack(
        ">4sHH4sIIIII", b"PSAR", 1, 4, b"zlib",
        toc_length, ENTRY_LEN, len(all_entries), BLOCK, 4,
    )

    toc = bytearray()
    offset = toc_length
    for digest, zindex, plain_len, stored_len in protos:
        toc += digest + struct.pack(">I", zindex) + _u40(plain_len) + _u40(offset)
        offset += stored_len
    # The block-size table. Each entry is a uint16, which cannot hold 65536 — so
    # a full-size block is written as 0. That is also how a raw (uncompressed)
    # block is signalled, since an uncompressed block is always exactly BLOCK
    # bytes unless it is the last one.
    for zlen in zlengths:
        toc += struct.pack(">H", 0 if zlen == BLOCK else zlen)

    enc = _toc_cipher().encryptor()
    return header + enc.update(bytes(toc)) + enc.finalize() + b"".join(stored)


def read_psarc(data: bytes) -> dict[str, bytes]:
    """Inverse of build_psarc — used by the export self-check."""
    magic, _maj, _min, comp, toc_length, entry_size, n_entries, block, flags = struct.unpack(
        ">4sHH4sIIIII", data[:HEADER_LEN])
    assert magic == b"PSAR" and comp == b"zlib" and entry_size == ENTRY_LEN

    toc_raw = data[HEADER_LEN:toc_length]
    if flags == 4:
        dec = _toc_cipher().decryptor()
        toc_raw = dec.update(toc_raw) + dec.finalize()

    entries = []
    pos = 0
    for _ in range(n_entries):
        digest = toc_raw[pos:pos + 16]
        zindex = struct.unpack(">I", toc_raw[pos + 16:pos + 20])[0]
        plain_len = int.from_bytes(toc_raw[pos + 20:pos + 25], "big")
        offset = int.from_bytes(toc_raw[pos + 25:pos + 30], "big")
        entries.append((digest, zindex, plain_len, offset))
        pos += ENTRY_LEN
    n_blocks = (len(toc_raw) - pos) // 2
    zlengths = struct.unpack(f">{n_blocks}H", toc_raw[pos:pos + n_blocks * 2])

    def inflate(zindex, plain_len, offset) -> bytes:
        out = bytearray()
        while len(out) < plain_len:
            size = zlengths[zindex] or block
            raw = data[offset:offset + size]
            if raw[:2] == b"\x78\xda":
                try:
                    raw = zlib.decompress(raw)
                except zlib.error:
                    pass
            out += raw
            offset += size
            zindex += 1
        return bytes(out[:plain_len])

    names = inflate(*entries[0][1:]).decode("ascii").split("\n")
    return {name: inflate(*e[1:]) for name, e in zip(names, entries[1:])}
