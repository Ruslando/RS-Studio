// Beat clocks and inclusion tolerance shared by reference editing and fingering.
import { beatClock } from "./bars.js";
import { timingSegments, minDur, segStep, gridAt } from "./grid-read.js";
import { timingData, timingIdOf } from "./timing.js";

export const laneClock = (lane) => beatClock(timingSegments(timingData(timingIdOf(lane))));
export const boxMinIn = (t) => Math.min(minDur(), segStep(gridAt(t)) || minDur());
