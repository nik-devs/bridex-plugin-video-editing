import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { run, slug, tail } from "./util.mjs";

const require = createRequire(import.meta.url);
const fontkit = require("fontkit");

/** Probes for the scripts captions most often need; a font may lack any of them. */
const SCRIPTS = {
  latin: "AaZz09",
  "latin-ext": "ĄąČčŘřŠšŽžŁłŐőŰűßÆæ",
  cyrillic: "АаБбЯяЁёЖжЩщЫы",
  greek: "ΑαΩωΣσ",
  vietnamese: "ẠạẾếỆệƠơƯư",
};

/** What a font file is: names, weight, style, variable axes, which scripts it covers. */
export function describeFont(file) {
  const f = fontkit.openSync(file);
  const os2 = f["OS/2"] ?? {};
  const sub = String(f.subfamilyName ?? "");
  const has = (s) => [...s].every((ch) => f.hasGlyphForCodePoint(ch.codePointAt(0)));
  return {
    // nameID 16 (typographic family) when the file has one: the family CSS and people say
    family: f.getName?.("preferredFamily") ?? f.familyName,
    // nameID 1: the name libass/fontconfig match in an .ass Style (a static «Montserrat ExtraBold»)
    assName: f.familyName,
    fullName: f.fullName,
    weight: os2.usWeightClass ?? 400,
    italic: Boolean(os2.fsSelection?.italic) || /italic|oblique/i.test(sub),
    variable: Object.keys(f.variationAxes ?? {}).length > 0,
    axes: Object.keys(f.variationAxes ?? {}),
    glyphs: f.numGlyphs,
    scripts: Object.entries(SCRIPTS)
      .filter(([, probe]) => has(probe))
      .map(([k]) => k),
  };
}

/** The characters of `text` the font has no glyph for (spaces and line breaks ignored). */
export function missingGlyphs(file, text) {
  const f = fontkit.openSync(file);
  return [...new Set([...String(text)].filter((ch) => ch.trim() && !f.hasGlyphForCodePoint(ch.codePointAt(0))))].join("");
}

/**
 * The instance's font store: every face as a static .ttf/.otf in one flat
 * folder (what libass's fontsdir reads), plus an index with names and
 * coverage. Google Fonts serve a non-browser client one full .ttf per style
 * and weight — variable families come out as static instances, Cyrillic
 * included — so no font tooling is needed here.
 */
export function makeFontStore(stateDir, log) {
  const dir = path.join(stateDir, "fonts");
  const indexFile = path.join(stateDir, "fonts.json");
  fs.mkdirSync(dir, { recursive: true });

  const load = () => {
    try {
      return JSON.parse(fs.readFileSync(indexFile, "utf8"));
    } catch {
      return { fonts: [] };
    }
  };
  const save = (idx) => fs.writeFileSync(indexFile, JSON.stringify(idx, null, 1));

  function register(file, source) {
    const meta = describeFont(file);
    const idx = load();
    idx.fonts = idx.fonts.filter((x) => x.file !== path.basename(file));
    const entry = { file: path.basename(file), source, ...meta };
    idx.fonts.push(entry);
    save(idx);
    return entry;
  }

  async function fetchGoogle(family, weights, italic) {
    const fam = encodeURIComponent(family.trim()).replace(/%20/g, "+");
    const ws = [...new Set((weights?.length ? weights : [400, 700]).map(Number))].sort((a, b) => a - b);
    const styles = italic === "both" ? [0, 1] : italic ? [1] : [0];
    const tries = [
      `ital,wght@${styles.flatMap((i) => ws.map((w) => `${i},${w}`)).join(";")}`,
      ...ws.map((w) => `ital,wght@${styles.map((i) => `${i},${w}`).join(";")}`),
      ...ws.map((w) => `wght@${w}`),
      styles.includes(1) ? "ital@0;1" : "",
      "",
    ];
    const faces = new Map();
    for (const spec of tries) {
      const url = `https://fonts.googleapis.com/css2?family=${fam}${spec ? `:${spec}` : ""}`;
      // a non-browser user agent gets whole .ttf files, not woff2 split by unicode-range
      const res = await fetch(url, { headers: { "User-Agent": "curl/8.7.1" }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) continue;
      const css = await res.text();
      for (const m of css.matchAll(/@font-face\s*{([^}]+)}/g)) {
        const block = m[1];
        const src = /url\((https:[^)]+\.(?:ttf|otf))\)/.exec(block)?.[1];
        if (!src) continue;
        const weight = Number(/font-weight:\s*(\d+)/.exec(block)?.[1] ?? 400);
        const style = /font-style:\s*italic/.test(block) ? "italic" : "normal";
        faces.set(`${weight}-${style}`, { src, weight, style });
      }
      if (faces.size && spec === tries[0]) break;
      if (faces.size >= ws.length * styles.length) break;
    }
    if (!faces.size) throw new Error(`Google Fonts has no family «${family}» (check the exact name on fonts.google.com)`);
    const added = [];
    for (const { src, weight, style } of faces.values()) {
      const res = await fetch(src, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`download failed for ${family} ${weight} ${style}: ${res.status}`);
      const file = path.join(dir, `${slug(family)}-${weight}${style === "italic" ? "i" : ""}.ttf`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      added.push(register(file, `google:${family}`));
    }
    return added;
  }

  async function fetchUrl(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: "follow" });
    if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
    const name = path.basename(new URL(url).pathname) || "font.ttf";
    return importBuffer(Buffer.from(await res.arrayBuffer()), name, `url:${url}`);
  }

  function importFile(abs, source) {
    return importBuffer(fs.readFileSync(abs), path.basename(abs), source);
  }

  function importBuffer(buf, name, source) {
    const ext = path.extname(name).toLowerCase();
    if (![".ttf", ".otf", ".woff", ".woff2"].includes(ext)) throw new Error(`${name}: give a .ttf, .otf, .woff or .woff2 file`);
    const file = path.join(dir, `${slug(path.basename(name, ext))}${ext}`);
    fs.writeFileSync(file, buf);
    return [register(file, source)];
  }

  const list = () => load().fonts;

  /** Faces of one family (by family, libass name or file), boldest last. */
  function faces(family) {
    const want = String(family).toLowerCase();
    return list()
      .filter((f) => [f.family, f.assName, f.fullName, f.file].some((n) => String(n ?? "").toLowerCase() === want))
      .sort((a, b) => a.weight - b.weight);
  }

  /** CSS @font-face rules for these faces, their files copied next to the stylesheet. */
  function cssFor(families, targetDir) {
    fs.mkdirSync(targetDir, { recursive: true });
    const rules = [];
    const missing = [];
    for (const fam of families) {
      const fs_ = faces(fam);
      if (!fs_.length) missing.push(fam);
      for (const f of fs_) {
        fs.copyFileSync(path.join(dir, f.file), path.join(targetDir, f.file));
        const fmt = { ".ttf": "truetype", ".otf": "opentype", ".woff": "woff", ".woff2": "woff2" }[path.extname(f.file)] ?? "truetype";
        rules.push(
          `@font-face { font-family: "${f.family}"; src: url("./${f.file}") format("${fmt}"); font-weight: ${f.variable ? "100 900" : f.weight}; font-style: ${f.italic ? "italic" : "normal"}; font-display: block; }`,
        );
      }
    }
    return { css: rules.join("\n"), missing };
  }

  /** A picture of candidate faces with the caption's own words, to choose by eye. */
  async function board(families, sample, outFile) {
    const rows = [];
    for (const fam of families) for (const f of faces(fam)) if (/\.(ttf|otf)$/i.test(f.file)) rows.push(f);
    if (!rows.length) throw new Error("none of these families is in the store yet — add them first");
    const tmp = fs.mkdtempSync(path.join(path.dirname(outFile), ".board-"));
    const rowH = 150;
    const h = 60 + rows.length * rowH;
    const filters = [];
    rows.forEach((f, i) => {
      const label = path.join(tmp, `l${i}.txt`);
      const body = path.join(tmp, `t${i}.txt`);
      fs.writeFileSync(label, `${f.family} ${f.weight}${f.italic ? " italic" : ""}${f.scripts.includes("cyrillic") ? "" : "  (no Cyrillic)"}`);
      fs.writeFileSync(body, String(sample).slice(0, 60));
      const y = 30 + i * rowH;
      filters.push(`drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:textfile=${label}:x=40:y=${y}:fontsize=24:fontcolor=0x777777`);
      filters.push(`drawtext=fontfile=${path.join(dir, f.file)}:textfile=${body}:x=40:y=${y + 36}:fontsize=78:fontcolor=0x111111`);
    });
    const r = await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=0xF5F2EC:s=1600x${h}`, "-frames:v", "1", "-vf", filters.join(","), outFile], { timeoutMs: 120_000 });
    fs.rmSync(tmp, { recursive: true, force: true });
    if (r.code !== 0) throw new Error(`board failed: ${tail(r.err)}`);
    log?.info?.(`font board: ${rows.length} faces`);
    return rows.length;
  }

  return { dir, list, faces, fetchGoogle, fetchUrl, importFile, cssFor, board, missingGlyphs: (file, t) => missingGlyphs(path.join(dir, file), t) };
}
