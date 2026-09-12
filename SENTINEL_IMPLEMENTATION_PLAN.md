# SENTINEL — Implementation Plan

Hackathon: AI Tinkerers “Agents Everywhere”
Repository: [EmpireofStorm/Kazakh-Guys-Torres](https://github.com/EmpireofStorm/Kazakh-Guys-Torres)

This plan is based on the current repository contents. Existing files (`README.md`, `models_overview.md`, `LICENSE`) are preserved.

---

## 1. Current repository state

| Item | Value |
|---|---|
| Remote | `https://github.com/EmpireofStorm/Kazakh-Guys-Torres.git` |
| Branch | `main` |
| History | `d8c3b85` Initial commit → `850fa61` README typos → `8f017bc` Models Overview |
| Existing files | `README.md` (placeholder), `models_overview.md` (research notes), `LICENSE` (MIT) |
| Application code | `desktop/` Electron app (phases 1–9 + scripted demo). `detector/server.py` is an HTTP **contract stub**, not UCF. |

`models_overview.md` documents **two pretrained detectors** plus fusion:

- **Video:** UCF (DeepfakeBench, Xception). Independently confirmed ~0.7633 AUC on Celeb-DF-v2. **Per-frame scores are volatile** on real video; the team already mitigates with **averaging, not max**.
- **Audio:** AASIST3 (Wav2Vec2 frozen + KAN graph backend). 16 kHz mono, ~4 s clips. Label polarity of the checkpoint is inverted vs the model card (already fixed in research code).
- **Fusion:** noisy-OR, **user-requested, not automatic**. Voice and video stay separate until combined.

Referenced research paths (`src/audio/model.py`, `src/video/crop.py`, `src/fusion.py`) are **not in this GitHub repository yet**. Detector integration must stay behind `DetectorAdapter` / HTTP and must not invent the Python function signatures.

---

## 2. Proposed architecture

SENTINEL is a **desktop agent**. The classifier is a tool, not the product.

```
Electron (main + renderer + overlay)
        │  user-consented window/screen capture
        ▼
Frame sampler (1–2 FPS; intensive only when requested)
        ▼
DetectorAdapter  ── Mock (milestone 1) / HTTP FastAPI (later)
        ▼
Evidence aggregator (deterministic ~10 s window)
        ▼
Rule layer (cheap, every sample)
        │
        ├── stay quiet (stable LOW)
        └── trigger Sentinel agent (thresholds, volatility, sparse faces)
                 │
                 ├── request_additional_sampling
                 └── set_user_assessment → overlay + main UI
```

Observe → analyze evidence → is it sufficient? → gather more **or** act conservatively.

Language never asserts “this person is fake.”

---

## 3. Proposed folder structure

Keep the GitHub repo root as the submission root. Put the app in `desktop/` so a later Python detector can live beside it without mixing runtimes.

```
Kazakh-Guys-Torres/
├── README.md
├── models_overview.md          # do not overwrite research notes
├── LICENSE
├── SENTINEL_IMPLEMENTATION_PLAN.md
├── .gitignore
├── .env.example
├── desktop/                    # Electron + TypeScript
│   ├── package.json
│   ├── electron.vite.config.ts
│   └── src/
│       ├── main/               # windows, IPC, orchestration
│       ├── preload/            # contextBridge only
│       ├── renderer/           # main UI + overlay UI
│       ├── detector/           # adapters (no model lock-in)
│       ├── evidence/           # rolling stats
│       ├── agent/              # tools + conservative policy
│       └── shared/             # types + IPC contracts
└── detector/                   # FastAPI + UCF later (not this milestone)
```

No nested git repositories. CopilotKit starter, if used, is cloned **outside** this tree as reference only.

---

## 4. Libraries / dependencies

**Desktop**

- Electron, TypeScript, React (polished control panel)
- electron-vite (dev server + dual renderer entries)
- zod (IPC + tool schemas)

**Agent**

- `@openai/agents` when `OPENAI_API_KEY` is present
- Deterministic fallback orchestrator so the demo works **without** a key

**Detector (later)**

- FastAPI on localhost
- Team’s UCF / AASIST3 stack — not trained here, not assumed here

Do not put secrets in renderer code. `.env` is gitignored.

---

## 5. Desktop capture approach

- Main process: `desktopCapturer.getSources({ types: ['window', 'screen'] })`
- User picks a source from thumbnails/names (explicit consent)
- Renderer: `getUserMedia` with `chromeMediaSource: 'desktop'` + selected `sourceId`
- Live preview in the main window
- Sample via canvas at **1–2 FPS** (not 30/60)
- Stop/restart tears down the `MediaStream`
- No stealth capture, no permanent frame storage in the MVP

---

## 6. Detector interface

```ts
interface DetectorResult {
  deepfakeProbability: number;
  faceDetected: boolean;
  confidence?: number;
  model?: string;
}

interface DetectorAdapter {
  analyzeFrame(frame: FrameInput): Promise<DetectorResult>;
}
```

- **Now:** `MockDetectorAdapter` with a scripted LOW → volatile → HIGH timeline so the demo works before Python exists.
- **Later:** `HttpDetectorAdapter` → `POST http://127.0.0.1:8000/analyze` with the JSON shape above only. No invented Python APIs.

---

## 7. Evidence aggregation design

Rolling window ~**10 seconds**. Arithmetic is **deterministic code**, never the LLM.

Per sample: timestamp, probability, faceDetected, confidence, model.

Aggregates: sampleCount, validFaceFrames, mean, median, min, max, stdDev, recent trend, previousAssessment.

This matches the UCF finding: single frames can swing 13% → 99.5% on ordinary speech. Average + spread + persistence beat max-score alarms.

---

## 8. Agent design

The agent does **not** run every frame.

**Cheap rules** always run. The agent is triggered when:

- suspicious scores appear
- stddev / trend is unstable
- risk rises quickly
- too few valid face frames
- high scores persist

**MVP tools**

- `get_recent_detection_evidence()`
- `request_additional_sampling({ durationSeconds, framesPerSecond })`
- `set_user_assessment({ level, explanation })`

Deferred: secondary detector, lipsync, audio spoof (AASIST3).

**Policy:** no certainty from one score; LOW_RISK ≠ proven authentic; prefer more evidence over accusation; HIGH_RISK recommends independent identity verification.

Assessments: `LOW_RISK` | `UNCERTAIN` | `HIGH_RISK`  
UI maps `UNCERTAIN` → “VERIFYING…”

---

## 9. Electron overlay design

- Separate `BrowserWindow`
- Frameless, always-on-top, skip taskbar
- Compact, default bottom-right, CSS drag region
- Low risk: tiny status
- Uncertain: “VERIFYING… Gathering more evidence”
- High risk: conservative warning + Details (focuses main window)

---

## 10. Security considerations

- `contextIsolation: true`, `nodeIntegration: false`, preload-only bridge
- Validate IPC with zod; cap frame payload size
- OpenAI key only in main process via `.env`
- Transient frames (data URL / buffer in memory)
- Capture is user-initiated

---

## 11. Phases

| Phase | Goal |
|---|---|
| 0 | Use **this** repo; inspect existing docs |
| 1 | Plan + Electron/TS scaffold |
| 2 | Main window launches |
| 3 | Polished main UI |
| 4 | Always-on-top overlay |
| 5 | Source selection + preview |
| 6 | Frame sampler 1–2 FPS |
| 7 | Mock detector (LOW → VERIFYING → HIGH) |
| 8 | Evidence aggregator |
| 9 | Agent tool layer (+ fallback if no API key) |
| 10 | Real UCF/HTTP detector (after milestone 1) |
| 11 | Demo polish |

**Milestone 1 (in this repo):** phases 1–9 with mock detector, window capture, overlay, evidence, agent tools + fallback.

**Next:** keep FastAPI JSON stable; wrap UCF (video) behind `analyze()` without changing the adapter. Do not auto-fuse AASIST3.

---

## 12. Risks / blockers

- Screen-capture permission / Electron `getUserMedia` constraints on some OS builds
- Overlay positioning on multi-monitor setups
- OpenAI key may be missing during the hackathon — fallback orchestrator is required
- UCF + dlib + DeepfakeBench deps are heavy; keep them in `detector/` later
- AASIST3 checkpoint label swap must not be forgotten when audio is added
- Frame volatility will false-alarm if we ever switch to max-score

---

## 13. Demo plan

1. Open SENTINEL.
2. Overlay appears bottom-right (low/idle).
3. Click **Select Meeting Window**, pick Zoom/browser/any window.
4. Preview shows the live source.
5. Mock detector walks **LOW RISK → VERIFYING → HIGH MANIPULATION RISK** in ~20s while sampling ~1.5 FPS.
6. Copy stays conservative: “High manipulation risk”, “signals consistent with synthetic media”, “verify independently.”
7. Stop monitoring tears down capture cleanly.

Later demo: same UI, `HttpDetectorAdapter` to FastAPI wrapping UCF.

---

## 14. Future meeting-platform integrations

MVP is **desktop-level** on purpose: any meeting app is just a window.

Later, optional: Zoom/Meet/Teams SDK or companion modes. Those must never replace explicit user-selected capture as the default trust boundary.

Audio path (AASIST3) and noisy-OR fusion stay **opt-in**, matching `models_overview.md`.
