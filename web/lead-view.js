// The Rocksmith export's leading silence, shown before the song when the View
// panel's toggle is on (S.leadView; geometry.js maps time around it). As long
// as the package will start with: the live check's measure, since the export
// raises the setting for an early first note; until then, the setting.
import { scroll } from "./dom.js";
import { layout } from "./geometry.js";
import { playbackTime, seekPlayback } from "./playback.js";
import { draw } from "./repaint.js";
import { rsLeadIn } from "./rocksmith-export.js";
import { rocksmithLeadIn } from "./rocksmith-check.js";
import { S } from "./store.js";
import { rememberPref } from "./util.js";

const LS_SHOW = "cw.showLeadIn";
let shown = false;
try { shown = localStorage.getItem(LS_SHOW) === "1"; } catch { /* storage blocked: off */ }

export function syncLeadView() {
  const lead = shown && S.state ? rocksmithLeadIn() ?? rsLeadIn() : 0;
  if (lead === S.leadView) return;
  // Scrolled into the song, it stays where it was on screen; at the very start
  // the view stays there too, so turning it on shows the silence. Read before
  // layout(), which clamps the scroll to the new width.
  const scrolled = scroll.scrollLeft > 0, left = scroll.scrollLeft / S.pxPerSec - S.leadView;
  S.leadView = lead;
  if (!S.state?.spec) return;
  layout();
  if (scrolled) scroll.scrollLeft = Math.max(0, (left + lead) * S.pxPerSec);
  if (playbackTime() < -lead) seekPlayback(-lead);   // the playhead leaves a silence no longer shown
  draw();
}

export function initLeadView() {
  const toggle = document.getElementById("stageLeadIn");
  toggle.checked = shown;
  toggle.addEventListener("change", () => {
    shown = toggle.checked;
    rememberPref(LS_SHOW, shown ? 1 : 0);
    syncLeadView();
  });
  for (const event of ["cw-project-opened", "cw-project-closed", "cw-rocksmith-checked"]) window.addEventListener(event, syncLeadView);
}
