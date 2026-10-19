// High-to-low string order, matching the live voicer. Distinct G, C and D grips,
// followed by a G major pentatonic box ascending and descending.
export function fretboardPreviewPhrase(tuning, capo = 0, lastFret = 12) {
  const columns = [];
  let time = 0;
  const add = (contacts, length) => {
    const start = time, end = time + length * .9;
    const fingers = contacts.filter(([string, fret]) => string < tuning.length && fret + capo <= lastFret)
      .map(([string, fret, finger]) => {
        const pitch = tuning[string] + capo + fret;
        return { string, fret, finger, pitch, start, soundingEnd: end, note: { start, end, pitch } };
      });
    const seat = Math.min(lastFret, Math.max(1, Math.min(...fingers.filter(f => f.fret > 0).map(f => f.fret))));
    const shape = fingers.map(f => `${f.string}:${f.fret}`).join(';');
    columns.push({ start, end, seat, shape, fingers }); time += length;
  };
  for (const grip of [
    [[0,3,4],[1,0,0],[2,0,0],[3,0,0],[4,2,1],[5,3,2]],
    [[0,0,0],[1,1,1],[2,0,0],[3,2,2],[4,3,3]],
    [[0,2,2],[1,3,3],[2,2,1],[3,0,0]],
  ]) add(grip, 1.8);
  const root = ((tuning.at(-1) + 3) % 12 + 12) % 12;
  const pentatonic = new Set([0,2,4,7,9].map(n => (root + n) % 12));
  const run = tuning.flatMap((pitch, string) => [2,3,4,5]
    .filter(fret => pentatonic.has((pitch + fret) % 12))
    .map(fret => [string, fret, fret - 1]))
    .sort((a,b) => tuning[a[0]] + a[1] - tuning[b[0]] - b[1]);
  for (const contact of [...run, ...run.slice(0,-1).reverse()]) add([contact], .32);
  return { columns, duration: time + .4 };
}
