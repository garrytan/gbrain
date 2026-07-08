/**
 * Descriptor-driven operation parameter validation seam.
 *
 * Every operation dispatch (CLI, MCP stdio/HTTP, edge) funnels through
 * `validateOperationParams` before a handler runs: required check, type check,
 * enum check, finite-number check, and opt-in string trimming driven by the
 * operation's existing `params` descriptors. Handlers keep their own checks as
 * defense in depth.
 *
 * Coercion is copy-on-write: the input params object is never mutated, and the
 * original object (including symbol-keyed internal markers) is returned
 * untouched when no coercion applies.
 */

import type { OfflineProfile } from './offline-profile.ts';

export type ErrorCode =
  | 'page_not_found'
  | 'task_not_found'
  | 'trace_not_found'
  | 'memory_candidate_not_found'
  | 'invalid_params'
  | 'embedding_failed'
  | 'storage_error'
  | 'write_conflict'
  | 'bucket_not_found'
  | 'database_error'
  | 'unsupported_capability'
  | 'schema_out_of_date'
  | 'permission_denied';

export class OperationError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public suggestion?: string,
    public docs?: string,
  ) {
    super(message);
    this.name = 'OperationError';
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      suggestion: this.suggestion,
      docs: this.docs,
    };
  }
}

export type ParamType = 'string' | 'number' | 'boolean' | 'object' | 'array';
export type OperationCapability = keyof OfflineProfile['capabilities'];

export interface ParamDef {
  type: ParamType | ParamType[];
  required?: boolean;
  nullable?: boolean;
  description?: string;
  compactDescription?: boolean;
  capabilityRequired?: OperationCapability;
  default?: unknown;
  enum?: string[];
  enumErrorHint?: string;
  compactEnum?: boolean;
  items?: ParamDef;
  /**
   * Opt-in coercion: trim surrounding whitespace from string values before
   * type/enum checks. Never enable on whitespace-sensitive params (page
   * content, raw ingest bodies, anything hashed or offset-addressed).
   */
  trim?: boolean;
}

export function paramHasType(paramDef: ParamDef | undefined, type: ParamType): boolean {
  if (!paramDef) return false;
  return Array.isArray(paramDef.type) ? paramDef.type.includes(type) : paramDef.type === type;
}

export function getMissingRequiredParams(
  op: { params: Record<string, ParamDef> },
  params: Record<string, unknown>,
): string[] {
  return Object.entries(op.params)
    .filter(([, def]) => def.required)
    .filter(([key]) => params[key] === undefined)
    .map(([key]) => key);
}

export function validateOperationParams(
  operation: { name: string; params: Record<string, ParamDef> },
  params: Record<string, unknown>,
): Record<string, unknown> {
  const missing = getMissingRequiredParams(operation, params);
  if (missing.length > 0) {
    const label = missing.length === 1 ? 'parameter' : 'parameters';
    throw new OperationError('invalid_params', `Missing required ${label}: ${missing.join(', ')}`);
  }

  let coerced: Record<string, unknown> | null = null;
  for (const [name, value] of Object.entries(params)) {
    const paramDef = operation.params[name];
    if (!paramDef || value === undefined) continue;
    const validated = coerceAndValidateParamValue(name, value, paramDef);
    if (validated !== value) {
      coerced ??= { ...params };
      coerced[name] = validated;
    }
  }
  return coerced ?? params;
}

function coerceAndValidateParamValue(path: string, value: unknown, paramDef: ParamDef): unknown {
  if (value === null) {
    if (paramDef.nullable) return value;
    throw new OperationError('invalid_params', `${path} must be ${formatExpectedParamTypes(paramDef)}.`);
  }

  const coercedValue = paramDef.trim === true && typeof value === 'string' ? value.trim() : value;

  const types = Array.isArray(paramDef.type) ? paramDef.type : [paramDef.type];
  const matched = types.some((type) => valueMatchesParamType(coercedValue, type));
  if (!matched) {
    throw new OperationError('invalid_params', `${path} must be ${formatExpectedParamTypes(paramDef)}.`);
  }

  if (typeof coercedValue === 'string' && paramDef.enum && !paramDef.enum.includes(coercedValue)) {
    throw new OperationError('invalid_params', formatEnumParamError(path, paramDef));
  }

  const itemDef = paramDef.items;
  if (Array.isArray(coercedValue) && paramHasType(paramDef, 'array') && itemDef) {
    let coercedItems: unknown[] | null = null;
    coercedValue.forEach((item, index) => {
      const validatedItem = coerceAndValidateParamValue(`${path}[${index}]`, item, itemDef);
      if (validatedItem !== item) {
        coercedItems ??= [...coercedValue];
        coercedItems[index] = validatedItem;
      }
    });
    if (coercedItems) return coercedItems;
  }

  return coercedValue;
}

function formatEnumParamError(path: string, paramDef: ParamDef): string {
  return formatEnumError(path, paramDef.enum ?? [], paramDef.enumErrorHint);
}

export function formatEnumError(path: string, allowed: readonly string[], hint?: string): string {
  const base = `${path} must be one of: ${allowed.join(', ')}`;
  return hint ? `${base}. ${hint}` : base;
}

function valueMatchesParamType(value: unknown, type: ParamType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
  }
}

function formatExpectedParamTypes(paramDef: ParamDef): string {
  const types = Array.isArray(paramDef.type) ? paramDef.type : [paramDef.type];
  const labels = types.map(formatExpectedParamType);
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

function formatExpectedParamType(type: ParamType): string {
  switch (type) {
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'object':
      return 'an object';
    case 'array':
      return 'an array';
  }
}
