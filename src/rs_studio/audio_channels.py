"""Disposable channel-analysis assets; original audio is never modified."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading

_lock = threading.Lock()


def channel_assets(source: Path, channel: str, *, spectrogram: bool = False) -> tuple[Path, Path | None]:
    if channel not in ('stereo', 'left', 'right'):
        raise ValueError('Unknown audio channel')
    if channel == 'stereo':
        return source, None
    from . import pipeline
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    with _lock:
        info = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0',
                               '-show_entries', 'stream=channels', '-of', 'json', str(source)],
                              capture_output=True, text=True, check=True, creationflags=flags)
        channels = json.loads(info.stdout)['streams'][0]['channels']
        if channels == 1:
            return source, None
        if channels != 2:
            raise ValueError('Channel selection requires mono or stereo audio')
        stat = source.stat()
        key = hashlib.sha256(f'{source.name}:{stat.st_size}:{stat.st_mtime_ns}:{channel}'.encode()).hexdigest()[:24]
        cache = source.parent / 'channel-cache'
        cache.mkdir(exist_ok=True)
        audio, image = cache / f'{key}.flac', cache / f'{key}.png'
        if not audio.exists():
            temp = cache / f'{key}.tmp.flac'
            try:
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(source),
                                '-af', f'pan=mono|c0=c{0 if channel == "left" else 1}', str(temp)],
                               capture_output=True, check=True, creationflags=flags)
                temp.replace(audio)
            finally:
                temp.unlink(missing_ok=True)
        if spectrogram and not image.exists():
            temp = cache / f'{key}.tmp.png'
            try:
                pipeline.compute_spectrogram(audio, temp)
                temp.replace(image)
                values = Path(str(temp) + ".intensity")
                if values.exists():
                    values.replace(Path(str(image) + ".intensity"))
            finally:
                temp.unlink(missing_ok=True)
        return audio, image if spectrogram else None
