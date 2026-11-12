# Fallow refactor coverage

This report covers the continued cleanup following the effect-conversion refactor (`339b48c`). The project Fallow configuration and warning thresholds were kept intact.

## Changes

- Separated Guitar Pro voice reconstruction into boundary planning, beat indexing/reuse, interval emission and note reconstruction. Original ordering and source provenance remain intact.
- Made 118 unused exports private after checking declarations and repository consumers. Implementations remain present, including functions used inside their own modules. Exports referenced by tests, tooling or integration entry points were retained; the fretboard core's namespace API was excluded from the automated cleanup.
- Centralized the shared fallback fret limit to resolve the duplicate-export finding.
- Split fretboard frame composition, neck layers, string painting, hand impacts and display-mark construction into focused functions.
- Split pointer updates, effect/reference gesture initialization and release handling by responsibility. Kept dispatch priority, error handling and final gesture cleanup in their original order.
- Separated lane-note painting from lane setup and shared frame collections.
- Separated chord interpretation into structural tones, tensions, naming and cost evaluation; separated pulse passage discovery into framing, similarity, candidate generation, selection and grouping.
- Moved stem muting to its project/mixer owner, removing the direct project/editor import cycle while preserving the editor's compatibility binding.
- Added a Guitar Pro voice regression covering mixed rhythms, authored 6:4 tuplets, grace notes, tied-part effects and inserting a note into a rest without changing unaffected bars or original sounding times. It passes against both the committed baseline and the refactor.

## Fallow comparison

| Finding | Before this continued pass | After |
|---|---:|---:|
| Non-complexity findings | 236 | 116 |
| Unused-export flags | 215 | 96 |
| Duplicate-export groups | 1 | 0 |
| Reported cycles | 20 | 20 |

The cycle count is still 20 because other dependency cycles remain. Removing the project/editor reciprocal import does not imply that the entire module graph is acyclic.

| Cognitive complexity | Before | After |
|---|---:|---:|
| Guitar Pro `rebuildVoice` | 112 | 1 |
| Fretboard `drawFretboard` | 110 | 37 |
| `paintFretboardNeck` | 101 | 4 |
| `drawHand` | 77 | 17 |
| Stage mousedown callback | 105 | 54 |
| Window mouseup callback | 97 | 19 |
| `updateDrag` | 91 | 21 |
| `paintLaneNotes` | 94 | 25 |
| Chord `reading` | 100 | 19 |
| `pulsePassages` | 81 | 3 |

Extracted helpers retain complexity where the domain requires it: string painting scores 57, hand impacts 50, chord naming 48, individual lane-note painting 33 and rebuilt-note construction 24. Arithmetic and selection order were preserved. The remaining function above cognitive complexity 75 is the voicing optimizer's `rememberAhead` (82). No optimizer behavior was changed.

Splitting responsibilities increases the number of functions that receive individual health findings. The raw health-finding count rises from 1048 to 1078. Most coverage-related scores remain static estimates; this pass does not claim that every Fallow warning was eliminated or that runtime performance improved.

## Verification

- Full JavaScript suite: **108 of 109 test files pass**. The independently established `string-techniques.test.mjs` failure remains.
- **All 1,083 Guitar Pro feature-matrix rows match exactly**, including notation and MIDI differences.
- **12,288 chord inputs** match the committed implementation exactly, including pitch-class combinations, inversions and octave duplicates.
- **163 passage inputs** match exactly; 108 produce passage groups. Inputs include the checked-in bass fixture and deterministic tempo/offset variants.
- **Eleven stage and fretboard canvas scenes match exactly** after asynchronous fingering settles: plain notes, selection, effects, marquee, slicing, tracing, scrolling, slides, grace notes, labels disabled and capo/fret numbering. An initial scrolled mismatch was a pending fingering calculation; the comparison harness was corrected to wait when no drag is active, without changing production behavior.
- Seven fretboard/diagnostic browser checks pass.
- Twelve pointer/edit/export browser checks: ten pass. The two failing pointer assertions also fail against committed code (`test_plain_drag_pans_and_ctrl_drag_draws_without_changing_clicks` and `test_ctrl_click_selects_notes_between_and_under_hidden_marker_rails`).
- The mixer volume/muting browser check passes.
- The new voice-reconstruction regression passes against the original and refactored implementations.
- `git diff --check` passes. Browser checks use cached Chromium and disposable project/config data.

These are targeted tests and comparisons, not an exhaustive browser or performance audit. The full Python suite was not run. The Python-served frontend still has no npm dependency manifest, so Fallow's missing-node-modules warning limits dependency classification.

## Remaining findings and stopping point

The majority of the unused-export flags and nine of the ten remaining UI/music-analysis hotspots above cognitive complexity 75 have been addressed. Retained exports include test/integration APIs and compatibility forwarding; other flags need individual consumer decisions. Remaining complexity includes solver/search code, source import planning, lifecycle controllers and detailed rendering. Those require separate performance or corpus-based work rather than further mechanical splitting. No warning categories were suppressed to reduce counts.

Detailed JSON reports, test logs, export-cleanup inventory, matrix comparisons and canvas hashes remain under `.local-tools/fallow/` (ignored local artifacts). The primary final artifacts are `bulk-final.json`, `bulk-tests-final.txt`, `bulk-interaction-browser.txt`, `bulk-pointer-baseline.txt`, `bulk-pixels-baseline.json`, `bulk-pixels-after.json`, `bulk-matrix-after.json`, `chord-comparison.json`, `pulse-comparison.json` and `export-cleanup-plan.json`.
