// What the walkthrough says, and in what order. Pure data: no imports, no DOM,
// no globals, so tour.test.mjs can load it under Node and check every step
// against the markup. tour.js is the machinery; this is the whole script.
//
// A step is { target | sel | spot, title, body, do?, until? }.
//
//   target   an element ID, as a string — resolved when the step runs, never a
//            node. A step whose target is missing or has no size is SKIPPED, so
//            a chapter degrades on a score-only project (no stems) rather than
//            spotlighting nothing. This is the only kind tour.test.mjs can check
//            against index.html, so it is the one to reach for.
//   sel      a CSS selector, for what index.html does not contain: rows and
//            menus built in JS. Unchecked by the test — use an ID where there
//            is one.
//   spot     a rect drawn on the canvas, by name (SPOTS in tour.js). The stage
//            is one element, so a note, a bar or the playhead cannot be pointed
//            at any other way.
//   do       one of ACT: what the step does when it opens. Rule 24's ban on a
//            walkthrough that edits is about the READER'S project; a chapter
//            here opens the tutorial song first (`project`), which is rebuilt
//            per run and is in nobody's library.
//   until    one of UNTIL: advance when the reader has done the thing. `task`
//            names a single action; `tasks` lists several actions with their
//            own UNTIL predicates. Waiting steps show Skip and advance when all
//            tasks complete. Close asks before returning to the main menu.
//   allow    selector for the controls a waiting step accepts; allowSpot and
//            allowMenu cover canvas gestures and context-menu items.
//   back     one of ACT: run when the reader pages backwards off this step, to
//            put away whatever they were asked to open.
//
// A chapter is { label, done, project?, next?, steps }.
//
// `done` is the last step's primary, per chapter, and it names where you land
// (rule 20). Paging is the work; on the last card there is no more of it, so
// "Next" would lie.

// The side effects a step may have, and the states it may wait for. Names rather
// than functions so this module stays importable without a DOM; tour.js holds
// the implementations and the test holds the two sides together.
export function previousTourStep(chapter, step) {
  if (step > 0) return { chapter, step: step - 1 };
  const previous = Object.keys(TOURS).find((name) => TOURS[name].next === chapter);
  return previous ? { chapter: previous, step: TOURS[previous].steps.length - 1 } : null;
}

export const ACT = {
  tutorial: "tutorial",     // open the walkthrough's own song, rebuilt
  fretboard: "fretboard",   // the neck is off at launch
  fretboardShow: "fretboardShow", // reveal the neck during the overview
  audioReady: "audioReady", // restore the compact neck and show the sidebar
  lanes: "lanes",           // so are the marker lanes
  seed: "seed",             // put the demo phrase in the active layer
  ensureDetectedNotes: "ensureDetectedNotes", // show the prepared result when Detect was skipped
  seedFirstPhrase: "seedFirstPhrase", // one copy for the reference lesson
  selectFirstPhrase: "selectFirstPhrase",
  ensureReference: "ensureReference",
  findSimilar: "findSimilar",
  prepareMatches: "prepareMatches",
  focusAlternative: "focusAlternative",
  demoSections: "demoSections",
  demoPhrases: "demoPhrases",
  demoTone: "demoTone",
  prepareEditNotes: "prepareEditNotes",
  prepareSliceNote: "prepareSliceNote",
  prepareEffectNote: "prepareEffectNote",
  traceOptions: "traceOptions", // show the prepared notes and their Editor settings
  prepareNavigation: "prepareNavigation",
  prepareShapeNotes: "prepareShapeNotes",
  selectShapeNotes: "selectShapeNotes",
  addUploadMode: "addUploadMode",
  addSeparateMode: "addSeparateMode",
  // What the reader opens for themselves has no action here. Opening the Add
  // audio menu and the two editors used to be steps that clicked for you, which
  // taught the window and hid the door: every one of them is now a card that
  // says where the door is and waits (UNTIL) for it to be opened.
  clear: "clear",           // empty it again
  bass: "bass",             // show the bass stem's spectrogram
  addBass: "addBass",       // reveal the tutorial's prepared bass audio
  // `back` uses these: a step that talked the reader into opening something puts
  // it away again when they page backwards, or Back lands on "open the window"
  // with the window still open.
  addMenuClose: "addMenuClose",
  addMenuOpen: "addMenuOpen",
  bassRemove: "bassRemove",
  stemEditOpen: "stemEditOpen",
  stemEditOpenIfClosed: "stemEditOpenIfClosed",
  stemEditClose: "stemEditClose",
  layerEditClose: "layerEditClose",
  tempoPopClose: "tempoPopClose",
  tempoPopOpen: "tempoPopOpen",
  detectClose: "detectClose",
  detectOpen: "detectOpen",
  closeWindows: "closeWindows",
  sidebarOpen: "sidebarOpen",
  options: "options",       // open Editor options
  optionsClose: "optionsClose",
  fbEdit: "fbEdit",         // put the neck in edit mode
  fbEditClose: "fbEditClose", // restore the neck's normal view on Back
  rsExport: "rsExport",     // open the Rocksmith export window
  rsExportClose: "rsExportClose",
  metroPlay: "metroPlay",   // play with the click on
  metroEnable: "metroEnable", // turn the click on without starting playback
  tempoReady: "tempoReady", // stop playback and bring the first flag into view
  tempoFix: "tempoFix",
  stop: "stop",
  stopReset: "stopReset",
};

// A waiting step names both the result it needs and the controls that may
// produce it. The guard in tour.js drops unrelated interactions while it waits.
export const UNTIL = {
  playing: "playing",       // the reader pressed play
  notes: "notes",           // the note count in the project changed
  refs: "refs",             // a reference group was made
  tempo120: "tempo120",     // the grid is on the song's real tempo
  tempoPosition: "tempoPosition", // BPM and first-beat position are both correct
  frame: "frame",           // a detect frame was dragged
  detectPanel: "detectPanel",
  detectFinished: "detectFinished",
  selection: "selection",   // something on the stage got selected
  fretboardEdit: "fretboardEdit", // the neck entered edit mode
  fretboardVisible: "fretboardVisible",
  fretboardOverride: "fretboardOverride",
  fretboardHandHold: "fretboardHandHold",
  matches: "matches",
  notePosition: "notePosition",
  noteLength: "noteLength",
  noteEffects: "noteEffects",
  menuOpened: "menuOpened",
  noteNavigation: "noteNavigation",
  shapeGroup: "shapeGroup",
  tempoPop: "tempoPop",     // the tempo/meter flag was clicked open
  addMenu: "addMenu",       // the Add audio menu was opened
  bass: "bass",             // the bass arrived in the audio list
  stemEditor: "stemEditor", // the audio editor was opened
  layerEditor: "layerEditor",
};

// The chapter the Walkthrough card on the landing page starts. Every other
// chapter is reached from it by `next`, which tour.test.mjs walks — a chapter
// nothing hands over to is data nobody can read.
export const FIRST = "editor";




// The chapters, in the order they are meant to be read. Each one hands over to
// the next (`next`), so the whole thing is one ride from the Help menu's first
// row while any single topic is still replayable on its own.
//
// The voice is a person showing you around: "let's", "you can", contractions,
// and the fact stated plainly when a fact is what is needed. It is chattier than
// anything else in the app because a card is the one surface allowed to explain
// (rule 24) — and it still stops at the fact (rule 28). What that rules out is
// the volunteered detail: name the thing, say what it is for, move on. "The
// speed chip slows the take without dropping its pitch" is an answer to a
// question the reader has not asked.
//
// A title is what the thing is called. Not a sentence, not a claim, not a joke.
export const TOURS = {
  editor: {
    label: "Overview",
    project: ACT.tutorial,
    next: "audio",
    done: "Next: Audio layers",
    steps: [
      {
        target: "projTab",
        title: "Welcome",
        body: "In this quick walkthrough, I'll show you everything you need to know to start charting your favourite songs.",
      },
      {
        target: "transport",
        title: "Toolbar",
        body: "The full-width toolbar holds playback, zoom, the metronome, and panel controls. Your project title sits between playback and zoom. The compact overview below it lets you jump through the song.",
      },
      {
        spot: "spectrogramArea",
        title: "Main editing area",
        body: "Place and edit notes in the spectrogram. The overview and editor share one panel. Pitch scales on both sides show the note under your pointer at every zoom level.",
      },
      {
        do: ACT.sidebarOpen,
        target: "sidebar",
        title: "Layer sidebar",
        body: "The sidebar on the left holds your audio layers and note layers. Audio layers are the sources you listen to; note layers hold the charts you create.",
        placement: "right",
      },
      {
        do: ACT.lanes,
        spot: "markerArea",
        title: "Marker strip",
        body: "Frosted flags at the top of the spectrogram mark tempo, sections, phrases, and tone changes. The spectrum stays visible between the flags.",
      },
      {
        do: ACT.fretboardShow,
        target: "fretboardPanel",
        title: "Fretboard",
        body: "The fretboard below the editing area shows how the notes can be played on your instrument. You can open or collapse it with the chevron.",
      },
    ],
  },

  audio: {
    label: "Audio layers",
    project: ACT.tutorial,
    next: "notes",
    done: "Next: Note layers",
    steps: [
      {
        do: ACT.audioReady,
        target: "stemsSection",
        title: "Audio layers",
        body: "At the top you'll find your audio sources. These include your full recording and additional audio sources, such as separated stems.",
      },
      {
        sel: "#audioLayerActions .layer-add",
        title: "Add audio layer",
        body: "RS Studio includes several stem separation models and options to make transcription easier to manage. Use the plus button below the audio-layer list whenever you need an additional source in your project.",
        lockApp: true,
      },
      {
        do: ACT.addMenuOpen,
        sel: ".stem-add-menu",
        title: "Separating a part",
        body: "To separate a stem from your full recording, choose a model and the part you want to separate. This demo recording contains only bass, so its prepared Bass stem sounds the same as Full song. Demucs and Bass are selected by default.",
        highlight: "Next",
        lockApp: true,
        allow: ".stem-add-menu select",
        back: ACT.addMenuClose,
      },
      {
        do: ACT.addUploadMode,
        sel: ".stem-add-menu",
        title: "Upload a stem",
        body: "If you've already separated a stem, the Upload my own tab lets you add it to your project.",
        highlight: "Upload my own",
        lockApp: true,
        back: ACT.addSeparateMode,
      },
    ],
  },

  notes: {
    label: "Note layers",
    project: ACT.tutorial,
    next: "tempo",
    done: "Next: Tempo and the grid",
    steps: [
      {
        do: ACT.addBass,
        back: ACT.bassRemove,
        target: "layersSection",
        title: "Note layers",
        body: "At the bottom, you'll find the note layers. This is where you organize and manage your transcribed notes and charts.",
      },
      {
        sel: "#lanes .lane-row .edit-btn",
        title: "Note layer settings",
        body: "Hover over a note layer to reveal its pencil button and open Edit note layer settings. The plus button below the note-layer list opens the same settings before creating a layer.",
        highlight: "Edit note layer settings",
        lockApp: true,
      },
      {
        do: ACT.stemEditOpenIfClosed,
        spot: "layerBasics",
        title: "Identity and playback",
        body: "Here you can edit the basics, such as the layer name and note color. Playback settings change its tone and volume when you preview the chart.",
        placement: "right",
        back: ACT.layerEditClose,
      },
      {
        sel: "#spLayer .section:nth-child(3)",
        title: "Notation",
        body: "Notation settings affect how notes and chords are tabbed and exported. Instrument and tuning set the strings and pitches, while Rocksmith arrangement assigns this layer as lead, rhythm, bass, or another supported arrangement.",
        placement: "right",
      },
    ],
  },

  tempo: {
    label: "Tempo and the grid",
    project: ACT.tutorial,
    next: "drawing",
    done: "Next: Drawing notes",
    steps: [
      {
        do: ACT.closeWindows,
        spot: "spectrogramArea",
        title: "Before charting",
        body: "The vertical grid lines in the editing area help you place notes in time with the song. Let's line up the grid before we start charting.",
      },
      {
        do: ACT.lanes,
        spot: "tempoMarker",
        title: "The tempo flag",
        body: "But before you start placing any notes, I highly recommend setting the project tempo and offset to match the imported song.\n\nThe app estimates these settings automatically and is usually quite close, but even small errors build up over time and throw off the timing.",
      },
      {
        do: ACT.tempoPopOpen,
        target: "markerPop",
        title: "The flag's settings",
        body: "In this example, the actual tempo is 120 BPM and the first beat starts at 0.35 seconds, so the automatic estimate is a bit off. Use the grid lines in the main view to line them up with the song, and use the metronome to check the alignment.",
        lockApp: true,
        allow: "#markerBpm, #markerTime, #markerTsNum, #markerTsDen, #markerSubdiv, #markerSubdivCustom, #play, #metroToggle",
        back: ACT.tempoPopClose,
      },
    ],
  },

  drawing: {
    label: "Drawing notes",
    project: ACT.tutorial,
    next: "detect",
    done: "Next: Detecting notes",
    steps: [
      {
        do: ACT.bass,
        spot: "spectrogramArea",
        title: "Trace a line",
        body: "There are multiple ways to add notes, but the most straightforward is to draw them in.\n\nTo do this, hold the left mouse button and draw a line along the highlighted areas.",
        until: UNTIL.notes,
        task: "Draw a line to add notes",
        optional: true,
        allowSpot: "stage",
        allowButton: 0,
        placement: "top-right",
      },
      {
        do: ACT.traceOptions,
        back: ACT.optionsClose,
        title: "Trace settings",
        body: "The trace tool places notes automatically along the traced line and snaps them to the most confident match in the spectrogram.\n\nFor finer control, you can double-click to add a single note. Open Settings in the toolbar, then choose Editor. Under Note placement, Heat sets the brightness threshold, Range sets the pitch search distance, and Snap to pitch can be turned off.",
        target: "tracePlacement",
        placement: "side",
        freeApp: "#tracePlacement",
      },
      {
        do: ACT.prepareNavigation,
        spot: "spectrogramArea",
        title: "Navigating notes",
        body: "Use the left and right arrow keys to jump between notes or chords. The playhead and selection follow each jump. If two lines sound at the same time, the up and down arrows move between them without changing the playhead.",
        until: UNTIL.noteNavigation,
        task: "Press [[→]] to jump to the next note",
        optional: true,
        allowKeys: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"],
        placement: "top-right",
      },
      {
        do: ACT.stop,
        spot: "spectrogramArea",
        title: "Positioning the playhead",
        body: "Click once in empty space in the editing area to move the playhead to that position.",
        until: UNTIL.noteNavigation,
        task: "Move the playhead with [[LMB]]",
        optional: true,
        allowSpot: "stage",
        allowButton: 0,
        placement: "top-right",
      },
      {
        do: ACT.prepareEditNotes,
        spot: "spectrogramArea",
        title: "Moving notes",
        body: "You can move a note by dragging its body when the move cursor (✥) appears. Drag it left or right to change its timing, or up and down to change its pitch.",
        until: UNTIL.notePosition,
        task: "Move a note",
        optional: true,
        allowSpot: "stage",
        allowButton: 0,
        placement: "top-right",
      },
      {
        spot: "spectrogramArea",
        title: "Changing note length",
        body: "To change how long a note lasts, drag its left or right edge when the double-arrow cursor (↔) appears. You can adjust several selected notes together in the same way.",
        until: UNTIL.noteLength,
        task: "Change a note's length",
        optional: true,
        allowSpot: "stage",
        allowButton: 0,
        placement: "top-right",
      },
      {
        do: ACT.prepareSliceNote,
        spot: "spectrogramArea",
        title: "Splitting notes",
        body: "To split a note, hold [[S]] and drag a line across it. The note is cut where the line crosses it, snapped to the grid. You can cut several notes with one line.",
        until: UNTIL.notes,
        task: "Split a note with [[S]]",
        optional: true,
        allowSpot: "stage",
        allowButton: 0,
        allowKeys: ["s", "S"],
        requireModifier: "S",
        placement: "top-right",
      },
      {
        do: ACT.prepareEffectNote,
        spot: "spectrogramArea",
        title: "Note effects",
        body: "Right-click a note to open its context menu. Here you can add effects such as Palm mute, Vibrato, and Slide. Choose one to apply it to the selected note.",
        until: UNTIL.noteEffects,
        tasks: [
          { label: "Open the note's context menu", until: UNTIL.menuOpened },
          { label: "Apply a note effect", until: UNTIL.noteEffects },
        ],
        optional: true,
        allowSpot: "stage",
        allowButton: 2,
        allow: ".ctxmenu",
        allowMenu: "noteEffects",
        menuSpot: true,
        placement: "top-right",
      },
      {
        spot: "spectrogramArea",
        title: "Editing effects",
        body: "Any effect you apply becomes part of the note. You can right-click the note again to change or remove it later.",
        until: UNTIL.noteEffects,
        task: "Change or remove a note effect",
        optional: true,
        menuSpot: true,
        allowMenu: "noteEffects",
        freeApp: "#stage, .ctxmenu",
        placement: "top-right",
      },
    ],
  },

  detect: {
    label: "Detecting notes",
    project: ACT.tutorial,
    next: "repeats",
    done: "Next: Repeats and references",
    steps: [
      {
        do: ACT.clear,
        spot: "spectrogramArea",
        title: "Detection",
        body: "Alternatively, you can use automatic note detection. To access it, right-click an empty space in the editing area to open the context menu and choose Detect notes.",
        until: UNTIL.detectPanel,
        tasks: [
          { label: "Open the context menu", until: UNTIL.menuOpened },
          { label: "Choose Detect notes", until: UNTIL.detectPanel },
        ],
        optional: true,
        allowSpot: "stage",
        allowButton: 2,
        allowMenu: "Detect notes",
        allowMenuInspect: true,
        menuSpot: true,
        lockCard: true,
        placement: "top-right",
      },
      {
        do: ACT.detectOpen,
        target: "detectPanel",
        title: "The models",
        body: "There are several detection models, each with different strengths and weaknesses. For our current bass stem, torchcrepe is a good choice for a single-note melody.\n\nNote detection uses a finer 1/32 grid by default. If the current grid is coarser, you'll be asked to use the 1/32 grid to preserve the detected timing or adjust the notes to the current grid. Cancel detection returns here so you can try again; Skip continues with example notes.",
        detectModel: "torchcrepe",
        until: UNTIL.detectFinished,
        task: "Detect notes with torchcrepe",
        placement: "side",
        optional: true,
        freeApp: "#detectPanel, #actionConfirmBackdrop, #confirmBackdrop",
        back: ACT.detectClose,
      },
      {
        do: ACT.ensureDetectedNotes,
        back: ACT.detectOpen,
        spot: "spectrogramArea",
        title: "Detection result",
        body: "Automatic detection is a great time saver, but detection results can vary greatly depending on the complexity of the audio source. It's not a silver bullet and is rarely perfectly correct.",
      },
      {
        spot: "spectrogramArea",
        title: "Detecting a range",
        body: "By default, note detection is applied to the whole track, but you can also limit it to a specific timeframe. To do that, hold [[Alt]] and drag a frame across the timeline before opening Detect notes.",
        until: UNTIL.frame,
        task: "Drag a detection frame with [[Alt]]",
        optional: true,
        allowSpot: "stage",
        allowButton: 0,
        allowKeys: ["Alt"],
        requireModifier: "Alt",
        placement: "top-right",
      },
    ],
  },

  repeats: {
    label: "Repeats and references",
    project: ACT.tutorial,
    next: "shapes",
    done: "Next: Shapes",
    steps: [
      {
        do: ACT.seedFirstPhrase,
        spot: "spectrogramArea",
        title: "Repeats",
        body: "Most songs have repeating parts and motifs. To reduce workload, we can mark those motifs as repeats and reuse them later in the song.\n\nHold [[Shift]] and drag a box around the notes, then right-click and choose Group selection into reference.",
        until: UNTIL.selection,
        task: "Select the motif with [[Shift]]",
        optional: true,
        allowSpot: "stage",
        allowButton: 0,
        allowKeys: ["Shift"],
        requireModifier: "Shift",
        placement: "top-right",
      },
      {
        do: ACT.selectFirstPhrase,
        spot: "spectrogramArea",
        title: "Reference groups",
        body: "Right-click anywhere in the editing area and choose Group selection into reference.",
        until: UNTIL.refs,
        tasks: [
          { label: "Open the context menu", until: UNTIL.menuOpened },
          { label: "Group the selection into a reference", until: UNTIL.refs },
        ],
        optional: true,
        allowSpot: "stage",
        allowButton: 2,
        allowMenu: "Group selection into reference",
        menuSpot: true,
        lockCard: true,
        placement: "top-right",
      },
      {
        do: ACT.ensureReference,
        spot: "reference",
        title: "Linked copies",
        body: "This box marks the motif as a reference. When you reuse it later, the notes stay linked, so editing one updates the others. You can drag a box's number to move it or its edge to change what it captures.\n\nYou can copy the selected notes within a reference group and paste them elsewhere in the song. You can paste them as either a reference or a new copy.",
        freeApp: true,
      },
      {
        do: ACT.findSimilar,
        spot: "spectrogramArea",
        title: "Find similar",
        body: "Selected notes of a motif can be used to find similar passages in a song. Right-click to open the context menu and choose Find similar passage.",
        until: UNTIL.matches,
        tasks: [
          { label: "Open the context menu", until: UNTIL.menuOpened },
          { label: "Find a similar passage", until: UNTIL.matches },
        ],
        optional: true,
        allowSpot: "stage",
        allowButton: 2,
        allowMenu: "Find similar passage",
        menuSpot: true,
        placement: "top-right",
      },
      {
        do: ACT.prepareMatches,
        spot: "spectrogramArea",
        title: "Similar passages",
        body: "If similar passages are found, you'll see white outlined boxes with a similarity rating inside the editing area. Hover over a box to preview it; moving away stops the preview. Click a box to paste the selected notes there. When the source notes belong to a reference, choose a linked reference or an independent copy.",
        until: UNTIL.notes,
        task: "Paste notes from a similar passage",
        allow: "#pasteBackdrop",
        optional: true,
        allowSpot: "stage",
        allowButton: 0,
        placement: "top-right",
      },
    ],
  },

  shapes: {
    label: "Shapes",
    project: ACT.tutorial,
    next: "fretboard",
    done: "Next: The fretboard",
    steps: [
      {
        do: ACT.prepareShapeNotes,
        spot: "spectrogramArea",
        title: "Selecting a shape",
        body: "A shape groups notes that should be played with one fretting-hand grip, even if they start at different times. It is different from a reference, which links repeated passages. Hold [[Shift]] and drag around these two notes to select them.",
        until: UNTIL.selection,
        task: "Select both notes with [[Shift]]",
        optional: true,
        allowSpot: "stage",
        allowButton: 0,
        allowKeys: ["Shift"],
        requireModifier: "Shift",
        placement: "top-right",
      },
      {
        do: ACT.selectShapeNotes,
        spot: "spectrogramArea",
        title: "Grouping a shape",
        body: "Right-click the selection and choose Group selection into shape. The notes keep their individual timing, but the fretboard treats them as one held grip. You can later select the entire shape or ungroup it from the same menu.",
        until: UNTIL.shapeGroup,
        tasks: [
          { label: "Open the context menu", until: UNTIL.menuOpened },
          { label: "Group selection into shape", until: UNTIL.shapeGroup },
        ],
        optional: true,
        allowSpot: "stage",
        allowButton: 2,
        allowMenu: "Group selection into shape",
        menuSpot: true,
        placement: "top-right",
      },
    ],
  },

  fretboard: {
    label: "The fretboard",
    project: ACT.tutorial,
    next: "markers",
    done: "Next: Markers",
    steps: [
      {
        do: ACT.fretboard,
        target: "fretboardChevron",
        title: "The neck",
        body: "Once you're happy with your note placement, you can preview your chart on a fretboard. You'll find it at the bottom of the editing area. Click the chevron to open it, or press [[F]].",
        until: UNTIL.fretboardVisible,
        task: "Open the fretboard",
        allow: "#fretboardToggle, #fretboardChevron",
        allowKeys: ["f", "F"],
      },
      {
        do: ACT.focusAlternative,
        target: "fretboardEdit",
        title: "Edit",
        body: "The numbers on the fretted strings indicate the fingers, and the highlighted fret shows the hand placement. Use the pencil button to enter Edit mode and change the current note, chord, or hand placement. Its settings appear in the toolbar.",
        until: UNTIL.fretboardEdit,
        task: "Open fretboard Edit mode",
        optional: true,
        allow: "#fretboardEdit",
      },
      {
        do: ACT.fbEdit,
        back: ACT.fbEditClose,
        target: "fretboardStage",
        title: "Other positions",
        extraTarget: "#fretboardContext",
        body: "Once in edit mode, you'll see outlines of the available alternatives for the current note or chord. Click a shape to set it as your preferred override, or click a ring to move a single note.",
        until: UNTIL.fretboardOverride,
        task: "Choose another fingering",
        optional: true,
        freeApp: "#fretboardStage",
      },
      {
        target: "fretboardPanel",
        title: "Moving the hand",
        body: "Alternatively, instead of choosing a specific note or shape, you can adjust the hand placement by clicking a fret. The app will then select a suitable fingering for the notes or chords around it.",
        until: UNTIL.fretboardHandHold,
        task: "Click a fret to move the hand",
        optional: true,
        freeApp: "#fretboardStage",
      },
      {
        target: "fretboardStage",
        title: "How overrides affect fingering",
        body: "An override can change how nearby notes or chords are fingered. A hand placement may also affect earlier notes as the app works out how to reach that position.",
      },
      {
        target: "fretboardStage",
        title: "Back to automatic",
        extraTarget: "#fretboardAuto:not([hidden])",
        body: "To remove an override, use Reset override beside the current note on the fretboard. Hover over it or focus it with the keyboard to preview the automatic position before resetting.",
      },
    ],
  },

  markers: {
    label: "Markers",
    project: ACT.tutorial,
    next: "export",
    done: "Next: Exporting",
    steps: [
      {
        do: ACT.lanes,
        spot: "markerArea",
        title: "Marker lanes",
        body: "Finally, once you're happy with the notes and tab, it's time to set up the markers. You'll find them at the top of the editing area, and you can toggle them with [[L]].\n\nThe miniature overview keeps its marker symbols visible even when these lanes are hidden.\n\nThey're mostly optional, but they can significantly improve the resulting export.",
      },
      {
        spot: "tempoMarker",
        title: "Tempo and meter",
        body: "First, we have the tempo flag we set earlier. You can add more tempo flags throughout the song if it has tempo or rhythmic changes.",
      },
      {
        do: ACT.demoSections,
        spot: "sectionFlags",
        title: "Sections",
        body: "Next are the section flags, such as intro, verse, chorus, and bridge. They add useful labels to a Guitar Pro export and become sections in Rocksmith's Riff Repeater.",
      },
      {
        do: ACT.demoPhrases,
        spot: "phraseFlags",
        title: "Phrases",
        body: "Phrases are similar to sections, but have no semantic label attached. Like sections, they define practice regions in Rocksmith.\n\nIf you don't add any sections or phrases, the song is divided into even regions automatically.",
      },
      {
        do: ACT.demoTone,
        spot: "toneFlags",
        title: "Tone switches",
        body: "Last but not least are tone switches, which change the tone preset during Rocksmith playback. The default tone is based on the selected layer's arrangement.",
      },
    ],
  },

  export: {
    label: "Exporting",
    project: ACT.tutorial,
    done: "Stay here",
    steps: [
      {
        target: "fileMenuBtn",
        title: "Export",
        body: "When you're happy with a project, the File menu has Export Guitar Pro (.gp), Export legacy Guitar Pro (.gp5), Export Rocksmith CDLC (.psarc), and Export .chart.",
      },
      {
        do: ACT.rsExport,
        back: ACT.rsExportClose,
        target: "rocksmithExportModal",
        title: "Rocksmith",
        body: "If you haven't already, use this form to fill out the song information.",
        freeApp: "#rocksmithExportModal",
      },
      {
        do: ACT.rsExportClose,
        back: ACT.rsExport,
        noSpot: true,
        title: "Done",
        body: "That's the tour. You can run it again whenever you like from the Walkthrough card on the welcome screen. Have fun charting!",
      },
    ],
  },
};
