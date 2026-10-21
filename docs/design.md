# RS Studio design system

The rules every screen, window and control in `web/` follows. Read this before
adding or changing UI. If a need is not covered here, extend this document and
`web/components.css` first, then build the feature on the new rule.

**Where things live**

| File | Holds | May contain |
|---|---|---|
| `web/tokens.css` | Every value of the interface | Custom properties only |
| `web/components.css` | Shared components | Tokens only, no screen ids |
| `web/style.css` | Screen layout and the stage palette | Tokens and layout sizes |
| `web/icons.js` | Icons used by more than one module | 24-unit outline paths |
| `web/stage-paint.js`, `web/constants.js` | What the canvas reads from the tokens | No colour literals |

**Checking your work**: `.venv/Scripts/python tools/design-audit.py` opens every
screen in Edge, compares each element's computed style with the tokens and writes
screenshots and `findings.json` to `design-shots/`. A new feature adds no findings.

Section 9 lists where the app does not follow this document yet. Do not copy
those patterns.

---

## 1. Character

RS Studio is a dense desktop tool for one long task: turning a recording into a
chart. The interface is quiet so that the song is the loudest thing on screen.

1. **The song is the colour.** The spectrogram, notes and markers carry hue.
   The interface around them is blue-grey with one accent.
2. **Dark is the default; light is a second theme.** The stage (spectrogram,
   rulers, fretboard) stays dark in both, because its colours are analysis data.
3. **Flat.** No gradients, no shadows on controls, no borders on buttons or
   fields. Depth comes from the surface ladder; shadow is for things that float.
4. **Dense and exact.** Three control heights, three radii, seven spacing steps,
   seven type sizes. Nothing in between.
5. **State is a mark, not a sentence.** A dot, a fill, a dashed border. Words
   explain only in a tooltip or when something went wrong.
6. **Motion reports a change of state** and takes 100–240 ms. Nothing moves to
   decorate.

The project start is a one-pixel vertical rule on the timeline, using the spectral
hint at 30% opacity (50% on hover). Its invisible grab area uses the panel spacing;
the existing splitter's three dots follow the pointer on hover. The line sits one
row spacing to the left of the project start; all markers retain their exact time
positions and alignment. A small leading gutter keeps the line reachable at zero.
Dragging translates all
notation and marker timings together; the audio stays fixed. No content can be
placed before the start, and one drag is one undo step.

---

## 2. Tokens

Use the token, never its value. A value with no token is added to
`tokens.css` with a name that says what it is for, or it is not used.
`var(--x, fallback)` is not allowed: a missing name is a bug.

### 2.1 Surfaces

Each surface has one job. Pick by job, not by how dark it looks.

| Token | Dark | Light | Job |
|---|---|---|---|
| `--workspace-ground` | `#0c121b` | `#e5e7eb` | Behind the editor's panels |
| `--page` | `#101722` | `#eceef2` | Launcher ground; rows that carry fields |
| `--panel` | `#171f2b` | `#f7f8fa` | Windows, sidebar, popovers, menus, toasts |
| `--surface-toolbar` | `#141d29` | `#f2f3f6` | Toolbar, window header and footer, settings navigation |
| `--surface-navigation` | `#131d29` | `#eef1f5` | Launcher's action column |
| `--surface-inset` | `#111a26` | `#eef0f4` | Text fields, selects, the segmented track |
| `--surface-button` / `-hover` | `#243449` / `#30435a` | `#e8ecf2` / `#dce3ed` | Buttons |
| `--control` / `--control-hover` | `#202c3b` / `#2a394b` | `#ffffff` / `#e9edf3` | Chips, keys, drop zones; hover fill of ghost controls and rows |
| `--surface-card` | `= --control` | `= --control` | Cards |
| `--surface-library` | `#1b2635` | `#ffffff` | Project rows in the library |
| `--selection` | accent 22 % on panel | accent 12 % on panel | The selected row or navigation item |
| `--surface-engaged` | `= --accent` | `= --accent` | A toggle that is on |
| `--stage` | `#101722` | `#f7f8fa` | Fretboard panel ground |
| `--scrim` | black 48 % | `rgba(24,30,40,.30)` | Behind a window |
| `--surface-frost`, `--frost-sheen`, `--frost-edge`, `--frost-blur` (6px) | | | Glass over a folded panel. Nowhere else |

### 2.2 Text and lines

| Token | Dark | Light | Use |
|---|---|---|---|
| `--text` | `#f2f3f5` | `#252830` | Content, values, button labels |
| `--label` | `#c0c4cc` | `#5c6471` | Field labels, captions, idle icons |
| `--label-hover` | `#d2d6de` | `#454d59` | |
| `--hint` | `#a5abb7` | `#69717e` | Secondary lines, placeholders, units, disabled text |
| `--on-accent`, `--on-engaged` | `#ffffff` | `#ffffff` | Text on accent |
| `--line` | white 9 % | `rgba(32,40,56,.12)` | Every hairline: borders, separators |
| `--line-mark` | white 24 % | `rgba(32,40,56,.28)` | Dashed drop zone, the info ring |
| `--line-soft` | white 4 % | `rgba(32,40,56,.04)` | Border of a library row |

### 2.3 Accent and status

| Token | Dark | Light | Use |
|---|---|---|---|
| `--accent` / `--accent-hover` | `#355f8d` / `#2b5079` | `#28496d` / `#203c5b` | See "Accent" below |
| `--ring` | accent 30 % | accent 24 % | Focus ring, 2px outside the border |
| `--selection-line` | `= --accent` | | Border of the selected row |
| `--ok` | `#63c398` | `#2e7a55` | Dot: ready, saved, found. The stage uses the same three values |
| `--warn` | `#dda65c` | `#a8762b` | Dot or triangle: missing, unsaved, attention |
| `--error` | `#ef95a6` | `#bd4c66` | Dot: failed. Outline of a destructive button |
| `--destructive` / `-hover` | `#b84960` / `#a94055` | `#b1435e` / `#a43d54` | Fill of the confirming destructive button |
| `--tour-cue` | `#f0b54f` | `#9a5e13` | The walkthrough's highlight. Nothing else |

**Accent** is used for: the primary button, focus, the selected item, a toggle
that is on, the filled part and thumb of a slider or progress bar, a checked
checkbox, the required dot, a drop target while a file is over it, and (as
`--stage-accent`) the playhead and selection on the stage. It is never text
colour on a panel, never a decoration, never a second button in the same view.

**Status colour is never text colour.** A status is an 8px dot (`.dot`) beside
ordinary `--text`; see 4.10.

### 2.4 Elevation

| Token | Use |
|---|---|
| `--e1` | Things that float beside their trigger: menus, popovers, toasts, tooltips, a row being dragged |
| `--e2` | Windows and the launcher card |
| `--e-card` | Library rows |
| none | Everything else, including every button |

### 2.5 Size, radius, spacing

| Height | Value | Radius that goes with it | Used by |
|---|---|---|---|
| `--h-compact` | 24 | `--r-compact` 4 | Menu rows, chips, keys, compact buttons, controls inside a row or popover header |
| `--h-control` | 32 | `--r-control` 6 | Buttons, fields, selects, icon buttons, the segmented control |
| `--h-list` | 44 | `--r-control` 6 | List rows, toasts |
| `--h-chrome` | 48 | (edge of its container) | Toolbar, window header, window footer |
| containers | content | `--r-container` 10 | Windows, panels, cards, menus, popovers |
| dots, tracks | | `999px` | Status dots, progress and slider tracks |

Height and radius always travel together: a 24-high control is never 6-round.
A control is exactly one of these heights unless it is a row whose height comes
from its content (4.13).

| Spacing | Value | Between |
|---|---|---|
| `--s-pair` | 4 | An icon and its label, a label and its field, items in a menu |
| `--s-sibling` | 8 | Two controls side by side, rows in a list |
| `--s-row` | 12 | Parts of one row; padding of a popover, a row, a field |
| `--s-panel` | 12 | Panels of the editor (the gap is the splitter) |
| `--s-group` | 16 | Field groups; padding of a window body and a button |
| `--s-section` | 24 | Sections; padding around a window on the scrim |
| `--s-empty` | 32 | Padding of an empty state |

Padding and gaps use these seven values and nothing else. Hairlines are 1px.
Focus and drop indicators are 2px.

| Width | Value | |
|---|---|---|
| `--w-modal` | 480 | Default window |
| `--w-modal-wide` | 720 | Window with a list or a table |
| `--w-settings` | 860 | Settings |
| `--w-popover` | 320 | Popovers, tour card, loading card |
| `--w-cover` | 96 | The cover-art tile |
| `--w-stepper` | 20 | The up/down pair of a stepper |
| `--h-modal-max` | 640 | A window is at most this, or 80 % of the viewport |
| `--w-edge` | 14 | The strip along a panel edge that folds it |
| `--w-sidebar-mini` / `-peek`, `--h-fretboard-mini` / `-peek` | 28 / 40 | A folded panel, and the same panel under the pointer |
| `--w-pitch-scale` 32, `--h-overview-ruler` 18, `--h-overview-mini` 32 | | Stage furniture |

### 2.6 Type

Two families. `--font-ui` (Atkinson Hyperlegible Next, 400–700) for everything
you read. `--font-mono` (IBM Plex Mono, 400 and 600 only) for everything you
compare: times, counts in a column, sizes, percentages, pitches, shortcuts,
versions. Mono text always has `font-variant-numeric: tabular-nums`.

| Token | px | Style | Use |
|---|---|---|---|
| `--text-title` | 28 | 700 / 1.2 / −.02em | Reserved; no screen uses it today |
| `--text-heading` | 16 | 600 / 1.2 / −.01em | Window title, pane title, name of a library project |
| `--text-body` | 14 | 400 / 1.5 (600 for emphasis) | Sentences, names in a row, popover title (600) |
| `--text-control` | 13 | 400 / 1 (500 on buttons, 600 when selected or primary) | Buttons, fields, field labels, menu items |
| `--text-caption` | 12 | 600 / 1.2 / +.02em in `--hint` for captions; 400 / 1.4 in `--hint` for a row's second line | Section captions, secondary lines |
| `--text-data` | 11 | mono 400 / 1 | Values |
| `--text-small` | 10 | mono | The glyph in `.info` only |

- Weights are 400, 500, 600, 700. Line heights are 1, 1.2, 1.4, 1.5.
- Sentence case everywhere. No uppercase, no `text-transform`.
- Letter spacing only as in the table.
- The sizes are the same everywhere: the editor, windows and the launcher use
  one scale, so a component looks the same wherever it sits. Never write a
  pixel size.
- Truncate with an ellipsis; never wrap a row's name. Sentences wrap
  (`text-wrap: pretty`).

### 2.7 Motion

| Token | ms | Use |
|---|---|---|
| `--dur-state` | 100 | Hover, press, selection, colour |
| `--dur-overlay` | 160 | A toast, a tour card, a drop highlight appearing |
| `--dur-panel` | 240, with `--ease-panel` | A panel folding or resizing |
| `--ease` | | Everything not a panel |
| `--dur-spin` | 800 | One turn of a spinner, linear |
| `--dur-sweep` | 1400 | One pass of an indeterminate progress bar |
| `--dur-note*`, `--ease-note*`, `--note-*` | | Notes on the stage only |

Windows, menus and popovers appear without animation. Dragging follows the
pointer with no easing. Every transition and animation is switched off under
`prefers-reduced-motion`.

### 2.8 Layers

One ladder, as `--z-*` tokens in `tokens.css`. A new layer takes a name there,
not a number in between. Only stacking inside one component (0–10) is written
as a number.

| z-index | Layer |
|---|---|
| 0–20 | Inside a panel: splitters 12, edge strips 15, edit outline 20 |
| 50–75 | Anchored: toolbar menus 50, add-audio menu 60, popovers 75 |
| 90 | Launcher |
| 100–130 | Windows: first window 100, editors opened from the editor 110, windows opened from a menu 120, confirmation 130 |
| 200 | Context menu |
| 250–260 | Walkthrough: spotlight 250, card 260 |
| 280 | Loading screen |
| 1000 | Toasts |

---

## 3. Rules that apply everywhere

**Interaction**

1. Every control answers the pointer: hover changes the fill
   (`--surface-button-hover` on buttons, `--control-hover` on ghost controls and
   rows). Cursor is `default`, as in a desktop app; `pointer` is not used on buttons.
2. Focus is the same everywhere: `border-color: var(--accent)` plus
   `box-shadow: 0 0 0 2px var(--ring)`, on `:focus-visible`.
3. Disabled: `--hint` text on a transparent fill; a disabled primary keeps a
   `--control` fill and a `--line` border. An action that cannot run now is
   **disabled, not removed**, and its tooltip says why.
4. Selected is `--selection` with a `--selection-line` border. On is
   `--surface-engaged` with `--on-engaged`. They are different facts and never
   share a look: selected says "this one of the list", on says "this is active".
5. One primary button per view. Its label names the work ("Export", "Create",
   "Import tracks"), not "OK".

**Windows and popovers**

6. A **window** has a scrim and is **staged**: settings are committed with
   **Apply**, shown only while values differ from the last saved snapshot. Apply
   saves without closing the window. Escape
   and the header's close button discard pending edits; there is no duplicate
   Cancel button. Action-only pages such as Models have no
   Apply action. Hide an empty footer.
7. A **popover** has no scrim and is **live**: each field applies as it changes.
   It has no footer and no primary. The exception is a popover that starts a
   job (Detect notes): it ends in one primary that names the job. Its header,
   padding and rows are those of every other popover.
8. An **action inside a staged window** (Download, Check again, Separate) runs
   when pressed. It is a job, not a value waiting for Apply.
9. A **destructive** action sits in the footer's left slot as an outlined
   button, far from the primary, and opens a confirmation whose confirming
   button is the filled `--destructive`. In a popover it is a compact icon
   button beside the close button. Tone presets groups Import preset and Export
   preset with the preset actions in the content area. In a confirmation that offers two answers (Detach / Move back), both
   stand on the right, the alternative as a default button and then the
   primary; closing the header's × cancels.
10. The header names the object ("Note layer" plus its chip). The body does not
    repeat it.

**Forms**

11. Label above the field, 4px apart; groups 16 apart. A slider is the
    exception: label beside it, value after it.
12. Fields that are read together share a row (title and artist, album and
    year). A field of a few characters never gets a row of its own. Selects
    keep the width of their longest option and share a row with their
    neighbours instead of each taking a line.
13. Five or more groups are split into sections with a caption (`.section`).
    Fewer are not.
14. A set of options that will grow is a dropdown. The segmented control is for
    two or three fixed, exclusive modes.
15. Required is a 4px accent dot after the label (`data-required`). Optional
    says nothing.
16. An explanation belongs to its control: an `.info` mark with the sentence in
    its tooltip, not a paragraph in the form.
17. A width that holds text is measured from the text or left to the layout,
    not guessed as a number.

**Status and feedback**

18. State is a dot, never coloured text: `--ok`, `--warn`, `--error`.
19. A warning inside a row is a triangle with its sentence in the tooltip. A
    sentence that wraps breaks every row beside it.
20. A thing that takes a file has a dashed border. Nothing else is dashed.
21. A wait names what it is waiting for, beside the spinner.
22. Results of an action are a toast. Problems that block the screen are a
    status line (4.10) where the problem is.

**The stage**

23. Every colour the canvas draws comes from `PAINT` or the layer's own colour.
    A colour literal in a renderer is a bug.
24. A layer's hue belongs to everything of that layer: its notes, its row dot,
    its chip, its grip on the fretboard.
25. The stage uses the notation the tablature uses. A mute is an X on both.
26. A mark on the stage never changes size to say something; it changes fill
    (filled against outlined) or opacity.

---

## 4. Components

Use the class in the "Class" line. Other class names found in the stylesheet
are legacy aliases (see 9).

### 4.1 Button

Class: `button` or `.btn`. 32 high, padding `0 16`, radius 6, `--surface-button`,
no border, no shadow, 13px/500, gap 8 between icon and label.

| Variant | Class | Look | Use |
|---|---|---|---|
| Default | `button` | `--surface-button` | Any action |
| Primary | `.primary` | `--accent`, `--on-accent`, 600 | The one action that commits the view |
| Destructive | `.danger` | transparent, 1px `--error` border, `--error` text | Starts a destructive action; footer left |
| Confirm destructive | `.primary.danger` | `--destructive`, `--on-accent`, 600 | The confirming button in a confirmation |
| Compact | `.btn--compact` | 24 high, padding `0 8`, radius 4 | Inside a row, a toast, a popover or on the stage |
| Ghost | `.btn--ghost` | transparent, `--label`; hover `--control-hover`, `--text` | Low-emphasis action beside stronger ones |
| Link | `.link` | no box, 600 | An inline action inside a sentence |

Do not give a button its own height, padding, border or background in a
feature stylesheet. If none of these fits, the component is missing a variant.

### 4.2 Icon button

Class: `.icon-btn` (32×32, radius 6) or `.icon-btn.icon-btn--compact` (24×24,
radius 4). Transparent, `--label`; hover `--control-hover` and `--text`. Always
has `aria-label` and `title`.

- Window header: 32. Popover header, rows, stage: 24.
- Close is the `CLOSE_ICON`. A destructive icon button turns `--error` on hover.
- A toggle carries `aria-pressed`; on is `--surface-engaged`.
- Lock and visibility are icons on every kind of row, never words. Mute is
  the volume control (4.18). Solo is the letter S, as on a mixing desk. The
  full song has no solo; its volume stays in the column the others' use.
- A button that opens a menu or panel carries `aria-expanded`; open is `--selection`.

### 4.3 Text field, number field, select

Class: `input[type=text|number|search]`, `select`, `textarea`, or `.field`.
32 high, padding `0 12`, radius 6, `--surface-inset`, transparent 1px border,
13px. Focus per rule 2. Placeholder `--hint`.

- Number: mono 11, right aligned, no native spin buttons. A unit sits inside the
  field, right after the number, in mono `--hint`: `.pop-field` is the field's
  box and holds the input and a `.pop-unit`, 4 apart, so "BPM" and "s" keep
  the same distance from their value. A unit is never written into the label,
  in brackets or otherwise.
- Select: the native control with the drawn chevron; width follows its longest
  option. Inside a row it is 24 high, radius 4.
- A field inside a row or the stage is 24 high, radius 4.
- A search field is a text field with a 16px search icon inside its left padding.
- A stepper (`.stepper`) is a field with two half-height buttons joined to its
  right edge, each a 12px chevron. A number you count rather than type gets one:
  wrap the input in `.stepper` and mark it `data-stepper`; its `min`, `max` and
  `step` decide what a press does. It is the only control below 24 high.

### 4.4 Slider, checkbox, colour

- Slider (`input[type=range]`): track 6 high in `--slider-track`, radius 4;
  thumb a 4×20 bar in `--accent`. Always in `.field-slider`: label, slider,
  value in `.ro` (mono, `--hint`, 40 wide). Used for every continuous value,
  including scrubbing through audio.
- Checkbox: native, 16×16, `accent-color: var(--accent)`, inside `.chk` with its
  label after it, 8 apart.
- Colour: native swatch, 56×32, padding 4, `--control`, `--line` border.

### 4.5 Field layout

| Class | Layout |
|---|---|
| `.field-group.block` | Label above control, gap 4 |
| `.field-inline` | Label left, control right, on one line |
| `.field-slider` | Label (64 wide), slider, value |
| Sound device parameter row | Slider plus an editable number and unit; discrete device parameters use a select with named options. Invalid values retain their text and use the shared `aria-invalid` field outline. |
| `.field-pair` | Two or more `.field-group.block` on one row, gap 12; `.is-narrow` for a field that keeps its own width |
| `.label` | The label: 13px/400, `--label`. Holds the `.info` mark. `data-required="true"` adds the dot |
| `.info` | 16px ring in `--line-mark` with a mono "i"; focusable; sentence in `title` and `aria-label` |
| `.section` + `.section-head` | A captioned section: caption in 12/600/+.02em `--hint`, then a hairline to the edge |
| `.hint`, `.sp-note` | A sentence under a group: 14/1.5, `--hint` or `--label` |

Text placed directly in a `.field-group` gets the label style, so it looks the
same as a `.label`. Use `.label` when the label holds an `.info` mark or the
required dot.

### 4.6 Segmented control

Class: `.pill` (items carry `aria-checked`). Track 32 high, padding 3, radius 6,
`--surface-inset`, `--line` border. Items 24 high, radius 4, min-width 92,
`--label`; the chosen one is `--control`, `--text`, 600. Two or three items.

### 4.7 Chip, tag, key

| Class | Look | Use |
|---|---|---|
| `.chip` (+ `.chip-dot`) | 24 high, radius 4, `--control`, `--line`, 13px, 8px dot in the entity's colour | Names a layer or audio source inside text or a header |
| `.tag` | Same box, 12/600/+.02em, `--hint` | A fixed category word |
| `.key` | Same box, min-width 24, mono 11 | A keyboard key. `data-rebinding="true"` shows focus while it listens |

### 4.8 Menu and context menu

Class: `.menu` container, `.menu-item` rows, `.menu-sep`, caption
`.ctxmenu-label`. Container: `--panel`, `--line`, radius 10, padding 4, `--e1`,
min-width 172–220. Row: 24 high, radius 4, padding `0 12`, 13px; hover
`--control-hover`; shortcut right aligned in mono 11 `--hint`; a check or a
submenu arrow sits in the same right column: the check is the `check` icon at
14, the arrow is drawn in CSS, neither is a character. Separator: 1px `--line`, 4 above
and below. Items that open a window end in "…". An item another choice rules
out is disabled, says why in its grey note ("Not with a bend") and explains it
in a tooltip beside the row (4.19): a natural harmonic and a bend exclude each
other.

### 4.9 Popover (live editor)

Class: `.live-editor` with `.pop-head`, `.pop-title`, `.pop-x`, `.dp-body`.
320 wide, `--panel`, `--line`, radius 10, `--e1`, fixed and anchored to what
it edits, kept 8 inside the viewport.

- Header: padding `12 12 8`, hairline under it, title 14/600, then compact icon
  buttons: delete (if any) and close.
- Body: padding 12, rows 8 apart, each row a 96-wide label and its field.
- No footer, no scrim; a primary only when the popover starts a job (rules 7 and 9).
- A value that is shown and not edited is a row like any other: its label, then
  a chip for a layer or audio source, or plain text; times in mono.
- A popover that starts a job ends in `.dp-actions`: what the last run did on
  the left (12, `--label`), the primary on the right.

### 4.10 Status

| Class | Use |
|---|---|
| `.dot` + `.dot--ok` / `--warn` / `--error` | 8px round mark |
| `.status-line` (`.status-line--warn` for a warning) | A dot, then the sentence in `--text` 14/1.5. A problem or state in place: failed import, missing tool, shortcut clash |
| `.spinner`, or class `busy` on the element that waits | 12px ring, 2px, `--hint` with a `--text` head, one turn per `--dur-spin`; 16 beside a heading, 24 alone on the stage; with a label beside it |
| Progress bar | 4 high track in `--line`, fill `--accent`, radius 999 |
| `.pt-dot` | The unsaved-changes dot beside the project title, `--warn` |

### 4.11 Toast

Class: `.toast` in `.toasts` (bottom centre, 24 from the edge, stacked 8 apart).
Min-height 44, padding `8 12`, radius 6, `--panel`, `--line`, `--e1`, 13px. A
status dot first; one compact button at most ("Copy", "Undo", "Cancel"). A
progress toast (the progress panel) adds a title (600), one detail line
(`--label`, 12), the current stage and a progress bar, and stays until the job
ends. When to use it: 4.17.

### 4.12 Window

Class: `.dialog` inside `.scrim`. `--panel`, `--line`, radius 10, `--e2`,
width `--w-modal` (wide: `--w-modal-wide`), max-height `--h-modal-max` or 80vh.

| Part | Class | Spec |
|---|---|---|
| Header | `.dialog-header` | 48 high, `--surface-toolbar`, hairline below, padding `0 8 0 16`. Title 16/600 (`.dialog-title`), optionally the object's chip, then the 32 close button |
| Body | `.dialog-body` | Padding 16, groups 16 apart, scrolls. `--sectioned`: sections 24 apart. `--flush`: padding 8, rows 4 apart, for a list whose rows are the controls |
| Footer | `.dialog-footer` | 48 high, `--surface-toolbar`, hairline above, padding `0 16`. Left: destructive action. Right (`.dialog-actions`): Apply only with pending edits, or the window's explicit job action. Hide the footer when empty |

A confirmation is a 480 window with a title, one sentence (`.confirm-msg`) and
a footer of two or three buttons. It has no close button; Escape cancels.
Settings is the one window with a navigation column: 190 wide,
`--surface-toolbar`, `.navigation-item` rows, body padding 24, each pane opening
with `.pane-intro` (title 16/600, without a subtitle).
Appearance uses the same radio preview cards as Timeline scrolling to select
Dark or Light, without a dropdown.
Each preview scales an inert copy of the actual project launcher, using its
existing markup, icons and component styles with the actual theme tokens.
Its radio label stays in the surrounding theme.
The update dialog uses the shared confirmation window, with a channel selector
above its result. Changing the channel saves it and checks again; installing
requires the explicit Update now action.

### 4.13 Rows and cards

Tone switches reference available app presets and use their current values.
Only imported tones absent from the app library retain project-local definitions
and appear in Project presets. The adjacent Tone Designer action selects the
referenced app preset or the imported project preset. Apply edits that target;
closing discards the draft. Missing references without definitions show warning
triangles and one warning toast on project load. Portable exports carry tone
definitions, which imports use only when their app preset is unavailable.

The tuning editor uses one row per string, lowest at the bottom by default.
A String order selector reverses the display and persists this view preference
without changing the tuning or string numbers. Tunings uses the standard Settings
height; Editor and Tone presets use the taller window. Spectrogram and Fretboard
reuse the Tone presets disclosure component and remember their collapsed state.
Fretboard settings use two columns for String order and Fret numbers, with full-width
Note labels, Animation and Onion skin groups. Peer groups have section spacing;
labels and controls have sibling spacing. Its preview uses the live fretboard's
projection and hand renderers, cropped at physical fret 12 while preserving the
instrument's taper, inlays and strings. Its demo plays three different grips and a
major pentatonic run up and down. Enable playback animation controls transitions
and string attack effects; switching it off keeps the phrase progressing with
immediate note changes. Note appearance and Timeline scrolling use the editor's
shared note-row and time-grid painters. Note label font size offers 10, 12, 14 and
16 px and affects both the editor and its preview. Slider readouts stay on one line.
Height changes use the panel duration and easing, and
respect reduced motion. The editor scrolls independently of the preset list.
Each row shows its
string number, a pitch button and separate minus/plus buttons for semitone
changes. The pitch button reveals inline Note and Octave fields. Whole-tuning
transpose actions share the Open strings heading; the preset list stays separate.

| Class | Spec | Use |
|---|---|---|
| `.list-row` | 44 high, padding `0 12`, radius 6, gap 12; hover `--control-hover`; `data-selected` | A selectable row |
| `.list-row--fields` | Same, `--page`, `--line` border, no hover | A row that carries its own controls (24 high, radius 4) |
| `.stem-row`, `.lane-row` | min 44, name 14, second line 12 `--hint`, compact controls right | Layer rows in the sidebar. The active one is selected |
| `.navigation-item` | min 32, padding `8 12`, radius 6; current is selected and 600 | Settings navigation, launcher actions |
| `.card` | `--surface-card`, `--line`, radius 10, padding 16 | A self-contained group |
| `.recent-item` | Card on `--surface-library`, `--line-soft`, `--e-card`; 52px cover, name 16/600, context 13 `--label`, facts 12 `--hint` | A project in the library |

In a row: name in `--text` 14, at most one second line. A lone value in its own
column is mono 11 `--hint`; a summary that mixes words and values is 12
`--hint` in the UI font. Row actions are compact icon buttons that appear on
hover or focus when they are secondary.

### 4.14 Drop zone

1px dashed `--line-mark`, radius 10, `--control`, padding 12, an upload icon,
a title (14/600) and at most one line under it. Hover or a file over it:
border `--accent`. With a file: the file name is the title and a remove button
sits on the right.

Cover art (`.cover-picker`) is the same zone as a square tile, `--w-cover` (96)
on each side. Empty, it shows a frame mark and "Choose image"; with a picture,
the picture fills it, the border turns solid and a compact remove button sits
in its top right corner. It stands left of the fields it belongs to
(`.cover-row`: the tile, then a `.field-stack`), level with their first row.

### 4.15 Editor chrome

| Part | Spec |
|---|---|
| Toolbar (`.bar.toolbar`) | min 48 high, `--surface-toolbar`, `--line`, radius 10, padding `8 12`; groups 8 apart, split by `.sep-v` (1×24 hairline) |
| Panels | `--panel` or the stage ground, radius 10, 12 apart; the gap is the `.splitter`, whose three dots appear under the pointer |
| Sidebar | Sections with a `.side-label` header (32 high, chevron, caption 12/600) and a list of layer rows; one compact "+" button under each list. Header and rows share both edges, and the first header is as far from the panel's top as the rows are from its left: 8 |
| Edge strip (`.edge-toggle`) | 14 deep along the whole edge of a panel; a fade and a chevron appear under the pointer. A folded panel keeps 28 visible, 40 under the pointer, frosted |
| Tour | Spotlight cut out of the scrim, radius 6, outlined in `--tour-cue` when it asks for an action; card as a popover with compact buttons |

### 4.16 Icons

One family: 24-unit grid, outline, `stroke="currentColor"`, round caps and
joins, **stroke-width 1.8**, `aria-hidden`. Drawn at 16 in controls, 14 in
compact controls and for the close mark, 12 for a chevron, 18 as the
leading mark of a launcher action or drop zone, 22–24 only in an empty state
or a cover placeholder. An icon used by two modules lives in
`icons.js` and is placed with `data-ui-icon` (16, or `data-icon-size`) or
`icon(name, size)`; markup is never pasted twice. A character (✓, ▸, ▲) is not an icon.

### 4.17 Waiting and loading

Every wait is one of five kinds. Which one follows from a single question: what
can the user do meanwhile?

| Kind | When | How it is shown | In code |
|---|---|---|---|
| **Job** | Takes noticeable time; the user can keep working | The progress panel (4.11): title, one detail line, the stage it is in, a bar, Cancel where the server supports it. The window or popover that started it closes | `operationRequest`, `uploadRequest`, `jobRequest` in `operation-progress.js` |
| **Blocking load** | Nothing can be done until it ends, usually because a project is about to open | The loading screen: scrim, title, a running bar — or, when the operation reports its steps, the current step and a measured bar. A failure is said there, with Back | `loadWithScreen` |
| **In place** | One part of the screen waits for its own content | The spinner and a label where the content will appear | class `busy` on the waiting element |
| **Row** | A list entry is being made or fetched | The row itself leads with the spinner, or shows its percentage in its second line | class `busy` on the row |
| **Short request** | Under about a second | The button that started it is disabled | `disabled` |

- The result of any of them is a toast: `ok` when it worked, `error` when it did
  not. A sentence in a window is only for a problem with what the user entered,
  in a form that stays open.
- No status text in the toolbar, and no "…ing" lines in windows.
- A percentage is shown only when it is measured. The panel never invents one
  from elapsed time.
- A job names its stages in plain words ("Calculating fingerings", "Building
  the package"), without an ellipsis: the bar already says it is running.
- One wait, one place: a card or row that belongs to a running job shows the
  spinner, and the bar lives in the panel.

| Wait | Kind |
|---|---|
| Detect notes, separate audio, every audio upload, attach audio, Rocksmith export, Guitar Pro export, update | Job |
| Open a project, import a .chart, load the walkthrough, create a project, import Guitar Pro, install acceleration | Blocking load |
| Fingering on the fretboard, reset preview, building the tablature, the add-audio menu, checking the audio converter | In place |
| Model download, an audio layer being added, a stem card being separated or uploaded, the cover tile | Row |
| Save, export .chart, check for updates, check again, remove a model, delete a project | Short request |

### 4.18 Volume

Class: `.vol`, made by `volumeControl()` in `volume.js`. A compact (24×24)
ghost icon button with the speaker at 14. Cursor `ew-resize`. While it is
pointed at, dragged or focused, the level (mono 11, the number without its
%) fades in over `--dur-state` in place of the speaker, so nothing in the row
moves.

- Click mutes. Muted is on: `--surface-engaged`, the struck speaker.
- A sideways drag sets the level, 200px for 0–100 %, Shift for a fifth of
  that, as the Position field of a marker is scrubbed. Arrow keys step 5 %.
- Silent because of something else (the bus is muted or at zero, another
  stem is soloed) is `.dim`: the whole control in `--hint`.
- Every layer row ends in one. The two sidebar headers hold the bus's (all
  note layers, all audio layers) inside their box, in the same column as the
  rows' controls. A layer is heard at its level times its bus's.
- The layer windows keep their slider (4.4) for the same value.

---

### 4.19 Tooltip

Class: `.tooltip` (`.app-tooltip` in `tooltip.js`). `--panel`, `--line`, radius
6, `--e1`, at most 240 wide, 13/1.4. It appears 400 ms after the pointer
arrives, below it and kept 8 inside the viewport, and closes on leave, click,
wheel or a key; moving straight to another tip shows that one without the wait.
Any element gets it with `data-tip` (first line the title) and `data-tip-tone`;
a canvas mark calls `showTooltip` with the pointer and a list of blocks. A block
is an optional caption line (the warning triangle in `--error` or `--warn`, then
"Error" or "Warning" in 12 `--label`), a 600 title in `--text` and the
explanation in `--label`; blocks are divided by a hairline, errors first.
Beside a menu row it opens to the right of the row instead, so it does not
cover the rows below. The browser's own `title` tooltip is still used elsewhere.

## 5. The stage

The stage has its own palette because it sits on a dark picture in both themes.
`--spectral-*` are the fixed colours of the spectrogram and everything drawn on
it; `--stage-*` follow the theme for stage chrome outside the picture (the
fretboard pin, rulers in light theme). The canvas reads both through
`PAINT` / `UI_PAINT` in `stage-paint.js`.

| Token | Value | Is |
|---|---|---|
| `--spectral-ground` | `#0f1012` | Ground |
| `--spectral-text` / `-label` / `-hint` | `#edeef0` / `#a2a5ac` / `#787c84` | Text ladder |
| `--spectral-chrome` / `-hover` | `#24282f` / `#262930` | Flags and boxes on the picture |
| `--spectral-accent` | `#74a9ff` | Playhead and selection |
| `--spectral-grid-bar` / `-beat` / `-sub` | white 45 / 20 / 6 % | The meter: the only place with three line weights |
| `--stage-marker` / `-idle` | `#60a5fa` / `#94a3b8` | Tempo and meter flags |
| `--stage-section` | `#ea580c` | Section markers |
| `--stage-phrase` | `#0d9488` | Phrase boundaries |
| `--stage-tone` | `#9333ea` | Tone switches |
| `--stage-shape` | `#c4a7ff` | Chord-shape boxes |
| `--stage-trace` | `#f0abfc` | Find-similar suggestions |
| `--stage-ref` | `#e7c873` | Linked reference groups |
| `EDIT_PALETTE` | `#6ee7b7 #fbbf72 #a5b4fc #f9a8d4 #67e8f9 #fca5a5` | Layer colours, in order |

- One hue per kind of overlay. A new kind of overlay gets a new named token.
- Transparency has three steps, chosen by what is underneath: `WASH` .14 tints
  data you still read through it; `VEIL` .72 backs chrome that may hide the
  song; `HALO` .85 backs a single glyph. Every glyph on the picture is haloed.
- Text: `stageUi(px, weight)` and `stageMono(px, weight)`. 11 by default; 9
  (`STAGE_ANCHORED`) only for text tied to a note or a pitch row. Values are mono.
- Flags and boxes are rounded 4; note bars 2.
- Canvas constants that mirror a token say so in a comment (`PAD = 16 //
  --s-group`).
- The tablature (`#tabRender`) is a document, not interface: alphaTab's white
  page, engraving type and cursor colours stay as they are in both themes. The
  window around it follows 4.12.

---

## 6. Accessibility

- Every control is reachable by keyboard and shows the focus ring.
- Icon-only controls have `aria-label` and `title`. Decorative marks are
  `aria-hidden`.
- A window is `role="dialog"` with `aria-modal` and a labelled title; focus is
  trapped (`modal-focus.js`) and Escape closes the top layer (`escape-stack.js`).
- Status that changes is announced (`role="status"`, `aria-live`).
- Text on its surface meets 4.5:1 in both themes; check both when adding a colour.
- `hidden` always wins over `display`.

---

## 7. Adding UI: the checklist

1. Is there a component in section 4? Use its class. Do not restyle it locally.
2. No pixel value outside the tables in section 2; no colour that is not a token.
3. Window or popover? Apply rules 6–9 before drawing anything.
4. One primary, named for the work.
5. Labels are `.label`; values are mono; state is a dot.
6. Check dark and light.
7. Add the screen to `tools/design-audit.py` and run it: no new findings.
8. Drive the feature through the UI in `tests/test_e2e.py`.

---

## 8. Changing this system

A new token, variant or component is added here and in `components.css` in the
same change, with the reason. A one-off value in a feature stylesheet is a
deviation and goes into section 9 until it is removed.

---

## 9. Open deviations

The audit of 2026-10-13 found 34 deviations. All but the ones below are fixed.
Remove a line when it is fixed; add one when a deviation is found.

| # | What | Where |
|---|---|---|
| D31 | Three components still run on alias names that are not plain synonyms, so renaming them changes behaviour and is its own piece of work: the segmented control (`.view-switch` / `.keymap-tabs`, chosen by `.active` instead of `aria-checked`), the toolbar menu (`.menu-list`, which also positions itself) and the close buttons (`.sp-x`, `.op-close`, `.pop-x`, whose hover differs from `.icon-btn`). The parts of a window have their names from section 4 | `components.css` |

**Findings the audit reports that are deliberate**

| Finding | Why it stays |
|---|---|
| `height`: launcher actions, library rows, tuning rows, drop zones, cover picker | Rows whose height comes from their content (4.13, 4.14) |
| `height`: edge strips, stepper halves, the cover tile, the input inside the search field or a unit field, a layer row's name | Not controls of their own: part of a larger one |
| `space` 3px in the segmented control | (32 − 24 − 2) / 2: what centres a 24 item in a 32 track |
| `space` 14px beside the sidebar and above the stage | `--w-edge` |
| `space` 34px on the right of a select | Room for the drawn chevron: two `--s-row` plus its 10px |
| `space` 2px in the tour's Next button | Its label may wrap to two lines |
| `space` 40px on the right of a stem card | `--h-compact` + `--s-group`: room for its remove button |
| `shadow` on the sidebar and a layer's dot | A 1px inset `--line` and a 2px ring; hairlines, not elevation |

---

## 10. Rule numbers in code comments

Comments in `web/` cite "rule N" of an earlier rulebook that is no longer in
the repository. What each number meant, as far as the comments show:

| Old | Meaning | Here |
|---|---|---|
| 2 | Containers are rounded | 2.5 |
| 5 | A mark never changes size | 3, rule 26 |
| 6 | Values are mono; 11, or 9 when anchored to a note | 2.6, 5 |
| 7 | Accent has a fixed list of uses | 2.3 |
| 8 | State is a dot; disabled rather than missing | 3, rules 3 and 18 |
| 9 | Controls answer the pointer | 3, rule 1 |
| 13 | Widths are measured | 3, rule 17 |
| 15 | Stage colours, layer hue, three transparencies | 5 |
| 16 | No `var()` fallbacks | 2 |
| 17 | Windows are staged, actions fire, destructive far left | 3, rules 6–9 |
| 20 | The primary names the work | 3, rule 5 |
| 21 | Selectable list and form sub-list | 4.12, 4.13 |
| 23 | Sections from five groups | 3, rule 13 |
| 24 | State not prose; tooltips; optional is silent; dashed takes a file | 3, rules 15, 16, 19, 20 |
| 25 | The tab's notation | 3, rule 25 |
| 26 | A growing set is a dropdown | 3, rule 14 |
| 27 | Pair related fields; slider label beside it | 3, rules 11, 12 |

Rules 1, 3, 4, 10–12, 14, 18, 19 and 22 are cited nowhere and their text is lost.
New comments cite this document by section ("design.md 4.9").


## 10. Artifact pane

The right artifact pane is built like the layer sidebar (4.15): no pane title,
each list under a `.side-header` / `.side-label` with its count in mono at the
right, rows as in 4.13. An empty list is hidden, header included. Each entry looks like what it
indexes on the stage, in that hue (`--stage-*`, a hand anchor its layer's colour):
a marker's name is drawn as its flag, a tinted 24-high chip; a reference entry is
framed solid, a motif dashed, at half strength and full under the pointer.
Double-clicking a reference or motif entry moves there (on its name it renames).
Dragging the entry onto the spectrogram pastes it where it is dropped: a
reference as another linked occurrence, a motif as an independent copy; one
undo step, and the clipboard is left as it was.
The first note lands under the pointer. A motif keeps only its intervals, so it
follows the pointer in pitch too (kept inside the spectrogram's range) and drops
its string and fret for fingering to place again. A reference's pitch is locked
by default; its menu's "Allow pitch changes" frees it.

A freed reference (`transposable`) lets each occurrence sit some semitones off the
group's pitch (`shifts[i]`, parallel to `anchors`): by dropping it higher or lower,
or by dragging an occurrence's label up or down on the stage. Edits mirror relative
to each box's shift, so the melody stays the same; effects mirror unchanged; a
shifted copy is fingered anew. The stage label and the preview's counter show the
offset ("+2"). "Lock pitch" with shifted occurrences asks first: Move back (to the
earliest occurrence's pitch) or Detach them (their notes stay); one undo step.
The lock is a padlock (icons.js's lock/unlock) at the right end of the box on
the stage, above it like the label, and at the right of its artifact row. On the
stage its state is said in words left of it ("Pitch locked" / "Pitch unlocked") only while
it is pointed at and for 1.5 s after it was flipped. It is closed and plain when locked (the default), open when free;
clicking either flips it, as the menu does.

Time in a reference is musical, not absolute: its box (`rb0`/`rb1`) and its
notes are measured in beats on its layer's grid, so an occurrence under a faster
tempo is shorter in seconds and keeps the same rhythm, when it is pasted,
dropped, moved, resized or mirrored. Copy and paste of any notes (motifs too)
keep their beat distances from the first note the same way. A project saved
before reads a reference's shape at its first occurrence.

A reference never lands inside another one: a dropped reference or motif whose
box would overlap a reference box is refused (the drop preview turns
`--error`, a toast says why), and an occurrence dragged by its label stops at
its last free place. Notes join a reference one at a time, drawn or pasted.
While it is over the stage, the notes show as ghosts where the drop would put
them (snapped exactly as the paste will snap them), framed as they will be: a
reference in its own box shape, a motif dashed. A
reference or motif row's head (`.artifact-row-head`) is the disclosure for its
preview window. Rows are one line, 32 high: the name, and for a marker its time in mono at
the right. Clicking a marker row moves there; its compact Edit and Move to icon
buttons cover the time on hover or focus. The pane follows the layer sidebar and fretboard interaction rules: a gap
splitter resizes it, dragging below the collapse threshold folds it to a frosted
strip, and hovering peeks at its retained content. The edge chevron, toolbar
toggle, strip click and splitter double-click restore it. Width and collapsed
state persist across reloads. Collapsed content is inert. The list updates with project edits
and undo. It lists only the active layer's artifacts.

Each reference row is its own preview window with its lane, a cropped track
miniature, and a compact Move to control. Hovering never plays: the compact play
toggle in the footer (`aria-pressed`, stop icon while playing) starts and stops
the preview, as does Space/Enter on the focused window.

References and motifs have names. Double-clicking the name in the artifact row
or the label on the stage, or Rename in their menu, opens a 24-high field over
it; Enter or leaving saves, Escape cancels, an empty name returns to the
numbered default, and each rename is one undo step. A reference's name is stored
on its group (`refBoxes[n].name`), a motif's on its notes (`motifName`). On the
stage both labels are drawn the same way: 11/700 UI type, haloed, above the box.

A reference box resizes from any edge or corner within `REF_BOX_EDGE_TOL` px:
the cursor turns to the matching resize arrow and the box lights up (2px stroke
and a `WASH` fill) while the pointer is on its edge or dragging it.
The displayed occurrence
is selected using previous/next arrows overlaid inside the miniature. The arrows appear
when the reference has multiple instances; the first/last boundary disables the
corresponding arrow. A counter and time range identify the current occurrence.
Both playback and Move to target that occurrence. Only one audition plays at a
time, and switching its instance stops it. Instance choices survive list redraws.

The miniature crops the displayed audio track's spectrogram and overlays the
owning lane's notes. Without audio it shows and plays the notes. Its height is
`--h-artifact-preview` (64px); a cursor follows playback inside the crop.
Every expanded window has the same fixed height and full available width,
including the same miniature width for single- and multiple-instance references.
The navigation arrows sit on the miniature; under it, one footer line holds the
playback dot, the counter and time range in mono, and Move to. Hiding arrows or switching instances never changes its size.
Each row's disclosure folds its preview window. The References disclosure folds
the entire list. Both use `aria-expanded` and `aria-controls`, and collapse
choices survive list redraws.

The audition leaves the main transport position unchanged and stops at the box
end, on a project change, on Move to or when normal playback starts. Move to
sets the playhead immediately and animates both viewport axes using the existing
panel motion, respecting reduced motion and manual scroll interruption.

Artifacts are live views of the project's reference boxes and owning lane notes,
never separate editable copies. Cards keep their DOM while notes, geometry and
metadata change. They render in the editor's paint pass, including undo/redo,
and resolve their targets again before an action. A changed source or passage
stops any outdated audition. The row's right-click and keyboard context menu use
the editor's `openRefMenu` and the displayed occurrence's actual note selection,
so Copy, Cut, Delete and Detach have exactly the editor's effects and undo.

## 11. Motifs

Motifs replace the former authored Shape groups. A motif is only a `motifId`
annotation on one or more notes in one layer. Marking or unmarking changes no
pitch, onset, duration, effect, fingering or arrangement. It creates no shared
grip and discovers or links no repeats. Single-note remnants remain marked.
Mark as motif extends the existing motif when the selection contains all of its
members and additional unmarked notes. Its ID and number stay unchanged. Partial
motifs or selections spanning multiple motifs receive a new ID instead.
Pitch, instrument, tuning, slicing and fingering edits do not clear annotations
on surviving notes. A pasted selection receives a new independent motif ID.
Old Shape membership loads as a motif, retaining existing authored fingering.
The timeline draws a dashed enclosure around the motif's time and pitch bounds.
Motif names use a project-local counter starting at 1, independent of note/lane
IDs. On load, old shared-counter IDs migrate once to `motif_v2_N`; subsequent
loads preserve these numbers, including gaps after deletion.

Artifacts has independently collapsible References and Motifs sections in one
scroll area. Motifs use the same fixed-size windows, hover preview, Move to,
collapse and context-menu idiom. Their preview and actions read only notes
carrying that motif ID, including when unmarked notes overlap their bounds.
They update directly from project notes on the editor paint pass and undo/redo;
no second note collection is stored. The motif menu offers Copy, Cut, Delete
marked notes and Unmark motif (keep notes). Musical exports ignore the label;
project save/load preserves it.

### Marker artifacts

Tempo/meter (including the start marker), sections, phrase boundaries and tone
switches have separate collapsible artifact lists. Entries show their exact
time, sorted by time. Like every artifact list, they show only the active layer
and the timing it follows; switching the active layer switches the lists.
Edit and right-click open the timeline's existing marker editor, including its
delete action. Move to seeks and smoothly scrolls horizontally, activating the
owning layer for layer-specific markers. Marker rows resolve live data on every
paint and action; they store no copies. Popover edits remain bound to their
original timing/layer, including song markers when all layers use own timings.

### Rocksmith issues

The pane's first list, Rocksmith, is what the Rocksmith export would report for
the active layer: DLC Builder's arrangement checks (`rocksmith/checker.py`) and
the export's own warnings. The server runs the export's compile about 700 ms
after edits settle, with the leading silence the export window last used; a
newer check cancels one in flight. A row leads with a warning triangle
(`--warn`; `--error` for what DLC Builder marks important), then the issue's
name and, when it has one, its time in mono. Its explanation is the row's
tooltip (3, rule 19), marked Error or Warning; DLC Builder's issue codes stay
internal. A timed row moves there like a marker row. On
the stage the notes an issue concerns are framed like an unplayable chord, in
`--error` or `--warn` like the row, and hovering the frame's triangle shows the
same tooltip (4.19). An unplayable chord is an error, one only a very wide hand
reaches is a warning. Bend points on the same millisecond carry a count badge
like an overlap stack's, ringed in `--warn` because the export keeps the first
and drops the rest; it sits up and right of the point and has a tooltip. What the
export changes on its own to avoid an issue (a slide into a chord, a dead note
in a chord) is listed and framed the same way, never as important. An empty list
is hidden, header included.

Hand anchors are explicit fretting-hand positions, stored compatibly in the
existing `handHolds` field. The active visible layer's anchors occupy a compact
20px marker rail, using the same tinted frame as other flags and a `Fret N`
label. Click/right-click opens their editor; dragging snaps to beats. Fret and
time edits, moves and deletion support undo. A separate collapsible Hand anchors
artifact list indexes the active layer and shares that editor and smooth Move to action.

The hand follows fixed rules (`web/voicing-core.js`), and Rocksmith gets exactly
the hand the fretboard shows (each note carries it as `hand` in the export spec;
`chart.py` turns the changes into anchors):

- The hand position is the fret under the index finger. It covers four frets and
  reaches six with a stretch (five on a bass); a note's finger is `fret − hand + 1`, the pinky past four.
- A chord fingered with the index has its hand on that fret and nowhere else.
- Planned automatically: index on the lowest note to start, stay while the notes
  are in reach, otherwise move.
- A hand anchor fixes the hand of its own note or chord only. It moves no note; the
  fretboard's Hand buttons offer only hands that can play that note or chord
  (`handChoices`), and one that can no longer play it lapses.
- A note moved along its string keeps its finger and stretch: the hand moves with it
  as an anchor on that note (`followHand`), undone with the move.
- A position override carries on in one of three ways, chosen on the fretboard
  (a `.pill`: Only here · Guided · Locked; `follow` on the pin). Only here: that
  note or chord alone. Guided: the memory forgets those notes and learns the
  override (weight 3), so the same notes after it prefer it where the hand allows.
  Locked: the same notes after it are played so until another override of them.
  Nothing reaches back before an override, and no other note's memory changes.
- In the package: anchors where the hand changes, plus one at every phrase start,
  four frets wide or as far as a note reaches, counted from the nut (capo added).
