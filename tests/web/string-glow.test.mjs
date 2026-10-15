import assert from "node:assert/strict";
import { stringAttackPulse, stringGlow } from "../../web/string-glow.js";

const mark = (extra = {}) => ({ start: 1, strikeStart: 1, string: 2,
  note: { start: 1, end: 3, ...extra } });
assert.equal(stringGlow(mark(), 0.99), 0);
assert.ok(stringGlow(mark(), 1) > 0, "bright immediately on the pick");
assert.equal(stringGlow(mark(), 3), 0);
const early = stringGlow(mark(), 1.04);
assert.ok(early > stringGlow(mark(), 1.6), "brightness fades with ringing energy");
assert.ok(stringGlow(mark({ fx: { ghost: true } }), 1.04) < early);
assert.ok(stringGlow(mark({ fx: { accent: true } }), 1.04) > early);
assert.ok(stringGlow(mark({ fx: { palmMute: true } }), 1.15) < stringGlow(mark(), 1.15));
assert.equal(stringGlow(mark({ fx: { staccato: true } }), 1.2), 0);
assert.equal(stringGlow({ ...mark(), strikeStart: 1.08 }, 1.04), 0, "strum waits for its own pick");
const tremolo = { ...mark(), tremoloStep: 0.125 };
assert.ok(stringGlow(tremolo, 1.14) > stringGlow(tremolo, 1.12), "each tremolo pick refreshes the glow");
for (const effects of [{ bend: "full" }, { fx: { vibrato: true } }, { slide: "shift" }])
  assert.ok(stringGlow(mark(effects), 1.04) > 0, "brightness works alongside authored hand motion");
console.log("string glow OK");

// Fast tremolo has a distinct flash and a real dark gap before each next pick.
for (const step of [0.25, 0.125, 0.0625]) {
  const repeated = { ...mark(), tremoloStep: step };
  assert.equal(stringAttackPulse(repeated, 1), 1);
  assert.equal(stringAttackPulse(repeated, 1 + step * 0.9), 0);
  assert.ok(stringAttackPulse(repeated, 1 + step + 0.001) > 0.9);
  assert.ok(stringGlow(repeated, 1 + step * 0.9) < 0.3);
}
assert.equal(stringAttackPulse(mark(), 0.99), 0);
assert.equal(stringAttackPulse({ ...mark(), slurred: true }, 1.01), 0, "hammer-on is not another pick");
assert.equal(stringAttackPulse({ ...mark(), strikeStart: 1.08 }, 1.04), 0);
assert.ok(stringAttackPulse(mark({ fx: { ghost: true } }), 1.01) < stringAttackPulse(mark(), 1.01));
