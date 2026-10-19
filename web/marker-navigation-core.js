// Marker kinds can share one timestamp; navigation visits each time only once.
export function adjacentMarkerTime(markers, time, direction, duration = Infinity) {
  if (!Number.isFinite(time) || ![-1, 1].includes(direction)) return null;
  const times = [...new Set(markers.map(marker => marker.t)
    .filter(t => Number.isFinite(t) && t >= 0 && t <= duration))].sort((a, b) => a - b);
  return (direction < 0 ? times.reverse() : times)
    .find(t => direction < 0 ? t < time - 1e-5 : t > time + 1e-5) ?? null;
}
