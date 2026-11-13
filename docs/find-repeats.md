# Find Repeats

Find Repeats opens the split view with one instance in each pane. The first pane
shows the instance under review; the second starts on the next instance. Every
instance of a group is in one list. Groups with only one instance are kept
but not shown, since there is nothing to compare. Each pane chooses its own instance with the
repeat toolbar, which sits on the active pane; the instance shown in the other
pane can't be chosen as well, so the panes never show the same one; a click in the other pane makes
it active and acts there at once. The group is shared by both panes.

A group holds only what recurs. A fill or ending played in no other instance
is a variation: it needs defining only once, so it belongs to no group. The
passage around it becomes the group, or splits into groups where different
instances share it, and the same material found in different passages is one
group. A version that several instances play alike, such as one of two
endings, is a group of its own. Octave variants, a single changed note and a
one-off brief ornament inside the passage stay in the group and show as
differences.

The two shown instances are compared with each other alone. Highlights describe
differences, rather than proving that a note is wrong. Closing the split view
ends the review.

Playheads are independent or linked during a review; synced is unavailable,
since both panes would then show one position. With linked playheads, both are
the same distance into their own instance: 3 s into one is 3 s into the other.
Choosing an instance puts both at the start of theirs, and a shorter instance's
playhead waits at its end while the longer one plays on. Paused, the playhead
can be put anywhere, also inside another instance; that never chooses it, as
only the repeat toolbar chooses instances. Playback never leaves the active
pane's instance: play starts at its start when the playhead is outside, seeks
during playback stop at its edges, and playback stops at its end. Audio and
notes are heard from the active pane only.

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

The note card hangs below the repeat toolbar, or above it when the toolbar is
near the foot of the pane, so it never covers the note itself. It lists only
what differs, each value on its pane's side. Position values are
compared only between notes with the same pitch. → copies a value from the left
to the right, ← from the right to the left; hovering an arrow previews the
result. Copying a missing note adds it, and copying an absence removes it. A
curve is drawn with a dotted zero line; a curve that is absent reads None.

The note card opens only for differences and stays hidden during playback.
Pausing on a differing note opens it. The playhead considers only the notes
this instance has: a note missing here belongs to the compared instance, so its
dashed outline opens from the difference buttons, not from the playhead. Left/right
arrow keys retain normal note/chord navigation.
Use the difference buttons or their dropdown to jump between differing notes;
its entries show only position / total. Each button click advances one entry,
wrapping from the last to the first or the first to the last. Alt+left/right
selects an instance, and Shift+left/right selects a group.
