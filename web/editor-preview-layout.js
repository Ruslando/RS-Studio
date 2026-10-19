// One geometry for both painting and picking the grid-aligned example notes.
export function notePreviewLayout(width, rowHeight = 12) {
  const cellWidth = 30, gridTop = (128 - 4 * rowHeight) / 2;
  const columns = Math.max(8, Math.floor(width / cellWidth));
  const available = columns - 3, first = Math.floor(available / 2);
  return {
    cellWidth, rowHeight, gridTop,
    notes: [
      { x: cellWidth, y: gridTop + 3 * rowHeight, width: first * cellWidth, height: rowHeight },
      { x: (first + 2) * cellWidth, y: gridTop, width: (available - first) * cellWidth, height: rowHeight },
    ],
  };
}
