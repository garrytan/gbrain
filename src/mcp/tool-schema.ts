import type { Operation, ParamDef } from '../core/operations.ts';

export type McpToolSchemaOptions = {
  compact?: boolean;
};

export function paramToMcpSchema(
  param: ParamDef,
  options: McpToolSchemaOptions = {},
): Record<string, unknown> {
  const types = Array.isArray(param.type) ? param.type : [param.type];
  const schemaTypes = param.nullable ? [...types, 'null'] : types;
  return {
    type: schemaTypes.length === 1 ? schemaTypes[0] : schemaTypes,
    ...(param.description && !options.compact ? { description: param.description } : {}),
    ...(param.enum ? { enum: param.enum } : {}),
    ...(param.items ? { items: paramToMcpSchema(param.items, options) } : {}),
  };
}

export function operationToMcpTool(op: Operation, options: McpToolSchemaOptions = {}): {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
} {
  const required = Object.entries(op.params)
    .filter(([, value]) => value.required)
    .map(([key]) => key);
  return {
    name: op.name,
    ...(!options.compact ? { description: op.description } : {}),
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(op.params).map(([key, value]) => [key, paramToMcpSchema(value, options)]),
      ),
      ...(!options.compact || required.length > 0 ? { required } : {}),
    },
  };
}
