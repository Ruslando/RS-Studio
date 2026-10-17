# Finger and grip rating

The register engine still chooses strings and frets. The grip model in
`web/voicing-core.js` assigns fingers to a shape and decides whether it belongs
among the offered alternatives. It does not optimize another passage.

## Feasibility

Enumerate finger assignments and connected barre groupings using up to four
fingers. Open strings use no finger. A barre cannot cross an unsupported,
open or lower-fretted string. Non-index barres cover at most three strings.
Keep the existing finger-order checks, including the tucked index of open A.

Each finger pair has a conservative reach budget:

| Fingers | Maximum fret difference | Longitudinal limit (mm) | Lateral comfort (mm) |
| --- | ---: | ---: | ---: |
| Index / middle | 2 | 60 | 20 |
| Index / ring | 3 | 85 | 30 |
| Index / little | 4 | 105 | 40 |
| Middle / ring | 1 | 38 | 18 |
| Middle / little | 3 | 75 | 32 |
| Ring / little | 1 | 38 | 16 |

Measure longitudinal distances using scale length and fret positions. Measure
lateral gaps between the strings occupied by the two contacts; a fingertip
above a barre need not reach across its full width. Compute combined reach as
`hypot(longitudinal / limit, lateral / (2 * comfort))`. Reject values above one.
Reduce the longitudinal budget to 85% when either contact is a barre.

These are product heuristics for ordinary playing, not measured anatomical
limits. Radicioni and Lombardo, *A Constraint-Based Approach for Annotating Music
Scores with Gestural Information*, section 4.3 / table 1, motivates pair-specific
constraints. Its numbers are not copied verbatim: in particular, its zero-fret
middle/ring limit would reject conventional open C, and index-only barres would
exclude useful movable grips. The millimetre limits and combined budget need
further player feedback beyond the showcase.

## Four score components

- **Fingers:** contact count, with a small preference for lower finger numbers.
- **Stretch:** the worst pair's approach to its reach limit. Lone notes instead
  pay for departing from their finger's usual offset from the hand anchor.
- **Barre:** finger number and barre width; index barres are cheaper.
- **Control:** awkward finger order, reverse lateral reach and internal string
  muting or skipping. Strumming across a skipped string costs more than picking.

Choose the cheapest feasible assignment. There is no tilt/rotation search,
curled-finger simulation, high-fret tax or extra charge for open-string clearance.
Alternatives sort by grip cost, then passage cost. Passage cost remains the
register engine's original measure; it cannot compensate for a rejected grip.
The board still uses the hand anchor when selecting the displayed fingering.
Pair stretch is charged over the last 10% of the reach budget. Charging it
earlier made normal open C and D prefer the little finger to the ring finger.

Dahlgren and Grahn, *Ergonomic fingerings for guitar chord sequences*, discussion
pp. 13-14 and further research p. 16, motivates keeping static stretch and hand
movement separate. Its two-player triad study does not supply universal weights.

## Regression checks

`tests/web/grip-rating.test.mjs` preserves all 24 intended playable showcase
grips, rejects the four overstretched D-major counterexamples, and exercises
the production worker for pitch preservation, non-mutation, ordering and agreement
between rated and displayed fingerings. It also checks conventional open C/D
fingers and the effect of scale length and fret position on physical reach.
The D-major example now offers three alternative positions rather than eight.
Existing hand-pose tests cover G fingering, barre continuity and anchors; bass
and technique tests cover shifts and slides. Browser tests cover navigating,
previewing and applying chord and single-note alternatives.
