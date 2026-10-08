# RS Studio

RS Studio is a local editor for audio transcription, and Rocksmith 2014 CDLC export.

## Development

Requirements:

- Python 3.10–3.12
- [uv 0.11+](https://docs.astral.sh/uv/)
- FFmpeg 4–8

Install the project and start the development server:

```text
uv sync --locked
uv run rs-studio serve --reload
```

Use `uv run rs-studio app` to open the native desktop window instead. The UI in
`web/` has no JavaScript build step.

On Windows, compatible FFmpeg files can be downloaded with:

```text
uv run python tools/fetch-ffmpeg.py
```

Optional model weights are managed under **Settings > Models** and are not
stored in this repository.

## Releases

Ready-to-run builds are available on the
[GitHub Releases page](https://github.com/Ruslando/RS-Studio/releases).

## Build from source

On Windows, download FFmpeg first, then build the desktop app:

```text
uv run python tools/fetch-ffmpeg.py
uv run python -m PyInstaller rs-studio.spec --noconfirm
```

The runnable build is written to `dist/RS Studio/`. On Linux, install FFmpeg
through the system package manager and run the same PyInstaller command.

## Rocksmith export

Windows export requires a local Wwise installation. Linux export requires
`oggenc` and [`wav2wem`](https://github.com/pas2k/wav2wem) on `PATH`.

## License

RS Studio is licensed under Apache-2.0. See [LICENSE](LICENSE) and
[NOTICE](NOTICE) for license and third-party attribution details.

