// Marker kinds can share one timestamp; navigation visits each time only once.
// `start` lets it into the leading silence, where the export's own marks sit.
export function adjacentMarkerTime(markers, time, direction, duration = Infinity, start = 0) {
  if (!Number.isFinite(time) || ![-1, 1].includes(direction)) return null;
  const times = [...new Set(markers.map(marker => marker.t)
    .filter(t => Number.isFinite(t) && t >= start - 1e-6 && t <= duration))].sort((a, b) => a - b);
  return (direction < 0 ? times.reverse() : times)
    .find(t => direction < 0 ? t < time - 1e-5 : t > time + 1e-5) ?? null;
}
