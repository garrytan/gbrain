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
   * MCP ToolAnnotations (SDK 1.29+): the op's own curated annotations, else
   * the conservative derivation in toolAnnotations(). Absent when neither
   * applies, so an op of unknown effect stays unannotated.
   */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

/**
 * Convert a single ParamDef to a JSON Schema fragment. Recursive on `items`
 * and object `properties` (closed, with member `required`).
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
    ...(p.properties ? {
      properties: Object.fromEntries(Object.entries(p.properties).map(([k, v]) => [k, paramDefToSchema(v)])),
      required: Object.entries(p.properties).filter(([, v]) => v.required).map(([k]) => k),
      additionalProperties: false,
    } : {}),
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
 * #5037 / agent contract A2: annotation-driven hosts need to tell reads from
 * writes. An op's curated `annotations` win as written. Otherwise derive only
 * what the op's required metadata states (every op declares `mutating` and
 * `idempotent`; test/ops-mutation-tags.test.ts): `readOnlyHint: true` iff
 * `mutating === false`; `readOnlyHint: false` iff `mutating === true`, plus
 * `idempotentHint: true` when the write is also `idempotent`.
 * `destructiveHint` and `openWorldHint` keep the MCP defaults (no metadata
 * separates additive from destructive writes yet).
 */
export function toolAnnotations(op: Operation): McpToolDef['annotations'] | undefined {
  if (op.annotations) return op.annotations;
  if (op.mutating === false) return { readOnlyHint: true };
  if (op.mutating === true) return op.idempotent === true ? { readOnlyHint: false, idempotentHint: true } : { readOnlyHint: false };
  return undefined;
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
  return ops.map(op => {
    const annotations = toolAnnotations(op);
    return {
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
      ...(annotations ? { annotations } : {}),
    };
  });
}
