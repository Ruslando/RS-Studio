# Override showcase

Open `RS Studio - Override showcase.chart` in the repository root. This folder
contains its editable `project.json` source. E standard, 60 BPM, 4/4, 128 seconds.
No audio is required. Import the updated chart again to replace an older library copy.

## Test passages

The original 0-32 second section retains single notes, repeated chords and a
reduced chord. It contains no note position overrides or hand anchors.

| Time | Passage | Input / expected result |
| --- | --- | --- |
| 32-40 s | A: E3 F#3 G3 A3 B3 A3 G3 E3 | One hand anchor at 32 s, fret 2 |
| 40-48 s | B: A3 B3 C4 D4 E4 D4 C4 A3 | Continue at hand position 2 |
| 48-56 s | C: B4 C#5 D5 C#5 B4 C#5 D5 B4 | Automatic shift to 7 |
| 56-64 s | D: E5 F#5 G5 F#5 E5 F#5 G5 E5 | Automatic shift to 12 |
| 64-72 s | A repeated | Return to the original low strings and hand position 2 |
| 72-80 s | B repeated | Return to the original low strings and hand position 2 |
| 80-88 s | A with a different ending | Entire eight-note run remains playable at 2 |
| 88-96 s | B with a changed inner note | Remain at 2 |
| 96-104 s | C again | Automatic high shift |
| 104-112 s | D again | Automatic high shift |
| 112-120 s | A variation after the high passages | Return to 2 without a split after the matching prefix |
| 120-128 s | A with a different beginning | Remain at 2 |

Only the hand anchor at 32 seconds is authored. Earlier versions of this fixture
also anchored the later bars and high runs; those anchors were removed. Explicit
anchors intentionally begin a fresh memory section and would prevent this fixture
from testing recall across natural high shifts. There are no note pins, motif
labels or reference boxes supplying the repetition answer.

## Implemented rules

- Global bar-register planning remains a soft prior.
- A rolling eight-column search compares hand positions jointly, including across
  bar lines. It retains up to twelve alternative paths at each step; it does not
  identify, label or lock motif fragments.
- Each committed column teaches pitch-to-string positions and complete chord
  assignments. Frequency and the proportion of uses at that position determine
  the bonus, with logarithmic growth. Only actual committed placements train the
  memory; speculative search paths never do.
- Authored hand placement and position overrides with forward adaptation begin
  the same new memory section. Their hand position continues across bar lines;
  feasible natural shifts and remembered returns remain possible.
- A local pin is displayed exactly as authored, while its hypothetical automatic
  placement supplies continuity and learning. The exception cannot teach a new
  future preference. Technique links still connect the real authored notes.
- Before-only adaptation temporarily replaces the memory and hand context; the
  previous context resumes immediately after its target column.
- Chord open strings carry no register penalty. Single notes retain the open-string
  restriction, and fretted techniques retain their physical constraints.
- Every solve reconstructs memory chronologically. Save/reload and undo do not
  accumulate a separate historical preference store.

The current search is bounded, not an exact whole-song optimum. Automatic first
choices still depend on the global register estimate. These are useful points to
listen for during manual review, alongside transitions at 48, 56, 64 and 112 s.

Regression coverage: `tests/web/voicing-memory.test.mjs` and
`tests/web/voicing-override.test.mjs`.
