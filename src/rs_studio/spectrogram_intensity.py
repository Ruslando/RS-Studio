"""16-bit normalized display intensities, stored row-major, highest pitch first."""
import struct
import threading
from pathlib import Path

_lock = threading.Lock()


def write_intensity(path, values):
    import numpy as np
    values = np.clip(values, 0, 1)
    height, width = values.shape
    data = np.rint(values * 65535).astype('<u2')
    temp = Path(str(path) + '.tmp')
    temp.write_bytes(struct.pack('<II', width, height) + data.tobytes())
    temp.replace(path)


def intensity_tile(image: Path, audio: Path, start: int, count: int, stride: int = 1, view: str = 'energy'):
    from . import pipeline
    if stride < 1 or stride > 65536 or stride & (stride - 1):
        raise ValueError('Invalid intensity stride')
    sidecar = Path(str(image) + '.intensity')
    with _lock:
        if not sidecar.exists():
            preview = image.with_name(image.stem + '.intensity-rebuild.png')
            try:
                pipeline.compute_spectrogram(audio, preview, view=view)
                Path(str(preview) + '.intensity').replace(sidecar)
            finally:
                preview.unlink(missing_ok=True)
        with sidecar.open('rb') as stream:
            header = stream.read(8)
            if len(header) != 8:
                raise ValueError('Invalid intensity data')
            width, height = struct.unpack('<II', header)
            if not width or not height or 8 + width * height * 2 != sidecar.stat().st_size:
                raise ValueError('Invalid intensity data')
            if start < 0 or start >= width or count < 1 or count > 1024:
                raise ValueError('Invalid intensity tile')
            import numpy as np
            count = min(count, (width - start + stride - 1) // stride)
            rows = []
            for row in range(height):
                stream.seek(8 + (row * width + start) * 2)
                raw = np.frombuffer(stream.read(min(count * stride, width - start) * 2), dtype='<u2')
                reduced = np.maximum.reduceat(raw, np.arange(0, len(raw), stride))
                rows.append(reduced.astype('<u2').tobytes())
    return struct.pack('<II', count, height) + b''.join(rows)
