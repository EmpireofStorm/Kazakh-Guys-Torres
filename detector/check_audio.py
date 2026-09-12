"""Run with detector/.venv/bin/python detector/check_audio.py, no model download."""

from pathlib import Path
import tempfile

import numpy as np
import torch

from audio import AudioDetector, WINDOW_SAMPLES, prepare_audio


def main():
    samples = np.array([0.25, 0.5, -0.25], dtype=np.float32)
    prepared = prepare_audio(samples, 16_000)
    assert prepared.shape == (1, WINDOW_SAMPLES)
    np.testing.assert_allclose(prepared[0, :3], [0.25, 0.2575, -0.735], atol=1e-6)
    torch.testing.assert_close(prepared[0, :3], prepared[0, 3:6])
    torch.testing.assert_close(prepared, prepare_audio(np.column_stack([samples, samples]), 16_000))
    assert prepare_audio(np.tile(samples, 40_000), 48_000).shape == (1, WINDOW_SAMPLES)
    long_audio = np.tile(samples, 30_000)
    torch.testing.assert_close(prepare_audio(long_audio, 16_000), prepare_audio(long_audio[:WINDOW_SAMPLES], 16_000))

    for invalid in ([], [float("nan")], [float("inf")], [2.0], [0.0], np.ones((2, 20)), np.r_[np.zeros(WINDOW_SAMPLES), samples]):
        try:
            prepare_audio(np.asarray(invalid), 16_000)
            raise AssertionError("Invalid audio accepted")
        except ValueError:
            pass
    for invalid_rate in (0, 1_000_000, 16_000.0, True):
        try:
            prepare_audio(samples, invalid_rate)
            raise AssertionError("Invalid sample rate accepted")
        except ValueError:
            pass
    with tempfile.TemporaryDirectory() as directory:
        detector = AudioDetector(Path(directory))
        try:
            detector.analyze(samples, 16_000)
            raise AssertionError("Missing model returned a score")
        except FileNotFoundError:
            pass

        class Logits(torch.nn.Module):
            def forward(self, signal):
                assert signal.shape == (1, WINDOW_SAMPLES)
                assert not torch.is_grad_enabled()
                return torch.tensor([[4.0, -4.0]])

        detector.model = Logits().eval()
        assert detector.analyze(samples, 16_000) > 0.99, "Spoof must be class 0"
    print("Audio checks passed: preprocessing, validation, missing assets, class direction.")


if __name__ == "__main__":
    main()
