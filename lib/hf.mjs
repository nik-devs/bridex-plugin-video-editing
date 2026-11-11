import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// siblings load with this file's own ?v= (the host's reload mark): a plain import would keep the previous version cached until a restart
const { run, tail } = await import(`./util.mjs${new URL(import.meta.url).search}`);

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HF_BIN = path.join(HERE, "..", "node_modules", "hyperframes", "bin", "hyperframes.mjs");

/** The Chrome build this HyperFrames pins (its CHROME_VERSION), read from its own code. */
function pinnedChrome() {
  const dist = path.join(HERE, "..", "node_modules", "hyperframes", "dist");
  try {
    for (const f of fs.readdirSync(dist)) {
      if (!f.endsWith(".js")) continue;
      const m = /var CHROME_VERSION = "(\d+\.\d+\.\d+\.\d+)"/.exec(fs.readFileSync(path.join(dist, f), "utf8"));
      if (m) return m[1];
    }
  } catch {
    // no dist: let the resolver pick the stable build
  }
  return null;
}

/**
 * HyperFrames commands an agent may run as they are. Everything that makes or
 * checks a composition is open; what stays out: commands that run a model on
 * this server (transcribe, tts, remove-background, models — the APIs do that
 * work: eleven_transcribe / openrouter_run, eleven_speak, fal), sending work to
 * HeyGen or a cloud (cloud, lambda, cloudrun, publish, share, billing), and
 * interactive or self-updating ones (preview, open, present, upgrade, update,
 * skills — video_setup installs the skills).
 */
export const HF_OPEN = [
  "add", "catalog", "capture", "lint", "check", "validate", "snapshot", "inspect", "keyframes", "media-treatment",
  "normalize-audio", "grade-compare", "compare", "diff", "measure", "beats", "audio", "timeline", "compositions",
  "info", "docs", "history", "doctor",
];
export const HF_CLOSED = {
  transcribe: "word timings come from an API here: eleven_transcribe (ElevenLabs Scribe) or openrouter_run with a transcription model — write the words into the project as transcript.json yourself",
  tts: "voices come from an API here: eleven_speak (ElevenLabs) or openrouter_run with a speech model",
  "remove-background": "cut-outs come from an API here: the fal.ai plugin (fal_run fal-ai/birefnet/v2, video: fal-ai/birefnet/v2/video); overlay the transparent result in the composition",
  models: "on-device models are not run on this server — use the APIs (eleven_transcribe, openrouter_run, fal)",
  cloud: "renders run on this server (video_render)",
  lambda: "renders run on this server (video_render)",
  cloudrun: "renders run on this server (video_render)",
  publish: "deliver the rendered file instead (video_render → artifacts, then the message tool or file_link)",
  share: "deliver the rendered file instead (video_render → artifacts, then the message tool or file_link)",
  billing: "not available here",
  preview: "no live preview on the server — look with video_hf snapshot / compare, or render a draft",
  open: "no desktop app on the server — use video_hf snapshot or a draft render",
  present: "not available here",
  upgrade: "the plugin pins its HyperFrames version; updates come with the plugin",
  update: "the plugin pins its HyperFrames version; updates come with the plugin",
  skills: "use video_setup — it installs the HyperFrames skills into your own HOME",
  render: "use video_render — it renders in the background, wakes you when done and saves the file into artifacts",
  init: "use video_new — it scaffolds the project in your working directory (any HyperFrames example too)",
  benchmark: "not needed here — render a draft with video_render quality draft",
  "catch-up": "not available here",
  clean: "the plugin keeps its own caches tidy; delete project files yourself",
  reverse: "not available here (HyperFrames Pro)",
  templates: "not available here (HyperFrames Pro)",
};
/** Flags that would download an on-device model. */
const MODEL_FLAGS = /^--(on-device|model)(=|$)/;

export function makeHf(stateDir, log) {
  const home = path.join(stateDir, "hf-home");
  fs.mkdirSync(home, { recursive: true });
  const env = (extra = {}) => ({
    ...process.env,
    // the CLI's caches (browser download, frame cache) live with the plugin's state, not the server's HOME
    HOME: home,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    HYPERFRAMES_NO_TELEMETRY: "1",
    HYPERFRAMES_NO_UPDATE_CHECK: "1",
    HYPERFRAMES_SKIP_SKILLS: "1",
    DO_NOT_TRACK: "1",
    ...(browserPath ? { HYPERFRAMES_BROWSER_PATH: browserPath } : {}),
    ...extra,
  });
  const hf = (args, opts = {}) => run(process.execPath, [HF_BIN, ...args], { timeoutMs: 600_000, ...opts, env: env(opts.env) });

  let browser = null;
  let browserPath = null;
  /**
   * chrome-headless-shell for renders, the build HyperFrames pins, downloaded
   * once into the plugin's state. HyperFrames itself settles for any system
   * Chrome it finds (the image's Chromium), which captures by screenshots —
   * several times slower than the shell's BeginFrame capture. Where no shell
   * build exists (Linux ARM), its own choice stands.
   */
  function ensureBrowser() {
    browser ??= (async () => {
      try {
        const pb = await import("@puppeteer/browsers");
        const platform = pb.detectBrowserPlatform();
        const buildId = pinnedChrome() ?? (await pb.resolveBuildId(pb.Browser.CHROMEHEADLESSSHELL, platform, "stable"));
        const cacheDir = path.join(home, ".cache", "hyperframes", "chrome");
        const got = await pb.install({ browser: pb.Browser.CHROMEHEADLESSSHELL, buildId, cacheDir, platform });
        const v = await run(got.executablePath, ["--version"], { timeoutMs: 30_000 });
        if (v.code !== 0) throw new Error(`the shell does not start: ${tail(v.err || v.out, 5)}`);
        browserPath = got.executablePath;
        log?.info?.(`HyperFrames browser ready: chrome-headless-shell ${buildId}`);
        return browserPath;
      } catch (err) {
        log?.warn?.(`chrome-headless-shell unavailable (${err.message}) — HyperFrames picks its own browser`);
      }
      const r = await hf(["browser", "ensure"], { timeoutMs: 900_000 });
      if (r.code !== 0) {
        browser = null;
        throw new Error(`HyperFrames could not get its browser: ${tail(r.err || r.out, 12)}`);
      }
      const p = await hf(["browser", "path"], { timeoutMs: 60_000 });
      const at = p.out.trim().split("\n").pop();
      log?.info?.(`HyperFrames browser ready: ${at}`);
      return at;
    })();
    return browser;
  }

  function check(command, args) {
    if (HF_CLOSED[command]) throw new Error(`hyperframes ${command} is not run here: ${HF_CLOSED[command]}`);
    if (!HF_OPEN.includes(command)) throw new Error(`unknown or closed HyperFrames command «${command}» — open ones: ${HF_OPEN.join(", ")}`);
    const bad = args.find((a) => MODEL_FLAGS.test(a));
    if (bad) throw new Error(`${bad}: on-device models are not run on this server — search the catalog by name instead`);
  }

  return { hf, env, ensureBrowser, check, home };
}
