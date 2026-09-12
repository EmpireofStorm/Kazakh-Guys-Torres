# Deepfake video samples

Downloaded on 2026-09-12 from the authors' public research demonstration pages. Files are unchanged apart from descriptive filenames.

| File | Duration | Content | Original download |
| --- | --- | --- | --- |
| `vasa1_synthetic_speaker_09.mp4` | 15.02 s | Realistic synthetic talking face, with a small reference portrait inset | [MP4](https://vasavatar.github.io/VASA-1/video/9.mp4) |
| `vasa1_synthetic_speaker_15.mp4` | 15.02 s | Realistic synthetic talking face, with a small reference portrait inset | [MP4](https://vasavatar.github.io/VASA-1/video/15.mp4) |
| `sadtalker_multilingual_talking.mp4` | 26.78 s | Grid of animated portraits speaking different languages | [MP4](https://github.com/sadtalker/sadtalker.github.io/blob/main/static/videos/talking.mp4?raw=true) |
| `sadtalker_chinese_speaking.mp4` | 23.10 s | Grid of animated portraits speaking Chinese | [MP4](https://github.com/sadtalker/sadtalker.github.io/blob/main/static/videos/chinese_speaker.mp4?raw=true) |

Start with the two VASA-1 clips and select the large animated face if the detector finds the small reference portrait too. The SadTalker clips contain grids of faces, including stylized portraits, and are better suited to exploratory demos.

## Sources and labels

- [VASA-1, Microsoft Research Asia](https://vasavatar.github.io/VASA-1/), also linked from [Microsoft Research](https://www.microsoft.com/en-us/research/project/vasa-1/). The authors generate talking videos from a portrait and speech audio. They state that the portrait identities in these examples are fictional, generated with StyleGAN2 or DALL-E 3.
- [SadTalker, CVPR 2023](https://sadtalker.github.io/). The authors generate talking-face animation from a still image and speech audio. These downloads correspond to the page's multilingual talking and Chinese speaking demos. The website footer states CC BY-SA 4.0; this does not independently establish rights in every underlying portrait or audio recording.

For Signal Check, label these as **generated video**. The source pages do not establish whether each speech track is recorded or AI-generated, so use **unknown** for audio authenticity. An audio detector returning low risk is not necessarily a failure on these clips.

These are demonstration samples, not a balanced evaluation dataset. No model accuracy was measured. This folder does not grant additional redistribution or commercial-use rights; retain source attribution and consult the original terms for those uses.

## Verification

All four MP4 files contain H.264 video and AAC audio. Both streams were decoded in full using FFmpeg with error detection enabled, and representative frames were inspected. Duration and stream metadata were checked with ffprobe.
