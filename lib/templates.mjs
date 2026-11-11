import fs from "node:fs";
import path from "node:path";
import { linkOrCopy, slug } from "./util.mjs";

const GSAP = "https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js";
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Caption looks to start from; every one is plain CSS in the project, change anything. */
const CAPTION_LOOKS = {
  plate: `background: var(--cap-plate, #ffffff); color: var(--cap-ink, #111111); padding: 0.28em 0.62em; border-radius: 0.42em; box-shadow: 0 10px 30px rgba(0,0,0,.18);`,
  outline: `color: var(--cap-ink, #ffffff); -webkit-text-stroke: 0.16em var(--cap-stroke, #000000); paint-order: stroke fill; text-shadow: 0 0.08em 0.3em rgba(0,0,0,.35);`,
  tiktok: `background: var(--cap-plate, rgba(0,0,0,.58)); color: var(--cap-ink, #ffffff); padding: 0.2em 0.5em; border-radius: 0.22em;`,
  editorial: `color: var(--cap-ink, #ffffff); font-style: italic; text-shadow: 0 0.04em 0.5em rgba(0,0,0,.45); letter-spacing: -0.01em;`,
  none: ``,
};
const POSITIONS = { upper: "top: 13%;", middle: "top: 50%; transform: translateY(-50%);", lower: "bottom: 27%;" };

/** Fonts the edit names, for the store to write into the project. */
export function fontsOf(edit) {
  const out = new Set(edit.fonts ?? []);
  for (const f of [edit.captions?.font, edit.hook?.font]) if (f) out.add(f);
  return [...out];
}

/**
 * A vertical reel from an edit list: shots in order (trim, framing, slow push,
 * cut style), a caption per shot or on the film's own clock, an opening hook,
 * music. The output is a normal HyperFrames project — open index.html and
 * change anything; the edit list is kept as edit.json for a quick rebuild.
 */
export function buildReel(edit, projectDir, resolveMedia) {
  const W = num(edit.width, 1080);
  const H = num(edit.height, 1920);
  const clips = edit.clips ?? [];
  if (!clips.length) throw new Error("the edit list has no clips");
  fs.mkdirSync(path.join(projectDir, "media"), { recursive: true });

  let t = 0;
  const shots = clips.map((c, i) => {
    const src = resolveMedia(c.src);
    const ext = path.extname(src).toLowerCase() || ".mp4";
    const name = `shot-${String(i + 1).padStart(2, "0")}${ext}`;
    linkOrCopy(src, path.join(projectDir, "media", name));
    const d = num(c.duration, 0) || (c.out !== undefined ? num(c.out, 0) - num(c.in, 0) : 2);
    if (d <= 0) throw new Error(`clip ${i + 1}: duration must be positive`);
    const shot = { ...c, i, name, start: r3(t), duration: r3(d), isImage: /\.(png|jpe?g|webp|gif)$/i.test(ext) };
    t += d;
    return shot;
  });
  const total = r3(t);

  const cap = { style: "plate", position: "lower", size: 64, weight: 800, ...(edit.captions ?? {}) };
  const hook = edit.hook?.text ? { duration: 1.6, size: 96, weight: 800, position: "middle", ...edit.hook } : null;
  const captions = [
    ...shots.filter((s) => s.caption).map((s) => ({ text: s.caption, start: s.start, end: s.start + s.duration })),
    ...(cap.items ?? []).map((x) => ({ text: x.text, start: num(x.start, 0), end: num(x.end, num(x.start, 0) + 1.5) })),
  ].filter((x) => x.text && x.end > x.start);

  let music = "";
  if (edit.music?.src) {
    const src = resolveMedia(edit.music.src);
    const name = `music${path.extname(src) || ".mp3"}`;
    linkOrCopy(src, path.join(projectDir, "media", name));
    music = `    <audio id="music" src="media/${name}" data-start="0" data-duration="${total}" data-media-start="${num(edit.music.in, 0)}" data-volume="${num(edit.music.volume, 0.85)}" data-fade-in="${num(edit.music.fade_in, 0.05)}" data-fade-out="${num(edit.music.fade_out, 1.2)}" data-track-index="9"></audio>`;
  }

  const shotEls = shots
    .map((s) => {
      const common = `id="shot-${s.i}" class="clip shot" data-start="${s.start}" data-duration="${s.duration}" data-track-index="0" style="object-position: ${esc(s.focus ?? "50% 50%")};"`;
      if (s.isImage) return `    <img ${common} src="media/${s.name}" alt="">`;
      const sound = s.audio ? `data-has-audio="true" data-volume="${num(s.volume, 1)}"` : "muted";
      return `    <video ${common} src="media/${s.name}" data-media-start="${num(s.in, 0)}" ${sound} playsinline></video>`;
    })
    .join("\n");

  // cut styles live on the cut, into the shot they open
  const flashes = shots
    .filter((s) => s.i > 0 && ["flash", "fade"].includes(s.transition ?? edit.transition))
    .map((s) => {
      const kind = s.transition ?? edit.transition;
      return `    <div id="cut-${s.i}" class="clip cutfx ${kind}" data-start="${r3(Math.max(0, s.start - 0.08))}" data-duration="0.3" data-track-index="5"></div>`;
    })
    .join("\n");

  const capEls = captions
    .map((c, i) => {
      const [main, brand] = String(c.text).split(/\s+—\s+/);
      const inner = brand && cap.style === "editorial" ? `${esc(main)}<span class="brand">${esc(brand)}</span>` : esc(c.text);
      return `    <div id="cap-${i}" class="clip cap" data-start="${r3(c.start)}" data-duration="${r3(c.end - c.start)}" data-track-index="2"><span class="cap-text">${inner}</span></div>`;
    })
    .join("\n");

  const hookEl = hook
    ? `    <div id="hook" class="clip hook" data-start="0" data-duration="${num(hook.duration, 1.6)}" data-track-index="3"><span class="hook-text">${esc(hook.text)}</span></div>`
    : "";

  const tweens = [];
  for (const s of shots) {
    const z = Array.isArray(s.zoom) ? s.zoom : s.zoom === false ? [1, 1] : [1, 1.06];
    if (z[0] !== z[1]) tweens.push(`tl.fromTo("#shot-${s.i}", { scale: ${z[0]} }, { scale: ${z[1]}, duration: ${s.duration}, ease: "none" }, ${s.start});`);
    const kind = s.i > 0 ? (s.transition ?? edit.transition ?? "cut") : "cut";
    if (kind === "zoom") tweens.push(`tl.fromTo("#shot-${s.i}", { scale: ${r3(z[0] * 1.14)} }, { scale: ${z[0]}, duration: 0.28, ease: "power3.out", immediateRender: false }, ${s.start});`);
    if (kind === "whip")
      tweens.push(`tl.fromTo("#shot-${s.i}", { xPercent: 28, filter: "blur(14px)" }, { xPercent: 0, filter: "blur(0px)", duration: 0.2, ease: "power3.out", immediateRender: false }, ${s.start});`);
    if (kind === "flash") tweens.push(`tl.fromTo("#cut-${s.i}", { opacity: 0 }, { opacity: 1, duration: 0.08, yoyo: true, repeat: 1, ease: "power1.inOut" }, ${r3(Math.max(0, s.start - 0.08))});`);
    if (kind === "fade") tweens.push(`tl.fromTo("#cut-${s.i}", { opacity: 0 }, { opacity: 1, duration: 0.12, yoyo: true, repeat: 1, ease: "sine.inOut" }, ${r3(Math.max(0, s.start - 0.12))});`);
  }
  captions.forEach((c, i) => {
    tweens.push(`tl.fromTo("#cap-${i} .cap-text", { opacity: 0, y: 26, scale: 0.92 }, { opacity: 1, y: 0, scale: 1, duration: 0.22, ease: "back.out(2)" }, ${r3(c.start)});`);
  });
  if (hook) tweens.push(`tl.fromTo("#hook .hook-text", { opacity: 0, scale: 1.18 }, { opacity: 1, scale: 1, duration: 0.3, ease: "power3.out" }, 0);`);

  const capFont = cap.font ? `"${esc(cap.font)}", ` : "";
  const hookFont = hook?.font ? `"${esc(hook.font)}", ` : capFont;
  const html = `<!doctype html>
<html lang="${esc(edit.lang ?? "ru")}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <script src="${GSAP}"></script>
    <link rel="stylesheet" href="fonts/fonts.css" />
    <style>
      :root {
        --cap-size: ${num(cap.size, 64)}px;
        --cap-weight: ${num(cap.weight, 800)};
        ${cap.color ? `--cap-ink: ${esc(cap.color)};` : ""}
        ${cap.plate ? `--cap-plate: ${esc(cap.plate)};` : ""}
        ${cap.stroke ? `--cap-stroke: ${esc(cap.stroke)};` : ""}
      }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; }
      .shot { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transform-origin: 50% 50%; }
      .cutfx { position: absolute; inset: 0; opacity: 0; pointer-events: none; }
      .cutfx.flash { background: #fff; }
      .cutfx.fade { background: #000; }
      .cap { position: absolute; left: 0; right: 0; display: flex; justify-content: center; ${POSITIONS[cap.position] ?? POSITIONS.lower} }
      .cap-text {
        display: inline-block; max-width: 84%; text-align: center; text-wrap: balance;
        font-family: ${capFont}system-ui, sans-serif; font-size: var(--cap-size); font-weight: var(--cap-weight); line-height: 1.12;
        ${cap.italic ? "font-style: italic;" : ""}${cap.uppercase ? "text-transform: uppercase;" : ""}
        ${CAPTION_LOOKS[cap.style] ?? CAPTION_LOOKS.plate}
      }
      .cap-text .brand { display: block; margin-top: 0.35em; font-size: 0.42em; font-style: normal; letter-spacing: 0.35em; text-transform: uppercase; opacity: 0.92; }
      .hook { position: absolute; left: 0; right: 0; display: flex; justify-content: center; ${POSITIONS[hook?.position] ?? POSITIONS.middle} }
      .hook-text {
        max-width: 88%; text-align: center; text-wrap: balance; line-height: 1.02;
        font-family: ${hookFont}system-ui, sans-serif; font-size: ${num(hook?.size, 96)}px; font-weight: ${num(hook?.weight, 800)};
        ${hook?.italic ? "font-style: italic;" : ""}color: ${esc(hook?.color ?? "#ffffff")};
        -webkit-text-stroke: ${hook?.stroke === false ? 0 : "0.06em"} rgba(0,0,0,.85); paint-order: stroke fill; text-shadow: 0 0.06em 0.4em rgba(0,0,0,.4);
      }
${cap.css ? `      /* the edit list's own css */\n      ${cap.css}\n` : ""}    </style>
  </head>
  <body>
    <div id="root" data-composition-id="reel" data-start="0" data-duration="${total}" data-width="${W}" data-height="${H}">
${shotEls}
${flashes}
${capEls}
${hookEl}
${music}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      ${tweens.join("\n      ")}
      window.__timelines["reel"] = tl;
    </script>
  </body>
</html>
`;
  fs.writeFileSync(path.join(projectDir, "index.html"), html);
  fs.writeFileSync(path.join(projectDir, "edit.json"), JSON.stringify(edit, null, 1));
  return { duration: total, shots: shots.map((s) => ({ shot: s.i + 1, file: `media/${s.name}`, start: s.start, end: r3(s.start + s.duration) })), captions: captions.length };
}

/** Lines of 2–5 words that break on pauses and sentence ends: how people read captions. */
export function groupWords(words, maxWords = 4, maxChars = 24) {
  const lines = [];
  let cur = [];
  for (const w of words) {
    const len = cur.reduce((n, x) => n + x.word.length + 1, 0) + w.word.length;
    const gap = cur.length ? w.start - cur[cur.length - 1].end : 0;
    if (cur.length && (cur.length >= maxWords || len > maxChars || gap > 0.6)) {
      lines.push(cur);
      cur = [];
    }
    cur.push(w);
    if (/[.!?…]$/.test(w.word)) {
      lines.push(cur);
      cur = [];
    }
  }
  if (cur.length) lines.push(cur);
  return lines;
}

/** Animated word-by-word captions over one video, from its transcript: the designed version of a caption burn. */
export function buildCaptions({ video, words, style = {}, width = 1080, height = 1920, duration }, projectDir, resolveMedia) {
  fs.mkdirSync(path.join(projectDir, "media"), { recursive: true });
  const src = resolveMedia(video);
  const name = `source${path.extname(src) || ".mp4"}`;
  linkOrCopy(src, path.join(projectDir, "media", name));
  const st = { font: "", size: 78, weight: 900, color: "#ffffff", active: "#FFE600", stroke: "#000000", position: "lower", uppercase: true, ...style };
  const lines = groupWords(words, num(st.maxWords, 4));
  const total = r3(num(duration, words.length ? words[words.length - 1].end + 0.5 : 5));
  const els = lines
    .map((ln, i) => {
      const s = ln[0].start;
      const e = Math.max(ln[ln.length - 1].end, s + 0.3);
      const spans = ln.map((w, j) => `<span class="w" id="w-${i}-${j}">${esc(w.word)}</span>`).join(" ");
      return `      <div id="line-${i}" class="clip line" data-start="${r3(s)}" data-duration="${r3(e - s)}" data-track-index="2"><span class="line-text">${spans}</span></div>`;
    })
    .join("\n");
  const tweens = [];
  lines.forEach((ln, i) => {
    tweens.push(`tl.fromTo("#line-${i} .line-text", { opacity: 0, y: 18, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.16, ease: "back.out(2)" }, ${r3(ln[0].start)});`);
    ln.forEach((w, j) => {
      tweens.push(`tl.to("#w-${i}-${j}", { color: "${esc(st.active)}", scale: 1.1, duration: 0.08 }, ${r3(w.start)});`);
      tweens.push(`tl.to("#w-${i}-${j}", { color: "${esc(st.color)}", scale: 1, duration: 0.08 }, ${r3(Math.max(w.start + 0.08, w.end))});`);
    });
  });
  const html = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <script src="${GSAP}"></script>
    <link rel="stylesheet" href="fonts/fonts.css" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #000; }
      #root { position: relative; width: 100%; height: 100%; }
      .src { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      .line { position: absolute; left: 0; right: 0; display: flex; justify-content: center; ${POSITIONS[st.position] ?? POSITIONS.lower} }
      .line-text {
        max-width: 86%; text-align: center; line-height: 1.08;
        font-family: ${st.font ? `"${esc(st.font)}", ` : ""}system-ui, sans-serif; font-size: ${num(st.size, 78)}px; font-weight: ${num(st.weight, 900)};
        ${st.uppercase ? "text-transform: uppercase;" : ""}color: ${esc(st.color)};
        -webkit-text-stroke: 0.14em ${esc(st.stroke)}; paint-order: stroke fill; text-shadow: 0 0.06em 0.3em rgba(0,0,0,.35);
      }
      .w { display: inline-block; transform-origin: 50% 60%; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="captions" data-start="0" data-duration="${total}" data-width="${width}" data-height="${height}">
      <video id="src" class="clip src" src="media/${name}" data-start="0" data-duration="${total}" data-has-audio="true" playsinline></video>
${els}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      ${tweens.join("\n      ")}
      window.__timelines["captions"] = tl;
    </script>
  </body>
</html>
`;
  fs.writeFileSync(path.join(projectDir, "index.html"), html);
  return { duration: total, lines: lines.length };
}

/** A title card on a transparent background — render it to mov or webm and lay it over any footage. */
export function buildTitle({ text, sub, duration = 2.5, font, size = 120, color = "#ffffff", width = 1080, height = 1920 }, projectDir) {
  fs.mkdirSync(projectDir, { recursive: true });
  const html = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <script src="${GSAP}"></script>
    <link rel="stylesheet" href="fonts/fonts.css" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: transparent; }
      #root { position: relative; width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px; }
      .title { font-family: ${font ? `"${esc(font)}", ` : ""}system-ui, sans-serif; font-size: ${size}px; font-weight: 800; color: ${esc(color)}; text-align: center; max-width: 86%; line-height: 1; }
      .sub { font-family: ${font ? `"${esc(font)}", ` : ""}system-ui, sans-serif; font-size: ${Math.round(size * 0.3)}px; letter-spacing: 0.3em; text-transform: uppercase; color: ${esc(color)}; opacity: .9; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="title" data-start="0" data-duration="${duration}" data-width="${width}" data-height="${height}">
      <div id="t" class="clip title" data-start="0" data-duration="${duration}">${esc(text)}</div>
      ${sub ? `<div id="s" class="clip sub" data-start="0.15" data-duration="${r3(duration - 0.15)}">${esc(sub)}</div>` : ""}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#t", { opacity: 0, y: 40, filter: "blur(10px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.45, ease: "power3.out" }, 0);
      ${sub ? `tl.fromTo("#s", { opacity: 0, letterSpacing: "0.6em" }, { opacity: 0.9, letterSpacing: "0.3em", duration: 0.5, ease: "power2.out" }, 0.2);` : ""}
      tl.to(["#t"${sub ? ', "#s"' : ""}], { opacity: 0, duration: 0.25 }, ${r3(duration - 0.25)});
      window.__timelines["title"] = tl;
    </script>
  </body>
</html>
`;
  fs.writeFileSync(path.join(projectDir, "index.html"), html);
  return { duration };
}

export const projectReadme = (kind) => `# Video project (${kind})

A HyperFrames project: \`index.html\` is the film — HTML/CSS for the look, a paused GSAP
timeline registered on \`window.__timelines\` for motion. Change anything.

- Look before rendering: \`video_hf\` command \`snapshot\` (args \`--at 1,3,5\`) and \`check\`.
- Show options side by side: \`video_hf\` \`compare\`.
- Ready-made blocks (caption styles, shader transitions, typography, overlays): \`video_hf\` \`catalog\` (args \`--tag captions\`, \`--tag transition\`, \`--tag typography\`), then \`add <name>\` and paste the snippet it prints.
- Fonts: \`video_fonts\` add → \`use\` with this project writes \`fonts/fonts.css\`.
- Render: \`video_render\` (draft first, then delivery).
- Reference: \`video_hf\` \`docs data-attributes\` / \`docs gsap\` / \`docs compositions\` / \`docs rendering\`.
`;

export const projectSlug = (name) => slug(name, "video");
