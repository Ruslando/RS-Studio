"""Standard-library-only installation engine for the small desktop launcher.

GitHub only hosts the signed manifest, the small app package and FFmpeg. The
Python libraries come from their original sources (PyPI, download.pytorch.org):
the bundled uv installs the exact, hash-pinned requirements shipped inside the
signed app package into a private virtual environment.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from collections import deque
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

SCHEMA = 2
LAUNCHER_VERSION = 2  # must match "launcher_version" in bootstrap-release.json
MAX_MANIFEST = 1024 * 1024
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
PYTHON = re.compile(r"^3\.\d{1,2}\.\d{1,3}$")
DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")
PACKAGES = ("app", "ffmpeg")
LABELS = {"app": "RS Studio application", "ffmpeg": "FFmpeg audio tools"}
RUNTIMES = ("core", "cuda")  # core is required; cuda swaps in GPU-enabled PyTorch
PYPI = "https://pypi.org/simple"
# ponytail: CUDA 12.x minimum Windows driver; move into the manifest if the CUDA major changes.
CUDA_DRIVER_MIN = (528, 33)
RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


class InstallError(Exception):
    pass


class Cancelled(InstallError):
    pass


def canonical(value: dict) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def verify_signature(payload: dict, signature: str, key: dict) -> None:
    """Verify RSA PKCS#1 v1.5 / SHA-256 without bundling a crypto dependency.

    Release generation signs with cryptography; only a public key ships here.
    The entire encoded block is compared, including padding and DigestInfo.
    """
    try:
        if len(key["n"]) > 2048:
            raise ValueError("Release public key is too large")
        n, e = int(key["n"], 16), int(key["e"])
        if n.bit_length() < 3072 or e != 65537:
            raise ValueError("Invalid release public key")
        width = (n.bit_length() + 7) // 8
        signed = base64.b64decode(signature, validate=True)
        if len(signed) != width or int.from_bytes(signed, "big") >= n:
            raise ValueError("Invalid signature size")
        actual = pow(int.from_bytes(signed, "big"), e, n).to_bytes(width, "big")
        digest = DIGEST_INFO + hashlib.sha256(canonical(payload)).digest()
        expected = b"\x00\x01" + b"\xff" * (width - len(digest) - 3) + b"\x00" + digest
        if actual != expected:
            raise ValueError("Signature mismatch")
    except (KeyError, ValueError, TypeError, OverflowError) as exc:
        raise InstallError("The release signature could not be verified.") from exc


def platform_id() -> str:
    machine = platform.machine().lower()
    architecture = "x64" if machine in {"amd64", "x86_64"} else machine
    return f"{platform.system().lower()}-{architecture}"


def checked_url(url: str, *, allow_local: bool = False) -> str:
    parsed = urllib.parse.urlsplit(url)
    local = allow_local and parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    if (parsed.scheme != "https" and not local) or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise InstallError("Release downloads require an HTTPS URL.")
    return url


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, allow_local: bool):
        self.allow_local = allow_local

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        checked_url(newurl, allow_local=self.allow_local)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def opener(allow_local: bool = False):
    return urllib.request.build_opener(SafeRedirect(allow_local))


def validate_manifest(envelope: dict, config: dict, *, allow_local: bool = False) -> dict:
    try:
        payload = envelope["payload"]
        verify_signature(payload, envelope["signature"], config["public_key"])
        if payload["schema"] != SCHEMA or payload["platform"] != platform_id():
            raise InstallError("This release is not compatible with this computer.")
        if payload["launcher_min"] > config["launcher_version"]:
            raise InstallError("This release requires a newer RS Studio installer.")
        if not PYTHON.fullmatch(payload["python"]):
            raise InstallError("Invalid Python version in release.")
        for kind in PACKAGES:
            package = payload[kind]
            if not ID.fullmatch(package["id"]) or not SHA256.fullmatch(package["sha256"]):
                raise InstallError("Invalid release package identity.")
            for field in ("bytes", "unpacked_bytes", "files"):
                if type(package[field]) is not int or package[field] <= 0:
                    raise InstallError("Invalid release package size.")
            if package["bytes"] > 2 * 1024**3 or package["files"] > 200000 or package["unpacked_bytes"] > 4 * 1024**3:
                raise InstallError("Release package exceeds installation limits.")
            checked_url(package["url"], allow_local=allow_local)
        if "core" not in payload["runtimes"] or set(payload["runtimes"]) - set(RUNTIMES):
            raise InstallError("Invalid runtime list in release.")
        for runtime in payload["runtimes"].values():
            archive_path(runtime["requirements"])
            if not 0 < len(runtime["wheels"]) <= 2000:
                raise InstallError("Invalid runtime wheel list.")
            for wheel in runtime["wheels"]:
                if len(archive_path(wheel["name"]).parts) != 1 or not wheel["name"].endswith(".whl") or not SHA256.fullmatch(wheel["sha256"]):
                    raise InstallError("Invalid runtime wheel.")
                if type(wheel["bytes"]) is not int or not 0 < wheel["bytes"] <= 4 * 1024**3:
                    raise InstallError("Invalid runtime wheel size.")
                checked_url(wheel["url"], allow_local=allow_local)
            if runtime["download_bytes"] != sum(wheel["bytes"] for wheel in runtime["wheels"]):
                raise InstallError("Invalid runtime size.")
        if "cuda" in payload["runtimes"] and not all(type(arch) is int for arch in payload["runtimes"]["cuda"]["cuda_archs"]):
            raise InstallError("Invalid CUDA runtime description.")
        return payload
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        raise InstallError("The release manifest is invalid.") from exc


def cuda_check(runtime: dict | None, query=None) -> dict:
    """Ask the NVIDIA driver whether the CUDA runtime would speed things up.

    Advisory only: anyone may still install CUDA. Uses nvidia-smi, which ships
    with every NVIDIA driver, so the launcher needs no GPU library.
    """
    if runtime is None:
        return {"useful": False, "reason": "This release has no CUDA runtime."}
    if query is None:
        def query():
            tool = shutil.which("nvidia-smi") or str(Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32/nvidia-smi.exe")
            return subprocess.run([tool, "--query-gpu=name,driver_version,memory.total,compute_cap", "--format=csv,noheader,nounits"],
                                  capture_output=True, text=True, timeout=15, check=True, creationflags=NO_WINDOW).stdout
    try:
        output = query()
    except (OSError, subprocess.SubprocessError):
        return {"useful": False, "reason": "No NVIDIA graphics card found."}
    archs = runtime["cuda_archs"]
    def runs(arch):
        # A kernel built for sm_XY runs on any GPU with the same major and minor >= Y (sm_86 on sm_89).
        return any(built // 10 == arch // 10 and built <= arch for built in archs)
    best = None
    for line in output.strip().splitlines():
        try:
            name, driver, memory, capability = (field.strip() for field in line.split(","))
            gpu = {"name": name, "driver": tuple(int(x) for x in driver.split(".")[:2]), "memory": int(float(memory)),
                   "arch": int(round(float(capability) * 10))}
        except ValueError:
            continue
        if best is None or (runs(gpu["arch"]), gpu["memory"]) > (runs(best["arch"]), best["memory"]):
            best = gpu
    if best is None:
        return {"useful": False, "reason": "No NVIDIA graphics card found."}
    name = best["name"]
    if not runs(best["arch"]):
        problem = "not supported by this CUDA build" if best["arch"] > max(archs) else "too old for CUDA"
        return {"useful": False, "gpu": name, "reason": f"{name} is {problem}."}
    if best["driver"] < CUDA_DRIVER_MIN:
        return {"useful": False, "gpu": name, "reason": f"{name}: NVIDIA driver too old."}
    if best["memory"] < 4096:
        return {"useful": True, "gpu": name, "reason": f"{name} · {best['memory'] / 1024:.1f} GB (low VRAM)"}
    return {"useful": True, "gpu": name, "reason": f"{name} · {best['memory'] / 1024:.0f} GB"}


def fetch_manifest(config: dict, *, allow_local: bool = False) -> dict:
    url = checked_url(config["manifest_url"], allow_local=allow_local)
    request = urllib.request.Request(url, headers={"User-Agent": "RS-Studio-Installer/2", "Accept": "application/json"})
    with opener(allow_local).open(request, timeout=30) as response:
        data = response.read(MAX_MANIFEST + 1)
    if len(data) > MAX_MANIFEST:
        raise InstallError("The release manifest is too large.")
    try:
        envelope = json.loads(data)
    except (ValueError, UnicodeError) as exc:
        raise InstallError("The release manifest is not valid JSON.") from exc
    validate_manifest(envelope, config, allow_local=allow_local)
    return envelope


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def check_cancel(cancel: threading.Event) -> None:
    if cancel.is_set():
        raise Cancelled("Installation cancelled.")


def file_hash(path: Path, cancel: threading.Event) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            check_cancel(cancel)
            digest.update(chunk)
    return digest.hexdigest()


def download(item: dict, target: Path, cancel: threading.Event, report, *, allow_local: bool = False) -> None:
    """Fetch item (url, bytes, sha256) to target. Resumes a .part file; reuses a verified target.

    report(transferred) is called with the bytes received over the network so far.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    if target.exists():
        if target.stat().st_size == item["bytes"] and file_hash(target, cancel) == item["sha256"]:
            return
        target.unlink()
    offset = partial.stat().st_size if partial.exists() else 0
    if offset > item["bytes"]:
        partial.unlink()
        offset = 0
    if offset < item["bytes"]:
        headers = {"User-Agent": "RS-Studio-Installer/2", "Accept-Encoding": "identity"}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        request = urllib.request.Request(checked_url(item["url"], allow_local=allow_local), headers=headers)
        with opener(allow_local).open(request, timeout=30) as response:
            if response.status == 206:
                match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
                if not match or int(match[1]) != offset or int(match[3]) != item["bytes"] or int(match[2]) != item["bytes"] - 1:
                    raise InstallError("The download server returned an invalid resume response.")
            elif response.status == 200:
                offset = 0
            else:
                raise InstallError("The download server returned an unexpected response.")
            received = 0
            with partial.open("ab" if offset else "wb") as stream:
                while chunk := response.read(256 * 1024):
                    check_cancel(cancel)
                    offset += len(chunk)
                    received += len(chunk)
                    if offset > item["bytes"]:
                        raise InstallError("Download exceeds its declared size.")
                    stream.write(chunk)
                    report(received)
                stream.flush()
                os.fsync(stream.fileno())
    if offset != item["bytes"]:
        raise InstallError("The download is incomplete. Please retry to resume it.")
    if file_hash(partial, cancel) != item["sha256"]:
        partial.unlink(missing_ok=True)
        raise InstallError(f"{target.name} is damaged (checksum mismatch). Please retry.")
    os.replace(partial, target)


def resume_size(item: dict, target: Path) -> int:
    """Bytes already on disk for this item: a finished file or a resumable .part."""
    if target.exists():
        return item["bytes"] if target.stat().st_size == item["bytes"] else 0
    partial = target.with_name(target.name + ".part")
    return min(partial.stat().st_size, item["bytes"]) if partial.exists() else 0


def download_all(items: list[tuple[dict, Path]], cancel: threading.Event, progress, *, allow_local: bool = False) -> None:
    """Download everything under one overall progress with file name and speed (5 s window).

    Files already on disk count as done (after their checksum is verified) and
    partial files continue where they stopped.
    """
    total = sum(item["bytes"] for item, _ in items)
    done = sum(resume_size(item, target) for item, target in items)
    window = deque([(time.monotonic(), 0)])  # (time, bytes received in this session)
    for item, target in items:
        name = item.get("name") or target.name
        start = resume_size(item, target)
        base, session = done - start, window[-1][1]
        stage = "Checking downloaded files" if start == item["bytes"] else "Downloading"
        progress(stage, done, total, file=name, speed=0)
        def report(received):
            now = time.monotonic()
            window.append((now, session + received))
            while len(window) > 2 and now - window[0][0] > 5:
                window.popleft()
            elapsed = window[-1][0] - window[0][0]
            speed = (window[-1][1] - window[0][1]) / elapsed if elapsed > 0.5 else 0
            progress("Downloading", min(base + start + received, total), total, file=name, speed=speed)
        download(item, target, cancel, report, allow_local=allow_local)
        done = base + item["bytes"]


def archive_path(name: str) -> PurePosixPath:
    if not isinstance(name, str) or "\\" in name or "\x00" in name:
        raise InstallError("Unsafe file name in installation package.")
    parts = name.rstrip("/").split("/")
    if not parts or any(not part or part in {".", ".."} or ":" in part or part.endswith((".", " ")) or any(ord(c) < 32 or c in '<>\"|?*' for c in part) or part.split(".")[0].upper() in RESERVED for part in parts):
        raise InstallError("Unsafe file path in installation package.")
    return PurePosixPath(*parts)


def extract(archive: Path, destination: Path, package: dict, cancel: threading.Event, progress) -> dict:
    inventory = {}
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if len(entries) > package["files"] + 10000:
            raise InstallError("Installation archive contains too many entries.")
        seen = set()
        total = sum(info.file_size for info in entries)
        if total != package["unpacked_bytes"]:
            raise InstallError("Installation archive has an unexpected unpacked size.")
        done = 0
        for info in entries:
            check_cancel(cancel)
            relative = archive_path(info.filename)
            key = relative.as_posix().casefold()
            if key in seen or key == "installed.json":
                raise InstallError("Duplicate or reserved path in installation package.")
            seen.add(key)
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode))):
                raise InstallError("Installation packages may not contain links or special files.")
            target = destination.joinpath(*relative.parts)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            written = 0
            with bundle.open(info) as source, target.open("xb") as output:
                while chunk := source.read(1024 * 1024):
                    check_cancel(cancel)
                    written += len(chunk)
                    done += len(chunk)
                    if written > info.file_size or done > package["unpacked_bytes"]:
                        raise InstallError("Installation archive expands beyond its declared size.")
                    output.write(chunk)
                    progress("Installing", done, total)
            if written != info.file_size:
                raise InstallError("An installed file is incomplete.")
            if os.name != "nt" and mode & 0o111:
                target.chmod(0o755)
            inventory[relative.as_posix()] = written
        if len(inventory) != package["files"]:
            raise InstallError("Installation archive has an unexpected file count.")
    return inventory


@contextmanager
def installation_lock(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    lock_path = root / "installer.lock"
    with lock_path.open("a+b") as stream:
        try:
            # Reading a byte already locked by another process is denied on
            # Windows; inspect its length without reading the locked region.
            if lock_path.stat().st_size == 0:
                stream.write(b"0")
                stream.flush()
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise InstallError("Another RS Studio installer is already running.") from exc
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def package_ready(directory: Path, package: dict) -> bool:
    try:
        receipt = json.loads((directory / "installed.json").read_text(encoding="utf-8"))
        inventory = receipt["inventory"]
        if receipt["sha256"] != package["sha256"] or not isinstance(inventory, dict) or len(inventory) != package["files"]:
            return False
        if any(type(size) is not int or size < 0 for size in inventory.values()) or sum(inventory.values()) != package["unpacked_bytes"]:
            return False
        for relative, size in inventory.items():
            item = directory.joinpath(*archive_path(relative).parts)
            if not item.is_file() or item.stat().st_size != size:
                return False
        return True
    except (OSError, ValueError, KeyError, TypeError, InstallError):
        return False


def package_directory(root: Path, kind: str, package: dict) -> Path:
    # Include the content hash: publishing a changed package with the same id
    # cannot mutate a version that a currently running application uses.
    return root / "versions" / kind / (package["id"] + "-" + package["sha256"][:16])


def unpack_package(root: Path, kind: str, package: dict, archive: Path, cancel: threading.Event, progress) -> Path:
    directory = package_directory(root, kind, package)
    if package_ready(directory, package):
        return directory
    check_cancel(cancel)
    if shutil.disk_usage(root).free < package["unpacked_bytes"] + 64 * 1024**2:
        raise InstallError("Not enough free disk space to install " + kind + ".")
    directory.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".install-", dir=directory.parent) as temporary:
        staging = Path(temporary) / "package"
        staging.mkdir()
        inventory = extract(archive, staging, package, cancel, lambda stage, done, total: progress("Unpacking", done, total, file=LABELS[kind]))
        atomic_json(staging / "installed.json", {"sha256": package["sha256"], "inventory": inventory})
        check_cancel(cancel)
        # A damaged old copy is preserved rather than deleting files
        # that another process might still have open.
        if directory.exists():
            os.replace(directory, directory.with_name(directory.name + ".damaged-" + uuid.uuid4().hex))
        os.replace(staging, directory)
    return directory


def uv_executable() -> Path:
    bundled = Path(getattr(sys, "_MEIPASS", Path(__file__).parent)) / ("uv.exe" if os.name == "nt" else "uv")
    found = bundled if bundled.is_file() else shutil.which("uv")
    if not found:
        raise InstallError("The installer is incomplete: uv is missing.")
    return Path(found)


def environment_directory(root: Path, runtime: str, payload: dict) -> Path:
    # One environment per runtime, updated in place: a new release only adds
    # or replaces the libraries that changed.
    return root / "envs" / runtime


def wheels_digest(payload: dict, runtime: str) -> str:
    return hashlib.sha256(canonical({"python": payload["python"], "wheels": payload["runtimes"][runtime]["wheels"]})).hexdigest()


def environment_python(environment: Path, *, windowed: bool = False) -> Path:
    if os.name == "nt":
        return environment / "Scripts" / ("pythonw.exe" if windowed else "python.exe")
    return environment / "bin" / "python"


def environment_ready(environment: Path, payload: dict, runtime: str) -> bool:
    """The environment was completely installed and verified for exactly these wheels."""
    # ponytail: receipt + interpreter only; a deleted library file shows up in
    # the startup check, which then rebuilds the environment.
    try:
        receipt = json.loads((environment / "rs-studio-environment.json").read_text(encoding="utf-8"))
        return receipt.get("wheels") == wheels_digest(payload, runtime) and environment_python(environment).is_file()
    except (OSError, ValueError):
        return False


def environment_python_version(environment: Path) -> str | None:
    try:
        config = (environment / "pyvenv.cfg").read_text(encoding="utf-8")
    except OSError:
        return None
    match = re.search(r"^version_info\s*=\s*(\S+)", config, re.MULTILINE)
    return match[1] if match and environment_python(environment).is_file() else None


def distribution_key(filename: str) -> tuple[str, str]:
    """(normalized name, version) from a wheel file or .dist-info directory name."""
    name, version = filename.removesuffix(".dist-info").split("-")[:2]
    return re.sub(r"[-_.]+", "-", name).lower(), version


def installed_distributions(environment: Path) -> set[tuple[str, str]]:
    site = environment / "Lib/site-packages" if os.name == "nt" else next(environment.glob("lib/python*/site-packages"), environment)
    return {distribution_key(path.name) for path in site.glob("*.dist-info")}


def missing_wheels(environment: Path, payload: dict, runtime: str) -> list[dict]:
    """Compare the installed libraries with the release: only absent or changed ones are needed."""
    wheels = payload["runtimes"][runtime]["wheels"]
    if environment_python_version(environment) != payload["python"]:
        return wheels  # new or different Python: the environment is rebuilt
    installed = installed_distributions(environment)
    return [wheel for wheel in wheels if distribution_key(wheel["name"]) not in installed]


def run_uv(arguments: list, root: Path, cancel: threading.Event, on_line=None) -> None:
    env = {**os.environ, "UV_CACHE_DIR": str(root / "cache"), "UV_PYTHON_INSTALL_DIR": str(root / "python"),
           "UV_NO_CONFIG": "1", "NO_COLOR": "1"}
    process = subprocess.Popen([str(uv_executable()), *arguments], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               stdin=subprocess.DEVNULL, env=env, text=True, encoding="utf-8", errors="replace",
                               creationflags=NO_WINDOW)
    lines = []
    def watch():
        while process.poll() is None:
            if cancel.wait(0.5):
                process.kill()
    threading.Thread(target=watch, daemon=True).start()
    with process.stdout:
        for line in process.stdout:
            lines.append(line.rstrip())
            if on_line:
                on_line(line.strip())
    process.wait()
    check_cancel(cancel)
    if process.returncode:
        detail = next((line for line in reversed(lines) if line.strip()), "unknown error")
        raise InstallError("Installing libraries failed: " + detail[-300:])


def install_environment(root: Path, runtime: str, environment: Path, app: Path, wheels: Path, payload: dict,
                        cancel: threading.Event, progress) -> None:
    """Create the private environment from the already downloaded, verified wheels."""
    progress("Preparing Python", 0, 0, file=f"Python {payload['python']}")
    def python_line(line):
        if line.startswith(("Downloading", "Downloaded", "Using")):
            progress("Preparing Python", 0, 0, file=line)
    if environment_python_version(environment) != payload["python"]:
        run_uv(["venv", str(environment), "--python", payload["python"], "--managed-python", "--clear", "--no-project"],
               root, cancel, python_line)
    # uv shows no live progress here; count what it has unpacked into its cache
    # and what it has linked into the environment instead.
    required = {distribution_key(wheel["name"]) for wheel in payload["runtimes"][runtime]["wheels"]}
    required |= {distribution_key(path.name) for path in (app / "wheels").glob("*.whl")}
    total = len(required)
    unpacked_before = len(list((root / "cache").glob("archive-v*/*")))
    already = len(required & installed_distributions(environment))
    stop = threading.Event()
    def watch():
        while not stop.wait(0.4):
            installed = len(required & installed_distributions(environment))
            prepared = max(installed, min(total, already + len(list((root / "cache").glob("archive-v*/*"))) - unpacked_before))
            progress("Installing libraries", prepared + installed, 2 * total,
                     file=f"{prepared} of {total} unpacked · {installed} of {total} installed")
    progress("Installing libraries", 0, 2 * total, file=f"0 of {total} unpacked · 0 of {total} installed")
    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    try:
        requirements = app.joinpath(*archive_path(payload["runtimes"][runtime]["requirements"]).parts)
        run_uv(["pip", "sync", str(requirements), "--python", str(environment_python(environment)), "--require-hashes",
                "--offline", "--no-index", "--find-links", str(wheels), "--find-links", str(app / "wheels")], root, cancel)
    finally:
        stop.set()
        watcher.join()
    progress("Installing libraries", 2 * total, 2 * total, file=f"{total} of {total} installed")


def application_environment(root: Path, app: Path, ffmpeg: Path) -> dict:
    env = os.environ.copy()
    env["RS_STUDIO_APP_ROOT"] = str(app)
    env["RS_STUDIO_DATA_ROOT"] = str(root / "data")
    env["RS_STUDIO_FFMPEG"] = str(ffmpeg)
    # The launcher itself is a PyInstaller program; do not leak its state.
    env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
    for name in ("PYTHONHOME", "PYTHONPATH", "TCL_LIBRARY", "TK_LIBRARY"):
        env.pop(name, None)
    (root / "data").mkdir(parents=True, exist_ok=True)
    return env


def health_check(root: Path, environment: Path, app: Path, ffmpeg: Path, cancel: threading.Event, progress=lambda *a, **k: None) -> None:
    python = environment_python(environment)
    if not python.is_file() or not (app / "src/rs_studio/__init__.py").is_file() or not (app / "web/index.html").is_file():
        raise InstallError("Required application files are missing.")
    fd, result_name = tempfile.mkstemp(suffix=".json", prefix="health-", dir=root)
    os.close(fd)
    result = Path(result_name)
    try:
        process = subprocess.Popen([str(python), str(app / "standalone.py"), "--bootstrap-check", str(result)], cwd=app,
                                   env=application_environment(root, app, ffmpeg), creationflags=NO_WINDOW,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                                   text=True, encoding="utf-8", errors="replace")
        def follow():
            # The check prints "check 3/20 torch" before each step.
            with process.stdout:
                for line in process.stdout:
                    if match := re.fullmatch(r"check (\d+)/(\d+) (.+)", line.strip()):
                        progress("Checking installation", int(match[1]) - 1, int(match[2]), file=match[3])
        reader = threading.Thread(target=follow, daemon=True)
        reader.start()
        deadline = time.monotonic() + 300
        while process.poll() is None:
            if cancel.wait(0.1) or time.monotonic() > deadline:
                process.kill()
                process.wait()
                check_cancel(cancel)
                raise InstallError("The installed libraries did not respond to their startup check.")
        reader.join(5)
        try:
            report = json.loads(result.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise InstallError("The installed libraries could not complete their startup check.") from exc
        if process.returncode != 0 or report.get("ok") is not True:
            raise InstallError("Verification failed: " + str(report.get("error", "Unknown error")))
    finally:
        result.unlink(missing_ok=True)


def active_release(root: Path, payload: dict, runtime: str) -> dict:
    """Everything launch() needs: the payload plus the chosen runtime's directories."""
    if runtime not in payload["runtimes"]:
        raise InstallError("The selected runtime is not part of this release.")
    return {**payload, "runtime": runtime, "app_dir": str(package_directory(root, "app", payload["app"])),
            "ffmpeg_dir": str(package_directory(root, "ffmpeg", payload["ffmpeg"])),
            "environment": str(environment_directory(root, runtime, payload))}


def installed_release(root: Path, config: dict, *, allow_local: bool = False) -> dict | None:
    try:
        envelope = json.loads((root / "current.json").read_text(encoding="utf-8"))
        payload = validate_manifest(envelope, config, allow_local=allow_local)
        for kind in PACKAGES:
            if not package_ready(package_directory(root, kind, payload[kind]), payload[kind]):
                return None
        active = active_release(root, payload, envelope.get("runtime", "core"))
        return active if environment_ready(Path(active["environment"]), payload, active["runtime"]) else None
    except (OSError, ValueError, InstallError, TypeError, KeyError):
        return None


def is_installation(root: Path) -> bool:
    # Every installation folder gets this lock file when its first install starts.
    return (root / "installer.lock").is_file()


def installed_runtime(root: Path) -> str | None:
    try:
        return json.loads((root / "current.json").read_text(encoding="utf-8")).get("runtime", "core")
    except (OSError, ValueError, AttributeError):
        return None


def install(root: Path, envelope: dict, config: dict, cancel: threading.Event, progress, *, runtime: str = "core",
            repair: bool = False, allow_local: bool = False, probe=health_check, prepare=install_environment) -> dict:
    """progress(stage, done, total, **detail): detail has file and speed while downloading.

    repair re-checks the libraries against the release instead of trusting the
    receipt; files are still only downloaded when missing or changed.
    """
    payload = validate_manifest(envelope, config, allow_local=allow_local)
    if runtime not in payload["runtimes"]:
        raise InstallError("The selected runtime is not part of this release.")
    with installation_lock(root):
        downloads = root / "downloads"
        active = active_release(root, payload, runtime)
        environment = Path(active["environment"])
        items = []
        for kind in PACKAGES:
            if not package_ready(Path(active[kind + "_dir"]), payload[kind]):
                items.append((dict(payload[kind], name=Path(payload[kind]["url"]).name), downloads / (payload[kind]["sha256"] + ".zip")))
        ready = not repair and environment_ready(environment, payload, runtime)
        wheels = [] if ready else missing_wheels(environment, payload, runtime)
        items += [(wheel, downloads / "wheels" / wheel["name"]) for wheel in wheels]
        missing = sum(item["bytes"] - resume_size(item, target) for item, target in items)
        if shutil.disk_usage(root).free < missing * 3 + 512 * 1024**2:
            raise InstallError("Not enough free disk space.")
        download_all(items, cancel, progress, allow_local=allow_local)
        for kind in PACKAGES:
            unpack_package(root, kind, payload[kind], downloads / (payload[kind]["sha256"] + ".zip"), cancel, progress)
        if not ready:
            (environment / "rs-studio-environment.json").unlink(missing_ok=True)
            prepare(root, runtime, environment, Path(active["app_dir"]), downloads / "wheels", payload, cancel, progress)
        progress("Checking installation", 0, 0)
        try:
            probe(root, environment, Path(active["app_dir"]), Path(active["ffmpeg_dir"]), cancel, progress)
        except Cancelled:
            raise
        except InstallError:
            # Libraries are present by name but broken: rebuild them on the next attempt.
            (environment / "rs-studio-environment.json").unlink(missing_ok=True)
            shutil.rmtree(environment / ("Lib" if os.name == "nt" else "lib"), ignore_errors=True)
            raise
        check_cancel(cancel)
        atomic_json(environment / "rs-studio-environment.json", {"runtime": runtime, "wheels": wheels_digest(payload, runtime)})
        atomic_json(root / "current.json", {**envelope, "runtime": runtime})
        # Installed and verified; partial installs keep their downloads for resuming.
        shutil.rmtree(downloads, ignore_errors=True)
        return active


def launch(root: Path, active: dict) -> subprocess.Popen:
    app = Path(active["app_dir"])
    return subprocess.Popen([str(environment_python(Path(active["environment"]), windowed=True)), str(app / "standalone.py")],
                            cwd=app, env=application_environment(root, app, Path(active["ffmpeg_dir"])), creationflags=NO_WINDOW)
