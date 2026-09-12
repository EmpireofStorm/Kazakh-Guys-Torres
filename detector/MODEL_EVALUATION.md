# LTX regression investigation — 2026-09-12

The original UCF detector misses this fully generated LTX-2.3 example. Its
alignment and inference were compared with the full upstream implementation:
the pixels and logits match. This is a model generalization limit, not a
reversed class or crop implementation bug.

The app now reports a separate Community Forensics generated-frame check and
leads with strong audio findings even when UCF is low. It does **not** claim
that visual-only LTX detection is solved. Thresholds were not fitted to this
clip, and filenames, hashes and source labels never enter model inference.

## Verified through the running HTTP service

First pass: eight fixed, uniformly spaced frames and audio from 0–4.0375s.
Additional pass: sixteen new frame positions and the next available audio.
All scores are uncalibrated; CF means and counts are experimental video summaries.

| Input / pass | UCF face mean | CF generated-frame mean | CF frames ≥0.5 | AASIST3 audio |
|---|---:|---:|---:|---:|
| LTX / initial | 0.120613 | 0.383961 | 4/8 | 0.746966 |
| LTX / additional | 0.184987 | 0.344891 | 5/16 | 0.999892 |
| Genuine Epps / initial | 0.003957 | 0.000070 | 0/8 | 0.042706 |
| Genuine Epps / additional | 0.004162 | 0.000106 | 0/16 | 0.026688 |

The LTX audio windows cover 8.0213 seconds of an 8.0417-second container.
Calling that evidence incomplete merely because it is an eight-second clip
was misleading. AAC float decoding also produced five samples outside full
scale; clipping finite decoder output to [-1, 1] fixed rejection of valid
audio. Direct model input validation remains strict.

The negative talking-head control is the fixed 30–42s segment of NASA's
[2019 Jeanette Epps interview](https://images.nasa.gov/details/iss061m2627771232_Live_Interviews_Jeanette_Epps_191004).
It was selected before detector scores were observed. Its reencoded MP4 SHA256
is `655973c8d0a746876bc68d6c26d459ca93e0f1820a14edc26a68d2a2fed6b1d3`.
The LTX input SHA256 is `e47f4ed103399055fe62bdbc284460648849bf03befc76702a655c8f4cc914e4`.
This small smoke comparison is not a held-out benchmark or an accuracy estimate.

## Candidate comparison

The same eight frame indices were frozen before candidate inference.
Community Forensics uses its official preprocessing and image threshold 0.5.
UniversalFakeDetect uses its official no-resize center crop 224, CLIP
normalization and unnormalized CLIP features with its released classifier.

| Input | UCF mean | Community Forensics mean | UniversalFakeDetect mean |
|---|---:|---:|---:|
| LTX-2.3 | 0.12061 | 0.38396 | 0.01896 |
| SadTalker Chinese | 0.38374 | 0.68117 | 0.02536 |
| SadTalker multilingual | 0.42212 | 0.98671 | 0.12984 |
| VASA09 | 0.00383 | 0.40826 | 0.11333 |
| VASA15 | 0.06597 | 0.55289 | 0.00871 |
| Genuine Collins portrait | 0.01382 | 0.00178 | 0.00005 |
| Genuine Epps interview | 0.00396 | 0.00007 | 0.00403 |

The Collins image is the public-domain NASA astronaut portrait supplied by
[scikit-image](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.astronaut),
which may have appeared in training datasets. A separately fixed Behnken
segment turned out to be a title card and was retained only as an auxiliary
sample; it is excluded from the natural-video comparison above.

Community Forensics adds useful visual evidence, but its LTX means remain
below 0.5. The app shows the actual 9/24 flagged frames and mixed scores;
it does not relabel the mean, select favorable frames, or call this a reliable
clip-level classification. Its CPU cost was about 60ms per sampled frame.

[UniversalFakeDetect](https://github.com/WisconsinAIVision/UniversalFakeDetect/tree/030495aea3300a8b54c0ec37ec7fe1dd7e63c619)
flagged zero frames from all five synthetic clips at its published threshold.
It was rejected as an upgrade. A temporal [D³ experiment](https://github.com/Zig-HS/D3/tree/c798fbc57fe0c4198d63a73732c2c0f9e4b4816c)
used the authors' XCLIP-16/l2 method and seed 42 sampling without a fitted
threshold. Its higher-means-real raw score ranked LTX (5.366925) above genuine
Epps (1.082667), so it was also rejected. Neither rejected model is loaded
by the app.

## Reproduce and check

```bash
cd detector
python setup_models.py
python check_generated_image.py
python check_server.py
python analyze_clip.py '../deepfake videos/ltx23_realistic_webcam_speaker.mp4'
python analyze_clip.py '../deepfake videos/ltx23_realistic_webcam_speaker.mp4' --additional-evidence
```

The generated-image check compares the adapter's tensors and real logits with
the pinned upstream implementation. Service checks cover independent channel
failures, frames without faces, invalid scores, original-resolution CF input,
distinct second-pass frames and bounded audio decoding. Desktop checks cover
preserved per-pass evidence, independent warnings, model-request metadata and
the uncertainty gate. Native Electron checks use real detector outputs with
a local simulated streaming chat provider; no remote LLM judgment is claimed.
