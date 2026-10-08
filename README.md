# RS Studio

A local desktop editor for transcription, tablature, and Rocksmith 2014 CDLC.
It can separate audio into stems, detect notes with optional models, edit
arrangements, import and export Guitar Pro files, and build Rocksmith packages.

## Run from source

Install Python 3.10, 3.11, or 3.12 and [uv 0.11 or newer](https://docs.astral.sh/uv/).
Install shared FFmpeg 4-8 libraries and put FFmpeg on PATH for source runs.
On Windows, the staging script below fetches compatible FFmpeg 8.1 libraries.
To use those staged files from PowerShell, run
`$env:PATH = "$PWD\vendor\ffmpeg;$env:PATH"` before starting the app.
From this directory:

```text
uv sync --locked
uv run rs-studio app
```

`uv run rs-studio serve` starts the local server without the desktop window.
The editor UI is served from `web/`; it has no JavaScript build step.
Use uv for this source checkout: the project excludes Basic Pitch's unused
TensorFlow, TFLite and Core ML backends and selects ONNX explicitly. Plain
`pip install .` does not apply these exclusions.

The server accepts loopback addresses only and rejects browser requests from
other origins. It is intended for local desktop use, not network hosting.
The app works locally after its optional model downloads. Open **Settings >
Models** to download the models you want; they can also be downloaded later.
Model weights are not part of this source repository.

## Build the desktop app

On Windows, stage the FFmpeg binaries before building:

```text
uv sync --locked
uv run python tools/fetch-ffmpeg.py
uv run python -m PyInstaller rs-studio.spec --noconfirm
```

The result is in `dist/RS Studio/`. The PyInstaller specification includes
`LICENSE`, `NOTICE`, bundled font and vendor license texts, the installed
PyGuitarPro source files, and a source/build recipe in `_internal/`.
The FFmpeg fetcher stages shared FFmpeg 8.1 libraries compatible with TorchCodec
and checks the binary's license configuration. FFmpeg and model
weights are not committed here. Recheck the bundle contents before publishing
a binary release.

On Linux, install FFmpeg 4-8 and its shared libraries through your distribution
and run:

```text
uv sync --locked
uv run python -m PyInstaller rs-studio.spec --noconfirm
```

The native Linux window needs WebKitGTK system bindings; without them, the app
opens in a browser. Linux packaging and Rocksmith export need validation on
the target distribution.

## Rocksmith export

Windows export requires a separate local installation of Wwise 2019 or newer.
Wwise is not bundled. The app checks for it and links to the download page.
On Linux, export uses `oggenc` from `vorbis-tools` and
[`wav2wem`](https://github.com/pas2k/wav2wem) installed on `PATH`; this
route is experimental and still needs playback checks in Rocksmith 2014.

## License

RS Studio is licensed under Apache-2.0; see [LICENSE](LICENSE).
Third-party attributions are in [NOTICE](NOTICE). Their license texts are in
`licenses/` or next to the vendored assets. Instrument samples are distributed
under the upstream CC BY 3.0 statement; source links and file checksums are in
[the sample attribution](web/vendor/samples/README.md).

