# Local detector

UCF analyzes faces. Community Forensics checks generated-image signals in
uploaded video frames. AASIST3 analyzes voice. Electron chat and live monitoring call
this same local FastAPI service. No inference request downloads a model or
sends media to an LLM provider.

## Install and run

Python 3.11, FFmpeg including `ffprobe`, and a C++ compiler are required.
The compiler builds dlib. On macOS, use the Xcode command line tools; on
Windows, use Visual Studio C++ Build Tools. This setup was tested on macOS arm64.

From a fresh checkout, using `uv`:

```bash
cd detector
uv venv --python 3.11 .venv
source .venv/bin/activate
uv pip install cmake==3.31.6
uv pip install -r requirements.txt
python setup_models.py
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

In PowerShell, activate with `.venv\Scripts\Activate.ps1` instead.
Model downloads total about 1.7 GB. Models, source snapshots and the virtual
environment are gitignored. `setup_models.py --video`, `--audio`, or `--generated-images` installs
one detector. Re-running setup verifies cached downloads; checkpoint SHA256
values are pinned in the script. Restart the service after changing assets.

On this development machine, dependencies and all three models are already installed.
Start the service from the repo root with:

```bash
detector/.venv/bin/python -m uvicorn server:app --app-dir detector --host 127.0.0.1 --port 8000
```

`SENTINEL_MODELS_DIR` overrides the models folder and `SENTINEL_DEVICE`
selects the PyTorch device, default `cpu`. UCF loads at startup. AASIST3 and
Community Forensics load on their first request. Use one service worker to avoid duplicating
large models in memory. Concurrent model work receives a busy error instead
of queuing stale meeting frames.

## Electron integration

Electron's **Real detector** mode uses `http://127.0.0.1:8000/analyze` by
default. `DETECTOR_URL` overrides the frame URL; health and file-analysis URLs
use the same service prefix. The scripted demo always uses simulated scores.
Uploaded files exercise all three models. Live capture currently uses UCF;
live meeting audio capture is not connected.

In Chat, attach media and ask the agent to analyze it. Its tools call
`/analyze/media` and show separate detector scores. The standalone file picker
in Live monitor uses the same endpoint. The chat model receives score summaries
and filenames; the raw media stays on this detector path.

## API

- `GET /health`: service status, device, loaded-model flags and audio-weight presence.
  Includes `generatedVideoLoaded` and `generatedVideoWeightsPresent`.
- `POST /analyze`: JSON `{ "jpegBase64": "...", "capturedAt": 1710000000000 }`.
  Returns `deepfakeProbability`, `faceDetected`, and `model`. Raw JPEG base64
  only, maximum 8 MiB encoded and 16 megapixels. No face means evidence is
  unavailable; the accompanying zero must not be interpreted as genuine.
- `POST /analyze/audio`: JSON `{ "audioBase64": "..." }` containing WAV/FLAC,
  maximum 30 seconds and 8 MiB encoded. Returns `voiceRisk`, `analyzedSeconds`
  and `model`. Uses the first 64,600 samples after resampling to 16 kHz.
- `POST /analyze/media`: multipart field `file`, maximum 100 MiB and five
  minutes. Supports MP4/MOV, WebM/MKV, WAV, FLAC, MP3, Ogg, AAC and M4A.
  Samples eight video frames and analyzes the first 4.0375 seconds of audio.
  Returns separate `videoRisk` and `voiceRisk`, `mediaDurationSeconds`, sample counts, frame results,
  and channel `errors`. Missing or failed channels have a null score.
  `generatedFrameEvidence` separately reports the Community Forensics mean,
  sampled-frame count, and number at or above its published 0.5 image threshold.
  This summary does not replace UCF's `videoRisk` or enter noisy-OR fusion.
  It works without a detected face. Missing assets produce a null summary and
  `errors.generatedVideo`, preserving the other detectors.
  Set multipart `additionalEvidence=true` for a second pass with up to 16
  different frame timestamps and the next audio window, starting at 4.0375
  seconds. Previously sampled frames and audio are never reused. A short
  video can have fewer new frames or none; fewer than one second of remaining
  audio returns null voice risk and a reason. Successful shorter audio tails
  use the model's repeat-padding. This pass adds `additionalEvidence: true`
  and `voiceStartSeconds: 4.0375` to the report. Use each window's start and
  analyzed duration to account for coverage; short clips may be covered by
  the two passes. Floating-point AAC/MP3 decoding is clipped to PCM full
  scale before inference, matching bounded playback and avoiding rejection
  of finite decoder overshoots.
- `POST /combine`: explicit JSON `{ "voiceRisk": 0.6, "videoRisk": 0.5 }`.
  Returns noisy-OR `combinedRisk` of 0.8 and an uncalibrated risk tier.
  No analysis endpoint automatically combines scores.

Invalid media returns 422; oversized uploads return 413. Direct frame/audio
requests return 503 if the model is missing, busy or cannot run. File analysis
preserves a successful channel when the other channel fails. Temporary uploads
are removed after analysis.

```bash
curl -F 'file=@../deepfake videos/vasa1_synthetic_speaker_09.mp4' \
  http://127.0.0.1:8000/analyze/media
# Gather another window from the same file when the initial evidence is uncertain.
curl -F 'file=@../deepfake videos/vasa1_synthetic_speaker_09.mp4' \
  -F 'additionalEvidence=true' http://127.0.0.1:8000/analyze/media
python analyze_clip.py '../deepfake videos/vasa1_synthetic_speaker_09.mp4'
# Add --combine only when you want noisy-OR fusion; --video-only skips voice.
```

## What is loaded

- [DeepfakeBench](https://github.com/SCLBD/DeepfakeBench/tree/f188b1c105465e2e5377eb536a95022ae0e4522d),
  official `v1.0.1/ucf_best.pth`, plus its 81-point dlib face predictor.
  The wrapper executes the original Xception and shared forgery head classes,
  excludes training-only branches, and strictly loads all inference weights.
  It uses upstream five-point ArcFace alignment, 256x256 RGB normalization
  to [-1, 1], largest-face selection, and class 1 for fake. Clip scores use
  the mean of frames with detected faces.
- [Original AASIST3](https://huggingface.co/lab260/AASIST3/tree/f0e9f100b670c6bc7e0d373a778e375afeaf057b),
  formerly MTUCI/AASIST3, with
  [its custom source](https://github.com/lab260ru/AASIST3/tree/a8457bb999b7b6087d238f17604bc4796fcc9fa9).
  Its checkpoint includes the Wav2Vec2 encoder; only the matching
  `facebook/wav2vec2-large-xlsr-53` config is downloaded separately.
  The wrapper freezes all parameters and uses evaluation/inference mode.
  Audio becomes mono 16 kHz, receives 0.97 pre-emphasis, then repeats or
  trims to exactly 64,600 samples. Class 0 is spoof, as the project notes
  and upstream training labels specify. Silent input is unavailable.
- [Community Forensics](https://github.com/JeongsooP/Community-Forensics/tree/ee5b71d43db0f3779e1edd64ee927b13f2dd6ad4),
  official [87 MB ViT-S/16-384 checkpoint](https://huggingface.co/OwensLab/commfor-model-384/tree/6076002bf0d9dd37537f965ee2f06f826c333b61).
  Original RGB frames use the published PIL resize-to-440, center-crop-to-384
  and ImageNet normalization; the full checkpoint loads strictly. Sigmoid
  scores are image classifier outputs. Frame counts and means are experimental
  video summaries, with no calibrated clip-level threshold.

The published loader uses XLSR-53, which differs from the encoder description
in `models_overview.md`. This integration follows the actual published model.
Upstream now recommends a newer model, but this service deliberately implements
the original AASIST3 named in the project notes. Upstream source/checkpoint
licenses remain separate from this repository's MIT license; downloaded
license files and the model card are included with the assets.

## Checks and observed limits

```bash
python check_video.py
python check_audio.py
python check_generated_image.py
python check_server.py
```

Checks cover preprocessing, output class direction, absent assets/faces,
media validation, busy requests, channel preservation and explicit fusion.
Actual weights were also tested offline, and HTTP file upload exercised both
models. UCF alignment matched upstream pixel-for-pixel and inference logits
matched the full original UCF inference path.

The saved VASA09 clip produced an eight-frame mean UCF score of **0.00383**
and an AASIST3 voice score of **0.9770** through the HTTP upload endpoint.
Other synthetic demo frames also received low UCF scores. These results
confirm the software runs and expose a generalization gap in UCF. They do
not validate detector accuracy or establish the voice's authenticity.

Scores and noisy-OR are uncalibrated. Low scores do not prove authenticity.
The EER/AUC figures in `models_overview.md` were not reproduced in this
integration. Multi-person frames use the largest detected face, and the
initial voice result covers only the first 4.0375 seconds of an uploaded
recording. A requested second pass covers up to the next 4.0375 seconds.

See [the LTX investigation](MODEL_EVALUATION.md) for actual positive/control
results, rejected alternatives, and the remaining visual detection limit.
