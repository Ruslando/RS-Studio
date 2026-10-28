"""Manifest JSON (.json/.hsan), aggregate graph (.nt), xblock and showlights.

Field sets and URN formats transcribed from Rocksmith2014.NET
(AttributesCreation.fs, AggregateGraph/*.fs, XBlock.fs).
"""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from importlib import resources

from . import sng as S

_SECTION_UI = {
    "fadein": "$[34276] Fade In [1]",
    "fadeout": "$[34277] Fade Out [1]",
    "buildup": "$[34278] Buildup [1]",
    "chorus": "$[34279] Chorus [1]",
    "hook": "$[34280] Hook [1]",
    "head": "$[34281] Head [1]",
    "bridge": "$[34282] Bridge [1]",
    "ambient": "$[34283] Ambient [1]",
    "breakdown": "$[34284] Breakdown [1]",
    "interlude": "$[34285] Interlude [1]",
    "intro": "$[34286] Intro [1]",
    "melody": "$[34287] Melody [1]",
    "modbridge": "$[34288] Modulated Bridge [1]",
    "modchorus": "$[34289] Modulated Chorus [1]",
    "modverse": "$[34290] Modulated Verse [1]",
    "outro": "$[34291] Outro [1]",
    "postbrdg": "$[34292] Post Bridge [1]",
    "postchorus": "$[34293] Post Chorus [1]",
    "postvs": "$[34294] Post Verse [1]",
    "prebrdg": "$[34295] Pre Bridge [1]",
    "prechorus": "$[34296] Pre Chorus [1]",
    "preverse": "$[34297] Pre Verse [1]",
    "riff": "$[34298] Riff [1]",
    "silence": "$[34299] Silence [1]",
    "solo": "$[34300] Solo [1]",
    "transition": "$[34301] Transition [1]",
    "vamp": "$[34302] Vamp [1]",
    "variation": "$[34303] Variation [1]",
    "verse": "$[34304] Verse [1]",
    "tapping": "$[34305] Tapping [1]",
    "noguitar": "$[6091] No Guitar [1]",
}


_INTERNAL_TONE_FILES = {
    "lead": "default_lead.json",
    "clean": "default_clean.json",
    "crunch": "default_crunch.json",
    "bass": "default_bass.json",
}


def load_internal_tone(preset: str, key: str) -> dict:
    """Load one bundled Rocksmith tone with an arrangement-unique key."""
    try:
        name = _INTERNAL_TONE_FILES[preset]
    except KeyError as exc:
        raise ValueError(f"Unknown internal Rocksmith tone preset: {preset}") from exc
    tone = json.loads(resources.files(__package__).joinpath("res", name).read_text("utf-8"))
    tone["Key"] = key
    return tone




def _round9(v: float) -> float:
    return round(v, 9)


def build_attributes(ctx, header: bool) -> dict:
    """One arrangement's manifest attributes; `header` = the .hsan subset.

    ctx carries: sng (chart.Compiled), ids, names — see builder.SongContext.
    """
    sng = ctx.compiled.sng
    props = ctx.compiled.arr_props
    note_count = ctx.compiled.note_count
    key = ctx.dlc_key
    low = key.lower()
    arr = ctx.arrangement
    arr_name = arr["name"]
    file_tag = arr["tag"]
    route = arr["route"]

    # calculateDifficulties (AttributesCreation.fs), term for term; fingerPicking,
    # twoFingerPicking and syncopation are always 0 here, as in EOF.
    def on(name: str) -> int:
        return 1 if props.get(name) else 0
    tech = (
        on("nonStandardChords") + 3 * on("barreChords")
        + (on("powerChords") | on("doubleStops")) + on("dropDPower")
        + 2 * on("openChords") + on("palmMutes") + 2 * on("harmonics")
        + 3 * on("pinchHarmonics") + on("hopo") + on("tremolo")
        + (4 if ctx.is_bass else 1) * on("slides") + on("unpitchedSlides")
        + 3 * on("bends") + 4 * on("tapping") + 2 * on("vibrato")
        + on("fretHandMutes") + on("slapPop") + on("sustain") + on("fifthsAndOctaves")
    )
    if tech <= 5:
        tech += 4
    song_len = sng.metadata.song_length
    diff = _round9(tech * note_count / song_len / 100.0)

    dna_riffs = 0.0
    for k, (t, dna_id) in enumerate(sng.dnas):
        if dna_id != 0:
            end = next((t2 for t2, d2 in sng.dnas[k + 1:] if d2 == 0), song_len)
            dna_riffs += end - t
    dna_riffs = round(dna_riffs, 3)

    attrs = {
        "AlbumArt": f"urn:image:dds:album_{low}",
        "AlbumName": ctx.album,
        "AlbumNameSort": sort_name(ctx.latin["album"], "album", ctx.dlc_key),
        "ArrangementName": arr_name,
        "ArtistName": ctx.artist,
        "ArtistNameSort": sort_name(ctx.latin["artist"], "artist", ctx.dlc_key),
        "CentOffset": ctx.cent_offset,
        "DLC": True,
        "DLCKey": key,
        "DNA_Chords": 0.0,
        "DNA_Riffs": dna_riffs,
        "DNA_Solo": 0.0,
        "EasyMastery": 1.0,
        "LeaderboardChallengeRating": 0,
        "ManifestUrn": f"urn:database:json-db:{low}_{file_tag}",
        "MasterID_RDV": ctx.master_id,
        "MediumMastery": 1.0,
        "NotesEasy": float(note_count),
        "NotesHard": float(note_count),
        "NotesMedium": float(note_count),
        "PersistentID": ctx.persistent_id.hex.upper(),
        "SKU": "RS2",
        "Shipping": True,
        "SongDiffEasy": _round9(tech * note_count / song_len / 25.0),
        "SongDiffHard": diff,
        "SongDiffMed": _round9(tech * note_count / song_len / 50.0),
        "SongDifficulty": diff,
        "SongKey": key,
        "SongLength": round(song_len, 3),
        "SongName": ctx.title,
        "SongNameSort": sort_name(ctx.latin["title"], "title", ctx.dlc_key),
        "SongYear": ctx.year,
        "Tuning": {f"string{i}": int(v) for i, v in enumerate(sng.metadata.tuning)},
    }
    # Left out entirely without a capo, as Rocksmith2014.NET writes it.
    if sng.metadata.capo_fret_id > 0:
        attrs["CapoFret"] = float(sng.metadata.capo_fret_id)
    if header:
        attrs["Representative"] = 1 if ctx.representative else 0
        attrs["RouteMask"] = route
        return attrs

    tones = []
    for tone in [ctx.tone, *ctx.tone_slots]:
        if tone["Key"] not in {item["Key"] for item in tones}:
            tones.append(tone)

    attrs.update({
        "ArrangementProperties": {
            "represent": 1 if ctx.representative else 0,
            "bonusArr": 1 if arr["priority"] == "bonus" else 0,
            "standardTuning": 1 if all(v == 0 for v in sng.metadata.tuning) else 0,
            "nonStandardChords": on("nonStandardChords"), "barreChords": on("barreChords"),
            "powerChords": on("powerChords"), "dropDPower": on("dropDPower"),
            "openChords": 1 if props["openChords"] else 0,
            "fingerPicking": 0, "pickDirection": 0,
            "doubleStops": 1 if props["doubleStops"] else 0,
            "palmMutes": 1 if props["palmMutes"] else 0,
            "harmonics": 1 if props["harmonics"] else 0,
            "pinchHarmonics": 1 if props["pinchHarmonics"] else 0,
            "hopo": 1 if props["hopo"] else 0,
            "tremolo": 1 if props["tremolo"] else 0,
            "slides": 1 if props["slides"] else 0,
            "unpitchedSlides": 1 if props["unpitchedSlides"] else 0,
            "bends": 1 if props["bends"] else 0,
            "tapping": 1 if props["tapping"] else 0,
            "vibrato": 1 if props["vibrato"] else 0,
            "fretHandMutes": 1 if props["fretHandMutes"] else 0,
            "slapPop": 1 if props["slapPop"] else 0,
            "twoFingerPicking": 0, "fifthsAndOctaves": on("fifthsAndOctaves"), "syncopation": 0,
            "bassPick": 0, "sustain": 1 if props["sustain"] else 0,
            "pathLead": 1 if arr["path"] == "lead" else 0,
            "pathRhythm": 1 if arr["path"] == "rhythm" else 0,
            "pathBass": 1 if arr["path"] == "bass" else 0,
            "routeMask": route,
        },
        "ArrangementSort": ctx.arrangement_sort,
        "ArrangementType": arr["type"],
        "BlockAsset": f"urn:emergent-world:{low}",
        "Chords": _chord_map(sng),
        "ChordTemplates": [
            {"ChordId": i, "ChordName": c.name,
             "Fingers": list(c.fingers), "Frets": list(c.frets)}
            for i, c in enumerate(sng.chords) if c.name and not (c.mask & S.CHORD_MASK_ARPEGGIO)
        ],
        # One entry per difficulty level the game may show. We emit a single level, so
        # every entry is the arrangement's scroll speed (DLC Builder does the same).
        "DynamicVisualDensity": [ctx.scroll_speed] * 20,
        "FullName": f"{key}_{arr['full_name']}",
        "LastConversionDateTime": sng.metadata.last_conversion_date_time,
        "MasterID_PS3": -1,
        "MasterID_XBox360": -1,
        "MaxPhraseDifficulty": 0,
        "PhraseIterations": [
            {"PhraseIndex": pi.phrase_id,
             "MaxDifficulty": sng.phrases[pi.phrase_id].max_difficulty,
             "Name": sng.phrases[pi.phrase_id].name,
             "StartTime": round(pi.start_time, 3), "EndTime": round(pi.end_time, 3)}
            for pi in sng.phrase_iterations
        ],
        "Phrases": [
            {"MaxDifficulty": p.max_difficulty, "Name": p.name,
             "IterationCount": p.iteration_count}
            for p in sng.phrases
        ],
        "PreviewBankPath": f"song_{low}_preview.bnk",
        "RelativeDifficulty": 0,
        "Score_MaxNotes": float(note_count),
        "Score_PNV": 100_000.0 / max(1, note_count),
        "Sections": [
            {"Name": s.name, "UIName": _SECTION_UI.get(s.name, _SECTION_UI["riff"]),
             "Number": s.number,
             "StartTime": round(s.start_time, 3), "EndTime": round(s.end_time, 3),
             "StartPhraseIterationIndex": s.start_pi, "EndPhraseIterationIndex": s.end_pi,
             "IsSolo": s.name.startswith("solo")}
            for s in sng.sections
        ],
        "ShowlightsXML": f"urn:application:xml:{low}_showlights",
        "SongAsset": f"urn:application:musicgame-song:{low}_{file_tag}",
        "SongAverageTempo": round(ctx.compiled.average_tempo, 3),
        "SongBank": f"song_{low}.bnk",
        "SongEvent": f"Play_{key}",
        "SongOffset": -round(sng.metadata.start_time, 3),
        "SongPartition": ctx.partition,
        "SongXml": f"urn:application:xml:{low}_{file_tag}",
        "TargetScore": 100_000,
        "Techniques": _technique_map(sng),
        "Tone_A": ctx.tone_slots[0]["Key"] if len(ctx.tone_slots) > 0 else "",
        "Tone_B": ctx.tone_slots[1]["Key"] if len(ctx.tone_slots) > 1 else "",
        "Tone_Base": ctx.tone["Key"],
        "Tone_C": ctx.tone_slots[2]["Key"] if len(ctx.tone_slots) > 2 else "",
        "Tone_D": ctx.tone_slots[3]["Key"] if len(ctx.tone_slots) > 3 else "",
        "Tone_Multiplayer": "",
        "Tones": tones,
    })
    return attrs


# ---- technique map ---------------------------------------------------------
# Rocksmith2014.NET Manifest/Techniques.fs, rule for rule. The numbers are the
# game's technique ids; DLC Builder's comments there note where they disagree
# with the game's own technique database.

def _has(note, flag: int) -> bool:
    return note.mask & flag == flag


def _chord_strings(sng, note) -> tuple:
    """(lowest string, highest string, its fret there, its fret there) of a chord."""
    frets = sng.chords[note.chord_id].frets
    used = [s for s, f in enumerate(frets) if f >= 0]
    return used[0], used[-1], frets[used[0]], frets[used[-1]]


def _techniques(sng, note) -> set:
    single = S.SINGLE
    if note.mask in (0, single, single | S.OPEN):
        return set()
    chord_notes = sng.chord_notes[note.chord_notes_id] if _has(note, S.CHORDNOTES) else None
    hopo = bool(note.mask & (S.HAMMERON | S.PULLOFF))
    power = False
    adjacent = False
    if _has(note, S.DOUBLESTOP):
        s1, s2, f1, f2 = _chord_strings(sng, note)
        power = s1 <= 2 and s1 + 1 == s2 and f1 + 2 == f2   # root on the D string or lower
        adjacent = s1 + 1 == s2
    tuning = sng.metadata.tuning
    drop_tuning = tuning[0] == tuning[1] - 2 and tuning[0] == tuning[2] - 2
    chord_only = note.mask & (S.CHORDNOTES | S.DOUBLESTOP) == S.CHORDNOTES
    double_stop_notes = _has(note, S.CHORDNOTES | S.DOUBLESTOP)
    slides = chord_notes is not None and any(t != -1 for t in chord_notes.slide_to)
    tremolos = chord_notes is not None and any(m & S.TREMOLO for m in chord_notes.mask)
    bends_used = [len(b) for b in chord_notes.bend_data] if chord_notes is not None else []
    out = set()
    for number, flag in ((0, S.ACCENT), (1, S.BEND), (2, S.FRETHANDMUTE), (3, S.HAMMERON), (4, S.HARMONIC),
                         (5, S.PINCHHARMONIC), (7, S.PALMMUTE), (8, S.PLUCK), (9, S.PULLOFF), (10, S.SLAP),
                         (11, S.SLIDE), (12, S.UNPITCHEDSLIDE), (14, S.TAP), (15, S.TREMOLO), (16, S.VIBRATO),
                         (17, S.PALMMUTE | S.ACCENT), (18, S.PALMMUTE | S.HARMONIC), (19, S.PALMMUTE | S.HAMMERON),
                         (20, S.PALMMUTE | S.PULLOFF), (21, S.FRETHANDMUTE | S.ACCENT), (26, S.BEND | S.TREMOLO),
                         (27, S.TREMOLO | S.SLIDE), (28, S.TREMOLO | S.VIBRATO)):
        if _has(note, flag):
            out.add(number)
    if hopo:
        out.add(6)
    if _has(note, S.SINGLE) and _has(note, S.SUSTAIN):
        out.add(13)
    bend = note.bend_values
    if _has(note, S.BEND) and bend and bend[0].time == note.time and bend[0].step > 0:
        out.add(29)   # pre-bend
    if chord_notes is not None and sum(1 for n in bends_used if n) == 1:
        out.add(30)   # oblique bend
    if (_has(note, S.BEND) and len(bend) >= 3
            and bend[0].step != bend[1].step and bend[1].step != bend[2].step):
        out.add(31)   # compound bend
    if _has(note, S.DOUBLESTOP) and not power:
        out.add(33 if adjacent else 34)
    if power:
        out.add(35)
    if _has(note, S.CHORD) and drop_tuning:
        frets = sng.chords[note.chord_id].frets
        if frets[0] != -1 and frets[0] == frets[1] == frets[2]:
            out.add(36)   # drop-D power chord
    if note.mask & (S.CHORD | S.DOUBLESTOP) == S.CHORD:
        fingers = [f for f in sng.chords[note.chord_id].fingers if f != -1]
        if any(fingers.count(f) >= 3 for f in set(fingers)):
            out.add(37)   # barre
    if note.mask & (S.CHORD | S.SUSTAIN | S.DOUBLESTOP) == S.CHORD:
        out.add(38)
    if hopo and note.finger_print_id[0] != -1:
        out.add(40)   # hammer-on or pull-off inside a handshape
    if chord_only and slides:
        out.add(41)
    if chord_only and tremolos:
        out.add(42)
    if chord_notes is not None and any(m & S.HAMMERON for m in chord_notes.mask):
        out.add(43)
    if double_stop_notes and slides:
        out.add(44)
    if double_stop_notes and tremolos:
        out.add(45)
    if double_stop_notes and any(bends_used):
        out.add(46)
    return out


def _technique_map(sng) -> dict:
    """Difficulty -> phrase iteration -> technique ids (createTechniqueMap).

    A note belongs to a phrase from just after its start up to and including its
    end, and the last phrase is left out: DLC Builder does both on purpose, as
    official files do.
    """
    per_pi: dict[str, list] = {}
    notes = sng.levels[0].notes
    for k, pi in enumerate(sng.phrase_iterations[:-1]):
        ids = set()
        for note in notes:
            if pi.start_time < note.time <= pi.end_time:
                ids |= _techniques(sng, note)
        if ids:
            per_pi[str(k)] = sorted(ids)
    return {"0": per_pi} if per_pi else {}


def _chord_map(sng) -> dict:
    """Difficulty -> phrase iteration -> named chord ids (from handshapes)."""
    per_pi: dict[str, list] = {}
    level = sng.levels[0]
    for k, pi in enumerate(sng.phrase_iterations):
        ids = sorted({
            fp.chord_id for fp in level.handshapes
            if sng.chords[fp.chord_id].name and pi.start_time <= fp.start_time < pi.end_time})
        if ids:
            per_pi[str(k)] = ids
    return {"0": per_pi} if per_pi else {}


def _dump(doc: dict) -> bytes:
    """Names go out as raw UTF-8, as DLC Builder writes them: the game shows a
    \\uXXXX escape as nothing at all, so 伊根 (Ine) came out as " (Ine)"."""
    return json.dumps(doc, indent=2, ensure_ascii=False).encode("utf-8")


def manifest_json(attrs: dict) -> bytes:
    doc = {
        "Entries": {attrs["PersistentID"]: {"Attributes": attrs}},
        "ModelName": "RSEnumerable_Song",
        "IterationVersion": 2,
        "InsertRoot": "Static.Songs.Entries",
    }
    return _dump(doc)


def hsan_json(header_attrs: dict | list[dict]) -> bytes:
    attrs_list = header_attrs if isinstance(header_attrs, list) else [header_attrs]
    doc = {
        "Entries": {attrs["PersistentID"]: {"Attributes": attrs} for attrs in attrs_list},
        "InsertRoot": "Static.Songs.Headers",
    }
    return _dump(doc)


# Sort values official files use for these artists (StringValidator.fs
# tryGetOfficialArtistNameSortValue), keyed by the name in lower case.
_OFFICIAL_ARTIST_SORT = {
    "a day to remember": "A Day To Remember",
    "a flock of seagulls": "A Flock of Seagulls",
    "b.b. king": "BB King",
    "blink-182": "Blink 182",
    "blue öyster cult": "Blue Oyster Cult",
    "booker t. & the m.g.'s": "Booker T & The MGs",
    'bobby "blue" bland': "Bobby Blue Bland",
    "brooks & dunn": "Brooks Dunn",
    "foster the people": "Foster People",
    "grace potter & the nocturnals": "Grace Potter and The Nocturnals",
    "hail the sun": "Hail Sun",
    "the mamas & the papas": "Mamas and The Papas",
    "motörhead": "Motorhead",
    "mötley crüe": "Motley Crue",
    "t. rex": "T Rex",
}


def _without_article(value: str) -> str:
    """StringValidator.removeArticles: a leading The, A or An, in any case."""
    for article in ("the ", "a ", "an "):
        if value.lower().startswith(article):
            return value[len(article):]
    return value


def sort_name(value: str, kind: str, fallback: str) -> str:
    """The sort value DLC Builder makes of a name (convertToSortField): an artist
    by the official table or without its article, a title without its article,
    an album as it is."""
    if kind == "artist":
        value = _OFFICIAL_ARTIST_SORT.get(value.lower()) or _without_article(value)
    elif kind == "title":
        value = _without_article(value)
    return _sort_field(value, fallback)


def _sort_field(value: str, fallback: str) -> str:
    """Sort fields must start with an ASCII letter or digit (Rocksmith2014.NET
    StringValidator.sortField). A name with no such character sorts by the DLC key."""
    return re.sub(r"\A[^0-9A-Za-z]*", "", value) or fallback


# The DLC key is pasted directly into XML attributes, RDF literals and asset
# paths throughout this module — no escaping, anywhere. That is safe only because
# builder._dlc_key strips it to alphanumerics, and a rule enforced two files away
# is a rule waiting to be relaxed by someone who cannot see what depends on it.
# So check it here, where the interpolation actually happens.
_SAFE_KEY = re.compile(r"\A[A-Za-z0-9]+\Z")


def _checked_key(key: str) -> str:
    if not _SAFE_KEY.match(key or ""):
        raise ValueError(
            f"DLC key {key!r} is not alphanumeric; it is interpolated into XML "
            "and RDF unescaped (see builder._dlc_key)")
    return key


# ---- stable ids ------------------------------------------------------------
# Rocksmith needs these ids unique *within* a package and consistent across the
# files that cross-reference each other. It does not need them random, and
# drawing them at random meant no two builds of the same project were ever byte
# comparable — which rules out the cheapest test a binary exporter can have:
# build twice, diff. Derived from the song key and the asset path instead, so a
# rebuild after an unrelated code change is either identical or shows exactly
# what moved.
#
# The namespace is an arbitrary fixed UUID. It only has to never change.
_ID_NAMESPACE = uuid.UUID("2f1b6d4e-9c37-4a51-8c6b-0f2a5e7d1c93")


def stable_uuid(*parts: str) -> uuid.UUID:
    return uuid.uuid5(_ID_NAMESPACE, "|".join(parts))


def stable_id32(*parts: str) -> int:
    """A positive signed-32-bit id, for the fields RS stores as one."""
    digest = hashlib.sha256("|".join(parts).encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") % (2 ** 31 - 1) + 1


# ---- aggregate graph -------------------------------------------------------

_LINE = '<urn:uuid:{0}> <http://emergent.net/aweb/1.0/{1}> "{2}".'


def _graph_item(name, canonical, tags, relpath, logpath=None) -> str:
    lines = []
    uid = str(stable_uuid("graph", canonical, relpath))
    for t in tags:
        lines.append(_LINE.format(uid, "tag", t))
    lines.append(_LINE.format(uid, "canonical", canonical))
    lines.append(_LINE.format(uid, "name", name))
    if logpath:
        llid = f"{stable_id32('llid', relpath):08x}-0000-0000-0000-000000000000"
        lines.append(_LINE.format(uid, "llid", llid))
        lines.append(_LINE.format(uid, "logpath", logpath))
    lines.append(_LINE.format(uid, "relpath", relpath))
    return "\n".join(lines)


def _ctx_list(ctx_or_list) -> list:
    if isinstance(ctx_or_list, (list, tuple)):
        return list(ctx_or_list)
    return [ctx_or_list]


def aggregate_graph(ctx) -> bytes:
    contexts = _ctx_list(ctx)
    first = contexts[0]
    low = _checked_key(first.dlc_key).lower()
    man = f"/manifests/songs_dlc_{low}"
    items = [
        _graph_item(low, "/gamexblocks/nsongs", ["emergent-world", "x-world"],
                    f"/gamexblocks/nsongs/{low}.xblock"),
        _graph_item(f"{low}_showlights", "/songs/arr", ["application", "xml"],
                    f"/songs/arr/{low}_showlights.xml", f"/songs/arr/{low}_showlights.xml"),
        _graph_item(f"songs_dlc_{low}", man, ["database", "hsan-db"],
                    f"{man}/songs_dlc_{low}.hsan"),
    ]
    for c in contexts:
        tag = c.arrangement["tag"]
        items.extend([
            _graph_item(f"{low}_{tag}", man, ["database", "json-db"],
                        f"{man}/{low}_{tag}.json"),
            _graph_item(f"{low}_{tag}", "/songs/bin/generic", ["application", "musicgame-song"],
                        f"/songs/bin/generic/{low}_{tag}.sng", f"/songs/bin/{low}_{tag}.sng"),
        ])
    for size in (64, 128, 256):
        name = f"album_{low}_{size}"
        items.append(_graph_item(name, "/gfxassets/album_art", ["dds", "image"],
                                 f"/gfxassets/album_art/{name}.dds",
                                 f"/gfxassets/album_art/{name}.dds"))
    for bank in (f"song_{low}", f"song_{low}_preview"):
        items.append(_graph_item(bank, "/audio/windows", ["audio", "wwise-sound-bank", "dx9"],
                                 f"/audio/windows/{bank}.bnk", f"/audio/{bank}.bnk"))
    return "\n".join(items).encode("utf-8")


def xblock(ctx) -> bytes:
    contexts = _ctx_list(ctx)
    key = _checked_key(contexts[0].dlc_key)
    low = key.lower()
    entity_xml = []
    for c in contexts:
        arr = c.arrangement
        tag = arr["tag"]
        props = [
            ("Header", f"urn:database:hsan-db:songs_dlc_{low}"),
            ("Manifest", f"urn:database:json-db:{low}_{tag}"),
            ("SngAsset", f"urn:application:musicgame-song:{low}_{tag}"),
            ("AlbumArtSmall", f"urn:image:dds:album_{low}_64"),
            ("AlbumArtMedium", f"urn:image:dds:album_{low}_128"),
            ("AlbumArtLarge", f"urn:image:dds:album_{low}_256"),
            ("LyricArt", ""),
            ("ShowLightsXMLAsset", f"urn:application:xml:{low}_showlights"),
            ("SoundBank", f"urn:audio:wwise-sound-bank:song_{low}"),
            ("PreviewSoundBank", f"urn:audio:wwise-sound-bank:song_{low}_preview"),
        ]
        prop_xml = "\n".join(
            f'        <property name="{name}">\n'
            f'          <set value="{value}" />\n'
            f'        </property>' for name, value in props)
        entity_xml.append(
            f'    <entity id="{c.persistent_id.hex}" modelName="RSEnumerable_Song" '
            f'name="{key}_{arr["full_name"]}" iterations="0">\n'
            "      <properties>\n"
            f"{prop_xml}\n"
            "      </properties>\n"
            "    </entity>"
        )
    doc = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<game>\n"
        "  <entitySet>\n"
        + "\n".join(entity_xml) + "\n"
        "  </entitySet>\n"
        "</game>"
    )
    return doc.encode("utf-8")


def showlights(compiled) -> bytes:
    """Fog colour per section, plus a beam at most every 2 seconds.

    The beam colour comes from the note's FRET, not its pitch: `n.fret % 12`
    happens to spread colours across the fretboard about as well as pitch would,
    and the SNG note record does not carry a MIDI pitch to use instead. Nothing
    musical depends on it -- these drive the stage lights, and the game is
    perfectly happy with any note value in range.
    """
    sng = compiled.sng
    events = []
    for k, sec in enumerate(sng.sections):
        events.append((sec.start_time, 24 + (k % 12)))
    last_beam = -10.0
    notes = sng.levels[0].notes
    for n in notes:
        if n.time - last_beam < 2.0:
            continue
        midi = n.fret if n.fret >= 0 else 0
        events.append((n.time, 48 + (midi % 12)))
        last_beam = n.time
    events.sort()
    lines = "\n".join(
        f'  <showlight time="{int(t * 1000)}" note="{note}" />' for t, note in events)
    doc = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        f'<showlights count="{len(events)}">\n{lines}\n</showlights>'
    )
    return doc.encode("utf-8")
