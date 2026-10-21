# Chord names

`web/chords.js` names the chord a set of pitches spells. It is the only place
that does: the stage, the fretboard's bar and the Rocksmith export all show its
answer, or the name the user gave the chord instead (`web/chord-names.js`).

## How a name is built

Names are not looked up in a list. For each sounding pitch class taken as the
root, the other tones are read by their distance above it, in semitones:

| Part | Read from | Written |
|---|---|---|
| Third | 4 major, 3 minor; without either, 5 (sus4) or 2 (sus2) | `m`, `sus4`, `sus2` |
| Fifth | 7 perfect; else 6 (b5) or, over a major third, 8 (#5) | `dim`, `aug`, `b5`, `#5` |
| Seventh | 10 (7), 11 (maj7), 9 over a diminished triad (dim7); 9 without a seventh is a sixth | `7`, `maj7`, `dim7`, `6` |
| Tensions | what is left: 2 (9), 1 (b9), 3 over a major third (#9), 5 (11), 6 over a perfect fifth (#11), 8 (b13), 9 with a seventh (13) | see below |

A natural tension names the chord (C9, C11, C13) when there is a seventh and a
ninth below it; the ninth may be altered (C13#9), and a 13 may leave out the 11.
Otherwise it is added (`Cadd9`, `C7add13`). Alterations follow the number
directly (`C7b9`, `C7#5b9`); with no number before them they are bracketed, so
`C(b5)` cannot be read as a root of C flat. A sixth with a ninth is `6/9`.

Every reading that holds together is a candidate. Readings are ranked by cost,
and the cheapest is the name:

| Cost | For |
|---|---|
| 1 | the root is not the bass, and the bass is the third or fifth (`C/E`) |
| 1.5 | ...the seventh (`C7/Bb`) |
| 2.5 | ...a sixth, major seventh or sus tone (`Cmaj7/B`, `Gsus4/C`) |
| 3 | ...a tension: rarely what anyone means |
| 1.5 / 2.5 | each alteration, on a chord with / without a seventh or sixth |
| 1 | each added tension; ½ for the 9 of a 6/9 |
| 1 | a natural 11 over a major third, which clashes with it |
| 1.5 | no third in a seventh chord (`C7(no3)`) |
| 0.5 | sus |
| 1 / 0.25 | no fifth, without / with a seventh or sixth |
| 1 | dim(maj7), and a sixth on a sus chord (`C6sus4/G` is `F/G`) |
| 2 | a chord over a bass note that is not part of it (`F/G`); 1.5 more when the bass is a semitone under one of its tones |

Ties go to the shorter name. Readings within 2.5 of the name are offered as
alternatives, at most five.

## Rules and why

- **One pitch class is a note, not a chord.** A note and its octaves are named by
  the note.
- **Two tones are a chord only as a fifth.** C G is `C5`, G C is `C5/G`. Any other
  pair is an interval and has no name: naming every two-note line a chord would
  put a name on every double stop.
- **A missing fifth is not written.** C E Bb is `C7`. Guitar voicings drop the
  fifth constantly, and chord charts do not mark it.
- **A missing third is written.** C G Bb is `C7(no3)`: the third decides major or
  minor, so leaving it out changes what the chord is. Without a seventh such a
  chord is a power chord or nothing.
- **A sus chord needs its fifth.** Otherwise C D E would read as `D7sus2/C` rather
  than `Cadd9`.
- **A bass that is not part of the chord is written after the slash.** F A C over
  G is `F/G`, as charts write it, not `Fadd9/G`. This reading exists only when the
  bass note does not also sound higher up, and the chord above has three tones. A
  bass a semitone under a chord tone clashes with it, which is why C E G# Bb Db is
  `C7#5b9` and not `C#m6/C`.
- **Roots and basses are spelled as guitar charts spell them:** C C# D Eb E F F#
  G Ab A Bb B. The right spelling depends on the key, which the editor does not
  know; this is what most charts write.

## Where the references disagree

The engine was checked against two libraries during development, neither of which
ships: Tonal 6.5.1 (JavaScript, 107 chord types, MIT licence) and music21 10.5
(Python, from MIT, BSD licence). Every Tonal type in all twelve keys, 1284
chords, gets a name, and Tonal reads each name back as the same tones, allowing
for an unwritten fifth. The exceptions are three six- and seven-tone stacks
(maj13#11, 7#9#11b13, 7sus4b9b13), named as slash chords whose 13 Tonal defines
without the 11; six strings cannot play them anyway.

Where the libraries disagree with each other or with charts, the engine's answer
and the reason:

| Tones | Tonal | music21 | Engine | Why |
|---|---|---|---|---|
| C E G Bb D F | Dm11A/C | C11 | `C11` | the root is the bass and every tone is a C11 tone |
| C F G Bb D | C11 | Gm7/C | `C9sus4` | no third, so suspended rather than an 11 chord; `Gm7/C` (G minor seven over C) is offered |
| E G C | Em#5 | C/E | `C/E` | a first inversion, not an altered E minor |
| C E G A | C6 | Am7/C | `C6` | root in the bass; `Am7/C` is offered |
| C G Bb | none | incomplete dominant seventh | `C7(no3)` | what music21 calls it, written as a symbol |
| C E Bb D# Ab | C7#5#9 | Ab+/CaddBb,Eb | `C7#5#9` | the altered dominant charts write |
| C E G A D F# | C69#11 | D11/C | `C6/9#11` | not `D11/C`: a natural 11 over a major third clashes |
| G F A C | FMadd9/G | F/G | `F/G` | F major over a G bass that is not part of it |

Where taste decides, the alternatives are offered and the user names the chord.

## Given names

A name the user gives rides on the chord's notes (`chordName`), with the tones it
was given to (`chordNameFor`). When the tones change, the given name no longer
applies and the engine names the chord again. Picking the engine's name, first
in the list, clears a given one. The export sends the shown name on each note;
Rocksmith keeps 31 bytes of it.

## Tests

`tests/web/note-tools.test.mjs` checks chord-book grips (open, barre, seventh,
sus, power, slash, extended) by their fret shapes, and the cases above.
