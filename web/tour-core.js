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
  sidebarOpen: "sidebarOpen",
  prepareSelect: "prepareSelect", // notes to select, none selected yet
  prepareChord: "prepareChord", // one note to stack a second on
  prepareDraw: "prepareDraw", // bring the bass line into view
  ensureLinkedCopy: "ensureLinkedCopy", // a reference with a pasted twin
  fileMenuOpen: "fileMenuOpen",
  fileMenuClose: "fileMenuClose",
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
  chord: "chord",           // two notes start together
  clipboard: "clipboard",   // something was copied
  refCopies: "refCopies",   // a reference gained an occurrence
  capo: "capo",             // the layer's capo moved
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
    next: "overview",
    done: "Next: Overview",
    steps: [
      {
        noSpot: true,
        title: "Welcome",
        body: "Hello and welcome to RS Studio. Thank you for checking out this app.\n\nIn this walkthrough I'm going to show you the most important features, so you can start charting your favourite songs.",
      },
    ],
  },

  overview: {
    label: "Overview",
    project: ACT.tutorial,
    next: "audio",
    done: "Next: Audio",
    steps: [
      {
        noSpot: true,
        title: "Overview",
        body: "Let's start with a quick overview of the components and panels.",
      },
      {
        target: "transport",
        title: "Toolbar",
        body: "At the top is the toolbar, where you'll have quick access to settings and tools.",
      },
      {
        do: ACT.sidebarOpen,
        target: "sidebar",
        title: "Sidebar",
        body: "Then there is the sidebar. This is where you manage your audio files and charts.",
        placement: "right",
      },
      {
        spot: "editorArea",
        title: "Editing panel",
        body: "In the middle are the timeline and the editing panel, the heart of the app. This is where you edit notes and create your charts.",
      },
      {
        do: ACT.fretboardShow,
        target: "fretboardPanel",
        title: "Fretboard",
        body: "Last but not least, at the bottom is the fretboard and tablature view.",
      },
    ],
  },

  audio: {
    label: "Audio",
    project: ACT.tutorial,
    next: "notes",
    done: "Next: Notes",
    steps: [
      {
        do: ACT.audioReady,
        target: "stemsSection",
        title: "Reference audio",
        body: "Under Audio layers, you'll find your imported audio. Each project needs a main audio track.",
      },
      {
        do: ACT.addMenuOpen,
        sel: ".stem-add-menu",
        title: "More audio sources",
        body: "In addition to the main song, you can add more audio sources. The app has built-in stem separators that can extract specific instruments from your song.\n\nYou can also upload any audio file you like.",
        lockApp: true,
        allow: ".stem-add-menu select",
        back: ACT.addMenuClose,
      },
    ],
  },

  notes: {
    label: "Notes",
    project: ACT.tutorial,
    next: "drawing",
    done: "Next: Note editor",
    steps: [
      {
        do: ACT.addBass,
        back: ACT.bassRemove,
        target: "layersSection",
        title: "Note layers",
        body: "Right below are the note layers. Here you'll manage your transcriptions and arrangements.",
      },
      {
        do: ACT.stemEditOpenIfClosed,
        back: ACT.layerEditClose,
        target: "spLayer",
        title: "Layer settings",
        body: "Each layer has its own settings. Here you choose the instrument, tuning, arrangement and more.",
        placement: "right",
      },
    ],
  },

  drawing: {
    label: "Note editor",
    project: ACT.tutorial,
    next: "detect",
    done: "Next: Detecting notes",
    steps: [
      {
        do: ACT.bass,
        spot: "spectrogramArea",
        title: "Place a note",
        body: "RS Studio offers many ways to create notes. The most straightforward way is to place them directly. To place a single note, double-click on the spectrogram.",
        until: UNTIL.notes,
        task: "Double-click to place a note",
        optional: true,
        allowSpot: "stage",
        allowButton: 0,
        placement: "top-right",
      },
      {
        do: ACT.prepareChord,
        spot: "spectrogramArea",
        title: "Chords",
        body: "Notes that start at the same time are played together as a chord. Double-click right above or below this note to turn it into a chord.",
        until: UNTIL.chord,
        task: "Add a note above or below it",
        optional: true,
        allowSpot: "stage",
        allowButton: 0,
        placement: "top-right",
      },
      {
        do: ACT.prepareDraw,
        spot: "phraseArea",
        title: "Draw a line",
        body: "To place multiple notes at once, click and hold the mouse button to draw a line. Trace the bright lines at the bottom with your mouse, and the app will place the notes for you.",
        until: UNTIL.notes,
        task: "Draw a line to add notes",
        optional: true,
        allowSpot: "stage",
        allowButton: 0,
        placement: "top-right",
      },
      {
        do: ACT.prepareSelect,
        spot: "spectrogramArea",
        title: "Selecting",
        body: "To select notes and chords, hold [[Shift]] and drag a box around them.",
        until: UNTIL.selection,
        task: "Select notes with [[Shift]]",
        optional: true,
        allowSpot: "stage",
        allowButton: 0,
        allowKeys: ["Shift"],
        requireModifier: "Shift",
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
        do: ACT.selectFirstPhrase,
        spot: "spectrogramArea",
        title: "Groups",
        body: "The same works for several notes at once. With these notes selected, drag one of them to move the whole group, or drag an edge to resize them all.",
        until: UNTIL.noteLength,
        tasks: [
          { label: "Move the group", until: UNTIL.notePosition },
          { label: "Resize the group", until: UNTIL.noteLength },
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
        body: "Right-click a note to add effects like palm mutes, vibrato or slides. This also works for chords.",
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
    done: "Next: References",
    steps: [
      {
        do: ACT.clear,
        spot: "spectrogramArea",
        title: "Detection",
        body: "If you don't feel like drawing the notes yourself, RS Studio can also detect notes for you. Right-click an empty spot and choose Detect notes.",
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
        body: "Note detection listens to your selected audio layer and adds the notes to your current note layer. RS Studio provides multiple models to choose from. The torchcrepe model, for example, works well with bass lines and single-note melodies.",
        detectModel: "torchcrepe",
        until: UNTIL.detectFinished,
        task: "Detect notes with torchcrepe",
        stay: true,
        placement: "side",
        optional: true,
        freeApp: "#detectPanel, #actionConfirmBackdrop, #confirmBackdrop",
      },
    ],
  },

  repeats: {
    label: "References",
    project: ACT.tutorial,
    next: "fretboard",
    done: "Next: The fretboard",
    steps: [
      {
        do: ACT.seedFirstPhrase,
        spot: "spectrogramArea",
        title: "References",
        body: "If your song has repeating parts or recurring motifs, you can use references to chart them once and reuse them as often as you like.\n\nSelect these notes, then right-click and choose Group into reference.",
        until: UNTIL.refs,
        tasks: [
          { label: "Select the notes with [[Shift]]", until: UNTIL.selection },
          { label: "Group them into a reference", until: UNTIL.refs },
        ],
        optional: true,
        allowSpot: "stage",
        allowButtons: [0, 2],
        allowKeys: ["Shift"],
        requireModifier: "Shift",
        allowMenu: "Group into reference",
        menuSpot: true,
        lockCard: true,
        placement: "top-right",
      },
      {
        do: ACT.ensureReference,
        spot: "spectrogramArea",
        title: "Linked copies",
        body: "Now let's reuse it. Click the box's number to select its notes and press [[Ctrl]]+[[C]]. Then click right after the box and press [[Ctrl]]+[[V]], and choose Paste as reference.",
        until: UNTIL.refCopies,
        tasks: [
          { label: "Copy the reference", until: UNTIL.clipboard },
          { label: "Paste it as a reference", until: UNTIL.refCopies },
        ],
        optional: true,
        allowSpot: "stage",
        allowButton: 0,
        allowKeys: ["Control", "c", "C", "v", "V"],
        allow: "#pasteBackdrop",
        placement: "top-right",
      },
      {
        do: ACT.ensureLinkedCopy,
        spot: "spectrogramArea",
        title: "Editing a reference",
        body: "Both boxes are linked now. Move a note in one of them and watch the other one follow.",
        until: UNTIL.notePosition,
        task: "Move a note inside a box",
        optional: true,
        allowSpot: "stage",
        allowButton: 0,
        placement: "top-right",
      },
      {
        do: ACT.findSimilar,
        spot: "spectrogramArea",
        title: "Find similar",
        body: "RS Studio can also find riffs and motifs by itself. Right-click and choose Find similar passage.",
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
        body: "Each box is a potential match. Hover your mouse over one to hear a preview, and left-click to paste your notes there.",
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
        body: "To see how your notes are played on the instrument, click the top edge of the fretboard, or press [[F]].",
        until: UNTIL.fretboardVisible,
        task: "Open the fretboard",
        allow: "#fretboardToggle, #fretboardChevron",
        allowKeys: ["f", "F"],
      },
      {
        do: ACT.focusAlternative,
        target: "fretboardStage",
        title: "Fingering and hand position",
        body: "RS Studio works out both the fingering and the hand position for you. The numbers show which finger plays each note, and the highlighted frets show where your hand sits.\n\nHowever, you may want to change its choice. To do that, click a note, a chord or the highlighted hand position, then choose Edit.",
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
        body: "Inside edit mode, you'll see your current note or chord, and alternative placements as outlines on the fretboard.\n\nChoose the note on the 10th fret.",
        until: UNTIL.fretboardOverride,
        task: "Choose the 10th fret",
        optional: true,
        freeApp: "#fretboardStage",
      },
      {
        target: "fretboardStage",
        title: "Override settings",
        body: "By default, an override doesn't affect the notes and chords before it, but the notes after it adapt to the change. The two active forward arrows show this, and you can change it freely.\n\nIf you want to undo the change, click Reset override.",
      },
      {
        target: "fretboardStage",
        title: "Hand anchors",
        body: "Click a fret to set a hand anchor, and RS Studio picks a fitting fingering for the notes around it. Hand anchors appear as small framed markers in the timeline and in Artifacts.",
        until: UNTIL.fretboardHandHold,
        task: "Click a fret to move the hand",
        optional: true,
        freeApp: "#fretboardStage",
      },
      {
        do: ACT.fbEdit,
        target: "fretboardStage",
        title: "Capo",
        body: "Playing with a capo? In edit mode, grab the nut and drag it up the neck to place one. Drag it back to the nut to take it off again.",
        until: UNTIL.capo,
        task: "Drag the nut to place a capo",
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
        do: ACT.tempoReady,
        spot: "tempoMarker",
        title: "Tempo",
        body: "The tempo flag sets the song's tempo. Your notes snap to this grid, so it's worth getting right before you start charting.\n\nRS Studio estimates it when you import a song. The estimate is usually close, but check it with the metronome. If the tempo changes during the song, add another flag.",
      },
      {
        do: ACT.demoSections,
        spot: "sectionFlags",
        title: "Sections",
        body: "Sections like intro, verse and chorus label your song, and they turn into practice sections in Rocksmith's Riff Repeater.",
      },
      {
        do: ACT.demoPhrases,
        spot: "phraseFlags",
        title: "Phrases",
        body: "Phrases work like sections, but without a name. They also define practice regions in Rocksmith. Without sections or phrases, the song is split into even regions automatically.",
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
        do: ACT.fileMenuOpen,
        back: ACT.fileMenuClose,
        target: "fileMenu",
        title: "Export",
        body: "When your chart is finished, the File menu has everything you need to save and export it.",
        lockApp: true,
      },
      {
        do: ACT.fileMenuOpen,
        target: "saveAs",
        title: "Saving your project",
        body: "Export .chart saves the whole project, audio included, as a single .chart file. Open it again later, or share it with someone else.",
        lockApp: true,
      },
      {
        do: ACT.fileMenuOpen,
        target: "menuExportModernGp",
        title: "Guitar Pro",
        body: "Export Guitar Pro creates a .gp file with your tabs, which you can open in Guitar Pro and other tab editors. For older programs, there's also the legacy .gp5 format.",
        lockApp: true,
      },
      {
        do: ACT.rsExport,
        back: ACT.rsExportClose,
        target: "rocksmithExportModal",
        title: "Rocksmith",
        body: "Before exporting to Rocksmith, you can fill in the song information, select your arrangements, add a leading silence and set a version number for the track.",
        lockApp: true,
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
