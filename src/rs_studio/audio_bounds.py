"""Conservative audible end estimate; no beat or note detection required."""
from __future__ import annotations


def audible_end(samples, sample_rate: int) -> float:
    import numpy as np

    y = np.asarray(samples, dtype=np.float64)
    if y.ndim > 1:
        y = np.max(np.abs(y), axis=1)
    duration = len(y) / sample_rate
    if not len(y):
        return duration
    # 10 ms energy windows, 60 dB below the loudest window. Retain a 100 ms
    # margin for fades/reverb; silent recordings retain their entire duration.
    size = max(1, int(sample_rate * 0.01))
    padded = np.pad(y, (0, (-len(y)) % size))
    energy = np.sqrt(np.mean(padded.reshape(-1, size) ** 2, axis=1))
    peak = float(energy.max())
    if peak <= 1e-8:
        return duration
    active = np.flatnonzero(energy >= max(1e-8, peak * 0.001))
    return min(duration, (int(active[-1]) + 1) * size / sample_rate + 0.1)
