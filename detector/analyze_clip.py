"""Analyze a saved video or audio file with the installed models."""

import argparse
from functools import lru_cache
import json
from pathlib import Path

from media import analyze_media
from setup_models import DEFAULT_MODELS


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    parser.add_argument("--models-dir", type=Path, default=DEFAULT_MODELS)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--frames", type=int, default=8)
    parser.add_argument("--video-only", action="store_true")
    parser.add_argument("--combine", action="store_true", help="Explicitly request noisy-OR fusion")
    args = parser.parse_args()
    if not 1 <= args.frames <= 100 or args.combine and args.video_only:
        parser.error("Choose 1-100 frames, and both models for --combine")

    @lru_cache(maxsize=2)
    def detector(kind):
        if kind == "video":
            from video import VideoDetector
            return VideoDetector(args.models_dir, args.device)
        from audio import AudioDetector
        return AudioDetector(args.models_dir, args.device)

    result = analyze_media(args.file, lambda image: detector("video").analyze(image),
                           None if args.video_only else lambda wave, sr: detector("audio").analyze(wave, sr), args.frames)
    if args.combine:
        if result["videoRisk"] is None or result["voiceRisk"] is None:
            result["errors"]["combine"] = "Both channels need evidence before combining"
        else:
            result["combinedRisk"] = 1 - (1 - result["voiceRisk"]) * (1 - result["videoRisk"])
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
