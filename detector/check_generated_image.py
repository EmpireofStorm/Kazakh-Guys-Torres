"""Run with detector/.venv/bin/python detector/check_generated_image.py. No downloads."""

import ast
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace

import numpy as np
from PIL import Image
import torch
from safetensors.torch import load_file, save_file
from torchvision import transforms
from torchvision.transforms import functional as functional

from generated_image import GeneratedImageDetector, prepare_image
from setup_models import DEFAULT_MODELS, KNOWN_SHA256, assets


def main():
    rgb = np.zeros((400, 600, 3), dtype=np.uint8)
    rgb[:, :, 0] = np.arange(600, dtype=np.uint16) % 256
    rgb[:, :, 1] = (np.arange(400, dtype=np.uint16) % 256)[:, None]
    assert prepare_image(rgb).shape == (1, 3, 384, 384)
    for invalid in (rgb.astype(np.float32), rgb[:, :, 0], rgb[:16], np.zeros((32, 32, 4), dtype=np.uint8)):
        try:
            prepare_image(invalid)
            raise AssertionError("Invalid generated-image input was accepted")
        except ValueError:
            pass

    with tempfile.TemporaryDirectory() as directory:
        try:
            GeneratedImageDetector(Path(directory))
            raise AssertionError("Missing checkpoint was accepted")
        except FileNotFoundError:
            pass
        checkpoint = Path(directory) / "community-forensics/community-forensics.safetensors"
        checkpoint.parent.mkdir()
        save_file({"vit.head.bias": torch.zeros(1)}, str(checkpoint))
        try:
            GeneratedImageDetector(Path(directory))
            raise AssertionError("Incomplete checkpoint was accepted")
        except RuntimeError:
            pass

    class FixedLogit(torch.nn.Module):
        def forward(self, signal):
            assert signal.shape == (1, 3, 384, 384) and not torch.is_grad_enabled()
            return torch.tensor([[2.]])

    detector = GeneratedImageDetector.__new__(GeneratedImageDetector)
    detector.device = torch.device("cpu")
    detector.network = FixedLogit()
    assert detector.analyze(rgb) == torch.tensor(2.).sigmoid().item()
    generated_assets = list(assets(False, False, True))
    assert len(generated_assets) == 8 and all(path.startswith("community-forensics/") for path, _ in generated_assets)
    assert KNOWN_SHA256["community-forensics.safetensors"] != KNOWN_SHA256["model.safetensors"]

    source = DEFAULT_MODELS / "community-forensics"
    checkpoint = source / "community-forensics.safetensors"
    if not checkpoint.is_file():
        print("Generated-image checks passed; actual-checkpoint parity skipped because assets are absent.")
        return

    # Original source definitions are installed by the pinned model setup, never supplied by requests.
    tree = ast.parse((source / "custom_transforms.py").read_text())
    definitions = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "ToTensor_range"]
    namespace = {"torch": torch, "Tensor": torch.Tensor, "F": functional}
    exec(compile(ast.Module(body=definitions, type_ignores=[]), str(source / "custom_transforms.py"), "exec"), namespace)
    tree = ast.parse((source / "dataloader.py").read_text())
    definitions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in {"determine_resize_crop_sizes", "get_transform"}]
    namespace.update(transforms=transforms, ctrans=SimpleNamespace(ToTensor_range=namespace["ToTensor_range"]))
    exec(compile(ast.Module(body=definitions, type_ignores=[]), str(source / "dataloader.py"), "exec"), namespace)
    official_transform = namespace["get_transform"](SimpleNamespace(input_size=384), mode="test", dtype=torch.float32)
    expected = official_transform(Image.fromarray(rgb)).unsqueeze(0)
    actual = prepare_image(rgb)
    torch.testing.assert_close(actual, expected, rtol=0, atol=0)

    spec = importlib.util.spec_from_file_location("_community_forensics_check", source / "models.py")
    original = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(original)
    create_model = original.timm.create_model

    def no_backbone_download(*args, **kwargs):
        kwargs["pretrained"] = False
        return create_model(*args, **kwargs)

    original.timm.create_model = no_backbone_download
    try:
        reference = original.ViTClassifier(device="cpu")
    finally:
        original.timm.create_model = create_model
    reference.load_state_dict(load_file(str(checkpoint), device="cpu"), strict=True)
    reference.eval()
    detector = GeneratedImageDetector(DEFAULT_MODELS)
    with torch.inference_mode():
        original_logits = reference(expected)
        actual_logits = detector.network(actual)
    torch.testing.assert_close(actual_logits, original_logits, rtol=0, atol=0)
    assert detector.analyze(rgb) == original_logits.sigmoid()[0, 0].item()
    print("Generated-image checks passed: invalid input, missing/strict assets, score direction, setup selection, exact official transform and logits.")


if __name__ == "__main__":
    main()
