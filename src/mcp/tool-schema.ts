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
  title?: string;
  description?: string;
  annotations?: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
} {
  const required = Object.entries(op.params)
    .filter(([, value]) => value.required)
    .map(([key]) => key);
  const title = operationTitle(op.name);
  const isMutating = op.mutating === true;
  const isDestructive = isMutating && isDestructiveOperation(op.name);
  const metadata = options.compact ? {} : {
    title,
    description: op.description,
    annotations: {
      readOnlyHint: !isMutating,
      destructiveHint: isDestructive,
      openWorldHint: false,
    },
  };
  return {
    name: op.name,
    ...metadata,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(op.params).map(([key, value]) => [key, paramToMcpSchema(value, options)]),
      ),
      ...(!options.compact || required.length > 0 ? { required } : {}),
    },
  };
}

function operationTitle(name: string): string {
  return name
    .split('_')
    .filter(part => part.length > 0)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isDestructiveOperation(name: string): boolean {
  if (name === 'put_page' || name === 'apply_memory_patch_candidate' || name === 'apply_memory_redaction_plan') {
    return true;
  }
  return /^(delete|remove|revert|revoke|purge|supersede)_/.test(name);
}
