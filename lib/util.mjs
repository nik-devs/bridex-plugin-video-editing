import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/** Every child this plugin started and has not seen exit — killed on shutdown. */
export const children = new Set();

/**
 * Run a process and collect its output (capped). The child gets its own
 * process group, so a timeout or a shutdown kills Chrome and ffmpeg under it
 * too, not just the launcher.
 */
export function run(cmd, args, { cwd, env, timeoutMs = 600_000, input } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ?? process.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: -1, out: "", err: String(err?.message ?? err) });
      return;
    }
    children.add(child);
    let out = "";
    let err = "";
    const keep = (s, add) => (s.length > 400_000 ? s : s + add);
    child.stdout.on("data", (d) => (out = keep(out, d.toString())));
    child.stderr.on("data", (d) => (err = keep(err, d.toString())));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code: -1, out, err: `${err}${e.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code: code ?? -1, signal, out, err: timedOut ? `${err}\n(stopped: over ${Math.round(timeoutMs / 1000)} s)` : err });
    });
    child.stdin.on("error", () => {});
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export function killGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** The last lines of a tool's stderr: what an agent needs to fix a call. */
export const tail = (s, n = 40) => String(s ?? "").trim().split("\n").slice(-n).join("\n").slice(-6000);

export const slug = (s, fallback = "video") =>
  String(s ?? "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60) || fallback;

/**
 * Paths an agent names: «artifacts/…» is the workspace's artifacts folder,
 * anything else is relative to its working directory; absolute paths are
 * taken as they are. Either way the result must stay inside the two.
 */
export function makeJail(ctx) {
  const roots = (ws) => ({ art: ctx.paths.workspaceArtifacts(ws), work: ctx.paths.workspaceWorkdir(ws) });
  function resolve(ws, p, { mustExist = true, base } = {}) {
    const { art, work } = roots(ws);
    const s = String(p ?? "").trim();
    if (!s) throw new Error("empty path");
    const abs = path.isAbsolute(s)
      ? path.resolve(s)
      : /^artifacts\//.test(s)
        ? path.join(art, s.slice("artifacts/".length))
        : path.resolve(base ?? work, s);
    const inside = (r) => abs === r || abs.startsWith(r + path.sep);
    if (!inside(art) && !inside(work)) throw new Error(`${p} is outside your workspace (artifacts/… or your working directory)`);
    if (mustExist && !fs.existsSync(abs)) throw new Error(`not found: ${p}`);
    return abs;
  }
  /** How an agent sees a path again: artifacts/… or relative to its working directory. */
  function show(ws, abs) {
    const { art, work } = roots(ws);
    if (abs === art || abs.startsWith(art + path.sep)) return `artifacts/${path.relative(art, abs).split(path.sep).join("/")}`;
    if (abs === work || abs.startsWith(work + path.sep)) return path.relative(work, abs).split(path.sep).join("/") || ".";
    return abs;
  }
  /** A finished file into the task's artifacts (video/ outside a task), with how it was made. */
  function save(call, srcAbs, name, description, generation) {
    const rel = path.posix.join(call.taskId ?? "video", name);
    const abs = path.join(ctx.paths.workspaceArtifacts(call.workspace), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // a name in use: the earlier file becomes a version first (newer cores)
    ctx.artifacts.keepVersion?.(call.workspace, rel, { agent: call.agent, taskId: call.taskId });
    fs.copyFileSync(srcAbs, abs);
    ctx.artifacts.annotate(call.workspace, rel, {
      agent: call.agent,
      taskId: call.taskId,
      description: String(description).slice(0, 300),
      action: "generated",
      ...(generation ? { generation } : {}),
    });
    ctx.artifacts.mirror(call.workspace, [rel]);
    return `artifacts/${rel}`;
  }
  return { roots, resolve, show, save };
}

/** Hard link when the two paths share a volume (instant, no extra space), copy otherwise. */
export function linkOrCopy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    if (fs.existsSync(dst)) fs.rmSync(dst);
    fs.linkSync(src, dst);
  } catch {
    fs.copyFileSync(src, dst);
  }
}

/** Files under `dir` written at or after `since` (ms), relative, for a reply. */
export function newFiles(dir, since, limit = 60) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 4 || out.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".hf-") || e.name === ".git") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else {
        try {
          if (fs.statSync(p).mtimeMs >= since - 1000) out.push(p);
        } catch {
          // vanished meanwhile
        }
      }
    }
  };
  walk(dir, 0);
  return out;
}

export const text = (t) => ({ content: [{ type: "text", text: String(t) }] });
export const json = (v) => text(JSON.stringify(v, null, 1));
