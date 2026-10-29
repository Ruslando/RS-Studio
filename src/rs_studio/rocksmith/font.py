"""The characters Rocksmith's fonts have, and what the export shows in their place.

The list is Rocksmith2014.NET's StringValidator.fs (MIT), as res/game_font.txt;
web/game-font.js carries the same list for the editor.
"""
from __future__ import annotations

from importlib import resources

GAME_FONT = frozenset(resources.files(__package__).joinpath("res", "game_font.txt").read_text("utf-8"))


def missing(name: str) -> list[str]:
    """The characters of `name` the game cannot show, in order, each once."""
    return list(dict.fromkeys(ch for ch in name if ch not in GAME_FONT))


def shown(name: str, latin: str) -> str:
    """What the game should show for a name: the name, or its Latin spelling when
    the fonts lack some of its characters (they would be gaps). Without a Latin
    spelling, the missing characters are left out, as DLC Builder does."""
    if not missing(name):
        return name
    if latin and latin != name and not missing(latin):
        return latin
    return " ".join("".join(ch for ch in name if ch in GAME_FONT).split())
