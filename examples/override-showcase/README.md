# Override showcase

Open `RS Studio - Override showcase.chart` in the repository root. This folder
contains its editable `project.json` source. E standard, 60 BPM, 4/4, 128 seconds.
No audio is required. Import the updated chart again to replace an older library copy.

## Test passages

The original 0-32 second section retains single notes, repeated chords and a
reduced chord. It contains no note position overrides or hand anchors.

| Time | Passage | Input / expected result |
| --- | --- | --- |
| 32-40 s | A: E3 F#3 G3 A3 B3 A3 G3 E3 | One hand anchor at 32 s, fret 2: played at 2 |
| 40-48 s | B: A3 B3 C4 D4 E4 D4 C4 A3 | At 2 until D4, then one shift to 12 |
| 48-56 s | C: B4 C#5 D5 C#5 B4 C#5 D5 B4 | Stays at 12 |
| 56-64 s | D: E5 F#5 G5 F#5 E5 F#5 G5 E5 | Stays at 12 |
| 64-128 s | A, B, C and D again, with variations | Stays at 12: everything fits, so the hand does not move |

Only the hand anchor at 32 seconds is authored. There are no note pins, motif
labels or reference boxes.

## Implemented rules

The hand planner (`planShifts` in `web/voicing-core.js`):

- The hand stays where it is until a note cannot be played from it, and over the
  lane it moves as few times as it can. It does not return to where a passage was
  played before; a reference box is how a repeat is played the same way.
- A hand covers four frets from the index; the pinky can stretch one fret further.
- A shift is cheaper at a rest, after open strings, on a slide or after a long
  note, and dearer in the middle of a fast run. Between equal plans the hand sits on
  the notes and moves the least.
- An open string is used when it saves a shift.
- A hand anchor keeps the hand there until the next anchor or until a note cannot be
  played from it; it reaches forward only. Placed notes keep their positions, and
  the hand goes where it can reach them.
- Slides and hammer-ons stay on one string.

Regression coverage: `tests/web/hand-planner.test.mjs`,
`tests/web/voicing-override.test.mjs` and `tests/web/hand-anchor-forward.test.mjs`.
