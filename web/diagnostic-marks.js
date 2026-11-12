import { issueInstanceKey } from './issue-identity.js';

// The most recently painted warning bounds are shared by tooltips and pointer
// actions. Keep hit testing independent of the canvas renderer's module graph.
export const warningMarks = [];

export function diagnosticMarksAt(x, y) {
  const entries = new Map();
  for (const mark of warningMarks) {
    if (x < mark.x0 || x > mark.x1 || y < mark.y0 || y > mark.y1 || !mark.tip.diagnostic) continue;
    const entry = mark.tip.diagnostic;
    entries.set(issueInstanceKey(entry.lane, entry.issue), entry);
  }
  return [...entries.values()];
}
