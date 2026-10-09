# Small Windows bootstrap: desktop window + stdlib networking, no application/ML imports.
import os
from pathlib import Path
import sys
from importlib.metadata import distribution
from PyInstaller.utils.hooks import collect_all

config = Path(os.environ.get("RS_BOOTSTRAP_CONFIG", "build/bootstrap/bootstrap-release.json")).resolve()
if not config.is_file():
    raise RuntimeError("Generate bootstrap-release.json with tools/package-bootstrap.py first")
datas = [(str(config), "."), ("bootstrap/installer.html", "."), ("assets/icon.ico", "assets"),
         ("web/fonts/atkinson-hyperlegible-next-400-700-latin.woff2", "web/fonts"), ("web/fonts/ibm-plex-mono-400-latin.woff2", "web/fonts"),
         ("web/fonts/AtkinsonHyperlegibleNext-LICENSE.txt", "licenses/fonts"), ("web/fonts/IBMPlexMono-LICENSE.txt", "licenses/fonts"),
         ("licenses/uv", "licenses/uv"), ("LICENSE", "."), ("NOTICE", ".")]
for package in ("pywebview", "pythonnet", "clr_loader", "cffi", "proxy_tools", "bottle"):
    installed = distribution(package)
    for file in installed.files or []:
        if file.name.lower().startswith(("license", "licence", "copying", "notice")) and file.suffix.lower() not in {".py", ".pyc"}:
            source = Path(installed.locate_file(file))
            if source.is_file():
                datas.append((str(source), "licenses/" + package))
python_license = Path(sys.base_prefix) / "LICENSE.txt"
if python_license.is_file():
    datas.append((str(python_license), "licenses/Python"))
# uv installs Python and the hash-pinned libraries on the user's machine.
import shutil
uv = os.environ.get("RS_BOOTSTRAP_UV") or shutil.which("uv")
if not uv:
    raise RuntimeError("uv.exe is required: install uv or set RS_BOOTSTRAP_UV")
binaries = [(uv, ".")]
hiddenimports = []
for package in ("webview", "clr_loader"):
    d, b, h = collect_all(package)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    ["bootstrap/launcher.py"], pathex=["bootstrap"], datas=datas,
    binaries=binaries, hiddenimports=hiddenimports,
    excludes=["rs_studio", "torch", "torchaudio", "torchvision", "numpy", "scipy",
              "llvmlite", "numba", "onnxruntime", "tkinter", "cryptography", "PIL"],
)
pyz = PYZ(a.pure)
# One file: users download a single "RS Studio Setup.exe"; it copies itself into
# the installation as "RS Studio.exe".
exe = EXE(pyz, a.scripts, a.binaries, a.datas, name="RS Studio Setup",
          icon="assets/icon.ico", console=False, upx=False)
