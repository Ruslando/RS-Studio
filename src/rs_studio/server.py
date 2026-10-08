"""Local FastAPI backend for RS Studio.

The `.runs/` folder is a working CACHE: every analyze writes a `project.json`
manifest into a job folder alongside the heavy artifacts (spectrogram PNG,
playback audio), so the editor can serve them over HTTP without recomputing.

Projects are saved/loaded as a self-contained `.chart` file (a ZIP bundling the
manifest + the spectrogram and playback assets it references). Opening a `.chart`
extracts it into a fresh cache dir; clearing the cache wipes `.runs/` but leaves
your saved `.chart` files untouched.

  POST /api/projects/new             - open an empty draft project (New Project modal)
  POST /api/projects/tutorial/rebuild - create a fresh disposable walkthrough project
  POST /api/projects/{job}/mix       - upload the full song into a draft
  POST /api/projects/{job}/stems/separate - separate one part from a draft's full song
  POST /api/projects/{job}/stems/upload   - add an already-separated stem file to a draft
  DELETE /api/projects/{job}/stems/{stem} - drop a stem from a project
  POST /api/projects/{job}/stems/order   - persist the separated-stem order
  POST /api/projects/{job}/finalize  - name a draft and make it a real project
  POST /api/projects/{job}/stems/{stem}/rename   - rename a stem in a real project
  POST /api/projects/{job}/stems/{stem}/replace  - swap a stem's audio for an uploaded file
  POST /api/projects/{job}/stems/{stem}/separate - recreate a stem from the full song in place
  POST /api/projects/{job}/guitar-pro - preserve an imported GP source in the project
  GET  /api/projects/{job}/guitar-pro/source - stream that untouched source to alphaTab
  POST /api/projects/{job}/export   - persist editor state + download a .chart bundle
  POST /api/projects/import         - open a .chart bundle into a fresh cache dir
  POST /api/cache/clear             - delete every cached project under .runs/
  GET  /api/models                  - model inventory + download progress
  POST /api/models/{id}/download    - start (or resume) fetching one model's weights
  POST /api/models/{id}/pause       - stop one in flight, keeping what it has
  GET  /api/projects                - list cached projects
  GET  /api/projects/{job}          - load a cached project (editor state + URLs)
  POST /api/projects/{job}          - persist editor state into the cache
  GET  /api/spectrogram/{job}/{stem}.png - the rendered CQT image (from disk)
  GET  /api/audio/{job}/{stem}      - the analyzed audio for playback (from disk)
  GET  /                            - the web UI
"""
from __future__ import annotations

import importlib
import io
import ipaddress
import json
import mimetypes
import os
import re
import shutil
import socket
import sys
import tempfile
from threading import Lock
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import UploadFile as StarletteUploadFile

from . import __version__, models, pipeline, processing, tab, tutorial
from .local_security import LocalRequestMiddleware

# ---------------------------------------------------------------------------
# Shared guards for routes that read or write client-supplied project data.
# Use these helpers consistently when adding routes.
#
#   Client-supplied paths       -> _safe_project_file()
#       Resolves a job-relative path and returns None if it escapes the job
#       directory. Anything out of a manifest is client-supplied: a save writes
#       it. Never join a manifest string onto a path by hand.
#
#   Job and stem ids            -> ID_RE, via _job_dir() / _find_stem()
#       Both are path components. Reach them through the helpers, not the
#       parameter.
#
#   Writing project.json        -> _write_manifest()
#       Atomic (temp file + fsync + os.replace). project.json is the whole
#       project and there is no second copy, so a plain write_text() truncates
#       it before it streams. Four routes used to inline exactly that.
#
#   Streaming an upload to disk -> _save_upload()
#       Enforces a byte ceiling and removes the partial file on failure.
#       shutil.copyfileobj will fill the disk instead.
#
#   The project's source audio  -> _project_input()
#       Reads the recorded `inputRel`. Globbing for `input.*` picks
#       alphabetically, which is not "the audio this project uses".
#
#   Fetching a client URL       -> _require_public_url()
#       Applied to the URL AND to every redirect hop; otherwise the server is an
#       HTTP client on the user's private network.
#
#   Extracting an archive       -> _copy_bounded() + the _*_MAX_* ceilings
#       The .chart import. Declared size is attacker-controlled; enforce against
#       bytes actually written.
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent
# When frozen (PyInstaller) bundled resources live under sys._MEIPASS and the
# writable cache sits next to the executable (portable); in dev both resolve to
# the project root.
_FROZEN = getattr(sys, "frozen", False)
_RES_ROOT = Path(getattr(sys, "_MEIPASS", ROOT.parent.parent))
_DATA_ROOT = Path(sys.executable).resolve().parent if _FROZEN else ROOT.parent.parent
WEB_DIR = _RES_ROOT / "web"
RUNS_DIR = _DATA_ROOT / ".runs"
_CONFIG_ROOT = (Path(os.environ["APPDATA"]) if os.name == "nt" and os.environ.get("APPDATA")
                else Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")) / "rs-studio"
_SETUP_MARKER = _CONFIG_ROOT / "setup-complete"
# Recognize existing installations; new setup writes use the RS Studio folder.
_LEGACY_SETUP_MARKER = _CONFIG_ROOT.parent / "rs-editor" / "setup-complete"
ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")  # job + stem ids share the same shape

EDIT_COLOR = "#6ee7b7"
_AUDIO_TYPES = {".opus": "audio/ogg", ".ogg": "audio/ogg", ".flac": "audio/flac",
                ".wav": "audio/wav", ".mp3": "audio/mpeg"}
_IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                ".webp": "image/webp", ".bmp": "image/bmp"}
_COVER_MAX_BYTES = 20 * 1024 * 1024
# A .chart is a zip of a whole project (spectrogram PNGs + Opus per stem), so the
# ceilings are generous — but a zip's declared sizes are attacker-controlled, so
# the unpacked one is enforced against bytes actually written (_copy_bounded).
_PROJECT_MAX_BYTES = 2 * 1024 * 1024 * 1024
_PROJECT_MAX_UNPACKED_BYTES = 4 * 1024 * 1024 * 1024
_PROJECT_MAX_FILES = 4000
_GUITAR_PRO_MAX_BYTES = 64 * 1024 * 1024
_GUITAR_PRO_SUMMARY_MAX_BYTES = 16 * 1024 * 1024
_GUITAR_PRO_EXTS = {".gp", ".gpx", ".gp3", ".gp4", ".gp5"}

app = FastAPI(
    title="RS Studio",
    description="Transcription and charting tool for Rocksmith 2014",
)


# Project-route suffixes whose bodies are binary.
NO_GZIP_SUFFIXES: list[str] = ["/export", "/rocksmith", "/guitar-pro/source"]


def _skip_gzip(path: str) -> bool:
    """Routes whose bodies must NOT be gzipped: the large binary assets (already
    compressed, so gzip wastes CPU for ~no gain) and — critically — the audio,
    where gzip would strip Accept-Ranges and break the browser's byte-range
    seeking into the FLAC. Everything else (the UI files + JSON API) is text and
    compresses well."""
    if path.startswith(("/api/audio/", "/api/spectrogram/")):
        return True
    if path == "/api/tab":
        return True
    if path.startswith("/api/projects/") and path.endswith("/cover"):
        return True
    if path.startswith("/api/projects/") and path.endswith(tuple(NO_GZIP_SUFFIXES)):
        return True
    return False


class ConditionalGZipMiddleware:
    """Gzip text/JSON responses, but pass the binary/streaming routes through
    untouched (see `_skip_gzip`)."""

    def __init__(self, app, minimum_size: int = 1024) -> None:
        self._plain = app
        self._gzip = GZipMiddleware(app, minimum_size=minimum_size)

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") == "http" and not _skip_gzip(scope.get("path", "")):
            await self._gzip(scope, receive, send)
        else:
            await self._plain(scope, receive, send)


app.add_middleware(ConditionalGZipMiddleware, minimum_size=1024)
app.add_middleware(LocalRequestMiddleware)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _job_dir(job: str) -> Path:
    if not ID_RE.match(job):
        raise HTTPException(status_code=400, detail="Invalid project id")
    return RUNS_DIR / job


def _manifest_path(job: str) -> Path:
    return _job_dir(job) / "project.json"


def _read_manifest(job: str) -> dict:
    p = _manifest_path(job)
    if not p.exists():
        raise HTTPException(status_code=404, detail="Unknown project")
    return json.loads(p.read_text())


def _write_manifest(job: str, m: dict) -> None:
    """Replace a project's manifest atomically.

    `project.json` is the whole project — every note, layer, marker and stem
    setting — and there is no second copy. The editor autosaves, so this runs
    constantly. Opening the real path for writing truncates it first, which means
    a crash, a force-quit or a full disk between truncate and write leaves an
    empty or half-written file and the project is gone.

    So: write a sibling temp file, flush it all the way to the platter, then
    rename over the original. `os.replace` is atomic on POSIX and on Windows, so
    a reader (or a crash) only ever sees the complete old file or the complete
    new one. `mkstemp` in the same directory keeps the rename on one filesystem
    and gives concurrent saves distinct names for free.

    Every writer goes through here. Four call sites used to inline
    `_manifest_path(job).write_text(...)` instead and each was one crash away
    from the same data loss.
    """
    path = _manifest_path(job)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(m, indent=2))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        # Never leave a stray .tmp behind. If os.replace already succeeded this
        # cannot run, so it can only ever remove a temp file that lost its race.
        Path(tmp).unlink(missing_ok=True)
        raise


def _find_stem(m: dict, stem: str) -> dict:
    if not ID_RE.match(stem):
        raise HTTPException(status_code=400, detail="Invalid stem id")
    st = next((s for s in m.get("stems", []) if s.get("id") == stem), None)
    if st is None:
        raise HTTPException(status_code=404, detail="Unknown stem")
    return st


def _project_assets(m: dict) -> list[str]:
    """Job-dir-relative paths of the files a manifest needs to render & play."""
    rels: list[str] = []
    for st in m.get("stems", []):
        img = st.get("spectrogram", {}).get("image")
        if img:
            rels.append(img)
        aud = st.get("audio_rel")
        if aud:
            rels.append(aud)
    cover = (m.get("metadata") or {}).get("coverArt")
    if cover:
        rels.append(cover)
    gp_source = (m.get("guitarPro") or {}).get("sourceRel")
    if isinstance(gp_source, str) and re.fullmatch(
        r"guitar-pro/[0-9a-f]{32}\.(?:gp|gpx|gp3|gp4|gp5)", gp_source
    ):
        rels.append(gp_source)
    return rels


def _clean_text(value, limit: int = 160) -> str:
    return str(value or "").strip()[:limit]


def _normalize_metadata(raw: dict | None, current: dict | None = None) -> dict:
    """Project/song metadata kept portable inside project.json."""
    raw = raw if isinstance(raw, dict) else {}
    out = dict(current or {}) if isinstance(current, dict) else {}
    for key, limit in (("title", 180), ("artist", 180), ("album", 180), ("coverArtName", 180)):
        if key in raw:
            out[key] = _clean_text(raw.get(key), limit)
        else:
            out.setdefault(key, "")
    if "year" in raw:
        try:
            year = int(raw.get("year") or 0)
        except (TypeError, ValueError):
            year = 0
        out["year"] = year if 1000 <= year <= 9999 else None
    else:
        out.setdefault("year", None)
    if "coverArt" in raw:
        cover = _clean_text(raw.get("coverArt"), 260)
        out["coverArt"] = cover or None
    else:
        out.setdefault("coverArt", None)
    if "coverArtUpdatedAt" in raw:
        out["coverArtUpdatedAt"] = _clean_text(raw.get("coverArtUpdatedAt"), 40)
    else:
        out.setdefault("coverArtUpdatedAt", None)
    return out


def _metadata_response(m: dict) -> dict:
    """Normalized song details plus a browser-safe cover URL for one manifest."""
    metadata = _normalize_metadata(m.get("metadata"))
    if metadata.get("coverArt"):
        job = m.get("job", "")
        v = metadata.get("coverArtUpdatedAt") or m.get("saved_at") or ""
        metadata["coverArtUrl"] = f"/api/projects/{job}/cover" + (f"?v={v}" if v else "")
    else:
        metadata["coverArtUrl"] = ""
    return metadata


def _apply_save_payload(job: str, payload: dict) -> dict:
    """Merge an editor-state payload into the on-disk manifest and persist it."""
    m = _read_manifest(job)
    if m.get("tutorial"):
        raise HTTPException(status_code=403, detail="The walkthrough project cannot be saved")
    if "editLanes" in payload:
        m["editLanes"] = payload["editLanes"]
    if isinstance(payload.get("stemSettings"), list):
        # Stem audio/specification data is server-owned. The browser may save
        # only its mixer state, and only for stems that are actually in this
        # project.
        settings_by_id = {
            setting.get("id"): setting
            for setting in payload["stemSettings"]
            if isinstance(setting, dict) and isinstance(setting.get("id"), str)
        }
        for stem in m.get("stems", []):
            setting = settings_by_id.get(stem.get("id"))
            if setting is None:
                continue
            if isinstance(setting.get("muted"), bool):
                stem["muted"] = setting["muted"]
            if isinstance(setting.get("solo"), bool):
                stem["solo"] = setting["solo"]
    if "grid" in payload:
        m["grid"] = payload["grid"]
    if "scoreBars" in payload and isinstance(payload.get("scoreBars"), list):
        m["scoreBars"] = payload["scoreBars"]
    if "sectionMarkers" in payload and isinstance(payload.get("sectionMarkers"), list):
        m["sectionMarkers"] = payload["sectionMarkers"]
    if "scoreDuration" in payload:
        try:
            score_duration = float(payload["scoreDuration"])
            if score_duration > 0:
                m["scoreDuration"] = score_duration
                if not m.get("stems"):
                    m["duration"] = score_duration
        except (TypeError, ValueError):
            pass
    if "metadata" in payload:
        m["metadata"] = _normalize_metadata(payload.get("metadata"), m.get("metadata"))
    if "guitarPro" in payload and isinstance(payload.get("guitarPro"), dict):
        # The browser owns the imported score projection, while sourceRel is
        # server-owned so a crafted save cannot point the bundle at arbitrary files.
        source_rel = (m.get("guitarPro") or {}).get("sourceRel")
        m["guitarPro"] = payload["guitarPro"]
        if source_rel:
            m["guitarPro"]["sourceRel"] = source_rel
    if payload.get("name"):
        m["name"] = payload["name"]
    m["saved_at"] = _now()
    _write_manifest(job, m)
    return m


def _safe_filename(name: str) -> str:
    """Sanitize a project name into a download-safe base filename."""
    base = re.sub(r"[^A-Za-z0-9._ -]+", "_", (name or "").strip()).strip(" .")
    return base or "project"


def _response_from_manifest(m: dict) -> dict:
    """Shape a manifest into the payload the frontend restores from."""
    job = m["job"]
    metadata = _metadata_response(m)
    stems = []
    for st in m.get("stems", []):
        spec = dict(st["spectrogram"])
        spec["url"] = f"/api/spectrogram/{job}/{st['id']}.png"
        stems.append({
            "id": st["id"],
            "name": st["name"],
            "spectrogram": spec,
            "audio_url": f"/api/audio/{job}/{st['id']}",
            "muted": bool(st.get("muted", False)),
            "solo": bool(st.get("solo", False)),
        })
    return {
        "job": job,
        "name": m.get("name"),
        "filename": m.get("filename"),
        "duration": m.get("duration"),
        "tempo": m.get("tempo"),
        "separated": m.get("separated", False),
        "separator": m.get("separator"),
        "metadata": metadata,
        "stems": stems,
        "editLanes": m.get("editLanes", []),
        "guitarPro": m.get("guitarPro"),
        "sectionMarkers": m.get("sectionMarkers"),
        "scoreBars": m.get("scoreBars", []),
        "scoreDuration": m.get("scoreDuration"),
        "grid": m.get("grid", {}),
        "warnings": m.get("warnings", []),
        "saved_at": m.get("saved_at"),
    }


# ---- New Project: build a project incrementally (draft) ----
# The modal lets each stem be prepared and previewed independently — separated
# from an uploaded full song, or uploaded pre-separated — before the project is
# created. That needs a job to exist (with real audio on disk, servable by the
# existing spectrogram/audio routes) before the user commits to it. So creating
# a project is now several small calls into a *draft* job rather than one big
# blocking analyze: `new` opens the draft, `mix`/`stems/separate`/`stems/upload`
# add pieces to it (each servable immediately for preview), `finalize` names it
# and turns the draft into a real, listed project. Cancelling just deletes the
# job dir (see DELETE /api/projects/{job}, unchanged) — nothing is listed under
# Recents until finalize clears the draft flag (see api_projects' filter).
def _stem_entry(job_dir: Path, view: pipeline.StemView) -> dict:
    return {
        "id": view.id,
        "name": view.name,
        "audio_rel": str(view.audio_path.relative_to(job_dir)),
        "spectrogram": view.spectrogram,
    }


# Ceiling on a streamed audio upload. The `.chart` import has had bounds since X1;
# the audio routes had none and used `shutil.copyfileobj`, which will fill the
# disk without complaint. Deliberately generous — a ten-minute stereo WAV is
# ~100 MB and a lossless album side more — because this exists to stop an
# unbounded write, not to police file sizes.
_AUDIO_MAX_BYTES = 1024 * 1024 * 1024
_UPLOAD_CHUNK = 1 << 20


def _save_upload(src, dest: Path, limit: int = _AUDIO_MAX_BYTES) -> None:
    """Stream an upload to `dest`, refusing anything past `limit`.

    A partial file is removed on any failure, so a rejected or interrupted upload
    can't be picked up later as if it were real audio.
    """
    written = 0
    try:
        with dest.open("wb") as fh:
            while chunk := src.read(_UPLOAD_CHUNK):
                written += len(chunk)
                if written > limit:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Audio file is larger than {limit // (1024 * 1024)} MB",
                    )
                fh.write(chunk)
    except BaseException:
        dest.unlink(missing_ok=True)
        raise


def _ingest_full_song(job: str, m: dict, audio: UploadFile) -> pipeline.StemView:
    """Store an uploaded full song as the project's source audio and analyze it.

    Shared by POST /mix (into a draft) and POST /audio (attaching to a score-only
    project), which were ~20 duplicated lines apart.

    The stored path is recorded as `inputRel`. Three routes have to find this file
    again later to separate from it, and they did it with
    `sorted(job_dir.glob("input.*"))[0]` — alphabetical order, which is not "the
    audio this project uses". Re-uploading the mix is supported and writes
    `input{new suffix}`, so uploading song.mp3 and then song.wav left both on disk
    and every later separation silently ran on the .mp3 that had been discarded.
    Both halves are closed here: the choice is recorded, and the superseded file
    is deleted rather than left to be found.
    """
    job_dir = _job_dir(job)
    suffix = Path(audio.filename or "input").suffix or ".wav"
    in_path = job_dir / f"input{suffix}"
    _save_upload(audio.file, in_path)
    for stale in job_dir.glob("input.*"):
        if stale != in_path:
            stale.unlink(missing_ok=True)
    try:
        view = pipeline.ingest_stem(in_path, job_dir, "mix", "Full song", with_tempo=True)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not process the full song: {exc}") from exc
    m["inputRel"] = in_path.name
    m["filename"] = audio.filename
    return view


def _project_input(job_dir: Path, m: dict, missing: str = "Original audio missing") -> Path:
    """The audio this project was built from, for the separators to work on."""
    recorded = _safe_project_file(job_dir, m.get("inputRel"))
    if recorded and recorded.exists():
        return recorded
    # Projects created before `inputRel` existed: newest wins. Not exact, but it
    # is at least the file uploaded last, where alphabetical order was picking
    # `.mp3` over the `.wav` that replaced it.
    candidates = sorted(job_dir.glob("input.*"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not candidates:
        raise HTTPException(status_code=404, detail=missing)
    return candidates[0]


def _drop_project_file(job_dir: Path, rel: str | None) -> None:
    """Delete a job-relative file if it is really inside the job directory."""
    asset = _safe_project_file(job_dir, rel)
    if asset:
        asset.unlink(missing_ok=True)


def _draft_manifest(job: str) -> dict:
    m = _read_manifest(job)
    if not m.get("draft"):
        raise HTTPException(status_code=400, detail="Project is already created")
    return m


def _safe_project_file(job_dir: Path, rel: str | None) -> Path | None:
    """Resolve a job-relative path, or None if it escapes the job directory.

    INVARIANT: every path that reaches the filesystem from a manifest MUST go
    through here. Manifest values are not all server-generated — `api_project_import`
    copies an uploaded .chart's project.json in verbatim, so `audio_rel`,
    `spectrogram.image` and `metadata.coverArt` are attacker-controlled after an
    import. Joining one directly would read, serve, or delete arbitrary files.
    """
    if not rel:
        return None
    base = job_dir.resolve()
    path = (job_dir / rel).resolve()
    if path == base or base not in path.parents:
        return None
    return path


def _project_file_or_404(job: str, rel: str | None, what: str) -> Path:
    """`_safe_project_file` for the routes that serve a manifest asset."""
    path = _safe_project_file(_job_dir(job), rel)
    if path is None or not path.exists():
        raise HTTPException(status_code=404, detail=f"{what} missing")
    return path


def _blank_manifest(job_id: str) -> dict:
    """The shape a project starts life in: one empty layer, a 120 BPM 4/4 grid.

    Factored out for the tutorial project, which is built server-side and must
    not drift into being a second, slightly different idea of "a new project".
    """
    return {
        "job": job_id, "name": "", "filename": None,
        "created_at": _now(), "saved_at": _now(), "draft": True,
        "duration": None, "tempo": None, "separated": False, "separator": None,
        "metadata": _normalize_metadata({}),
        "stems": [],
        "editLanes": [
            {
                "id": "edit", "name": "Layer 1", "kind": "edit",
                "color": EDIT_COLOR, "visible": True,
                "instrument": "guitar", "muted": False,
                "tablatureEnabled": True, "notes": [],
            },
        ],
        "grid": {"bpm": 120, "offset": 0.0, "subdiv": 2, "tsNum": 4, "tsDen": 4, "snap": True, "showGrid": True},
        "warnings": [],
        "sectionMarkers": [],
        "scoreBars": [],
        "scoreDuration": None,
    }


_stem_updates_lock = Lock()


def _append_processed_stem(job, job_dir, view, separator=None):
    # Several upload/separation requests can finish together. Merge into the
    # latest manifest instead of overwriting other newly completed audio.
    with _stem_updates_lock:
        current = _read_manifest(job)
        current.setdefault("stems", []).append(_stem_entry(job_dir, view))
        if separator:
            current["separated"] = True
            current["separator"] = current.get("separator") or separator
        current["saved_at"] = _now()
        _write_manifest(job, current)
        return current


@app.post("/api/projects/new")
def api_project_new() -> JSONResponse:
    """Open an empty draft job. Nothing is separated/uploaded yet."""
    job_id = uuid.uuid4().hex[:12]
    job_dir = RUNS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    manifest = _blank_manifest(job_id)
    _write_manifest(job_id, manifest)
    return JSONResponse({"job": job_id})


# Sync `def` (not async) for the three routes below: separation/transcoding is
# heavy, fully blocking CPU work (ffmpeg, librosa, Demucs — seconds to minutes).
# FastAPI runs sync handlers in a worker thread, so the event loop stays free to
# serve other requests (spectrogram/audio for stems already done) meanwhile.
@app.post("/api/projects/{job}/mix")
def api_project_mix(job: str, audio: UploadFile) -> JSONResponse:
    """Upload the full song into a draft. Always stored as stems[0] ("mix") —
    the frontend treats stems[0] as the master/audible-by-default source."""
    m = _draft_manifest(job)
    job_dir = _job_dir(job)
    view = _ingest_full_song(job, m, audio)

    entry = _stem_entry(job_dir, view)
    m["stems"] = [s for s in m["stems"] if s["id"] != "mix"]
    m["stems"].insert(0, entry)
    m["duration"] = view.spectrogram.get("duration")
    m["tempo"] = view.spectrogram.get("tempo")
    m["grid"]["bpm"] = m["tempo"] or 120
    m["grid"]["offset"] = view.spectrogram.get("offset") or 0.0
    _write_manifest(job, m)

    spec = dict(view.spectrogram)
    spec["url"] = f"/api/spectrogram/{job}/{view.id}.png"
    return JSONResponse({
        "stem": {"id": view.id, "name": view.name, "spectrogram": spec, "audio_url": f"/api/audio/{job}/{view.id}"},
        "tempo": m["tempo"], "duration": m["duration"],
    })


@app.post("/api/projects/{job}/audio")
def api_project_attach_audio(job: str, audio: UploadFile) -> JSONResponse:
    """Attach a full-song recording to an existing score-only project."""
    m = _read_manifest(job)
    if m.get("draft"):
        raise HTTPException(status_code=400, detail="Create the project before attaching audio")
    if m.get("stems"):
        raise HTTPException(status_code=400, detail="This project already has audio")
    job_dir = _job_dir(job)
    view = _ingest_full_song(job, m, audio)
    m["stems"] = [_stem_entry(job_dir, view)]
    m["duration"] = view.spectrogram.get("duration") or m.get("scoreDuration")
    m["tempo"] = view.spectrogram.get("tempo") or m.get("tempo")
    m["saved_at"] = _now()
    _write_manifest(job, m)
    return JSONResponse(_response_from_manifest(m))


@app.post("/api/projects/{job}/stems/separate")
def api_project_stem_separate(job: str, payload: dict = Body(...)) -> JSONResponse:
    """Separate one part from the draft's full song using a chosen backend.

    Body: {backend, part}. Each call mints a fresh stem id (out_id), so the same
    part can be pulled from more than one backend in one project.
    """
    backend = payload.get("backend", "demucs")
    part = payload.get("part", "")
    m = _draft_manifest(job)
    if not m["stems"] or m["stems"][0]["id"] != "mix":
        raise HTTPException(status_code=400, detail="Upload the full song first")
    if backend not in {s["id"] for s in pipeline.list_separators()}:
        raise HTTPException(status_code=400, detail="Unknown separator")

    job_dir = _job_dir(job)
    source = _project_input(job_dir, m)
    out_id = f"{part}_{uuid.uuid4().hex[:6]}"
    try:
        view, warn = processing.run(payload.get("progress_id"), lambda: pipeline.add_stem(job_dir, source, backend, part, out_id))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Separation failed: {exc}") from exc

    _append_processed_stem(job, job_dir, view, backend)

    spec = dict(view.spectrogram)
    spec["url"] = f"/api/spectrogram/{job}/{view.id}.png"
    resp = {"stem": {"id": view.id, "name": view.name, "spectrogram": spec, "audio_url": f"/api/audio/{job}/{view.id}"}}
    if warn:
        resp["warning"] = warn
    return JSONResponse(resp)


@app.post("/api/projects/{job}/stems/upload")
def api_project_stem_upload(job: str, file: UploadFile, name: str = Form("")) -> JSONResponse:
    """Add a stem the user already separated themselves — no separation step,
    just transcode + spectrogram.

    Not draft-only: a stem you bring yourself is the same operation in the New
    Project window and in the editor's Add stem menu, and gating it on the draft
    left the editor able to separate a stem but not to load one.
    """
    m = _read_manifest(job)
    job_dir = _job_dir(job)
    out_id = f"stem_{uuid.uuid4().hex[:6]}"
    suffix = Path(file.filename or "stem").suffix or ".wav"
    src_path = job_dir / f"upload_{out_id}{suffix}"
    _save_upload(file.file, src_path)
    stem_name = name.strip() or Path(file.filename or "").stem or "Stem"
    try:
        view = processing.run(None, lambda: pipeline.ingest_stem(src_path, job_dir, out_id, stem_name))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not process '{file.filename}': {exc}") from exc

    _append_processed_stem(job, job_dir, view)

    spec = dict(view.spectrogram)
    spec["url"] = f"/api/spectrogram/{job}/{view.id}.png"
    return JSONResponse({"stem": {"id": view.id, "name": view.name, "spectrogram": spec, "audio_url": f"/api/audio/{job}/{view.id}"}})


@app.delete("/api/projects/{job}/stems/{stem_id}")
def api_project_stem_remove(job: str, stem_id: str) -> JSONResponse:
    """Drop a stem from a draft or an existing project."""
    m = _read_manifest(job)
    job_dir = _job_dir(job)
    st = next((s for s in m["stems"] if s["id"] == stem_id), None)
    if st is None:
        return JSONResponse({"ok": True})
    for rel in (st.get("audio_rel"), st.get("spectrogram", {}).get("image")):
        _drop_project_file(job_dir, rel)
    # ...and the original the stem was ingested from, which nothing deleted. For
    # an app whose inputs are audio files, keeping every source for the life of
    # the project was the largest avoidable disk cost in the codebase.
    for upload in job_dir.glob(f"upload_{stem_id}.*"):
        upload.unlink(missing_ok=True)
    if stem_id == "mix":
        _drop_project_file(job_dir, m.get("inputRel"))
        for stale in job_dir.glob("input.*"):
            stale.unlink(missing_ok=True)
        m.pop("inputRel", None)
    m["stems"] = [s for s in m["stems"] if s["id"] != stem_id]
    m["saved_at"] = _now()
    _write_manifest(job, m)
    return JSONResponse({"ok": True})


@app.post("/api/projects/{job}/stems/order")
def api_project_stem_order(job: str, payload: dict = Body(...)) -> JSONResponse:
    """Persist the sidebar order of separated stems.

    The full-song stem remains first because it is the editor's playback clock.
    """
    m = _read_manifest(job)
    order = payload.get("order")
    current = [st["id"] for st in m.get("stems", [])]
    if not isinstance(order, list) or any(not isinstance(stem_id, str) for stem_id in order):
        raise HTTPException(status_code=400, detail="Invalid stem order")
    if len(order) != len(current) or set(order) != set(current):
        raise HTTPException(status_code=400, detail="Stem order must include every stem exactly once")
    if current and order[0] != current[0]:
        raise HTTPException(status_code=400, detail="The full song must remain first")

    by_id = {st["id"]: st for st in m["stems"]}
    m["stems"] = [by_id[stem_id] for stem_id in order]
    m["saved_at"] = _now()
    _write_manifest(job, m)
    return JSONResponse({"ok": True})


@app.post("/api/projects/{job}/finalize")
def api_project_finalize(job: str, payload: dict = Body(default={})) -> JSONResponse:
    """Name the draft and turn it into a real, listed project."""
    m = _draft_manifest(job)
    if not m["stems"] and not m.get("guitarPro"):
        raise HTTPException(status_code=400, detail="Add audio or import a Guitar Pro score")
    name = (payload or {}).get("name", "")
    if "metadata" in (payload or {}):
        m["metadata"] = _normalize_metadata((payload or {}).get("metadata"), m.get("metadata"))
    m["name"] = name.strip() or (Path(m["filename"]).stem if m.get("filename") else "") or "Untitled"
    if m["duration"] is None:  # no full song — fall back to the longest stem
        m["duration"] = (max(s["spectrogram"]["duration"] for s in m["stems"])
                         if m["stems"] else m.get("scoreDuration") or 1.0)
    m["draft"] = False
    m["saved_at"] = _now()
    _write_manifest(job, m)
    return JSONResponse(_response_from_manifest(m))


@app.get("/api/projects/{job}/cover")
def api_project_cover_get(job: str) -> FileResponse:
    m = _read_manifest(job)
    job_dir = _job_dir(job)
    path = _safe_project_file(job_dir, (m.get("metadata") or {}).get("coverArt"))
    if path is None or not path.exists():
        raise HTTPException(status_code=404, detail="Cover art missing")
    media_type = _IMAGE_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "image/png"
    return FileResponse(path, media_type=media_type)


def _store_cover_art(job: str, m: dict, source, source_name: str) -> JSONResponse:
    job_dir = _job_dir(job)
    try:
        from PIL import Image, ImageOps

        img = Image.open(source)
        img.load()
        img = ImageOps.exif_transpose(img)
        resampling = getattr(Image, "Resampling", Image).LANCZOS
        img = ImageOps.fit(img.convert("RGB"), (512, 512), method=resampling)
        out_rel = "cover_art.png"
        out_path = job_dir / out_rel
        img.save(out_path, "PNG", optimize=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read cover art: {exc}") from exc

    meta = _normalize_metadata(m.get("metadata"))
    meta["coverArt"] = out_rel
    meta["coverArtName"] = _clean_text(source_name or "cover art", 180)
    meta["coverArtUpdatedAt"] = _now()
    m["metadata"] = meta
    m["saved_at"] = _now()
    _write_manifest(job, m)
    return JSONResponse({"metadata": _response_from_manifest(m)["metadata"]})


def _cover_name_from_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    name = Path(urllib.parse.unquote(parsed.path or "")).name
    return name or parsed.hostname or "cover art"


def _require_public_url(url: str) -> None:
    """Refuse a URL that does not resolve to a public address.

    This is the one endpoint that makes the server an HTTP client on behalf of
    whoever is talking to it, which means it can reach things the browser cannot:
    a router's admin page, a printer, a cloud metadata service, anything bound to
    localhost. The app is local-only today so the real-world damage is small, but
    an unrestricted server-side fetcher is the first thing a stranger will open an
    issue about, and the fix is a dozen lines.

    `is_global` is the whole test — it is false for loopback, private ranges,
    link-local, carrier-grade NAT and reserved space, in both IPv4 and IPv6, and
    every address of the host must pass so a dual-stack name can't sneak through
    on one family.

    Deliberately not handled: DNS rebinding between this check and the connect.
    Closing that means resolving once here and connecting to that exact IP with
    the Host header preserved, which is a great deal more machinery than a
    localhost tool needs against an attack requiring a hostile domain *and* a
    local target worth reaching.
    """
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail="Cover URL must be http or https")
    host = parsed.hostname or ""
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Could not resolve {host}") from exc
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if not address.is_global or address.is_multicast:
            raise HTTPException(
                status_code=400,
                detail="Cover URL must point at a public address",
            )


class _PublicOnlyRedirectHandler(urllib.request.HTTPRedirectHandler):
    """urllib follows redirects on its own, so checking only the URL the user
    pasted would let a public host bounce the fetch to 127.0.0.1. Every hop is
    re-checked."""

    def redirect_request(self, req, fp, code, msg, headers, newurl) -> urllib.request.Request | None:
        _require_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_cover_opener = urllib.request.build_opener(_PublicOnlyRedirectHandler())


def _download_cover_url(url: str) -> bytes:
    _require_public_url(url)
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "rs-studio/cover-fetch",
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
    )
    try:
        with _cover_opener.open(request, timeout=20) as resp:
            length = resp.headers.get("Content-Length")
            try:
                too_large = bool(length and int(length) > _COVER_MAX_BYTES)
            except (TypeError, ValueError):
                too_large = False
            if too_large:
                raise HTTPException(status_code=413, detail="Cover art is larger than 20 MB")
            data = resp.read(_COVER_MAX_BYTES + 1)
    except HTTPException:
        raise
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HTTPException(status_code=400, detail=f"Could not fetch cover art: {exc}") from exc
    if len(data) > _COVER_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Cover art is larger than 20 MB")
    return data


@app.post("/api/projects/{job}/cover")
def api_project_cover_upload(job: str, file: UploadFile) -> JSONResponse:
    m = _read_manifest(job)
    # The URL path has enforced _COVER_MAX_BYTES from the start; this one handed
    # an unbounded stream straight to PIL. Same limit, same message.
    data = file.file.read(_COVER_MAX_BYTES + 1)
    if len(data) > _COVER_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Cover art is larger than 20 MB")
    return _store_cover_art(job, m, io.BytesIO(data), file.filename or "cover art")


@app.post("/api/projects/{job}/cover-url")
def api_project_cover_url(job: str, payload: dict = Body(...)) -> JSONResponse:
    url = _clean_text((payload or {}).get("url"), 4096)
    if not url:
        raise HTTPException(status_code=400, detail="Cover URL is required")
    m = _read_manifest(job)
    data = _download_cover_url(url)
    return _store_cover_art(job, m, io.BytesIO(data), _cover_name_from_url(url))


@app.delete("/api/projects/{job}/cover")
def api_project_cover_delete(job: str) -> JSONResponse:
    m = _read_manifest(job)
    job_dir = _job_dir(job)
    meta = _normalize_metadata(m.get("metadata"))
    path = _safe_project_file(job_dir, meta.get("coverArt"))
    if path is not None:
        path.unlink(missing_ok=True)
    meta["coverArt"] = None
    meta["coverArtName"] = ""
    meta["coverArtUpdatedAt"] = _now()
    m["metadata"] = meta
    m["saved_at"] = _now()
    _write_manifest(job, m)
    return JSONResponse({"metadata": _response_from_manifest(m)["metadata"]})


TUTORIAL_JOB = "tutorial"


_TUTORIAL_PROGRESS: dict[str, str] = {}


@app.get("/api/projects/tutorial/progress")
def api_tutorial_progress(progress_id: str) -> dict:
    if not re.fullmatch(r"[a-f0-9]{32}", progress_id):
        raise HTTPException(status_code=400, detail="Invalid progress ID")
    return {"stage": _TUTORIAL_PROGRESS.get(progress_id, "pending")}


@app.post("/api/projects/tutorial/rebuild")
def api_project_tutorial(progress_id: str = "") -> JSONResponse:
    """Build the walkthrough's demo project and return it loaded.

    Always rebuilt, never reused: the walkthrough edits it — that is the whole
    point of it existing — so the second run of a chapter would otherwise open on
    the first run's leftovers and every step that says "now there are no notes
    here" would be a lie.

    It is not in the library (`tutorial: True`, filtered out of /api/projects).
    A demo project sitting in the list beside real work is something the user has
    to learn to ignore forever to be told something once.
    """
    if progress_id and not re.fullmatch(r"[a-f0-9]{32}", progress_id):
        raise HTTPException(status_code=400, detail="Invalid progress ID")

    def progress(stage: str) -> None:
        if progress_id:
            _TUTORIAL_PROGRESS[progress_id] = stage

    if progress_id and len(_TUTORIAL_PROGRESS) >= 32:
        _TUTORIAL_PROGRESS.pop(next(iter(_TUTORIAL_PROGRESS)))
    progress("audio")
    job_dir = RUNS_DIR / TUTORIAL_JOB
    shutil.rmtree(job_dir, ignore_errors=True)
    job_dir.mkdir(parents=True, exist_ok=True)

    parts = tutorial.write_audio(job_dir)
    m = _blank_manifest(TUTORIAL_JOB)
    m.update({
        "name": "Tutorial", "filename": parts["mix"].name, "draft": False,
        "tutorial": True, "separated": True, "separator": "tutorial",
    })
    m["metadata"] = _normalize_metadata({"title": "Tutorial", "artist": "RS Studio"})
    try:
        # The mix is ingested exactly as an uploaded full song is, tempo analysis
        # and all — the tempo lesson needs the app's own guess, not ours.
        progress("mix")
        mix = pipeline.ingest_stem(parts["mix"], job_dir, "mix", "Full song", with_tempo=True)
        progress("bass")
        bass = pipeline.ingest_stem(parts["bass"], job_dir, "bass", "Bass")
    except Exception as exc:
        progress("error")
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Could not build the tutorial project: {exc}") from exc

    progress("finalize")
    m["inputRel"] = parts["mix"].name
    # The project OPENS with the full song alone, because separating a part is
    # something the walkthrough asks the reader to do rather than something it
    # finds already done. The parts are ingested anyway and parked here, so the
    # separation the reader asks for is instant instead of a model run: a
    # walkthrough that waits two minutes on Demucs is a walkthrough nobody
    # finishes, and what is being taught is the menu, not the wait.
    m["stems"] = [_stem_entry(job_dir, mix)]
    m["tutorialStems"] = {bass.id: _stem_entry(job_dir, bass)}
    m["duration"] = mix.spectrogram.get("duration")
    m["tempo"] = mix.spectrogram.get("tempo")
    m["grid"]["bpm"] = m["tempo"] or 120
    m["grid"]["offset"] = mix.spectrogram.get("offset") or 0.0
    _write_manifest(TUTORIAL_JOB, m)
    progress("done")
    return JSONResponse(_response_from_manifest(m))


@app.get("/api/projects")
def api_projects() -> JSONResponse:
    out = []
    if RUNS_DIR.exists():
        for d in sorted(RUNS_DIR.iterdir()):
            mp = d / "project.json"
            if not mp.exists():
                continue
            try:
                m = json.loads(mp.read_text())
            except Exception:
                continue
            if m.get("draft"):  # not finished in the New Project modal yet
                continue
            if m.get("tutorial"):  # the walkthrough's demo song — reachable only from Help
                continue
            edit_notes = sum(len(l.get("notes", [])) for l in m.get("editLanes", []))
            stems = [
                {"id": s.get("id"), "name": s.get("name")}
                for s in m.get("stems", [])
                if s.get("id") != "mix"
            ]
            out.append({
                "job": m.get("job", d.name),
                "name": m.get("name") or m.get("filename") or m.get("job", d.name),
                "filename": m.get("filename"),
                "saved_at": m.get("saved_at"),
                "duration": m.get("duration"),
                "tempo": m.get("tempo"),
                "metadata": _metadata_response({**m, "job": m.get("job", d.name)}),
                "stems": stems,
                "separated": m.get("separated", False),
                "edit_notes": edit_notes,
            })
    out.sort(key=lambda x: x.get("saved_at") or "", reverse=True)
    return JSONResponse(out)


@app.get("/api/version")
def api_version() -> JSONResponse:
    return JSONResponse({"version": __version__})


@app.post("/api/projects/import")
def api_project_import(file: UploadFile) -> JSONResponse:
    """Open a `.chart` bundle: extract it into a fresh cache dir and load it.

    Declared before `/api/projects/{job}` so the fixed `import` path wins over
    the variable one. Sync `def` so the zip extraction (blocking disk I/O) runs
    in a worker thread rather than on the event loop.
    """
    raw = file.file.read(_PROJECT_MAX_BYTES + 1)
    if len(raw) > _PROJECT_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Project file is too large")
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="Not a valid project file (.chart)")
    if "project.json" not in zf.namelist():
        raise HTTPException(status_code=400, detail="Not a valid project file (.chart)")
    if len(zf.namelist()) > _PROJECT_MAX_FILES:
        raise HTTPException(status_code=413, detail="Project file contains too many files")

    job_id = uuid.uuid4().hex[:12]
    job_dir = RUNS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    base = job_dir.resolve()
    budget = _PROJECT_MAX_UNPACKED_BYTES
    try:
        for entry in zf.namelist():
            if entry.endswith("/"):
                continue
            dest = (job_dir / entry).resolve()
            if base != dest and base not in dest.parents:  # reject zip-slip paths
                raise HTTPException(status_code=400, detail="Unsafe path in project file")
            dest.parent.mkdir(parents=True, exist_ok=True)
            # Stream through _copy_bounded rather than zf.read(): a bomb entry
            # would otherwise be fully decompressed into memory before any
            # ceiling could apply.
            with zf.open(entry) as src, open(dest, "wb") as out:
                budget = _copy_bounded(src, out, budget)
        m = json.loads((job_dir / "project.json").read_text())
        if not isinstance(m, dict):
            raise ValueError("project.json is not an object")
    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    except (OSError, ValueError) as exc:   # ValueError covers JSONDecodeError
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=f"Damaged project file: {exc}") from exc

    m["job"] = job_id
    m["saved_at"] = _now()
    _write_manifest(job_id, m)
    return JSONResponse(_response_from_manifest(m))


@app.get("/api/projects/{job}")
def api_project_load(job: str) -> JSONResponse:
    return JSONResponse(_response_from_manifest(_read_manifest(job)))


@app.post("/api/projects/{job}")
def api_project_save(job: str, payload: dict = Body(...)) -> JSONResponse:
    m = _apply_save_payload(job, payload)
    return JSONResponse({"ok": True, "saved_at": m["saved_at"]})


@app.post("/api/projects/{job}/guitar-pro")
async def api_project_guitar_pro(
    job: str,
    request: Request,
) -> JSONResponse:
    """Keep the untouched GP source beside its editable browser projection."""
    m = _read_manifest(job)
    # Starlette deliberately limits ordinary multipart fields to 1 MB.  A
    # detailed multi-track GP projection can be larger, so parse this route with
    # a bounded, score-specific limit while retaining the default everywhere else.
    async with request.form(
        max_files=1,
        max_fields=1,
        max_part_size=_GUITAR_PRO_SUMMARY_MAX_BYTES,
    ) as form:
        file = form.get("file")
        summary = form.get("summary", "{}")
        if not isinstance(file, StarletteUploadFile):
            raise HTTPException(status_code=400, detail="Guitar Pro file is missing")
        if not isinstance(summary, str):
            raise HTTPException(status_code=400, detail="Invalid Guitar Pro summary")
        if len(summary.encode("utf-8")) > _GUITAR_PRO_SUMMARY_MAX_BYTES:
            raise HTTPException(status_code=413, detail="Guitar Pro import data is larger than 16 MB")
        original_name = Path(file.filename or "score.gp").name
        raw = await file.read(_GUITAR_PRO_MAX_BYTES + 1)

    suffix = Path(original_name).suffix.lower()
    if suffix not in _GUITAR_PRO_EXTS:
        raise HTTPException(status_code=400, detail="Choose a .gp, .gpx, .gp3, .gp4, or .gp5 file")
    if not raw:
        raise HTTPException(status_code=400, detail="The Guitar Pro file is empty")
    if len(raw) > _GUITAR_PRO_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Guitar Pro file is larger than 64 MB")
    try:
        parsed = json.loads(summary or "{}")
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid Guitar Pro summary") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="Invalid Guitar Pro summary")

    rel = f"guitar-pro/{uuid.uuid4().hex}{suffix}"
    dest = _job_dir(job) / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(raw)
    parsed.update({
        "sourceRel": rel,
        "sourceFilename": _clean_text(original_name, 240),
        "sourceBytes": len(raw),
        "importedAt": _now(),
    })
    m["guitarPro"] = parsed
    score = parsed.get("score") if isinstance(parsed.get("score"), dict) else {}
    duration = score.get("durationSeconds")
    try:
        duration = float(duration)
    except (TypeError, ValueError):
        duration = None
    if duration and duration > 0:
        m["scoreDuration"] = duration
        if not m.get("stems"):
            m["duration"] = duration
    tempo = score.get("tempo")
    try:
        tempo = float(tempo)
    except (TypeError, ValueError):
        tempo = None
    if tempo and tempo > 0 and not m.get("tempo"):
        m["tempo"] = tempo
    if not m.get("filename"):
        m["filename"] = original_name
    m["saved_at"] = _now()
    _write_manifest(job, m)
    return JSONResponse({"guitarPro": parsed, "saved_at": m["saved_at"]})


@app.get("/api/projects/{job}/guitar-pro/source")
def api_project_guitar_pro_source(job: str) -> FileResponse:
    """Return the untouched source to the same-version browser alphaTab runtime."""
    m = _read_manifest(job)
    gp = m.get("guitarPro") or {}
    rel = gp.get("sourceRel")
    if not isinstance(rel, str) or not re.fullmatch(
        r"guitar-pro/[0-9a-f]{32}\.(?:gp|gpx|gp3|gp4|gp5)", rel
    ):
        raise HTTPException(status_code=404, detail="Guitar Pro source is unavailable")
    source = _safe_project_file(_job_dir(job), rel)
    if source is None or not source.exists():
        raise HTTPException(status_code=404, detail="Guitar Pro source is missing")
    return FileResponse(source, media_type="application/octet-stream", filename=gp.get("sourceFilename") or source.name)


@app.delete("/api/projects/{job}")
def api_project_delete(job: str) -> JSONResponse:
    """Remove one cached project's job dir. Saved `.chart` files are untouched."""
    d = _job_dir(job)  # validates the id (ID_RE) — blocks path traversal
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
    return JSONResponse({"ok": True})


@app.post("/api/projects/{job}/export")
def api_project_export(job: str, payload: dict = Body(default={})) -> Response:
    """Persist the editor state, then return a self-contained `.chart` bundle.

    The bundle is a ZIP holding the manifest (with the job id stripped, so it's
    portable) plus every spectrogram/playback asset the manifest references.
    """
    m = _apply_save_payload(job, payload or {})
    job_dir = _job_dir(job)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        portable = {k: v for k, v in m.items() if k != "job"}
        zf.writestr("project.json", json.dumps(portable, indent=2))
        for rel in _project_assets(m):
            asset = _safe_project_file(job_dir, rel)
            if asset and asset.exists():
                zf.write(asset, rel)
    name = _safe_filename(m.get("name") or m.get("filename") or "project")
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name}.chart"'},
    )


@app.post("/api/cache/clear")
def api_cache_clear() -> JSONResponse:
    """Wipe every cached project under `.runs/`. Saved `.chart` files are untouched."""
    removed = 0
    if RUNS_DIR.exists():
        for child in RUNS_DIR.iterdir():
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink(missing_ok=True)
            removed += 1
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    return JSONResponse({"ok": True, "removed": removed})


@app.get("/api/models")
def api_models() -> JSONResponse:
    """Every model the app can use, with its state and any download in flight."""
    return JSONResponse(models.status())


@app.post("/api/models/{model_id}/download")
def api_model_download(model_id: str) -> JSONResponse:
    """Start fetching one model's weights. The URL is ours, never the caller's."""
    try:
        models.start_download(model_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="No download for this model") from None
    return JSONResponse(models.status())


@app.post("/api/models/{model_id}/pause")
def api_model_pause(model_id: str) -> JSONResponse:
    """Stop a download in flight. Its partial file stays and resumes on demand."""
    models.pause_download(model_id)
    return JSONResponse(models.status())


@app.get("/api/separators")
def api_separators() -> JSONResponse:
    """Stem-separation backends for the analyze form (with availability)."""
    return JSONResponse(pipeline.list_separators())


@app.get("/api/operations/{operation_id}")
async def api_operation_progress(operation_id: str) -> dict:
    if not re.fullmatch(r"[a-f0-9]{32}", operation_id):
        raise HTTPException(status_code=400, detail="Invalid progress ID")
    return processing.status(operation_id)


@app.get("/api/detectors")
def api_detectors() -> JSONResponse:
    """Models available for the editor's per-stem detection dropdown."""
    return JSONResponse(pipeline.list_detectors())


@app.post("/api/detect")
def api_detect(payload: dict = Body(...)) -> JSONResponse:
    """Run a detector on one stem's audio and return the detected notes.

    Body: {job, stem, model, start?, end?}. With start/end (seconds) detection
    is scoped to that time frame. Returns {stem, source, notes[, warning]}; the
    editor drops the notes straight into the active edit lane as editable notes,
    so nothing is persisted here — the notes are saved with the project's edit lanes.
    """
    job = payload.get("job", "")
    stem_id = payload.get("stem", "")
    model = payload.get("model", "")
    start = payload.get("start")
    end = payload.get("end")
    m = _read_manifest(job)            # validates job id
    st = _find_stem(m, stem_id)        # validates stem id
    label = next((d["label"] for d in pipeline.list_detectors() if d["id"] == model), None)
    if label is None:
        raise HTTPException(status_code=400, detail=f"Unknown detector: {model}")

    if m.get("tutorial") and stem_id == "bass" and model == "torchcrepe":
        return JSONResponse({"stem": stem_id, "source": label,
                             "notes": tutorial.cached_bass_detection(start, end)})

    audio = _project_file_or_404(job, st.get("audio_rel"), "Stem audio")
    try:
        notes, warn = processing.run(payload.get("progress_id"), lambda: pipeline.detect(audio, model, start=start, end=end))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Detection failed: {exc}") from exc

    resp = {"stem": stem_id, "source": label, "notes": notes}
    if warn:
        resp["warning"] = warn
    return JSONResponse(resp)


@app.get("/api/stems/{job}/addable")
def api_stems_addable(job: str) -> JSONResponse:
    """Separable stems the project's backend can still surface (not yet added)."""
    m = _read_manifest(job)
    have = {s["id"] for s in m.get("stems", [])}
    separator = m.get("separator")
    if not m.get("separated") or not separator:
        return JSONResponse([])
    sep = next((s for s in pipeline.list_separators() if s["id"] == separator), None)
    stems = (sep or {}).get("stems", [])
    return JSONResponse([s for s in stems if s["id"] not in have])


@app.post("/api/stems/add")
def api_stem_add(payload: dict = Body(...)) -> JSONResponse:
    """Render one extra separated stem and append it to the project.

    Body: {job, stem, backend}. Reuses a matching separation already on disk
    when possible; otherwise runs the selected backend. Persists the new stem
    and returns it shaped like the analyze/load payload's stem entries.
    """
    job = payload.get("job", "")
    stem_id = payload.get("stem", "")
    backend = payload.get("backend", "")
    if not ID_RE.match(stem_id):
        raise HTTPException(status_code=400, detail="Invalid stem id")
    m = _read_manifest(job)

    # The tutorial bass was synthesised, so it is already exact and on disk:
    # "separating" it hands it over. It is checked before the
    # backend is, because which model the reader picked in the menu is part of
    # what the walkthrough is showing them and none of them would be running.
    if m.get("tutorial"):
        ready = (m.get("tutorialStems") or {}).get(stem_id)
        if not ready:
            raise HTTPException(status_code=400, detail="Only the bass stem is available in the tutorial song")
        if not any(s["id"] == stem_id for s in m.get("stems", [])):
            m.setdefault("stems", []).append(ready)
            m["saved_at"] = _now()
            _write_manifest(job, m)
        spec = dict(ready["spectrogram"])
        spec["url"] = f"/api/spectrogram/{job}/{stem_id}.png"
        return JSONResponse({"stem": {
            "id": stem_id, "name": ready["name"], "spectrogram": spec,
            "audio_url": f"/api/audio/{job}/{stem_id}",
        }})

    separator = backend or m.get("separator") or "demucs"
    sep = next((item for item in pipeline.list_separators() if item["id"] == separator), None)
    if not sep or not sep.get("available"):
        raise HTTPException(status_code=400, detail="Selected separation model is unavailable")

    job_dir = _job_dir(job)
    source = _project_input(job_dir, m)
    try:
        out_id = stem_id if not any(s["id"] == stem_id for s in m.get("stems", [])) else f"{stem_id}_{uuid.uuid4().hex[:6]}"
        view, warn = processing.run(payload.get("progress_id"), lambda: pipeline.add_stem(job_dir, source, separator, stem_id, out_id))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not add stem: {exc}") from exc

    _append_processed_stem(job, job_dir, view, separator)

    spec = dict(view.spectrogram)
    spec["url"] = f"/api/spectrogram/{job}/{view.id}.png"
    resp = {
        "stem": {
            "id": view.id,
            "name": view.name,
            "spectrogram": spec,
            "audio_url": f"/api/audio/{job}/{view.id}",
        },
    }
    if warn:
        resp["warning"] = warn
    return JSONResponse(resp)


# ---- post-creation stem editing (main editor's per-stem edit panel) ----
# Rename/replace/recreate all act on a stem already in a real project, in place
# (same id, same on-disk filenames) — so URLs never change and the mixer/editor
# only need to reload the audio, not rewire anything. A fresh ?v= query string
# on the returned URLs busts the browser cache for the file it just overwrote.
def _cache_busted(job: str, stem_id: str) -> tuple[dict, str]:
    v = uuid.uuid4().hex[:8]
    m = _read_manifest(job)
    st = _find_stem(m, stem_id)
    spec = dict(st["spectrogram"])
    spec["url"] = f"/api/spectrogram/{job}/{stem_id}.png?v={v}"
    return spec, f"/api/audio/{job}/{stem_id}?v={v}"


@app.post("/api/projects/{job}/stems/{stem_id}/rename")
def api_stem_rename(job: str, stem_id: str, payload: dict = Body(...)) -> JSONResponse:
    """Rename a stem in place (main editor's stem edit panel)."""
    m = _read_manifest(job)
    st = _find_stem(m, stem_id)
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name can't be empty")
    st["name"] = name
    _write_manifest(job, m)
    return JSONResponse({"ok": True, "name": name})


@app.post("/api/projects/{job}/stems/{stem_id}/replace")
def api_stem_replace(job: str, stem_id: str, file: UploadFile) -> JSONResponse:
    """Swap a stem's audio for a file the user already has, keeping its id/name
    (main editor's stem edit panel) — no separation step, just re-ingest."""
    m = _read_manifest(job)
    st = _find_stem(m, stem_id)
    job_dir = _job_dir(job)
    suffix = Path(file.filename or "stem").suffix or ".wav"
    src_path = job_dir / f"upload_{stem_id}{suffix}"
    _save_upload(file.file, src_path)
    # A replace with a different extension used to leave the old upload behind,
    # one per replace, for the life of the project.
    for stale in job_dir.glob(f"upload_{stem_id}.*"):
        if stale != src_path:
            stale.unlink(missing_ok=True)
    try:
        view = pipeline.ingest_stem(src_path, job_dir, stem_id, st["name"])
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not process '{file.filename}': {exc}") from exc

    st["spectrogram"] = view.spectrogram
    st["audio_rel"] = str(view.audio_path.relative_to(job_dir))
    is_master = m["stems"] and m["stems"][0]["id"] == stem_id
    if is_master:
        m["duration"] = view.spectrogram.get("duration")
    _write_manifest(job, m)

    spec, audio_url = _cache_busted(job, stem_id)
    resp = {"stem": {"id": stem_id, "name": st["name"], "spectrogram": spec, "audio_url": audio_url}}
    if is_master:
        resp["duration"] = m["duration"]
    return JSONResponse(resp)


@app.post("/api/projects/{job}/stems/{stem_id}/separate")
def api_stem_recreate(job: str, stem_id: str, payload: dict = Body(...)) -> JSONResponse:
    """Recreate a stem from the full song with a (possibly different) backend/part,
    overwriting its audio in place (main editor's stem edit panel)."""
    backend = payload.get("backend", "demucs")
    part = payload.get("part", "")
    m = _read_manifest(job)
    st = _find_stem(m, stem_id)
    if m["stems"] and m["stems"][0]["id"] == stem_id:
        raise HTTPException(status_code=400, detail="Can't recreate the full song — replace it with a file instead")
    if backend not in {s["id"] for s in pipeline.list_separators()}:
        raise HTTPException(status_code=400, detail="Unknown separator")

    job_dir = _job_dir(job)
    source = _project_input(job_dir, m, "Full song audio isn't available to separate from")
    try:
        view, warn = processing.run(payload.get("progress_id"), lambda: pipeline.add_stem(job_dir, source, backend, part, stem_id))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Separation failed: {exc}") from exc

    st["spectrogram"] = view.spectrogram
    st["audio_rel"] = str(view.audio_path.relative_to(job_dir))
    m["separated"] = True
    m["separator"] = m.get("separator") or backend
    _write_manifest(job, m)

    spec, audio_url = _cache_busted(job, stem_id)
    resp = {"stem": {"id": stem_id, "name": st["name"], "spectrogram": spec, "audio_url": audio_url}}
    if warn:
        resp["warning"] = warn
    return JSONResponse(resp)


@app.post("/api/tab")
def api_tab(payload: dict = Body(...)) -> Response:
    """Build a Guitar Pro (.gp5) from the current edit lanes + grid.

    Takes a client-supplied spec (so it works on unsaved edits) and returns the
    .gp5 bytes — the same bytes the editor renders for preview and offers for
    download. Quantization/tuning warnings ride along in an X-Tab-Warnings
    header so the UI can surface them without corrupting the binary body.
    """
    try:
        data, warnings = tab.build_gp5(payload or {})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Tab build failed: {exc}") from exc
    name = _safe_filename(payload.get("name") or "tab")
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{name}.gp5"',
            "X-Tab-Warnings": json.dumps(warnings),
        },
    )


@app.get("/api/rocksmith/audio-converter")
def api_rocksmith_audio_converter() -> dict:
    """Whether the platform's WAV-to-WEM tools are available.

    The export already fails with a 424 when it doesn't, but by then the user has
    filled in a form and waited on a voicing pass. Same scan, asked when the
    window opens instead of when the work is done.
    """
    from .rocksmith.wem import audio_converter_status
    return audio_converter_status()


@app.get("/api/setup")
def api_setup_status() -> dict:
    """A durable first-run marker, independent of the desktop server's port."""
    return {"complete": _SETUP_MARKER.is_file() or _LEGACY_SETUP_MARKER.is_file()}


@app.post("/api/setup/complete")
def api_setup_complete() -> dict:
    _CONFIG_ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=_CONFIG_ROOT,
                                     prefix="setup-", delete=False) as tmp:
        tmp.write("1\n")
        pending = Path(tmp.name)
    os.replace(pending, _SETUP_MARKER)
    return {"complete": True}


@app.post("/api/projects/{job}/rocksmith")
def api_rocksmith(job: str, payload: dict = Body(...)) -> Response:
    """Build a Rocksmith 2014 CDLC (.psarc) from the tab spec + project audio.

    Needs Wwise on Windows or oggenc and wav2wem on Linux for WAV-to-WEM.
    Missing tools come back as 424 with instructions.
    """
    job_dir = _job_dir(job)
    m = _read_manifest(job)
    source_audio = _project_input(job_dir, m, "Song audio missing")
    from .rocksmith import builder as rs_builder  # lazy: pulls in cryptography/PIL

    cover_path = _safe_project_file(job_dir, (m.get("metadata") or {}).get("coverArt"))
    if cover_path is not None and not cover_path.exists():
        cover_path = None

    try:
        data, warnings, filename = rs_builder.build_cdlc(
            payload or {}, source_audio, cover_art_path=cover_path)
    except rs_builder.AudioConverterNotFoundError as exc:
        raise HTTPException(status_code=424, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"CDLC build failed: {exc}") from exc
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Tab-Warnings": json.dumps(warnings),
        },
    )


@app.get("/api/spectrogram/{job}/{stem}.png")
def api_spectrogram(job: str, stem: str) -> FileResponse:
    st = _find_stem(_read_manifest(job), stem)
    png = _project_file_or_404(job, st.get("spectrogram", {}).get("image"), "Spectrogram")
    return FileResponse(png, media_type="image/png")


@app.get("/api/audio/{job}/{stem}")
def api_audio(job: str, stem: str) -> FileResponse:
    st = _find_stem(_read_manifest(job), stem)
    path = _project_file_or_404(job, st.get("audio_rel"), "Audio")
    # mimetypes doesn't know .flac on every OS; map the formats we emit explicitly
    # so the browser gets a real audio content-type (some refuse octet-stream).
    media_type = (
        _AUDIO_TYPES.get(path.suffix.lower())
        or mimetypes.guess_type(path.name)[0]
        or "application/octet-stream"
    )
    return FileResponse(path, media_type=media_type)


# The UI self-hosts its two font families, and mimetypes doesn't know .woff2 on
# every OS — it was going out as application/octet-stream. Browsers load a font
# regardless of content-type, so this is not a bug you can see; it is one a strict
# CSP or a caching proxy in front of the app would find for us later.
mimetypes.add_type("font/woff2", ".woff2")


# Serve the web UI at the root. Mount last so /api/* keeps priority. The UI is
# served live from disk and edited often, so force revalidation — otherwise a
# browser can heuristically cache a stale app.js / style.css across edits.
class NoCacheStaticFiles(StaticFiles):
    def file_response(self, *args, **kwargs) -> Response:
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


def _copy_bounded(src, dst, remaining: int) -> int:
    """Copy src->dst, aborting past `remaining` bytes. Returns what's left.

    A zip's declared sizes are attacker-controlled, so the ceiling is enforced
    against bytes actually written, not against the header.
    """
    while True:
        chunk = src.read(64 * 1024)
        if not chunk:
            return remaining
        remaining -= len(chunk)
        if remaining < 0:
            raise HTTPException(status_code=413, detail="Project file expands too far on disk")
        dst.write(chunk)


# Mount the web UI last: it is a catch-all at "/", so anything registered after
# it would never be reached.
if WEB_DIR.exists():
    app.mount("/", NoCacheStaticFiles(directory=str(WEB_DIR), html=True), name="web")


def serve(host: str = "127.0.0.1", port: int = 8000, reload: bool = False) -> None:
    if host not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("RS Studio is a local desktop app; bind to localhost, 127.0.0.1 or ::1")
    import uvicorn

    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    if reload:
        # Reload needs an import string so uvicorn can re-import on change; watch
        # the package source (web/ is served from disk live, so it needs no reload).
        uvicorn.run(
            "rs_studio.server:app",
            host=host, port=port, reload=True, reload_dirs=[str(ROOT)],
        )
    else:
        uvicorn.run(app, host=host, port=port)
