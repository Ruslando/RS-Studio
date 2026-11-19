# Sound presets

Add JSON tone files to `presets/sounds` in the RS Studio data directory, then
open **Settings → Tone presets**.
The folder is read when the editor opens; there is no manual reload action.
Bootstrap installs use their persistent data directory; portable builds use the
folder beside the executable. The bundled defaults are copied there on first use
without overwriting existing files. A release that adds defaults copies only the new ones;
files you removed are never restored.

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
Assigned tones reference their app preset. The Tone Designer action on a switch
edits that app preset's values; it does not overwrite the source JSON file.
Only unavailable tones from imported projects keep project-local definitions.

## Included starting points

These are settings from the [official-DLC tone database](https://github.com/iminashi/tones) that DLC Builder downloads for its tone collection.
The display names were changed to identify their intended role; gear, parameters
and original volume values are retained. Each was chosen because Rocksmith's own descriptor or its gear matches
the role, the chain has at most six devices and the volume is between −16 and −25.
Crunch/Overdrive are our intended categories, not a manufacturer ranking. Compare their levels in Rocksmith.

| File | Artist / song | Original tone key |
| --- | --- | --- |
| guitar-clean.json | Simple Minds — Don't You (Forget About Me) | simpdont_clean |
| guitar-crunch.json | Free — All Right Now | FreeAllR_drive |
| guitar-overdrive.json | Tom Petty and the Heartbreakers — American Girl | TomGirl_drivelead |
| guitar-distortion.json | Rage Against the Machine — Killing in the Name | RageKilling_dist |
| guitar-high-gain.json | Slayer — War Ensemble | WarEnsemble_dist |
| guitar-lead.json | The Cars — You're All I've Got Tonight | CarsYoure_echolead |
| guitar-echo-drive.json | Angels & Airwaves — The Adventure | angeadve_echodist |
| guitar-surf.json | The Chantays — Pipeline | chanpipe_lead |
| guitar-funk.json | Chic — Good Times | GoodTimes_clean |
| guitar-wah.json | Third Eye Blind — Semi-Charmed Life | 3eyesemi_leadwah |
| guitar-tremolo.json | The Doors — Riders on the Storm | DoorsRiders_trem |
| guitar-octave-lead.json | David Bowie — Ziggy Stardust | davizigg_lead8va |
| guitar-doom.json | Ghost — Cirice | ghosciri_dist |
| guitar-acoustic.json | Audioslave — Like a Stone | AudLike_acc |
| guitar-clean-chorus.json | The Cure — Boys Don't Cry | BoysDontCry_clean |
| guitar-fuzz.json | Lenny Kravitz — Are You Gonna Go My Way | AreYouGonna_fuzz |
| guitar-ambient.json | U2 — Where the Streets Have No Name | u2wher_cleandelay |
| bass-clean.json | Gold Motel — Brand New Kind of Blue | BrandNew_bass |
| bass-crunch.json | Edgar Winter — Free Ride | edgafree_bassdist |
| bass-overdrive.json | The Pretty Reckless — Going to Hell | pretgoin_bass |
| bass-distortion.json | Rage Against the Machine — Bombtrack | RageBomb_bassdist |
| bass-synth.json | Lady Gaga — Poker Face | ladypoke_synthbass |
| bass-octave.json | Bush — Machinehead | Machinehead_bass8va |
| bass-acoustic.json | Violent Femmes — Blister in the Sun | Blister_bass |
| bass-fuzz.json | Garbage — Only Happy When It Rains | GarbOnly_bassfuzz |
| bass-pick.json | Bad Religion — American Jesus | badramer_bass |
| bass-vintage.json | Marvin Gaye & Tammi Terrell — Ain't No Mountain High Enough | marvaint_bass |
| bass-envelope.json | Earth, Wind & Fire — Let's Groove | eartlets_synthbass |
| bass-chorus.json | Joy Division — Love Will Tear Us Apart | joydlove_bass |

The legacy Clean/Crunch/Lead definitions remain available for existing projects;
the Tone presets's normal starting-point list is populated from the JSON folder.
