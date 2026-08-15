import type { Operation, ParamDef } from '../core/operations.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    /** WP3 (D14.1): emitted ONLY when buildToolDefs runs with strictParams. */
    additionalProperties?: false;
  };
  /**
   * MCP ToolAnnotations (SDK 1.29+), emitted ONLY when the op defines them —
   * existing tools keep byte-identical definitions (the byte-equality
   * regression test depends on absent keys staying absent).
   */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

/**
 * Convert a single ParamDef to a JSON Schema fragment. Recursive on `items`.
 *
 * Single source of truth for ParamDef→JSON Schema mapping. Consumed by:
 * - buildToolDefs (stdio MCP server.ts via tool-defs.ts)
 * - serve-http.ts tools/list handler (HTTP MCP path)
 * - brain-allowlist.ts paramsToInputSchema (subagent tool registry)
 *
 * The three call sites previously each had their own inline destructure that
 * drifted from each other (live HTTP MCP path dropped `items` entirely in
 * v0.32 PR review). Centralizing here closes the bug class at the
 * architecture level instead of patching one site at a time.
 *
 * Key ordering (type, description, enum, default, items) is intentional —
 * matches the pre-v0.34 inline mappers so JSON.stringify output stays
 * byte-stable for the byte-equality regression test.
 */
export function paramDefToSchema(p: ParamDef): Record<string, unknown> {
  return {
    type: p.type === 'array' ? 'array' : p.type,
    ...(p.description ? { description: p.description } : {}),
    ...(p.enum ? { enum: p.enum } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.items ? { items: paramDefToSchema(p.items) } : {}),
  };
}

/**
 * WP3 (D14.1): when a strict schema closes the property set with
 * `additionalProperties: false`, the two dispatch-allowlisted passthrough
 * keys MUST be declared in `properties` — schema-validating clients
 * (Gemini strict, OpenAI structured outputs) would otherwise strip
 * `_meta.session_id` and `dry_run` from arguments before they ever reach
 * the server. Declared only when the op doesn't already declare them
 * (several ops carry a real `dry_run` param).
 */
function strictPassthroughProperties(op: Operation): Record<string, unknown> {
  return {
    ...('_meta' in op.params ? {} : {
      _meta: {
        type: 'object',
        description: 'MCP client metadata passthrough (e.g. session id); not an operation parameter.',
      },
    }),
    ...('dry_run' in op.params ? {} : { dry_run: { type: 'boolean' } }),
  };
}

/**
 * Build MCP tool definitions from operations.
 *
 * Default emission (no opts / strictParams false) is BYTE-IDENTICAL to the
 * pre-WP3 output — pinned by test/mcp-tool-defs.test.ts. With
 * `strictParams: true` (mcp.strict_params = 'reject'), each inputSchema
 * additionally declares the `_meta`/`dry_run` passthrough keys and closes
 * the schema with `additionalProperties: false`, keeping client-side
 * validation aligned with the server's reject posture.
 */
export function buildToolDefs(ops: Operation[], opts?: { strictParams?: boolean }): McpToolDef[] {
  const strict = opts?.strictParams === true;
  return ops.map(op => ({
    name: op.name,
    description: op.description,
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...Object.fromEntries(
          Object.entries(op.params).map(([k, v]) => [k, paramDefToSchema(v)]),
        ),
        ...(strict ? strictPassthroughProperties(op) : {}),
      },
      required: Object.entries(op.params)
        .filter(([, v]) => v.required)
        .map(([k]) => k),
      ...(strict ? { additionalProperties: false as const } : {}),
    },
    ...(op.annotations ? { annotations: op.annotations } : {}),
  }));
}
