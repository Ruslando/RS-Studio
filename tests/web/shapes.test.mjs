// Run: node tests/web/shapes.test.mjs
// Arpeggio and handshape frames: marking, re-marking, unmarking, copying, naming,
// and a grip override inside a shape.
import assert from "node:assert/strict";
import { markShape, remintShapes, renameShape, shapeChord, shapeDefaultName, shapeGroups, shapeLabel, shapeLabelAt, unmarkShape } from "../../web/shapes.js";
import { voiceNotesFingered, voiceNotes, writeColumnOverride } from "../../web/voicing-core.js";

const notes = () => [45, 52, 57, 60, 64].map((pitch, i) => ({ id: `n${i}`, pitch, start: i / 4, end: i / 4 + 0.25 }));

{
  const all = notes();
  assert.equal(markShape(all.slice(0, 1), "shape_1", "arpeggio"), false, "one note frames nothing");
  assert.equal(markShape(all, "shape_1", "chord"), false, "only the two kinds");
  assert.equal(shapeGroups(all).size, 0);
  assert.ok(markShape(all, "shape_1", "arpeggio"));
  assert.equal(shapeGroups(all).get("shape_1").length, 5);
  assert.equal(shapeLabel(all), "Am arp", "the grip is named from every pitch it holds");

  // Re-marking part of it moves those notes; the rest keeps its shape.
  assert.ok(markShape(all.slice(0, 2), "shape_2", "handshape"));
  assert.equal(shapeGroups(all).get("shape_2").length, 2);
  assert.equal(shapeGroups(all).get("shape_1").length, 3);
  assert.equal(shapeLabel(all.slice(0, 2)), "A5", "a handshape carries the plain grip name");

  // A shape down to one note (all others moved, deleted or sent away) is no shape.
  assert.ok(markShape(all.slice(2, 4), "shape_3", "handshape"));
  assert.equal(all[4].shapeId, "shape_1");
  assert.ok(!shapeGroups(all).has("shape_1"), "a lone note is not drawn or exported as a shape");

  unmarkShape(all, "shape_2");
  assert.ok(!("shapeId" in all[0]) && !("shapeKind" in all[0]));
  assert.deepEqual([...shapeGroups(all).keys()], ["shape_3"]);
}

{
  const all = notes();
  markShape(all, "shape_1", "arpeggio");
  let next = 10;
  const copies = all.map((n) => ({ ...n }));
  remintShapes(all.map((n, i) => [n, copies[i]]), () => `shape_${next++}`);
  assert.ok(copies.every((c) => c.shapeId === "shape_10" && c.shapeKind === "arpeggio"), "a copy is its own shape");
  assert.ok(all.every((n) => n.shapeId === "shape_1"), "the source is untouched");

  // Moved notes (source and copy are one note) leave the id behind them.
  const moved = all.slice(0, 2);
  remintShapes(moved.map((n) => [n, n]), () => `shape_${next++}`);
  assert.ok(moved.every((n) => n.shapeId === "shape_11"));
  assert.ok(all.slice(2).every((n) => n.shapeId === "shape_1"));

  const plain = { id: "x", pitch: 40, shapeId: "stale" };
  remintShapes([[{ id: "y", pitch: 40 }, plain]], () => "never");
  assert.ok(!("shapeId" in plain), "a copy of an unshaped note carries no shape");
}

// A custom grip on a column inside a shape keeps the column in it, including a note
// the grip adds; returning to automatic does not revive a shape the column has left.
{
  const column = [
    { id: "a", start: 0, end: 1, pitch: 45, pos: { string: 4, fret: 0 }, shapeId: "shape_1", shapeKind: "handshape" },
    { id: "b", start: 0, end: 1, pitch: 52, pos: { string: 3, fret: 2 }, shapeId: "shape_1", shapeKind: "handshape" },
  ];
  const tail = { id: "c", start: 1, end: 2, pitch: 57, shapeId: "shape_1", shapeKind: "handshape" };
  const lane = [...column, tail];
  // A grip that adds the A on the G string: { notes: voices, shape: voice -> string/fret }.
  const voices = [{ pitch: 45 }, { pitch: 52 }, { pitch: 57 }];
  const choice = { notes: voices, shape: new Map(voices.map((v, i) => [v, { string: 4 - i, fret: [0, 2, 2][i] }])) };
  let id = 0;
  const added = writeColumnOverride(lane, column, choice, {}, () => `new${++id}`);
  assert.equal(added.column.length, 3, "the grip added a note");
  assert.ok(added.column.every((n) => n.shapeId === "shape_1" && n.shapeKind === "handshape"),
    "every note of the overridden column, added ones included, stays in the shape");

  for (const n of added.column) { delete n.shapeId; delete n.shapeKind; }
  const reset = writeColumnOverride(added.notes, added.column, null, {});
  assert.ok(reset.column.every((n) => !("shapeId" in n)), "a reset does not bring back a shape the column left");
}

// A name the user gives replaces the chord, travels with copies and grip overrides,
// and goes when the notes are marked into a new shape or the field is cleared.
{
  const all = notes();
  markShape(all, "shape_1", "arpeggio");
  renameShape(all, "shape_1", "Am(add9)");
  assert.equal(shapeChord(all), "Am(add9)");
  assert.equal(shapeLabel(all), "Am(add9) arp");
  assert.equal(shapeDefaultName(all), "Am", "the field still offers the automatic name");

  const copies = all.map((n) => ({ ...n, shapeName: undefined }));
  remintShapes(all.map((n, i) => [n, copies[i]]), () => "shape_2");
  assert.ok(copies.every((c) => c.shapeName === "Am(add9)"));

  markShape(all.slice(0, 2), "shape_3", "handshape");
  assert.ok(!("shapeName" in all[0]), "a new shape starts with the automatic name");
  renameShape(all, "shape_1", "");
  assert.ok(all.every((n) => !("shapeName" in n)));
}

{
  const column = [
    { id: "a", start: 0, end: 1, pitch: 45, pos: { string: 4, fret: 0 }, shapeId: "s", shapeKind: "arpeggio", shapeName: "Mine" },
    { id: "b", start: 0, end: 1, pitch: 52, pos: { string: 3, fret: 2 }, shapeId: "s", shapeKind: "arpeggio", shapeName: "Mine" },
  ];
  const voices = [{ pitch: 45 }, { pitch: 52 }, { pitch: 57 }];
  const choice = { notes: voices, shape: new Map(voices.map((v, i) => [v, { string: 4 - i, fret: [0, 2, 2][i] }])) };
  const { column: after } = writeColumnOverride(column, column, choice, {}, () => "new");
  assert.ok(after.every((n) => n.shapeName === "Mine"), "a note a grip adds takes the shape's name too");
}

{
  const labels = [{ lane: {}, id: "shape_1", x: 10, y: 20, w: 50, h: 14 }];
  assert.equal(shapeLabelAt(labels, 30, 25).id, "shape_1");
  assert.equal(shapeLabelAt(labels, 70, 25), null);
}

// THE FINGERING PLAYS A SHAPE AS ONE GRIP. C D E D C on its own is voiced along
// one string; marked, it is one grip: one fret per string, one hand, one finger per
// pitch. Only marked notes change.
{
  const E = [64, 59, 55, 50, 45, 40];
  const run = (extra = {}, pitches = [60, 62, 64, 62, 60]) =>
    pitches.map((pitch, i) => ({ id: `v${i}`, pitch, start: i / 4, end: i / 4 + 0.25, ...extra }));
  const strings = (r, notes) => notes.map((n) => r.voiced.get(n));
  const oneGrip = (positions) => {
    const fretOn = new Map();
    return positions.every((p) => p && (fretOn.get(p.string) ?? p.fret) === p.fret && fretOn.set(p.string, p.fret));
  };

  const plain = run();
  assert.ok(!oneGrip(strings(voiceNotesFingered(plain, E, Infinity, { instrument: "electric" }), plain)),
    "the fixture: unmarked, the run uses one string on two frets");

  const marked = run({ shapeId: "s1", shapeKind: "arpeggio" });
  const r = voiceNotesFingered(marked, E, Infinity, { instrument: "electric" });
  assert.ok(oneGrip(strings(r, marked)), "marked, every string holds one fret");
  assert.equal(new Set(marked.map((n) => r.seats.get(n))).size, 1, "the hand stays put");
  for (const pitch of [60, 62]) {
    const same = marked.filter((n) => n.pitch === pitch);
    assert.equal(new Set(same.map((n) => r.fingers.get(n))).size, 1, `${pitch} is one finger every time`);
  }
  const fromVoiceNotes = voiceNotes(marked, E, Infinity, { instrument: "electric" });
  assert.deepEqual(marked.map((n) => fromVoiceNotes.get(n)), strings(r, marked), "every entry point agrees");

  // A position the player pinned stays, and the grip is built around it.
  const pinned = run({ shapeId: "s1", shapeKind: "handshape" });
  pinned[2].pos = { string: 1, fret: 5, scope: "local", follow: "here" };   // E on the B string
  const rp = voiceNotesFingered(pinned, E, Infinity, { instrument: "electric" });
  assert.deepEqual(rp.voiced.get(pinned[2]), { string: 1, fret: 5 });
  assert.ok(oneGrip(strings(rp, pinned)));

  // A technique that needs a fretted note never gets an open string in the grip:
  // A minor picked with vibrato on the top E cannot be the open chord.
  const am = run({ shapeId: "s1", shapeKind: "arpeggio" }, [45, 52, 57, 60, 64]);
  const ra = voiceNotesFingered(am, E, Infinity, { instrument: "electric" });
  assert.ok(oneGrip(strings(ra, am)));
  am[4].fx = { vibrato: true };
  const rv = voiceNotesFingered(am, E, Infinity, { instrument: "electric" });
  assert.ok(rv.voiced.get(am[4]).fret > 0, "the vibrato note is fretted");
  assert.ok(oneGrip(strings(rv, am)), "and the rest of the grip moves with it");

  // More pitches than strings: no grip holds them, so they are voiced as usual.
  const wide = run({ shapeId: "s1", shapeKind: "arpeggio" }, [40, 45, 50, 55, 59, 64, 67]);
  const rw = voiceNotesFingered(wide, E, Infinity, { instrument: "electric" });
  assert.ok(wide.every((n) => rw.voiced.get(n)), "still voiced");

  // Notes outside the shape are untouched by it.
  const outside = [...run({ shapeId: "s1", shapeKind: "arpeggio" }), { id: "late", pitch: 67, start: 3, end: 3.5 }];
  const alone = { id: "late", pitch: 67, start: 3, end: 3.5 };
  const ro = voiceNotesFingered(outside, E, Infinity, { instrument: "electric" });
  const rn = voiceNotesFingered([...run(), alone], E, Infinity, { instrument: "electric" });
  assert.ok(ro.voiced.get(outside.at(-1)) && rn.voiced.get(alone));
}

console.log("shapes: ok");
