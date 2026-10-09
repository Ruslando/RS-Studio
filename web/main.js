// Entry point: imports every feature module and runs their init (event wiring,
// initial render) in the original top-to-bottom order.

import { init_project } from "./project.js";
import { init_detect } from "./detect.js";
import { init_ui } from "./ui.js";
import { init_grid } from "./grid.js";
import { init_lanes } from "./lanes.js";
import { init_draw } from "./draw.js";
import { init_settings } from "./settings.js";
import { init_tracing } from "./tracing.js";
import { init_interaction } from "./interaction.js";
import { init_sidebar } from "./sidebar.js";
import { init_fretboard } from "./fretboard.js";
import { init_geometry } from "./geometry.js";
import { init_tablature } from "./tablature.js";
import { init_edit } from "./edit.js";
import { init_playback } from "./playback.js";
import { init_markers } from "./markers.js";
import { init_phrase_markers } from "./phrase-markers.js";
import { init_section_markers } from "./section-markers.js";
import { init_tone_markers } from "./tone-markers.js";
import { init_guitar_pro_import } from "./guitar-pro-import.js";
import { init_rocksmith_export } from "./rocksmith-export.js";
import { init_tour } from "./tour.js";
import { init_setup } from "./setup.js";
import { init_updates } from "./updates.js";
import { initModalFocus } from "./modal-focus.js";
import { initSelectPickers } from "./select-pickers.js";

init_project();
init_detect();
init_ui();
init_grid();
init_lanes();
init_draw();
init_settings();   // restore persisted prefs before features read their inputs
init_tracing();
init_interaction();
init_sidebar();
init_fretboard();   // before init_geometry: the stage measures the height this leaves it
init_geometry();
init_tablature();
init_edit();
init_playback();
init_markers();
init_section_markers();
init_phrase_markers();
init_tone_markers();
init_guitar_pro_import();
init_rocksmith_export();
init_tour();
init_setup();
init_updates();
initModalFocus();
initSelectPickers();
