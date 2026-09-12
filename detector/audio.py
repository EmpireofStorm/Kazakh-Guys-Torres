"""Original AASIST3 inference. Assets are installed separately, never at inference.

Source: lab260ru/AASIST3 at a8457bb999b7b6087d238f17604bc4796fcc9fa9.
Weights: lab260/AASIST3 at f0e9f100b670c6bc7e0d373a778e375afeaf057b.
The score is softmax class 0, spoof, as confirmed in models_overview.md
and upstream datasets/generic.py. It is not a calibrated probability.
"""

from functools import partial
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import threading

import numpy as np


SAMPLE_RATE = 16_000
WINDOW_SAMPLES = 64_600


def prepare_audio(waveform: np.ndarray, sample_rate: int):
    """Accept normalized mono or samples-by-channels PCM and return [1, 64600]."""
    import torch
    import torchaudio.functional as audio_functional

    if isinstance(sample_rate, bool) or not isinstance(sample_rate, (int, np.integer)):
        raise ValueError("Audio sample rate must be an integer.")
    if not 8_000 <= sample_rate <= 192_000:
        raise ValueError("Audio sample rate must be between 8000 and 192000 Hz.")
    samples = np.asarray(waveform, dtype=np.float32)
    if samples.ndim not in (1, 2) or not samples.size:
        raise ValueError("Audio must contain mono or samples-by-channels PCM.")
    if samples.ndim == 2 and not 1 <= samples.shape[1] <= 8:
        raise ValueError("Audio must have between 1 and 8 channels.")
    if not np.isfinite(samples).all():
        raise ValueError("Audio contains non-finite samples.")
    if np.max(np.abs(samples)) > 1.0001:
        raise ValueError("Audio must be normalized floating-point PCM in [-1, 1].")
    if samples.ndim == 2:
        samples = samples.mean(axis=1)
    first_window = samples[: (WINDOW_SAMPLES * int(sample_rate) + SAMPLE_RATE - 1) // SAMPLE_RATE]
    if np.max(np.abs(first_window)) < 1e-7:
        raise ValueError("Audio is silent; no voice evidence is available.")

    signal = torch.from_numpy(np.ascontiguousarray(samples))
    if sample_rate != SAMPLE_RATE:
        signal = audio_functional.resample(signal, int(sample_rate), SAMPLE_RATE)
    # Match the upstream training preprocessing, with a deterministic first window.
    signal = audio_functional.preemphasis(signal, coeff=0.97)
    if signal.numel() < WINDOW_SAMPLES:
        signal = signal.repeat((WINDOW_SAMPLES + signal.numel() - 1) // signal.numel())
    return signal[:WINDOW_SAMPLES].unsqueeze(0)


class AudioDetector:
    def __init__(self, assets_dir: Path, device: str = "cpu"):
        self.assets_dir = Path(assets_dir).resolve()
        self.device = device
        self.model = None
        # ponytail: one inference at a time; batch windows if throughput needs grow.
        self._lock = threading.Lock()

    def _load(self):
        if self.model is not None:
            return
        source = self.assets_dir / "AASIST3" / "model" / "__init__.py"
        weights = self.assets_dir / "aasist3-weights" / "model.safetensors"
        model_config = self.assets_dir / "aasist3-weights" / "config.json"
        encoder_dir = self.assets_dir / "wav2vec2"
        for required in (source, weights, model_config, encoder_dir / "config.json"):
            if not required.is_file():
                raise FileNotFoundError(f"AASIST3 asset missing: {required}. Run detector/setup_models.py --audio.")

        import torch
        from safetensors.torch import load_file

        # Give upstream relative imports their own package, avoiding generic 'model'
        # imports that can collide with other detectors in the same process.
        package_name = "_sentinel_aasist3_" + hashlib.sha256(str(source).encode()).hexdigest()[:12]
        if package_name not in sys.modules:
            spec = importlib.util.spec_from_file_location(package_name, source)
            if spec is None or spec.loader is None:
                raise RuntimeError("Cannot import the installed AASIST3 source.")
            package = importlib.util.module_from_spec(spec)
            sys.modules[package_name] = package
            try:
                spec.loader.exec_module(package)
            except Exception:
                sys.modules.pop(package_name, None)
                raise
        full_model = sys.modules[f"{package_name}.full_model"]
        encoder_class = sys.modules[f"{package_name}.wav2vec"].Wav2Vec2Encoder
        # The full checkpoint already includes the encoder weights. Point the
        # upstream constructor at its local config so it cannot fetch another model.
        full_model.Wav2Vec2Encoder = partial(encoder_class, model_name_or_path=str(encoder_dir))
        config = json.loads(model_config.read_text())
        try:
            model = full_model.aasist3(
                d_args=config["d_args"], size=config["size"], load_pretrained=False
            )
            model.load_state_dict(load_file(str(weights), device="cpu"), strict=True, assign=True)
            model.requires_grad_(False)
            self.model = model.to(torch.device(self.device)).eval()
        except (KeyError, RuntimeError, ValueError) as error:
            raise RuntimeError(f"AASIST3 could not load its pinned checkpoint: {error}") from error

    def analyze(self, waveform: np.ndarray, sample_rate: int) -> float:
        import torch

        signal = prepare_audio(waveform, sample_rate)
        with self._lock:
            self._load()
            with torch.inference_mode():
                logits = self.model(signal.to(self.device))
                if logits.shape != (1, 2) or not torch.isfinite(logits).all():
                    raise RuntimeError("AASIST3 returned invalid class logits.")
                return float(torch.softmax(logits, dim=1)[0, 0].item())
