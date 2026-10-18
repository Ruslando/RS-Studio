# Sound presets

Add JSON tone files to `presets/sounds` in the RS Studio data directory, then
open **Settings → Tone presets**.
The folder is read when the editor opens; there is no manual reload action.
Bootstrap installs use their persistent data directory; portable builds use the
folder beside the executable. The six defaults are copied there on first use
without overwriting existing files. Later reloads do not restore files you removed.

Supported JSON: a single DLC Builder-style tone, an array of tones, or the
versioned RS Studio library from earlier versions. A file can contain
1–100 tones and must be no larger than 1 MiB. Up to 256 JSON files are read.
Invalid files are reported individually and are not silently corrected.
The folder is read without executing files. XML and PSARC import are not supported.

**Import preset** adds files to the current editing draft. **Apply** keeps
them in your preset library; closing with **×** discards that import. Importing identical
settings again skips duplicates. Existing presets are never overwritten by import.
Editing a folder preset creates a private copy. To change a folder file, export
the edited preset as JSON and replace that file yourself. **Export preset** exports
the selected preset. Both actions sit below the preset selector with the other
preset actions. Apply saves without closing the window.
Assigned project tone snapshots remain independent of these files.

## Included starting points

These are settings from the [official-DLC tone collection distributed by DLC Builder](https://github.com/iminashi/tones).
The display names were changed to identify their intended role; gear, parameters
and original volume values are retained. Crunch/Overdrive are our intended
categories, not a manufacturer ranking. Compare their levels in Rocksmith.

| File | Artist / song | Original tone key |
| --- | --- | --- |
| guitar-clean.json | Simple Minds — Don't You (Forget About Me) | simpdont_clean |
| guitar-crunch.json | Free — All Right Now | FreeAllR_drive |
| guitar-overdrive.json | Big Brother and the Holding Company — Piece of My Heart | janipece_drivelead |
| bass-clean.json | Gold Motel — Brand New Kind of Blue | BrandNew_bass |
| bass-crunch.json | Edgar Winter — Free Ride | edgafree_bassdist |
| bass-overdrive.json | The Pretty Reckless — Going to Hell | pretgoin_bass |

The legacy Clean/Crunch/Lead definitions remain available for existing projects;
the Tone presets's normal starting-point list is populated from the JSON folder.
