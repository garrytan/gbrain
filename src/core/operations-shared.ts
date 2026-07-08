// Shared operation-contract helpers used by operations.ts and the
// operations-*.ts domain modules. Runtime-safe for both sides: imports only
// the operation-params seam, never operations.ts.
import { formatEnumError, OperationError, type ParamDef } from './operation-params.ts';

export const REQUESTED_SCOPES = ['work', 'personal', 'mixed'] as const;

export const REQUESTED_SCOPE_ENUM_ERROR_HINT = 'requested_scope is the access scope; put retrieval details in query.';

export function requestedScopeParam(description: string): ParamDef {
  return {
    type: 'string',
    description,
    compactDescription: true,
    enum: [...REQUESTED_SCOPES],
    enumErrorHint: REQUESTED_SCOPE_ENUM_ERROR_HINT,
  };
}

export function parseRequestedScopeParam(value: unknown): (typeof REQUESTED_SCOPES)[number] | undefined {
  return parseEnumParam(value, 'requested_scope', REQUESTED_SCOPES, REQUESTED_SCOPE_ENUM_ERROR_HINT);
}

export function parseOptionalStringParam(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new OperationError('invalid_params', `${key} must be a string.`);
  }
  return value;
}

export function parsePositiveIntegerParam(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new OperationError('invalid_params', `${key} must be a positive integer.`);
  }
  return value;
}

export function parseEnumParam<T extends string>(value: unknown, key: string, allowed: readonly T[], hint?: string): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new OperationError('invalid_params', `${key} must be a string.`);
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new OperationError('invalid_params', formatEnumError(key, allowed, hint));
  }
  return value as T;
}

export function parseNonNegativeIntegerParam(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new OperationError('invalid_params', `${name} must be a non-negative integer`);
  }
  return value;
}

export function assertJsonSerializable(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null) return;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new OperationError('invalid_params', `${path} must be JSON-serializable`);
      }
      return;
    case 'object': {
      const objectValue = value as Record<string, unknown>;
      if (seen.has(objectValue)) {
        throw new OperationError('invalid_params', `${path} must be JSON-serializable`);
      }
      seen.add(objectValue);
      if (Array.isArray(value)) {
        value.forEach((item, index) => assertJsonSerializable(item, `${path}[${index}]`, seen));
        seen.delete(objectValue);
        return;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new OperationError('invalid_params', `${path} must be JSON-serializable object data`);
      }
      for (const [key, entry] of Object.entries(objectValue)) {
        assertJsonSerializable(entry, `${path}.${key}`, seen);
      }
      seen.delete(objectValue);
      return;
    }
    default:
      throw new OperationError('invalid_params', `${path} must be JSON-serializable`);
  }
}
