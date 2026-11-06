# Issue IDs and message wording

Each condition has a stable `id`. Display text, times, fret numbers, and preset names do not identify a condition.
An ID identifies a category, not one occurrence. Different notes can have the same issue ID.

DLC Builder checks keep their `Ixx` IDs, titles, detection rules, severity, and importance flags.
Their help text uses shorter explanations. The legacy `code` field remains available for existing renderers.
Export corrections use `export.*` IDs, including `export.chord-dead-note-removed`, separate from checker `I29`.
Only unresolved DLC Builder checks block server validation. The export review still asks users to fix or ignore warnings.

Saved ignore choices migrate from old titles, export codes, and warning message templates.
The migration preserves unknown IDs. Old `I29` ignores apply to both previously combined categories.

## Writing standard

Use ASD-STE100 Issue 9 as the writing reference: [official specification](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf).
Use short, complete sentences, active voice, consistent names, and direct instructions.
Describe the result first for export corrections. Give the corrective action in the help text.
Do not use contractions. Keep instructions within 20 words per sentence and descriptions within 25 words per sentence.
Do not claim formal STE compliance without a complete vocabulary review against the official dictionary.

Technical names retain their application meanings: arrangement, arpeggio, barre, bend point, capo, chord, dead note,
fingering, fret, grace note, grip, hand anchor, hand position, handshape, harmonic, hammer-on, legato,
mastery score, mordent, ornament, phrase, pinch harmonic, pitch, pull-off, rasgueado, riff, slide,
staccato, string, strum, sustain, tapping, tone preset, tone switch, tremolo, trill, tuning offset,
tuning pitch, turn, unpitched slide, vibrato, and whammy. Product and UI names keep their spelling.

## DLC Builder checks

| ID | Severity | Title | Help |
|---|---|---|---|
| `I01` | warning | An applause event is missing the event that ends it | Add an Applause end event after Intro applause. |
| `I02` | warning | Unexpected event between intro applause events | Move this crowd event before Intro applause or after Applause end. |
| `I03` | warning | Note linked to a chord | Rocksmith cannot link a single note to a chord. Change the legato slide to a shift slide, or use a single target note. |
| `I04` | warning | Linked note missing its target | This linked note has no next note on the same string. Add a target note. If it has a legato slide, remove the slide instead. |
| `I05` | warning | Linked slide ends on the wrong fret | The slide ends on a different fret from the next linked note. Change the target note or the slide. |
| `I06` | warning | Linked notes on different frets | Linked notes use different frets without a connecting slide. Use a legato slide between them, or set them to the same fret. |
| `I07` | warning | Linked bend mismatch | Set the last bend value of the first note to the first bend value of the next note. |
| `I08` | warning | Linked note does not reach its target | The linked note ends before its target starts. Extend it to the next note on the same string. |
| `I09` | warning | Unpitched slide with link | An unpitched slide with a link can cause incorrect mastery scores. Remove the slide or change it to a shift slide. |
| `I10` | warning | Phrase changes on a linked note's sustain | Move the phrase boundary outside the linked note. With difficulty levels, this boundary can hide a later note. |
| `I11` | warning | Note is both harmonic and pinch harmonic | Select one harmonic type in the Harmonic menu. |
| `I13` | warning | 7th fret harmonic with sustain | Rocksmith cannot detect sustain on a natural harmonic at fret 7. Shorten the note or select Rocksmith > Not scored (Ignore). |
| `I14` | warning | Bend without a bend value | All bend points have a value of zero. Move a bend point above zero, or remove Bend. |
| `I15` | warning | Tone change on a note | Move the tone switch before the note so the tone is active when the note starts. |
| `I16` | warning | Note inside a noguitar section | Move the note outside the No Guitar section, or change the section type. |
| `I18` | error | Linked chord without linked chord notes | Rocksmith can stop when a chord link has no linked chord notes. Check the chord's legato slide and note lengths. |
| `I20` | warning | Chord fingering does not match the hand position | The hand position does not match this chord's fingering. Change the hand anchor or the finger positions. |
| `I27` | warning | Chord fingering looks wrong | The finger numbers suggest that the fingers cross. Check the fingering and change it if needed. |
| `I28` | warning | Barre over open strings | Change the fingering. An open string is between strings held by the same finger. |
| `I29` | warning | Muted string in a chord that is not muted | Rocksmith cannot combine dead notes with pitched notes in one chord. Remove Dead / muted note, or enable it for every chord note. |
| `I21` | error | Hand position changes inside a chord shape | Move the hand position change outside the held chord shape. This change can cut off the shape or cause the game to stop. |
| `I22` | warning | Phrase boundary breaks a chord shape | A phrase or section boundary changes the hand position inside a held chord shape. Move the boundary outside the shape. |
| `I23` | warning | Hand position change at the end of an unpitched slide | Move the hand anchor away from the end of the unpitched slide. Rocksmith can fail to show a change at the slide's end. |
| `I25` | error | The first phrase contains notes | Rocksmith needs an empty first phrase. Increase Leading silence in the export settings, or move the first notes later. |
| `I26` | warning | Missing END phrase | Rocksmith needs an END phrase after the playable notes. The export creates it automatically. If this message remains, report an export error. |
| `I30` | error | More than 100 phrases | The arrangement has more than 100 phrase occurrences. Remove unnecessary phrase or section markers. Too many phrases can hide difficulty bars or stop the game. |
| `I31` | warning | Hammer-on or pull-off on the same fret | This hammer-on or pull-off starts on the previous note's fret or slide target. Change the fret or remove Hammer-on / pull-off. |
| `I32` | warning | Finger changes during a slide | The hand positions imply different fingers at the start and end of this slide. Change the hand anchors or fingering to keep the same finger. |
| `I33` | warning | Position shift into a pull-off | Move the hand anchor before or after the pull-off note. |
| `I34` | warning | Several bend values at the same time | Move or remove overlapping bend points. Each bend point must have a different time. |
| `I35` | warning | Natural harmonic with bend | This note has a natural harmonic and a bend. Remove Bend or select Pinch in the Harmonic menu. |
| `I37` | warning | Phrase mover on a note | A mover1 phrase starts on a note. Rocksmith requires mover2 or a higher number here. The editor does not allow these reserved phrase names. Report this export error. |
| `I36` | error | String not available on bass | Move the note to one of the four bass strings. |
| `I38` | warning | Fret above 24 | Rocksmith cannot show frets above 24. Move the note to a lower fret, or reduce the capo if used. |
| `I39` | warning | Note after the song end | This note starts at or after the END phrase or the end of the audio. Move it earlier or extend the playable song and its audio. |
| `I40` | warning | Technique on a note without sustain | This note is too short to carry its vibrato, tremolo picking, or slide. Extend the note or remove the technique. |
| `I41` | warning | Low bass tuning without workaround | This bass tuning needs the low-tuning workaround for note detection. The export normally applies it automatically. Check the layer tuning. If the tuning is correct, report this export error. |
| `I42` | warning | Bass tuning does not fit the tuning pitch | The tuning reference is 220 Hz or lower, but a string offset is negative. Check the layer tuning and Concert pitch settings. |

## Export corrections

| ID | Severity | Title | Help |
|---|---|---|---|
| `export.chord-dead-note-removed` | warning | Dead note removed from the chord | The export leaves this dead note out because other chord notes are not muted. Enable Dead / muted note for every chord note to keep a fully muted chord. |
| `export.slide` | warning | Slide removed: no valid target | The export cannot find a valid target for this slide. Put the next note on the same string at a different fret above fret 0. |
| `export.late-fx` | warning | Slide or vibrato starts with the note | Rocksmith cannot start this effect partway through a bent note. The export starts the slide or vibrato at the beginning of the note. |
| `export.grace` | warning | Grace note removed | The export cannot place a lower note before this note. Check for an open string, the song start, or another note on the same string. |
| `export.slide-in` | warning | Slide-in removed | The slide-in overlaps another note, has no duration, or has no valid start fret. Shorten the slide-in, move the other note, or change the slide direction. |
| `export.whammy` | warning | Whammy removed | The whammy would leave frets 1 to 24, or this note has a bend. Change the whammy curve, move the note, or remove Bend. |
| `export.whammy-slide` | warning | Whammy replaces the slide | The export uses the final whammy slide and leaves out the separate slide out. Remove Whammy bar to keep the separate slide. |
| `export.trill` | warning | Trill removed | The note is too short for the trill, or its upper note is above fret 24. Extend the note or select a smaller trill interval. |
| `export.ornament` | warning | Ornament removed | The note is too short for the figure, or a figure note is outside frets 0 to 24. Extend the note, change its fret, or select another ornament. |
| `export.slide-open` | warning | Slide removed from an open string | An open string cannot slide. Use a fretted note to keep the slide. |
| `export.fret` | warning | Note moved to fret 24 | The export limits this note to fret 24, which changes its pitch. Choose a position at fret 24 or below and check the capo. |
| `export.unvoiced` | warning | Note removed: no string or fret | The export leaves out this note because its string or fret is missing or invalid. Assign a valid string and fret position. |
| `export.finger` | warning | Chord has no complete fingering | Some fretted chord notes have no finger number. Assign the missing fingers, or select Rocksmith > No finger numbers (Fingerless). |
| `export.hand` | note | Export sets the hand position | The export received no hand position for this note, so it sets one. Add a hand anchor to choose the position. |
| `export.shape-grip` | warning | Shape removed: invalid grip | The export writes plain notes because this shape cannot use one grip. Use at least two strings and only one fret on each string. |
| `export.shape-mixed` | warning | Shape removed: another note is inside it | A note outside this shape starts between its first and last notes. Add that note to the shape or move it outside the shape. |
| `export.grip-only` | warning | Grip-only note removed | A grip-only note needs an arpeggio or handshape that contains played notes. Add it to such a shape, or turn off Grip only (Ghost gem). |
| `export.phrase-differs` | warning | Phrases with the same name have different notes | Rocksmith gives phrases with the same name shared difficulty levels and scores. Make their notes match, or give this phrase a different name. |
| `export.shape-hand` | warning | Hand position change removed inside a shape | The export keeps the hand position from the start of this shape. Move the hand anchor outside the shape, or change the fingering. |

## Editor issues

| ID | Severity | Title | Help |
|---|---|---|---|
| `editor.note.outOfRange` | warning | Note is outside the fret range | No string can play this pitch within the selected fret range. Change the pitch, tuning, or fret range. |
| `editor.note.stack` | warning | Notes with the same pitch overlap | Notes with the same pitch overlap on the same string or have no separate string positions. Remove the overlap or place them on different strings. |
| `editor.note.bendStack` | warning | Bend points have the same time | Rocksmith keeps only the first bend point at this time. Move or remove the other points. |
| `editor.import.pickSlide` | warning | Imported pick slide has no conversion | The imported pick slide has no pick-slide effect in the editor. Select Pick slide up or Pick slide down in the Slide menu. |
| `editor.import.harmonic` | warning | Harmonic type is not supported | Rocksmith supports natural and pinch harmonics. Select Natural or Pinch in the Harmonic menu. |
| `editor.import.leftTap` | warning | Left-hand tap is not shown | Rocksmith has no separate notation for a left-hand tap. Select Tapping under Slap / pop to represent it as tapping. |
| `editor.import.ornament` | warning | Imported ornament is not shown | Select a figure in the Ornament menu to convert this imported turn or mordent to notes for Rocksmith. |
| `editor.import.barVibrato` | warning | Whammy vibrato is not shown | Rocksmith has no whammy-bar vibrato notation. Enable Vibrato to show finger vibrato instead. |
| `editor.import.golpe` | warning | Golpe is not supported | Rocksmith cannot show a tap on the guitar body. The Guitar Pro export keeps this technique. |
| `editor.import.rasgueado` | warning | Rasgueado is not supported | Rocksmith shows the chord notes without this strum technique. The Guitar Pro export keeps the technique. |
| `editor.import.deadSlapped` | warning | Imported dead slap has no conversion | The imported dead slap is not fully represented by the editor effects. Select Slapping under Slap / pop and enable Dead / muted note. |
| `editor.effect.ghost` | warning (reserved; not emitted) | Ghost dynamics are not supported | Rocksmith cannot show the quiet dynamics of this note. |
| `editor.effect.staccato` | warning | Staccato needs a shorter note | Rocksmith has no staccato notation. Shorten the note to represent the short sound. |
| `editor.effect.letRing` | warning | Let ring needs a longer note | Rocksmith has no let-ring notation. Extend the note to represent how long it sounds. |
| `editor.effect.strum` | warning (reserved; not emitted) | Strum direction is not supported | Rocksmith has no strum-direction notation. It shows the chord without the picking direction. |
| `editor.adapt.pickSlide` | note | Pick slide uses a muted slide | Rocksmith has no pick-slide notation. The export represents the pick slide with a tapped, muted slide. |
| `editor.adapt.ghost` | warning | Ghost note is not scored | Rocksmith has no ghost-note dynamics. The export shows this note but excludes it from scoring. |
| `editor.adapt.trill` | note | Trill uses hammer-ons and pull-offs | Rocksmith has no trill notation. The export writes alternating notes with hammer-ons and pull-offs. |
| `editor.adapt.grace` | note | Grace note uses a short hammer-on | Rocksmith has no grace-note notation. The export writes a short note before the main note and connects the notes with a hammer-on. |
| `editor.adapt.whammy` | warning | Whammy uses slides | Rocksmith has no whammy-bar notation. The export uses slides to represent the pitch changes. |
| `editor.adapt.ornament` | note | Ornament uses hammer-ons and pull-offs | Rocksmith has no turn or mordent notation. The export writes the figure as notes with hammer-ons and pull-offs. |
| `editor.adapt.artificial` | warning | Artificial harmonic uses pinch harmonic notation | Rocksmith has no separate notation for this artificial harmonic. The export uses pinch harmonic notation. |
| `editor.shape.stretch` | warning | Chord needs a large hand stretch | The editor found a fingering that needs a large hand stretch. Change the string positions or notes if the stretch is too difficult. |
| `editor.shape.impossible` | warning | Chord has no valid fingering | The editor found no fingering for these notes with the current tuning, fret range, and fixed positions. Change the notes or their string positions. |

## Marker issues

| ID | Severity | Title | Help |
|---|---|---|---|
| `marker.anchor-out-of-reach` | warning | Hand anchor at fret {fret} cannot reach the note | The hand cannot reach the note from this anchor, so the anchor is not used. Move the anchor or select another fret. |
| `marker.tone-preset-missing` | warning | Tone preset is missing: {preset} | The sound library does not contain this tone preset. Select another preset or import the missing preset. |

## Export warnings

The ID identifies the condition. A skipped switch or moved marker changes only the export, not the project.

All entries have warning severity. The live check returns structured `warningIssues` beside the legacy string `warnings` list.
Package export retains the string interface, with IDs available on the Python warning objects.
The last four entries occur during package export only.

| ID | Title | Help |
|---|---|---|
| `export.tuning-octave` | Tuning offset {offset:+d} changed to {reduced:+d} | The export changes this string's tuning by whole octaves. Check the layer tuning if this change is not intended. |
| `export.bass-reference` | Low bass tuning uses a lower tuning reference | The export raises the string tuning offsets by one octave and halves the tuning reference. This helps Rocksmith detect low bass notes without changing their pitches. |
| `export.tone-unknown` | Tone switch skipped: unknown preset {preset} | The export skips this tone switch because it cannot find its preset. Select another preset for the switch. |
| `export.tone-outside-song` | Tone switch skipped at {time:.3f}s | The export skips this tone switch because it is outside the song. Move the switch between the start and end of the song. |
| `export.section-unknown` | Section type changed to riff: {name} | The export uses Riff for this unsupported section type. Select a supported type in the section marker. |
| `export.section-snapped` | Section moved to a measure boundary: {name} | The exported section starts at the nearest measure boundary. Move the section marker to that boundary to keep its position in the export. |
| `export.section-collision` | Only the last section at {time:.3f}s is exported | Multiple section markers use the same exported measure boundary. Only the last one is used. Move the markers to different measure boundaries. |
| `export.phrase-snapped` | Phrase boundary moved from {time:.3f}s | The export moves this phrase boundary to the nearest beat. Place the boundary on a beat to keep its position. |
| `export.multiple-lanes` | Only one layer is exported: {name} | The export has no arrangement selection and uses only this layer. Select an arrangement for each required layer in Rocksmith export. |
| `export.metadata-characters` | Characters removed from {field}: {characters} | Rocksmith cannot show these characters. Replace them or enter a Latin spelling for this field. |
| `export.japanese-characters` | Characters removed from Japanese {field}: {characters} | The Rocksmith font cannot show these characters in the Japanese field. Replace them with supported characters. |
| `export.difficulty-reduced` | {arrangement}: fewer difficulty levels in {phrases} | These phrases have fewer difficulty levels than at the previous export. Saved progress from earlier versions may no longer match these levels. |

## Compilation failures

These messages appear after `Not exported:` and contain their own explanation and action.
There is no separate help field. The lower-level chart compiler also uses `export.string-count`
with: "Rocksmith needs a layer with 4 to 6 strings. This layer has {count} strings."

All entries have error severity. The live check returns `errorId` beside the existing `error` explanation.

| ID | Message |
|---|---|
| `export.string-count` | Rocksmith needs a 6-string guitar or 4-string bass. This layer has {count} strings. |
| `export.arrangement-tuning` | {arrangement} needs a {required tuning} tuning. Change the arrangement type or the layer tuning. |
| `export.tone-limit` | Use four or fewer tones per arrangement, including the base tone. |
| `export.beat-grid` | The song is too short for this beat grid. Check the tempo and grid start, or extend the song. |
| `export.no-voiced-notes` | There are no playable notes to export. Add notes with valid string and fret positions and turn off Grip only where needed. |
| `export.note-limit` | The export contains {count} notes. The export limit is 32,000 notes per arrangement. Remove notes or reduce the use of trills and ornaments. |
| `export.compile-failed` | The explanation from the compilation failure. |
