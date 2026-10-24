"""Beat and downbeat times -> the editor's grid: a start tempo/meter plus markers.

Works like Editor on Fire's anchors: the grid keeps one tempo for as long as it
stays on the detected beats, and a new marker goes on the downbeat where it
stops doing so, or where the meter changes. A steady song gets one
tempo and no markers; a drifting one gets as many markers as it needs.

Pure numpy, so it is testable without audio or models.
"""
from __future__ import annotations

import numpy as np

# When the grid has left the beats: a bar that sits more than TOLERANCE off
# (the median of its beats' signed misses), or any one beat more than OUTLIER.
# Judging where the bar sits, not its worst beat, lets per-beat noise cancel
# out (beat_this reports on a 20 ms frame grid and wavers in sparse passages)
# while real drift, which moves every beat the same way, still gets its marker.
TOLERANCE = 0.03
OUTLIER = 0.08
# A meter has to hold this many bars in a row to count. Shorter stretches are
# usually a misplaced downbeat (4,5,3,4) or a messy ending.
MIN_METER_BARS = 4


def _bars(beats: np.ndarray, downbeats: np.ndarray | None) -> list[list[int]]:
    """[first beat index, beat count] per bar."""
    # Without downbeats, or with one on most beats (a detector that lost the bar),
    # assume 4/4 from the first beat.
    if downbeats is None or len(downbeats) < 2 or len(downbeats) > len(beats) / 1.8:
        starts = list(range(0, len(beats), 4))
    else:
        nearest = np.abs(beats[None, :] - np.asarray(downbeats, float)[:, None]).argmin(axis=1)
        starts = sorted(set(int(i) for i in nearest))
    bars = [[a, b - a] for a, b in zip(starts, starts[1:])]
    if bars and len(beats) > starts[-1]:
        bars.append([starts[-1], len(beats) - starts[-1]])   # the last bar may be cut short
    return [bar for bar in bars if bar[1] > 0]


def _recut(first: int, total: int, meter: int) -> list[list[int]]:
    """`total` beats from `first` as bars of `meter`; the rest is one short bar."""
    return [[first + k, min(meter, total - k)] for k in range(0, total, meter)]


def _steady_meters(bars: list[list[int]]) -> list[list[int]]:
    """Keep meters that hold for MIN_METER_BARS; re-cut everything between them.

    A stretch between steady meters (4,5,3,4 from a misplaced downbeat, a messy
    ending, a passage the detector lost) becomes bars of the meter before it.
    Whatever doesn't divide stays as one short bar, so the next steady stretch
    still starts on its own downbeat. A stretch before the first steady meter
    is cut from its end instead: the beats left over at the start are a pickup.
    """
    runs: list[tuple[int, list]] = []
    for bar in bars:
        if runs and runs[-1][0] == bar[1]:
            runs[-1][1].append(bar)
        else:
            runs.append((bar[1], [bar]))
    steady = [count >= 2 and len(run) >= MIN_METER_BARS for count, run in runs]
    if not any(steady):   # nothing holds: the commonest count of 2 or more, else 4
        counts = [bar[1] for bar in bars if bar[1] >= 2]
        meter = max(set(counts), key=counts.count) if counts else 4
        return _recut(bars[0][0], sum(bar[1] for bar in bars), meter)
    out: list[list[int]] = []
    i = 0
    while i < len(runs):
        if steady[i]:
            out += runs[i][1]
            i += 1
            continue
        j = i
        while j < len(runs) and not steady[j]:
            j += 1
        first, total = runs[i][1][0][0], sum(bar[1] for _, run in runs[i:j] for bar in run)
        if out:
            out += _recut(first, total, out[-1][1])
        else:   # leading stretch: whole bars of the first steady meter, back from it
            meter = runs[j][0]
            pickup = total % meter
            out += _recut(first + pickup, total - pickup, meter)
        i = j
    # A one-beat bar is a stray downbeat: join a neighbour. The song's last bar
    # may be that short; it is only cut off.
    for k in range(len(out) - 2, -1, -1):
        if out[k][1] == 1 and len(out) > 1:
            if k > 0:
                out[k - 1][1] += 1
            else:
                out[1] = [out[0][0], out[1][1] + 1]
            del out[k]
    return out


def _fit(beats: np.ndarray, first: int, last: int) -> tuple[float, float, np.ndarray]:
    """(start time, seconds per beat, each beat's signed miss) of a line through beats[first:last]."""
    y = beats[first:last]
    x = np.arange(len(y), dtype=float)
    if len(y) < 2:
        return float(y[0]), 0.5, np.zeros(len(y))
    slope, start = np.polyfit(x, y, 1)
    return float(start), float(slope), y - (start + slope * x)


def _stretches(off: list[float]) -> list[int]:
    """Start indices of the fewest stretches in which every offset is within
    TOLERANCE of the stretch's middle (exact, by dynamic programming); among
    equally few, the tightest."""
    n = len(off)
    best = [(0, 0.0)] + [(n + 1, 0.0)] * n   # best[j]: (stretches, total spread) for off[:j]
    cut = [0] * (n + 1)
    for j in range(1, n + 1):
        low = high = off[j - 1]
        for i in range(j - 1, -1, -1):
            low, high = min(low, off[i]), max(high, off[i])
            if high - low > 2 * TOLERANCE:
                break
            score = (best[i][0] + 1, best[i][1] + high - low)
            if score < best[j]:
                best[j], cut[j] = score, i
    starts, j = [], n
    while j > 0:
        starts.append(cut[j])
        j = cut[j]
    return starts[::-1]


def _phase_jumps(beats: np.ndarray, bars: list[list[int]], run: list[dict]) -> list[dict] | None:
    """`run` as one tempo with markers only where the grid's phase has to move,
    or None when that doesn't fit.

    Each bar's offset is the median miss of its beats from one straight grid;
    _stretches groups the bars. A jump tilts a line fitted straight through it,
    so the tempo is then re-estimated with each stretch at its own phase, and
    the bars grouped again.
    """
    lo, hi = run[0]["first"], run[-1]["end"]
    in_run = [bar for bar in bars if lo <= bar[0] < hi]
    _, spb, _ = _fit(beats, lo, hi)
    starts = [0]
    for _ in range(2):
        off = [float(np.median(beats[f:f + c] - spb * (np.arange(f, f + c) - lo))) for f, c in in_run]
        starts = _stretches(off)
        # Pooled slope: every stretch at its own phase, one tempo for all.
        num = den = 0.0
        for a, b in zip(starts, starts[1:] + [len(in_run)]):
            first, end = in_run[a][0], in_run[b - 1][0] + in_run[b - 1][1]
            x = np.arange(first, end, dtype=float)
            if len(x) > 1:
                num += float(((x - x.mean()) * (beats[first:end] - beats[first:end].mean())).sum())
                den += float(((x - x.mean()) ** 2).sum())
        spb = num / den if den else spb
    off = [float(np.median(beats[f:f + c] - spb * (np.arange(f, f + c) - lo))) for f, c in in_run]
    starts = _stretches(off)
    segs = []
    for a, b in zip(starts, starts[1:] + [len(in_run)]):
        first, end = in_run[a][0], in_run[b - 1][0] + in_run[b - 1][1]
        level = (min(off[a:b]) + max(off[a:b])) / 2   # every bar within TOLERANCE of it
        t = level + spb * (first - lo)
        if np.abs(beats[first:end] - (t + spb * np.arange(end - first))).max() > OUTLIER:
            return None
        segs.append({**run[0], "first": first, "end": end, "t": t, "spb": spb})
    return segs


def _shared_tempo(beats: np.ndarray, bars: list[list[int]], segments: list[dict]) -> list[dict]:
    """Segments as they ship, with as few tempi and markers as the beats allow.

    A marker often only moves the grid's phase: the band played on, a beat or a
    cut sits a little off. So each run in one meter first tries one tempo with
    markers only at phase jumps (_phase_jumps), and keeps its own tempo per
    segment only when that needs more markers or doesn't fit (a real tempo change).
    """
    runs: list[list[dict]] = []
    for seg in segments:
        if runs and runs[-1][-1]["tsNum"] == seg["tsNum"]:
            runs[-1].append(seg)
        else:
            runs.append([seg])
    result: list[dict] = []
    for run in runs:
        jumps = _phase_jumps(beats, bars, run)
        if jumps is not None and len(jumps) <= len(run):
            result += jumps
            continue
        for seg in run:
            start, spb, _ = _fit(beats, seg["first"], min(len(beats), seg["end"] + 1))
            result.append({**seg, "t": start, "spb": spb})
    return result


def tempo_map(beats, downbeats=None) -> dict:
    """{bpm, offset, tsNum, tsDen, tempoMap} for the editor's grid.

    `offset` is the first downbeat; beats before it are a pickup. Every
    tempoMap marker starts a bar on a detected downbeat.
    """
    beats = np.sort(np.asarray(beats, float))
    if len(beats) < 2:
        return {"bpm": 120.0, "offset": float(beats[0]) if len(beats) else 0.0,
                "tsNum": 4, "tsDen": 4, "tempoMap": []}
    bars = _steady_meters(_bars(beats, downbeats))
    segments: list[dict] = []
    seg_first = seg_end = None
    meter = None
    for first, count in bars:
        end = first + count
        cut_short = end == len(beats) and seg_first is not None and count < meter   # the song ends mid-bar
        if seg_first is not None and (count == meter or cut_short):
            last = end + 1 if end < len(beats) else end   # through the next downbeat
            *_, miss = _fit(beats, seg_first, last)
            if abs(np.median(miss[first - seg_first:])) <= TOLERANCE and np.abs(miss).max() <= OUTLIER:
                seg_end = end
                continue
        if seg_first is not None:
            segments.append({"first": seg_first, "end": seg_end, "tsNum": meter})
        seg_first, seg_end, meter = first, end, count
    segments.append({"first": seg_first, "end": seg_end, "tsNum": meter})

    out = []
    for seg in _shared_tempo(beats, bars, segments):
        out.append({"t": round(seg["t"], 4), "bpm": round(60.0 / seg["spb"], 3), "tsNum": int(seg["tsNum"]), "tsDen": 4})
    head, rest = out[0], out[1:]
    return {"bpm": head["bpm"], "offset": max(0.0, head["t"]), "tsNum": head["tsNum"], "tsDen": 4, "tempoMap": rest}
