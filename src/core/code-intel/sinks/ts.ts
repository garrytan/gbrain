/**
 * v0.34 W3 — TypeScript / JavaScript sink patterns.
 *
 * Each pattern is a LITERAL string + glob (`*` = any). NOT regex —
 * auditable. Used by `code_flow` to tag terminal nodes with the kind
 * of external side-effect they trigger.
 */
export type SinkKind = 'db_call' | 'http_call' | 'file_io' | 'process_exec' | 'unknown';

export interface SinkPatterns {
  http_call: readonly string[];
  db_call: readonly string[];
  file_io: readonly string[];
  process_exec: readonly string[];
}

export const TS_SINKS: SinkPatterns = {
  http_call: ['fetch', 'axios.*', 'http.*', 'https.*', 'request.*'],
  db_call: ['*.query', '*.exec', 'sql`', '*.find', '*.insert', '*.update', '*.delete'],
  file_io: ['fs.read*', 'fs.write*', 'Bun.file', 'Bun.write', 'readFileSync', 'writeFileSync'],
  process_exec: ['execSync', 'spawnSync', 'Bun.spawn*', 'spawn', 'exec'],
} as const;
