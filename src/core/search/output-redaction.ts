import { applyRedaction, planRedaction, type RedactionPlan } from '../secret-scan.ts';
import { DEGRADED_REASONS, DEGRADED_STAGES } from '../types.ts';

export const OUTPUT_REDACTION_MAX_FIELD_CHARS = 64 * 1024;
export const OUTPUT_REDACTION_MAX_TOTAL_CHARS = 1024 * 1024;
export const OUTPUT_REDACTION_LIMIT = '<REDACTED:output_limit>';

const IDENTITY_FIELDS = new Set([
  'id', 'slug', 'source_id', 'page_id', 'chunk_id', 'message_id', 'thread_id',
  'graph_session_prefix', 'relational_seed', 'relational_path', 'superseded_by',
]);
const MAX_DEPTH = 24;
const MAX_TEXT_FIELDS = 8192;
const DEGRADED_STAGE_CODES = new Set<string>(DEGRADED_STAGES);
const DEGRADED_REASON_CODES = new Set<string>(DEGRADED_REASONS);

export function redactRetrievalOutput<T, M>(results: T[], meta: M): { results: T[]; meta: M } {
  const echoValues = new Map<string, string>();
  const plans = new Map<string, RedactionPlan>();
  const writes: Array<() => void> = [];
  let remaining = OUTPUT_REDACTION_MAX_TOTAL_CHARS;
  let fields = 0;

  function copy(value: unknown, depth: number, path: Array<string | number>): unknown {
    if (typeof value !== 'object' || value === null) return value;
    if (depth > MAX_DEPTH) return OUTPUT_REDACTION_LIMIT;
    const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
    const out: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    for (const [key, item] of entries) {
      let next: unknown;
      if (IDENTITY_FIELDS.has(String(key)) && (typeof item !== 'object' || item === null ||
        (Array.isArray(item) && item.every(part => typeof part === 'string')))) {
        next = Array.isArray(item) ? [...item] : item;
      } else if (typeof item === 'string' && path[0] === 'meta' && (
        path.length === 3 && path[1] === 'degraded' && typeof path[2] === 'number' &&
          (key === 'stage' && DEGRADED_STAGE_CODES.has(item) || key === 'reason' && DEGRADED_REASON_CODES.has(item)) ||
        path.length === 2 && path[1] === 'projection_readiness' && key === 'status' &&
          ['ready', 'projection_pending', 'unknown'].includes(item)
      )) {
        next = item;
      } else if (typeof item === 'string') {
        let plan = plans.get(item);
        if (item.length > OUTPUT_REDACTION_MAX_FIELD_CHARS || item.length > remaining || ++fields > MAX_TEXT_FIELDS) {
          next = OUTPUT_REDACTION_LIMIT;
        } else {
          remaining -= item.length;
          if (!plan) {
            plan = planRedaction(item, { echoValues });
            plans.set(item, plan);
          }
          const planned = plan;
          writes.push(() => {
            Object.defineProperty(out, key, { value: applyRedaction(planned), enumerable: true, writable: true, configurable: true });
          });
        }
      } else {
        next = copy(item, depth + 1, [...path, key]);
      }
      Object.defineProperty(out, key, { value: next, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }

  const output = copy({ results, meta }, 0, []) as { results: T[]; meta: M };
  for (const write of writes) write();
  return output;
}
