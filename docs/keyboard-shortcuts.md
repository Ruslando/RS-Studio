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
| T | Toggle drawing snap to pitch |
| H | Open / close drawing quick settings |
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

A moving release carries the viewport forward with smoothly decreasing speed,
based on the last 90 ms of panning. Pausing before release stops immediately.
Clicking, pressing a key, using the wheel or switching projects stops the coast.
The view stays within its bounds; reduced-motion preferences disable inertia.

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

## Drawing quick settings

The overview playhead always shows its position as `mm:ss.sss`, adding hours as
`h:mm:ss.sss` once needed. Double-click its time label (or focus it and press Enter)
to enter a position. Use `mm:ss` or `h:mm:ss`, optionally followed by `.sss`
milliseconds. Enter seeks, Escape cancels, and a valid edit also applies when
focus leaves the field. Times beyond the song duration are rejected.

The time grid automatically adapts to horizontal zoom, from coarse beat/bar
steps to 1/32 notes. The readout beside Zoom shows the active step. Hold Alt on
a note edge, or press it during a resize, to move that edge without snapping.
Release Alt to snap again. Alt-drag on empty space still creates a time range.
Free edge positions persist after release and through unrelated edits; the
opposite edge of a resized note stays fixed.

The Drawing button beside Zoom shows the snap state. Its popover provides
Snap to pitch and a search range of ±1, ±2 or ±3 semitones. Changes persist
immediately and stay synchronized with Editor settings. Turning snap off
disables Range. A former saved ±5 range is migrated to ±3.

H opens the popover and focuses Snap. Escape or an outside click closes it. Both
H and T are editable commands, with the same conflict checking, removal, staged
Apply/cancel and persistence as other bindings. The button hints follow the
current bindings.

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

Navigating between notes or chords with the arrow keys also auditions the newly
selected note or chord using its lane voice and mute settings.

The spectrogram's floating controls select Stereo / Left / Right for the
viewed audio layer and set the displayed Intensity range (Min / Max). Values
outside the range are hidden; 0–100% restores the original appearance. This
display filter is independent of drawing snap and note analysis.
Channel selection is saved per audio layer and applies to playback and analysis.
Audio layer speaker controls retain click to mute and sideways volume dragging.

The spectrogram controls collapse to a compact channel/range summary. Use its
chevron to expand, or drag its grip to dock along any spectrogram edge. With
the grip focused, arrow keys choose an edge. Dock position and collapsed state
are remembered on this device. Channel choices use the app's menu controls.
