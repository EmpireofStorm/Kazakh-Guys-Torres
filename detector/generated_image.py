"""Community Forensics generated-image evidence, separate from UCF face scores.

Source: JeongsooP/Community-Forensics at ee5b71d43db0f3779e1edd64ee927b13f2dd6ad4.
Weights: OwensLab/commfor-model-384 at 6076002bf0d9dd37537f965ee2f06f826c333b61.
Higher sigmoid scores indicate generated images; they are not calibrated
probabilities. The published image threshold is 0.5, not a video verdict.
"""

from pathlib import Path

import numpy as np


def prepare_image(image_rgb: np.ndarray):
    if (not isinstance(image_rgb, np.ndarray) or image_rgb.dtype != np.uint8
            or image_rgb.ndim != 3 or image_rgb.shape[2] != 3
            or min(image_rgb.shape[:2]) < 32 or image_rgb.shape[0] * image_rgb.shape[1] > 16_000_000):
        raise ValueError("Generated-image input must be RGB uint8, at least 32x32 and at most 16 megapixels")

    from PIL import Image
    from torchvision.transforms import functional as transforms

    # Exact upstream test transform. This takes the frame, without face alignment.
    image = transforms.center_crop(transforms.resize(Image.fromarray(image_rgb), 440), 384)
    signal = transforms.to_tensor(image).float()
    return transforms.normalize(signal, [.485, .456, .406], [.229, .224, .225]).unsqueeze(0)


class GeneratedImageDetector:
    model_name = "CommunityForensics"

    def __init__(self, assets_dir: Path, device: str = "cpu"):
        checkpoint = Path(assets_dir) / "community-forensics" / "community-forensics.safetensors"
        if not checkpoint.is_file():
            raise FileNotFoundError(f"Missing generated-image checkpoint: {checkpoint}. Run detector/setup_models.py --generated-images.")

        import timm
        import torch
        from safetensors.torch import load_file

        self.network = timm.create_model("vit_small_patch16_384.augreg_in21k_ft_in1k", pretrained=False, num_classes=1)
        state = load_file(str(checkpoint), device="cpu")
        # Preserve every checkpoint key so missing/unexpected weights fail strict loading.
        self.network.load_state_dict({key.removeprefix("vit."): value for key, value in state.items()}, strict=True)
        self.device = torch.device(device)
        self.network.requires_grad_(False).to(device=self.device, dtype=torch.float32).eval()

    def analyze(self, image_rgb: np.ndarray) -> float:
        import torch

        signal = prepare_image(image_rgb).to(self.device)
        with torch.inference_mode():
            logits = self.network(signal)
            if logits.shape != (1, 1) or not torch.isfinite(logits).all():
                raise RuntimeError("Community Forensics returned invalid generated-image logits")
            return float(logits.sigmoid()[0, 0].item())
