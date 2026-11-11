import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";

// the host reloads this file with ?v=<commit>: its modules come with the same mark, or an
// update would run the new index over the previous version's cached modules until a restart
const v = new URL(import.meta.url).search;
const { children, json, killGroup, makeJail, newFiles, slug, tail, text } = await import(`./lib/util.mjs${v}`);
const { makeFontStore } = await import(`./lib/fonts.mjs${v}`);
const { HF_OPEN, makeHf } = await import(`./lib/hf.mjs${v}`);
const { burnCaptions, encode, makeFetcher, probe, proxy, sheet, wordsFrom } = await import(`./lib/media.mjs${v}`);
const { buildCaptions, buildReel, buildTitle, fontsOf, projectReadme, projectSlug } = await import(`./lib/templates.mjs${v}`);

/**
 * Video editing for agents. HyperFrames is the editor: a video is an HTML/CSS
 * composition with a GSAP timeline — clips, captions, titles, transitions,
 * music — rendered to MP4/MOV/WebM in headless Chrome, with 448 ready-made
 * blocks (caption styles, shader transitions, typography, overlays) and its
 * own checks, snapshots and measurements. Next to it: a fast libass caption
 * burn (one ffmpeg pass), any font, reference downloads, source inspection and
 * delivery encodes. Agents get possibilities, not a fixed menu: every project
 * is plain files they may edit, and their own ffmpeg stays theirs.
 *
 * Model work stays with the APIs (transcripts, voices, cut-outs) — the
 * HyperFrames commands that would run models on this server are closed.
 */

const require = createRequire(import.meta.url);
const HF_VERSION = (() => {
  try {
    return require("hyperframes/package.json").version;
  } catch {
    return "unknown";
  }
})();

export default async function activate(ctx) {
  // nothing to set up: one render takes every core it is given, so a second one at the same
  // time only halves both — big machines get two. Chrome workers are HyperFrames' call (it
  // sizes them by CPU and memory, and drops to a safe single-worker profile on small servers)
  const cfg = { parallel_renders: Math.max(1, Math.min(4, Math.floor(os.cpus().length / 8))), ...(ctx.config ?? {}) };
  const state = path.join(ctx.paths.state, "video-editing");
  fs.mkdirSync(state, { recursive: true });
  const jail = makeJail(ctx);
  const fonts = makeFontStore(state, ctx.log);
  const hfApi = makeHf(state, ctx.log);
  const fetcher = makeFetcher(state, ctx.log);
  const z = ctx.z;

  // the browser comes down once, in the background, before the first render needs it
  hfApi.ensureBrowser().catch((err) => ctx.log.warn(`HyperFrames browser not ready yet: ${err.message}`));
  ctx.onShutdown?.(() => {
    for (const c of children) killGroup(c);
  });
  ctx.registerCheck?.(async () => {
    try {
      const at = await hfApi.ensureBrowser();
      return { ok: true, message: `HyperFrames ${HF_VERSION}, browser at ${at}` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  /** A project directory inside the workspace: video/<name> in the working directory unless a path is given. */
  const projectAt = (call, p, { mustExist = true } = {}) => {
    const s = String(p ?? "").trim();
    const abs = s.includes("/") || s.startsWith(".") ? jail.resolve(call.workspace, s, { mustExist }) : jail.resolve(call.workspace, path.join("video", projectSlug(s)), { mustExist });
    if (mustExist && !fs.existsSync(path.join(abs, "index.html"))) throw new Error(`${s} has no index.html — create the project with video_new`);
    return abs;
  };
  const outDir = (call) => {
    const d = path.join(jail.roots(call.workspace).work, "video", ".out");
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  // ---------------------------------------------------------------- projects

  ctx.registerTool({
    name: "video_new",
    description:
      "Start a video project (HyperFrames: HTML/CSS + GSAP timeline, rendered to MP4) in your working directory, ready to edit and render.\n" +
      "• template reel — a vertical reel from an edit list: shots in order (src, in, duration, focus, zoom, audio, caption, transition cut|flash|zoom|whip|fade), captions style (plate|outline|tiktok|editorial|none, font, weight, size, color, plate, position, uppercase, css), opening hook, music. Rebuild any time with the same name.\n" +
      "• template captions — animated word-by-word captions over one video from its transcript (words with start/end from eleven_transcribe / openrouter_run).\n" +
      "• template title — a title card on a transparent background (render it to mov or webm and lay it over footage).\n" +
      "• any HyperFrames example by name (blank, warm-grain, swiss-grid…).\n" +
      "Everything it writes is plain files: open index.html and change anything. Blocks from the catalog (caption styles, shader transitions, typography) go in with video_hf add.",
    schema: {
      name: z.string().min(1).max(60).describe("project folder name (under video/ in your working directory) or a path"),
      template: z.string().optional().describe("reel (default), captions, title, or a HyperFrames example name"),
      edit: z.record(z.string(), z.unknown()).optional().describe("reel: {width?, height?, clips:[{src, in?, duration, focus?, zoom?, audio?, volume?, caption?, transition?}], captions?:{…}, hook?:{text, duration?, font?, size?, italic?}, music?:{src, in?, volume?, fade_out?}, transition?, fonts?:[]}; captions: {video, transcript (path) | words, style?}; title: {text, sub?, duration?, font?, size?, color?}"),
      fonts: z.array(z.string()).optional().describe("font families from video_fonts to write into the project's fonts/fonts.css"),
      overwrite: z.boolean().optional().describe("rebuild index.html of an existing project (media and your other files stay)"),
    },
    handler: async (args, call) => {
      const dir = projectAt(call, args.name, { mustExist: false });
      const exists = fs.existsSync(path.join(dir, "index.html"));
      if (exists && !args.overwrite) return text(`error: ${jail.show(call.workspace, dir)} already exists — pass overwrite: true to rebuild it from the edit list`);
      const template = String(args.template ?? "reel");
      const edit = args.edit ?? {};
      const media = (p) => jail.resolve(call.workspace, p);
      fs.mkdirSync(dir, { recursive: true });
      let made;
      if (template === "reel") made = buildReel(edit, dir, media);
      else if (template === "captions") {
        const raw = edit.words ?? (edit.transcript ? JSON.parse(fs.readFileSync(media(edit.transcript), "utf8")) : null);
        const words = wordsFrom(raw ?? []);
        if (!words.length) throw new Error("captions template: pass edit.transcript (a transcript .json path) or edit.words [{word,start,end}]");
        const src = media(edit.video);
        const info = await probe(src);
        made = buildCaptions({ ...edit, words, width: info.video?.width ?? 1080, height: info.video?.height ?? 1920, duration: info.duration }, dir, media);
      } else if (template === "title") {
        if (!edit.text) throw new Error("title template: pass edit.text");
        made = buildTitle(edit, dir);
      } else {
        const r = await hfApi.hf(["init", dir, "--example", template, "--non-interactive", "--skip-transcribe", "--skip-skills", "--resolution", String(edit.resolution ?? "portrait")], { cwd: path.dirname(dir), timeoutMs: 300_000 });
        if (r.code !== 0) throw new Error(`hyperframes init failed: ${tail(r.err || r.out)}`);
        made = { example: template };
      }
      const families = [...new Set([...(args.fonts ?? []), ...fontsOf(edit)])];
      const css = fonts.cssFor(families, path.join(dir, "fonts"));
      fs.writeFileSync(path.join(dir, "fonts", "fonts.css"), css.css + "\n");
      if (!fs.existsSync(path.join(dir, "README.md"))) fs.writeFileSync(path.join(dir, "README.md"), projectReadme(template));
      return json({
        project: jail.show(call.workspace, dir),
        template,
        ...made,
        fonts: families.filter((f) => !css.missing.includes(f)),
        ...(css.missing.length ? { fonts_missing: css.missing, hint_fonts: "add them first: video_fonts add (google: «Family»), then video_new again with overwrite or video_fonts use" } : {}),
        next: "look: video_hf snapshot (args [\"--at\",\"0.5,3,8\"]) and check → render a draft: video_render quality draft → fix → video_render quality delivery",
      });
    },
  });

  ctx.registerTool({
    name: "video_hf",
    description:
      "Run a HyperFrames command in a project — the editor's own toolbox, as is. Free.\n" +
      "• check / lint / validate — mistakes before a render; snapshot — PNG frames at given seconds (look at them before rendering); compare — variants on one labelled sheet (show the person options); timeline / compositions / info / history.\n" +
      "• catalog (--tag captions|transition|typography|overlay|social…, or a word) and add <name> — 448 ready blocks: caption styles, shader transitions, kinetic type, lower thirds, counters; add prints the snippet to paste.\n" +
      "• measure probe|cuts|events|frames|look|ink|face — take apart a reference or a source (cut rhythm, shot lengths, text size and position, colour look); beats — beat times of the music; audio — onsets and loudness; media-treatment / grade-compare — colour treatments; normalize-audio; keyframes; inspect; diff; docs <topic>.\n" +
      "Closed here: render (video_render), init (video_new), skills (video_setup), and anything that runs a model on this server or sends the project elsewhere.",
    schema: {
      command: z.string().describe(`one of: ${HF_OPEN.join(", ")}`),
      args: z.array(z.string()).max(40).optional().describe("the command's arguments as separate items, e.g. [\"--at\",\"1,3,5\"] or [\"cuts\",\"artifacts/refs/x.mp4\"]"),
      project: z.string().optional().describe("project name or path (omit for catalog, docs, measure on a file)"),
    },
    handler: async (args, call) => {
      const command = String(args.command).trim();
      const raw = (args.args ?? []).map(String);
      hfApi.check(command, raw);
      const cwd = args.project ? projectAt(call, args.project) : jail.roots(call.workspace).work;
      fs.mkdirSync(cwd, { recursive: true });
      // a file argument stays inside the workspace; «artifacts/…» means the workspace's artifacts
      const argv = raw.map((a) => {
        if (a.startsWith("-") || !(a.includes("/") || /\.[a-z0-9]{2,5}$/i.test(a))) return a;
        try {
          return jail.resolve(call.workspace, a, { mustExist: false, base: cwd });
        } catch (err) {
          throw new Error(`${a}: ${err.message}`);
        }
      });
      if (command === "add" && !argv.some((a) => a.startsWith("--dir"))) argv.push("--dir", cwd, "--no-clipboard");
      const started = Date.now();
      const r = await hfApi.hf([command, ...argv], { cwd, timeoutMs: 1_200_000 });
      const out = (r.out || "").trim();
      const files = newFiles(cwd, started).map((f) => jail.show(call.workspace, f));
      return json({
        ok: r.code === 0,
        ...(out ? { output: out.length > 30_000 ? `${out.slice(0, 30_000)}\n…(cut)` : out } : {}),
        ...(r.code !== 0 ? { error: tail(r.err || r.out, 30) } : {}),
        ...(files.length ? { files } : {}),
      });
    },
  });

  // ------------------------------------------------------------------ render

  const jobs = new Map();
  let active = 0;
  const waiting = [];
  const acquire = () =>
    new Promise((resolve) => {
      if (active < Number(cfg.parallel_renders || 1)) {
        active++;
        resolve();
      } else waiting.push(resolve);
    });
  const release = () => {
    active--;
    const next = waiting.shift();
    if (next) {
      active++;
      next();
    }
  };

  // a render that was under way when the server stopped is gone with it: say so, once
  for (const j of ctx.jobs?.pending?.() ?? []) {
    ctx.jobs.settle(j.id, { status: "failed", error: "the server restarted during the render" });
    ctx.wakeAgent?.({
      workspace: j.workspace,
      agent: j.agent,
      key: `video-render:${j.externalId}`,
      ...(j.sessionKey ? { sessionKey: j.sessionKey } : {}),
      prompt: `Your video render ${j.externalId} (${j.label || j.model}) was cut off by a server restart. Run video_render again with the same settings.`,
    });
  }

  ctx.registerTool({
    name: "video_render",
    description:
      "Render a project to a video file in this task's artifacts (HyperFrames in headless Chrome on this server). Free, but it takes CPU time: draft quality first to check, then delivery. Waits up to wait_s; a longer render goes on in the background and you are WOKEN when the file lands — end your turn then. With job_id: the state of an earlier render.\n" +
      "format mp4 (default), mov or webm keep transparency (for overlays), gif, png-sequence. Size and quality: crf or video_bitrate/max_bitrate; for a hard size cap (Telegram) pass the result through video_encode.",
    schema: {
      project: z.string().optional().describe("project name or path"),
      job_id: z.string().optional().describe("an earlier render's id: its state or result"),
      composition: z.string().optional().describe("a composition file inside the project instead of index.html"),
      name: z.string().max(60).optional().describe("output file name without extension"),
      format: z.enum(["mp4", "webm", "mov", "gif", "png-sequence"]).optional(),
      quality: z.enum(["draft", "looks", "delivery", "standard", "high"]).optional().describe("draft for checks; delivery for the file that goes out (default looks)"),
      fps: z.string().optional(),
      resolution: z.string().optional().describe("portrait, landscape, square, portrait-4k…"),
      crf: z.number().int().min(0).max(51).optional(),
      video_bitrate: z.string().optional().describe("e.g. 10M"),
      max_bitrate: z.string().optional(),
      variables: z.record(z.string(), z.unknown()).optional().describe("values for the composition's declared variables"),
      start: z.number().optional().describe("render from this second"),
      end: z.number().optional().describe("render up to this second"),
      dynamic_range: z.enum(["auto", "sdr", "hdr"]).optional().describe("auto follows the sources; sdr forces BT.709 (what phones and Telegram show right)"),
      wait_s: z.number().int().min(0).max(1500).optional().describe("how long to wait for the file (default 240)"),
      note: z.string().max(200).optional().describe("what this render is for (stored on the file)"),
    },
    handler: async (args, call) => {
      if (args.job_id) {
        const j = jobs.get(String(args.job_id));
        if (j?.result) return json(j.result);
        if (j?.error) return json({ job_id: j.id, status: "failed", error: j.error });
        if (j) return json({ job_id: j.id, status: "rendering", seconds: Math.round((Date.now() - j.startedAt) / 1000) });
        const stored = ctx.jobs?.find?.(String(args.job_id));
        if (stored) return json({ job_id: args.job_id, status: stored.status, ...(stored.result ? { result: stored.result } : {}), ...(stored.error ? { error: stored.error } : {}) });
        return text(`error: no render ${args.job_id} here`);
      }
      if (!args.project) return text("error: pass project (or job_id for an earlier render)");
      const dir = projectAt(call, args.project);
      const format = String(args.format ?? "mp4");
      const ext = format === "png-sequence" ? "" : `.${format}`;
      const name = slug(args.name ?? `${path.basename(dir)}-${format === "mp4" ? "" : `${format}-`}${crypto.randomBytes(3).toString("hex")}`.replace(/--/g, "-"));
      const out = path.join(outDir(call), `${name}${ext}`);
      const flags = ["--format", format, "--quality", String(args.quality ?? "looks"), ...(cfg.workers ? ["--workers", String(cfg.workers)] : [])];
      if (args.composition) flags.push("-c", String(args.composition));
      if (args.fps) flags.push("--fps", String(args.fps));
      if (args.resolution) flags.push("--resolution", String(args.resolution));
      if (args.crf !== undefined) flags.push("--crf", String(args.crf));
      if (args.video_bitrate) flags.push("--video-bitrate", String(args.video_bitrate));
      if (args.max_bitrate) flags.push("--max-bitrate", String(args.max_bitrate));
      if (args.variables) flags.push("--variables", JSON.stringify(args.variables));
      if (args.start !== undefined) flags.push("--start", String(args.start));
      if (args.end !== undefined) flags.push("--end", String(args.end));
      if (args.dynamic_range === "sdr") flags.push("--sdr");
      if (args.dynamic_range === "hdr") flags.push("--hdr");
      const id = `vr-${crypto.randomBytes(5).toString("hex")}`;
      const note = String(args.note ?? `${path.basename(dir)} · ${args.quality ?? "looks"}`);
      const tracked = ctx.jobs?.track?.({ workspace: call.workspace, agent: call.agent, taskId: call.taskId, sessionKey: call.sessionKey, runId: call.runId, externalId: id, model: `hyperframes@${HF_VERSION}`, label: note }) ?? null;
      const entry = { id, startedAt: Date.now(), detached: false };
      jobs.set(id, entry);
      const wake = (prompt) =>
        entry.detached &&
        ctx.wakeAgent?.({ workspace: call.workspace, agent: call.agent, key: `video-render:${id}`, ...(call.sessionKey ? { sessionKey: call.sessionKey } : {}), prompt });
      entry.promise = (async () => {
        await acquire();
        try {
          await hfApi.ensureBrowser();
          const r = await hfApi.hf(["render", dir, "-o", out, "--json", ...flags], { cwd: dir, timeoutMs: 4 * 3_600_000 });
          if (r.code !== 0 || (ext && !fs.existsSync(out))) throw new Error(`render failed: ${tail(r.out || r.err, 30)}`);
          const seconds = Math.round((Date.now() - entry.startedAt) / 1000);
          let result;
          if (ext) {
            const info = await probe(out);
            const artifact = jail.save(call, out, `${name}${ext}`, `HyperFrames render · ${note}`, {
              provider: "HyperFrames",
              model: `hyperframes@${HF_VERSION}`,
              params: { project: jail.show(call.workspace, dir), ...Object.fromEntries(Object.entries(args).filter(([k]) => !["project", "wait_s", "note"].includes(k))) },
            });
            result = { job_id: id, artifact, project_file: jail.show(call.workspace, out), duration: Math.round(info.duration * 100) / 100, size_mb: info.size_mb, width: info.video?.width, height: info.video?.height, render_s: seconds };
          } else result = { job_id: id, frames_dir: jail.show(call.workspace, out), render_s: seconds };
          entry.result = result;
          if (tracked) ctx.jobs.settle(tracked, { status: "succeeded", result });
          wake(`Your video render ${id} (${note}) is done: ${result.artifact ?? result.frames_dir}. Watch it with video_understand before handing it over.`);
          return result;
        } catch (err) {
          entry.error = err.message;
          if (tracked) ctx.jobs.settle(tracked, { status: "failed", error: err.message.slice(0, 500) });
          wake(`Your video render ${id} (${note}) FAILED: ${err.message.slice(0, 400)}. Fix the project (video_hf check) and render again.`);
          throw err;
        } finally {
          release();
        }
      })();
      entry.promise.catch(() => {});
      const waitMs = Number(args.wait_s ?? 240) * 1000;
      const done = await Promise.race([entry.promise.then((r) => ({ r })).catch((e) => ({ e })), new Promise((res) => setTimeout(() => res(null), waitMs))]);
      if (done?.r) return json(done.r);
      if (done?.e) return json({ job_id: id, status: "failed", error: done.e.message });
      entry.detached = true;
      return json({ job_id: id, status: active > Number(cfg.parallel_renders || 1) || waiting.length ? "queued" : "rendering", hint: "still rendering — end your turn if nothing else is pending: you will be WOKEN when the file lands (or check with video_render job_id)" });
    },
  });

  // ---------------------------------------------------------------- captions

  ctx.registerTool({
    name: "video_captions",
    description:
      "Burn captions into a finished video in ONE ffmpeg pass (libass): seconds, not a re-render — the fast path for speech captions, long videos and batches. Modes: karaoke-highlight (groups of words, the spoken one tinted and scaled), word-carousel (one word at a time, pop-in), phrases (each phrase on a rounded plate sized to the text). Words come from a transcript file (eleven_transcribe / openrouter_run / HyperFrames transcript.json) or are passed directly. Style: font (a family from video_fonts), fontSize, primaryColor, highlightColor, outline, outlineColor, position bottom|center|top, marginV, maxWordsPerGroup, bold, uppercase, box {color, opacity, padding}, plate {color, opacity, radius, padX, padY} (phrases). Captions that are design — animated, styled per word — go through video_new captions instead.",
    schema: {
      video: z.string().describe("artifacts/… path or a path in your workspace"),
      mode: z.enum(["karaoke-highlight", "word-carousel", "phrases"]),
      transcript: z.string().optional().describe("a transcript .json with word timings"),
      words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() })).optional(),
      phrases: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })).optional().describe("phrases mode: the lines and their times"),
      style: z.record(z.string(), z.unknown()).optional(),
      name: z.string().max(60).optional(),
    },
    handler: async (args, call) => {
      const video = jail.resolve(call.workspace, args.video);
      let words = args.words ?? null;
      if (!words && args.transcript) words = wordsFrom(JSON.parse(fs.readFileSync(jail.resolve(call.workspace, args.transcript), "utf8")));
      if (args.mode === "phrases" && !args.phrases?.length) return text("error: phrases mode needs phrases [{text,start,end}]");
      if (args.mode !== "phrases" && !words?.length) return text("error: pass transcript (a .json with word timings) or words");
      const style = { ...(args.style ?? {}) };
      if (style.font) {
        const face = fonts.faces(String(style.font)).find((f) => /\.(ttf|otf)$/i.test(f.file));
        if (face) style.font = face.assName;
        const all = args.mode === "phrases" ? args.phrases.map((p) => p.text).join(" ") : words.map((w) => w.word).join(" ");
        const missing = face ? fonts.missingGlyphs(face.file, all) : "";
        if (missing) return text(`error: ${style.font} has no glyphs for «${missing}» — pick another font (video_fonts check) or another weight`);
      }
      const name = slug(args.name ?? `${path.basename(video).replace(/\.[^.]+$/, "")}-${args.mode}-${crypto.randomBytes(3).toString("hex")}`);
      const out = path.join(outDir(call), `${name}.mp4`);
      const done = await burnCaptions({ video, mode: args.mode, words, phrases: args.phrases, style, fontsDir: fonts.dir, outFile: out });
      const artifact = jail.save(call, out, `${name}.mp4`, `captions (${args.mode}) on ${path.basename(video)}`, { provider: "libass", model: "ffmpeg-caption-burn-ass", params: { mode: args.mode, style } });
      const ass = jail.save(call, out.replace(/\.mp4$/, ".ass"), `${name}.ass`, `caption events for ${name}.mp4`, { provider: "libass", model: "ffmpeg-caption-burn-ass" });
      return json({ artifact, ass, events: done.events, duration: done.duration, hint: "watch it with video_understand before handing it over" });
    },
  });

  // ------------------------------------------------------------------- fonts

  ctx.registerTool({
    name: "video_fonts",
    description:
      "The instance's fonts for video — any font, not a fixed list. add: a Google Fonts family by its exact name (weights, italic; variable families come as static weights, Cyrillic included), a .ttf/.otf/.woff2 by URL, or a font file from your workspace. list: what is there, with the scripts each face covers. check: which faces have every glyph of your text (Cyrillic, ß, accents). board: one picture of candidate faces set in your own words — to choose by eye or show the person. use: write chosen families into a project (fonts/fonts.css). In CSS use font-family «family» with font-weight; in video_captions use the family name.",
    schema: {
      action: z.enum(["add", "list", "check", "board", "use"]),
      google: z.string().optional().describe("add: Google Fonts family name, e.g. «Instrument Serif»"),
      weights: z.array(z.number().int().min(100).max(1000)).optional().describe("add google: e.g. [400, 700, 900]"),
      italic: z.union([z.boolean(), z.literal("both")]).optional().describe("add google: italic faces too"),
      url: z.string().optional().describe("add: a font file URL"),
      file: z.string().optional().describe("add: a font file in your workspace"),
      families: z.array(z.string()).optional().describe("check / board / use: which families (default all)"),
      text: z.string().optional().describe("check / board: your caption text"),
      project: z.string().optional().describe("use: the project to write fonts into"),
    },
    handler: async (args, call) => {
      const a = args.action;
      if (a === "add") {
        let added;
        if (args.google) added = await fonts.fetchGoogle(String(args.google), args.weights, args.italic);
        else if (args.url) added = await fonts.fetchUrl(String(args.url));
        else if (args.file) added = fonts.importFile(jail.resolve(call.workspace, args.file), `file:${args.file}`);
        else return text("error: add needs google, url or file");
        return json({ added: added.map((f) => ({ family: f.family, weight: f.weight, italic: f.italic, captions_name: f.assName, scripts: f.scripts, variable: f.variable })) });
      }
      const pick = args.families?.length ? args.families : [...new Set(fonts.list().map((f) => f.family))];
      if (a === "list") {
        const byFam = {};
        for (const f of fonts.list()) (byFam[f.family] ??= []).push(`${f.weight}${f.italic ? "i" : ""}`);
        return json({ families: Object.entries(byFam).map(([family, faces]) => ({ family, faces, scripts: fonts.faces(family)[0]?.scripts })), hint: "none fits? add any Google family by name, or a file" });
      }
      if (a === "check") {
        const t = String(args.text ?? "");
        if (!t) return text("error: check needs text");
        const rows = pick.flatMap((fam) => fonts.faces(fam).map((f) => ({ family: f.family, weight: f.weight, italic: f.italic, missing: fonts.missingGlyphs(f.file, t) })));
        return json({ fits: rows.filter((r) => !r.missing), lacking: rows.filter((r) => r.missing) });
      }
      if (a === "board") {
        const out = path.join(outDir(call), `fonts-${crypto.randomBytes(3).toString("hex")}.png`);
        const n = await fonts.board(pick, String(args.text ?? "Get ready with me — Привет"), out);
        const artifact = jail.save(call, out, path.basename(out), `font board: ${pick.join(", ")}`, null);
        return json({ artifact, faces: n, hint: "look at it with artifact_read; send it to the person to choose" });
      }
      if (a === "use") {
        if (!args.project) return text("error: use needs project");
        const dir = projectAt(call, args.project);
        const css = fonts.cssFor(pick, path.join(dir, "fonts"));
        fs.writeFileSync(path.join(dir, "fonts", "fonts.css"), css.css + "\n");
        return json({ project: jail.show(call.workspace, dir), fonts_css: jail.show(call.workspace, path.join(dir, "fonts", "fonts.css")), ...(css.missing.length ? { missing: css.missing } : {}), hint: 'index.html links fonts/fonts.css — use font-family: "Family"; font-weight: N' });
      }
      return text("error: unknown action");
    },
  });

  // ------------------------------------------------------- sources & output

  ctx.registerTool({
    name: "video_inspect",
    description:
      "What a source or reference video is, and copies made for looking at it: duration, size as shown (rotation applied), fps, HDR, sound; proxy — a light copy with the source time burned in large (give THAT to video_understand so it names exact seconds); sheet — one picture with a frame every N seconds and its time (for artifact_read). Deeper: video_hf measure cuts|events|look|ink.",
    schema: {
      src: z.string().describe("artifacts/… or a path in your workspace"),
      proxy: z.boolean().optional(),
      sheet: z.number().min(0.2).max(30).optional().describe("seconds between frames on the sheet"),
    },
    handler: async (args, call) => {
      const src = jail.resolve(call.workspace, args.src);
      const info = await probe(src);
      const base = slug(path.basename(src).replace(/\.[^.]+$/, ""));
      const extra = {};
      if (args.proxy) {
        const out = path.join(outDir(call), `${base}.proxy.mp4`);
        await proxy(src, out, path.basename(src));
        extra.proxy = jail.save(call, out, `${base}.proxy.mp4`, `timecode proxy of ${path.basename(src)}`, null);
      }
      if (args.sheet) {
        const out = path.join(outDir(call), `${base}.sheet.png`);
        await sheet(src, out, Number(args.sheet));
        extra.sheet = jail.save(call, out, `${base}.sheet.png`, `contact sheet of ${path.basename(src)} every ${args.sheet}s`, null);
      }
      return json({ src: jail.show(call.workspace, src), ...info, ...extra, ...(info.video?.hdr ? { note: "HDR source: renders and encodes here tone-map it to SDR; keep dynamic_range auto or sdr" } : {}) });
    },
  });

  ctx.registerTool({
    name: "video_encode",
    description:
      "Re-encode a finished video for where it goes. instagram — 1080 wide, high quality (Instagram re-encodes anyway, give it the best); telegram — two-pass to fit max_mb (Bot API uploads up to 50 MB; send the original as a file and this as the in-chat preview); preview — light, for video_understand; master — near-lossless archive. HDR sources are tone-mapped to SDR.",
    schema: {
      src: z.string(),
      target: z.enum(["instagram", "telegram", "preview", "master"]),
      max_mb: z.number().min(1).max(2000).optional().describe("telegram: the size cap (default 48)"),
      name: z.string().max(60).optional(),
    },
    handler: async (args, call) => {
      const src = jail.resolve(call.workspace, args.src);
      const name = slug(args.name ?? `${path.basename(src).replace(/\.[^.]+$/, "")}-${args.target}-${crypto.randomBytes(3).toString("hex")}`);
      const out = path.join(outDir(call), `${name}.mp4`);
      const r = await encode(src, out, args.target, args.max_mb);
      const artifact = jail.save(call, out, `${name}.mp4`, `${args.target} encode of ${path.basename(src)}`, { provider: "ffmpeg", model: "libx264", params: { target: args.target, ...(args.max_mb ? { max_mb: args.max_mb } : {}) } });
      return json({ artifact, ...r });
    },
  });

  ctx.registerTool({
    name: "video_fetch",
    description:
      "Download a public video by its page link (Instagram reel, TikTok, YouTube Shorts, Pinterest…) into artifacts/refs/ — for studying a reference the person sent: then video_hf measure cuts/look/ink, video_inspect sheet and video_understand on it. Some sites want a login for some videos: then ask the person for the file itself.",
    schema: { url: z.string().url(), note: z.string().max(200).optional() },
    handler: async (args, call) => {
      const dir = path.join(outDir(call), "refs");
      const { file, meta } = await fetcher.get(String(args.url), dir);
      const name = path.basename(file);
      const rel = path.posix.join("refs", name);
      const abs = path.join(jail.roots(call.workspace).art, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(file, abs);
      fs.rmSync(file, { force: true });
      ctx.artifacts.annotate(call.workspace, rel, { agent: call.agent, taskId: call.taskId, description: `reference: ${args.url}${args.note ? ` · ${args.note}` : ""}`.slice(0, 300), action: "created" });
      ctx.artifacts.mirror(call.workspace, [rel]);
      const info = await probe(abs);
      return json({ artifact: `artifacts/${rel}`, ...meta, duration: info.duration, width: info.video?.width, height: info.video?.height, hint: "study it: video_hf measure [\"cuts\", path] and [\"look\", path], video_inspect sheet, video_understand" });
    },
  });

  ctx.registerTool({
    name: "video_setup",
    description:
      "Install the official HyperFrames and GSAP authoring skills into your own HOME (Claude Code, Codex and other coding agents read them natively) — the composition contract, captions, overlays, motion, look and sound references. Run once; again to refresh.",
    schema: {},
    handler: async (_args, call) => {
      const own = path.join(ctx.paths.agentHomeBase, call.workspace, call.agent);
      const home = fs.existsSync(own) ? own : ctx.paths.agentHomeBase;
      const r = await hfApi.hf(["skills"], { cwd: home, env: { HOME: home, HYPERFRAMES_SKIP_SKILLS: "0" }, timeoutMs: 600_000 });
      if (r.code !== 0) return json({ ok: false, error: tail(r.err || r.out, 20) });
      const where = [".claude/skills", ".codex/skills", ".agents/skills"].map((d) => path.join(home, d)).filter((d) => fs.existsSync(d));
      const installed = where.flatMap((d) => fs.readdirSync(d).filter((n) => /hyperframes|gsap|media-use|figma|slideshow/i.test(n)).map((n) => `${path.basename(path.dirname(d))}/${path.basename(d)}/${n}`));
      return json({ ok: true, installed, hint: "they load in your next session; start from the /hyperframes skill" });
    },
  });

  ctx.log.info(`video editing ready (HyperFrames ${HF_VERSION})`);
}
