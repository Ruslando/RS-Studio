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
    label: "Introduction",
    project: ACT.tutorial,
    next: "audio",
    done: "Next: Audio layers",
    steps: [
      {
        noSpot: true,
        title: "Welcome",
        body: "Hello and welcome to RS Studio. RS Studio is an interactive note editor with features such as integrated stem separation, note detection, motif search, a spectrogram view and automatic tablature. It provides a comfortable experience for transcribing and exporting guitar and bass charts.",
      },
      {
        noSpot: true,
        title: "RS Studio",
        body: "In this walkthrough I'm going to show you the most important features, so you can start charting your favourite songs.",
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
        body: "Up here are your audio layers: the full song, plus any stems you separate from it. Click one to hear it and see it in the spectrogram.",
      },
      {
        do: ACT.addMenuOpen,
        sel: ".stem-add-menu",
        title: "Adding a stem",
        body: "The plus button under the list opens this menu. Pick a model and the part you want, and RS Studio separates it from the full song. Already have a stem? Use the Upload my own tab.",
        lockApp: true,
        allow: ".stem-add-menu select",
        back: ACT.addMenuClose,
      },
    ],
  },

  notes: {
    label: "Note layers",
    project: ACT.tutorial,
    next: "tempo",
    done: "Next: Tempo",
    steps: [
      {
        do: ACT.addBass,
        back: ACT.bassRemove,
        target: "layersSection",
        title: "Note layers",
        body: "Down here are your note layers. Each one is a part you're charting, like lead guitar or bass.",
      },
      {
        do: ACT.stemEditOpenIfClosed,
        back: ACT.layerEditClose,
        target: "spLayer",
        title: "Layer settings",
        body: "Hover a layer and click its pencil to open its settings. The important ones are the instrument and tuning, and which Rocksmith arrangement this layer becomes.",
        placement: "right",
      },
    ],
  },

  tempo: {
    label: "Tempo",
    project: ACT.tutorial,
    next: "drawing",
    done: "Next: Drawing notes",
    steps: [
      {
        do: ACT.tempoReady,
        spot: "tempoMarker",
        title: "Tempo first",
        body: "Before you chart anything, get the tempo right. Your notes snap to the grid lines, so if the grid is off, everything is off.\n\nThis flag holds the song's tempo. RS Studio guesses it for you, and the guess is usually close, but not always.",
      },
      {
        do: ACT.tempoPopOpen,
        back: ACT.tempoPopClose,
        target: "markerPop",
        title: "Setting the tempo",
        body: "This song is 120 BPM and its first beat is at 0.35 seconds. Type those in, then hit play with the metronome on and listen if it lines up.",
        lockApp: true,
        allow: "#markerBpm, #markerTime, #markerTsNum, #markerTsDen, #markerSubdiv, #markerSubdivCustom, #markerPop .field-revert, #play, #metroToggle",
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
        title: "Draw a line",
        body: "The most straightforward way to add notes is to draw them. Hold the left mouse button and trace along the bright lines, and RS Studio places the notes for you.",
        until: UNTIL.notes,
        task: "Draw a line to add notes",
        optional: true,
        allowSpot: "stage",
        allowButton: 0,
        placement: "top-right",
      },
      {
        do: ACT.prepareEditNotes,
        spot: "spectrogramArea",
        title: "Move and resize",
        body: "Drag a note to move it in time or pitch. Drag its edge to make it longer or shorter.",
        until: UNTIL.noteLength,
        tasks: [
          { label: "Move a note", until: UNTIL.notePosition },
          { label: "Change a note's length", until: UNTIL.noteLength },
        ],
        optional: true,
        allowSpot: "stage",
        allowButton: 0,
        placement: "top-right",
      },
      {
        do: ACT.prepareSliceNote,
        spot: "spectrogramArea",
        title: "Splitting notes",
        body: "Need to cut a note in two? Hold [[S]] and drag a line across it.",
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
        body: "Right-click a note to add effects like palm mutes, vibrato or slides. Right-click it again whenever you want to change them.",
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
    ],
  },

  detect: {
    label: "Detecting notes",
    project: ACT.tutorial,
    next: "repeats",
    done: "Next: Repeats",
    steps: [
      {
        do: ACT.clear,
        spot: "spectrogramArea",
        title: "Detection",
        body: "Alternatively, RS Studio can detect the notes for you. Right-click an empty spot and choose Detect notes.",
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
        back: ACT.detectClose,
        target: "detectPanel",
        title: "Pick a model",
        body: "Each model is good at different things. For a single bass line like this one, torchcrepe is a good choice.",
        detectModel: "torchcrepe",
        until: UNTIL.detectFinished,
        task: "Detect notes with torchcrepe",
        placement: "side",
        optional: true,
        freeApp: "#detectPanel, #actionConfirmBackdrop, #confirmBackdrop",
      },
      {
        do: ACT.ensureDetectedNotes,
        back: ACT.detectOpen,
        spot: "spectrogramArea",
        title: "The result",
        body: "Detection saves a lot of time, but it's rarely perfect, so expect to clean up the result.\n\nTip: hold [[Alt]] and drag across the timeline first to detect just that part.",
      },
    ],
  },

  repeats: {
    label: "Repeats",
    project: ACT.tutorial,
    next: "fretboard",
    done: "Next: The fretboard",
    steps: [
      {
        do: ACT.seedFirstPhrase,
        spot: "spectrogramArea",
        title: "Select a riff",
        body: "Most songs repeat their riffs, so you only need to chart each one once. Hold [[Shift]] and drag a box around these notes to select them.",
        until: UNTIL.selection,
        task: "Select the riff with [[Shift]]",
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
        title: "Make a reference",
        body: "Now right-click and choose Group into reference. Copies of a reference stay linked, so fixing one fixes them all.",
        until: UNTIL.refs,
        tasks: [
          { label: "Open the context menu", until: UNTIL.menuOpened },
          { label: "Group the selection into a reference", until: UNTIL.refs },
        ],
        optional: true,
        allowSpot: "stage",
        allowButton: 2,
        allowMenu: "Group into reference",
        menuSpot: true,
        lockCard: true,
        placement: "top-right",
      },
      {
        do: ACT.findSimilar,
        spot: "spectrogramArea",
        title: "Find similar",
        body: "RS Studio can also find where the riff comes back in the song. Right-click and choose Find similar passage.",
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
        title: "Paste it in",
        body: "Each box is a match. Hover one to hear it, and click it to paste your notes there.",
        until: UNTIL.notes,
        task: "Paste notes into a match",
        allow: "#pasteBackdrop",
        optional: true,
        allowSpot: "stage",
        allowButton: 0,
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
        body: "To see how your chart is played, click the top edge of the fretboard, or press [[F]].",
        until: UNTIL.fretboardVisible,
        task: "Open the fretboard",
        allow: "#fretboardToggle, #fretboardChevron",
        allowKeys: ["f", "F"],
      },
      {
        do: ACT.focusAlternative,
        target: "fretboardStage",
        title: "Fingering",
        body: "RS Studio works out the fingering for you. To change it, double-click the note.",
        until: UNTIL.fretboardEdit,
        task: "Open fretboard Edit mode",
        optional: true,
        allow: "#fretboardStage",
      },
      {
        do: ACT.fbEdit,
        back: ACT.fbEditClose,
        target: "fretboardStage",
        title: "Other positions",
        body: "The outlines show other places you could play it. Click one to use it instead. Reset override restores the automatic position.",
        until: UNTIL.fretboardOverride,
        task: "Choose another fingering",
        optional: true,
        freeApp: "#fretboardStage",
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
        title: "Markers",
        body: "Up top are the markers. They're optional, but they improve your export. Press [[L]] to show or hide them.",
      },
      {
        do: ACT.demoSections,
        spot: "sectionFlags",
        title: "Sections",
        body: "Sections like intro, verse and chorus label your song, and they turn into practice sections in Rocksmith's Riff Repeater.",
      },
      {
        do: ACT.demoTone,
        spot: "toneFlags",
        title: "Tone switches",
        body: "Tone switches change the amp preset mid-song in Rocksmith. Click a flag to pick a different tone.",
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
        body: "When your chart is finished, the File menu exports to Guitar Pro, Rocksmith and .chart.",
      },
      {
        do: ACT.rsExport,
        back: ACT.rsExportClose,
        target: "rocksmithExportModal",
        title: "Rocksmith",
        body: "For Rocksmith, fill in the song information here before exporting.",
        freeApp: "#rocksmithExportModal",
      },
      {
        do: ACT.rsExportClose,
        back: ACT.rsExport,
        noSpot: true,
        title: "Done",
        body: "That's the tour. You can run it again anytime from the Walkthrough card on the welcome screen. Have fun charting!",
      },
    ],
  },
};
