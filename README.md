# bridex-plugin-video-editing

Video editing for Bridex agents. The editor is [HyperFrames](https://hyperframes.heygen.com)
(Apache-2.0): a video is an HTML/CSS composition with a GSAP timeline — clips, captions,
titles, transitions, music — rendered to MP4 / MOV / WebM in headless Chrome, with its own
checks, snapshots and measurements and a catalog of 448 ready blocks (caption styles,
shader transitions, kinetic typography, overlays). Next to it: a one-pass libass caption
burn, any font, reference downloads, source inspection and delivery encodes.

The plugin gives possibilities, not a fixed menu: every project is plain files the agent
edits as it likes, every open HyperFrames command runs as is, any font can be added.
Model work stays with the APIs — transcripts (ElevenLabs Scribe, OpenRouter), voices,
cut-outs (fal): the HyperFrames commands that would run models on the server are closed.

## Tools

| Tool | What |
|---|---|
| `video_new` | a project in the agent's working directory: `reel` from an edit list (shots, captions, hook, music, cut styles), `captions` (animated word captions from a transcript), `title` (transparent title card), or any HyperFrames example |
| `video_hf` | a HyperFrames command as is: `check`, `snapshot`, `compare`, `catalog`, `add`, `measure`, `beats`, `audio`, `media-treatment`, `grade-compare`, `docs`… |
| `video_render` | render to artifacts; long renders go on in the background and wake the agent |
| `video_captions` | burn captions into a finished video in one ffmpeg pass (libass): karaoke-highlight, word-carousel, phrases on plates |
| `video_fonts` | add any font (Google Fonts by name — static weights with Cyrillic — a URL or a file), check glyph coverage, a board of candidates, write fonts into a project |
| `video_inspect` | what a source is (rotation, HDR, fps), a timecode proxy for `video_understand`, a contact sheet |
| `video_encode` | delivery encodes: Instagram, Telegram (fits a size cap), preview, master |
| `video_fetch` | a public video by its page link (Instagram, TikTok, YouTube…) into `artifacts/refs/` |
| `video_setup` | the official HyperFrames and GSAP skills into the agent's own HOME |

## Install

From the Bridex plugin catalog (Settings → Plugins → Catalog). The install runs
`npm install` (HyperFrames, fontkit); the render browser (chrome-headless-shell) and
yt-dlp are fetched on first use into `$BRIDEX_HOME/state/video-editing/`, together with
the font store.

Nothing to set up: renders at once follow the machine's cores (two from 16 up), and
HyperFrames sizes its Chrome workers by CPU and memory — on a small server it drops to
one worker and screenshot capture by itself.

## Credits

`py/ass_captions.py` is [ffmpeg-caption-burn-ass](https://github.com/nik-devs/ffmpeg-caption-burn-ass)
(MIT). HyperFrames is by HeyGen (Apache-2.0); yt-dlp is the yt-dlp project's (Unlicense).

MIT.
