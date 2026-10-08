"""BS-RoFormer stem separation — an alternative backend to Demucs.

Loads a local MSST-format BS-RoFormer model (a config `.yaml` + weights `.ckpt`
in `models/`) and separates the requested stems with chunked overlap-add
inference. Runs in-process and is numpy<2 safe (unlike audio-separator), so it
coexists with basic_pitch. The model arch is vendored at
`vendor/bs_roformer/` (MSST's copy — the exact code these "Fixed" checkpoints
were saved from, so the state_dict loads strictly).

Prefers CUDA when available (set MTT_ROFORMER_DEVICE to override) and falls back
to CPU automatically if the GPU is out of memory. On CPU it's slow — a full song
can take several minutes — so it's best on short excerpts for A/B-ing guitar.
"""
from __future__ import annotations

from . import processing

import os
from pathlib import Path

MODELS_DIR = Path(__file__).resolve().parents[2] / "models"
CONFIG_NAME = "BS-Rofo-SW-Fixed.yaml"
CHECKPOINT_NAME = "BS-Rofo-SW-Fixed.ckpt"


def _device() -> str:
    """Inference device. Prefers CUDA when available (much faster);
    `MTT_ROFORMER_DEVICE` overrides — e.g. set it to "cpu" to keep the GPU free
    for other work. separate() also falls back to CPU on a CUDA OOM."""
    override = os.environ.get("MTT_ROFORMER_DEVICE")
    if override:
        return override
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"

# Cache the loaded model for the process lifetime (it's ~668 MB + slow to build).
_cache: dict = {}


def config_path() -> Path:
    return MODELS_DIR / CONFIG_NAME


def checkpoint_path() -> Path:
    return MODELS_DIR / CHECKPOINT_NAME


def available() -> bool:
    """True when both model files are present (cheap; no torch import)."""
    return config_path().exists() and checkpoint_path().exists()


def _read_config() -> dict:
    """Load model data, allowing tuples without Python object construction."""
    import yaml

    class ModelConfigLoader(yaml.SafeLoader):
        pass

    ModelConfigLoader.add_constructor(
        "tag:yaml.org,2002:python/tuple",
        lambda loader, node: tuple(loader.construct_sequence(node, deep=True)),
    )
    with config_path().open(encoding="utf-8") as source:
        config = yaml.load(source, Loader=ModelConfigLoader)
    if not isinstance(config, dict):
        raise ValueError("Model configuration must be a mapping")
    return config


def instruments() -> list[str]:
    """Stem ids this model can output, read cheaply from the config yaml.

    Returns [] when the model/config is missing or unreadable, so callers can
    treat it as "no separable stems available".
    """
    if not available():
        return []
    try:
        cfg = _read_config()
        return list(cfg["training"]["instruments"])
    except Exception:
        return []


def _load(device: str) -> tuple:
    """Build + load the model on `device` (cached per-device for the process)."""
    if _cache.get("device") == device:
        return _cache["model"], _cache["cfg"], _cache["instruments"]
    import inspect

    import torch

    from .vendor.bs_roformer import BSRoformer

    cfg = _read_config()
    sig = set(inspect.signature(BSRoformer.__init__).parameters)
    kwargs = {k: v for k, v in dict(cfg["model"]).items() if k in sig}
    # Flash / mem-efficient SDPA kernels are CUDA-only; on CPU they abort with
    # "No available kernel". flash_attn only changes the attention computation,
    # not the weights, so toggling it per device keeps the strict load valid.
    kwargs["flash_attn"] = device.startswith("cuda")
    model = BSRoformer(**kwargs)
    state = torch.load(checkpoint_path(), map_location="cpu", weights_only=True)
    model.load_state_dict(state)  # strict: vendored arch matches the checkpoint exactly
    model.eval()
    model.to(device)
    instruments = list(cfg["training"]["instruments"])
    _cache.update(model=model, cfg=cfg, instruments=instruments, device=device)
    return model, cfg, instruments


def _infer(model, mix, cfg, want: list, device: str) -> "torch.Tensor":
    """Chunked overlap-add inference -> (len(want), 2, n) tensor on CPU.

    Processes fixed chunk_size windows, crossfades the seams, and normalises by
    an accumulated window counter (which also handles the signal edges).
    """
    import torch

    C = int(cfg["audio"]["chunk_size"])
    overlap = max(1, int(cfg.get("inference", {}).get("num_overlap", 2)))
    step = max(1, C // overlap)
    fade = max(1, min(step, C // 10))
    window = torch.ones(C)
    ramp = torch.linspace(0.0, 1.0, fade)
    window[:fade] = ramp
    window[-fade:] = ramp.flip(0)

    n = mix.shape[-1]
    result = torch.zeros(len(want), 2, n)
    counter = torch.zeros(n)
    # On CUDA, autocast to fp16 (MSST's use_amp): flash attention needs half
    # precision, and it halves GPU memory. CPU stays fp32 (math attention).
    use_amp = device.startswith("cuda")
    with torch.no_grad():
        i = 0
        processing.report("Separating audio", 0, (n + step - 1) // step, device)
        while i < n:
            chunk = mix[:, i : i + C]
            clen = chunk.shape[-1]
            if clen < C:
                chunk = torch.nn.functional.pad(chunk, (0, C - clen))
            inp = chunk.unsqueeze(0).to(device)
            if use_amp:
                with torch.autocast("cuda", dtype=torch.float16):
                    out = model(inp)[0]
            else:
                out = model(inp)[0]
            out = out.float().cpu()  # (stems, 2, C)
            w = window[:clen]
            for j, (_, sidx) in enumerate(want):
                result[j, :, i : i + clen] += out[sidx, :, :clen] * w
            counter[i : i + clen] += w
            i += step
            processing.report("Separating audio", min((i + step - 1) // step, (n + step - 1) // step), (n + step - 1) // step, device)
    return result / counter.clamp(min=1e-8)  # broadcast over (stems, 2, n)


def separate(
    input_path: Path, out_dir: Path, wanted: tuple[str, ...] = ("guitar", "bass")
) -> tuple[dict[str, Path], str | None]:
    """Separate `wanted` stems. Returns ({instrument: wav_path}, warning).

    Mirrors pipeline.separate_stems' contract: empty dict + warning on failure,
    so analyze() falls back to the full mix.
    """
    if not available():
        return {}, (
            f"RoFormer model not found in {MODELS_DIR} "
            f"({CONFIG_NAME} + {CHECKPOINT_NAME}). Download it in Settings > Models."
        )
    try:
        import librosa
        import numpy as np
        import soundfile as sf
        import torch
    except Exception as exc:  # pragma: no cover - import guard
        return {}, f"RoFormer dependencies unavailable: {exc}"

    try:  # cheap config peek (sr + stem order) before building the heavy model
        cfg = _read_config()
        sr = int(cfg["audio"]["sample_rate"])
        instruments = list(cfg["training"]["instruments"])
    except Exception as exc:
        return {}, f"RoFormer config unreadable: {exc}"

    idx = {name: instruments.index(name) for name in wanted if name in instruments}
    if not idx:
        return {}, f"RoFormer model does not output any of {wanted}."
    want = list(idx.items())  # [(name, stem_index)]

    y, _ = librosa.load(str(input_path), sr=sr, mono=False)
    if y.ndim == 1:  # mono -> duplicate to the stereo the model expects
        y = np.stack([y, y])
    mix = torch.as_tensor(np.ascontiguousarray(y), dtype=torch.float32)  # (2, n)

    def _run(dev: str) -> "torch.Tensor":
        model, mcfg, _ = _load(dev)  # build/cache + flash_attn per device
        return _infer(model, mix, mcfg, want, dev)

    device = _device()
    note = None
    try:
        result = _run(device)  # OOM / kernel errors can come from _load (.to GPU) or _infer
    except Exception as exc:
        msg = str(exc).lower()
        gpu_issue = "out of memory" in msg or "no available kernel" in msg
        if device.startswith("cuda") and gpu_issue:
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass
            try:
                result = _run("cpu")
                note = "GPU inference failed (busy/OOM); ran RoFormer on CPU instead (slower)."
            except Exception as exc2:
                return {}, f"RoFormer separation failed (GPU error, then CPU retry failed): {exc2}"
        else:
            return {}, f"RoFormer separation failed: {exc}"

    dest = out_dir / "roformer"
    dest.mkdir(parents=True, exist_ok=True)
    paths: dict[str, Path] = {}
    for j, (name, _) in enumerate(want):
        wav = dest / f"{name}.wav"
        sf.write(str(wav), result[j].t().numpy(), sr)  # soundfile wants (n, channels)
        paths[name] = wav
    return paths, note
