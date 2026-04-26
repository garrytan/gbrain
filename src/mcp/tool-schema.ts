import type { Operation, ParamDef } from '../core/operations.ts';

export function paramToMcpSchema(param: ParamDef): Record<string, unknown> {
  const baseType = param.type === 'array' ? 'array' : param.type;
  return {
    type: param.nullable ? [baseType, 'null'] : baseType,
    ...(param.description ? { description: param.description } : {}),
    ...(param.enum ? { enum: param.enum } : {}),
    ...(param.items ? { items: { type: param.items.type } } : {}),
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
