"""UCF inference using the published DeepfakeBench checkpoint and architecture.

Architecture/config: SCLBD/DeepfakeBench at
f188b1c105465e2e5377eb536a95022ae0e4522d, training/detectors/ucf_detector.py
and training/config/detector/ucf.yaml. Only the shared forgery branch affects
the inference logits; the content encoder and reconstruction GAN train it.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Union

import cv2
import dlib
import numpy as np
from skimage.transform import SimilarityTransform
import torch
from torch import nn
from torch.nn import functional as F


def _upstream_classes(path: Path, names: set[str]) -> dict:
    """Load the original classes without importing all 36 training detectors.

    These are executable upstream source files downloaded by setup_models.py,
    not request input. Keep their class bodies intact; omit registry decorators.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    classes = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name in names]
    if {node.name for node in classes} != names:
        raise RuntimeError(f"Unexpected DeepfakeBench source: {path}; rerun model setup")
    for node in classes:
        node.decorator_list = []
    namespace = {"__name__": __name__, "torch": torch, "nn": nn, "F": F, "Union": Union}
    exec(compile(ast.Module(body=classes, type_ignores=[]), str(path), "exec"), namespace)
    return namespace


def align_face(image_rgb: np.ndarray, landmarks: np.ndarray) -> np.ndarray:
    """DeepfakeBench's five-point ArcFace transform, including its 1.3 margin."""
    destination = np.array(
        [[30.2946, 51.6963], [65.5318, 51.5014], [48.0252, 71.7366],
         [33.5493, 92.3655], [62.7299, 92.2041]], dtype=np.float32,
    )
    destination[:, 0] += 8.0
    destination *= 256 / 112
    margin = 256 * (1.3 - 1) / 2
    destination += margin
    destination *= 256 / (256 + 2 * margin)
    transform = SimilarityTransform()
    if not transform.estimate(landmarks.astype(np.float32), destination):
        raise ValueError("Could not align facial landmarks")
    return cv2.warpAffine(image_rgb, transform.params[:2], (256, 256))


def face_tensor(face_rgb: np.ndarray) -> torch.Tensor:
    # Same RGB ToTensor + Normalize(mean=.5, std=.5) as the UCF test dataset.
    return torch.from_numpy(np.ascontiguousarray(face_rgb.transpose(2, 0, 1))).float().div(255).sub(.5).div(.5).unsqueeze(0)


class VideoDetector:
    model_name = "UCF-DeepfakeBench"

    def __init__(self, assets_dir: Path, device: str = "cpu") -> None:
        assets_dir = Path(assets_dir)
        source = assets_dir / "DeepfakeBench" / "training"
        checkpoint = assets_dir / "ucf_best.pth"
        landmarks = assets_dir / "shape_predictor_81_face_landmarks.dat"
        for path in (checkpoint, landmarks, source / "networks/xception.py", source / "detectors/ucf_detector.py"):
            if not path.is_file():
                raise FileNotFoundError(f"Missing video model asset: {path}. Run detector/setup_models.py --video.")

        backbone = _upstream_classes(source / "networks/xception.py", {"SeparableConv2d", "Block", "Xception"})
        heads = _upstream_classes(source / "detectors/ucf_detector.py", {"Conv2d1x1", "Head"})
        self.network = nn.ModuleDict({
            "encoder_f": backbone["Xception"]({"num_classes": 2, "mode": "adjust_channel", "inc": 3, "dropout": False}),
            "block_sha": heads["Conv2d1x1"](512, 256, 256),
            "head_sha": heads["Head"](256, 512, 2),
        })
        state = torch.load(checkpoint, map_location="cpu", weights_only=True)
        if isinstance(state, dict) and "state_dict" in state:
            state = state["state_dict"]
        if not isinstance(state, dict):
            raise RuntimeError("UCF checkpoint must contain a model state dictionary")
        state = {key.removeprefix("module."): value for key, value in state.items()}
        inference_state = {key: value for key, value in state.items() if key.split(".")[0] in self.network}
        # Strict loading prevents absent/mismatched inference weights from producing scores.
        self.network.load_state_dict(inference_state, strict=True)
        self.device = torch.device(device)
        self.network.to(self.device).eval()
        self.face_detector = dlib.get_frontal_face_detector()
        self.landmark_predictor = dlib.shape_predictor(str(landmarks))

    def analyze(self, image_rgb: np.ndarray) -> dict:
        if (not isinstance(image_rgb, np.ndarray) or image_rgb.dtype != np.uint8
                or image_rgb.ndim != 3 or image_rgb.shape[2] != 3
                or min(image_rgb.shape[:2]) < 32):
            raise ValueError("Video input must be an RGB uint8 image at least 32 by 32 pixels")
        image_rgb = np.ascontiguousarray(image_rgb)
        faces = self.face_detector(image_rgb, 1)
        unavailable = {"deepfakeProbability": 0.0, "faceDetected": False, "model": self.model_name}
        if not faces:
            return unavailable
        # ponytail: largest face only, matching upstream; crop a participant before capture for multi-person calls.
        face = max(faces, key=lambda rect: rect.width() * rect.height())
        shape = self.landmark_predictor(image_rgb, face)
        points = np.array([(shape.part(i).x, shape.part(i).y) for i in (37, 44, 30, 49, 55)])
        aligned = align_face(image_rgb, points)
        # Upstream also verifies that a face remains detectable after alignment.
        if not self.face_detector(cv2.cvtColor(aligned, cv2.COLOR_RGB2BGR), 1):
            return unavailable
        with torch.inference_mode():
            features = self.network["encoder_f"].features(face_tensor(aligned).to(self.device))
            shared = self.network["block_sha"](features)
            logits, _ = self.network["head_sha"](shared)
            # UCF's inference method explicitly uses softmax[:, 1] for fake.
            risk = torch.softmax(logits, dim=1)[0, 1].item()
        if not np.isfinite(risk) or not 0 <= risk <= 1:
            raise RuntimeError("UCF returned an invalid risk score")
        return {"deepfakeProbability": risk, "faceDetected": True, "model": self.model_name}
