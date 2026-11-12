# Find Repeats

Find Repeats compares the active instance with the other included instances of
the selected group or variation. Highlights describe differences, rather than
proving that a note is wrong. Excluded instances do not contribute differences.

| Appearance | Meaning |
| --- | --- |
| Amber solid outline | This note has differences in another included instance, including fingering or being absent there. |
| Amber dashed outline | A note is missing here but present in another included instance. The box projects its position and duration into this instance. |
| Bright magenta passage frame, solid and thicker | The active instance. |
| Fainter magenta passage frame, dashed and thinner | Another included instance of the passage. |

Colors above describe the spectrogram palette. Notes without a difference have
no additional outline. A single differing note is counted once even when it
differs from several instances. Whammy type alone does not add an amber outline;
whammy curve differences can.

In the note preview, amber bold values flag a difference from the opened note
when viewing another instance. On the opened instance, they flag a difference
from the comparison value used by Apply. Numeric comparison values use the lower
median; other values use the middle present instance in comparison order. The
label “common” therefore does not always mean a majority vote. Position values
are compared only among notes with the same pitch.

Curves use a dotted zero line and a solid shape; differing shapes use the amber
value color. A pink/red curve heading means curve data is unavailable. Previewing
another instance projects its note into the current passage at 55% opacity and
hides the current counterpart until the preview is closed or switched back.

The note preview opens only for differences, including missing notes, and stays
hidden during playback. Pausing on a differing note opens its preview. Left/right
arrow keys retain normal note/chord navigation.
Use the difference buttons or their dropdown to jump between differing notes;
its entries show only position / total. Each button click advances one entry,
wrapping from the last to the first or the first to the last. Alt+left/right
selects an instance, and Shift+left/right selects a group. The arrows inside the note preview show the
same note in other instances.
