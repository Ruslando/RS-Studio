# Fallow refactor coverage

The latest pass starts from `6124eee`. Fallow configuration, entry points, ignore patterns and warning thresholds are unchanged.

## Current findings

| Finding | Before latest pass | Current |
|---|---:|---:|
| Unused-export flags | 76 | 26 |
| Dependency cycles | 0 | 0 |
| Unresolved imports | 0 | 0 |
| Unused files | 0 | 0 |
| Functions exceeding health thresholds | 1,081 | 1,094 |

Duplication remains 39 clone groups / 432 lines, approximately 0.99% of analyzed lines. Quality gates still fail because export and health findings remain. The earlier continued cleanup began with 215 unused-export flags, 20 cycles and one duplicate-export group; the current non-health total is 26.

## Latest changes

- Made 50 unused declarations private or removed unused forwarding exports after checking consumers. Implementations remain present. The review distinguishes JavaScript consumers from unrelated Python constants, DOM IDs, comments and names used only inside the declaring module. The fretboard namespace test was checked explicitly before making five implementation constants private.
- Separated Guitar Pro lane planning into tick projection, grace-run attachment, deleted tie-chain invalidation and changed bar/voice invalidation. Order, source tick tolerances and rebuild criteria are unchanged.
- Separated staff import into beat annotations, sounding-note/tie provenance and lane assembly. Text, rest lyrics, chord labels, effects and note ordering are preserved.
- Separated project restoration into score/section migration, state construction, view restoration, grid restoration and warnings. Teardown, ID repair, active-layer fallback and editor reveal retain their order. View settings remain available for stem selection later in the load.
- Separated repeat discovery's candidate indexing, competing phrase plans and singleton-region handling. Candidate insertion order, scoring and passage selection are unchanged.
- Separated voicing column normalization, alternative-shape pricing and hand-seat reconstruction from chronological placement. Search order, memory updates and arithmetic are unchanged.
- Added a persistent browser regression for loading without audio, migrating duplicate per-layer sections, repairing duplicate note IDs, choosing an active layer and saving the restored content.

| Cognitive complexity | Before | Current |
|---|---:|---:|
| Guitar Pro `planLane` | 63 | 0 |
| Guitar Pro `staffLane` | 63 | 21 |
| Project `applyProject` | 62 | 15 |
| Repeat `findRepeats` | 62 | 17 |
| Voicing `voiceRegister` | 62 | 51 |

Helpers retain domain complexity: grace attachment scores 23 and competing repeat-plan construction scores 34. The highest remaining score is 58 in audit tooling; the highest application score is 57. The configured cognitive threshold remains 15.

Splitting responsibilities adds separately scored functions. Consequently, the raw health count increases by 13. Coverage-related scores still use Fallow's `static_estimated` model. This work does not claim measured coverage gains, lower total branching, faster execution or elimination of every warning.

## Latest verification

- Full JavaScript suite: **110 of 111 test files pass**. The independently established `string-techniques.test.mjs` failure remains.
- **All 1,083 Guitar Pro export-matrix rows match the committed baseline**, including notation and MIDI differences.
- **731 Guitar Pro import probes match** the preceding implementation, including two identical rejection outcomes for unsupported inputs.
- **182 voicing cases match** for string/fret placements, fingers and hand seats. Showcase fixtures and seeded sequences exercise pins, holds, capo and technique flags; inputs remain unchanged. Timing samples are diagnostic, not a performance benchmark.
- **183 repeat-discovery cases match**, producing 131 groups. Cases include showcase excerpts and seeded variations in chords, octave variants, missing/extra attacks, rests and beat clocks; inputs remain unchanged.
- **Seven project-restoration snapshots match exactly**: base data, legacy per-layer sections, missing score bars, no active layer, duplicate note IDs, view settings and no audio. Comparisons include save payloads, grid controls, active layers and warnings.
- **All 11 selected browser checks pass**, including those snapshots, save/undo, chart reopening, library rename/delete, both Guitar Pro export paths, independent track timing, Rocksmith hand positions, chord alternatives, reference rhythm and comments.
- **The new migration regression passes against both the refactor and committed baseline.** It checks actual saving after restoration, note count/pitch/timing preservation, unique IDs, deduplicated sections and active-layer selection.
- **All five Python font tests pass**, including equality of the frontend/backend font character lists.
- `git diff --check` passes. Browser checks use cached Chromium and disposable project/config data.

An initial loading check caught a view-settings scope error introduced during extraction. It was corrected before the successful browser/snapshot runs above. The full Python suite was not run.

## Retained export flags

The 26 remaining flags cover dynamic test/tool access and retained editor compatibility bindings:

- Editor history/commands: Python browser tests and command tests call snapshots, commit, undo/redo, structure commits, lane transfers and motif marking. The diagnostic-commit, snapshot-restore and undo-button forwarding bindings retain the existing editor API.
- Preview/fretboard and marker APIs: browser tests invoke appearance painting, fretboard editing, slide handles, phrase/tone snapping and tone-marker painting directly.
- Project and playback APIs: browser tests call clean-baseline marking, cached loading and playback-position revelation.
- Guitar Pro import structure: the audit harness consumes it through a module object.
- Repeat navigation/hover/playhead and intensity coloring: isolated tests consume the modules through `mockImport`.
- The sound-library storage key: browser tests initialize persisted preset data with it.

No suppression was added for these findings. Fallow does not fully resolve these dynamic consumers, so the count is not evidence that every remaining export can be removed safely.

## Earlier work and limits

Earlier commits removed the frontend dependency cycles, split rendering/gesture/effect-conversion hotspots, extracted shared save-state and fingering services, and preserved source provenance during voice reconstruction. Earlier comparisons covered 12,288 chord inputs, 163 pulse-passage cases and eleven settled stage/fretboard scenes. Those earlier comparisons were not all rerun in this pass.

Known earlier browser failures include two pointer assertions and global-settings `notes is not iterable` errors, reproduced against their committed baselines. The walkthrough launch is deliberately disabled in the product, preventing its full browser test from starting. These remain separate from the successful checks listed above.

The Python-served frontend has no npm dependency manifest. Fallow warns that missing root `node_modules` limits package-export and dependency classification.

Detailed local artifacts remain in ignored `.local-tools/fallow/`: `hotspots-final.json`, `hotspots-export-audit.json`, `hotspots-tests-verified.txt`, `hotspots-browser-verified.txt`, `hotspots-migration-verified.txt`, `hotspots-migration-baseline.txt`, `hotspots-matrix.json`, `hotspots-import-comparison.json`, `hotspots-voice-comparison.json`, `hotspots-repeat-comparison.json`, and the `hotspots-project-baseline.json` / `hotspots-project-after.json` snapshot pair.
