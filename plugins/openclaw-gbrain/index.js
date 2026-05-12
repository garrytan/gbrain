import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const DEFAULT_GBRAIN_BIN = "gbrain";
const DEFAULT_OPENCLAW_BIN = "openclaw";
const DEFAULT_EXTRACTION_MODEL = "openai-codex/gpt-5.4-mini";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_ENV_FILE = join(homedir(), ".gbrain", "gbrain.env");
const DEFAULT_MAX_CONCURRENT_EXTRACTIONS = 1;
const DEFAULT_EXTRACTION_QUEUE_LIMIT = 8;
const DEFAULT_EXTRACTION_QUEUE_TIMEOUT_MS = 30_000;
const DEFAULT_MIN_EXTRACTION_INTERVAL_MS = 0;
const DEFAULT_MAX_EXTRACTION_FILE_BYTES = 8_000_000;
const GBRAIN_ROUTE_PATH = "/plugins/gbrain/extract";
const MAX_TIMEOUT_MS = 300_000;
const MAX_EXTRACTION_QUEUE_LIMIT = 100;
const MAX_MIN_EXTRACTION_INTERVAL_MS = 60_000;
const MAX_EXTRACTION_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_BODY_BYTES = Math.ceil((MAX_EXTRACTION_FILE_BYTES * 4) / 3) + 512_000;

let activeExtractions = 0;
const extractionQueue = [];
let lastExtractionStartedAt = 0;
let extractionStartGate = Promise.resolve();

function readConfig(pluginConfig) {
  const cfg = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {};
  return {
    gbrainBin: readConfigString(cfg.gbrainBin) ?? process.env.GBRAIN_BIN ?? DEFAULT_GBRAIN_BIN,
    openclawBin: readConfigString(cfg.openclawBin) ?? process.env.OPENCLAW_BIN ?? DEFAULT_OPENCLAW_BIN,
    workingDir: readConfigString(cfg.workingDir) ?? process.cwd(),
    envFile: readConfigString(cfg.envFile) ?? process.env.GBRAIN_ENV_FILE ?? DEFAULT_ENV_FILE,
    extractionModel: readConfigString(cfg.extractionModel) ?? DEFAULT_EXTRACTION_MODEL,
    timeoutMs: readTimeoutMs(cfg.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxConcurrentExtractions: readBoundedInteger(
      cfg.maxConcurrentExtractions,
      DEFAULT_MAX_CONCURRENT_EXTRACTIONS,
      1,
      16,
    ),
    extractionQueueLimit: readBoundedInteger(
      cfg.extractionQueueLimit,
      DEFAULT_EXTRACTION_QUEUE_LIMIT,
      0,
      MAX_EXTRACTION_QUEUE_LIMIT,
    ),
    extractionQueueTimeoutMs: readBoundedInteger(
      cfg.extractionQueueTimeoutMs,
      DEFAULT_EXTRACTION_QUEUE_TIMEOUT_MS,
      1_000,
      MAX_TIMEOUT_MS,
    ),
    minExtractionIntervalMs: readBoundedInteger(
      cfg.minExtractionIntervalMs,
      DEFAULT_MIN_EXTRACTION_INTERVAL_MS,
      0,
      MAX_MIN_EXTRACTION_INTERVAL_MS,
    ),
    maxExtractionFileBytes: readBoundedInteger(
      cfg.maxExtractionFileBytes,
      DEFAULT_MAX_EXTRACTION_FILE_BYTES,
      1,
      MAX_EXTRACTION_FILE_BYTES,
    ),
  };
}

function readConfigString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readTimeoutMs(value, fallback) {
  return clampTimeoutMs(Number(value), fallback);
}

function readBoundedInteger(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function clampTimeoutMs(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Math.floor(value)));
}

function textResult(text, details = {}) {
  return { content: [{ type: "text", text }], details };
}

function readEnvFile(envFile) {
  if (!envFile || !existsSync(envFile)) return {};
  try {
    const env = {};
    const text = readFileSync(envFile, "utf8");
    for (const rawLine of text.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const assignment = line.replace(/^export\s+/u, "");
      const idx = assignment.indexOf("=");
      if (idx <= 0) continue;
      const key = assignment.slice(0, idx).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue;
      env[key] = parseEnvValue(assignment.slice(idx + 1));
    }
    return env;
  } catch {
    return {};
  }
}

function parseEnvValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const quote = raw[0];
  if (quote !== "'" && quote !== '"') return stripInlineComment(raw);

  let out = "";
  for (let i = 1; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === quote) return out;
    if (quote === '"' && char === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else if (next === "t") out += "\t";
      else out += next;
      i += 1;
      continue;
    }
    out += char;
  }
  return out;
}

function stripInlineComment(raw) {
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== "#") continue;
    const prev = raw[i - 1];
    if (prev === " " || prev === "\t") return raw.slice(0, i).trimEnd();
  }
  return raw.trimEnd();
}

function commandEnv(config) {
  const fileEnv = readEnvFile(config.envFile);
  const bunBin = join(homedir(), ".bun", "bin");
  // Match core gbrain.env precedence: runtime/OpenClaw env wins, and the
  // optional file only fills missing values for spawned helper commands.
  const basePath = process.env.PATH ?? fileEnv.PATH ?? "";
  return {
    ...fileEnv,
    ...process.env,
    BUN_INSTALL: process.env.BUN_INSTALL ?? fileEnv.BUN_INSTALL ?? join(homedir(), ".bun"),
    PATH: prependPathEntry(basePath, bunBin),
  };
}

function prependPathEntry(pathValue, entry) {
  const parts = String(pathValue || "")
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  return [entry, ...parts.filter((part) => part !== entry)].join(":");
}

function runCommand(command, args, config, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: config.workingDir,
      env: commandEnv(config),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const maxBytes = options.maxBytes ?? 256_000;
    let timedOut = false;
    const timeoutMs = clampTimeoutMs(options.timeoutMs, config.timeoutMs);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2_000).unref();
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-maxBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-maxBytes);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr: timedOut ? `Command timed out after ${timeoutMs}ms.` : stderr,
        timedOut,
      });
    });
  });
}

function runGbrain(config, args, options = {}) {
  return runCommand(config.gbrainBin, args, config, options);
}

function runOpenClaw(config, args, options = {}) {
  return runCommand(config.openclawBin, args, config, options);
}

function acquireExtractionSlot(config) {
  if (activeExtractions < config.maxConcurrentExtractions) {
    return startExtraction(config);
  }
  if (config.extractionQueueLimit <= 0 || extractionQueue.length >= config.extractionQueueLimit) {
    throw new RequestError(
      429,
      "extraction_busy",
      "GBrain extraction is busy. Retry shortly.",
    );
  }
  return new Promise((resolve, reject) => {
    const queued = {
      config,
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = extractionQueue.indexOf(queued);
        if (index >= 0) extractionQueue.splice(index, 1);
        reject(
          new RequestError(
            429,
            "extraction_queue_timeout",
            "GBrain extraction queue timed out. Retry shortly.",
          ),
        );
      }, config.extractionQueueTimeoutMs),
    };
    queued.timer.unref?.();
    extractionQueue.push(queued);
  });
}

async function startExtraction(config) {
  activeExtractions += 1;
  try {
    await waitForExtractionInterval(config);
  } catch (error) {
    releaseExtractionSlot();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseExtractionSlot();
  };
}

function releaseExtractionSlot() {
  activeExtractions = Math.max(0, activeExtractions - 1);
  drainExtractionQueue();
}

function drainExtractionQueue() {
  for (let index = 0; index < extractionQueue.length; index += 1) {
    const queued = extractionQueue[index];
    if (activeExtractions >= queued.config.maxConcurrentExtractions) return;
    extractionQueue.splice(index, 1);
    index -= 1;
    clearTimeout(queued.timer);
    startExtraction(queued.config).then(queued.resolve, queued.reject);
  }
}

async function waitForExtractionInterval(config) {
  const gate = extractionStartGate.then(async () => {
    if (config.minExtractionIntervalMs > 0) {
      const earliestStart = lastExtractionStartedAt + config.minExtractionIntervalMs;
      const waitMs = Math.max(0, earliestStart - Date.now());
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    lastExtractionStartedAt = Date.now();
  });
  extractionStartGate = gate.catch(() => {});
  await gate;
}

async function handleExtractionRoute(config, req, res) {
  if (req.method !== "POST") {
    writeJson(res, 405, { ok: false, error: "method_not_allowed" });
    return true;
  }

  let tempDir;
  let releaseSlot;
  try {
    const body = await readJsonBody(req, requestBodyLimitBytes(config.maxExtractionFileBytes));
    const request = readExtractionRequest(body);
    const kind = normalizeMediaKind(request.kind);
    const sourceRef = normalizeRequiredString(request.sourceRef, "sourceRef");
    const title = normalizeOptionalString(request.title);
    const text = normalizeOptionalString(request.text);
    const image = readImageInput(request, config);
    if (!text && !image) {
      throw new RequestError(400, "missing_content", "Provide text or file.base64.");
    }
    if (kind !== "image" && !text) {
      throw new RequestError(
        400,
        "missing_text",
        "Video, audio, and document MVP extraction requires text or transcript content.",
      );
    }
    releaseSlot = await acquireExtractionSlot(config);

    const args = [
      "infer",
      "model",
      "run",
      "--local",
      "--model",
      resolveExtractionModel(request.model, config.extractionModel),
      "--prompt",
      buildExtractionPrompt({ kind, sourceRef, title, text, hasImage: Boolean(image) }),
      "--json",
    ];
    if (image) {
      tempDir = await mkdtemp(join(tmpdir(), "gbrain-extract-"));
      const imagePath = join(tempDir, image.name);
      await writeFile(imagePath, Buffer.from(image.base64, "base64"));
      args.push("--file", imagePath);
    }

    const result = await runOpenClaw(config, args, {
      maxBytes: 512_000,
      timeoutMs: readTimeoutMs(request.timeoutMs, config.timeoutMs),
    });
    if (!result.ok) {
      throw new Error(result.stderr || result.stdout || "OpenClaw model run failed.");
    }
    const cliJson = parseJsonObject(result.stdout);
    if (cliJson.ok !== true) {
      throw new Error("OpenClaw model run returned an unsuccessful response.");
    }
    const modelText = readModelRunText(cliJson);
    const extraction = normalizeExtraction({
      parsed: parseJsonObject(modelText),
      kind,
      sourceRef,
      title,
    });
    writeJson(res, 200, {
      ok: true,
      protocol: "gbrain.media-extraction.v1",
      provider: "openai-codex",
      model: resolveExtractionModel(request.model, config.extractionModel),
      extraction,
    });
    return true;
  } catch (error) {
    if (error instanceof RequestError) {
      writeJson(res, error.statusCode, {
        ok: false,
        error: error.code,
        message: error.message,
      });
      return true;
    }
    writeJson(res, 502, {
      ok: false,
      error: "extraction_failed",
      message: "OpenClaw OAuth-backed extraction failed.",
    });
    return true;
  } finally {
    if (releaseSlot) releaseSlot();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

function resolveExtractionModel(requested, fallback) {
  const model = normalizeOptionalString(requested) ?? fallback;
  const resolved = model.includes("/") ? model : `openai-codex/${model}`;
  if (!resolved.startsWith("openai-codex/") || resolved.slice("openai-codex/".length).trim() === "") {
    throw new RequestError(
      400,
      "invalid_model",
      "GBrain extraction only supports openai-codex/* models through the OpenClaw OAuth runtime.",
    );
  }
  return resolved;
}

function buildExtractionPrompt(params) {
  const segmentKind =
    params.kind === "image"
      ? "frame"
      : params.kind === "video"
        ? "transcript_segment"
        : params.kind === "audio"
          ? "audio_segment"
          : "page";
  const parts = [
    "Return only JSON matching this TypeScript shape:",
    "{ schemaVersion:'gbrain.media-extraction.v1', kind:'image'|'pdf'|'video'|'audio', sourceRef:string, title?:string, summary?:string, tags?:string[], entities?:{text:string,type?:string}[], segments:{id:string, kind:'asset'|'page'|'frame'|'transcript_segment'|'audio_segment', label?:string, summary?:string, caption?:string, ocrText?:string, transcriptText?:string, tags?:string[], entities?:{text:string,type?:string}[]}[] }",
    "",
    `kind: ${params.kind}`,
    `sourceRef: ${params.sourceRef}`,
    `preferred segment kind: ${segmentKind}`,
  ];
  if (params.title) parts.push(`title: ${params.title}`);
  if (params.hasImage) {
    parts.push(
      "Analyze the attached image. Categorize it, summarize it, add searchable tags, extract visible text into ocrText, and list visible entities when identifiable.",
    );
  }
  if (params.text) parts.push("Text/transcript content:", params.text);
  return parts.join("\n");
}

function normalizeExtraction(params) {
  const candidate = isRecord(params.parsed.extraction) ? params.parsed.extraction : params.parsed;
  const summary = normalizeOptionalString(candidate.summary);
  const extraction = {
    schemaVersion: "gbrain.media-extraction.v1",
    kind: params.kind,
    sourceRef: params.sourceRef,
    ...(params.title ? { title: params.title } : {}),
    ...(summary ? { summary } : {}),
    tags: normalizeStringArray(candidate.tags),
    entities: normalizeEntities(candidate.entities),
    segments: normalizeSegments(candidate.segments, params.kind, summary),
  };
  const returnedTitle = normalizeOptionalString(candidate.title);
  if (returnedTitle && !extraction.title) extraction.title = returnedTitle;
  return extraction;
}

function normalizeSegments(value, kind, fallbackSummary) {
  const source = Array.isArray(value) ? value : [];
  const segments = source.filter(isRecord).map((segment, index) => {
    const segmentKind =
      normalizeSegmentKind(segment.kind) ??
      (kind === "image"
        ? "frame"
        : kind === "video"
          ? "transcript_segment"
          : kind === "audio"
            ? "audio_segment"
            : "page");
    const normalized = {
      id: normalizeOptionalString(segment.id) ?? `${segmentKind}-${index + 1}`,
      kind: segmentKind,
      tags: normalizeStringArray(segment.tags),
      entities: normalizeEntities(segment.entities),
    };
    for (const key of ["label", "summary", "caption", "ocrText", "transcriptText"]) {
      const stringValue = normalizeOptionalString(segment[key]);
      if (stringValue) normalized[key] = stringValue;
    }
    const ocr = normalizeOptionalString(segment.ocr);
    const transcript = normalizeOptionalString(segment.transcript);
    if (ocr && !normalized.ocrText) normalized.ocrText = ocr;
    if (transcript && !normalized.transcriptText) normalized.transcriptText = transcript;
    return normalized;
  });
  if (segments.length > 0) return segments;
  return [
    {
      id: "asset-1",
      kind:
        kind === "image"
          ? "frame"
          : kind === "video"
            ? "transcript_segment"
            : kind === "audio"
              ? "audio_segment"
              : "page",
      ...(fallbackSummary ? { summary: fallbackSummary } : {}),
      tags: [],
      entities: [],
    },
  ];
}

function normalizeEntities(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((entity) => {
    const text = normalizeOptionalString(entity.text ?? entity.name);
    if (!text) return [];
    const type = normalizeOptionalString(entity.type ?? entity.kind);
    return [{ text, ...(type ? { type } : {}) }];
  });
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean),
    ),
  ];
}

function normalizeSegmentKind(value) {
  const kind = normalizeOptionalString(value);
  return ["asset", "page", "frame", "transcript_segment", "audio_segment"].includes(kind)
    ? kind
    : undefined;
}

function readModelRunText(value) {
  const outputs = Array.isArray(value.outputs) ? value.outputs : [];
  const text = outputs
    .filter(isRecord)
    .map((output) => normalizeOptionalString(output.text))
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (!text) throw new Error("OpenClaw model run returned no text.");
  return text;
}

function readExtractionRequest(value) {
  if (!isRecord(value)) {
    throw new RequestError(400, "invalid_json", "Request body must be a JSON object.");
  }
  return value;
}

function readImageInput(request, config) {
  const file = isRecord(request.file) ? request.file : undefined;
  const base64 = normalizeOptionalString(file?.base64);
  if (!base64) return undefined;
  const normalizedBase64 = normalizeBase64Payload(base64);
  const decodedBytes = decodedBase64ByteLength(normalizedBase64);
  if (decodedBytes > config.maxExtractionFileBytes) {
    throw new RequestError(
      413,
      "file_too_large",
      `GBrain extraction file is too large (${decodedBytes} bytes, max ${config.maxExtractionFileBytes}).`,
    );
  }
  return {
    base64: normalizedBase64,
    name: sanitizeFileName(normalizeOptionalString(file.name) ?? "image.png"),
    decodedBytes,
  };
}

function requestBodyLimitBytes(maxExtractionFileBytes) {
  return Math.min(
    MAX_BODY_BYTES,
    Math.max(DEFAULT_MAX_BODY_BYTES, Math.ceil((maxExtractionFileBytes * 4) / 3) + 512_000),
  );
}

function normalizeBase64Payload(value) {
  const trimmed = value.trim();
  const dataUrl = trimmed.match(/^data:[^,]+;base64,(.+)$/su);
  const compact = (dataUrl ? dataUrl[1] : trimmed).replace(/\s+/gu, "");
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)) {
    throw new RequestError(400, "invalid_file_base64", "file.base64 must be valid base64.");
  }
  return compact;
}

function decodedBase64ByteLength(base64) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function sanitizeFileName(value) {
  const clean = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return clean || "image.png";
}

function normalizeMediaKind(value) {
  const kind = normalizeOptionalString(value) ?? "image";
  if (["image", "pdf", "video", "audio"].includes(kind)) return kind;
  throw new RequestError(400, "invalid_kind", "kind must be image, pdf, video, or audio.");
}

function normalizeRequiredString(value, field) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new RequestError(400, `missing_${field}`, `${field} is required.`);
  return normalized;
}

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text));
    if (isRecord(parsed)) return parsed;
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/u);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (isRecord(parsed)) return parsed;
    }
  }
  throw new Error("Expected a JSON object.");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function writeJson(res, statusCode, value) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new RequestError(413, "body_too_large", "Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new RequestError(400, "invalid_json", "Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

class RequestError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export default definePluginEntry({
  id: "gbrain",
  name: "GBrain",
  description: "GBrain search, query, and media extraction.",
  register(api) {
    const config = readConfig(api.pluginConfig);

    api.registerHttpRoute({
      path: GBRAIN_ROUTE_PATH,
      auth: "gateway",
      match: "exact",
      handler: (req, res) => handleExtractionRoute(config, req, res),
    });

    api.registerTool(
      {
        name: "gbrain_status",
        description: "Check the local GBrain installation status.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          const version = await runGbrain(config, ["--version"]);
          const sources = await runGbrain(config, ["sources", "list"], { maxBytes: 24_000 });
          return textResult(
            [
              version.ok ? version.stdout.trim() : `gbrain version failed: ${version.stderr.trim()}`,
              "",
              sources.ok ? sources.stdout.trim() : `gbrain sources failed: ${sources.stderr.trim()}`,
            ].join("\n"),
            { version, sources },
          );
        },
      },
      { name: "gbrain_status" },
    );

    api.registerTool(
      {
        name: "gbrain_search",
        description: "Search the local GBrain index.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
          },
        },
        execute: async (_toolCallId, params) => {
          const query = typeof params?.query === "string" ? params.query.trim() : "";
          const limit = Number.isFinite(params?.limit)
            ? Math.max(1, Math.min(20, Math.floor(params.limit)))
            : 5;
          if (!query) return textResult("Missing required query.", { ok: false });
          const result = await runGbrain(config, ["search", query, "--limit", String(limit)]);
          return textResult(result.ok ? result.stdout.trim() : result.stderr.trim(), result);
        },
      },
      { name: "gbrain_search" },
    );

    api.registerTool(
      {
        name: "gbrain_query",
        description: "Ask a question against the local GBrain index.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["question"],
          properties: {
            question: { type: "string" },
          },
        },
        execute: async (_toolCallId, params) => {
          const question = typeof params?.question === "string" ? params.question.trim() : "";
          if (!question) return textResult("Missing required question.", { ok: false });
          const result = await runGbrain(config, ["query", question]);
          return textResult(result.ok ? result.stdout.trim() : result.stderr.trim(), result);
        },
      },
      { name: "gbrain_query" },
    );

    api.registerCli(
      ({ program }) => {
        const gbrain = program.command("gbrain").description("GBrain commands");
        gbrain
          .command("status")
          .description("Check the local GBrain installation")
          .action(async () => {
            const result = await runGbrain(config, ["--version"]);
            if (result.ok) {
              console.log(result.stdout.trim());
            } else {
              console.error(result.stderr.trim() || "gbrain status failed");
              process.exitCode = 1;
            }
          });
      },
      {
        descriptors: [
          {
            name: "gbrain",
            description: "GBrain commands",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
