/**
 * Guard: every SQL literal in src/ that reads `sources` and sorts by the source id sorts in byte order
 * (`COLLATE "C"`), so the result order is the same on PGLite and on a Postgres server of any locale.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a raw read of the sources list returns ids in byte order (`a-c`, `a0`, `ab`) whatever the server
 *    locale. That is the order PGLite and the Rust engine give.
 *  - Regression: a new `ORDER BY id` (or `s.id`, `name`, `ORDER BY 1`) on a `sources` read without `COLLATE "C"`.
 *    On an en_US.utf8 Postgres it sorts `a0, ab, a-c`, which changes output order, which source a tie-break picks,
 *    and preview hashes built from the list.
 *  - Why existing coverage misses it: the test suites and CI run PGLite and a C-locale Postgres container, where
 *    the default collation already sorts in byte order, so an uncollated sort passes every behavior test.
 *  - Seam: source text, because the bug only shows on a server locale no test database uses.
 *
 * Exempt: row-lock reads (`FOR UPDATE` / `FOR SHARE`) keep the lock order the other lockers use (topology-locks,
 * core-guard); see EXEMPT for the rest. Each exemption must still match, so a stale one fails.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');
const SRC = join(REPO_ROOT, 'src');

/** `file|ORDER BY clause start` → why the sort may stay in the server collation. */
const EXEMPT: Record<string, string> = {
  'src/core/engine-sql/synopsis-tier.ts|ORDER BY id':
    'sorts the union output column id, which the first branch already selects as `id COLLATE "C"`.',
  'src/core/engine-sql/sources.ts|ORDER BY id LIMIT 2':
    'readSoleSourceId only checks that exactly one row exists; the order picks nothing (ruling C keeps its SQL).',
  // Master d02e67de11 (#10372): listActiveSourceConfigs keeps master's text, `SELECT id, config, archived FROM sources
  // WHERE archived = false ORDER BY id`; the key covers the statement and its doc comment quoting it.
  'src/core/engine-sql/sources.ts|ORDER BY id':
    'listActiveSourceConfigs sends master\'s statement byte for byte (`SELECT id, config, archived FROM sources WHERE archived = false ORDER BY id`); its one caller, source-resolver.ts liveSourceRows, re-sorts the rows with sortSourcesById.',
  'src/core/engine-sql/git-gap-census.ts|ORDER BY 1':
    'column 1 is a hold code, not a source id.',
  'src/core/sync-attempt.ts|ORDER BY created_at DESC, id DESC LIMIT':
    'sorts minion_jobs ids; sources is only a subquery.',
  'src/core/engine-sql/applied-watermark-reads.ts|ORDER BY started_at, id LIMIT 1':
    'sorts minion_jobs ids; sources is only a subquery.',
  'src/core/engine-sql/belief-state.ts|ORDER BY 1) = ARRAY(SELECT unnest(${[...':
    'sorts page keys on both sides of an equality; the order is never output.',
  'src/core/engine-sql/belief-state.ts|ORDER BY 1) AS ok), known_fp AS (SELECT':
    'sorts page keys on both sides of an equality; the order is never output.',
  'src/core/engine-sql/writer-admin.ts|ORDER BY id) FROM persistence_worktrees)':
    'sorts worktree ids, not source ids.',
  'src/core/engine-sql/stale-atom-reads.ts|ORDER BY CASE class WHEN \'origin_gone\' T':
    'sorts atom ids, not source ids.',
};

const LITERAL = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/gs;
const READS_SOURCES = /\b(?:FROM|JOIN)\s+sources\b(?!_)/;
const ORDER_BY = /ORDER BY\s+([\s\S]*?)(?=\bLIMIT\b|\bFOR\s+(?:UPDATE|SHARE)\b|\bOFFSET\b|\)|$|\$\{)/g;
const UNCOLLATED_ID = /(?:^|[\s,(])(?:(?:s|src|sources)\.)?(?:id|name)\b(?!\s*(?:COLLATE|=|\())/;

interface Finding { file: string; line: number; key: string; clause: string }

/** Uncollated sources-id sorts in one file's text. Row-lock reads are skipped. */
function scanText(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  for (const lit of text.matchAll(LITERAL)) {
    const body = lit[0].slice(1, -1);
    if (!READS_SOURCES.test(body)) continue;
    for (const ob of body.matchAll(ORDER_BY)) {
      const clause = ob[1]!.split(/\s+/).join(' ').trim();
      if (!UNCOLLATED_ID.test(clause) && !/^1\b/.test(clause)) continue;
      const tail = body.slice(ob.index!, ob.index! + 200);
      if (/FOR\s+(?:UPDATE|SHARE)/.test(tail)) continue;
      const at = lit.index! + 1 + ob.index!;
      const key = `${file}|${body.slice(ob.index!, ob.index! + 120).split(/\s+/).join(' ').slice(0, 40).trimEnd()}`;
      out.push({ file, line: text.slice(0, at).split('\n').length, key, clause });
    }
  }
  return out;
}

function listTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTs(full));
    else if (entry.endsWith('.ts') && !entry.includes('generated')) out.push(full);
  }
  return out;
}

describe('sources id sorts use byte order', () => {
  test('the scanner flags an uncollated sort and passes a collated, locked or default-first one', () => {
    const bad = scanText('x.ts', "const a = 'SELECT id FROM sources WHERE NOT archived ORDER BY id';\n"
      + 'const b = `SELECT s.id FROM sources s JOIN pages p ON p.source_id = s.id ORDER BY s.id, p.slug`;\n'
      + 'const c = `SELECT s.id FROM sources s WHERE s.archived ORDER BY 1`;\n');
    expect(bad.map((f) => [f.line, f.clause])).toEqual([[1, 'id'], [2, 's.id, p.slug'], [3, '1']]);
    const good = scanText('y.ts', 'const a = `SELECT id FROM sources ORDER BY id COLLATE "C"`;\n'
      + "const b = \"SELECT id FROM sources ORDER BY (id = 'default') DESC, id COLLATE \\\"C\\\"\";\n"
      + "const c = 'SELECT id FROM sources ORDER BY id FOR UPDATE';\n"
      + "const d = 'SELECT slug FROM pages ORDER BY id';\n");
    expect(good).toEqual([]);
  });

  test('every sources id sort in src/ is collated, locked or exempt, and no exemption is stale', () => {
    const findings = listTs(SRC).flatMap((abs) => {
      const rel = relative(REPO_ROOT, abs);
      // test-reads-source-ok[structural]: the locale bug only shows on a server collation no test database uses.
      return scanText(rel, readFileSync(abs, 'utf-8'));
    });
    const offenders = findings.filter((f) => !(f.key in EXEMPT)).map((f) => `${f.file}:${f.line} ORDER BY ${f.clause} (exemption key: ${f.key})`);
    expect(offenders).toEqual([]);
    const used = new Set(findings.map((f) => f.key));
    expect(Object.keys(EXEMPT).filter((k) => !used.has(k))).toEqual([]);
  });
});
