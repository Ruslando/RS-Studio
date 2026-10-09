"""Package the app + FFmpeg and sign a first-install release.

The libraries themselves are not packaged: the release ships hash-pinned
requirements (exported from uv.lock) and the launcher's bundled uv installs them
from PyPI, or GPU-enabled PyTorch from download.pytorch.org for CUDA.
Run with the Python version the release should install. No upload is performed.
"""
from __future__ import annotations

import argparse
import ast
import base64
import hashlib
import json
import platform
import re
import subprocess
import sys
import tempfile
import tomllib
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

from packaging.markers import Marker
from packaging.tags import sys_tags
from packaging.utils import parse_wheel_filename

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bootstrap"))
from installer import ID, LAUNCHER_VERSION, canonical, checked_url, platform_id

CUDA_INDEX = "https://download.pytorch.org/whl/cu126"
AGENT = {"User-Agent": "RS-Studio-Packager/1"}  # the PyTorch CDN rejects urllib's default agent
CUDA_PACKAGES = ("torch", "torchaudio", "torchvision")  # the only packages that differ for CUDA


def public_key(key) -> dict:
    numbers = key.public_key().public_numbers()
    return {"n": format(numbers.n, "x"), "e": numbers.e}


def write_zip(destination: Path, files: dict[str, Path | bytes]) -> dict:
    # The installer rejects paths that collide case-insensitively; fail here instead.
    if len({name.casefold() for name in files}) != len(files):
        raise RuntimeError("Case-insensitive duplicate paths in " + destination.name)
    total = 0
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for name, source in sorted(files.items()):
            if isinstance(source, bytes):
                total += len(source)
                bundle.writestr(name, source)
            else:
                total += source.stat().st_size
                bundle.write(source, name)
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    return {"bytes": destination.stat().st_size, "unpacked_bytes": total, "files": len(files), "sha256": digest}


def source_files(directory: Path, prefix: str) -> dict[str, Path]:
    return {prefix + file.relative_to(directory).as_posix(): file for file in directory.rglob("*")
            if file.is_file() and "__pycache__" not in file.parts and file.suffix not in {".pyc", ".pyo"}}


def requirement_blocks(text: str) -> dict[str, tuple[str, str, str | None]]:
    """name -> (block text, version, marker) for each `name==version \\ --hash ...` block of uv export."""
    blocks = {}
    for block in re.split(r"\n(?=\S)", text.strip()):
        match = re.match(r"([A-Za-z0-9._-]+)==([^\s;\\]+)\s*(?:;\s*([^\\\n]+?))?\s*\\?\n", block + "\n")
        if match:
            blocks[match[1].lower()] = (block, match[2], match[3])
    return blocks


def index_wheel(name: str, version: str, python_tag: str) -> dict:
    """The +cu126 wheel of a PyTorch package from download.pytorch.org."""
    filename = f"{name}-{version}+cu126-{python_tag}-{python_tag}-win_amd64.whl"
    with urllib.request.urlopen(urllib.request.Request(f"{CUDA_INDEX}/{name}/", headers=AGENT), timeout=60) as response:
        index = response.read().decode("utf-8")
    match = re.search(r'href="(https://[^"#]+/' + re.escape(urllib.parse.quote(filename)) + r')#sha256=([a-f0-9]{64})"', index)
    if not match:
        raise RuntimeError(f"{filename} is not on {CUDA_INDEX}")
    with urllib.request.urlopen(urllib.request.Request(match[1], method="HEAD", headers=AGENT), timeout=60) as response:
        size = int(response.headers["Content-Length"])
    return {"name": filename, "url": match[1], "sha256": match[2], "bytes": size}


def platform_wheels(requirements: str, lock: dict, built: Path) -> tuple[str, list[dict], dict[str, Path]]:
    """Pick the best wheel for this platform per locked package (uv.lock has URL, hash and size).

    The launcher downloads these itself (resumable) and uv installs them offline.
    Packages published only as source are built here once into pure-Python
    wheels that ship inside the app package; their requirement hash is replaced.
    Returns (requirements, downloads, built wheels).
    """
    supported = {str(tag): rank for rank, tag in enumerate(sys_tags())}
    packages = {(entry["name"], entry["version"]): entry for entry in lock["package"] if "version" in entry}
    downloads, shipped = [], {}
    for name, (block, version, marker) in requirement_blocks(requirements).items():
        if marker and not Marker(marker).evaluate():
            continue
        entry = packages[(name, version)]
        best = None
        for wheel in entry.get("wheels", []):
            filename = urllib.parse.unquote(wheel["url"].rsplit("/", 1)[-1])
            rank = min((supported[str(tag)] for tag in parse_wheel_filename(filename)[3] if str(tag) in supported), default=None)
            if rank is not None and (best is None or rank < best[0]):
                best = (rank, filename, wheel)
        if best:
            _, filename, wheel = best
            downloads.append({"name": filename, "url": wheel["url"], "sha256": wheel["hash"].removeprefix("sha256:"), "bytes": wheel["size"]})
            continue
        sdist = entry["sdist"]
        archive = built / "sdist" / urllib.parse.unquote(sdist["url"].rsplit("/", 1)[-1])
        archive.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(urllib.request.Request(sdist["url"], headers=AGENT), timeout=120) as response:
            archive.write_bytes(response.read())
        if "sha256:" + hashlib.sha256(archive.read_bytes()).hexdigest() != sdist["hash"]:
            raise RuntimeError(f"{archive.name} does not match uv.lock")
        before = set(built.glob("*.whl"))
        subprocess.run(["uv", "build", "--wheel", "--no-config", "--python", sys.executable, "--out-dir", str(built), str(archive)],
                       check=True, capture_output=True)
        (wheel_path,) = set(built.glob("*.whl")) - before
        if not any(str(tag) in supported for tag in parse_wheel_filename(wheel_path.name)[3]):
            raise RuntimeError(f"{wheel_path.name} is not installable here")
        digest = hashlib.sha256(wheel_path.read_bytes()).hexdigest()
        requirements = requirements.replace(block, f"{name}=={version}" + (f" ; {marker}" if marker else "") + f" \
    --hash=sha256:{digest}")
        shipped["wheels/" + wheel_path.name] = wheel_path
    return requirements, downloads, shipped


def cuda_variant(requirements: str, downloads: list[dict], python_tag: str) -> tuple[str, list[dict]]:
    """Swap the PyTorch family for the +cu126 wheels."""
    blocks = requirement_blocks(requirements)
    for name in CUDA_PACKAGES:
        block, version, _ = blocks[name]
        wheel = index_wheel(name, version, python_tag)
        requirements = requirements.replace(block, f"{name}=={version}+cu126 \
    --hash=sha256:{wheel['sha256']}")
        downloads = [item for item in downloads if not item["name"].startswith(name + "-")] + [wheel]
    return requirements, downloads


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version")
    parser.add_argument("--base-url")
    parser.add_argument("--signing-key", type=Path, required=True)
    parser.add_argument("--generate-key", action="store_true", help="Create a private release key and exit. Keep it outside version control.")
    parser.add_argument("--output", type=Path, default=ROOT / "dist/bootstrap-release")
    parser.add_argument("--ffmpeg", type=Path, default=ROOT / "vendor/ffmpeg", help="LGPL FFmpeg staged by tools/fetch-ffmpeg.py")
    parser.add_argument("--cuda-venv", type=Path, default=ROOT / ".venv", help="Environment with the +cu126 torch, used to read its GPU architectures")
    parser.add_argument("--no-cuda", action="store_true")
    parser.add_argument("--manifest-url", help="Where the setup looks for releases (default: the GitHub 'latest' release)")
    parser.add_argument("--allow-local", action="store_true", help="Development-only localhost HTTP release")
    args = parser.parse_args()
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    if args.generate_key:
        args.signing_key.parent.mkdir(parents=True, exist_ok=True)
        key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        encoded = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        # Never overwrite an existing identity by accident.
        with args.signing_key.open("xb") as destination:
            destination.write(encoded)
        print("Created private signing key:", args.signing_key)
        return
    if not args.version or not args.base_url:
        parser.error("--version and --base-url are required for packaging")
    if not ID.fullmatch(args.version):
        parser.error("Invalid application version")
    checked_url(args.base_url, allow_local=args.allow_local)
    key = serialization.load_pem_private_key(args.signing_key.read_bytes(), password=None)
    if not isinstance(key, rsa.RSAPrivateKey) or key.key_size < 3072 or key.public_key().public_numbers().e != 65537:
        parser.error("A 3072-bit or larger RSA signing key with exponent 65537 is required")
    source = (ROOT / "src/rs_studio/__init__.py").read_text(encoding="utf-8")
    versions = [node.value.value for node in ast.parse(source).body if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == "__version__" for target in node.targets)]
    if versions != [args.version]:
        parser.error("--version must match src/rs_studio/__init__.py")
    if not (args.ffmpeg / "ffmpeg.exe").is_file() or not (args.ffmpeg / "build-record.json").is_file():
        parser.error("Stage FFmpeg first: python tools/fetch-ffmpeg.py")

    python = platform.python_version()
    python_tag = f"cp{sys.version_info.major}{sys.version_info.minor}"
    lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
    core = subprocess.run(["uv", "export", "--frozen", "--no-dev", "--no-emit-project", "--no-header", "--format", "requirements.txt"],
                          cwd=ROOT, capture_output=True, text=True, check=True).stdout
    built = Path(tempfile.mkdtemp(prefix="rs-wheels-"))
    core, core_wheels, shipped = platform_wheels(core, lock, built)
    requirements = {"requirements/core.txt": core}
    runtimes = {"core": {"requirements": "requirements/core.txt", "wheels": core_wheels}}
    if not args.no_cuda:
        cuda, cuda_wheels = cuda_variant(core, core_wheels, python_tag)
        venv_python = args.cuda_venv / "Scripts/python.exe"
        # The launcher's CUDA check compares the GPU against the architectures compiled into this torch.
        probe = subprocess.run([str(venv_python), "-c", "import torch; print(torch.__version__); print(torch._C._cuda_getArchFlags())"],
                               capture_output=True, text=True, check=True).stdout.split()
        if probe[0] != requirement_blocks(core)["torch"][1] + "+cu126":
            parser.error(f"--cuda-venv has torch {probe[0]}, expected the locked version +cu126")
        archs = sorted(int(flag.removeprefix("sm_")) for flag in probe[1:] if flag.startswith("sm_"))
        requirements["requirements/cuda.txt"] = cuda
        runtimes["cuda"] = {"requirements": "requirements/cuda.txt", "wheels": cuda_wheels, "cuda_archs": archs}
    for runtime in runtimes.values():
        runtime["download_bytes"] = sum(wheel["bytes"] for wheel in runtime["wheels"])

    app_files: dict[str, Path | bytes] = {name: text.encode("utf-8") for name, text in requirements.items()}
    app_files.update(shipped)
    for directory in ("src/rs_studio", "web", "assets", "licenses", "bootstrap", "docs"):
        app_files.update(source_files(ROOT / directory, directory + "/"))
    for file in ("LICENSE", "NOTICE", "README.md", "pyproject.toml", "uv.lock", "standalone.py", "tools/fetch-ffmpeg.py",
                 "tools/fetch-fonts.py", "tools/package-bootstrap.py", "tools/try-bootstrap.py", "rs-bootstrap.spec"):
        app_files[file] = ROOT / file
    ffmpeg_files = {name: path for name, path in source_files(args.ffmpeg, "").items() if name != "ffplay.exe"}

    args.output.mkdir(parents=True, exist_ok=True)
    base_url = args.base_url.rstrip("/") + "/"
    app_name = f"RS-Studio-app-{args.version}.zip"
    app = write_zip(args.output / app_name, app_files)
    app.update(id=args.version, url=base_url + app_name)
    ffmpeg_name = f"RS-Studio-ffmpeg-{platform_id()}.zip"
    ffmpeg = write_zip(args.output / ffmpeg_name, ffmpeg_files)
    ffmpeg.update(id="ffmpeg", url=base_url + ffmpeg_name)
    payload = {"schema": 2, "launcher_min": 2, "version": args.version, "platform": platform_id(), "python": python,
               "app": app, "ffmpeg": ffmpeg, "runtimes": runtimes}
    signature = key.sign(canonical(payload), padding.PKCS1v15(), hashes.SHA256())
    envelope = {"payload": payload, "signature": base64.b64encode(signature).decode("ascii")}
    # The setup asks the newest release for its manifest, so one setup EXE keeps working for later
    # versions. GitHub's "latest" skips releases marked as pre-release.
    manifest_url = args.manifest_url or re.sub(r"/releases/download/[^/]+/$", "/releases/latest/download/", base_url) + "bootstrap-manifest.json"
    checked_url(manifest_url, allow_local=args.allow_local)
    config = {"launcher_version": LAUNCHER_VERSION, "manifest_url": manifest_url, "public_key": public_key(key)}
    (args.output / "bootstrap-manifest.json").write_text(json.dumps(envelope, indent=2), encoding="utf-8")
    (args.output / "bootstrap-release.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
    print(json.dumps({**{k: v for k, v in payload.items() if k != "runtimes"}, "download_mib": {k: round(v["download_bytes"] / 2**20) for k, v in runtimes.items()}, "built_wheels": sorted(shipped), "config": str(args.output / "bootstrap-release.json")}, indent=2))


if __name__ == "__main__":
    main()
