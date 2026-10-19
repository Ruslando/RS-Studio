# Tone presets

Open **Settings > Tone presets**, choose a starting point and edit any field.
Your first change automatically creates an editable preset while preserving the
original starting point. **New preset** starts with an amplifier and cabinet;
**Duplicate preset** copies the current preset, including its settings.
Changes to your library are staged until **Apply**;
**Apply** keeps the window open and establishes the saved baseline. Escape and
closing discard edits made since the last Apply. **Apply** appears only with pending edits.
The Preset header shows **Unsaved changes** while the library has staged edits.
**Delete preset** sits with the other preset actions and applies to your own presets.

The six starting points (Clean, Crunch and Overdrive for guitar and bass) are
ordinary JSON files in `presets/sounds` under the app's data directory.
Add files there and reopen the editor.
**Import preset** reads individual tones or a library into the editing draft.
**Export preset** downloads the selected tone. These actions sit below the preset selector alongside New, Duplicate and Delete. Imports are kept only after
**Apply**, and repeated settings are skipped. Invalid files are reported
without silently changing parameters. Only JSON is supported, with no XML or
PSARC import. See [Preset files](../presets/README.md) for sources, limits and
the supported JSON shapes. Folder presets are directly selectable on project
tone markers as references to their current app-library values. The marker's
Tone Designer button opens the referenced app preset directly.

The pane has three collapsible sections: **Preset**, **Signal chain** and
**Device settings**. A collapsed section's header still names its content
(preset name and effect count), and the layout is remembered.
A preset that blocks saving reopens the section holding the invalid field.
With every section open the pane scrolls, keeping the device editor usable.

The signal chain runs horizontally above the editor: pre-amp pedals (in front
of the amp), amplifier, effects loop (between preamp and power amp), cabinet and
rack effects (after the cabinet). Select a device card to
edit it below; each effects bank has an explicit add action. Full chains scroll
horizontally, and selecting or moving a device keeps its card in view.
Cards shrink before the chain scrolls; a cut-off edge fades out to show that
more cards follow. Click the selected card again to replace that device.
Each signal-chain stage has a separate framed group with its own heading and
connectors between groups. The chain expands to use the available width. Each effect card has a remove
icon and drag grip. Drag cards before or after other effects, or onto a bank
heading to append them. Pedals can move between the pre and loop banks; rack
effects stay in the rack. From the keyboard, Alt+←/→ moves a focused effect card
(across the amp between the pedal banks) and Delete removes it. A bank that
already holds effects shows a slim + tile beside them.
The editor shows device-shaped controls (see below), with no permanent device browser.
Clicking the selected device card opens a searchable picker with an inline device list
(double-click or Enter applies the selection). **Add effect** uses the same picker;
Closing the picker leaves the preset unchanged. Its Apply action appears only
when a different device is selected, or when adding an effect. An unchanged cabinet model retains
its microphone position. Cabinet model selection and microphone/position
selection are separate. Preset name and volume share a row; descriptions sit on the next. Descriptions are
tags: each has its own picker and remove button, and **+ Add** appears until
the native maximum of three.
Smaller windows keep the chain scrollable and stack the controls.
Switching devices resets the editor scroll position. Chain edits retain keyboard
focus, and a preset that blocks saving is revealed even from another settings pane.

- 63 amplifiers, including guitar, bass and direct models.
- 58 cabinet models, represented by 450 native microphone/position variants.
- 83 pedals and 17 rack effects.
- All catalogue parameter names, ranges, slider steps, units, defaults and
  discrete choices. A compressor ratio, for example, stores its native switch
  index while displaying `1.5:1`, `2:1`, `4:1`, `8:1` or `20:1`.
- Up to four effects in total, matching Rocksmith's in-game Tone Designer.
  DLC Builder can technically write more, but warns that loading such a tone
  into the game's Tone Designer may crash it. This editor enforces four.
- Move effects within their bank and pedals between pre and loop banks.
  Rack effects remain in the rack. Parameter values travel with the device.
- A control that differs from the value the preset had when opened shows a
  small ↺ to return to it. Changing a device's model loads the new model's defaults.
- One to three native tone descriptions and the DLC Builder volume scale
  (stored with its native inverted sign). Legacy prototype volume settings are
  retained, including negative display values.

Number fields allow exact manual values, including values between slider ticks,
as DLC Builder does. Discrete controls require a listed option. Invalid input is
retained and highlighted; saving and export refuse it instead of clamping it or
substituting a different tone. Older finite out-of-range prototype parameters
remain available for explicit correction.
Controls follow the hardware they model:

- Amps, pedals and rack effects use dials. Drag up/down (Shift for fine steps)
  or use the arrow keys; the value field below accepts exact input. The default
  is marked on the ring and labelled; click the label or double-click the dial
  to reset.
- Fixed-band graphic EQs (5- and 8-band pedals) use one vertical fader per band.
- Parametric rack EQs show a frequency-response curve. Drag a numbered point to
  set that band's frequency and gain; exact fields per band sit below, with Q
  as a switch. The curve uses standard shelf/peak filter shapes as an
  illustration; Rocksmith's own DSP is not documented.
- Short discrete choices (on/off, filter type, ratio, waveform) are segmented
  switches; the catalogue default carries a dot. Cabinets choose microphone and
  position as two switches.

Click a device card to select its controls; click the selected card once more
to replace the device. The selected card has an accent border and icon.
Device settings centre the controls horizontally and vertically when they fit;
larger control sets remain scrollable from the top. The Tone presets window uses
additional height when the viewport allows it. Device settings show only the
controls, without a repeated device-name label.
Only when the device controls need an internal scrollbar does the expand button
appear. Its modal fills the Settings content area while keeping the navigation
and outer window bounds in place. Edits remain in the same draft; Close or Escape returns the
controls to Settings. Apply commits those edits as usual.
Parametric EQ bands use compact columns with numbered band names, gain,
frequency and Q. Numeric readouts show catalogue units, with semitones for
pitch, bits for bit depth and dB for preset volume. Normalized controls retain
their unitless catalogue scale.

Every default comes from the game's catalogue. Volume uses the
same scale component with a zero default. Manual input keeps its exact value,
including values between the slider's native steps.

Saving preserves entries that this app cannot load, rather than silently
removing them. Malformed library JSON is protected against replacement. If
another window changes the library during editing, saving is refused and the
draft stays open. Reopen Settings to load the newer library before editing it.
An unchanged library is never rewritten when applying other settings.

Projects reference existing app presets, so library edits update their tones.
Portable `.chart` files carry tone definitions. On import, an available preset
remains a reference; only unavailable imported tones become editable Project
presets. Missing references without a usable definition show a warning. CDLC
export resolves references to the current app preset values.

## Source and verification

The catalogue comes from MIT-licensed
[Rocksmith2014.NET / DLC Builder](https://github.com/iminashi/Rocksmith2014.NET/tree/4cf3325174e13f1dc5ce997e7663b2851c6afcce),
pinned to commit `4cf3325174e13f1dc5ce997e7663b2851c6afcce`:

- `samples/DLCBuilder.Domain/Tones/tone_gear_data.json`
- `src/Rocksmith2014.Common/Manifest/ToneDescriptors.fs`

`tools/sync-tone-gear.py SOURCE_DIR REVISION` generates the frontend module and
the packaged backend catalogue from the same source. The source checksum and
revision are embedded in both. The app needs no download at runtime.

Tests cover every device's defaults and numeric endpoints, frontend/backend
catalogue equality, native switch indices, parameter preservation during chain
edits, library staging, project portability and packaged manifest output. These
checks establish file/data compatibility; they are not an in-game listening test.

The designer authors native tone settings. Audition tones in Rocksmith; the
designer does not provide an audio preview.
