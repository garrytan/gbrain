/**
 * #5151: the extract_facts cycle phase drains pages whose facts watermark is
 * behind the page (`page_facts_reconcile`, src/core/facts/reconcile-watermark.ts).
 *
 * Protects: on an unmanaged brain, a fence imported by a standalone
 * `gbrain sync` reaches the facts index on the next dream cycle even though
 * the cycle's own sync is a no-op; removing a page's whole fence expires its
 * fence rows (`cli:` rows and withdrawals untouched); an edit to an already
 * indexed fence is reconciled; a second run with nothing changed reconciles
 * nothing and issues no `UPDATE pages`; malformed or lock-held pages at the
 * head of the drain do not starve later pages; doctor names fence pages that
 * are not reconciled yet.
 * Fails when: extract_facts only visits the slugs the cycle's sync reported
 * (the pre-#5151 behavior: `slugs: []` after a no-op sync reconciled nothing).
 * Why existing coverage misses it: phase tests pass explicit slugs or a full
 * walk; nothing ran a standalone sync before the cycle.
 * Seams: none; real PGLite (and Postgres through the e2e registration),
 * a real git checkout for the sync case, `runCycle` and `runExtractFacts`.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performSync } from '../src/commands/sync.ts';
import { runCycle } from '../src/core/cycle.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { applyFactsReconcileBacklog, readFactsReconcileBacklog } from '../src/core/facts/reconcile-watermark.ts';
import { acquirePageLock } from '../src/core/page-lock.ts';
import { managedPersistenceEnabled } from '../src/core/persistence/ownership.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const fence = (rows: string): string => `## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
<!--- gbrain:facts:end -->
`;
const row = (n: number, claim: string): string => `| ${n} | ${claim} | fact | 1.0 | world | high | 2024-01-01 |  | notes |  |`;
const body = (rows: string): string => `# Page\n\nProse.\n\n${fence(rows)}`;

async function brain(databaseUrl: string | undefined, run: (b: { engine: BrainEngine; home: string }) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-facts-drain-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        await run({ engine, home });
      } finally {
        await close();
      }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function put(engine: BrainEngine, slug: string, compiled: string): Promise<void> {
  await engine.putPage(slug, { type: 'person', title: slug, compiled_truth: compiled, timeline: '', frontmatter: {} });
}

async function activeFacts(engine: BrainEngine) {
  return engine.executeRaw<{ slug: string; fact: string; row_num: number | null }>(
    `SELECT source_markdown_slug AS slug, fact, row_num FROM facts WHERE expired_at IS NULL ORDER BY source_markdown_slug, row_num, fact`);
}

async function generationClock(engine: BrainEngine): Promise<string> {
  const [r] = await engine.executeRaw<{ v: string }>('SELECT last_value::text AS v FROM page_generation_clock_seq');
  return r!.v;
}

const drainRun = (engine: BrainEngine, extra: Parameters<typeof runExtractFacts>[1] = {}) =>
  runExtractFacts(engine, { slugs: [], drain: {}, ...extra });

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: a standalone sync then a dream cycle reconciles the imported fence`, () => brain(databaseUrl, async ({ engine, home }) => {
    const repo = join(home, 'repo');
    mkdirSync(join(repo, 'people'), { recursive: true });
    writeFileSync(join(repo, 'people', 'alice-example.md'),
      `---\ntype: person\ntitle: Alice Example\n---\n${body(row(1, 'Alice example joined Acme example'))}`);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'seed');
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [repo]);
    await performSync(engine, { sourceId: 'default', noPull: true, noEmbed: true });
    expect(await activeFacts(engine)).toEqual([]);

    const report = await runCycle(engine, { brainDir: repo, sourceId: 'default', phases: ['sync', 'extract_facts'] });
    const phase = report.phases.find(p => p.phase === 'extract_facts')!;
    expect(phase.details).toMatchObject({ factsInserted: 1, pagesFailed: 0 });
    expect(await activeFacts(engine)).toEqual([{ slug: 'people/alice-example', fact: 'Alice example joined Acme example', row_num: 1 }]);
  }), 60_000);

  test(`${backend}: a second run with nothing changed reconciles nothing and issues no UPDATE pages`, () => brain(databaseUrl, async ({ engine }) => {
    await put(engine, 'people/alice-example', body(row(1, 'Claim one')));
    await put(engine, 'notes/plain', '# Plain\n\nNo facts here.');
    const first = await drainRun(engine);
    expect(first.factsInserted).toBe(1);
    const clock = await generationClock(engine);
    const second = await drainRun(engine);
    expect({ scanned: second.pagesScanned, inserted: second.factsInserted, clock: await generationClock(engine) })
      .toEqual({ scanned: 0, inserted: 0, clock });
    expect(await readFactsReconcileBacklog(engine)).toEqual({ pending: 0, invalid: [] });
  }), 60_000);

  test(`${backend}: an edit to an already indexed fence is reconciled by the drain`, () => brain(databaseUrl, async ({ engine }) => {
    await put(engine, 'people/alice-example', body(row(1, 'Claim one')));
    await drainRun(engine);
    await put(engine, 'people/alice-example', body(`${row(1, 'Claim one')}\n${row(2, 'Claim two')}`));
    const r = await drainRun(engine);
    expect(r.factsInserted).toBe(1);
    expect((await activeFacts(engine)).map(f => f.fact)).toEqual(['Claim one', 'Claim two']);
  }), 60_000);

  test(`${backend}: removing the whole fence expires its rows; cli: facts and withdrawals survive`, () => brain(databaseUrl, async ({ engine }) => {
    await put(engine, 'people/alice-example', body(`${row(1, 'Claim one')}\n${row(2, 'Claim two')}`));
    await drainRun(engine);
    await engine.insertFacts( // gbrain-allow-direct-insert: test fixture for a conversation-origin row
      [{ fact: 'Said in a meeting', kind: 'fact', source: 'cli:session-1', row_num: 100, source_markdown_slug: 'people/alice-example' }],
      { source_id: 'default' },
    );
    await engine.executeRaw(
      `INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash) VALUES ('default', 'world', 'people/alice-example', 'abc123')`);
    await put(engine, 'people/alice-example', '# Page\n\nProse only now.');
    const r = await drainRun(engine);
    expect(r.factsDeleted).toBe(2);
    expect(await activeFacts(engine)).toEqual([{ slug: 'people/alice-example', fact: 'Said in a meeting', row_num: 100 }]);
    const [w] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM fact_withdrawals');
    expect(Number(w!.n)).toBe(1);
  }), 60_000);

  test(`${backend}: malformed pages at the head of the drain do not starve later pages`, () => brain(databaseUrl, async ({ engine }) => {
    for (const n of [1, 2, 3]) {
      await put(engine, `people/broken-${n}`, `# Broken\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim |\n|---|---|\n| x | not a row |\n<!--- gbrain:facts:end -->\n`);
    }
    await put(engine, 'people/tail', body(row(1, 'Tail claim')));
    const first = await drainRun(engine, { drain: { pageLimit: 2 } });
    expect(first.factsInserted).toBe(0);
    const second = await drainRun(engine, { drain: { pageLimit: 2 } });
    expect(second.factsInserted).toBe(1);
    expect((await activeFacts(engine)).map(f => f.fact)).toEqual(['Tail claim']);
    expect((await drainRun(engine, { drain: { pageLimit: 2 } })).pagesScanned).toBe(0);

    const backlog = await readFactsReconcileBacklog(engine);
    expect(backlog.invalid.map(p => p.slug)).toEqual(['people/broken-1', 'people/broken-2', 'people/broken-3']);
    const check = { status: 'ok' as 'ok' | 'warn' | 'fail', message: 'all extractors healthy', details: {} as Record<string, unknown> };
    applyFactsReconcileBacklog(check, backlog);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('3 page(s) have a Facts fence extract_facts cannot read (people/broken-1, people/broken-2, people/broken-3)');

    await put(engine, 'people/broken-1', body(row(1, 'Fixed claim')));
    expect((await drainRun(engine)).factsInserted).toBe(1);
  }), 60_000);

  test(`${backend}: a page whose reconcile keeps deferring rotates behind the rest`, () => brain(databaseUrl, async ({ engine, home }) => {
    const lockRoot = join(home, '.locks');
    await put(engine, 'people/head', body(`${row(1, 'Head one')}\n${row(2, 'Head two')}`));
    await put(engine, 'people/tail', body(row(1, 'Tail one')));
    await drainRun(engine);
    await put(engine, 'people/head', body(row(1, 'Head one')));
    await put(engine, 'people/tail', body(`${row(1, 'Tail one')}\n${row(2, 'Tail two')}`));
    const held = await acquirePageLock('people/head', { lockRoot });
    try {
      const first = await drainRun(engine, { drain: { pageLimit: 1 }, pageLockRoot: lockRoot });
      expect(first.warnings).toContainEqual(expect.stringContaining('people/head: FACTS_PAGE_LOCK_TIMEOUT'));
      const second = await drainRun(engine, { drain: { pageLimit: 1 }, pageLockRoot: lockRoot });
      expect(second.factsInserted).toBe(1);
    } finally {
      await held!.release();
    }
    expect((await readFactsReconcileBacklog(engine)).pending).toBe(1);
    const third = await drainRun(engine, { pageLockRoot: lockRoot });
    expect(third.factsDeleted).toBe(1);
    expect((await activeFacts(engine)).map(f => f.fact)).toEqual(['Head one', 'Tail one', 'Tail two']);
  }), 60_000);

  test(`${backend}: doctor names fence pages that are not reconciled yet, and a full run clears them`, () => brain(databaseUrl, async ({ engine }) => {
    await put(engine, 'people/alice-example', body(row(1, 'Claim one')));
    await put(engine, 'notes/plain', '# Plain\n\nNo facts here.');
    const backlog = await readFactsReconcileBacklog(engine);
    expect(backlog).toEqual({ pending: 1, invalid: [] });
    const check = { status: 'ok' as 'ok' | 'warn' | 'fail', message: 'all extractors healthy', details: {} as Record<string, unknown> };
    applyFactsReconcileBacklog(check, backlog);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('to reconcile every page now run: gbrain dream --phase extract_facts');
    await runExtractFacts(engine, {});
    expect(await readFactsReconcileBacklog(engine)).toEqual({ pending: 0, invalid: [] });
  }), 60_000);

  if (backend === 'postgres') {
    test('postgres: a page rewritten on another connection while its reconcile waits is never committed stale', () => brain(databaseUrl, async ({ engine }) => {
      await put(engine, 'people/race', body(row(1, 'Old claim')));
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const writer = engine.transaction(async tx => {
        await tx.executeRaw(`SELECT 1 FROM pages WHERE slug = 'people/race' FOR UPDATE`);
        await gate;
        await tx.executeRaw(`UPDATE pages SET compiled_truth = $1 WHERE slug = 'people/race'`, [body(row(1, 'New claim'))]);
      });
      const run = drainRun(engine);
      for (let i = 0; i < 200; i++) {
        const [w] = await engine.executeRaw<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
        if (Number(w!.n) > 0) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      release();
      await writer;
      const raced = await run;
      expect(raced.factsInserted).toBe(0);
      expect(await activeFacts(engine)).toEqual([]);
      expect((await readFactsReconcileBacklog(engine)).pending).toBe(1);
      expect((await drainRun(engine)).factsInserted).toBe(1);
      expect((await activeFacts(engine)).map(f => f.fact)).toEqual(['New claim']);
    }), 60_000);
  }

  test(`${backend}: without the drain option an empty slug list still reconciles nothing`, () => brain(databaseUrl, async ({ engine }) => {
    await put(engine, 'people/alice-example', body(row(1, 'Claim one')));
    const r = await runExtractFacts(engine, { slugs: [] });
    expect({ scanned: r.pagesScanned, inserted: r.factsInserted }).toEqual({ scanned: 0, inserted: 0 });
  }), 60_000);
}
