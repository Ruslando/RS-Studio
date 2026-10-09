# PyInstaller spec for the standalone desktop build (one-folder).
# Build:  .venv\Scripts\python -m PyInstaller rs-studio.spec --noconfirm
import os
from importlib.metadata import distribution
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, copy_metadata

# Collection hooks import audio modules in subprocesses. Put compatible FFmpeg
# on their inherited PATH and retain its DLL directory in the build process.
_ffmpeg_dll_directories = []
_ffmpeg_dir = Path("vendor/ffmpeg").resolve()
if _ffmpeg_dir.is_dir():
    os.environ["PATH"] = str(_ffmpeg_dir) + os.pathsep + os.environ.get("PATH", "")
    if hasattr(os, "add_dll_directory"):
        _ffmpeg_dll_directories.append(os.add_dll_directory(str(_ffmpeg_dir)))

datas = [("web", "web"), ("assets", "assets"), ("assets", "source/assets")]          # bundle the static UI alongside the app
# Package data from pyproject.toml: Rocksmith export templates read through importlib.resources.
datas += [("src/rs_studio/rocksmith/res", "rs_studio/rocksmith/res")]
# The one-folder build carries visible license notices and the source needed to
# rebuild with a modified LGPL PyGuitarPro library.
datas += [
    ("LICENSE", "."),
    ("NOTICE", "."),
    ("licenses", "licenses"),
    ("README.md", "source"),
    ("LICENSE", "source"),
    ("NOTICE", "source"),
    ("licenses", "source/licenses"),
    ("pyproject.toml", "source"),
    ("uv.lock", "source"),
    ("rs-studio.spec", "source"),
    ("standalone.py", "source"),
    ("tools/fetch-ffmpeg.py", "source/tools"),
    ("tools/fetch-fonts.py", "source/tools"),
]
for source_file in Path("src/rs_studio").rglob("*"):
    if source_file.is_file() and (
        source_file.suffix in {".py", ".json", ".flat", ".wwu"}
        or source_file.name == "LICENSE"
    ):
        datas.append((str(source_file), str(Path("source") / source_file.parent)))

pyguitarpro = distribution("PyGuitarPro")
guitarpro_files = [
    file for file in (pyguitarpro.files or ())
    if file.parts and file.parts[0] == "guitarpro" and file.suffix == ".py"
]
if not guitarpro_files:
    raise RuntimeError("PyGuitarPro source files missing; cannot package LGPL source")
for file in guitarpro_files:
    datas.append((
        str(pyguitarpro.locate_file(file)),
        str(Path("licenses/PyGuitarPro-source") / file.parent),
    ))

basic_pitch = distribution("basic-pitch")
basic_notice = next(
    (file for file in (basic_pitch.files or ())
     if file.name == "NOTICE" and file.parts[0].startswith("basic_pitch-")),
    None,
)
if basic_notice is None or Path(basic_pitch.locate_file(basic_notice)).read_text(encoding="utf-8").replace("\r\n", "\n").strip() != Path(
    "licenses/basic-pitch-NOTICE.txt"
).read_text(encoding="utf-8").replace("\r\n", "\n").strip():
    raise RuntimeError("Update licenses/basic-pitch-NOTICE.txt for the installed basic-pitch")
binaries = []
hiddenimports = []

# Bundle shared FFmpeg binaries (staged in vendor/ffmpeg/) into ffmpeg/; the
# launcher prepends that folder to PATH so _to_wav and Demucs' loader find it.
if os.path.isdir("vendor/ffmpeg"):
    for fn in os.listdir("vendor/ffmpeg"):
        datas.append((os.path.join("vendor", "ffmpeg", fn), "ffmpeg"))

# Packages with data files, bundled models, or lazy/dynamic imports the
# automatic analysis tends to miss.
COLLECT_PKGS = [
    "basic_pitch", "torchcrepe", "piano_transcription_inference",
    "demucs", "librosa", "soundfile", "soxr", "resampy",
    "audioread", "pooch", "lazy_loader", "pretty_midi", "mido", "julius",
    "openunmix", "torchaudio", "torchcodec", "einops", "rotary_embedding_torch",
    "onnxruntime",
    # MT3 detector lane (mt3_infer) + its HuggingFace/torch stack. transformers
    # in particular has many lazy submodule imports PyInstaller won't see.
    "mt3_infer", "transformers", "tokenizers", "safetensors", "huggingface_hub",
    "torchvision",
    # Native window: pywebview ships a JS bridge as package data, and on Windows
    # reaches WebView2 through pythonnet/clr_loader.
    "webview", "clr_loader",
]
for pkg in COLLECT_PKGS:
    try:
        d, b, h = collect_all(pkg)
        datas += d; binaries += b; hiddenimports += h
    except Exception as exc:  # noqa: BLE001 - a missing optional pkg shouldn't break the build
        print(f"[spec] collect_all({pkg}) skipped: {exc}")

# Libs that look up their installed version at runtime via importlib.metadata.
for pkg in ("basic_pitch", "demucs", "librosa", "numba", "llvmlite", "torch",
            "torchaudio", "onnxruntime", "soundfile", "mt3_infer",
            "transformers", "tokenizers", "safetensors", "huggingface_hub",
            "torchvision", "pyguitarpro", "scikit-learn"):
    try:
        datas += copy_metadata(pkg)
    except Exception:
        pass

a = Analysis(
    ["standalone.py"],
    pathex=["src"],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "tensorflow", "tensorflow_intel"],
    noarchive=False,
    # Keep app code outside the runtime archive so small app packages can update it.
    module_collection_mode={"rs_studio": "py"},
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="RS Studio",
    icon="assets/icon.ico",
    # False: the desktop build opens a native window, and a console behind it
    # looks like a crash. Flip to True while debugging a build — the server's
    # log is the only place startup failures surface.
    console=False,
    disable_windowed_traceback=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="RS Studio")


