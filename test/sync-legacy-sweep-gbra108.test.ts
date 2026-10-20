/**
 * GBRA-108 (GBRA-133 latency §6.14): the first managed sync after activating a classic brain sweeps every legacy page
 * (design §2.7) through the read-only same-content screen. Before the fix each screened page re-read the config table,
 * the source's config, its binding, root, writer, managed mode, shared packs and purge tombstones, and its own page three
 * times (about 18 statements a page), and the sweep recorded nothing until it had screened the whole source: at 100k
 * pages on Postgres it outlived the drain's 300 s no-progress window, the pass was abandoned with nothing kept, and the
 * next pass started the sweep over.
 *
 * Protects:
 * - within a slice the sweep's statements do not grow with its legacy pages: each kind of page read (snapshot, origin,
 *   timeline, takes, chunker fence) and the record writes run once a slice, and no pass-invariant read (config, source
 *   config, binding, root, writer, managed mode, shared packs, purge tombstones) runs more often for more pages;
 * - a pass stopped mid-sweep keeps the records of the slices it finished: the next pass screens only the rest, records
 *   the first full sweep and leaves no legacy page unverified.
 *
 * PGLite here (statements counted at the PGLite protocol); Postgres through
 * test/e2e/sync-legacy-sweep-gbra108-postgres.test.ts (the wire trace, src/core/sql-trace.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { drainProjections } from '../src/core/page-state/projections.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { LEGACY_SWEEP_SLICE } from '../src/core/persistence/sync-pass-apply.ts';
import { sliceReads } from '../src/core/persistence/import-reads.ts';
import { STORED_TIMELINE_SQL, TAKE_COLLISIONS_SQL } from '../src/core/persistence/canonical-projections.ts';
import { SYNC_ORIGIN_PAGES_SQL } from '../src/core/persistence/sync-origin.ts';
import { SAFE_FENCE_SQL } from '../src/core/page-state/projections.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';
import { MANAGED_SYNC_PASS_OP } from '../src/core/persistence/sync-pass-row.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { countPgliteStatements, readSqlTrace, type StatementRecord } from './helpers/statement-counter.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const names = (count: number) => Array.from({ length: count }, (_, i) => `n${String(i).padStart(3, '0')}`);
const setupNotes = (count: number) => ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const name of names(count)) writeFileSync(join(root, `notes/${name}.md`), `---\ntype: concept\ntitle: notes/${name}\n---\n\nThe committed body of notes/${name}.\n`);
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
};
/**
 * Statements a legacy page may add to its sweep: none. Its slice reads each kind once (snapshot, origin, timeline, takes,
 * chunker fence) and writes its records together, so a slice costs a constant; the half statement a page is headroom for
 * the background work the counter also sees. A read per page coming back costs at least one a page (about 18 before GBRA-108).
 */
const PER_PAGE_BUDGET = 0.5;
/**
 * Reads every screened preparation repeats; the sweep answers each once per slice, never once per page. The config read is
 * the plain `SELECT … FROM config`: the projection drain's statement, which also reads config, runs on its own timer.
 */
const INVARIANT = [/^\s*SELECT [\w, ]+ FROM config\b/, /SELECT config FROM sources\b/, /FROM persistence_brain\b/, /FROM persistence_local_writers\b/, /FROM page_purges\b/,
  /FROM shared_skill_packs\b/, /SELECT local_path FROM sources\b/, /FROM persistence_source_bindings s\b/];

const passRow = async (engine: BrainEngine) => (await engine.executeRaw<{ value: any }>('SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1', [MANAGED_SYNC_PASS_OP]))[0]?.value ?? null;
const recorded = async (engine: BrainEngine) => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM op_checkpoints WHERE op=$1', [SYNC_IMPORT_PROVENANCE_OP]))[0]!.n;

/** Turns the synced pages into pages an older gbrain imported: the same rows with no import record, and no pass row. */
async function legacyPages(engine: BrainEngine): Promise<void> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try {
    const cols = 'source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, source_path';
    const rows = await engine.executeRaw<Record<string, unknown>>(`SELECT ${cols} FROM pages WHERE source_id='default'`);
    await engine.executeRaw("DELETE FROM pages WHERE source_id='default'");
    for (const row of rows) await engine.executeRaw(`INSERT INTO pages(${cols}) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [row.source_id, row.slug, row.type, row.title, row.compiled_truth, row.timeline, JSON.stringify(row.frontmatter), row.content_hash, row.source_path]);
  } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op IN ($1,$2)', [SYNC_IMPORT_PROVENANCE_OP, MANAGED_SYNC_PASS_OP]);
  // The rewritten rows' projection rebuilds run now, not inside the measured sync.
  while ((await drainProjections(engine, { limit: 100 })).rebuilt > 0);
}

/** The statements `run` sends: the PGLite protocol, or the Postgres wire trace's records inside its window. */
async function counted(engine: BrainEngine, trace: string, run: () => Promise<unknown>): Promise<StatementRecord[]> {
  if (engine.kind === 'pglite') {
    const counter = countPgliteStatements(engine as PGLiteEngine);
    try { await run(); } finally { counter.stop(); }
    return counter.records;
  }
  const started = performance.timeOrigin + performance.now();
  await run();
  const ended = performance.timeOrigin + performance.now();
  // The trace flushes every second.
  await Bun.sleep(1500);
  return readSqlTrace(trace).filter(record => record.t >= started && record.t <= ended && (record.kind === 'execute' || record.kind === 'simple'));
}

/** The first managed sync after the pages turned legacy: its statements, telemetry and records. */
async function sweep(count: number, databaseUrl: string | undefined, trace: string) {
  let out: { records: StatementRecord[]; counts: Record<string, number>; recorded: number; legacySweep: unknown } | null = null;
  await managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await legacyPages(engine);
    const records = await counted(engine, trace, async () => { expect((await performManagedSync(engine, OPTS)).status).not.toBe('blocked_by_failures'); });
    const row = await passRow(engine);
    out = { records, counts: row.telemetry.counts, recorded: await recorded(engine), legacySweep: row.obligations.legacy_sweep ?? null };
  }, { databaseUrl, setup: setupNotes(count) });
  return out!;
}

afterEach(() => installFaultHook(undefined));

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  describe(`GBRA-108: the legacy sweep after activation (${backend})`, () => {
    test('the sweep costs a bounded number of statements per legacy page, and no pass-invariant read runs per page', async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-legacy-sweep-'));
      const trace = join(home, 'trace.jsonl');
      try {
        await withEnv({ GBRAIN_SQL_TRACE: databaseUrl ? trace : undefined, GBRAIN_SQL_TRACE_LABEL: databaseUrl ? 'legacy-sweep' : undefined }, async () => {
          const small = await sweep(12, databaseUrl, trace), large = await sweep(48, databaseUrl, trace);
          for (const [run, n] of [[small, 12], [large, 48]] as const) {
            expect(run.counts).toMatchObject({ legacy_swept: n, legacy_recorded: n });
            expect(run.recorded).toBe(n);
            expect(run.legacySweep).toMatchObject({ first_full_at: expect.any(String) });
          }
          // The counter saw both syncs (each reads its pages at least once).
          expect(small.records.length).toBeGreaterThan(12);
          const perPage = (large.records.length - small.records.length) / (48 - 12);
          expect(perPage).toBeLessThanOrEqual(PER_PAGE_BUDGET);
          const uses = (records: StatementRecord[]) => INVARIANT.map(pattern => [String(pattern), records.filter(record => pattern.test(record.sql)).length]);
          expect(uses(large.records)).toEqual(uses(small.records));
        });
      } finally { rmSync(home, { recursive: true, force: true }); }
    }, 300_000);

    test('a pass stopped mid-sweep keeps the slices it recorded; the next pass sweeps only the rest and records the first full sweep', () => managedBrain(async ({ engine }) => {
      const total = LEGACY_SWEEP_SLICE + 20;
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      await legacyPages(engine);
      let slices = 0;
      installFaultHook(async point => { if (point === 'sync:legacy_slice' && ++slices === 2) throw new Error('killed mid-sweep'); });
      const stopped = await performManagedSync(engine, OPTS).then(result => result.status, (error: Error) => error.message);
      expect(stopped).not.toMatch(/^(synced|up_to_date)$/);
      installFaultHook(undefined);
      // The first slice's records committed before the stop; the pass recorded no full sweep.
      expect(await recorded(engine)).toBe(LEGACY_SWEEP_SLICE);
      expect((await passRow(engine))?.obligations.legacy_sweep ?? null).toBeNull();

      expect((await performManagedSync(engine, OPTS)).status).not.toBe('blocked_by_failures');
      const row = await passRow(engine);
      expect(row.telemetry.counts).toMatchObject({ legacy_swept: total - LEGACY_SWEEP_SLICE, legacy_recorded: total - LEGACY_SWEEP_SLICE });
      expect(row.obligations.legacy_sweep).toMatchObject({ first_full_at: expect.any(String) });
      expect(row.telemetry.summary.legacy_unverified).toBe(0);
      expect(await recorded(engine)).toBe(total);
    }, { databaseUrl, setup: setupNotes(LEGACY_SWEEP_SLICE + 20) }), 300_000);

    test('a slice read answers each page read as the page\'s own statement does, and a read it does not cover runs its own', () => managedBrain(async ({ engine }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      const pages = await engine.executeRaw<{ id: number; source_path: string }>("SELECT id, source_path FROM pages WHERE source_id='default' ORDER BY id");
      const [taken, plain, outside] = [pages.find(p => p.source_path === 'notes/n000.md')!, pages.find(p => p.source_path === 'notes/n001.md')!, pages.find(p => p.source_path === 'notes/n002.md')!];
      expect(await engine.executeRaw('SELECT 1 FROM takes WHERE page_id=$1', [taken.id])).not.toEqual([]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const [date, summary] of [['2024-03-02', 'second'], ['2024-01-05', 'first']]) await engine.executeRaw('INSERT INTO timeline_entries(page_id,date,summary) VALUES($1,$2,$3)', [plain.id, date, summary]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const slice = sliceReads(engine, { sourceId: 'default', pageIds: [taken.id, plain.id], origins: ['notes/n000.md', 'notes/n001.md'] });
      const collide = JSON.stringify([{ row_num: 1, claim: 'another claim', kind: 'take', holder: 'brain' }]);
      const reads: Array<[string, unknown[]]> = [
        [SYNC_ORIGIN_PAGES_SQL, ['default', ['notes/n000.md']]], [SYNC_ORIGIN_PAGES_SQL, ['default', ['notes/n000.md', 'notes/n001.md']]], [SYNC_ORIGIN_PAGES_SQL, ['default', ['notes/n002.md']]],
        ...[taken, plain, outside].flatMap(page => [[STORED_TIMELINE_SQL, [page.id]], [SAFE_FENCE_SQL, [page.id]], [TAKE_COLLISIONS_SQL, [page.id, collide, 50]]] as Array<[string, unknown[]]>)];
      const byId = (rows: unknown[]) => [...rows].sort((a, b) => Number((a as { id?: number }).id ?? 0) - Number((b as { id?: number }).id ?? 0));
      for (const [sql, params] of reads) expect(byId(await slice.executeRaw(sql, params))).toEqual(byId(await engine.executeRaw(sql, params)));
      expect((await slice.executeRaw<{ row_num: number }>(TAKE_COLLISIONS_SQL, [taken.id, collide, 50])).map(row => Number(row.row_num))).toEqual([1]);
      expect((await slice.executeRaw(STORED_TIMELINE_SQL, [plain.id])).map(row => (row as { summary: string }).summary)).toEqual(['first', 'second']);
    }, { databaseUrl, setup: ({ root }) => {
      setupNotes(3)({ root });
      writeFileSync(join(root, 'notes/n000.md'), `---\ntype: concept\ntitle: notes/n000\n---\n\nA page with a take.\n\n${TAKES_FENCE_BEGIN}\n| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|\n| 1 | a durable hunch | take | brain | 0.8 | 2026-04 | note |\n${TAKES_FENCE_END}\n`);
      git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'take');
    } }), 300_000);
  });
}
