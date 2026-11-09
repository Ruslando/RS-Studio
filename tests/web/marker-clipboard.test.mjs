import test from "node:test";
import assert from "node:assert/strict";
import { landMarkers, markerRange } from "../../web/marker-clipboard-core.js";

test("pasted markers keep their spacing from the earliest one", () => {
  const out = landMarkers([{ kind: "section", t: 12 }, { kind: "tempo", t: 10 }], 30);
  assert.deepEqual(out.map((c) => [c.kind, c.t]), [["section", 32], ["tempo", 30]]);
});

test("a shift-click range takes both ends, in either order", () => {
  const flags = [1, 2, 3, 4].map((t) => ({ t }));
  assert.deepEqual(markerRange(flags, 3, 2).map((f) => f.t), [2, 3]);
  assert.deepEqual(markerRange(flags, 1, 4).length, 4);
});
