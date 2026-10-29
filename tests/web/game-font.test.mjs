// Run: node tests/web/game-font.test.mjs
// Which names need a Latin spelling, and which the game cannot show.
import assert from "node:assert/strict";
import { latinUsable, nameCheck } from "../../web/game-font.js";

// Latin with typographic marks the fonts have: no Latin spelling needed.
for (const name of ["Don’t Stop", "Motörhead", "Œuvre – Live…", "Sigur Rós", "Łaska"]) {
  assert.deepEqual(nameCheck(name), { foreign: false, missing: [] }, name);
}
// Japanese: shown as written, but sorted by a Latin spelling.
assert.deepEqual(nameCheck("伊根 (Ine)"), { foreign: true, missing: [] });
// Scripts and letters the fonts lack: a Latin spelling, and the game shows it.
assert.deepEqual(nameCheck("Кино"), { foreign: true, missing: ["К", "и", "н", "о"] });
assert.deepEqual(nameCheck("Dvořák"), { foreign: true, missing: ["ř"] });
assert.deepEqual(nameCheck("Łódź"), { foreign: true, missing: ["ź"] }, "Ł and ó are in the fonts, ź is not");
assert.deepEqual(nameCheck(""), { foreign: false, missing: [] });

// A Latin spelling must start with a letter or digit and be all Latin the game shows.
assert.ok(latinUsable("Kino"));
assert.ok(latinUsable("Dvorak’s Ninth"));
assert.ok(!latinUsable("’Til Tuesday"), "starts with a mark");
assert.ok(!latinUsable("Dvořák"), "ř is not in the fonts");
assert.ok(!latinUsable("Кино"));

console.log("game-font ok");
