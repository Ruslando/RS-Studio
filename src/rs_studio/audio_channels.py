"""Disposable channel-analysis assets; original audio is never modified."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading

_lock = threading.Lock()
# Side = (L - R) / 2: removes everything panned dead centre (bass, vocals, kick)
# and keeps what differs between the speakers, e.g. double-tracked guitars.
PAN = {'left': 'c0', 'right': 'c1', 'side': '0.5*c0-0.5*c1'}


def channel_assets(source: Path, channel: str, *, spectrogram: bool = False,
                   view: str = 'energy') -> tuple[Path, Path | None]:
    if channel not in ('stereo', 'left', 'right', 'side'):
        raise ValueError('Unknown audio channel')
    from . import pipeline
    if view not in pipeline.SPECTROGRAM_VIEWS:
        raise ValueError('Unknown spectrogram view')
    if channel == 'stereo' and view == 'energy':
        return source, None
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    cache = source.parent / 'channel-cache'
    with _lock:
        audio = source
        if channel != 'stereo':
            info = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0',
                                   '-show_entries', 'stream=channels', '-of', 'json', str(source)],
                                  capture_output=True, text=True, check=True, creationflags=flags)
            channels = json.loads(info.stdout)['streams'][0]['channels']
            if channels not in (1, 2):
                raise ValueError('Channel selection requires mono or stereo audio')
            if channels == 1:
                channel = 'stereo'  # ponytail: mono has no side signal; shows the mono audio instead
                if view == 'energy':
                    return source, None
        stat = source.stat()
        key = hashlib.sha256(f'{source.name}:{stat.st_size}:{stat.st_mtime_ns}:{channel}'.encode()).hexdigest()[:24]
        cache.mkdir(exist_ok=True)
        if channel != 'stereo':
            audio = cache / f'{key}.flac'
            if not audio.exists():
                temp = cache / f'{key}.tmp.flac'
                try:
                    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(source),
                                    '-af', f'pan=mono|c0={PAN[channel]}', str(temp)],
                                   capture_output=True, check=True, creationflags=flags)
                    temp.replace(audio)
                finally:
                    temp.unlink(missing_ok=True)
        if not spectrogram:
            return audio, None
        name = key if view == 'energy' else f'{key}.{view}'
        image = cache / f'{name}.png'
        if not image.exists():
            temp = cache / f'{name}.tmp.png'
            try:
                pipeline.compute_spectrogram(audio, temp, view=view)
                temp.replace(image)
                values = Path(str(temp) + ".intensity")
                if values.exists():
                    values.replace(Path(str(image) + ".intensity"))
            finally:
                temp.unlink(missing_ok=True)
        return audio, image
