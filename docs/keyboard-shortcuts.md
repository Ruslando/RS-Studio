# Keyboard shortcuts

Open Settings > Keyboard shortcuts. Click a binding to replace it; the adjacent
cross removes it. Apply keeps changes; closing without Apply restores the previous
bindings. Reset to defaults is staged in the same way. New defaults yield to
existing custom bindings using the same key.

## Editor defaults

| Key | Action |
| --- | --- |
| Space | Play / pause |
| Delete / Backspace | Delete selection |
| M / Shift+M | Mute active note layer / audio layer |
| F | Toggle fretboard |
| L | Toggle marker lanes |
| B | Toggle layer sidebar |
| R | Toggle Artifacts sidebar |
| + / - | Zoom in / out, like the toolbar buttons |
| 0 | Reset zoom |
| Left / Right | Previous / next note onset or chord; navigate matches during Find similar |
| Up / Down | Choose between simultaneously sounding note groups |
| Ctrl+Left / Ctrl+Right | Previous / next marker |
| Ctrl/Cmd+left drag | Draw notes along the spectrogram |
| Left drag in empty space | Pan the spectrogram in time and pitch |

A plain click in empty space still seeks, and Ctrl/Cmd+click still toggles a
note in the selection. Drawing and panning start only after a small drag threshold.
Panning preserves the playhead, notes, selection and undo history. Existing note
move/resize gestures, double-click insertion, Shift-selection and Alt-ranges stay
available.

The transport buttons on either side of Play perform the same marker jumps.
Navigation uses the active layer's tempo/meter, sections, phrase boundaries,
tone switches and hand anchors. Coincident markers form one stop. It does not
wrap at the ends or navigate markers belonging only to inactive layers. Marker
jumps also work with the overview focused or the pointer over the fretboard.
Ctrl/Cmd with plus or minus remains available to the browser. The new action
bindings and marker jumps do not run while typing or while a modal dialog is open.

The Fixed tab also documents the existing file/clipboard shortcuts and local
keyboard or mouse controls for the overview, project start, fretboard, note menu,
Tone Designer, Artifacts previews, selection, scrolling and zooming.

## Actions available without a default key

These 48 actions appear as **Unassigned** until a key is chosen. Each is connected
to its existing editor action; it applies to the current project and selection.

| Area | Unassigned actions |
| --- | --- |
| Playback | Slower; faster; normal speed; toggle metronome |
| Navigation and range | Song start; song end; range start; clear loop/detection range |
| Markers | Add tempo/meter marker; section marker; phrase boundary; tone switch at playhead |
| Detection and search | Open note detection; find similar passage |
| References and motifs | Group selection into reference; detach selected reference occurrences while keeping notes; mark selection as motif; select entire motif; unmark selected motifs while keeping notes |
| Fretboard | Build a grip; apply custom grip; use previewed alternative; return to automatic |
| Note techniques | Toggle palm mute; hammer-on/pull-off; vibrato; dead note; accent; let ring |
| Layers | Previous layer; next layer; add layer; active layer settings; show/hide active layer; lock/unlock active layer |
| Views and settings | Open tablature; editor settings; project details; manage tunings; Tone Designer; keyboard shortcuts |
| Project and import | Open project from library; close project; import Guitar Pro tracks; attach audio |
| Export | Guitar Pro .gp; legacy Guitar Pro .gp5; Rocksmith CDLC .psarc |

Further candidates from the shortcut audit are not registered yet: note timing,
pitch and duration nudges; setting range boundaries from the playhead; bar-wise
navigation; other technique variants such as bends, slides and harmonics;
reference locks and renaming; fretboard influence controls; and a shortcut to
start detection immediately. These need a separate choice of behavior and scope.
