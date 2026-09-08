/**
 * Opt-in LLM/RAG tracing → Arize Phoenix and/or Langfuse (dual-export; either,
 * both, or neither can be active).
 *
 * Enabled when `GBRAIN_TRACING=1|true`, an OTLP/Phoenix endpoint is set, or a
 * Langfuse key pair is set. When disabled (the default), every helper here is
 * a no-op — no provider is registered, no exporter is created, and the hot
 * path pays only a boolean check.
 *
 * PRIVACY: unlike `mcp_request_log` (which stores redacted param shapes),
 * spans deliberately carry FULL queries, prompts, and retrieved document
 * content — that is the point of a trace debugger. Only enable against a
 * collector you control (see docs/operations/tracing.md). Values are
 * truncated to MAX_ATTR_CHARS to bound span size, never redacted.
 *
 * Span vocabulary is OpenInference (https://github.com/Arize-ai/openinference)
 * so Phoenix renders LLM / RETRIEVER / RERANKER / TOOL / AGENT spans with
 * their specialized UIs. The attribute names are stable public constants;
 * they are inlined here rather than pulling in another dependency.
 *
 * Env (Phoenix / generic OTLP):
 *   GBRAIN_TRACING=1                     force-enable (endpoint defaults to Phoenix local)
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:6006   collector base URL (no /v1/traces suffix)
 *   PHOENIX_COLLECTOR_ENDPOINT           alias, same semantics
 *   PHOENIX_PROJECT_NAME=gbrain          Phoenix project the traces land in
 *   PHOENIX_API_KEY                      bearer credential for an auth-gated collector
 *
 * Env (Langfuse):
 *   LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY   both required together — this
 *     pair is the enable predicate (mirrors PHOENIX_COLLECTOR_ENDPOINT above);
 *     there is no separate LANGFUSE_ENABLED flag to drift out of sync with it
 *   LANGFUSE_BASE_URL=https://cloud.langfuse.com   collector base URL (no
 *     `/api/public/otel/v1/traces` suffix); point at a self-hosted instance's
 *     URL instead when running Langfuse yourself
 */

import { trace, context, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { resourceFromAttributes } from '@opentelemetry/resources';

/** OpenInference span kinds Phoenix knows how to render. */
export type OISpanKind =
  | 'CHAIN'
  | 'LLM'
  | 'RETRIEVER'
  | 'RERANKER'
  | 'EMBEDDING'
  | 'TOOL'
  | 'AGENT';

const OI = {
  spanKind: 'openinference.span.kind',
  input: 'input.value',
  inputMime: 'input.mime_type',
  output: 'output.value',
  outputMime: 'output.mime_type',
  projectName: 'openinference.project.name',
} as const;

/** Cap per-attribute payloads so a huge prompt can't balloon the export. */
const MAX_ATTR_CHARS = 16_000;
/** How many retrieved documents to attach to a RETRIEVER span. */
const MAX_TRACE_DOCS = 25;
/** Per-document content cap on RETRIEVER spans. */
const MAX_DOC_CHARS = 1_500;

export type AttrValue = string | number | boolean;

export interface SpanHandle {
  setAttribute(key: string, value: AttrValue): void;
  setAttributes(attrs: Record<string, AttrValue | undefined>): void;
  addEvent(name: string, attrs?: Record<string, AttrValue | undefined>): void;
  /** Sets `output.value` (stringified + truncated). */
  setOutput(value: unknown): void;
}

const NOOP_HANDLE: SpanHandle = {
  setAttribute: () => {},
  setAttributes: () => {},
  addEvent: () => {},
  setOutput: () => {},
};

let _initialized = false;
let _provider: BasicTracerProvider | null = null;
let _tracer: Tracer | null = null;

function readEnabled(): boolean {
  const flag = (process.env.GBRAIN_TRACING ?? '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  if (flag === '1' || flag === 'true' || flag === 'on') return true;
  return Boolean(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      process.env.PHOENIX_COLLECTOR_ENDPOINT ||
      langfuseReady(),
  );
}

function collectorBaseUrl(): string {
  const raw =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    process.env.PHOENIX_COLLECTOR_ENDPOINT ||
    'http://localhost:6006';
  return raw.replace(/\/+$/, '');
}

/**
 * True once both halves of the Langfuse key pair are present — the pair, not
 * a separate `LANGFUSE_ENABLED` flag, is the enable signal (see module doc).
 * Takes `env` as a parameter so it's testable as a pure function, same as
 * `buildExporterHeaders`.
 */
export function langfuseReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean((env.LANGFUSE_PUBLIC_KEY ?? '').trim() && (env.LANGFUSE_SECRET_KEY ?? '').trim());
}

/**
 * Langfuse's OTLP ingestion endpoint + Basic-auth header (base64 of
 * `publicKey:secretKey`) — distinct from Phoenix's bearer-token scheme in
 * `buildExporterHeaders`, so the two backends cannot be configured through
 * the same env shape. Callers must check `langfuseReady(env)` first — this
 * builds a header from whatever key halves are present, blank or not.
 */
export function langfuseExporterConfig(
  env: NodeJS.ProcessEnv = process.env,
): { url: string; headers: Record<string, string> } {
  const baseUrl = (env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com').replace(/\/+$/, '');
  const auth = Buffer.from(
    `${(env.LANGFUSE_PUBLIC_KEY ?? '').trim()}:${(env.LANGFUSE_SECRET_KEY ?? '').trim()}`,
  ).toString('base64');
  return {
    url: `${baseUrl}/api/public/otel/v1/traces`,
    headers: { Authorization: `Basic ${auth}` },
  };
}

/**
 * Credential headers for the OTLP exporter.
 *
 * A Phoenix deployment with auth enabled rejects every unauthenticated
 * `POST /v1/traces` with 401 — and the exporter swallows that, so the failure
 * mode is silence: tracing looks ON (banner printed, spans created) while the
 * collector holds zero data. `PHOENIX_API_KEY` closes that gap.
 *
 * Deliberately NOT part of `readEnabled()`: possessing a key is not intent to
 * trace. Spans carry full prompts and documents (see the PRIVACY note above),
 * so turning export on stays an explicit act (`GBRAIN_TRACING` / an endpoint).
 *
 * `Authorization: Bearer <key>` is what the Phoenix OTel distro sends, but the
 * header a given Phoenix build accepts is not verifiable from here. The escape
 * hatch is to leave `PHOENIX_API_KEY` unset: this returns undefined, no
 * `headers` are passed to the exporter at all, and the SDK's own
 * `OTEL_EXPORTER_OTLP_HEADERS` parsing runs untouched — so an operator can
 * spell any header they need through env, with no code change or redeploy.
 *
 * Takes `env` as a parameter so the mapping is testable as a pure function —
 * no `process.env` mutation, no interaction with the lazy-init latch.
 */
export function buildExporterHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const key = (env.PHOENIX_API_KEY ?? '').trim();
  if (!key) return undefined;
  return { Authorization: `Bearer ${key}` };
}

/**
 * Lazily register the global tracer provider on first span. Lazy (rather
 * than an explicit init call at each entrypoint) so every surface — stdio
 * MCP, HTTP MCP, one-shot CLI commands, eval harnesses — gets tracing from
 * the same single seam without startup wiring.
 */
function ensureTracer(): Tracer | null {
  if (_initialized) return _tracer;
  _initialized = true;
  if (!readEnabled()) return null;
  try {
    // Phoenix stays wired exactly as before — forced by GBRAIN_TRACING or an
    // explicit endpoint — so existing single-backend deployments see no
    // behavior change. Langfuse is purely additive: it engages only when its
    // own key pair is present, independent of the Phoenix env.
    const flag = (process.env.GBRAIN_TRACING ?? '').trim().toLowerCase();
    const phoenixWanted =
      ['1', 'true', 'on'].includes(flag) ||
      Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.PHOENIX_COLLECTOR_ENDPOINT);
    const langfuseWanted = langfuseReady();

    const spanProcessors: BatchSpanProcessor[] = [];
    const banners: string[] = [];

    if (phoenixWanted) {
      const headers = buildExporterHeaders();
      const exporter = new OTLPTraceExporter({
        url: `${collectorBaseUrl()}/v1/traces`,
        ...(headers ? { headers } : {}),
      });
      spanProcessors.push(new BatchSpanProcessor(exporter));
      // `auth=` is the diagnostic that distinguishes "exporting into a 401"
      // from a genuine transport problem. The key itself is never printed.
      banners.push(
        `phoenix=${collectorBaseUrl()}/v1/traces (project=${process.env.PHOENIX_PROJECT_NAME ?? 'gbrain'}, auth=${headers ? 'bearer' : 'none'})`,
      );
    }
    if (langfuseWanted) {
      const { url, headers } = langfuseExporterConfig();
      spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url, headers })));
      banners.push(`langfuse=${url} (auth=basic)`);
    }
    if (spanProcessors.length === 0) return null;

    _provider = new BasicTracerProvider({
      resource: resourceFromAttributes({
        'service.name': 'gbrain',
        [OI.projectName]: process.env.PHOENIX_PROJECT_NAME ?? 'gbrain',
      }),
      spanProcessors,
    });
    trace.setGlobalTracerProvider(_provider);
    const cm = new AsyncLocalStorageContextManager();
    cm.enable();
    context.setGlobalContextManager(cm);
    _tracer = trace.getTracer('gbrain');
    // One-shot CLI commands exit before the 5s batch flush; drain on exit.
    process.on('beforeExit', () => {
      void _provider?.forceFlush().catch(() => {});
    });
    process.stderr.write(
      `[tracing] ON → ${banners.join(', ')}. Spans carry full queries/prompts/documents.\n`,
    );
  } catch (e) {
    _tracer = null;
    process.stderr.write(
      `[tracing] failed to initialize OTLP tracing (disabled): ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
  return _tracer;
}

export function isTracingEnabled(): boolean {
  return ensureTracer() !== null;
}

/**
 * Test seam — install an explicit tracer so tests can observe the attributes
 * spans actually carry, without an OTLP collector or env mutation.
 *
 * Needed because `withSpan` short-circuits to a no-op handle whenever tracing
 * is off (the default in tests). Without this, every assertion about span
 * content is really an assertion about a pure helper, and the wiring between
 * the helper and the exported span goes untested.
 *
 * Pass `null` to restore lazy env-driven initialization.
 */
export function __setTracerForTests(tracer: Tracer | null): void {
  _tracer = tracer;
  // Leaving `_initialized` true on reset would pin tracing off for the rest of
  // the process; clearing it lets the normal env probe run again.
  _initialized = tracer !== null;
}

/** Flush pending spans (best-effort). Call before hard process exits. */
export async function flushTracing(): Promise<void> {
  try {
    await _provider?.forceFlush();
  } catch {
    // Tracing must never break shutdown.
  }
}

export function truncateForTrace(value: unknown, max = MAX_ATTR_CHARS): string {
  let s: string;
  if (typeof value === 'string') s = value;
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s;
}

function wrapSpan(span: Span): SpanHandle {
  return {
    setAttribute(key, value) {
      try {
        span.setAttribute(key, typeof value === 'string' ? truncateForTrace(value) : value);
      } catch { /* tracing must never throw into the hot path */ }
    },
    setAttributes(attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v !== undefined) this.setAttribute(k, v);
      }
    },
    addEvent(name, attrs) {
      try {
        const clean: Record<string, AttrValue> = {};
        for (const [k, v] of Object.entries(attrs ?? {})) {
          if (v !== undefined) clean[k] = typeof v === 'string' ? truncateForTrace(v) : v;
        }
        span.addEvent(name, clean);
      } catch { /* ignore */ }
    },
    setOutput(value) {
      try {
        span.setAttribute(OI.output, truncateForTrace(value));
        span.setAttribute(OI.outputMime, typeof value === 'string' ? 'text/plain' : 'application/json');
      } catch { /* ignore */ }
    },
  };
}

export interface SpanOpts {
  kind: OISpanKind;
  /** Stringified into `input.value` (truncated). */
  input?: unknown;
  attributes?: Record<string, AttrValue | undefined>;
}

/**
 * Run `fn` inside an active span. Children created within `fn` (including
 * spans opened by awaited callees) nest under it via AsyncLocalStorage
 * context. No-op passthrough when tracing is disabled. Errors are recorded
 * on the span and rethrown — withSpan never swallows.
 */
export async function withSpan<T>(
  name: string,
  opts: SpanOpts,
  fn: (span: SpanHandle) => Promise<T>,
): Promise<T> {
  const tracer = ensureTracer();
  if (!tracer) return fn(NOOP_HANDLE);
  return tracer.startActiveSpan(name, async (span) => {
    const handle = wrapSpan(span);
    try {
      span.setAttribute(OI.spanKind, opts.kind);
      if (opts.input !== undefined) {
        span.setAttribute(OI.input, truncateForTrace(opts.input));
        span.setAttribute(OI.inputMime, typeof opts.input === 'string' ? 'text/plain' : 'application/json');
      }
      handle.setAttributes(opts.attributes ?? {});
    } catch { /* attribute failures must not skip fn */ }
    try {
      const result = await fn(handle);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (e) {
      try {
        span.recordException(e instanceof Error ? e : new Error(String(e)));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: e instanceof Error ? e.message : String(e),
        });
      } catch { /* ignore */ }
      throw e;
    } finally {
      span.end();
    }
  });
}

/** Attach an event to whatever span is currently active (no-op when none). */
export function addSpanEvent(name: string, attrs?: Record<string, AttrValue | undefined>): void {
  if (!ensureTracer()) return;
  const span = trace.getActiveSpan();
  if (!span) return;
  try {
    const clean: Record<string, AttrValue> = {};
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (v !== undefined) clean[k] = typeof v === 'string' ? truncateForTrace(v) : v;
    }
    span.addEvent(name, clean);
  } catch { /* ignore */ }
}

export interface TraceDocument {
  id: string;
  content: string;
  score?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * OpenInference `retrieval.documents.{i}.document.*` attributes — Phoenix
 * renders these as an inspectable document list on RETRIEVER spans.
 */
export function retrievalDocumentAttributes(
  docs: TraceDocument[],
): Record<string, AttrValue> {
  const attrs: Record<string, AttrValue> = {};
  const n = Math.min(docs.length, MAX_TRACE_DOCS);
  for (let i = 0; i < n; i++) {
    const d = docs[i]!;
    const p = `retrieval.documents.${i}.document`;
    attrs[`${p}.id`] = d.id;
    attrs[`${p}.content`] = truncateForTrace(d.content ?? '', MAX_DOC_CHARS);
    if (typeof d.score === 'number' && Number.isFinite(d.score)) attrs[`${p}.score`] = d.score;
    if (d.metadata) attrs[`${p}.metadata`] = truncateForTrace(d.metadata, 1_000);
  }
  return attrs;
}
