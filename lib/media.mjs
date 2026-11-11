import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// siblings load with this file's own ?v= (the host's reload mark): a plain import would keep the previous version cached until a restart
const { run, tail } = await import(`./util.mjs${new URL(import.meta.url).search}`);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPTIONS_PY = path.join(HERE, "..", "py", "captions.py");
const LABEL_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

/** ffprobe of one file, boiled down to what editing decisions need. */
export async function probe(abs) {
  const r = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", abs], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`ffprobe could not read ${path.basename(abs)}: ${tail(r.err, 5)}`);
  const j = JSON.parse(r.out);
  const v = (j.streams ?? []).find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const a = (j.streams ?? []).find((s) => s.codec_type === "audio");
  const rate = (s) => {
    const [n, d] = String(s ?? "0/1").split("/").map(Number);
    return d ? Math.round((n / d) * 100) / 100 : n;
  };
  // a phone shoots sideways and stores the turn: what is shown is the rotated size
  const rot = Math.abs(Number(v?.side_data_list?.find((x) => x.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0)) % 180;
  const transfer = v?.color_transfer ?? null;
  return {
    duration: Number(j.format?.duration ?? v?.duration ?? 0),
    size_mb: Math.round((Number(j.format?.size ?? 0) / 1048576) * 10) / 10,
    ...(v
      ? {
          video: {
            codec: v.codec_name,
            width: rot === 90 ? v.height : v.width,
            height: rot === 90 ? v.width : v.height,
            fps: rate(v.avg_frame_rate || v.r_frame_rate),
            hdr: transfer === "smpte2084" || transfer === "arib-std-b67",
            color: [v.color_primaries, transfer, v.pix_fmt].filter(Boolean).join(" / "),
            bitrate_kbps: v.bit_rate ? Math.round(Number(v.bit_rate) / 1000) : undefined,
          },
        }
      : {}),
    ...(a ? { audio: { codec: a.codec_name, channels: a.channels, sample_rate: Number(a.sample_rate) } } : { audio: null }),
  };
}

/** HDR (PQ / HLG, iPhone footage) to SDR BT.709 — without it the picture comes out grey and flat. */
export const TONEMAP = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";

/** A light copy with the source time burned in large: what video_understand should watch to name exact moments. */
export async function proxy(abs, outFile, label) {
  const info = await probe(abs);
  const pre = info.video?.hdr ? `${TONEMAP},` : "";
  const lbl = path.join(path.dirname(outFile), `.label-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(lbl, String(label).slice(0, 60));
  const vf = [
    `${pre}scale=-2:720`,
    `drawtext=fontfile=${LABEL_FONT}:text='%{pts\\:flt}':x=24:y=24:fontsize=54:fontcolor=yellow:box=1:boxcolor=black@0.6:boxborderw=10`,
    `drawtext=fontfile=${LABEL_FONT}:textfile=${lbl}:x=24:y=h-th-24:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=8`,
  ].join(",");
  const r = await run("ffmpeg", ["-y", "-v", "error", "-i", abs, "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", outFile], { timeoutMs: 1_800_000 });
  fs.rmSync(lbl, { force: true });
  if (r.code !== 0) throw new Error(`proxy failed: ${tail(r.err)}`);
}

/** One picture of the whole clip: a frame every `every` seconds with its time, for artifact_read. */
export async function sheet(abs, outFile, every = 1) {
  const info = await probe(abs);
  const n = Math.max(1, Math.ceil(info.duration / every));
  const cols = n <= 12 ? 4 : 6;
  const rows = Math.ceil(n / cols);
  const pre = info.video?.hdr ? `${TONEMAP},` : "";
  const vf = `${pre}fps=1/${every},scale=320:-2,drawtext=fontfile=${LABEL_FONT}:text='%{pts\\:flt}':x=8:y=8:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.6:boxborderw=4,tile=${cols}x${rows}:padding=4:color=black`;
  const r = await run("ffmpeg", ["-y", "-v", "error", "-i", abs, "-vf", vf, "-frames:v", "1", outFile], { timeoutMs: 900_000 });
  if (r.code !== 0) throw new Error(`contact sheet failed: ${tail(r.err)}`);
  return { frames: n, every };
}

/**
 * Re-encode for where the video goes. instagram: 1080 wide H.264 high
 * quality (Instagram re-encodes anyway, so it gets the best input); telegram:
 * two-pass to fit `maxMb` (bots upload up to 50 MB through the Bot API, up to
 * 2 GB through a local Bot API server); preview: light, for video_understand;
 * master: near-lossless archive copy.
 */
export async function encode(abs, outFile, target, maxMb) {
  const info = await probe(abs);
  const pre = info.video?.hdr ? `${TONEMAP},` : "";
  const audio = info.audio ? ["-c:a", "aac", "-b:a", target === "preview" ? "96k" : "192k", "-ar", "48000"] : ["-an"];
  const tags = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-movflags", "+faststart"];
  const scale = (w) => `${pre}scale='min(${w},iw)':-2:flags=lanczos,format=yuv420p`;
  let r;
  if (target === "telegram") {
    const cap = Number(maxMb ?? 48);
    const kbps = Math.floor(((cap * 8 * 1024 * 1024) / Math.max(1, info.duration) / 1000) * 0.96 - (info.audio ? 192 : 0));
    if (kbps < 300) throw new Error(`${info.duration.toFixed(0)} s cannot fit ${cap} MB at a watchable bitrate — send a link instead (file_link) or raise max_mb`);
    const v = Math.min(kbps, 16000);
    const log = path.join(path.dirname(outFile), `.2pass-${process.pid}-${Date.now()}`);
    const common = ["-vf", scale(1080), "-c:v", "libx264", "-preset", "slow", "-b:v", `${v}k`, "-maxrate", `${Math.round(v * 1.5)}k`, "-bufsize", `${v * 2}k`, "-pix_fmt", "yuv420p", "-passlogfile", log];
    r = await run("ffmpeg", ["-y", "-v", "error", "-i", abs, ...common, "-pass", "1", "-an", "-f", "null", "/dev/null"], { timeoutMs: 3_600_000 });
    if (r.code === 0) r = await run("ffmpeg", ["-y", "-v", "error", "-i", abs, ...common, "-pass", "2", ...audio, ...tags, outFile], { timeoutMs: 3_600_000 });
    for (const f of fs.readdirSync(path.dirname(outFile))) if (f.startsWith(path.basename(log))) fs.rmSync(path.join(path.dirname(outFile), f), { force: true });
  } else {
    const preset = {
      instagram: ["-vf", scale(1080), "-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", "17", "-maxrate", "16M", "-bufsize", "32M"],
      preview: ["-vf", scale(540), "-c:v", "libx264", "-preset", "veryfast", "-crf", "30"],
      master: ["-vf", `${pre}format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "13"],
    }[target];
    if (!preset) throw new Error(`unknown target ${target}`);
    r = await run("ffmpeg", ["-y", "-v", "error", "-i", abs, ...preset, "-pix_fmt", "yuv420p", ...audio, ...tags, outFile], { timeoutMs: 3_600_000 });
  }
  if (r.code !== 0) throw new Error(`encode failed: ${tail(r.err)}`);
  const out = await probe(outFile);
  return { duration: out.duration, size_mb: out.size_mb, width: out.video?.width, height: out.video?.height };
}

/**
 * Word timings from any transcript this instance makes: ElevenLabs Scribe
 * (words[].text, type «word»), OpenRouter / Whisper verbose_json
 * (words[].word), a HyperFrames transcript.json, or a plain [{word|text,start,end}].
 */
export function wordsFrom(transcript) {
  const list = Array.isArray(transcript) ? transcript : (transcript?.words ?? transcript?.segments?.flatMap((s) => s.words ?? []) ?? []);
  return list
    .filter((w) => !w.type || w.type === "word")
    .map((w) => ({ word: String(w.word ?? w.text ?? "").trim(), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.word && Number.isFinite(w.start) && Number.isFinite(w.end));
}

/** Captions into the picture in one libass pass: no browser, encode speed. */
export async function burnCaptions({ video, mode, words, phrases, style, fontsDir, outFile }) {
  const info = await probe(video);
  if (!info.video) throw new Error("this file has no video stream");
  const work = fs.mkdtempSync(path.join(path.dirname(outFile), ".captions-"));
  try {
    const args = [CAPTIONS_PY, "--mode", mode, "--size", `${info.video.width}x${info.video.height}`, "--style", JSON.stringify(style ?? {}), "--out", path.join(work, "captions.ass")];
    if (mode === "phrases") {
      fs.writeFileSync(path.join(work, "phrases.json"), JSON.stringify(phrases));
      args.push("--phrases", path.join(work, "phrases.json"));
    } else {
      fs.writeFileSync(path.join(work, "words.json"), JSON.stringify(words));
      args.push("--words", path.join(work, "words.json"));
    }
    if (fontsDir) args.push("--fonts-dir", fontsDir);
    const b = await run("python3", args, { timeoutMs: 120_000 });
    if (b.code !== 0) throw new Error(`caption builder failed: ${tail(b.err)}`);
    const pre = info.video.hdr ? `${TONEMAP},` : "";
    const vf = `${pre}subtitles=filename=${path.join(work, "captions.ass")}${fontsDir ? `:fontsdir=${fontsDir}` : ""}`;
    const r = await run("ffmpeg", ["-y", "-v", "error", "-i", video, "-vf", vf, "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", outFile], { timeoutMs: 3_600_000 });
    if (r.code !== 0) throw new Error(`burn failed: ${tail(r.err)}`);
    fs.copyFileSync(path.join(work, "captions.ass"), outFile.replace(/\.[^.]+$/, ".ass"));
    return { events: Number(b.out.trim()) || 0, duration: info.duration };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * yt-dlp as its official single-file build, kept in the plugin's state and
 * refreshed every two weeks (site extractors break often). It runs on the
 * image's python3 — nothing is installed system-wide.
 */
export function makeFetcher(stateDir, log) {
  const bin = path.join(stateDir, "bin", "yt-dlp");
  async function ensure() {
    const fresh = fs.existsSync(bin) && Date.now() - fs.statSync(bin).mtimeMs < 14 * 86_400_000;
    if (fresh) return bin;
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    const res = await fetch("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp", { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
      if (fs.existsSync(bin)) return bin;
      throw new Error(`could not get yt-dlp: ${res.status}`);
    }
    fs.writeFileSync(`${bin}.new`, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
    fs.renameSync(`${bin}.new`, bin);
    log?.info?.("yt-dlp updated");
    return bin;
  }
  /** One public video by its page URL into `dir`; returns the file and what the page says about it. */
  async function get(url, dir) {
    const exe = await ensure();
    fs.mkdirSync(dir, { recursive: true });
    const r = await run(
      "python3",
      [exe, "--no-warnings", "--no-playlist", "--no-progress", "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b", "--merge-output-format", "mp4", "--write-info-json", "-o", path.join(dir, "%(extractor)s-%(id)s.%(ext)s"), "--print", "after_move:filepath", url],
      { timeoutMs: 900_000 },
    );
    if (r.code !== 0) {
      const why = tail(r.err, 6);
      const login = /login|cookies|rate-limit|private|not available/i.test(why);
      throw new Error(`${login ? "the site wants a login for this one — ask the person to send the video file itself" : "download failed"}: ${why}`);
    }
    const file = r.out.trim().split("\n").filter(Boolean).pop();
    const infoFile = file.replace(/\.[^.]+$/, ".info.json");
    let meta = {};
    try {
      const j = JSON.parse(fs.readFileSync(infoFile, "utf8"));
      meta = { title: j.title, uploader: j.uploader ?? j.channel, duration: j.duration, description: String(j.description ?? "").slice(0, 600), music: j.track ? `${j.artist ?? ""} — ${j.track}` : undefined, url: j.webpage_url ?? url };
    } catch {
      // no metadata, the video is what matters
    }
    fs.rmSync(infoFile, { force: true });
    return { file, meta };
  }
  return { get };
}
