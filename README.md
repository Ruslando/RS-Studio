# RS Studio

RS Studio is a local editor for audio transcription, and Rocksmith 2014 CDLC export.

## Windows: installer

Download `RS Studio Setup.exe` from the
[Releases page](https://github.com/Ruslando/RS-Studio/releases) and run it. It
installs everything into one folder and keeps RS Studio up to date.

Rocksmith export on Windows needs [Wwise](https://www.audiokinetic.com/download/).

## Run from source

### 1. Install the tools

| | Windows | Linux |
| --- | --- | --- |
| [git](https://git-scm.com/) and [uv](https://docs.astral.sh/uv/) | yes | yes |
| FFmpeg 4–9 | step 3 fetches it | from your package manager |
| Rust | no | yes, for Rocksmith export |

On Arch-based systems: `sudo pacman -S git uv ffmpeg rust`

### 2. Get the source

```text
git clone https://github.com/Ruslando/RS-Studio
cd RS-Studio
```

### 3. Windows only: fetch FFmpeg

```text
uv run --no-project tools/fetch-ffmpeg.py
```

### 4. Start

```text
uv run rs-studio app
```

The first start downloads the libraries (about 2 GB) and, on Linux, builds the
Rocksmith audio encoder. `uv run rs-studio serve` starts only the server; open
the printed address in a browser.

### Update

```text
git pull
```

The next start installs whatever changed. RS Studio tells you on its start page
when a new release is out.

## NVIDIA graphics card (optional)

RS Studio uses the CPU by default. To use an NVIDIA card instead (about 7.5 GB):

```text
uv sync --no-group cpu --group cuda
```

Then start RS Studio from the environment, because `uv run` would switch back
to the CPU libraries:

```text
.venv/bin/rs-studio app          Linux
.venv\Scripts\rs-studio app      Windows
```

After `git pull`, run the `uv sync` line again.

## Build a standalone folder

```text
uv run python -m PyInstaller rs-studio.spec --noconfirm
```

The result is `dist/RS Studio/`, about 2 GB, and runs without uv or the source.
On Linux it uses the system's FFmpeg. With the NVIDIA libraries installed, run
`.venv/bin/python` (Windows: `.venv\Scripts\python`) in place of `uv run python`.

## Good to know

- [Keyboard shortcuts](docs/keyboard-shortcuts.md): defaults, marker navigation,
  and actions available for custom bindings.
- Models are optional downloads: **Settings > Models**.
- The **End** section flag marks the song's end, independently of the last charted
  note. New audio estimates it from the audible tail (including a short release
  margin); older projects default to the recording's full length. Drag the flag
  to correct it, or choose **Special > End** in the section editor. The position
  is saved with the project, supports undo, and sets
  Rocksmith's END phrase and final No Guitar section.
- **Settings > Tone presets**: edit a starting tone to create your own preset, change its gear
  and controls, then choose **Apply**. Select your preset in a project's
  tone marker to reference its current settings, including Rocksmith export values.
  Audition tones in Rocksmith. Portable exports include tone definitions;
  imports keep project-local tones only when their app preset is unavailable.
  The designer includes the full DLC Builder gear catalogue, native parameter
  controls, cabinet microphone positions and effect reordering. See
  [Tone presets](docs/sound-designer.md) for the supported workflow and scope.
  Six JSON starting presets live in `presets/sounds` in the app's data directory.
  Add your own JSON files there and reopen Tone presets, or use **Import preset**.
  **Export preset** shares the selected tone. Import and export sit below the preset selector with the other preset actions.
- Linux without Rust: `uv sync --no-group encoder`, then start from `.venv` as
  above. Everything works except Rocksmith export.
- Linux export uses the [`wwise-wem`](https://github.com/rabbit-smith/wem)
  encoder. RS Studio does not ship it; uv builds it on your machine from a
  pinned commit.
- Tests: `uv run python -m unittest discover -s tests`. The browser tests
  need Node.js and Microsoft Edge.
- Packaging the Windows installer:
  [docs/bootstrap-installer.md](docs/bootstrap-installer.md)

## License

RS Studio is licensed under Apache-2.0. See [LICENSE](LICENSE) and
[NOTICE](NOTICE) for license and third-party attribution details.

