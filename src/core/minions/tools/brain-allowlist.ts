/**
 * Derive the subagent brain-tool registry from src/core/operations.ts.
 *
 * Single source of truth: the MCP server already maps OPERATIONS → tool defs.
 * We reuse the same ParamDef-shape → JSONSchema conversion (lives in
 * buildToolDefs for MCP) and wrap each allowed op with an execute() that
 * invokes its handler under a subagent-tagged OperationContext.
 *
 * Filtering is NAME-based (not by OperationContext.remote, which is a
 * call-time flag, not operation metadata — codex catch). The allow-list
 * below is reviewed manually; adding a new op here is an explicit security
 * decision.
 *
 * put_page: allowed, but the subagent tool-schema wraps its `slug` with a
 * per-subagent namespace regex so the model can only write under
 * `wiki/agents/<subagentId>/...`. The put_page operation also has a server-
 * side fail-closed check (see src/core/operations.ts) that catches any
 * dispatcher bug where viaSubagent=true but subagentId is missing.
 *
 * In v0.15 every allow-list op is treated as idempotent for the two-phase
 * replay path. put_page with a deterministic slug is idempotent at the row
 * level; repeats re-derive the same embedding over identical content.
 */

import type { BrainEngine } from '../../engine.ts';
import type { GBrainConfig } from '../../config.ts';
import { operations } from '../../operations.ts';
import type { Operation, OperationContext } from '../../operations.ts';
import type { ToolCtx, ToolDef } from '../types.ts';

/**
 * v0.15 brain-tool allow-list. Review carefully when extending. Op names
 * verified against origin/master:src/core/operations.ts (post shell-jobs +
 * Knowledge Runtime).
 *
 * Read-only (all safe):
 *   query, search, get_page, list_pages, file_list, file_url,
 *   get_backlinks, traverse_graph, resolve_slugs, get_ingest_log
 *
 * Conditional write:
 *   put_page (namespace-enforced by the tool schema + server-side check)
 *
 * Every name below MUST exist in src/core/operations.ts OPERATIONS; the
 * brain-allowlist test pins this invariant so an upstream rename fails CI
 * instead of silently dropping a tool.
 */
export const BRAIN_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'query',
  'search',
  'get_page',
  'list_pages',
  'file_list',
  'file_url',
  'get_backlinks',
  'traverse_graph',
  'resolve_slugs',
  'get_ingest_log',
  'put_page',
]);

/** Matches Anthropic's tool-name constraint. No dots. */
const ANTHROPIC_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function sanitizeToolName(opName: string): string {
  // Prefix with brain_ and replace any non-conforming char. For the v0.15
  // allow-list, every op name is already a valid simple identifier, so this
  // is defense-in-depth.
  const prefixed = `brain_${opName}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  return prefixed.slice(0, 64);
}

/**
 * Convert an Operation.params (ParamDef) map to an Anthropic-compatible
 * JSONSchema.input_schema. Same shape MCP uses inline — ParamDef.type
 * narrows to a subset of JSONSchema types.
 */
function paramsToInputSchema(op: Operation): Record<string, unknown> {
  return {
    type: 'object' as const,
    properties: Object.fromEntries(
      Object.entries(op.params).map(([k, v]) => [k, {
        type: v.type === 'array' ? 'array' : v.type,
        ...(v.description ? { description: v.description } : {}),
        ...(v.enum ? { enum: v.enum } : {}),
        ...(v.items ? { items: { type: v.items.type } } : {}),
      }]),
    ),
    required: Object.entries(op.params).filter(([, v]) => v.required).map(([k]) => k),
  };
}

/**
 * For put_page specifically, the tool schema shown to the model constrains
 * `slug`. Two modes:
 *
 *  - Default (legacy): slug MUST start with `wiki/agents/<subagentId>/`,
 *    enforced by both the JSONSchema `pattern` and the server-side check.
 *  - Trusted-workspace (v0.23 dream cycle): when `allowedSlugPrefixes` is
 *    set, the model is told the allowed prefixes in plain English (no
 *    regex pattern — the prefix list is authoritative server-side, and
 *    JSONSchema can't express "matches any of these globs" cleanly).
 */
function namespacedPutPageSchema(
  op: Operation,
  subagentId: number,
  allowedSlugPrefixes?: readonly string[],
): Record<string, unknown> {
  const base = paramsToInputSchema(op);
  const props = (base.properties as Record<string, Record<string, unknown>>) ?? {};
  if (props.slug) {
    if (allowedSlugPrefixes && allowedSlugPrefixes.length > 0) {
      props.slug = {
        ...props.slug,
        description:
          `Page slug. MUST match one of these prefix globs: ${allowedSlugPrefixes.join(', ')}. ` +
          `Slugs use lowercase alphanumeric segments separated by '/'. No leading slash, no '.md' extension, no underscores.`,
      };
    } else {
      props.slug = {
        ...props.slug,
        description: `Page slug. MUST start with "wiki/agents/${subagentId}/" (agents can only write under their own namespace).`,
        pattern: `^wiki/agents/${subagentId}/.+`,
      };
    }
  }
  return { ...base, properties: props };
}

/** Args required to build the registry for a given subagent job. */
export interface BuildBrainToolsOpts {
  subagentId: number;
  engine: BrainEngine;
  config: GBrainConfig;
  /** Optional filter: only include names in this set. */
  allowedNames?: ReadonlySet<string>;
  /**
   * Connected-gbrains brain id (v0.19+, PR 0 plumbing only).
   *
   * CURRENT BEHAVIOR: `brainId` is stamped onto each tool-call's
   * `OperationContext.brainId` for audit / logging, but `ctx.engine` is
   * still the engine passed in here (the parent job's engine). Ops
   * targeting mounted brains via brainId WITHOUT a registry lookup will
   * silently run against the parent engine.
   *
   * FUTURE (PR 1): `buildOpContext` will call `BrainRegistry.getBrain
   * (brainId).engine` to select the right engine per dispatch. Once
   * wired, `opCtx.engine` will match `opCtx.brainId`. Until then, treat
   * brainId as metadata only.
   */
  brainId?: string;
  /**
   * Trusted-workspace allow-list (v0.23). When set, put_page is bounded
   * to slugs matching these prefix globs instead of the legacy
   * `wiki/agents/<id>/...` namespace. Trust comes from PROTECTED_JOB_NAMES
   * (MCP can't submit subagent jobs) — this flows from
   * SubagentHandlerData.allowed_slug_prefixes via the handler.
   */
  allowedSlugPrefixes?: readonly string[];
}

interface OpContextDeps {
  engine: BrainEngine;
  config: GBrainConfig;
  subagentId: number;
  jobId: number;
  signal?: AbortSignal;
  brainId?: string;
  allowedSlugPrefixes?: readonly string[];
}

function buildOpContext(deps: OpContextDeps): OperationContext {
  return {
    engine: deps.engine,
    config: deps.config,
    logger: {
      info: (msg: string) => process.stderr.write(`[subagent-tool:${deps.jobId}] ${msg}\n`),
      warn: (msg: string) => process.stderr.write(`[subagent-tool:${deps.jobId}] WARN: ${msg}\n`),
      error: (msg: string) => process.stderr.write(`[subagent-tool:${deps.jobId}] ERROR: ${msg}\n`),
    },
    dryRun: false,
    remote: true,                // match MCP trust boundary for auto-link skip
    jobId: deps.jobId,
    subagentId: deps.subagentId,
    viaSubagent: true,           // FAIL-CLOSED: put_page etc. enforce namespace
    brainId: deps.brainId,
    allowedSlugPrefixes: deps.allowedSlugPrefixes
      ? [...deps.allowedSlugPrefixes]
      : undefined,
  };
}

/**
 * Build the subagent brain-tool registry. One ToolDef per allow-listed op,
 * with a namespace-wrapped schema for put_page.
 *
 * Call this once per subagent-job claim; the registry is keyed to the job's
 * subagentId + engine handle, so it's not shareable across jobs.
 */
export function buildBrainTools(opts: BuildBrainToolsOpts): ToolDef[] {
  const filter = opts.allowedNames ?? BRAIN_TOOL_ALLOWLIST;
  const picked: Operation[] = operations.filter(
    op => BRAIN_TOOL_ALLOWLIST.has(op.name) && filter.has(op.name),
  );

  return picked.map<ToolDef>(op => {
    const schema = op.name === 'put_page'
      ? namespacedPutPageSchema(op, opts.subagentId, opts.allowedSlugPrefixes)
      : paramsToInputSchema(op);

    const toolName = sanitizeToolName(op.name);
    if (!ANTHROPIC_NAME_RE.test(toolName)) {
      throw new Error(`brain tool name ${toolName} does not match Anthropic constraint`);
    }

    return {
      name: toolName,
      description: op.description,
      input_schema: schema,
      // v0.15 ships only idempotent brain tools (every allow-listed op is
      // deterministic over its input; put_page re-writes the same slug).
      idempotent: true,
      async execute(input: unknown, ctx: ToolCtx): Promise<unknown> {
        const opCtx = buildOpContext({
          engine: ctx.engine,
          config: opts.config,
          subagentId: opts.subagentId,
          jobId: ctx.jobId,
          signal: ctx.signal,
          brainId: opts.brainId,
          allowedSlugPrefixes: opts.allowedSlugPrefixes,
        });
        const params = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
        return op.handler(opCtx, params);
      },
    };
  });
}

/**
 * Apply the caller's `allowed_tools` subset to a registry. Unknown tool
 * names throw a clear error at load time (NOT silently ignored) so
 * subagent defs with a typo don't ship to prod wondering why a tool
 * never fires.
 */
export function filterAllowedTools(registry: ToolDef[], allowedToolNames: string[]): ToolDef[] {
  const indexByName = new Map(registry.map(t => [t.name, t]));
  // Also index by the un-prefixed op name (for friendlier allowed_tools entries).
  const indexByShort = new Map(
    registry.map(t => [t.name.replace(/^brain_/, ''), t]),
  );
  const seen = new Set<string>();
  const picked: ToolDef[] = [];
  for (const requested of allowedToolNames) {
    const match = indexByName.get(requested) ?? indexByShort.get(requested);
    if (!match) {
      throw new Error(
        `subagent allowed_tools references unknown tool "${requested}". ` +
        `Known: ${[...indexByName.keys()].join(', ')}`,
      );
    }
    if (seen.has(match.name)) continue;
    seen.add(match.name);
    picked.push(match);
  }
  return picked;
}

/** Exported for unit tests (stable surface). */
export const __testing = {
  sanitizeToolName,
  paramsToInputSchema,
  namespacedPutPageSchema,
  ANTHROPIC_NAME_RE,
};
