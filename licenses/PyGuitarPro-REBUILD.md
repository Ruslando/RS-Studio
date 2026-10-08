# Rebuilding with a modified PyGuitarPro

The Windows RS Studio build includes PyGuitarPro under LGPL-3.0-only.
Its installed Python source is copied into
`_internal/licenses/PyGuitarPro-source/guitarpro/` in the one-folder build.
`_internal/licenses/PyGuitarPro-LGPL-3.0.txt` and
`_internal/licenses/GPL-3.0.txt` contain the license texts.

The same build includes RS Studio application source and build files under
`_internal/source/`. The web UI source is under `_internal/web/`.

To rebuild a modified version on Windows:

1. Copy the contents of `_internal/source/` to a new working directory.
   Copy `_internal/web/` into that directory as `web/`.
2. Install Python 3.10-3.12 and uv. Run `uv sync --locked` in the working
   directory. This installs the locked PyGuitarPro release.
3. Replace the Python files in `.venv/Lib/site-packages/guitarpro/` with your
   modified copies of the files under
   `_internal/licenses/PyGuitarPro-source/guitarpro/`.
4. Run `uv run python tools/fetch-ffmpeg.py` to stage FFmpeg, followed by
   `uv run python -m PyInstaller rs-studio.spec --noconfirm`.

The resulting one-folder application is in `dist/RS Studio/`. Wwise is a
separate optional dependency for Rocksmith export and is not bundled.
