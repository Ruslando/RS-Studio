# Find Repeats

Find Repeats opens the split view with one instance in each pane. The first pane
shows the instance under review; the second starts on the next instance. Every
instance of a group is in one list. Each pane chooses its own instance with the
repeat toolbar, which sits on the active pane; a click in the other pane makes
it active and acts there at once. The group is shared by both panes.

The two shown instances are compared with each other alone. Highlights describe
differences, rather than proving that a note is wrong. With the split view
closed, the instance is compared with every instance of the group.

Playheads are independent or linked during a review; synced is unavailable,
since both panes would then show one position. With linked playheads, both are
the same distance into their own instance: 3 s into one is 3 s into the other.
Choosing an instance puts both at the start of theirs, and a shorter instance's
playhead waits at its end while the longer one plays on. The playhead stays
inside the active pane's instance: seeks stop at its edges and playback loops
it. Notes are heard from the active pane only.

| Appearance | Meaning |
| --- | --- |
| Amber solid outline | This note differs in the compared instance, including fingering or being absent there. |
| Amber dashed outline | A note is missing here but present in the compared instance. The box projects its position and duration into this instance. |
| Bright magenta passage frame, solid and thicker | The instance this pane shows. |
| Fainter magenta passage frame, dashed and thinner | The compared instance, where it is in view. |

A frame's label names its group and its instance number.

Colors above describe the spectrogram palette. Notes without a difference have
no additional outline. A single differing note is counted once even when it
differs in several ways. Whammy type alone does not add an amber outline;
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
