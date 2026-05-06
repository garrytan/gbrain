import type { Operation, ParamDef } from '../core/operations.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

/** Convert a ParamDef to a valid MCP JSON Schema object (recursive for nested items). */
function paramDefToMcpSchema(def: ParamDef): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: def.type };
  if (def.description) schema.description = def.description;
  if (def.enum) schema.enum = def.enum;
  if (def.items) {
    schema.items = paramDefToMcpSchema(def.items);
  }
  return schema;
}

export function buildToolDefs(ops: Operation[]): McpToolDef[] {
  return ops.map(op => ({
    name: op.name,
    description: op.description,
    inputSchema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        Object.entries(op.params).map(([k, v]) => {
          const base: Record<string, unknown> = { type: v.type };
          if (v.description) base.description = v.description;
          if (v.enum) base.enum = v.enum;
          if (v.items) {
            base.items = paramDefToMcpSchema(v.items);
          }
          return [k, base];
        }),
      ),
      required: Object.entries(op.params)
        .filter(([, v]) => v.required)
        .map(([k]) => k),
    },
  }));
}
