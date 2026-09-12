# Models Overview — Signal Check (Deepfake Detection)

Summary of the AI models powering voice and video deepfake detection, for
the team. Two independent, specialized models — one per modality — plus a
simple rule for combining their results. No single model tries to do both.

---

## 1. Voice detection — AASIST3

**What it is:** A pretrained deepfake/spoofed-voice detector, built from
two parts:
- **Front-end:** Wav2Vec2 — a self-supervised speech model pretrained on
  436,000 hours of speech across 128 languages. It never saw a single
  labeled fake/real example; it just learned general "what does speech
  sound like" representations. Kept **frozen** (not fine-tuned) — a
  published ablation on this exact model family showed freezing the
  front-end beats fine-tuning it (8.8% EER vs. 21.7% EER), because
  fine-tuning on our comparatively small labeled dataset risks overfitting
  and destroying the broad generalization the pretraining provided.
- **Back-end:** A KAN-enhanced graph attention network (AASIST3's own
  contribution) that looks for spoofing artifacts across time and
  frequency in the front-end's output.

**Source:** `MTUCI/AASIST3` on Hugging Face, loaded via a custom loader
(`git clone github.com/mtuciru/AASIST3`) — not a standard
`transformers.AutoModel`.

**Confirmed performance:** **19.23% EER** on the full ASVspoof5 dev shard
(47,400 real files, zero-shot — no fine-tuning on our data). For context:
challenge-baseline systems without a pretrained speech front-end scored
25–40%+ EER on this same dataset; published fine-tuned systems in this
model family reach roughly 1.5–8% EER. Our zero-shot result sits above the
fine-tuned range, as expected — fine-tuning the back-end (front-end still
frozen) on more labeled data is the identified path to closing that gap.

**A finding worth knowing about, not just the model itself:** the model
card states its output convention as "0 = bonafide, 1 = spoof" — but for
this actual loaded checkpoint, that was backwards. Using the card's stated
convention gave an EER of 80.77%, a number only possible if the labels
were being read in reverse (EER above 50% means strong separation,
misread). Swapping the two output indices dropped it to 19.23%, confirmed
correct across the full 47,400-file test. This fix is baked directly into
our code (`src/audio/model.py`), not just documented — anyone loading this
same checkpoint elsewhere would hit the same issue.

**Input format:** mono, 16kHz audio, padded or trimmed to exactly 64,600
samples (~4 seconds).

---

## 2. Video detection — UCF (from DeepfakeBench)

**What it is:** One of 36 detector methods in DeepfakeBench, an academic
benchmark toolkit (NeurIPS 2023) standardizing access to 9 datasets and
33+ published detection methods. UCF uses an Xception backbone.

**Why UCF specifically, not a different method:** picked using
DeepfakeBench's own published cross-dataset comparison table — UCF had
the best within-dataset average (0.9527 AUC) *and* the most top-3
finishes across different test datasets (5 of them), meaning it
generalizes more consistently than alternatives, rather than just
excelling on one benchmark. This mattered because a separate, confirmed
finding showed in-distribution scores can be highly misleading: Xception
scores 99.7% AUC tested on the same dataset it trained on, but only
65.3% on a different deepfake dataset it never saw. One real documented
case: a model at 96.98% training accuracy misclassified every real-world
internet deepfake it was tested on (a well-known Obama PSA, Tom Cruise
face-swap videos) as genuine — because it had only learned the specific,
dated manipulation techniques in its training set.

**Confirmed performance:** **0.7633 AUC** on real Celeb-DF-v2 footage
(n=49 real test files, not benchmark numbers taken on faith) — closely
matching DeepfakeBench's own published UCF-on-Celeb-DF-v2 result of
~0.75 AUC. This is genuine, independent confirmation that our specific
setup (checkpoint, preprocessing, our own face-cropping code) reproduces
the published result rather than just running without errors.

**Face cropping:** Built our own dlib-based face detection and alignment
(`src/video/crop.py`) using the same ArcFace-style method DeepfakeBench's
own preprocessing uses — necessary because real, arbitrary user video
isn't pre-cropped the way benchmark datasets are. Validated directly: ran
it on raw, uncropped images and confirmed it independently found and
correctly aligned faces, producing predictions matching the pre-cropped
benchmark test's direction and rough magnitude.

**A real limitation, found and partially addressed:** testing on actual
recorded video revealed that individual frame-level scores can swing
significantly across a single, unremarkable clip of one person (one test
went from 13% to 99.5% and back down within a few seconds of normal
talking). Aggregating across sampled frames via **simple averaging**
(not the maximum score) is the current mitigation — chosen after testing
showed a single anomalous frame shouldn't be allowed to dominate the
result. The root cause of the frame-to-frame volatility itself is still
open and flagged for deeper research.

**Getting this running required real dependency work** — 10 separate
issues (missing packages, a NumPy 2.0 compatibility break, a circular
import, missing model/data files with a nested-zip surprise) — all
documented and fixed in code, not worked around by hand each time.

---

## 3. Combining the two — fusion logic

Not a model — a deliberate, simple rule (`src/fusion.py`), chosen over a
trained classifier because the labeled paired audio+video data needed for
that (FakeAVCeleb) is still pending access approval.

- **Voice and video are shown separately and immediately**, each as soon
  as its own analysis finishes. Combining them is a separate, explicit
  action the user requests — never automatic.
- **Combination formula:** `1 − (1 − voice_risk) × (1 − video_risk)`
  ("noisy-OR") — answers "what's the chance at least one channel is
  fake," rather than averaging the two scores. A plain average would let
  a strong, correct warning on one channel get diluted by a clean result
  on the other — the wrong trade-off for a tool meant to protect against
  fraud.
- **Risk tiers:** High (>75%), Medium (30–75%), Low (<30%) — the High
  cutoff is a deliberate product decision; the Medium/Low boundary is
  carried over from an earlier proposal and hasn't been separately
  validated.

---

## Honest summary of where things stand

| | Voice (AASIST3) | Video (UCF) |
|---|---|---|
| Status | Confirmed, zero-shot | Confirmed, zero-shot |
| Metric | 19.23% EER | 0.7633 AUC |
| Validated on | Full ASVspoof5 dev shard (47,400 files) | Real Celeb-DF-v2 footage (n=49) |
| Known gap | Below fine-tuned SOTA (~1.5–8% EER) for this model family | Frame-to-frame volatility on real video, partially mitigated |
| Next step | Fine-tune back-end only (front-end stays frozen) on more labeled data | Investigate root cause of per-frame volatility; consider better aggregation |

Both models are real, working, and independently verified against actual
data — not just assumed to work because they loaded without errors. The
target for the next research phase on both is 85–90% accuracy, up from
today's solid-but-improvable zero-shot baselines.
