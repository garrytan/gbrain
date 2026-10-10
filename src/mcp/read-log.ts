/**
 * `--log-read-params` — readable activity for READ operations.
 *
 * The default request log (F8) keeps no values: `summarizeMcpParams` records
 * declared key names only. That is right for writes (the payload is the
 * user's content) but leaves an operator unable to answer "what did this
 * agent look up, and what came back?". `--log-full-params` answers it by
 * logging every raw payload, writes included, and is debug-only.
 *
 * This is the middle setting. For read operations only (not `mutating`, `read` scope):
 *   - params: declared keys only (unknown keys counted, never named), string
 *     values PII-scrubbed with the eval-capture scrubber and capped;
 *   - result: the slugs and fact ids the call returned, plus counts. Never
 *     page bodies or fact text: the brain already holds those.
 * Writes keep the redacted summary. The same object rides the admin SSE feed.
 */

import { scrubPii } from '../core/eval-capture-scrub.ts';
import { operations as allOperations } from '../core/operations.ts';

// Network-reachable operations only: this logs remote MCP traffic, and local-only ops never arrive over HTTP.
const operations = allOperations.filter(op => !op.localOnly);

const MAX_STRING = 2000;       // per string value
const MAX_LIST = 50;           // slugs / fact ids per result
const MAX_DEPTH = 6;           // result walk depth

export interface ReadParamsLog {
  read: true;
  params: Record<string, unknown>;
  unknown_key_count: number;
}

export interface ReadResultLog {
  slugs: string[];
  fact_ids: number[];
  items: number | null;
  truncated?: true;
}

/** True when `--log-read-params` should log values for this operation: not mutating, and `read` scope. */
export function isReadOperation(opName: string): boolean {
  const op = operations.find(o => o.name === opName);
  return !!op && op.mutating !== true && (op.scope ?? 'read') === 'read';
}

function scrubValue(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') {
    const s = scrubPii(v);
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
  if (depth >= 3) return '[nested]';
  if (Array.isArray(v)) return v.slice(0, MAX_LIST).map(x => scrubValue(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = scrubValue(x, depth + 1);
    return out;
  }
  return null;
}

/** Declared params of a read op, PII-scrubbed. Unknown (attacker-controlled) keys are counted, never named. */
export function readParamsLog(opName: string, params: unknown): ReadParamsLog | null {
  if (params == null || typeof params !== 'object' || Array.isArray(params)) return null;
  const op = operations.find(o => o.name === opName);
  const allow = op ? new Set(Object.keys(op.params)) : new Set<string>();
  const out: Record<string, unknown> = {};
  let unknown = 0;
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (allow.has(k)) out[k] = scrubValue(v);
    else unknown += 1;
  }
  return { read: true, params: out, unknown_key_count: unknown };
}

function walk(v: unknown, depth: number, slugs: Set<string>, factIds: Set<number>): void {
  if (depth > MAX_DEPTH || v == null || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    for (const x of v) walk(x, depth + 1, slugs, factIds);
    return;
  }
  const o = v as Record<string, unknown>;
  if (typeof o.slug === 'string') slugs.add(o.slug);
  // A fact row: numeric id plus the fact's text field.
  if (typeof o.id === 'number' && (typeof o.fact === 'string' || typeof o.claim === 'string')) factIds.add(o.id);
  for (const x of Object.values(o)) walk(x, depth + 1, slugs, factIds);
}

/**
 * What a read returned: slugs and fact ids (deduplicated, capped), plus the
 * top-level item count when the result is a list. Best effort: a result that
 * isn't JSON yields empty lists, never an error.
 */
export function readResultLog(result: { content?: Array<{ type?: string; text?: string }> }): ReadResultLog {
  const slugs = new Set<string>();
  const factIds = new Set<number>();
  let items: number | null = null;
  const text = result.content?.[0]?.text;
  if (typeof text === 'string') {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) items = parsed.length;
      else if (parsed && typeof parsed === 'object') {
        for (const k of ['results', 'facts', 'pages', 'items']) {
          const arr = (parsed as Record<string, unknown>)[k];
          if (Array.isArray(arr)) { items = (items ?? 0) + arr.length; }
        }
      }
      walk(parsed, 0, slugs, factIds);
    } catch { /* not JSON: nothing to summarize */ }
  }
  const out: ReadResultLog = {
    slugs: [...slugs].slice(0, MAX_LIST),
    fact_ids: [...factIds].slice(0, MAX_LIST),
    items,
  };
  if (slugs.size > MAX_LIST || factIds.size > MAX_LIST) out.truncated = true;
  return out;
}
