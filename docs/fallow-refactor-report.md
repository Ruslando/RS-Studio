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
- Extracted save-state tracking into a configured service so editing features no longer import the project lifecycle just to refresh the dirty indicator. Added regression coverage for clean/dirty automatic placement, mixer edits, view changes, tutorial state and closing a project. Moved comment normalization into a UI-free module.
- Moved stem soloing beside stem muting, and shared Rocksmith lead-in preferences outside the export dialog.
- Moved stage hit testing and client/canvas coordinate conversion out of the gesture controller. Hover deletion and pointer tests exercise the shared implementation. Removed five unused forwarding exports after checking consumers; retained the project `markSaved` API used by browser tests.
- Separated remembered placement validation from beam search, and walkthrough scoped-control admission from stage-spot admission. Search ordering and event policy are unchanged.
- Added a Guitar Pro voice regression covering mixed rhythms, authored 6:4 tuplets, grace notes, tied-part effects and inserting a note into a rest without changing unaffected bars or original sounding times. It passes against both the committed baseline and the refactor.

## Fallow comparison

| Finding | Before this continued pass | After |
|---|---:|---:|
| Non-complexity findings | 236 | 113 |
| Unused-export flags | 215 | 92 |
| Duplicate-export groups | 1 | 0 |
| Reported cycles | 20 | 21 |

Fallow now reports 21 cycle paths. Direct project/playback, Rocksmith-check/export and editor/interaction reciprocal imports were removed, but other paths remain; the reported cycle count did not improve. This is not an acyclic module graph.

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
| `rememberAhead` | 82 | 40 |
| Walkthrough `guard` | 70 | 34 |

Extracted helpers retain complexity where the domain requires it: string painting scores 57, hand impacts 50, chord naming 48, individual lane-note painting 33 and rebuilt-note construction 24. Arithmetic and selection order were preserved. The new placement helper scores 21; walkthrough helpers score 7 and 13. No reported function now exceeds cognitive complexity 75; the highest remaining score is 63. This does not eliminate the configured threshold violations (15 cognitive / 20 cyclomatic).

Splitting responsibilities increases the number of functions that receive individual health findings. The raw health-finding count rises from 1048 to 1081. Most coverage-related scores remain static estimates; this pass does not claim that every Fallow warning was eliminated or that runtime performance improved.

## Verification

- Full JavaScript suite: **109 of 110 test files pass**. The independently established `string-techniques.test.mjs` failure remains.
- **All 1,083 Guitar Pro feature-matrix rows match exactly**, including notation and MIDI differences, rerun after the latest optimizer change.
- **92 optimizer comparisons** match the preceding implementation exactly for string/fret placement, fingers and hand seats. Both showcase fixtures and seeded chord/note sequences cover pins, holds, capo and technique flags; neither version mutates its inputs. This is a regression corpus, not a comprehensive performance benchmark.
- **24,000 event-policy comparisons** match the preceding walkthrough guard, including modifier keys, scoped selectors, menus, spot boundaries and transition releases. The walkthrough browser test cannot start because the product deliberately disables its launch button in `index.html`; it timed out before reaching any changed guard code.
- **All nine latest browser checks pass**: save/undo, mixer, comments, chart reopening, grid selection/resize, slide/vibrato handles, project-start cancellation and the Rocksmith export dialog.
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

The majority of the initial unused-export flags and all initially reported hotspots above cognitive complexity 75 have been addressed. Fallow still fails its quality gates: **92 unused exports, 21 cycle paths and 1,081 health findings** remain. Many health findings use static coverage estimates; they are not measured test failures. Retained exports include test/integration APIs and compatibility forwarding; other flags need individual consumer decisions. Remaining complexity includes solver/search code, source import planning, lifecycle controllers and detailed rendering. Those require separate performance or corpus-based work rather than further mechanical splitting. No warning categories were suppressed to reduce counts.

Detailed JSON reports, test logs, export-cleanup inventory, matrix comparisons and canvas hashes remain under `.local-tools/fallow/` (ignored local artifacts). The latest artifacts are `continued-final.json`, `continued-tests-verified.txt`, `continued-browser-final.txt`, `continued-memory-comparison.json`, `continued-tour-comparison.json` and `continued-matrix.json`. Earlier artifacts are `bulk-final.json`, `bulk-tests-final.txt`, `bulk-interaction-browser.txt`, `bulk-pointer-baseline.txt`, `bulk-pixels-baseline.json`, `bulk-pixels-after.json`, `bulk-matrix-after.json`, `chord-comparison.json`, `pulse-comparison.json` and `export-cleanup-plan.json`.
