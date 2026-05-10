#!/usr/bin/env bun
/**
 * kos-compat-api.ts — Drop-in replacement for knowledge-os v1 kos-api.py.
 *
 * Exposes the same HTTP contract that kos-worker (Notion Worker) calls:
 *   POST /query    { question }      → gbrain ask <question>
 *   POST /ingest   { url, slug? }    → filesystem-canonical: write to
 *                                       ~/brain/<kind-dir>/<slug>.md, git
 *                                       commit, `gbrain sync --repo ~/brain`
 *                                       (Step 2.2, 2026-04-23).
 *   GET  /digest   ?since=N          → latest kos-patrol digest or DB summary
 *   GET  /status                     → direct PGLite inventory (Step 2.2
 *                                       fixes the 100-cap bug of shelling
 *                                       `gbrain list`)
 *   GET  /health                     → { status, brain }
 *
 * Auth: Authorization: Bearer <token> (KOS_API_TOKEN env, optional).
 * Port: KOS_API_PORT env (default 7225 for KOS v2; v1 kos-api.py used 7220).
 *
 * Usage:
 *   bun run server/kos-compat-api.ts --port 7225
 *   KOS_API_TOKEN=secret bun run server/kos-compat-api.ts
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BrainDb } from "../skills/kos-jarvis/_lib/brain-db.ts";
import { fetchUrl } from "../skills/kos-jarvis/url-fetcher/index.ts";

const PORT = Number(process.env.KOS_API_PORT ?? readFlag("--port") ?? 7225);
const TOKEN = process.env.KOS_API_TOKEN ?? "";
const BRAIN = process.env.GBRAIN_HOME ?? join(homedir(), "brain");
const DIGEST_DIR = join(BRAIN, ".agent", "digests");
// URL fetch deadline. Cloudflare's edge will 524 after ~100s if origin doesn't
// respond, so we keep this well below that. X/Twitter + reflective targets
// frequently stall HTTPS handshake without ever erroring, so AbortSignal is
// the only thing that prevents the request from sitting forever.
const FETCH_TIMEOUT_MS = Number(process.env.KOS_FETCH_TIMEOUT_MS ?? 20_000);

// kind → filesystem directory mapping for filesystem-canonical /ingest.
// Matches gbrain's 20-dir MECE + KOS 9-kind structure. Unknown kinds land
// in sources/ as a safe default (still gets parsed as a source page).
const KIND_TO_DIR: Record<string, string> = {
  source: "sources",
  concept: "concepts",
  entity: "entities",
  project: "projects",
  decision: "decisions",
  synthesis: "syntheses",
  comparison: "comparisons",
  protocol: "protocols",
  timeline: "timelines",
  person: "people",
  company: "companies",
};

function kindToDir(kind: string): string {
  return KIND_TO_DIR[kind] ?? "sources";
}

// KOS `kind` → gbrain `type` mapping. Upstream gbrain's lint requires
// `type:` in frontmatter from its fixed enum (see src/core/types.ts
// PageType). KOS keeps `kind:` as the quality-gate profile tag.
// Mapping rules are documented in skills/kos-jarvis/type-mapping.md.
const KIND_TO_TYPE: Record<string, string> = {
  source: "source",
  concept: "concept",
  project: "project",
  entity: "note",        // entity is too coarse; `note` is upstream's catch-all
  decision: "concept",   // decisions live in concepts/ with kind preserved
  synthesis: "writing",
  comparison: "writing",
  protocol: "concept",
  timeline: "note",
  person: "person",
  company: "company",
};

function kindToType(kind: string): string {
  return KIND_TO_TYPE[kind] ?? "note";
}

// YAML-safe single-quoted scalar: ' → '' and wrap in single quotes. Handles
// titles that contain colons, hyphens, quotes, Chinese punctuation, etc.
function yamlQuoteSingle(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// Pull a title out of markdown body — first `# heading`, otherwise fall
// back to the slug. Strips leading/trailing whitespace, caps at 240 chars
// (upstream pages table title is TEXT but long titles hurt rendering).
function deriveTitle(body: string | undefined, slug: string): string {
  if (body) {
    const m = body.match(/^#\s+(.+?)\s*$/m);
    if (m) return m[1].trim().slice(0, 240);
  }
  return slug;
}

function readFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Async, non-blocking spawn helper. Replaces the previous `spawnSync`-based
 * helpers because spawnSync froze the Bun HTTP event loop for the duration
 * of the child process — when /ingest spawned `gbrain sync` (which can hold
 * the PGLite write lock for 30 s on a deadlock), every other concurrent
 * request (/status, /query, externally-tunneled traffic) blocked too.
 *
 * See docs/bug-reports/notion-poller-pglite-lock-deadlock.md for the
 * incident report. This helper is the 短期 / 方案 A fix; the 彻底 / 方案 B
 * fix (in-process BrainDb writes, no subprocess at all) is filed as P1
 * in skills/kos-jarvis/TODO.md.
 *
 * Behavior:
 * - Captures stdout + stderr, returns combined as `stdout` (keeping the
 *   existing return contract callers expect).
 * - Strips ANSI on the way out (preserves prior behavior).
 * - Sends SIGKILL on timeout. Process MUST die on SIGKILL; if it doesn't,
 *   the orphan keeps holding the PGLite lock — the original incident.
 *   Logs the SIGKILL to stderr so operators can correlate with future
 *   zombies (P1 zombie-leak hunt).
 */
function spawnAsync(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill("SIGKILL");
          console.error(JSON.stringify({
            t: new Date().toISOString(),
            op: "spawn.timeout_kill",
            cmd, args: args.slice(0, 6),
            timeout_ms: opts.timeoutMs,
            pid: proc.pid,
          }));
        } catch { /* race: process already exited */ }
      }, opts.timeoutMs);
    }
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const out = stripAnsi(stdout + stderr);
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout: out });
    });
    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: 1,
        stdout: stripAnsi(`[spawn error] ${String(err)}\n${stdout}${stderr}`),
      });
    });
  });
}

async function gbrain(
  args: string[],
  timeoutMs = 120_000,
): Promise<{ code: number; stdout: string }> {
  return spawnAsync("gbrain", args, { timeoutMs });
}

/** Commit a single ingest to the ~/brain git repo. Idempotent on unchanged content. */
async function gitCommitIngest(slug: string): Promise<{ ok: boolean; msg: string }> {
  const add = await spawnAsync("git", ["-C", BRAIN, "add", "-A"], { timeoutMs: 10_000 });
  if (add.code !== 0) return { ok: false, msg: `git add failed: ${add.stdout.slice(0, 200)}` };
  const cmt = await spawnAsync(
    "git",
    ["-C", BRAIN, "commit", "-m", `ingest: ${slug}`],
    { timeoutMs: 10_000 }
  );
  if (cmt.code !== 0) {
    const err = cmt.stdout;
    // "nothing to commit" = idempotent re-ingest of unchanged payload; fine.
    if (err.includes("nothing to commit")) return { ok: true, msg: "no-op (content unchanged)" };
    return { ok: false, msg: `git commit failed: ${err.slice(0, 200)}` };
  }
  return { ok: true, msg: "committed" };
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  const payload = typeof body === "string" ? { result: body } : body;
  res.end(JSON.stringify(payload, null, 2));
}

function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!TOKEN) return true;
  const h = req.headers.authorization ?? "";
  if (h === `Bearer ${TOKEN}`) return true;
  send(res, 401, { error: "unauthorized" });
  return false;
}

// ─── handlers ───

function handleHealth(res: ServerResponse) {
  send(res, 200, { status: "ok", brain: BRAIN, engine: "gbrain" });
}

async function handleStatus(res: ServerResponse) {
  // Direct PGLite read — bypasses the upstream `gbrain list` 100-row cap
  // that caused total_pages to silently under-report for 1800+ page brains.
  // Open briefly, read, close per kos-jarvis/_lib/brain-db.ts convention.
  const db = new BrainDb();
  try {
    await db.open();
    const pages = await db.listAllPages();
    const byType: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    const byConfidence: Record<string, number> = {};
    for (const p of pages) {
      byType[p.type] = (byType[p.type] ?? 0) + 1;
      const kind = (p.frontmatter?.kind as string) ?? p.type;
      byKind[kind] = (byKind[kind] ?? 0) + 1;
      const conf = (p.frontmatter?.confidence as string) ?? "unknown";
      byConfidence[conf] = (byConfidence[conf] ?? 0) + 1;
    }
    send(res, 200, {
      total_pages: pages.length,
      by_type: byType,
      by_kind: byKind,
      by_confidence: byConfidence,
      engine: "gbrain (postgres)",
      brain: BRAIN,
      note: "direct Postgres read (Path 3, 2026-04-29); DIKW rollup via kos-patrol",
    });
  } catch (e) {
    send(res, 500, { error: `status query failed: ${String(e).slice(0, 200)}` });
  } finally {
    await db.close();
  }
}

async function handleDigest(res: ServerResponse, sinceDays: number) {
  // Prefer latest kos-patrol digest file if present.
  try {
    const files = readdirSync(DIGEST_DIR)
      .filter((f) => f.startsWith("patrol-") && f.endsWith(".md"))
      .sort()
      .reverse();
    if (files.length > 0) {
      const body = readFileSync(join(DIGEST_DIR, files[0]), "utf-8");
      return send(res, 200, body);
    }
  } catch {
    // digest dir doesn't exist yet
  }
  // Fallback: direct-DB inventory summary (Step 2.2 — no more shell-out cap).
  const db = new BrainDb();
  try {
    await db.open();
    const pages = await db.listAllPages();
    const text = `[knowledge-os] (live, since ${sinceDays}d): ${pages.length} pages in gbrain.
Patrol digest file not found at ${DIGEST_DIR}. Run kos-patrol first.`;
    send(res, 200, text);
  } catch (e) {
    send(res, 500, { error: `digest fallback failed: ${String(e).slice(0, 200)}` });
  } finally {
    await db.close();
  }
}

async function handleQuery(req: IncomingMessage, res: ServerResponse) {
  let body: { question?: string };
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return send(res, 400, { error: "invalid JSON" });
  }
  const q = body.question?.trim();
  if (!q) return send(res, 400, { error: "question is required" });

  // Phase 1 — retrieval
  const r = await gbrain(["ask", q, "--no-expand"], 120_000);
  if (r.code !== 0) return send(res, 500, r.stdout);

  // Phase 2 — LLM synthesis (matches v1 Python kos-api contract; consumers
  // like Notion Knowledge Agent and feishu-bridge expect a prose answer,
  // not raw ranked chunks)
  const answer = await synthesizeAnswer(q, r.stdout);
  const out = `=== KOS Query ===
Q: ${q}

Phase 1: Retrieval
${r.stdout.trim()}

Phase 2: Synthesize (LLM)

─── Answer ───
${answer}
──────────────
`;
  send(res, 200, out);
}

async function synthesizeAnswer(q: string, retrieval: string): Promise<string> {
  const apiBase = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
  const apiKey =
    process.env.ANTHROPIC_API_KEY ??
    process.env.ANTHROPIC_AUTH_TOKEN ??
    "";
  if (!apiKey) {
    return `[synthesis skipped: ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN not set in kos-compat-api environment]`;
  }
  const model = process.env.KOS_LLM_MODEL_QUERY ?? "claude-sonnet-4-6";
  const maxTokens = Number(process.env.KOS_LLM_MAX_TOKENS_QUERY ?? "4096");
  const ctx = retrieval.length > 30000 ? retrieval.slice(0, 30000) : retrieval;

  const system = `基于下方 wiki 检索片段回答用户问题。
严格要求：
1. 直接输出中文答案正文，不要 YAML/JSON 元数据块
2. 不要输出 <file_read> 或其他工具调用标签
3. 引用来源时用 wiki 路径（例如 sources/... 或 concepts/...）
4. 若检索片段不足以回答，明确说明缺少什么；不要编造`;

  try {
    const resp = await fetch(`${apiBase.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "User-Agent": "kos-compat-api/1.0",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [
          {
            role: "user",
            content: `问题：${q}\n\n检索到的 wiki 片段：\n\n${ctx}`,
          },
        ],
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      return `ERROR: LLM 调用失败 (HTTP ${resp.status}): ${err.slice(0, 300)}`;
    }
    const data = (await resp.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (data.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n");
    return text.trim() || "ERROR: empty LLM response";
  } catch (e) {
    return `ERROR: LLM fetch exception: ${String(e).slice(0, 300)}`;
  }
}

async function handleIngest(req: IncomingMessage, res: ServerResponse) {
  let body: {
    url?: string;
    slug?: string;
    markdown?: string;
    title?: string;
    source?: string;
    kind?: string;
    tags?: string[];
    notion_id?: string;
  };
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return send(res, 400, { error: "invalid JSON" });
  }

  const url = body.url?.trim();
  const markdown = body.markdown?.trim();

  if (!url && !markdown) {
    return send(res, 400, { error: "either url or markdown is required" });
  }

  // Slug resolution: explicit > derived from title > derived from URL > timestamped
  const deriveSlug = (s: string) =>
    s
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase()
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  const slug =
    body.slug?.trim() ||
    (body.title ? deriveSlug(body.title) : undefined) ||
    (url ? deriveSlug(url) : undefined) ||
    `ingest-${Date.now()}`;

  const today = new Date().toISOString().slice(0, 10);
  const kind = body.kind?.trim() || "source";
  const sourceRef =
    body.source?.trim() || url || (body.notion_id ? `notion:${body.notion_id}` : "manual");
  const extraTags = Array.isArray(body.tags) ? body.tags : [];
  const tagList = ["ingest-via-compat-api", ...extraTags];

  let md: string;

  if (markdown) {
    // Direct markdown path (Notion worker, ad-hoc TS payloads, etc.)
    const hasFrontmatter = /^---\n[\s\S]*?\n---/.test(markdown);
    if (hasFrontmatter) {
      // Trust caller's frontmatter as-is; assume they know what they're doing
      md = markdown.endsWith("\n") ? markdown : markdown + "\n";
    } else {
      const title = body.title?.trim() || deriveTitle(markdown, slug);
      md = `---
id: '${kind}-${slug}'
type: ${kindToType(kind)}
kind: ${kind}
title: ${yamlQuoteSingle(title)}
status: draft
created: '${today}'
updated: '${today}'
owners:
  - jarvis
confidence: low
source_of_truth: raw
source_refs:
  - ${sourceRef}
tags: [${tagList.join(", ")}]
---

# ${title}

> Ingested via kos-compat-api /ingest (markdown payload) on ${today}.
> Source: ${sourceRef}

${markdown}
`;
    }
  } else {
    // URL fetch path routes through skills/kos-jarvis/url-fetcher which
    // prefers UltimateSearchSkill's Tavily/FireCrawl tiers (X/Twitter,
    // FlareSolverr-protected sites) and falls back to native fetch with
    // AbortSignal deadline. Backend via KOS_FETCH_BACKEND env (default
    // auto). Defends against the bare-fetch hang that caused Cloudflare
    // 524 to /ingest callers.
    const result = await fetchUrl(url!, { timeoutMs: FETCH_TIMEOUT_MS });
    if (!result.ok) {
      console.error(JSON.stringify({
        t: new Date().toISOString(),
        op: "ingest.fetch.fail",
        url, slug, kind,
        backend: result.backend,
        error: result.error,
        timeout: result.timeout,
        http_status: result.http_status,
        dur_ms: result.dur_ms,
      }));
      return send(res, result.timeout ? 504 : 502, {
        error: result.timeout
          ? `fetch timeout after ${FETCH_TIMEOUT_MS}ms (backend=${result.backend})`
          : `failed to fetch url: ${result.error} (backend=${result.backend})`,
        url,
        backend: result.backend,
      });
    }
    const fetched = result.content;
    console.log(JSON.stringify({
      t: new Date().toISOString(),
      op: "ingest.fetch.ok",
      url, slug, kind,
      backend: result.backend,
      source: result.source,
      format: result.format,
      bytes: result.bytes,
      dur_ms: result.dur_ms,
    }));

    // ultimate-search returns markdown; native returns html. Skip the HTML
    // strip when the body is already markdown — strip-on-markdown is mostly
    // a no-op but the regex chain has cost on long docs.
    const plain = result.format === "markdown"
      ? fetched.slice(0, 50_000)
      : fetched
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim()
          .slice(0, 50_000);

    const title = body.title?.trim() || slug;
    md = `---
id: 'source-${slug}'
type: source
kind: source
title: ${yamlQuoteSingle(title)}
status: draft
created: '${today}'
updated: '${today}'
owners:
  - jarvis
confidence: low
source_of_truth: raw
source_refs:
  - ${url}
tags: [${tagList.join(", ")}]
---

# ${title}

> Fetched via kos-compat-api /ingest on ${today}.
> Source: ${url}

${plain}
`;
  }
  // Filesystem-canonical write (Step 2.2): ~/brain/<kind-dir>/<slug>.md is
  // the source of truth. gbrain sync derives DB state from git HEAD.
  const dir = kindToDir(kind);
  const relPath = join(dir, `${slug}.md`);
  const absPath = join(BRAIN, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, md, "utf-8");

  // Commit to ~/brain git repo so `gbrain sync` has a HEAD to diff from.
  // Per-ingest commits are noisy but functional; Step 2.3/2.4 layers
  // commit-batching on top.
  const commit = await gitCommitIngest(slug);
  if (!commit.ok) {
    return send(res, 500, {
      imported: false,
      slug,
      wrote_to: absPath,
      output: commit.msg,
    });
  }

  // Incremental sync from HEAD. --no-pull avoids attempting git pull on
  // our local-only repo (no remote configured for ~/brain).
  const syncRes = await gbrain(["sync", "--repo", BRAIN, "--no-pull"], 180_000);
  if (syncRes.code !== 0) {
    return send(res, 500, {
      imported: false,
      slug,
      wrote_to: absPath,
      commit: commit.msg,
      output: syncRes.stdout,
    });
  }

  // gbrain sync already embeds new pages as part of the import pipeline
  // (see "N pages embedded" line in syncRes.stdout). This call acts as an
  // idempotent retry in case the sync embed hit a transient gemini-shim
  // error; it short-circuits with "all N chunks already embedded" when the
  // page is already vectored. Slug is <dir>/<slug> — gbrain pages are
  // stored under their full path slug.
  const fullSlug = `${dir}/${slug}`;
  const embedRes = await gbrain(["embed", fullSlug], 120_000);
  const embedded = embedRes.code === 0;

  send(res, 200, {
    imported: true,
    embedded,
    slug: fullSlug,
    wrote_to: absPath,
    commit: commit.msg,
    output: syncRes.stdout + (embedded ? "" : `\n[embed retry failed] ${embedRes.stdout}`),
    next: embedded
      ? "page is searchable via keyword + vector; use `gbrain dream` for cross-page synthesis"
      : "page synced (may already be embedded by sync) — retry `gbrain embed " + fullSlug + "` manually if vector search misses",
  });
}

// ─── server ───

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    return res.end();
  }
  if (!checkAuth(req, res)) return;

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  // Request-line log on response end. Skip /health to keep stdout signal-rich.
  // Without this, the only stdout entries are startup banners — last night's
  // 524 was invisible to the operator because no per-request line was written.
  const t0 = Date.now();
  if (path !== "/health") {
    const origEnd = res.end.bind(res);
    res.end = ((...args: unknown[]) => {
      console.log(JSON.stringify({
        t: new Date().toISOString(),
        op: "req",
        method: req.method,
        path,
        status: res.statusCode,
        dur_ms: Date.now() - t0,
      }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origEnd as any)(...args);
    }) as typeof res.end;
  }

  try {
    if (req.method === "GET" && path === "/health") return handleHealth(res);
    if (req.method === "GET" && path === "/status") return await handleStatus(res);
    if (req.method === "GET" && path === "/digest") {
      const since = Number(url.searchParams.get("since") ?? "7");
      return await handleDigest(res, since);
    }
    if (req.method === "POST" && path === "/query") return await handleQuery(req, res);
    if (req.method === "POST" && path === "/ingest") return await handleIngest(req, res);
    send(res, 404, { error: `unknown endpoint: ${req.method} ${path}` });
  } catch (e) {
    send(res, 500, { error: String(e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`kos-compat-api listening on http://127.0.0.1:${PORT}`);
  console.log(`Brain: ${BRAIN}`);
  console.log(`Auth: ${TOKEN ? "Bearer token required" : "none (dev mode)"}`);
  console.log(`Endpoints: GET /health /status /digest | POST /query /ingest`);
});
