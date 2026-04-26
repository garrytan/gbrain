import type { Operation, ParamDef } from '../core/operations.ts';

export function paramToMcpSchema(param: ParamDef): Record<string, unknown> {
  const types = Array.isArray(param.type) ? param.type : [param.type];
  const schemaTypes = param.nullable ? [...types, 'null'] : types;
  return {
    type: schemaTypes.length === 1 ? schemaTypes[0] : schemaTypes,
    ...(param.description ? { description: param.description } : {}),
    ...(param.enum ? { enum: param.enum } : {}),
    ...(param.items ? { items: paramToMcpSchema(param.items) } : {}),
  };
}

export function operationToMcpTool(op: Operation): {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
} {
  return {
    name: op.name,
    description: op.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(op.params).map(([key, value]) => [key, paramToMcpSchema(value)]),
      ),
      required: Object.entries(op.params)
        .filter(([, value]) => value.required)
        .map(([key]) => key),
    },
  };
}
