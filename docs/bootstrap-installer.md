# Bootstrap installer

The Windows download contains only the launcher (Python/pywebview, standard-library
networking), a bundled uv.exe and license notices. It does not contain PyTorch,
LLVM, ONNX, NumPy, FFmpeg or the audio stack, and does not require a Python
installation. The launcher opens its own window before importing any
application modules. Windows uses WebView2, as the existing desktop app does.

The GitHub release hosts only small assets: the signed manifest, the app
package (code, web UI, hash-pinned requirements) and an LGPL FFmpeg build.
**The Python libraries come from their original sources**: uv downloads
Python 3.12 (python-build-standalone), the locked libraries from PyPI and, for
CUDA, GPU-enabled PyTorch from download.pytorch.org. Every library is pinned by
version and SHA-256 hash (exported from uv.lock), so every user gets the same,
tested set. Optional model weights remain managed by Settings > Models.

## Core and CUDA

The setup window lists **Core** (required) and **NVIDIA CUDA acceleration**
(optional). Choosing CUDA installs the +cu126 PyTorch wheels instead of the CPU
ones (requirements/cuda.txt); it also runs without a GPU.

Before offering it, the launcher asks nvidia-smi (shipped with every NVIDIA
driver) for each GPU's compute capability, driver version and memory. CUDA is
pre-selected only when a GPU can run the architectures compiled into the CUDA
torch (stored in the manifest as cuda_archs) with a CUDA 12 driver (528.33+).
Otherwise the option stays available with the reason it would not help, for
example no NVIDIA GPU, an outdated driver, or a GPU newer than the build
(RTX 50-series needs sm_120, which cu126 torch does not include).

## Portable installation folder

RS Studio installs into one folder, by default "RS Studio" next to the setup
EXE; Browse… picks another one. Everything, including projects and models,
stays inside, and deleting the folder removes RS Studio. Nothing is written to
the registry; the Start menu and desktop shortcuts on the finish page are the
only files outside the folder.

A chosen folder follows the usual installer rules: an empty folder or an
existing installation is used as is, any other folder gets an "RS Studio"
subfolder, and a folder with foreign files is never filled. Setup recognises
what the folder holds:

- an installation: shows its version and offers **Open** or **Repair**
  (Repair re-checks every library and downloads only missing or changed ones);
- an interrupted installation: **Continue**, reusing finished downloads;
- nothing: **Install**.

After installing, setup copies itself into the folder as RS Studio.exe. Started
from there it opens the app offline, or shows setup to repair it.

## Installation and startup

1. Start the small launcher. Validate an existing installation locally, without
   contacting the network, or fetch the signed first-install manifest.
2. Show the components and approximate download size; Install and open starts.
3. Download the app and FFmpeg packages into resumable .part files, check
   SHA-256, extract with path, link, file count and size guards.
4. uv creates a private virtual environment (Python version from the manifest)
   and runs `uv pip sync --require-hashes` with the requirements file of the
   chosen runtime. The uv cache makes a retry after a network error fast.
5. Run `standalone.py --bootstrap-check`. It loads the actual application,
   representative native/audio/ML libraries and checks the FFmpeg executables.
6. Atomically activate current.json only after the startup check succeeds.
7. Start the application. Subsequent launches use the local installation offline.

Closing setup cancels downloads (and stops uv). Retry is available after
network, signature, disk-space, extraction or library errors. Installation
locking prevents concurrent writers. A failed replacement does not change the
previous active manifest. Missing or truncated app/FFmpeg files lead back to
setup; the environment is identified by its requirements hash and receipt.

    RS Studio/   (portable folder)
      RS Studio.exe           launcher (opens the app, offers repair)
      current.json            active manifest + chosen runtime (core/cuda)
      downloads/wheels/       verified wheels of this release (kept) + resumable .part files
      cache/                  uv cache
      python/                 uv-managed Python
      envs/<runtime>-<hash>/  virtual environment per requirements file
      versions/app/<id>-<hash>/
      versions/ffmpeg/<id>-<hash>/
      data/                   runs, models, checkpoints

Existing portable/source runs retain their old paths. This installer does not
migrate data from an existing portable installation.

## Build and release

**In one step:** `tools/release.py` sets the version, tags, packages, builds
the setup EXE and publishes the GitHub release with its four assets
(RS-Studio-Setup.exe, bootstrap-manifest.json, the app and FFmpeg ZIPs). It
refuses to run outside a clean main checkout and publishes nothing until all
builds succeeded. Requires the GitHub CLI (winget install GitHub.cli, then
gh auth login).

    build/cpu-venv/Scripts/python tools/release.py 0.2.2-alpha --notes notes.txt
    build/cpu-venv/Scripts/python tools/release.py 0.2.2-alpha --dry-run

The steps it runs are described below.

Generate a release signing identity **once** and keep it private, backed up and
outside version control. Later releases must retain the same public key.

    uv run python tools/package-bootstrap.py --generate-key --signing-key .local-tools/bootstrap-signing-key.pem

Stage the LGPL FFmpeg build (once per FFmpeg update):

    uv run python tools/fetch-ffmpeg.py

Package and sign the release with its intended GitHub Release asset URL. Run it
with a Python of the version the release should install (build/cpu-venv is
3.12.13). It exports requirements/core.txt from uv.lock, derives
requirements/cuda.txt by swapping in the +cu126 torch wheels from
download.pytorch.org, and reads the compiled GPU architectures from --cuda-venv
(default .venv, which must hold the same torch +cu126):

    build/cpu-venv/Scripts/python tools/package-bootstrap.py --version 0.1.1-alpha --signing-key .local-tools/bootstrap-signing-key.pem --base-url https://github.com/Ruslando/RS-Studio/releases/download/v0.1.1-alpha --output dist/bootstrap-release

It produces:

- RS-Studio-app-0.1.1-alpha.zip
- RS-Studio-ffmpeg-windows-x64.zip
- bootstrap-manifest.json (signed payload)
- bootstrap-release.json (launcher URL + pinned public key; no secrets)

Build the small launcher with the generated public configuration, in PowerShell.
It bundles the uv.exe found on PATH (or RS_BOOTSTRAP_UV):

    $env:RS_BOOTSTRAP_CONFIG = (Resolve-Path dist/bootstrap-release/bootstrap-release.json).Path
    build/cpu-venv/Scripts/python -m PyInstaller rs-bootstrap.spec --noconfirm --distpath dist/bootstrap-launcher --workpath build/bootstrap-launcher

This produces one file, dist/bootstrap-launcher/RS Studio Setup.exe. The app ZIP,
the FFmpeg ZIP and bootstrap-manifest.json must be uploaded to the release
**before** distributing the setup.

The setup looks for bootstrap-manifest.json in the **latest** GitHub release
(releases/latest/download/...), so one setup EXE keeps installing the newest
version. GitHub's "latest" ignores releases marked as pre-release; override
with --manifest-url if needed. The EXE is not code-signed, so Windows
SmartScreen asks users to confirm the first start.
No script in this change uploads or publishes assets.

The launcher verifies RSA PKCS#1 v1.5 / SHA-256 signatures using a 3072-bit or
larger pinned public key. Production transport is HTTPS, including redirects.
Library integrity comes from the hashes inside the signed app package.

## Local verification

The source launcher supports explicit localhost HTTP for integration tests.
Frozen launchers do not accept --allow-local. A localhost manifest/configuration
must never be distributed as a production launcher.

    uv run python -m unittest discover -s tests

For a complete local preview, package with
--base-url http://127.0.0.1:8099 --allow-local --output dist/bootstrap-test-release,
then run:

    uv run python tools/try-bootstrap.py

This starts the loopback asset server and opens the setup window. It installs
into build/bootstrap-preview-install, leaving user installations untouched.
Libraries are still downloaded from PyPI / download.pytorch.org.

## Updates

The installation keeps the setup's public configuration
(bootstrap-release.json). On the start page the app checks the latest
release's signed manifest once per start and via **Check for updates**
(rs_studio/updates.py, GET /api/update). A newer version marks that button;
its dialog lists the release notes (package with --notes FILE).

**Update now** (POST /api/update/install) starts RS Studio.exe --update and
exits. The launcher waits for the app to close, installs only what changed
(new app package, changed libraries), verifies it, switches current.json and
reopens RS Studio. The previous version stays untouched until the switch.

To try the UI from a source run, point it at the bootstrap-release.json of a
signed test release (served on loopback) whose manifest names a newer version:

    $env:RS_STUDIO_UPDATE_CONFIG = "dist\bootstrap-test-release\bootstrap-release.json"
    $env:RS_STUDIO_ALLOW_LOCAL = "1"
    uv run rs-studio serve
