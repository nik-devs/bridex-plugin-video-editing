#!/usr/bin/env python3
"""words.json / phrases.json -> a styled .ass file for one libass burn.

The builder is ass_captions.py from github.com/nik-devs/ffmpeg-caption-burn-ass
(MIT, see LICENSE-ffmpeg-caption-burn-ass); this wrapper only takes the canvas
size and the font folders from the plugin instead of probing the video itself.

  python3 captions.py --mode phrases --phrases p.json --size 1080x1920 \
      --style '{"font":"Montserrat ExtraBold"}' --fonts-dir /fonts --out captions.ass
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ass_captions import build_ass  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--words", help="[{word,start,end}] for karaoke-highlight / word-carousel")
    ap.add_argument("--phrases", help="[{text,start,end}] for phrases")
    ap.add_argument("--mode", required=True, choices=["karaoke-highlight", "word-carousel", "phrases"])
    ap.add_argument("--style", default="{}")
    ap.add_argument("--size", required=True, help="WxH of the video")
    ap.add_argument("--fonts-dir", action="append", default=[])
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    w, h = (int(x) for x in a.size.lower().split("x"))
    words = json.load(open(a.words)) if a.words else None
    phrases = json.load(open(a.phrases)) if a.phrases else None
    ass = build_ass(words, a.mode, json.loads(a.style), phrases=phrases, video_size=(w, h), font_dirs=a.fonts_dir)
    with open(a.out, "w") as f:
        f.write(ass)
    print(ass.count("\nDialogue:"))


if __name__ == "__main__":
    main()
