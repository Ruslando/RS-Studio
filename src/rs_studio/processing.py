"""Request-scoped, measured progress for local audio operations."""
from contextvars import ContextVar
from collections import OrderedDict
from threading import Lock
import io
import re

_states = OrderedDict()
_states_lock = Lock()
_work_lock = Lock()
_current = ContextVar("audio_operation", default=None)


def status(operation_id):
    with _states_lock:
        value = _states.get(operation_id)
        return dict(value) if value else {"state": "pending", "stage": "Waiting", "fraction": None}


def report(stage, completed=None, total=None, device=None):
    operation_id = _current.get()
    if not operation_id:
        return
    fraction = min(1.0, max(0.0, completed / total)) if total and completed is not None else None
    with _states_lock:
        value = _states[operation_id]
        value.update(stage=stage, fraction=fraction, completed=completed, total=total)
        if device:
            value["device"] = device


def run(operation_id, function):
    if operation_id and not re.fullmatch(r"[a-f0-9]{32}", operation_id):
        raise ValueError("Invalid progress ID")
    if operation_id:
        with _states_lock:
            if operation_id in _states:
                raise ValueError("Progress ID already used")
            # Active tasks are retained; completed records are bounded.
            for key in list(_states):
                if len(_states) < 128:
                    break
                if _states[key]["state"] in {"done", "error"}:
                    del _states[key]
            if len(_states) >= 128:
                raise ValueError("Too many pending audio operations")
            _states[operation_id] = {"state": "queued", "stage": "Waiting for audio processor", "fraction": None}
    token = _current.set(operation_id or None)
    try:
        # Model caches and library stdout redirection are process-wide. Serialising
        # heavy jobs also prevents simultaneous songs multiplying peak memory.
        with _work_lock:
            if operation_id:
                with _states_lock:
                    _states[operation_id]["state"] = "running"
            report("Preparing audio")
            result = function()
        if operation_id:
            with _states_lock:
                _states[operation_id].update(state="done", stage="Complete", fraction=1.0)
        return result
    except BaseException:
        if operation_id:
            with _states_lock:
                _states[operation_id].update(state="error", stage="Failed", fraction=None)
        raise
    finally:
        _current.reset(token)


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
