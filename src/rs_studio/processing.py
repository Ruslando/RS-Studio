"""Measured progress and cancellable, isolated local audio operations."""
from contextvars import ContextVar
from collections import OrderedDict
from threading import Event, Lock
from pathlib import Path
import io
import multiprocessing
import os
import re
import signal
import subprocess
import tempfile

_states = OrderedDict()
_states_lock = Lock()
_work_lock = Lock()
_cancel_events = {}
_reservations = set()
_current = ContextVar("audio_operation", default=None)
_channel = None


class OperationCancelled(Exception):
    pass


def _validate(operation_id):
    if not re.fullmatch(r"[a-f0-9]{32}", operation_id):
        raise ValueError("Invalid progress ID")


def _make_room():
    for key in list(_states):
        if len(_states) < 128:
            break
        if _states[key]["state"] in {"done", "error", "cancelled"}:
            del _states[key]
            _cancel_events.pop(key, None)
            _reservations.discard(key)
    if len(_states) >= 128:
        raise ValueError("Too many pending audio operations")


def status(operation_id):
    with _states_lock:
        value = _states.get(operation_id)
        return dict(value) if value else {"state": "pending", "stage": "Waiting", "fraction": None}


def cancel(operation_id):
    _validate(operation_id)
    with _states_lock:
        if operation_id not in _states:
            # The cancel request can arrive before the processing POST is ready.
            _make_room()
            _states[operation_id] = {"state": "cancelled", "stage": "Cancelled", "fraction": None}
            _cancel_events[operation_id] = Event()
            _reservations.add(operation_id)
        value = _states[operation_id]
        if value["state"] in {"queued", "running", "cancelling", "cancelled"}:
            _cancel_events[operation_id].set()
            if value["state"] != "cancelled":
                value.update(state="cancelling", stage="Stopping", fraction=None)
        return dict(value)


def report(stage, completed=None, total=None, device=None):
    operation_id = _current.get()
    if not operation_id:
        return
    fraction = min(1.0, max(0.0, completed / total)) if total and completed is not None else None
    value = dict(stage=stage, fraction=fraction, completed=completed, total=total)
    if device:
        value["device"] = device
    if _channel is not None:
        _channel.send(("progress", value))
    else:
        with _states_lock:
            _states[operation_id].update(value)


def _worker(operation_id, connection, function, args, kwargs):
    global _channel
    if os.name != "nt":
        os.setsid()
    _channel = connection
    _current.set(operation_id)
    try:
        report("Preparing audio")
        connection.send(("result", function(*args, **kwargs)))
    except BaseException as exc:
        connection.send(("error", str(exc) or type(exc).__name__))
    finally:
        connection.close()


def _publish(result, staging, output_dir):
    # Only the parent commits completed artifacts. A terminated worker cannot
    # overwrite an existing stem or leave an incomplete separation in the cache.
    view, warning = result
    try:
        audio_relative = view.audio_path.relative_to(staging)
    except ValueError:
        audio_relative = None  # existing lossless separation reused from cache
    for source in staging.rglob("*"):
        if source.is_file():
            destination = output_dir / source.relative_to(staging)
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source, destination)
    if audio_relative is not None:
        view.audio_path = output_dir / audio_relative
    return view, warning


def run(operation_id, function, *args, output_dir=None, **kwargs):
    tracked = bool(operation_id)
    if not operation_id:
        # Even callers that do not expose progress or cancellation must run in a
        # disposable process. Audio backends cache model weights internally;
        # ending the worker is the reliable boundary that releases CPU and CUDA
        # memory instead of retaining it in the long-lived web server.
        operation_id = os.urandom(16).hex()
    _validate(operation_id)
    with _states_lock:
        if operation_id in _states and operation_id not in _reservations:
            raise ValueError("Progress ID already used")
        if operation_id in _reservations:
            _reservations.remove(operation_id)
            raise OperationCancelled("Operation cancelled")
        _make_room()
        event = _cancel_events[operation_id] = Event()
        _states[operation_id] = {"state": "queued", "stage": "Waiting for audio processor", "fraction": None}
    locked = False
    process = receiver = sender = None
    temporary = None
    try:
        while not locked:
            if event.is_set():
                raise OperationCancelled("Operation cancelled")
            locked = _work_lock.acquire(timeout=0.05)
        if event.is_set():
            raise OperationCancelled("Operation cancelled")
        with _states_lock:
            _states[operation_id]["state"] = "running"
        if output_dir is not None:
            output_dir = Path(output_dir)
            temporary = tempfile.TemporaryDirectory(prefix=".operation-", dir=output_dir)
            kwargs["work_dir"] = Path(temporary.name)
        context = multiprocessing.get_context("spawn")
        receiver, sender = context.Pipe(duplex=False)
        process = context.Process(target=_worker, args=(operation_id, sender, function, args, kwargs))
        process.start()
        sender.close()
        result = None
        while True:
            if event.is_set():
                raise OperationCancelled("Operation cancelled")
            if receiver.poll(0.05):
                try:
                    kind, value = receiver.recv()
                except EOFError:
                    raise RuntimeError("Audio worker exited without a result") from None
                if kind == "progress":
                    with _states_lock:
                        if not event.is_set():
                            _states[operation_id].update(value)
                elif kind == "error":
                    raise RuntimeError(value)
                else:
                    result = value
                    break
            elif not process.is_alive():
                raise RuntimeError(f"Audio worker exited (code {process.exitcode})")
        with _states_lock:
            if event.is_set():
                raise OperationCancelled("Operation cancelled")
            # Once commit begins, Cancel cannot be accepted: the work is complete.
            _states[operation_id].update(state="committing", stage="Finishing", fraction=1.0)
        if temporary is not None:
            result = _publish(result, Path(temporary.name), output_dir)
        with _states_lock:
            _states[operation_id].update(state="done", stage="Complete", fraction=1.0)
        return result
    except OperationCancelled:
        with _states_lock:
            _states[operation_id].update(state="cancelled", stage="Cancelled", fraction=None)
        raise
    except BaseException:
        with _states_lock:
            _states[operation_id].update(state="error", stage="Failed", fraction=None)
        raise
    finally:
        if process is not None and process.pid is not None:
            if process.is_alive():
                if os.name == "nt":
                    # FFmpeg/FFprobe children must stop before staging is removed.
                    subprocess.run(
                        [str(Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32/taskkill.exe"),
                         "/PID", str(process.pid), "/T", "/F"],
                        capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW,
                    )
                else:
                    try:
                        if os.getpgid(process.pid) == process.pid:
                            os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                if process.is_alive():
                    process.terminate()
            process.join()
            process.close()
        if receiver is not None:
            receiver.close()
        if sender is not None:
            sender.close()
        if temporary is not None:
            temporary.cleanup()
        if locked:
            _work_lock.release()
        if not tracked:
            with _states_lock:
                _states.pop(operation_id, None)
                _cancel_events.pop(operation_id, None)
                _reservations.discard(operation_id)


class SeparationOutput(io.StringIO):
    """Translate Demucs' actual tqdm progress, without estimating elapsed time."""
    def __init__(self, device):
        super().__init__()
        self.device = device
        self.partial = ""
        self.pass_number = 0
        self.previous = None

    def write(self, text):
        # Retain a bounded tail for diagnostic CLI errors.
        if self.tell() > 16384:
            tail = self.getvalue()[-4096:]
            self.seek(0)
            self.truncate()
            super().write(tail)
        result = super().write(text)
        self.partial = (self.partial + text)[-4096:]
        matches = list(re.finditer(r"(\d+)%\|[^\r\n]*?\|\s*([\d.]+)/([\d.]+)", self.partial))
        if matches:
            match = matches[-1]
            completed, total = float(match[2]), float(match[3])
            if self.previous is None or completed < self.previous:
                self.pass_number += 1
            self.previous = completed
            report(f"Separation pass {self.pass_number}", completed, total, self.device)
            self.partial = ""
        return result
