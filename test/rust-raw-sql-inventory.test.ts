/**
 * Raw SQL by design on a Rust brain: every product call site of the session and migration seams
 * (withReservedConnection, executeRawDirect, keywordBoundedRead, runMigration) is listed here with the reason a Rust
 * brain never reaches it, or reaches it only to get the typed `engine_capability_missing` refusal (reason raw_sql)
 * back, never a silent fallback.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the Rust engine has no SQL dialect, so these four members refuse with raw_sql (D18). A caller on an
 *    agent-facing path (CLI, MCP, search) either checks the engine first (an engine-kind guard or a typed Rust
 *    member), or an earlier raw read on the same path refuses first. The tally counts the parity cases that call these
 *    members directly as "refused by design: no SQL on Rust".
 *  - Regression: a new call site of one of these members, or one moved into a new file, with no reviewed reason. The
 *    case that motivated this list: search dedup's segmentRegions called keywordBoundedRead, caught the Rust refusal
 *    and returned no regions, so search on a Rust brain dropped far-apart passages of a large page with no error.
 *  - Why existing coverage misses it: test/rust-engine-no-raw-proof.test.ts traces the import, search and cycle-lock
 *    paths on PGLite only, and the parity raw-sql cases call the members directly, so neither sees a new caller.
 *  - Seam: none (reads src/). test/rust-engine-store.test.ts pins the runtime half on the real addon: each member
 *    refuses raw_sql before its callback runs, and segmentRegions on Rust never calls keywordBoundedRead.
 *
 * executeRaw is not listed: it has thousands of product call sites, and they are the Rust port's backlog, not a
 * design choice. Its parity case is the raw SQL entry point itself (test/engine-parity/raw-sql.test.ts).
 */
// test-reads-source-ok[structural]: call-site inventory of the raw seams; the reviewed list is the guard.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');

type Member = 'withReservedConnection' | 'executeRawDirect' | 'keywordBoundedRead' | 'runMigration';
const MEMBERS: readonly Member[] = ['withReservedConnection', 'executeRawDirect', 'keywordBoundedRead', 'runMigration'];

/**
 * Whole areas a Rust brain never runs: the SQL engines' own code, and migration bodies (the Rust engine's initSchema
 * runs no SQL migration; `gbrain apply-migrations` on a Rust brain reaches runMigration and gets the raw_sql refusal,
 * migrate.ts applyOneMigration, which it does not catch).
 */
const SQL_ONLY_AREAS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^src\/core\/(postgres|pglite)-engine(\.ts$|\/)/, 'a SQL engine implementing its own members'],
  [/^src\/core\/engine-sql\//, 'shared SQL of the SQL engines; the Rust engine serves its members from the store'],
  [/^src\/core\/schema-migrations\//, 'a SQL migration body, run only by the migration runner'],
];

/** Every other product file that calls a member: the count of call sites and why a Rust brain is safe there. */
const SITES: Record<Member, Record<string, { count: number; why: string }>> = {
  withReservedConnection: {
    'src/core/backfill-base.ts': { count: 2, why: 'the index build returns first unless engine.kind is postgres; the batch write runs after the batch read, whose executeRaw refuses raw_sql first' },
    'src/core/embedding-ann-build.ts': { count: 1, why: 'inside engine.kind === postgres; the index probe before it refuses raw_sql on Rust' },
    'src/core/migration-preludes.ts': { count: 1, why: 'returns first unless engine.kind is postgres' },
    'src/core/persistence/bounded-reads.ts': { count: 1, why: 'runs fn(engine) directly unless engine.kind is postgres' },
    'src/core/persistence/consumer.ts': { count: 1, why: 'the idle lane returns first unless engine.kind is postgres' },
    'src/core/persistence/origin-index.ts': { count: 1, why: 'inside engine.kind === postgres' },
    'src/core/vector-index.ts': { count: 1, why: 'returns first unless engine.kind is postgres' },
  },
  executeRawDirect: {
    'src/core/persistence/consumer-lane.ts': { count: 1, why: 'consumerStatementEngine returns the engine unchanged unless engine.kind is postgres' },
    'src/core/persistence/journal.ts': { count: 1, why: 'reclaims a managed-persistence write; a Rust brain refuses managed persistence at admission (rust-engine/errors.ts)' },
  },
  keywordBoundedRead: {
    'src/core/search/dedup.ts': { count: 1, why: 'segmentRegions asks engine.readSegmentRegions first, which the Rust engine defines' },
  },
  runMigration: {
    'src/core/facts/fts-index.ts': { count: 1, why: 'the index state read before it (executeRaw on pg_index) refuses raw_sql first' },
    'src/core/function-search-path.ts': { count: 1, why: 'the pg_proc read before it (executeRaw) refuses raw_sql first, and the caller rethrows' },
    'src/core/link-source-check-repair.ts': { count: 3, why: 'checkLinkSourceCheck answers needsRepair false on Rust (the links store enforces the gate), so the repair returns already_correct before any DDL' },
    'src/core/migrate.ts': { count: 3, why: 'the migration runner; the Rust engine initSchema never calls it, and a direct call gets the raw_sql refusal uncaught' },
    'src/core/schema-missing-tables.ts': { count: 5, why: 'readMissingTables calls sqlEngineKind first, which refuses raw_sql on Rust' },
    'src/core/schema-verify.ts': { count: 1, why: 'the information_schema read before it (executeRaw) refuses raw_sql first' },
  },
};

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (path.endsWith('.ts')) yield path;
  }
}

const callRe = (member: Member) => new RegExp(`\\.${member}\\b\\s*(<[^>()]*>)?\\s*\\(`, 'g');

/** member -> file -> call-site count, over product code outside the SQL-only areas. */
function inventory(): Record<Member, Record<string, number>> {
  const found = Object.fromEntries(MEMBERS.map(m => [m, {} as Record<string, number>])) as Record<Member, Record<string, number>>;
  for (const path of walk(SRC)) {
    const rel = relative(ROOT, path).split('\\').join('/');
    if (SQL_ONLY_AREAS.some(([re]) => re.test(rel))) continue;
    const text = readFileSync(path, 'utf8');
    for (const member of MEMBERS) {
      const count = text.match(callRe(member))?.length ?? 0;
      if (count > 0) found[member][rel] = count;
    }
  }
  return found;
}

describe('raw SQL by design: call sites of the session and migration seams', () => {
  test('every product call site outside the SQL engines and migrations is listed with its reason', () => {
    const listed = Object.fromEntries(MEMBERS.map(m => [m, Object.fromEntries(Object.entries(SITES[m]).map(([f, s]) => [f, s.count]))]));
    // A failure here names a new or moved call site: show why a Rust brain never reaches it (an engine-kind guard, a
    // typed Rust member, or an earlier raw read that refuses first), then add it to SITES with that reason.
    expect(inventory()).toEqual(listed as Record<Member, Record<string, number>>);
  });

  test('every listed reason is a sentence and every SQL-only area still exists', () => {
    for (const member of MEMBERS) for (const [file, site] of Object.entries(SITES[member])) {
      expect({ file, member, why: site.why.length >= 20 }).toEqual({ file, member, why: true });
    }
    const files = [...walk(SRC)].map(p => relative(ROOT, p).split('\\').join('/'));
    for (const [re, why] of SQL_ONLY_AREAS) expect({ why, present: files.some(f => re.test(f)) }).toEqual({ why, present: true });
  });
});
