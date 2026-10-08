"""What weights this app runs on, where they are, and how to fetch them.

Two kinds of model sit behind the analyze form and the Detect button, and from
the outside they are indistinguishable: some ship inside a pip package and need
nothing, and the rest are tens or hundreds of megabytes that used to arrive the
first time you pressed a button, which reads as a hang. This module states which
is which and fetches the second kind up front, so the wait happens where the
user asked for it.

Sizes below are the servers' own Content-Length, recorded so a row can say what
a download costs before it starts, and summed across files for a model that
needs more than one. Once the files are here the row reports what they actually
weigh instead.

Transfers resume through temporary `.part` files and HTTP Range requests.
Partial downloads survive pauses and network errors. Files with a configured
checksum are verified before installation; corrupt partial files are discarded.
"""
from __future__ import annotations

import hashlib
import os
import threading
from pathlib import Path
from urllib.request import Request, urlopen

from . import roformer
from .pipeline import PIANO_CKPT_URL, mt3_checkpoint_path, piano_checkpoint_path

MODELS_DIR = roformer.MODELS_DIR

# htdemucs_6s is a bag of one; demucs/remote/files.txt maps that signature to
# this file, and the name is the hash of its contents, so it never moves.
DEMUCS_FILE = "5c90dfd2-34c22ccb.th"
DEMUCS_URL = f"https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/{DEMUCS_FILE}"

# BS-RoFormer is the one model here with no upstream. lucidrains' repo is the
# architecture only — ByteDance published the paper and never the weights — and
# the person who hosted this checkpoint says he did not train it either, only
# renamed its keys so it loads under MSST ("Fixed"). Whoever trained it is
# unknown, and the original host 401s again as of Aug 2026.
#
# So: mirrors, tried in order, and a hash. Every reupload below serves the same
# bytes, and openmirlab/bs-roformer-infer pins this same digest independently,
# which confirms the identity of the mirrored bytes, not their authorship. A third
# reupload, Blakus/bs_roformer_sw_6stem, has the identical ckpt but a different
# yaml — left out rather than mixed.
ROFORMER_CKPT_URLS = [
    "https://huggingface.co/enerjazzer/BS-ROFO-SW-Fixed/resolve/main/BS-Rofo-SW-Fixed.ckpt",
    "https://huggingface.co/cdjmix1991/bandsplit-roformer-sw-by-jarredou/resolve/main/model_BandSplit-Roformer_SW_by-jarredou.ckpt",
]
ROFORMER_YAML_URLS = [
    "https://huggingface.co/enerjazzer/BS-ROFO-SW-Fixed/resolve/main/BS-Rofo-SW-Fixed.yaml",
    "https://huggingface.co/cdjmix1991/bandsplit-roformer-sw-by-jarredou/resolve/main/config_BandSplit-Roformer_SW_by-jarredou.yaml",
]
ROFORMER_CKPT_SHA = "24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e"
ROFORMER_YAML_SHA = "f9fada9f94e5ba2d2e4600196299459294bc5f532b314c209cc156ac63e4329b"

_CHUNK = 1 << 20


def _torch_checkpoints() -> Path:
    """Where torch.hub caches downloads.

    Limitation: this repeats torch.hub.get_dir()'s env lookup rather than
    importing torch, which costs seconds on a settings window that has to open
    now. If torch ever changes the rule, this pane calls a present file missing.
    """
    home = os.environ.get("TORCH_HOME")
    if home:
        return Path(home).expanduser() / "hub" / "checkpoints"
    cache = os.environ.get("XDG_CACHE_HOME") or (Path.home() / ".cache")
    return Path(cache).expanduser() / "torch" / "hub" / "checkpoints"


# Hardware support shown in the model pane. Keep this factual and avoid rating
# model performance; the labels describe what each model is intended to handle.
_RUNS = {
    "demucs": {"needs": "GPU or CPU."},
    "roformer": {"needs": "CUDA GPU or CPU. 174.7M parameters, 44.1 kHz."},
    "piano": {"needs": "CPU. No GPU needed."},
    "mt3": {"needs": "CPU. No GPU needed."},
    "basic_pitch": {"needs": "CPU. No GPU needed."},
    "torchcrepe": {"needs": "GPU or CPU."},
}


def _catalog() -> list[dict]:
    """Every model the app can use. `files` is what has to exist on disk.

    A downloadable entry carries either `url` (one file) or `urls` (a list of
    mirrors per file, positionally matching `files`), and optionally `sha256`
    per file. Sizes are the servers' own Content-Length.
    """
    return [
        {"id": "demucs", "label": "Demucs (6-stem model)", "kind": "Stem separation",
         "url": DEMUCS_URL, "size": 54996327,
         "files": [_torch_checkpoints() / DEMUCS_FILE]},
        # Two files, because loading needs the config as well as the weights,
        # and both are pinned by hash — see the mirror note above.
        {"id": "roformer", "label": "BS-RoFormer (6-stem model)", "kind": "Stem separation",
         "size": 699416765,
         "urls": [ROFORMER_CKPT_URLS, ROFORMER_YAML_URLS],
         "sha256": [ROFORMER_CKPT_SHA, ROFORMER_YAML_SHA],
         "files": [roformer.checkpoint_path(), roformer.config_path()]},
        {"id": "piano", "label": "Piano Transcription (piano model)", "kind": "Note detection",
         "url": PIANO_CKPT_URL, "size": 171966578,
         "files": [piano_checkpoint_path()]},
        # mt3-infer would fetch this itself the first time the detector ran.
        # It is listed here with a URL instead, and pipeline.list_detectors()
        # marks MR-MT3 unavailable until the file exists, just like BS-RoFormer.
        # The URL is the one mt3-infer's own
        # registry names, so a checkpoint already fetched by the old path is
        # found here rather than downloaded twice.
        {"id": "mt3", "label": "MR-MT3 (multi-instrument model)", "kind": "Note detection",
         "url": "https://huggingface.co/gudgud1014/MR-MT3/resolve/main/mt3.pth",
         "size": 183672643, "files": [mt3_checkpoint_path()]},
        {"id": "basic_pitch", "label": "Basic Pitch (polyphonic model)", "kind": "Note detection",
         "bundled": True},
        {"id": "torchcrepe", "label": "torchcrepe (bass / melody model)", "kind": "Note detection",
         "bundled": True},
    ]


# model id -> {state, done, total, error}. Written by the worker thread, read by
# request threads; single-field reads of a dict are atomic under the GIL, and a
# progress number one chunk out of date is not worth a lock.
_jobs: dict[str, dict] = {}
_lock = threading.Lock()


def _entry(model_id: str) -> dict | None:
    return next((m for m in _catalog() if m["id"] == model_id), None)


def _sources(m: dict) -> list[tuple[Path, list[str], str | None]]:
    """(destination, mirrors, expected sha256) per file. Empty if not fetchable.

    Flattens `url` and `urls` into the one shape the worker walks, so a
    single-file model and a two-file one take the same code path.
    """
    urls = m.get("urls") or ([[m["url"]]] if "url" in m else [])
    if not urls:
        return []
    digests = m.get("sha256") or [None] * len(urls)
    return list(zip(m["files"], urls, digests))


def status() -> list[dict]:
    """One row per model for the Models pane.

    `state` is bundled | ready | missing | downloading | error. `size` is what
    the files actually weigh once they are here, and what they will weigh before
    that.
    """
    rows = []
    for m in _catalog():
        runs = _RUNS.get(m["id"], {})
        row = {"id": m["id"], "label": m["label"], "kind": m["kind"],
               "size": m.get("size"), "done": 0,
               "downloadable": bool(_sources(m)), "detail": "",
                "needs": runs.get("needs", ""), "warning": ""}
        if m.get("bundled"):
            row["state"] = "bundled"
        else:
            job = _jobs.get(m["id"]) or {}
            here = [f for f in m["files"] if f.exists()]
            if job.get("state") == "running":
                row["state"] = "downloading"
                row["done"] = job["done"]
                row["size"] = job["total"] or row["size"]
            elif len(here) == len(m["files"]):
                row["state"] = "ready"
                row["size"] = sum(f.stat().st_size for f in here)
            elif job.get("state") in ("paused", "error"):
                # Both keep their .part, so both report how far they got: the
                # row has to say "stopped at 40%", not "nothing here", or
                # pressing Download again looks like starting over.
                row["state"] = job["state"]
                row["detail"] = job["error"]
                row["done"] = _on_disk(_sources(m))
            elif any(f.with_name(f.name + ".part").exists() for f in m["files"]):
                # A .part with no job behind it: the app was closed mid-download.
                # Only a .part counts — a model that simply has one of its two
                # finished files is missing, not half-downloaded.
                row["state"] = "paused"
                row["done"] = _on_disk(_sources(m))
            else:
                row["state"] = "missing"
            row["files"] = [f.name for f in m["files"]]
            row["dir"] = str(m["files"][0].parent)
        rows.append(row)
    return rows


def _on_disk(sources: list[tuple[Path, list[str], str | None]]) -> int:
    """Bytes already fetched, counting finished files and part-files alike."""
    total = 0
    for dest, _, _ in sources:
        part = dest.with_name(dest.name + ".part")
        for f in (dest, part):
            if f.exists():
                total += f.stat().st_size
                break
    return total


def start_download(model_id: str) -> None:
    """Fetch a model in the background, resuming if a .part is already there.

    Raises KeyError if it isn't fetchable.
    """
    m = _entry(model_id)
    sources = _sources(m) if m else []
    if not sources:
        raise KeyError(model_id)
    with _lock:
        if (_jobs.get(model_id) or {}).get("state") == "running":
            return
        _jobs[model_id] = {"state": "running", "done": _on_disk(sources),
                           "total": m.get("size") or 0, "error": "",
                           "stop": threading.Event()}
    threading.Thread(target=_download, args=(model_id, sources), daemon=True).start()


def pause_download(model_id: str) -> None:
    """Ask a running download to stop. It keeps its .part and resumes later."""
    job = _jobs.get(model_id) or {}
    if job.get("state") == "running":
        job["stop"].set()


class Paused(Exception):
    """The user pressed pause. Not an error: the .part stays and resumes."""


def _sha256(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(_CHUNK):
            sha.update(chunk)
    return sha.hexdigest()


def _fetch(url: str, part: Path, job: dict, done_before: int) -> None:
    """Stream one file into `part`, continuing from whatever is already there.

    A 699 MB transfer over a domestic line really does get cut off mid-stream,
    and read() reports that as a clean end of file. Restarting from zero each
    time never converges — three attempts here died at 148, 91 and 288 MB — so
    the .part survives the failure and the next attempt asks for the rest with
    a Range header. Every mirror is HF-backed and answers 206.

    Raises if the transfer ends short, so the caller retries rather than
    treating a half file as done. The hash is checked by the caller once the
    file is whole, because it cannot be computed across resumes.
    """
    start = part.stat().st_size if part.exists() else 0
    headers = {"User-Agent": "rs-studio"}
    if start:
        headers["Range"] = f"bytes={start}-"
    with urlopen(Request(url, headers=headers), timeout=60) as resp:
        # 206 means the server honoured the Range. Anything else means it sent
        # the whole file regardless, so the bytes on disk are not a prefix of
        # what is arriving and appending would splice two copies together.
        resuming = start > 0 and resp.status == 206
        if start and not resuming:
            start = 0
        remaining = int(resp.headers.get("Content-Length") or 0)
        got = 0
        with part.open("ab" if resuming else "wb") as fh:
            while chunk := resp.read(_CHUNK):
                if job["stop"].is_set():
                    fh.flush()
                    raise Paused
                fh.write(chunk)
                got += len(chunk)
                job["done"] = done_before + start + got
    if remaining and got != remaining:
        raise OSError(f"transfer ended at {start + got:,} of {start + remaining:,} bytes")


def _download(model_id: str, sources: list[tuple[Path, list[str], str | None]]) -> None:
    job = _jobs[model_id]
    parts = [d.with_name(d.name + ".part") for d, _, _ in sources]
    try:
        done = 0
        for (dest, mirrors, digest), part in zip(sources, parts):
            dest.parent.mkdir(parents=True, exist_ok=True)
            # Four passes over the mirrors, because each attempt now resumes
            # where the last one stopped instead of starting over: a link that
            # drops every hundred megabytes still converges. These checkpoints
            # are also anonymous reuploads whose original host is gone, so one
            # dead mirror is not a dead model.
            attempts = list(mirrors) * 4
            for i, url in enumerate(attempts):
                try:
                    _fetch(url, part, job, done)
                    # Verified whole rather than per chunk, because a resumed
                    # file is written by several transfers. This sits inside the
                    # retry so a host serving complete-but-wrong bytes is just
                    # another bad attempt — but its .part goes, since resuming
                    # junk would carry the junk forever.
                    if digest and _sha256(part) != digest:
                        part.unlink(missing_ok=True)
                        raise ValueError(f"{dest.name} does not match its expected checksum")
                    break
                except Paused:
                    raise
                except Exception:  # noqa: BLE001 - the last attempt's error is the report
                    if i == len(attempts) - 1:
                        raise
            done = job["done"]
        # Renamed only once every file arrived and verified: a model whose
        # weights landed but whose config did not is not a usable half.
        for (dest, _, _), part in zip(sources, parts):
            part.replace(dest)
        job["state"] = "done"
    except Paused:
        job["state"] = "paused"
    except Exception as exc:  # noqa: BLE001 - the message is the whole report
        # The .part files stay. Whatever went wrong, the bytes already on disk
        # are still good, and pressing Download again continues from them.
        job["error"] = str(exc)
        job["state"] = "error"


