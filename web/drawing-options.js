export function normalizeTraceRange(value) {
  const range = Number(value);
  return range >= 3 ? '3' : range === 1 ? '1' : '2';
}
