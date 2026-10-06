#!/usr/bin/env bun
/**
 * Schema text generator (refactor wave 1, W2): one copy of schema DDL.
 *
 * Canonical sources (docs/ENGINES.md "Canonical schema sources"):
 *   - src/schema.sql: canonical for every table except the TS fragment tables;
 *   - the TS fragment modules in FRAGMENTS below: canonical for their tables
 *     (evaluated here under Bun, so the text is exactly what migrations use).
 * Everything else is generated, in this fixed order (`bun run build:schema`):
 *   1. evaluate the fragment modules;
 *   2. rewrite the `BEGIN/END GENERATED from <path>` regions of src/schema.sql;
 *   3. write src/core/schema-embedded.generated.ts (the Postgres blob);
 *   4. write src/core/pglite-schema.generated.ts, the PGLite bootstrap TEMPLATE:
 *      schema.sql statements + fragment text, transformed by the explicit
 *      PGLite capability rules below, with the __EMBEDDING_DIMS__ /
 *      __EMBEDDING_MODEL__ placeholders and the runtime policy hooks
 *      (applyChunkEmbeddingIndexPolicy, applyFtsLanguagePolicy) left to
 *      getPGLiteSchema(dims, model) at runtime.
 * Unknown statement kinds, unclassified DO blocks and rules that no longer
 * match exit non-zero.
 *
 * Usage:
 *   bun run build:schema                               # write all outputs in place
 *   bun scripts/build-schema.ts --out-dir <dir>        # write outputs under <dir>/<repo path> (freshness guard)
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SOURCE_INGESTION_RECEIPTS_SCHEMA_SQL } from '../src/core/company-brain/receipt-schema.ts';
import { FACT_WITHDRAWAL_SCHEMA_STATEMENTS } from '../src/core/facts/withdrawal-schema.ts';
import { GRANT_AUDIT_SCHEMA_SQL } from '../src/core/grants/schema.ts';
import { LEASE_TOKEN_SCHEMA_SQL } from '../src/core/lease-schema.ts';
import { LINK_TEMPORAL_SCHEMA_SQL } from '../src/core/link-temporal-schema.ts';
import { PAGE_PROJECTION_SCHEMA_SQL } from '../src/core/page-state/projection-schema.ts';
import { PAGE_STATE_SCHEMA_SQL } from '../src/core/page-state/schema.ts';
import { POSTGRES_CONCURRENT_PERSISTENCE_INDEXES, PERSISTENCE_SCHEMA_STATEMENTS } from '../src/core/persistence/schema.ts';
import { PERSISTENCE_TOPOLOGY_SCHEMA_SQL } from '../src/core/persistence/topology-schema.ts';
import { WORKTREE_REFRESH_SCHEMA_SQL } from '../src/core/persistence/worktree-refresh-schema.ts';
import { SHARED_SKILLS_SCHEMA_SQL } from '../src/core/shared-skills/schema-all.ts';
import { DECIDE_SCHEMA_SQL } from '../src/core/ai/decide/schema.ts';
import { FACT_RELINK_SCHEMA_SQL } from '../src/core/facts/relink-schema.ts';
import { CORE_EDIT_NOTICES_SCHEMA_SQL } from '../src/core/core-memory-schema.ts';

const REPO = resolve(import.meta.dir, '..');
export const SCHEMA_SQL_PATH = 'src/schema.sql';
export const EMBEDDED_PATH = 'src/core/schema-embedded.generated.ts';
export const PGLITE_PATH = 'src/core/pglite-schema.generated.ts';
const SEE = 'See:  docs/ENGINES.md#canonical-schema-sources';

export class SchemaBuildError extends Error {}

function fail(what: string, why: string, fix: string): never {
  throw new SchemaBuildError(`FAIL: ${what}\nWhy:  ${why}\nFix:  ${fix}\n${SEE}`);
}

// ---------------------------------------------------------------------------
// 1. Fragments: TS modules canonical for their tables.
// ---------------------------------------------------------------------------

export interface Fragment {
  /** Banner label: `<source path> (<expression>)`. */
  source: string;
  expr: string;
  /** Text of the src/schema.sql region (the Postgres blob). */
  postgres: string;
  /** Text spliced into the PGLite template. */
  pglite: string;
}

const persistenceSql = (statements: readonly string[]) => `${statements.join(';\n')};`;

export const FRAGMENTS: readonly Fragment[] = [
  { source: 'src/core/grants/schema.ts', expr: 'GRANT_AUDIT_SCHEMA_SQL', postgres: GRANT_AUDIT_SCHEMA_SQL, pglite: GRANT_AUDIT_SCHEMA_SQL },
  {
    source: 'src/core/facts/withdrawal-schema.ts',
    expr: 'FACT_WITHDRAWAL_SCHEMA_STATEMENTS[0]',
    postgres: `${FACT_WITHDRAWAL_SCHEMA_STATEMENTS[0]};`,
    pglite: `${FACT_WITHDRAWAL_SCHEMA_STATEMENTS[0]};`,
  },
  { source: 'src/core/lease-schema.ts', expr: 'LEASE_TOKEN_SCHEMA_SQL', postgres: LEASE_TOKEN_SCHEMA_SQL, pglite: LEASE_TOKEN_SCHEMA_SQL },
  { source: 'src/core/page-state/schema.ts', expr: 'PAGE_STATE_SCHEMA_SQL', postgres: PAGE_STATE_SCHEMA_SQL, pglite: PAGE_STATE_SCHEMA_SQL },
  {
    source: 'src/core/persistence/schema.ts',
    expr: 'PERSISTENCE_SCHEMA_STATEMENTS',
    // Capability rule: Postgres builds persistence_requests_database_pending
    // (v165) and the #5762 sync-run indexes CONCURRENTLY in migrations (never
    // inside the blob); PGLite has no concurrent builds, so its bootstrap
    // creates them inline.
    postgres: persistenceSql(PERSISTENCE_SCHEMA_STATEMENTS.filter((s) => !POSTGRES_CONCURRENT_PERSISTENCE_INDEXES.has(s))),
    pglite: persistenceSql(PERSISTENCE_SCHEMA_STATEMENTS),
  },
  { source: 'src/core/page-state/projection-schema.ts', expr: 'PAGE_PROJECTION_SCHEMA_SQL', postgres: PAGE_PROJECTION_SCHEMA_SQL, pglite: PAGE_PROJECTION_SCHEMA_SQL },
  { source: 'src/core/persistence/topology-schema.ts', expr: 'PERSISTENCE_TOPOLOGY_SCHEMA_SQL', postgres: PERSISTENCE_TOPOLOGY_SCHEMA_SQL, pglite: PERSISTENCE_TOPOLOGY_SCHEMA_SQL },
  { source: 'src/core/persistence/worktree-refresh-schema.ts', expr: 'WORKTREE_REFRESH_SCHEMA_SQL', postgres: WORKTREE_REFRESH_SCHEMA_SQL, pglite: WORKTREE_REFRESH_SCHEMA_SQL },
  { source: 'src/core/company-brain/receipt-schema.ts', expr: 'SOURCE_INGESTION_RECEIPTS_SCHEMA_SQL', postgres: SOURCE_INGESTION_RECEIPTS_SCHEMA_SQL, pglite: SOURCE_INGESTION_RECEIPTS_SCHEMA_SQL },
  { source: 'src/core/shared-skills/schema-all.ts', expr: 'SHARED_SKILLS_SCHEMA_SQL', postgres: SHARED_SKILLS_SCHEMA_SQL, pglite: SHARED_SKILLS_SCHEMA_SQL },
  { source: 'src/core/ai/decide/schema.ts', expr: 'DECIDE_SCHEMA_SQL', postgres: DECIDE_SCHEMA_SQL, pglite: DECIDE_SCHEMA_SQL },
  { source: 'src/core/facts/relink-schema.ts', expr: 'FACT_RELINK_SCHEMA_SQL', postgres: FACT_RELINK_SCHEMA_SQL, pglite: FACT_RELINK_SCHEMA_SQL },
  { source: 'src/core/link-temporal-schema.ts', expr: 'LINK_TEMPORAL_SCHEMA_SQL', postgres: LINK_TEMPORAL_SCHEMA_SQL, pglite: LINK_TEMPORAL_SCHEMA_SQL },
  { source: 'src/core/core-memory-schema.ts', expr: 'CORE_EDIT_NOTICES_SCHEMA_SQL', postgres: CORE_EDIT_NOTICES_SCHEMA_SQL, pglite: CORE_EDIT_NOTICES_SCHEMA_SQL },
];

const fragmentLabel = (f: Fragment) => `${f.source} (${f.expr})`;
const regionBody = (text: string) => `${text.replace(/^\s*\n/, '').replace(/\s+$/, '')}\n`;

// ---------------------------------------------------------------------------
// SQL statement splitting (comments, quotes, dollar quotes aware).
// ---------------------------------------------------------------------------

export interface Stmt {
  /** Full text including leading comments/whitespace since the previous statement. */
  text: string;
  /** Comment-stripped, whitespace-collapsed text. */
  norm: string;
  line: number;
}

export function splitSql(src: string, firstLine = 1): Stmt[] {
  const out: Stmt[] = [];
  let i = 0;
  let start = 0;
  const n = src.length;
  const push = (end: number) => {
    const text = src.slice(start, end);
    const lead = text.length - text.trimStart().length;
    out.push({ text, norm: normalizeSql(text), line: firstLine + src.slice(0, start + lead).split('\n').length - 1 });
    start = end;
  };
  while (i < n) {
    const c = src[i]!;
    if (c === '-' && src[i + 1] === '-') {
      const e = src.indexOf('\n', i);
      i = e < 0 ? n : e + 1;
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 2;
    } else if (c === "'" || c === '"') {
      i++;
      while (i < n && !(src[i] === c && src[i + 1] !== c)) i += src[i] === c ? 2 : 1;
      i++;
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64));
      if (m) {
        const e = src.indexOf(m[0], i + m[0].length);
        if (e < 0) throw new SchemaBuildError(`unterminated dollar quote ${m[0]} at offset ${i}`);
        i = e + m[0].length;
      } else {
        i++;
      }
    } else if (c === ';') {
      i++;
      push(i);
    } else {
      i++;
    }
  }
  if (src.slice(start).trim()) push(n);
  else if (start < n) out.push({ text: src.slice(start), norm: '', line: firstLine });
  return out;
}

export function normalizeSql(s: string): string {
  let r = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '-' && s[i + 1] === '-') {
      const e = s.indexOf('\n', i);
      i = e < 0 ? s.length : e;
    } else if (c === "'") {
      const st = i++;
      while (i < s.length && !(s[i] === "'" && s[i + 1] !== "'")) i += s[i] === "'" ? 2 : 1;
      i++;
      r += s.slice(st, i);
    } else if (c === '$' && /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.test(s.slice(i, i + 64))) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 64))![0];
      const e = s.indexOf(tag, i + tag.length) + tag.length;
      r += s.slice(i, e);
      i = e;
    } else {
      r += c;
      i++;
    }
  }
  return r.replace(/\s+/g, ' ').trim();
}

/**
 * Drop `--` comments outside string and dollar quotes, and the lines they
 * leave empty. schema.sql's comments document the Postgres text; the PGLite
 * template carries none, so no comment text (with its stray parentheses) can
 * reach structural parsers such as test/schema-bootstrap-coverage.test.ts.
 */
export function stripSqlComments(s: string): string {
  let r = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '-' && s[i + 1] === '-') {
      const e = s.indexOf('\n', i);
      const lineStart = r.lastIndexOf('\n') + 1;
      if (/^[ \t]*$/.test(r.slice(lineStart))) {
        r = r.slice(0, lineStart);
        i = e < 0 ? s.length : e + 1;
      } else {
        r = r.replace(/[ \t]+$/, '');
        i = e < 0 ? s.length : e;
      }
    } else if (c === "'") {
      const st = i++;
      while (i < s.length && !(s[i] === "'" && s[i + 1] !== "'")) i += s[i] === "'" ? 2 : 1;
      i++;
      r += s.slice(st, i);
    } else if (c === '$' && /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.test(s.slice(i, i + 64))) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 64))![0];
      const e = s.indexOf(tag, i + tag.length) + tag.length;
      r += s.slice(i, e);
      i = e;
    } else {
      r += c;
      i++;
    }
  }
  return r;
}

// ---------------------------------------------------------------------------
// 2. src/schema.sql generated regions.
// ---------------------------------------------------------------------------

const BEGIN_RE = /^-- BEGIN GENERATED from (\S+) \(([^)]+)\)\..*$/;
const END_RE = /^-- END GENERATED from (\S+) \(([^)]+)\)$/;

export function beginMarker(f: Fragment): string {
  return `-- BEGIN GENERATED from ${fragmentLabel(f)}. Edit that file, then run: bun run build:schema`;
}
export function endMarker(f: Fragment): string {
  return `-- END GENERATED from ${fragmentLabel(f)}`;
}

export type SchemaPart = { kind: 'sql'; text: string; line: number } | { kind: 'region'; fragment: Fragment; line: number };

/** Split schema.sql into hand-written SQL runs and generated regions. */
export function parseSchemaSql(text: string): SchemaPart[] {
  const lines = text.split('\n');
  const parts: SchemaPart[] = [];
  const seen = new Set<Fragment>();
  let buf: string[] = [];
  let bufLine = 1;
  for (let i = 0; i < lines.length; i++) {
    const b = BEGIN_RE.exec(lines[i]!);
    if (END_RE.test(lines[i]!)) fail(`${SCHEMA_SQL_PATH}:${i + 1} END GENERATED marker without a BEGIN`, 'regions are delimited by a BEGIN/END pair.', 'restore the matching BEGIN marker (or regenerate from git).');
    if (!b) {
      if (buf.length === 0) bufLine = i + 1;
      buf.push(lines[i]!);
      continue;
    }
    const fragment = FRAGMENTS.find((f) => f.source === b[1] && f.expr === b[2]);
    if (!fragment) fail(`${SCHEMA_SQL_PATH}:${i + 1} names an unknown fragment ${b[1]} (${b[2]})`, 'every generated region must map to an entry of FRAGMENTS in scripts/build-schema.ts.', 'fix the marker or add the fragment to FRAGMENTS.');
    if (seen.has(fragment)) fail(`${SCHEMA_SQL_PATH}:${i + 1} has a second region for ${fragmentLabel(fragment)}`, 'each fragment is generated into exactly one region.', 'delete the duplicate region.');
    seen.add(fragment);
    let j = i + 1;
    while (j < lines.length && !END_RE.test(lines[j]!)) {
      if (BEGIN_RE.test(lines[j]!)) fail(`${SCHEMA_SQL_PATH}:${j + 1} nested BEGIN GENERATED marker`, 'regions cannot nest.', 'close the previous region first.');
      j++;
    }
    const end = END_RE.exec(lines[j] ?? '');
    if (!end || end[1] !== b[1] || end[2] !== b[2]) fail(`${SCHEMA_SQL_PATH}:${i + 1} region for ${fragmentLabel(fragment)} has no matching END marker`, 'an unclosed region would swallow hand-written SQL.', `add \`${endMarker(fragment)}\`.`);
    parts.push({ kind: 'sql', text: buf.join('\n'), line: bufLine });
    buf = [];
    parts.push({ kind: 'region', fragment, line: i + 1 });
    i = j;
    bufLine = j + 2;
  }
  parts.push({ kind: 'sql', text: buf.join('\n'), line: bufLine });
  for (const f of FRAGMENTS) {
    if (!seen.has(f)) fail(`${SCHEMA_SQL_PATH} has no generated region for ${fragmentLabel(f)}`, 'the fragment tables must reach the Postgres blob through schema.sql.', `add \`${beginMarker(f)}\` / \`${endMarker(f)}\` where the tables belong, then run: bun run build:schema`);
  }
  return parts;
}

export function renderSchemaSql(current: string): string {
  return parseSchemaSql(current)
    .map((p) => (p.kind === 'sql' ? p.text : `${beginMarker(p.fragment)}\n${regionBody(p.fragment.postgres)}${endMarker(p.fragment)}`))
    .join('\n');
}

// ---------------------------------------------------------------------------
// 3. schema-embedded.generated.ts
// ---------------------------------------------------------------------------

const escapeTemplate = (s: string) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');

export function renderEmbedded(schemaSql: string): string {
  return `// AUTO-GENERATED — do not edit. Run: bun run build:schema\n// Source: ${SCHEMA_SQL_PATH}\n\nexport const SCHEMA_SQL = \`\n${escapeTemplate(schemaSql)}\`;\n`;
}

// ---------------------------------------------------------------------------
// 4. PGLite template: capability rules.
// ---------------------------------------------------------------------------

/** Statement identity used by the rules, e.g. `table:pages`, `index:idx_x`, `do:<sha12>`. */
export function identify(s: Stmt): string {
  const t = s.norm;
  let m: RegExpExecArray | null;
  if ((m = /^CREATE TABLE IF NOT EXISTS (\w+)/i.exec(t))) return `table:${m[1]}`;
  if ((m = /^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?IF NOT EXISTS (\w+)/i.exec(t))) return `index:${m[1]}`;
  if ((m = /^CREATE OR REPLACE FUNCTION (\w+)/i.exec(t))) return `function:${m[1]}`;
  if ((m = /^DROP FUNCTION IF EXISTS (\w+)/i.exec(t))) return `drop-function:${m[1]}`;
  if ((m = /^DROP TRIGGER IF EXISTS (\w+) ON (\w+)/i.exec(t))) return `drop-trigger:${m[2]}.${m[1]}`;
  if ((m = /^CREATE TRIGGER (\w+) .*? ON (\w+) /i.exec(t))) return `trigger:${m[2]}.${m[1]}`;
  if ((m = /^ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/i.exec(t))) return `add-column:${m[1]}.${m[2]}`;
  if ((m = /^ALTER TABLE (\w+) DROP COLUMN IF EXISTS (\w+)/i.exec(t))) return `drop-column:${m[1]}.${m[2]}`;
  if ((m = /^ALTER TABLE (\w+) ALTER COLUMN (\w+) SET STORAGE/i.exec(t))) return `set-storage:${m[1]}.${m[2]}`;
  if ((m = /^CREATE EXTENSION IF NOT EXISTS (\w+)/i.exec(t))) return `extension:${m[1]}`;
  if ((m = /^CREATE SEQUENCE IF NOT EXISTS (\w+)/i.exec(t))) return `sequence:${m[1]}`;
  if ((m = /^SELECT setval\('(\w+)'/i.exec(t))) return `setval:${m[1]}`;
  if ((m = /^INSERT INTO (\w+)/i.exec(t))) return `insert:${m[1]}`;
  if (/^DO \$/i.test(t)) return `do:${createHash('sha256').update(t).digest('hex').slice(0, 12)}`;
  if (t === ';') return 'empty';
  return `unknown:${t.slice(0, 60)}`;
}

type Rewrite = (text: string) => string;
interface Rule {
  id: string;
  reason: string;
  action: 'drop' | Rewrite;
}

function replaceOnce(from: string | RegExp, to: string): Rewrite {
  return (text) => {
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- `from` is a constant capability-rule pattern defined in this script; the copy only forces the global flag for counting
    const hits = typeof from === 'string' ? text.split(from).length - 1 : (text.match(new RegExp(from.source, `${from.flags.replace('g', '')}g`)) ?? []).length;
    if (hits !== 1) throw new SchemaBuildError(`PGLite rule expected exactly one match of ${String(from)}, found ${hits}`);
    return text.replace(from, to);
  };
}

function columnLineIndex(lines: string[], column: string): number {
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- `column` is a constant column name from this script's capability rules, never external input
  const idx = lines.map((l, i) => (new RegExp(`^\\s+${column}\\s`).test(l) ? i : -1)).filter((i) => i >= 0);
  if (idx.length !== 1) throw new SchemaBuildError(`PGLite rule expected one column line for ${column}, found ${idx.length}`);
  return idx[0]!;
}

function omitColumns(...columns: string[]): Rewrite {
  return (text) => {
    const lines = text.split('\n');
    for (const c of columns) lines.splice(columnLineIndex(lines, c), 1);
    return lines.join('\n');
  };
}

function moveColumnsAfter(anchor: string, ...columns: string[]): Rewrite {
  return (text) => {
    const lines = text.split('\n');
    const moved = columns.map((c) => lines.splice(columnLineIndex(lines, c), 1)[0]!);
    lines.splice(columnLineIndex(lines, anchor) + 1, 0, ...moved);
    return lines.join('\n');
  };
}

const compose = (...fns: Rewrite[]): Rewrite => (text) => fns.reduce((t, f) => f(t), text);

const POSTGRES_ONLY = 'Postgres-only by design; not part of the PGLite bootstrap';
const MIGRATION_TIMING = 'PGLite gets it later from its migration, so fresh PGLite brains keep master\'s column/object order';

/**
 * Explicit PGLite capability rules, keyed by statement identity. A statement
 * with no rule is portable and copied verbatim. Every rule must match.
 */
export const PGLITE_RULES: readonly Rule[] = [
  { id: 'extension:pgcrypto', reason: 'PGLite ships no pgcrypto; gen_random_uuid() is core', action: 'drop' },
  { id: 'table:sources', reason: `sources.chunker_version: ${MIGRATION_TIMING}`, action: omitColumns('chunker_version') },
  { id: 'add-column:sources.upstream_checked_at', reason: MIGRATION_TIMING, action: 'drop' },
  { id: 'add-column:sources.upstream_commit', reason: MIGRATION_TIMING, action: 'drop' },
  { id: 'add-column:sources.upstream_behind', reason: MIGRATION_TIMING, action: 'drop' },
  { id: 'index:pages_generation_idx', reason: MIGRATION_TIMING, action: 'drop' },
  { id: 'index:idx_pages_updated_at_desc', reason: MIGRATION_TIMING, action: 'drop' },
  {
    id: 'table:content_chunks',
    reason: `embedding dims/model are runtime placeholders; code-symbol and search_vector columns: ${MIGRATION_TIMING}`,
    action: compose(
      replaceOnce(/vector\(1536\)/, 'vector(__EMBEDDING_DIMS__)'),
      replaceOnce("DEFAULT 'text-embedding-3-large'", "DEFAULT '__EMBEDDING_MODEL__'"),
      omitColumns('parent_symbol_path', 'doc_comment', 'symbol_name_qualified', 'search_vector'),
    ),
  },
  { id: 'index:idx_chunks_search_vector', reason: MIGRATION_TIMING, action: 'drop' },
  { id: 'index:idx_chunks_symbol_qualified', reason: MIGRATION_TIMING, action: 'drop' },
  { id: 'function:update_chunk_search_vector', reason: MIGRATION_TIMING, action: 'drop' },
  { id: 'drop-trigger:content_chunks.chunk_search_vector_trigger', reason: MIGRATION_TIMING, action: 'drop' },
  { id: 'trigger:content_chunks.chunk_search_vector_trigger', reason: MIGRATION_TIMING, action: 'drop' },
  ...['code_edges_chunk', 'code_edges_symbol'].flatMap((t): Rule[] => [{ id: `table:${t}`, reason: MIGRATION_TIMING, action: 'drop' }]),
  ...['idx_code_edges_chunk_from', 'idx_code_edges_chunk_to', 'idx_code_edges_chunk_to_symbol', 'idx_code_edges_chunk_from_symbol',
    'idx_code_edges_symbol_from', 'idx_code_edges_symbol_to', 'idx_code_edges_symbol_from_symbol']
    .map((i): Rule => ({ id: `index:${i}`, reason: MIGRATION_TIMING, action: 'drop' })),
  {
    id: 'insert:config',
    reason: 'PGLite records engine=pglite; the embedding model/dims are runtime placeholders',
    action: compose(
      replaceOnce("('version', '1'),\n", "('version', '1'),\n  ('engine', 'pglite'),\n"),
      replaceOnce("('embedding_model', 'text-embedding-3-large')", "('embedding_model', '__EMBEDDING_MODEL__')"),
      replaceOnce("('embedding_dimensions', '1536')", "('embedding_dimensions', '__EMBEDDING_DIMS__')"),
    ),
  },
  { id: 'drop-column:files.storage_url', reason: `${POSTGRES_ONLY} (legacy Supabase Storage column cleanup)`, action: 'drop' },
  { id: 'table:file_migration_ledger', reason: `${POSTGRES_ONLY} (Supabase Storage migration ledger)`, action: 'drop' },
  { id: 'index:idx_file_migration_ledger_status', reason: POSTGRES_ONLY, action: 'drop' },
  {
    id: 'function:update_page_search_vector',
    reason: 'the PGLite blob body has no comment lines; prosrc is pinned by the E4 blob catalog and the upgrade-replay golden',
    action: (text) => text.replace(/\n[ \t]+--[^\n]*(?=\n)/g, ''),
  },
  { id: 'table:minion_jobs', reason: 'master\'s PGLite column order (result/progress/error_text/stacktrace after the private-queue columns)', action: moveColumnsAfter('private_queue_lease_until', 'result', 'progress', 'error_text', 'stacktrace') },
  { id: 'set-storage:minion_attachments.content', reason: `${POSTGRES_ONLY} (TOAST storage tuning)`, action: 'drop' },
  { id: 'table:dream_verdicts', reason: MIGRATION_TIMING, action: 'drop' },
  { id: 'index:dream_verdicts_expires_idx', reason: MIGRATION_TIMING, action: 'drop' },
  { id: 'function:notify_minion_job_change', reason: `${POSTGRES_ONLY} (LISTEN/NOTIFY wakeups need a server)`, action: 'drop' },
  { id: 'drop-trigger:minion_jobs.minion_job_notify', reason: POSTGRES_ONLY, action: 'drop' },
  { id: 'trigger:minion_jobs.minion_job_notify', reason: POSTGRES_ONLY, action: 'drop' },
];

/** DO blocks outside fragment regions are opaque, so each is classified by content hash. */
export const PGLITE_DO_BLOCKS: Readonly<Record<string, { keep: boolean; reason: string }>> = {
  '28b8b384fc62': { keep: false, reason: 'schema.sql RLS enablement block: PGLite has no role system (the shared-skills fragment keeps its own block)' },
};

interface Addition {
  after: string;
  reason: string;
  sql: string;
}

/** PGLite-only statements (Postgres gets these objects from migrations). */
export const PGLITE_ADDITIONS: readonly Addition[] = [
  {
    after: 'index:idx_links_origin',
    reason: 'page_links alias view is part of the PGLite bootstrap; Postgres gets it from a migration',
    sql: `-- v0.38: page_links is the alias the engine queries use (pglite-engine.ts +
-- postgres-engine.ts both JOIN page_links pl ON pl.to_page_id = p.id). The
-- alias predates the table-name standardization; the canonical table is
-- links. Brainstorm domain-bank connection_count tiebreaker and the
-- doctor link-density score read through this view.
--
-- The projection is intentionally NARROW (id, from_page_id, to_page_id only).
-- Engine queries only reference pl.id (via COUNT(*)) and pl.to_page_id.
-- Including link_source / origin_page_id / etc. in the view would couple
-- the alias to columns that didn't exist in pre-v0.13 brains AND would
-- block ALTER TABLE DROP COLUMN on those columns during upgrades.
CREATE OR REPLACE VIEW page_links AS
  SELECT id, from_page_id, to_page_id FROM links;`,
  },
  {
    after: 'drop-function:update_page_search_vector_from_timeline',
    reason: 'slug_aliases / page_aliases are bootstrap tables on PGLite (before the managed-writer guard loop); Postgres gets them from migrations',
    sql: `-- v0.42 type-unification (T1, plan D1+D11+D17): slug_aliases backs the
-- concept-redirect → alias-table migration. Wikilinks like
-- [[old-redirect-slug]] resolve to canonical via engine.resolveSlugWithAlias
-- short-circuit. Source-scoped throughout (codex F12: dangling_aliases
-- doctor check joins on (source_id, alias_slug)).
CREATE TABLE IF NOT EXISTS slug_aliases (
  id             BIGSERIAL PRIMARY KEY,
  source_id      TEXT NOT NULL,
  alias_slug     TEXT NOT NULL,
  canonical_slug TEXT NOT NULL,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT slug_aliases_no_self CHECK (alias_slug <> canonical_slug),
  CONSTRAINT slug_aliases_uniq UNIQUE (source_id, alias_slug)
);
CREATE INDEX IF NOT EXISTS slug_aliases_canonical_idx
  ON slug_aliases (source_id, canonical_slug);

-- T3 retrieval-cathedral (retrieval-maxpool incident): free-text alias
-- resolution for SEARCH. Distinct from slug_aliases (slug->slug wikilink
-- redirect): page_aliases maps a normalized free-text name ("hall of light",
-- "明堂") to a canonical slug so a query that is a chosen name surfaces the
-- page. alias_norm is normalizeAlias() output; the (source_id, alias_norm,
-- slug) triple is unique so re-ingest is idempotent without blocking a second
-- page claiming the same alias (collisions reported + resolved at query time).
CREATE TABLE IF NOT EXISTS page_aliases (
  id          BIGSERIAL PRIMARY KEY,
  source_id   TEXT NOT NULL,
  alias_norm  TEXT NOT NULL,
  slug        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT page_aliases_uniq UNIQUE (source_id, alias_norm, slug)
);
CREATE INDEX IF NOT EXISTS page_aliases_lookup_idx
  ON page_aliases (source_id, alias_norm);
CREATE INDEX IF NOT EXISTS page_aliases_slug_idx
  ON page_aliases (source_id, slug);`,
  },
];

export function renderPgliteTemplateSql(schemaSql: string): string {
  const out: string[] = [];
  const usedRules = new Set<string>();
  const usedDo = new Set<string>();
  const usedAdditions = new Set<Addition>();
  for (const part of parseSchemaSql(schemaSql)) {
    if (part.kind === 'region') {
      out.push(`\n${regionBody(part.fragment.pglite)}`);
      continue;
    }
    for (const s of splitSql(part.text, part.line)) {
      if (!s.norm) {
        out.push(s.text);
        continue;
      }
      const id = identify(s);
      if (id.startsWith('unknown:')) {
        fail(`${SCHEMA_SQL_PATH}:${s.line} has a statement the PGLite generator does not recognize: ${s.norm.slice(0, 80)}`,
          'the PGLite bootstrap is derived statement by statement; an unknown construct may be Postgres-only.',
          'teach identify() in scripts/build-schema.ts the statement kind and add a PGLITE_RULES entry if PGLite needs it changed or dropped.');
      }
      let text = s.text;
      if (id.startsWith('do:')) {
        const cls = PGLITE_DO_BLOCKS[id.slice(3)];
        if (!cls) {
          fail(`${SCHEMA_SQL_PATH}:${s.line} DO block ${id.slice(3)} is not classified for PGLite`,
            'DO blocks are opaque (roles, RLS, catalog probes); each must be explicitly kept or dropped for PGLite.',
            `add '${id.slice(3)}': { keep: <true|false>, reason: '...' } to PGLITE_DO_BLOCKS in scripts/build-schema.ts.`);
        }
        usedDo.add(id.slice(3));
        if (!cls.keep) continue;
      }
      const rule = PGLITE_RULES.find((r) => r.id === id);
      if (rule) {
        if (usedRules.has(rule.id)) fail(`${SCHEMA_SQL_PATH}:${s.line} matches PGLite rule ${rule.id} a second time`, 'rules are keyed by statement identity and must match exactly one statement.', 'make the identity unique or split the rule.');
        usedRules.add(rule.id);
        if (rule.action === 'drop') continue;
        text = rule.action(text);
      }
      out.push(stripSqlComments(text));
      for (const a of PGLITE_ADDITIONS.filter((x) => x.after === id)) {
        usedAdditions.add(a);
        out.push(`\n${stripSqlComments(a.sql).replace(/\s+$/, '')}\n`);
      }
    }
  }
  const stale = [
    ...PGLITE_RULES.filter((r) => !usedRules.has(r.id)).map((r) => `rule ${r.id}`),
    ...Object.keys(PGLITE_DO_BLOCKS).filter((k) => !usedDo.has(k)).map((k) => `DO block ${k}`),
    ...PGLITE_ADDITIONS.filter((a) => !usedAdditions.has(a)).map((a) => `addition anchored after ${a.after}`),
  ];
  if (stale.length > 0) {
    fail(`PGLite capability rules no longer match ${SCHEMA_SQL_PATH}: ${stale.join(', ')}`,
      'a rule whose statement changed or disappeared would silently stop applying.',
      'update or delete the rule in scripts/build-schema.ts to match the new schema.sql text.');
  }
  return `\n-- GBrain PGLite schema (local embedded Postgres), generated from ${SCHEMA_SQL_PATH}\n-- and the TS schema fragments by scripts/build-schema.ts.\n${out.join('')}\n`;
}

export function renderPgliteModule(schemaSql: string): string {
  return `// AUTO-GENERATED — do not edit. Run: bun run build:schema
// Sources: ${SCHEMA_SQL_PATH} + the TS fragment modules, transformed by the PGLite
// capability rules in scripts/build-schema.ts (docs/ENGINES.md#canonical-schema-sources).
// A template: __EMBEDDING_DIMS__ / __EMBEDDING_MODEL__ and the chunk-index and
// FTS-language policies are applied at runtime by getPGLiteSchema(dims, model).

import { applyChunkEmbeddingIndexPolicy } from './vector-index.ts';
import { applyFtsLanguagePolicy } from './fts-language.ts';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } from './ai/defaults.ts';

export const PGLITE_SCHEMA_SQL_TEMPLATE = \`${escapeTemplate(renderPgliteTemplateSql(schemaSql))}\`;

export function getPGLiteSchema(
  dims: number = DEFAULT_EMBEDDING_DIMENSIONS,
  model: string = DEFAULT_EMBEDDING_MODEL,
): string {
  const parsedDims = Number(dims);
  if (!Number.isInteger(parsedDims) || parsedDims <= 0) {
    throw new Error(\`Invalid embedding dimensions: \${dims}\`);
  }
  const sanitizedModel = String(model).replace(/'/g, "''");
  return applyFtsLanguagePolicy(applyChunkEmbeddingIndexPolicy(PGLITE_SCHEMA_SQL_TEMPLATE, parsedDims))
    .replace(/__EMBEDDING_DIMS__/g, String(parsedDims))
    .replace(/__EMBEDDING_MODEL__/g, sanitizedModel);
}

/** Back-compat: pre-computed default-1536 schema for existing callers. */
export const PGLITE_SCHEMA_SQL = getPGLiteSchema();
`;
}

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

export interface BuildOutputs {
  [repoPath: string]: string;
}

/** Run the whole chain in fixed order from the committed schema.sql. */
export function buildAll(schemaSqlIn = readFileSync(join(REPO, SCHEMA_SQL_PATH), 'utf8')): BuildOutputs {
  const schemaSql = renderSchemaSql(schemaSqlIn);
  return {
    [SCHEMA_SQL_PATH]: schemaSql,
    [EMBEDDED_PATH]: renderEmbedded(schemaSql),
    [PGLITE_PATH]: renderPgliteModule(schemaSql),
  };
}

function main(argv: string[]): number {
  let outDir = REPO;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out-dir') outDir = resolve(argv[++i]!);
    else {
      console.error(`unknown argument ${argv[i]}`);
      return 2;
    }
  }
  let outputs: BuildOutputs;
  try {
    outputs = buildAll();
  } catch (e) {
    if (e instanceof SchemaBuildError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
  for (const [path, text] of Object.entries(outputs)) {
    const target = join(outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    if (outDir === REPO) console.log(`Generated ${path}`);
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
