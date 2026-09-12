"""Run with detector/.venv/bin/python detector/check_video.py, no model download."""

from pathlib import Path
import tempfile
from types import SimpleNamespace

import dlib
import numpy as np
import torch

from video import VideoDetector, face_tensor


def main():
    rgb = np.zeros((256, 256, 3), dtype=np.uint8)
    rgb[:, :, 0] = 255
    prepared = face_tensor(rgb)
    assert prepared.shape == (1, 3, 256, 256)
    torch.testing.assert_close(prepared[0, :, 100, 100], torch.tensor([1., -1., -1.]))
    with tempfile.TemporaryDirectory() as directory:
        try:
            VideoDetector(Path(directory))
            raise AssertionError("Missing video model returned a detector")
        except FileNotFoundError:
            pass

    detector = VideoDetector.__new__(VideoDetector)
    detector.face_detector = lambda image, upsample: []
    result = detector.analyze(rgb)
    assert not result["faceDetected"], "No face must mean unavailable, not genuine"
    for invalid in (rgb.astype(np.float32), rgb[:, :, 0], rgb[:16], np.zeros((32, 32, 4), dtype=np.uint8)):
        try:
            detector.analyze(invalid)
            raise AssertionError("Invalid image accepted")
        except ValueError:
            pass

    selected = []
    small, large = dlib.rectangle(5, 5, 25, 25), dlib.rectangle(5, 5, 220, 220)
    detector.face_detector = lambda image, upsample: [small, large]
    points = {37: (70, 100), 44: (170, 100), 30: (120, 150), 49: (80, 200), 55: (160, 200)}

    def predictor(image, face):
        selected.append(face)
        return SimpleNamespace(part=lambda i: SimpleNamespace(x=points[i][0], y=points[i][1]))

    class Backbone(torch.nn.Module):
        def features(self, signal):
            assert signal.shape == (1, 3, 256, 256)
            assert not torch.is_grad_enabled()
            return signal

    class Head(torch.nn.Module):
        def forward(self, features):
            return torch.tensor([[-4.0, 4.0]]), features

    detector.device = torch.device("cpu")
    detector.landmark_predictor = predictor
    detector.network = torch.nn.ModuleDict({"encoder_f": Backbone(), "block_sha": torch.nn.Identity(), "head_sha": Head()})
    assert detector.analyze(rgb)["deepfakeProbability"] > .99, "UCF fake must be class 1"
    assert selected == [large], "Analyze the largest selected face"
    print("Video checks passed: RGB normalization, invalid input, missing assets, no face, largest face, class direction.")


if __name__ == "__main__":
    main()
