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
                   view: str = 'energy', cents: float = 0.0) -> tuple[Path, Path | None]:
    """The channel's audio and, with `spectrogram`, its image in `view`.

    The image is None when the project's stored one fits: stereo, energy, and no
    `cents` offset (stored spectrograms are always rendered at A440).
    """
    if channel not in ('stereo', 'left', 'right', 'side'):
        raise ValueError('Unknown audio channel')
    from . import pipeline
    if view not in pipeline.SPECTROGRAM_VIEWS:
        raise ValueError('Unknown spectrogram view')
    if channel == 'stereo' and view == 'energy' and not cents:
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
                if view == 'energy' and not cents:
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
        name = (key if view == 'energy' else f'{key}.{view}') + (f'.{cents:+.1f}ct' if cents else '')
        image = cache / f'{name}.png'
        if not image.exists():
            temp = cache / f'{name}.tmp.png'
            try:
                pipeline.compute_spectrogram(audio, temp, view=view, cents=cents)
                temp.replace(image)
                values = Path(str(temp) + ".intensity")
                if values.exists():
                    values.replace(Path(str(image) + ".intensity"))
            finally:
                temp.unlink(missing_ok=True)
        return audio, image


def pitch_shift(source: Path, out: Path, cents: float, codec: list[str]) -> None:
    """Write `source` moved by `cents`, same tempo, encoded with ffmpeg `codec` args.

    Resampling moves pitch and speed together; atempo then puts the speed back.
    """
    # ponytail: atempo (WSOLA) is clean enough at the +-3% a 50 ct shift needs;
    # ffmpeg's rubberband filter sounds better if a build reliably has it.
    ratio = 2 ** (cents / 1200)
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(source), '-map', 'a',
                    '-af', f'aresample=48000,asetrate={48000 * ratio:.3f},aresample=48000,atempo={1 / ratio:.6f}',
                    *codec, str(out)], capture_output=True, check=True, creationflags=flags)


def shifted_audio(source: Path, cents: float) -> Path:
    """Playback audio moved by `cents`, rendered once and cached beside the source."""
    if not cents:
        return source
    stat = source.stat()
    key = hashlib.sha256(f'{source.name}:{stat.st_size}:{stat.st_mtime_ns}'.encode()).hexdigest()[:24]
    out = source.parent / 'channel-cache' / f'{key}.{cents:+.1f}ct.opus'
    with _lock:
        if not out.exists():
            out.parent.mkdir(exist_ok=True)
            temp = out.with_suffix('.tmp.opus')
            try:
                pitch_shift(source, temp, cents, ['-c:a', 'libopus', '-b:a', '128k'])
                temp.replace(out)
            finally:
                temp.unlink(missing_ok=True)
    return out
