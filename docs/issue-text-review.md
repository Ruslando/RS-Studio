# Issue text review

Reviewed all 102 categories against their trigger conditions, export conversion, and available editor controls.
Revised 84 entries. Kept the remaining entries after checking them. IDs, severity, and detection rules are unchanged by this text review.
The two reserved definitions are listed explicitly. The complete current titles and help text are in [the issue catalogue](issue-catalogue.md).

Review criteria: Does the text describe the actual condition? Does it distinguish exported changes from project edits?
Does it name an available action? Does it avoid irrelevant implementation details and references to other warning messages?
The wording follows the project's ASD-STE100 guidance: short sentences, consistent technical names, and direct instructions.
This review checks the implementation and its existing tests. It does not independently validate game-engine behavior or certify dictionary compliance.

The DLC Builder titles and detector logic remain intact. Some retained checks concern generated data that users cannot edit directly;
those explanations identify the export problem rather than inventing a control.
The generic `export.compile-failed` fallback still carries the original exception text, which varies with the cause.

| ID | Decision | Evidence in code | Review result |
|---|---|---|---|
| `export.chord-dead-note-removed` | Revised | `_voiced_entities` | Only dead chord notes are omitted; keeping a fully muted chord requires the actual muting control. |
| `export.slide` | Revised | `_emit_notes` | The next onset must offer a different, non-open fret on the same string; the advice matches these constraints. |
| `export.late-fx` | Revised | `_split_late_effects` | Bends prevent splitting the note for late effects; states the timing change and cause. |
| `export.grace` | Revised | `_add_grace_notes` | Failure includes fret zero, no time before the song start, or another onset on the same string. |
| `export.slide-in` | Revised | `_add_slide_ins` | The added lead occupies the start of the note, not time before it; covers overlap, duration, and fret reach. |
| `export.whammy` | Revised | `_whammy_as_slides` | Rounded offsets must stay in frets 1–24 and the note must not have a bend; suggests curve or fret edits. |
| `export.whammy-slide` | Revised | `_whammy_as_slides` | Only a final moving whammy segment replaces the separate slide; explains how to keep that slide. |
| `export.trill` | Revised | `_trill_as_hammers` | Failure is a short duration or upper fret above 24; avoids fixed-rate instructions in the hover text. |
| `export.ornament` | Revised | `_ornament_as_hammers` | Failure is duration or a figure pitch outside frets 0–24; offers note length, position, and figure choices. |
| `export.slide-open` | Kept | `_emit_notes` | The string is open; using a fretted note is the necessary correction. |
| `export.fret` | Revised | `_voiced_entities` | Clamping changes pitch, not just appearance; the user must check position and capo. |
| `export.unvoiced` | Revised | `_voiced_entities` | Missing, negative, and out-of-range string positions are covered; avoids implying only absent fields can fail. |
| `export.finger` | Revised | `ensure_chord_template` | An incomplete fingering differs from intentional Fingerless; presents both available choices. |
| `export.hand` | Revised | `_hand_anchors` | The export received no hand position; a hand anchor is the supported way to choose one. |
| `export.shape-grip` | Revised | `_voiced_entities` | One grip requires at least two strings and one fret per string; also states that the notes still export. |
| `export.shape-mixed` | Revised | `_voiced_entities` | An outside onset lies between the shape first and last notes; names the offending relationship and available fixes. |
| `export.grip-only` | Revised | `_voiced_entities` | A grip-only note needs played shape members; names the actual toggle for making it a played note. |
| `export.phrase-differs` | Revised | `_phrase_differences` | The comparison uses note timing and pitch positions; explains shared levels and scoring without claiming a removed effect. |
| `export.shape-hand` | Revised | `_hand_anchors` | The first shape position is retained and later changes are skipped; anchor or fingering edits are supported. |
| `I01` | Revised | `_check_crowd_events` | Only a missing end for Intro applause triggers this check; removed the broader applause claim. |
| `I02` | Revised | `_check_crowd_events` | The marked crowd event lies between the first intro and end events; moving it is supported. |
| `I03` | Revised | `_check_link_next` | A linked single note reaches a chord; offers shift-slide or single-note alternatives. |
| `I04` | Revised | `_check_link_next` | No target exists on the string; removal advice is conditional on an actual legato slide. |
| `I05` | Revised | `_check_link_next` | The slide target disagrees with the linked note; does not promise a separate target-fret setting. |
| `I06` | Revised | `_check_link_next` | Different linked frets lack a matching slide; legato and fret changes are available. |
| `I07` | Kept | `_check_link_next` | The last and first bend values differ; the bend-point editor provides the stated correction. |
| `I08` | Revised | `_check_link_next` | The sustain ends before the target; extending the note addresses the measured gap. |
| `I09` | Revised | `_check_notes / _check_chords` | The issue requires both an unpitched slide and a link; uses available slide choices. |
| `I10` | Kept | `_phrase_change_on_sustain` | A non-mover phrase boundary crosses linked sustain; preserves the difficulty-level consequence. |
| `I11` | Revised | `_check_notes / _check_chords` | Both harmonic flags are present; the Harmonic menu selects one type. |
| `I13` | Revised | `_check_notes / _check_chords` | A scored fret-7 natural harmonic has sustain; names the actual Not scored (Ignore) action. |
| `I14` | Revised | `_check_notes / _check_chords` | Every bend value is zero; changing the points or removing Bend addresses this condition. |
| `I15` | Revised | `_check_notes / _check_chords` | A tone switch and note share a time; explains why the switch belongs before the note. |
| `I16` | Kept | `_in_noguitar` | A note or chord starts inside No Guitar; both section type and note time are editable. |
| `I18` | Revised | `_check_chords` | A parent chord has no parent chord notes; avoids inventing an editable chord-link control. |
| `I20` | Revised | `_check_handshapes` | The hand position conflicts with fingering; removed an overly specific lowest-fret claim. |
| `I27` | Revised | `_strange_fingering` | The finger numbers suggest a crossing; avoids declaring every such fingering physically impossible. |
| `I28` | Kept | `_barre_over_open_strings` | An open string lies between uses of one finger; changing fingering is an available correction. |
| `I29` | Revised | `_muted_string` | Dead and pitched notes share a chord; names the Dead / muted note control instead of requiring deletion. |
| `I21` | Kept | `_check_anchors` | A hand change occurs inside a shape; move its anchor outside the shape. |
| `I22` | Revised | `_check_anchors` | The crossing also has a phrase or section boundary; now explains the hand-position interaction. |
| `I23` | Revised | `_check_anchors` | A hand change is very near an unpitched-slide end; points to the hand anchor. |
| `I25` | Revised | `_check_phrases` | Notes occur in the first phrase; names the available Leading silence setting. |
| `I26` | Revised | `_check_phrases / chart._beats_phrases_sections` | END is generated and reserved, so manual creation is inappropriate; identifies an exporter failure. |
| `I30` | Revised | `_check_phrases` | The limit counts phrase occurrences, not distinct names; mentions both phrase and section markers. |
| `I31` | Revised | `_check_notes` | The previous note or its slide endpoint supplies the same fret; the old wording omitted slide endpoints. |
| `I32` | Revised | `_check_notes` | Finger changes are inferred from hand positions; the wording now marks this as an inference. |
| `I33` | Revised | `_check_notes / _check_chords` | The anchor changes on a pull-off; the hand-anchor rail supports moving it. |
| `I34` | Revised | `_overlapping_bend` | Multiple points can share a time; the instruction now covers all overlapping points. |
| `I35` | Revised | `_check_notes` | A natural harmonic carries bend values; names the actual Bend and Harmonic controls. |
| `I37` | Revised | `_check_phrases / section-marker-core.phraseName` | mover names are reserved and rejected by the editor; does not instruct users to enter an unavailable name. |
| `I36` | Kept | `_check_notes / _check_chords` | The bass string index is outside four strings; moving the note addresses the index. |
| `I38` | Revised | `_check_notes / chart._voiced_entities` | The effective exported fret can include a capo; the correction now includes the capo. |
| `I39` | Revised | `_end_time / _check_notes / _check_chords` | Equal-to-end also fails, and audio length matters; the new explanation covers both. |
| `I40` | Revised | `_needs_sustain` | The duration is too short for the technique; extending or removing the technique addresses the check. |
| `I41` | Revised | `check_bass_tuning / builder._tuning_offsets` | The exporter normally applies compensation automatically; does not invent a manual 220 Hz checkbox. |
| `I42` | Revised | `check_bass_tuning` | Zero offsets are accepted, so positive-only advice was wrong; points to tuning settings instead. |
| `export.tuning-octave` | Revised | `_tuning_offsets` | Whole-octave folding is an export policy; removed the unsupported claim of a game tuning-range limit. |
| `export.bass-reference` | Revised | `_tuning_offsets / _concert_pitch` | Concert pitch can shift the reference away from exactly 220 Hz; describes halving rather than an exact frequency. |
| `export.tone-unknown` | Revised | `_arrangement_tones` | Only the export switch is skipped; the application does not delete the preset from the library. |
| `export.tone-outside-song` | Revised | `_arrangement_tones` | Only the export switch is skipped; the original project marker remains. |
| `export.section-unknown` | Revised | `chart._beats_phrases_sections` | Unsupported types fall back to Riff; a supported section type can be selected. |
| `export.section-snapped` | Revised | `chart._beats_phrases_sections` | The export uses the nearest measure boundary; the project marker itself does not move. |
| `export.section-collision` | Revised | `chart._beats_phrases_sections` | The last marker at the same exported boundary wins; distinct boundaries avoid the collision. |
| `export.phrase-snapped` | Revised | `chart._beats_phrases_sections` | The export uses the nearest beat; moving the editor marker to a beat prevents the difference. |
| `export.multiple-lanes` | Revised | `_arrangement_specs` | This is the no-selection fallback; explicit per-layer arrangements are available in the export review. |
| `export.metadata-characters` | Revised | `build_cdlc / font / metadata.latinFields` | Unsupported characters are omitted when no usable Latin alternative exists; names the available Latin-spelling remedy. |
| `export.japanese-characters` | Revised | `build_cdlc / font` | The Japanese field also uses the game character set; replacing unsupported characters is the applicable action. |
| `export.difficulty-reduced` | Revised | `_fewer_levels` | Levels fell compared with the prior export; saved-progress effects are conditional, not guaranteed corruption. |
| `editor.note.outOfRange` | Revised | `note-issues / outOfFretboardRange` | Pitch is outside the selected tuning/fret bounds; those are the relevant editable limits. |
| `editor.note.stack` | Revised | `stackClusters` | Separate pinned strings exempt unisons; the text no longer says that every same-pitch overlap is merged. |
| `editor.note.bendStack` | Revised | `stackedBends` | All points at one millisecond are grouped; explains the first-point rule and plural corrections. |
| `editor.import.pickSlide` | Revised | `gpOnlyTechniques / edit.EFFECT_MENU` | The imported technique lacks a pick-slide projection; use the existing directional Slide options. |
| `editor.import.harmonic` | Revised | `gpOnlyTechniques / edit.EFFECT_MENU` | Tapped, semi, and feedback harmonics lack direct representation; Natural and Pinch are valid alternatives. |
| `editor.import.leftTap` | Revised | `gpOnlyTechniques / edit.EFFECT_MENU` | The importer preserves a left-hand tap without the generic tap effect; Tapping supplies the export effect. |
| `editor.import.ornament` | Revised | `gpOnlyTechniques / edit.EFFECT_MENU` | An Ornament selector exists, so manually writing all notes is not the only remedy. |
| `editor.import.barVibrato` | Revised | `gpOnlyTechniques / edit.EFFECT_MENU` | Finger vibrato is an approximation of bar vibrato, not an identical supported technique. |
| `editor.import.golpe` | Kept | `gpOnlyTechniques / guitar-pro-edit` | No Rocksmith projection exists; unchanged imported technique data remains available for Guitar Pro export. |
| `editor.import.rasgueado` | Kept | `gpOnlyTechniques / guitar-pro-edit` | The strum technique is not projected, but the notes and original Guitar Pro data remain. |
| `editor.import.deadSlapped` | Revised | `gpOnlyTechniques / edit.EFFECT_MENU` | The condition can have partial effect settings; the explanation requires both Slapping and Dead / muted note. |
| `editor.effect.ghost` | Kept (reserved) | `DROPPED_TEXT` | Reserved, currently not emitted; describes the unsupported dynamics without claiming that the note disappears. |
| `editor.effect.staccato` | Revised | `droppedEffects / chart._base_note_mask / _ignored` | There is no staccato flag in the Rocksmith output; duration is the user-controlled representation. |
| `editor.effect.letRing` | Revised | `droppedEffects / chart._base_note_mask / _ignored` | There is no let-ring flag in the Rocksmith output; extending duration represents the sounding note. |
| `editor.effect.strum` | Revised (reserved) | `DROPPED_TEXT` | Reserved, currently not emitted; distinguishes chord notes from unsupported picking direction. |
| `editor.adapt.pickSlide` | Kept | `chart._pick_slides` | A tapped, muted slide represents the technique; fret-placement details are unnecessary in the hover text. |
| `editor.adapt.ghost` | Revised | `chart._base_note_mask / _ignored / _emit_notes` | The note remains visible but receives Ignore; describes scoring rather than offering another Ignore action. |
| `editor.adapt.trill` | Kept | `chart._trill_as_hammers` | Alternating hammered/pulled notes are written out; omits rate assumptions and references to other warnings. |
| `editor.adapt.grace` | Revised | `chart._add_grace_notes` | A lower lead note connects to the main note by hammer-on; explicitly starts with the missing Rocksmith notation. |
| `editor.adapt.whammy` | Kept | `chart._whammy_as_slides` | Slides represent the pitch curve; this is not native whammy-bar notation. |
| `editor.adapt.ornament` | Kept | `chart._ornament_as_hammers` | The figure is written as hammered/pulled notes; omits implementation rate and warning-system commentary. |
| `editor.adapt.artificial` | Revised | `chart._base_note_mask / _ignored` | Pinch-harmonic notation represents this artificial harmonic; explains the notation substitution. |
| `editor.shape.stretch` | Revised | `chordPlayability` | A stretch profile found a fingering; the message is an assessment rather than an instruction to change a valid chord. |
| `editor.shape.impossible` | Revised | `chordPlayability` | The solver found no shape under current constraints; avoids claiming universal physical impossibility. |
| `marker.anchor-out-of-reach` | Revised | `markerArtifacts / hand-anchors / holdsByColumn` | An unreachable anchor is not applied by the editor; the wording no longer limits this result to export. |
| `marker.tone-preset-missing` | Kept | `tonePresetMissing` | Both the library preset and usable stored definition are absent; choosing or importing a preset is available. |
| `export.string-count` | Kept | `_tuning_offsets / compile_track` | The package accepts six-string guitar or four-string bass; the lower-level compiler separately accepts 4–6 strings. |
| `export.arrangement-tuning` | Revised | `_compile_arrangement` | Arrangement family and tuning disagree; both arrangement selection and layer tuning are editable. |
| `export.tone-limit` | Kept | `_arrangement_tones` | The four-tone count includes the base tone; the original instruction was already accurate. |
| `export.beat-grid` | Revised | `_beats` | Too few beats remain before audio end; tempo and grid start are more specific corrections than changing an unspecified grid. |
| `export.no-voiced-notes` | Revised | `_voiced_entities` | No played notes remain, including all-grip-only and empty layers; valid string/fret data alone is not sufficient. |
| `export.note-limit` | Revised | `_emit_notes` | The application enforces a 32,000-event ceiling; repeated effects can add events, so editor note count is not the whole explanation. |
| `export.compile-failed` | Kept | `builder.check_spec` | Fallback has exception-specific text, not a fixed message. Preserved the original diagnostic; it cannot be validated as one static sentence. |
