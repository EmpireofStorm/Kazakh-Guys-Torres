# Colab model comparison

Reviewed on 2026-09-12 against `Hackaton.ipynb` in upstream commit
`04364a27596d8c3060f4eaa9e325b92db13add40`. Cell numbers below refer to the
original notebook, starting at zero.

Keep the current UCF and AASIST3 implementation. The notebook loads public
pretrained checkpoints and contains no fine-tuning run, custom weight export,
or held-out evaluation showing an improvement.

| Component | Notebook | Current application and decision |
| --- | --- | --- |
| Video weights, cells 11–12 | DeepfakeBench `v1.0.1/ucf_best.pth` | The same release is already installed, with SHA256 verification. Keep the wrapper whose alignment and logits were checked against upstream. |
| Audio weights, cells 1 and 15 | `MTUCI/AASIST3` | Official metadata currently resolves this alias to `lab260/AASIST3`, revision `f0e9f100b670c6bc7e0d373a778e375afeaf057b`. The file hash matches our pinned weights exactly. |
| Audio preprocessing | Zero-padding to 64,600 samples, without pre-emphasis | Keep the existing upstream-compatible pre-emphasis and repeat-padding. A different preprocessing recipe does not establish a better model. |
| Video examples, cell 12 | One declared real frame scores `0.195941`; one fake frame scores `0.593219` | Two examples cannot establish comparative accuracy. |
| Audio examples, cells 3 and 8–10 | Declared real samples score approximately `0.9953–1.0`, alongside similarly high fake scores | These outputs raise false-alarm concerns. They do not support replacing the current pipeline. |
| HTTP service, cell 17 | Basic `/health` and frame-only `/analyze` | Keep `server.py`, which implements the health, audio, media upload, and distinct additional-evidence contracts required by chat. |

The [official Hugging Face metadata](https://huggingface.co/api/models/MTUCI/AASIST3?blobs=true)
reports a 1,287,120,456-byte `model.safetensors` file with SHA256
`a06d43d8d4a7e11b62fb4fa833f13a598fee23be7c368c416df4bec2e44e664f`.
This matches `setup_models.py`. The notebook did not record the revision it
downloaded during its saved run, so the historical bytes cannot be verified.

The original notebook is retained as a prototype with credentials and saved
outputs removed. Its optional legacy agent cells now read Colab Secrets, and
the hard-coded secondary-channel response is labeled as simulated. Those
cells are not used by the desktop app. Existing committed credentials still
need rotation by their owners.

GPU execution can use the current service with `SENTINEL_DEVICE=cuda`. Moving
inference to Colab may change runtime performance; it does not establish an
accuracy improvement. No notebook cells, external agent calls, or tunnel were
run during this review.

To evaluate a future fine-tuned checkpoint, compare both implementations on
the same labeled, held-out files. Report false positives, missed fakes, audio
EER, video ROC-AUC, and unavailable-evidence coverage. The current demo clips
are insufficient for that comparison, and their voice labels are unverified.
