/**
 * SkillOpt write-flavored skill optimization via mocked-write capture (F10).
 *
 * v1 SkillOpt rollouts use a read-only tool allowlist (D13). That works
 * for read-flavored skills (search-then-summarize, query-then-render) but
 * breaks for skills whose job IS to write — `put_page`, `submit_job`,
 * `file_upload`. F10 closes the gap: enable `--write-capture` and the
 * rollout's `put_page` calls land in an in-memory virtual brain rather
 * than persisting to the user's real DB. The judge sees the captured
 * virtual writes (slugs, frontmatter, body) and scores accordingly.
 *
 * Hermetic by construction: virtual writes never touch the engine.
 * Idempotent at the slug level — repeated put_page for the same slug
 * within a single rollout updates the virtual record (matches real
 * put_page behavior).
 *
 * Trajectory tool_calls keeps the put_page entries so `judge: rule` checks
 * like `tool_called('put_page')` work; the captured page contents are
 * surfaced as the tool output for downstream judges (LLM rubric can see
 * the proposed page text and grade it).
 */

import type { ChatToolDef, ToolHandler } from '../ai/gateway.ts';
import { operations, type OperationContext, type ParamDef } from '../operations.ts';
import { paramDefToSchema } from '../../mcp/tool-defs.ts';
import { loadConfig } from '../config.ts';
import { BRAIN_TOOL_ALLOWLIST } from '../minions/tools/brain-allowlist.ts';
import type { BrainEngine } from '../engine.ts';

/**
 * A single captured write from a write-flavored rollout. Persists in
 * memory for the duration of one rollout (re-created per task).
 */
export interface CapturedWrite {
  op: 'put_page' | 'submit_job' | 'file_upload';
  /** Captured slug (for put_page) or job name (for submit_job). */
  key: string;
  /** Full input object to the op. */
  input: Record<string, unknown>;
  /** Order of write within the rollout. */
  ordinal: number;
}

export interface WriteCaptureRegistry {
  /** Read-only base tool defs (search/query/get_page/etc). */
  baseDefs: ChatToolDef[];
  /** Read-only base handlers. */
  baseHandlers: Map<string, ToolHandler>;
  /** Capture-mode tool defs (adds put_page + submit_job + file_upload with virtual semantics). */
  defs: ChatToolDef[];
  /** Capture-mode handlers (adds the virtual write handlers). */
  handlers: Map<string, ToolHandler>;
  /** Read-only access to the captured writes for this rollout. */
  getWrites(): readonly CapturedWrite[];
  /** Read-only access to the in-memory virtual brain (slug -> CapturedWrite). */
  getVirtualPages(): ReadonlyMap<string, CapturedWrite>;
}

const WRITE_OPS: ReadonlySet<string> = new Set(['put_page', 'submit_job', 'file_upload']);

/**
 * Build a write-capture registry. Each call returns a FRESH capture set;
 * the orchestrator should create one per rollout so writes don't leak
 * across tasks within the same batch.
 */
export function buildWriteCaptureRegistry(engine: BrainEngine): WriteCaptureRegistry {
  const writes: CapturedWrite[] = [];
  const virtualPages = new Map<string, CapturedWrite>();
  let nextOrdinal = 0;

  const ctx = buildOpContext(engine);
  const baseDefs: ChatToolDef[] = [];
  const baseHandlers = new Map<string, ToolHandler>();

  // Build the read-only base (same shape as rollout.ts uses).
  for (const op of operations) {
    if (!BRAIN_TOOL_ALLOWLIST.has(op.name)) continue;
    if (WRITE_OPS.has(op.name)) continue; // skip write ops; virtual versions land below
    const toolName = `brain_${op.name}`;
    baseDefs.push({
      name: toolName,
      description: op.description,
      inputSchema: paramsToSchema(op.params),
    });
    baseHandlers.set(toolName, {
      idempotent: true,
      execute: async (input: unknown) => op.handler(ctx, (input as Record<string, unknown>) ?? {}),
    });
  }

  // Virtual put_page. Captures the write; returns the slug + 'virtual: true'
  // so the agent's loop knows the write succeeded (or thinks it did) AND
  // the judge can see it was a virtual write.
  const defs = [...baseDefs];
  const handlers = new Map(baseHandlers);
  defs.push({
    name: 'brain_put_page',
    description: '[write-capture mode] Write a page to the brain. In write-capture mode, the write is captured in-memory for judge inspection but NOT persisted.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Page slug' },
        content: { type: 'string', description: 'Markdown body' },
        type: { type: 'string', description: 'Page type (optional)' },
        frontmatter: { type: 'object', description: 'YAML frontmatter (optional)' },
      },
      required: ['slug', 'content'],
    },
  });
  handlers.set('brain_put_page', {
    idempotent: true,
    execute: async (input: unknown) => {
      const i = (input as Record<string, unknown>) ?? {};
      const slug = String(i.slug ?? '');
      if (!slug) throw new Error('virtual put_page: slug required');
      const captured: CapturedWrite = {
        op: 'put_page',
        key: slug,
        input: i,
        ordinal: nextOrdinal++,
      };
      writes.push(captured);
      virtualPages.set(slug, captured);
      return { ok: true, virtual: true, slug, note: 'Captured by SkillOpt write-capture mode; not persisted.' };
    },
  });
  defs.push({
    name: 'brain_submit_job',
    description: '[write-capture mode] Submit a Minion job. Captured in-memory; not actually submitted.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Job name' },
        params: { type: 'object', description: 'Job params (optional)' },
      },
      required: ['name'],
    },
  });
  handlers.set('brain_submit_job', {
    idempotent: true,
    execute: async (input: unknown) => {
      const i = (input as Record<string, unknown>) ?? {};
      const name = String(i.name ?? '');
      if (!name) throw new Error('virtual submit_job: name required');
      const captured: CapturedWrite = {
        op: 'submit_job',
        key: name,
        input: i,
        ordinal: nextOrdinal++,
      };
      writes.push(captured);
      return { ok: true, virtual: true, job_name: name, note: 'Captured by SkillOpt write-capture mode; not submitted.' };
    },
  });
  defs.push({
    name: 'brain_file_upload',
    description: '[write-capture mode] Upload a file to brain storage. Captured in-memory; nothing written to disk.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Local file path' },
        page_slug: { type: 'string', description: 'Associate with page (optional)' },
      },
      required: ['path'],
    },
  });
  handlers.set('brain_file_upload', {
    idempotent: true,
    execute: async (input: unknown) => {
      const i = (input as Record<string, unknown>) ?? {};
      const filePath = String(i.path ?? '');
      if (!filePath) throw new Error('virtual file_upload: path required');
      const captured: CapturedWrite = {
        op: 'file_upload',
        key: filePath,
        input: i,
        ordinal: nextOrdinal++,
      };
      writes.push(captured);
      return { ok: true, virtual: true, path: filePath, note: 'Captured by SkillOpt write-capture mode; nothing uploaded.' };
    },
  });

  return {
    baseDefs,
    baseHandlers,
    defs,
    handlers,
    getWrites: () => writes,
    getVirtualPages: () => virtualPages,
  };
}

function buildOpContext(engine: BrainEngine): OperationContext {
  const cfg = loadConfig();
  return {
    engine,
    config: cfg ?? ({} as never),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    dryRun: false,
    remote: true,
    sourceId: 'default',
  };
}

function paramsToSchema(params: Record<string, ParamDef>): Record<string, unknown> {
  return {
    type: 'object' as const,
    properties: Object.fromEntries(
      // Canonical ParamDef→JSON Schema mapper (shared with subagent + MCP + HTTP)
      // so enum/default/items survive. Prior {type,description}-only map dropped them.
      Object.entries(params).map(([k, v]) => [k, paramDefToSchema(v)]),
    ),
    required: Object.entries(params).filter(([, v]) => v.required).map(([k]) => k),
  };
}
