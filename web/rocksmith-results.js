// Last completed export check, shared by rails and lead-in display without
// importing the checker or its artifact list. Replacing the map invalidates views.
let results = new Map();
export const checkResults = () => results;
export function replaceCheckResults(found) { results = found; }

// The silence the export will put in front, which it raises past the setting
// for an early first note; null until a check has measured it.
export function rocksmithLeadIn() {
  const lead = [...results.values()][0]?.leadIn;
  return Number.isFinite(lead) ? lead : null;
}

// What the export adds in front of a layer, in editor time: the COUNT phrase's
// start and the count-in events (B0 / B1 ticks). The active layer's when it has
// been checked, else the first checked one; null before any check.
export function rocksmithCountIn(lane) {
  const found = results.get(lane?.id) || [...results.values()][0];
  return found && Array.isArray(found.events) ? { count: found.count, events: found.events } : null;
}

// The events the export writes for one layer, in editor time: [{ t, code }].
export function rocksmithEvents(lane) {
  return results.get(lane?.id)?.events || [];
}

