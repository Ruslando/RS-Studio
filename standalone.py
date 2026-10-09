"""Entry point for the installed app (bootstrap venv or PyInstaller build), or an audio worker."""
import json
import multiprocessing
import os
import sys
from pathlib import Path

# This must happen BEFORE freeze_support: spawned workers unpickle functions
# from the same external application package as their parent process.
_app_root = os.environ.get("RS_STUDIO_APP_ROOT")
if _app_root:
    sys.path.insert(0, str(Path(_app_root) / "src"))


def _bootstrap_check(destination: Path) -> int:
    """Test the installed binaries without opening the editor or fetching models."""
    sink = open(os.devnull, "w", encoding="utf-8", errors="replace")
    if sys.stdout is None:
        sys.stdout = sink
    if sys.stderr is None:
        sys.stderr = sink
    modules = ("torch", "torchaudio", "torchcodec", "torchvision", "llvmlite.binding", "onnxruntime",
               "scipy", "librosa", "soundfile", "demucs", "basic_pitch", "torchcrepe",
               "piano_transcription_inference", "transformers", "mt3_infer", "webview")
    steps = 4 + len(modules)
    done = [0]

    def step(name):
        # Read line by line by the installer to show what is being checked.
        done[0] += 1
        print(f"check {done[0]}/{steps} {name}", flush=True)

    try:
        import importlib
        from rs_studio.audio_runtime import prepare_ffmpeg
        ffmpeg = prepare_ffmpeg()
        if ffmpeg is None:
            raise RuntimeError("Bundled FFmpeg is missing")
        import subprocess
        for binary in ("ffmpeg", "ffprobe"):
            step(binary)
            result = subprocess.run([str(ffmpeg / (binary + (".exe" if os.name == "nt" else ""))), "-version"],
                                    capture_output=True, timeout=30,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            if result.returncode:
                raise RuntimeError(binary + " cannot start")
        for name in modules:
            step(name)
            importlib.import_module(name)
        step("PyTorch computation")
        import torch
        assert torch.ones(2).sum().item() == 2
        step("RS Studio audio worker")
        from rs_studio import processing, paths, server, __version__
        if processing.run(None, paths.resource_root) != paths.resource_root():
            raise RuntimeError("Audio worker loaded a different application version")
        if not (server.WEB_DIR / "index.html").is_file():
            raise RuntimeError("Application interface is missing")
        if _app_root and not str(Path(server.__file__).resolve()).startswith(str(Path(_app_root).resolve()) + os.sep):
            raise RuntimeError("Runtime loaded embedded application code instead of the installed version")
        destination.write_text(json.dumps({"ok": True, "version": __version__}), encoding="utf-8")
        return 0
    except BaseException as exc:
        destination.write_text(json.dumps({"ok": False, "error": str(exc) or type(exc).__name__}), encoding="utf-8")
        return 1


if __name__ == "__main__":
    multiprocessing.freeze_support()
    if len(sys.argv) == 3 and sys.argv[1] == "--bootstrap-check":
        raise SystemExit(_bootstrap_check(Path(sys.argv[2])))
    from rs_studio.desktop import launch
    launch()
