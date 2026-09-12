"""Download pinned public inference assets. Run once, before starting the service."""

import argparse
import hashlib
from pathlib import Path
import shutil
from urllib.request import Request, urlopen

DEFAULT_MODELS = Path(__file__).resolve().parent / "models"
UCF_REF = "f188b1c105465e2e5377eb536a95022ae0e4522d"
AASIST_REF = "a8457bb999b7b6087d238f17604bc4796fcc9fa9"
AASIST_WEIGHTS = "f0e9f100b670c6bc7e0d373a778e375afeaf057b"
COMMUNITY_REF = "ee5b71d43db0f3779e1edd64ee927b13f2dd6ad4"
COMMUNITY_WEIGHTS = "6076002bf0d9dd37537f965ee2f06f826c333b61"
KNOWN_SHA256 = {
    "model.safetensors": "a06d43d8d4a7e11b62fb4fa833f13a598fee23be7c368c416df4bec2e44e664f",
    "community-forensics.safetensors": "b89f36275f3bf5e2b040eee36597a8f19db051bff9a473a9cf7b2466284fb387",
    "ucf_best.pth": "4afa2517feeb473024e1b73049bfa61ce446eb4da14d17c864f2e2a76b3223e5",
    "shape_predictor_81_face_landmarks.dat": "8cae4375589dd915d9a0a881101bed1bbb4e9887e35e63b024388f1ca25ff869",
}


def assets(video: bool, audio: bool, generated_images: bool = False):
    if video:
        for name in ("training/networks/xception.py", "training/detectors/ucf_detector.py",
                     "training/config/detector/ucf.yaml", "preprocessing/preprocess.py", "LICENSE"):
            yield f"DeepfakeBench/{name}", f"https://raw.githubusercontent.com/SCLBD/DeepfakeBench/{UCF_REF}/{name}"
        yield "ucf_best.pth", "https://github.com/SCLBD/DeepfakeBench/releases/download/v1.0.1/ucf_best.pth"
        landmarks = "https://raw.githubusercontent.com/codeniko/shape_predictor_81_face_landmarks/186619fa3ea10c9e3384f5c9bcfa9b77f6cea343"
        yield "shape_predictor_81_face_landmarks.dat", f"{landmarks}/shape_predictor_81_face_landmarks.dat"
        yield "landmarks-LICENSE", f"{landmarks}/LICENSE"
    if audio:
        for name in ("__init__", "branch", "full_model", "gat", "hs_gal", "kan", "pool", "residual", "wav2vec"):
            yield f"AASIST3/model/{name}.py", f"https://raw.githubusercontent.com/lab260ru/AASIST3/{AASIST_REF}/model/{name}.py"
        yield "AASIST3/LICENSE", f"https://raw.githubusercontent.com/lab260ru/AASIST3/{AASIST_REF}/LICENSE"
        for name in ("config.json", "model.safetensors", "README.md"):
            yield f"aasist3-weights/{name}", f"https://huggingface.co/lab260/AASIST3/resolve/{AASIST_WEIGHTS}/{name}"
        yield "wav2vec2/config.json", "https://huggingface.co/facebook/wav2vec2-large-xlsr-53/resolve/c3f9d884181a224a6ac87bf8885c84d1cff3384f/config.json"
    if generated_images:
        for name in ("models.py", "dataloader.py", "custom_transforms.py", "utils.py", "LICENSE"):
            yield f"community-forensics/{name}", f"https://raw.githubusercontent.com/JeongsooP/Community-Forensics/{COMMUNITY_REF}/{name}"
        model_base = f"https://huggingface.co/OwensLab/commfor-model-384/resolve/{COMMUNITY_WEIGHTS}"
        yield "community-forensics/community-forensics.safetensors", f"{model_base}/model.safetensors"
        yield "community-forensics/config.json", f"{model_base}/config.json"
        yield "community-forensics/model-card.md", f"{model_base}/README.md"


def download(url: str, destination: Path):
    checksum = destination.with_name(destination.name + ".sha256")
    if destination.is_file() and checksum.is_file():
        with destination.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() == KNOWN_SHA256.get(destination.name, checksum.read_text().strip()):
                print(f"Verified {destination.name}", flush=True)
                return
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".part")
    print(f"Downloading {destination.name}", flush=True)
    try:
        with urlopen(Request(url, headers={"User-Agent": "SENTINEL-model-setup"}), timeout=120) as response, partial.open("wb") as output:
            shutil.copyfileobj(response, output)
        with partial.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if destination.name in KNOWN_SHA256 and digest != KNOWN_SHA256[destination.name]:
            raise ValueError(f"Checksum mismatch for {destination.name}")
        partial.replace(destination)
        checksum.write_text(digest + "\n")
    finally:
        partial.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", action="store_true", help="Install UCF only")
    parser.add_argument("--audio", action="store_true", help="Install AASIST3 only")
    parser.add_argument("--generated-images", action="store_true", help="Install Community Forensics only")
    parser.add_argument("--models-dir", type=Path, default=DEFAULT_MODELS)
    args = parser.parse_args()
    install_all = not (args.video or args.audio or args.generated_images)
    for relative, url in assets(args.video or install_all, args.audio or install_all, args.generated_images or install_all):
        download(url, args.models_dir / relative)
    print(f"Models installed in {args.models_dir.resolve()}")
