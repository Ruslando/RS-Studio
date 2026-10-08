// Cached DOM element references and the $() lookup helper. A dependency sink:
// feature modules import the elements they touch from here. Resolved at module
// load (the entry is type=module, so the DOM is already parsed).

export const $ = (id) => document.getElementById(id);

// A list row rebuilt under an already-hovering pointer computes its first frame
// without :hover and its second with it, so every transition on that row would
// replay after each click on one of its controls. Rows are built with .arriving,
// which suppresses their transitions (see style.css); this drops it once both
// frames have passed and the row's real state is settled.
export function clearArriving(container) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    container.querySelectorAll(".arriving").forEach((el) => el.classList.remove("arriving"));
  }));
}
export const form = $("form"), fileInput = $("file");
export const goBtn = $("go"), statusEl = $("status"), warnEl = $("warnings");
export const transport = $("transport"), appshell = $("appshell");
export const lanesEl = $("lanes");
export const stemTabsEl = $("stemTabs");
export const detectModelSel = $("detectModel"), detectBtn = $("detectBtn");
export const detectStatus = $("detectStatus"), detectStemNameEl = $("detectStemName");
export const confirmBackdrop = $("confirmBackdrop"), confirmMsgEl = $("confirmMsg");
export const confirmReplaceBtn = $("confirmReplace"), confirmAppendBtn = $("confirmAppend"), confirmCancelBtn = $("confirmCancel");
export const actionConfirmBackdrop = $("actionConfirmBackdrop"), actionConfirmTitle = $("actionConfirmTitle");
export const actionConfirmMsg = $("actionConfirmMsg"), actionConfirmAccept = $("actionConfirmAccept"), actionConfirmCancel = $("actionConfirmCancel");
export const actionConfirmDiscard = $("actionConfirmDiscard");
export const actionConfirmModal = $("actionConfirmModal");
export const homeBtn = $("homeBtn"), closeProjBtn = $("closeProj");
export const pasteBackdrop = $("pasteBackdrop");
export const pasteCopyBtn = $("pasteCopy"), pasteAsRefBtn = $("pasteAsRef"), pasteCancelBtn = $("pasteCancel");
export const undoMI = $("menuUndo"), redoMI = $("menuRedo");
export const traceRangeSel = $("traceRange");
export const traceThresholdInput = $("traceThreshold");
export const traceSnapInput = $("traceSnap");
export const saveBtn = $("save"), saveAsBtn = $("saveAs"), openBtn = $("open"), openFileInput = $("openFile");
export const importGpBtn = $("importGp"), gpImportFile = $("gpImportFile");
export const attachAudioBtn = $("attachAudio");
export const gpImportBackdrop = $("gpImportBackdrop"), gpImportClose = $("gpImportClose"), gpImportCancel = $("gpImportCancel");
export const gpImportConfirm = $("gpImportConfirm"), gpImportSummary = $("gpImportSummary"), gpImportTracks = $("gpImportTracks"), gpImportStatus = $("gpImportStatus");
export const openProjMenuBtn = $("openProjMenu");
export const openProjBackdrop = $("openProjBackdrop"), openProjList = $("openProjList"), openProjClose = $("openProjClose");
export const newProjBtn = $("newProj");
export const tabViewBackdropEl = $("tabViewBackdrop"), tabViewCloseEl = $("tabViewClose"), editorEl = $("editor");
export const tabWarnEl = $("tabWarn"), tabRenderEl = $("tabRender"), tabScrollEl = $("tabScroll");
export const fretboardPanel = $("fretboardPanel"), fretboardEl = $("fretboard"), fretboardToggle = $("fretboardToggle");
export const fretboardBusy = $("fretboardBusy"), fretboardBusyLabel = $("fretboardBusyLabel");
export const fretboardStage = $("fretboardStage"), fretboardName = $("fretboardName");
export const fretboardPin = $("fretboardPin"), fretboardAuto = $("fretboardAuto"), fretboardReach = $("fretboardReach");
export const fretboardContext = $("fretboardContext");
export const fretboardEdit = $("fretboardEdit");
export const fretboardSide = $("fretboardSide"), fretboardShape = $("fretboardShape"), fretboardApply = $("fretboardApply");
export const fretboardReachPrev = $("fretboardReachPrev"), fretboardReachNext = $("fretboardReachNext");
export const appbar = $("appbar");
export const projTab = $("projTab"), projTabName = $("projTabName"), projDirtyDot = $("projDirtyDot");
export const welcome = $("welcome"), welcomeNewBtn = $("welcomeNew"), welcomeOpenBtn = $("welcomeOpen");
export const welcomeGpBtn = $("welcomeGp");
export const welcomeRecent = $("welcomeRecent"), recentListEl = $("recentList"), recentSearchEl = $("recentSearch"), recentCountEl = $("recentCount"), recentPaginationEl = $("recentPagination"), recentPrevBtn = $("recentPrev"), recentPageEl = $("recentPage"), recentNextBtn = $("recentNext"), welcomeVersion = $("welcomeVersion");
export const fileMenuBtn = $("fileMenuBtn"), fileMenu = $("fileMenu");
export const modalBackdrop = $("modalBackdrop"), npCancelBtn = $("npCancel"), npNameInput = $("npName");
export const npDrop = $("npDrop"), npDropTitle = $("npDropTitle"), npDropSub = $("npDropSub"), npClear = $("npClear");
export const stemsListEl = $("stemsList"), stemsAddEl = $("stemsAdd");
export const addStemBtn = $("addStemBtn"), stemBulkBrowseBtn = $("stemBulkBrowseBtn"), stemBulkInput = $("stemBulkInput");
export const stemSettingsBackdrop = $("stemSettingsBackdrop"), stemSettingsClose = $("stemSettingsClose");
export const stemSettName = $("stemSettName"), stemSettNameInput = $("stemSettNameInput"), stemSettCard = $("stemSettCard");
export const audio = $("audio"), playBtn = $("play"), seek = $("seek"), timeEl = $("time");
export const metroOn = $("metro"), speedSel = $("speed");
export const bpmInput = $("bpm"), offsetInput = $("offset");
export const subdivSel = $("subdiv"), subdivCustom = $("subdivCustom"), subdivCustomWrap = $("subdivCustomWrap");
export const tsNumInput = $("tsNum"), tsDenInput = $("tsDen");
export const detectBpmBtn = $("detectBpm"), tapBtn = $("tap"), tapInfo = $("tapInfo");
export const markerPop = $("markerPop"), markerPopTitle = $("markerPopTitle"), markerPopClose = $("markerPopClose");
export const markerBpm = $("markerBpm"), markerTsNum = $("markerTsNum"), markerTsDen = $("markerTsDen");
export const markerSubdiv = $("markerSubdiv"), markerSubdivCustom = $("markerSubdivCustom"), markerSubdivCustomWrap = $("markerSubdivCustomWrap");
export const markerAtEl = $("markerAt"), markerDeleteBtn = $("markerDelete"), markerTime = $("markerTime");
export const sectionMarkerPop = $("sectionMarkerPop"), sectionMarkerPopClose = $("sectionMarkerPopClose");
export const sectionMarkerKind = $("sectionMarkerKind"), sectionMarkerName = $("sectionMarkerName");
export const sectionMarkerNameWrap = $("sectionMarkerNameWrap"), sectionMarkerType = $("sectionMarkerType");
export const sectionMarkerTypeWrap = $("sectionMarkerTypeWrap"), sectionMarkerTime = $("sectionMarkerTime");
export const sectionMarkerDelete = $("sectionMarkerDelete");
export const sectionMarkerHelpIcon = $("sectionMarkerHelpIcon");
export const phraseMarkerPop = $("phraseMarkerPop"), phraseMarkerPopClose = $("phraseMarkerPopClose");
export const phraseMarkerTime = $("phraseMarkerTime"), phraseMarkerDelete = $("phraseMarkerDelete");
export const toneMarkerPop = $("toneMarkerPop"), toneMarkerPopClose = $("toneMarkerPopClose");
export const toneMarkerPreset = $("toneMarkerPreset"), toneMarkerTime = $("toneMarkerTime");
export const toneMarkerDelete = $("toneMarkerDelete");
export const sctx = $("stage").getContext("2d"), rctx = $("ruler").getContext("2d");
export const stage = $("stage"), ruler = $("ruler"), scroll = $("scroll"), viewer = $("viewer");
export const rulerRight = $("rulerRight");
export const stageSpacer = $("stageSpacer");
export const overviewRuler = $("overviewRuler"), overviewRulerCtx = overviewRuler.getContext("2d");
export const minimap = $("minimap"), mmctx = minimap.getContext("2d");
export const zoomResetBtn = $("zoomReset");
export const detectPanel = $("detectPanel"), detectClose = $("detectClose");
export const detectTargetLayer = $("detectTargetLayer");

// A click inside the walkthrough's card is not a click on the app. Every menu
// and popover in here closes on an outside click, and the card is outside all of
// them — so paging a step shut the very menu the step was explaining, and the
// next card then pointed at something that was no longer there. The card is
// chrome about the app, not part of it.
export const inTourCard = (target) => !!(target instanceof Element && target.closest(".tour-card"));
