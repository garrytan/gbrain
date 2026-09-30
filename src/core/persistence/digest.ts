import { createHash } from 'node:crypto';
import { isWriteRequestId } from './types.ts';
import { OperationError } from '../ops/contract.ts';

/** Intent identity includes caller input before timestamps and other generated defaults. */
export function stableJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'bigint') return v.toString();
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().filter(k => (v as Record<string, unknown>)[k] !== undefined)
        .map(k => [k, normalize((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  const json = JSON.stringify(normalize(value));
  if (json === undefined) throw new TypeError('Write intent must be JSON serializable.');
  return json;
}
export function digest(value: unknown): string { return sha256(stableJson(value)); }
export function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function jsonBytes(value: unknown): number { return Buffer.byteLength(stableJson(value), 'utf8'); }
export function requireUuid(value: string): string {
  if (!isWriteRequestId(value)) {
    throw new OperationError('invalid_params', 'request_id must be a UUID.');
  }
  return value.toLowerCase();
}
