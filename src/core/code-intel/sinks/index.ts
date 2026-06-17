/**
 * v0.34 W3 — sink pattern dispatch by language.
 *
 * Returns the SinkKind for a callee qualified name, or 'unknown' when
 * no pattern matches. Pattern matching is literal-string + glob (`*` =
 * any chars). Auditable, no regex eval. Cap glob expansion to one
 * conversion to RegExp per pattern, cached per process.
 */
import type { SinkKind, SinkPatterns } from './ts.ts';
import { TS_SINKS } from './ts.ts';
import { PY_SINKS } from './py.ts';

export type { SinkKind, SinkPatterns };
export { TS_SINKS, PY_SINKS };

const LANG_SINKS: Record<string, SinkPatterns> = {
  typescript: TS_SINKS,
  tsx: TS_SINKS,
  javascript: TS_SINKS,
  python: PY_SINKS,
};

const compiledCache = new Map<string, RegExp>();
function compile(pattern: string): RegExp {
  let re = compiledCache.get(pattern);
  if (re) return re;
  // Escape regex metacharacters EXCEPT `*` (glob wildcard).
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  re = new RegExp(`^${escaped}$`);
  compiledCache.set(pattern, re);
  return re;
}

export function classifySink(callee: string, language: string | undefined): SinkKind {
  if (!language) return 'unknown';
  const sinks = LANG_SINKS[language];
  if (!sinks) return 'unknown';
  // Try each kind in priority order. Order: db, http, file_io, process_exec.
  for (const kind of ['db_call', 'http_call', 'file_io', 'process_exec'] as const) {
    const patterns = sinks[kind];
    for (const pattern of patterns) {
      if (compile(pattern).test(callee)) return kind;
    }
  }
  return 'unknown';
}
