/**
 * Lane L0-2: a second, independent read of the transaction callbacks the scan flagged (/code/.plans/l0-2/callback-audit-l0.md).
 *
 * A transaction callback may run more than once: on a Rust brain in multi-user mode a commit that loses a conflict keeps
 * nothing and the engine runs the callback again from a fresh snapshot (docs/designs/rust-engine/multi-user-server.md).
 * Anything the callback changes outside `tx` (a captured counter, array, flag, a file, an audit line) must start each run
 * from the same state or move after the commit. Each case below drives the real caller with a lost first run: the first
 * run's database writes are really rolled back (PGLite), or a stub engine's callback runs twice and keeps the second, and
 * the caller must report the surviving run only. This file complements test/optimistic-callback-rerun.test.ts (lane L1).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { restampSource } from '../src/core/access/policy.ts';
import { backfillEffectiveDate } from '../src/core/backfill-effective-date.ts';
import * as factsImpl from '../src/core/engine-sql/facts.ts';
import { runDerivationSweep } from '../src/core/page-body/segment-derive.ts';
import type { BrainEngine } from '../src/core/engine.ts';

/** A stub engine: `members` answer by name; `transaction(fn)` runs fn on the engine twice, keeping the second result. */
function l0RerunningEngine(members: Record<string, (...args: never[]) => unknown>): never {
  const engine: Record<string, unknown> = { ...members };
  engine.transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    await fn(engine); // the run that loses its commit: its writes are dropped, the callback is not told
    return fn(engine);
  };
  return engine as never;
}

const L0_LOST = new Error('lost optimistic commit');

/**
 * Makes the FIRST transaction call of `target` (or the first whose callback source contains `only`) a lost commit: the
 * callback runs inside a real transaction that is then rolled back (its writes vanish, what it kept outside stays), and the
 * call runs again for real. Returns a restore function and the number of runs of the wrapped call.
 */
function l0LoseFirstCommit(target: BrainEngine, only?: string): { runs: () => number; restore: () => void } {
  const original = Object.getPrototypeOf(target).transaction as BrainEngine['transaction'];
  let lost = false;
  let runs = 0;
  (target as { transaction: unknown }).transaction = async function (this: BrainEngine, fn: (tx: BrainEngine) => Promise<unknown>, opts?: Parameters<BrainEngine['transaction']>[1]) {
    if (this !== target || lost || (only !== undefined && !fn.toString().includes(only))) return original.call(this, fn, opts);
    lost = true;
    await original.call(target, async tx => { runs++; await fn(tx); throw L0_LOST; }, opts).catch((error: unknown) => { if (error !== L0_LOST) throw error; });
    runs++;
    return original.call(target, fn, opts);
  } as BrainEngine['transaction'];
  return { runs: () => runs, restore: () => { delete (target as { transaction?: unknown }).transaction; } };
}

describe('row 60 restampSource (src/core/access/policy.ts): the restamp count is taken after the commit', () => {
  test('row 60: a rerun of the closing transaction counts the pages it restamped once', async () => {
    const engine = l0RerunningEngine({
      readAccessStateUnreadable: async () => false,
      restampAccessWindow: async () => ({ last: null, scanned: 0, changed: 0 }),
      lockAccessPolicy: async () => undefined,
      finishAccessRestamp: async () => 4,
    });
    expect((await restampSource(engine, 'default')).pages_restamped).toBe(4);
  });
});

describe('row 144 insertFacts (src/core/engine-sql/facts.ts): a warning is reported once', () => {
  test('row 144: a rerun of the insert transaction does not repeat the dangling-reference warning', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      const exec = (engine as unknown as { engineSql: { transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> } }).engineSql;
      let runs = 0;
      // The executor's transaction: the first run is rolled back for real, the second one commits.
      const rerunning = new Proxy(exec, { get: (target, prop) => {
        if (prop === 'transaction') {
          return async (fn: (tx: unknown) => Promise<unknown>) => {
            await target.transaction(async tx => { runs++; await fn(tx); throw L0_LOST; }).catch((error: unknown) => { if (error !== L0_LOST) throw error; });
            runs++;
            return target.transaction(fn);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      // One fact whose `superseded by #99` names a row that does not exist: exactly one dangling-reference warning.
      const rows = [{ fact: 'Claim 1', kind: 'fact', entity_slug: 'people/alice', visibility: 'world', notability: 'medium', source: 'test:fixture', confidence: 1,
        row_num: 1, source_markdown_slug: 'people/alice', superseded_by_row: 99 }];
      const result = await factsImpl.insertFacts(rerunning as never, undefined, rows as never, { source_id: 'default' });
      expect(runs).toBe(2);
      expect(result.inserted).toBe(1);
      expect(result.warnings).toHaveLength(1);
    } finally { await engine.disconnect(); }
  }, 60_000);
});

describe('row 269 runDerivationSweep (src/core/page-body/segment-derive.ts): a parked record belongs to the batch that committed', () => {
  test('row 269: a rerun that picks another record does not finish the id the lost run parked', async () => {
    const A = '00000000-0000-4000-8000-00000000000a';
    const B = '00000000-0000-4000-8000-00000000000b';
    const record = (id: string) => ({ request_id: id, needles: ['n'], patterns: [], page_ids: null, phase: 'sweep', recheck: null, found: 0,
      cursor_page: null, cursor_pipeline: null, cursor_occurrence: null, batch_rows: 2 });
    const finished: string[] = [];
    let picks = 0;
    let transactions = 0;
    const engine: Record<string, unknown> = {
      executeRaw: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM page_segment_derivation_purges WHERE source_id=$1')) { picks++; return picks === 1 ? [record(A)] : picks === 2 ? [record(B)] : []; }
        if (sql.includes('last AS (')) {
          // Run 1 walks to the end of its source (scanned < batch_rows); the rerun reads a full batch.
          return [{ page_id: null, swept: 0, normalized: 0, deleted: 0, scanned: picks === 1 ? 0 : 2, last_page: 1, last_pipeline: 'p', last_occurrence: '1' }];
        }
        if (sql.includes('pg_try_advisory_xact_lock')) return [{ held: false }]; // a writer holds the scope lock: the record is parked
        if (sql.includes('FOR UPDATE SKIP LOCKED') && sql.includes('request_id=$1::uuid')) finished.push(String(params[0]));
        return [];
      },
    };
    // Only the batch transaction is a lost commit; finishing a parked record runs once.
    engine.transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
      transactions++;
      if (transactions === 1) await fn(engine);
      return fn(engine);
    };
    await runDerivationSweep(engine as never, 'default', {}, { batchRows: 2, statementMs: 1000, inlineMs: 10_000, totalMs: 10_000, finalizeWaitMs: 100 });
    expect(picks).toBeGreaterThanOrEqual(2);
    expect(finished).not.toContain(A);
  });
});

describe('row 325 backfillEffectiveDate (src/core/backfill-effective-date.ts): a batch counts its rows once', () => {
  test('row 325: a rerun of the batch transaction reports each updated page, fallback and change once', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const lost = l0LoseFirstCommit(engine, 'UPDATE pages SET effective_date');
    try {
      for (const slug of ['wiki/one', 'wiki/two']) {
        await engine.executeRaw(
          `INSERT INTO pages (source_id, slug, type, title, frontmatter, effective_date, effective_date_source)
           VALUES ('default', $1, 'note', $1, '{}'::jsonb, NULL, NULL)`, [slug]);
      }
      const changed: string[] = [];
      const result = await backfillEffectiveDate(engine, { fresh: true, onChange: row => { changed.push(row.slug); } });
      expect(lost.runs()).toBe(2); // the lost run, then the run that kept its writes
      expect({ updated: result.updated, fallback: result.fallback, changed: changed.sort() })
        .toEqual({ updated: 2, fallback: 2, changed: ['wiki/one', 'wiki/two'] });
    } finally { lost.restore(); await engine.disconnect(); }
  }, 60_000);
});

// ---- audit rows below were written as separate blocks (dynamic imports, partA prefix) ----

// Multi-user Rust: a transaction whose optimistic commit is lost keeps none of its writes and its callback runs AGAIN from a fresh
// snapshot, but whatever the callback changed outside `tx` stays. `partALost` is the faithful wrapper for a real database: the FIRST
// call that `pick` selects runs `fn` inside a real transaction and then throws a sentinel (a real ROLLBACK of its writes; the
// callback's outside-state changes stay); `between` may then change the database like a competing winner; then the real transaction
// runs the callback again.
type PartAEngine = import('../src/core/engine.ts').BrainEngine;
function partALost(outer: PartAEngine, pick: (source: string) => boolean, between?: () => Promise<void>): { reran: () => boolean; restore: () => void } {
  const transaction = Object.getPrototypeOf(outer).transaction as PartAEngine['transaction'];
  const LOST = new Error('lost optimistic commit');
  let reran = false;
  outer.transaction = async function (this: PartAEngine, fn: (tx: PartAEngine) => Promise<unknown>, opts?: Parameters<PartAEngine['transaction']>[1]) {
    if (this !== outer || reran || !pick(fn.toString())) return transaction.call(this, fn, opts);
    reran = true;
    await transaction.call(outer, async tx => { await fn(tx); throw LOST; }, opts).catch((e: unknown) => { if (e !== LOST) throw e; });
    await between?.();
    return transaction.call(outer, fn, opts);
  } as PartAEngine['transaction'];
  return { reran: () => reran, restore: () => { delete (outer as { transaction?: unknown }).transaction; } };
}

describe('company-brain runtime resumeCompanyBrain: the sync-approval transaction callback runs again after a lost commit', () => {
  let home = '';
  let engine!: PartAEngine;
  beforeAll(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    home = mkdtempSync(join(tmpdir(), 'gbrain-partA-company-'));
    const lite = new PGLiteEngine();
    await lite.connect({});
    await lite.initSchema();
    engine = lite;
  }, 120_000);
  afterAll(async () => {
    const { rmSync } = await import('node:fs');
    const { withEnv } = await import('./helpers/with-env.ts');
    const { disposePersistenceConsumer } = await import('../src/core/persistence/service.ts');
    await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
    rmSync(home, { recursive: true, force: true });
  });

  test('row 271: a rerun of the sync-approval transaction still approves the new commit, once, with the new receipt linked', async () => {
    const { randomUUID } = await import('node:crypto');
    const { execFileSync } = await import('node:child_process');
    const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { withEnv } = await import('./helpers/with-env.ts');
    const { makeGitFixture } = await import('./helpers/git-fixture.ts');
    const { inspectCompanyBrain } = await import('../src/core/company-brain/inspection.ts');
    const { companyBrainProfile } = await import('../src/core/company-brain/profile.ts');
    const { getSourceIngestionReceipt } = await import('../src/core/company-brain/receipts.ts');
    const { connectCompanyBrain, resumeCompanyBrain } = await import('../src/core/company-brain/runtime.ts');
    const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', root, ...args], { encoding: 'utf8' }).trim();
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      const root = mkdtempSync(join(home, 'repo-'));
      await makeGitFixture(root);
      for (const [path, body] of Object.entries({
        'people/operator.md': '---\ntype: person\ntitle: Example Operator\n---\n# Example Operator\nOwns the account.\n',
        'customers/account.md': '---\ntype: customer\ntitle: Example Account\nowner: "[[people/operator]]"\naudience: internal\n---\n# Example Account\nA synthetic account with an explicit owner.\n',
        'README.md': '# Excluded scaffolding\n',
      })) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); }
      git(root, 'add', '.'); git(root, 'commit', '-qm', 'Synthetic source fixture');
      const input = { brainId: 'company-example', sourceId: `company-${randomUUID().slice(0, 8)}`, path: root,
        plan: await inspectCompanyBrain({ path: root, profile: 'company-brain' }), remote: false, requestId: randomUUID() };
      expect((await connectCompanyBrain(engine, input)).ok).toBe(true);
      const [before] = await engine.executeRaw<{ config: unknown; incarnation: string }>('SELECT config,incarnation FROM sources WHERE id=$1', [input.sourceId]);
      expect(companyBrainProfile(before.config)?.receiptId).toBe(input.requestId);

      // A new commit makes `resume` take the sync-approval transaction (it begins a new receipt for the new revision).
      writeFileSync(join(root, 'customers/account.md'), `${'---\ntype: customer\ntitle: Example Account\nowner: "[[people/operator]]"\naudience: internal\n---\n# Example Account\n'}A committed update.\n`);
      git(root, 'add', '.'); git(root, 'commit', '-qm', 'Synthetic source update');

      const lost = partALost(engine, source => source.includes('company-brain-plan'));
      let resumed: Awaited<ReturnType<typeof resumeCompanyBrain>> | undefined;
      try {
        resumed = await resumeCompanyBrain(engine, { brainId: input.brainId, sourceId: input.sourceId, remote: false });
      } finally { lost.restore(); }
      expect(lost.reran()).toBe(true);
      // Before the fix the rerun read the stored receipt against the lost run's new receipt id and threw source_changed.
      expect(resumed).toMatchObject({ ok: true, code: 'complete', receipt: { phase: 'COMPLETE', outcome: 'complete' } });
      expect(resumed!.receipt.id).not.toBe(input.requestId);
      const [after] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [input.sourceId]);
      expect(companyBrainProfile(after.config)?.receiptId).toBe(resumed!.receipt.id);
      expect(await getSourceIngestionReceipt(engine, { sourceId: input.sourceId, sourceIncarnation: before.incarnation, receiptId: resumed!.receipt.id }))
        .toMatchObject({ approvedRevision: git(root, 'rev-parse', 'HEAD') });
      // Exactly one new plan checkpoint survived: the lost run's insert was rolled back, the rerun's stands.
      expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='company-brain-plan' AND fingerprint=$1", [resumed!.receipt.id])).toHaveLength(1);
    });
  }, 120_000);
});

describe('connector sync ManagedConnectorSync.submit: the retry-approval transaction callback runs again after a lost commit', () => {
  test('row 374: a rerun that finds the retry already settled counts no page admission', async () => {
    const { withEnv } = await import('./helpers/with-env.ts');
    const fx = await import('./helpers/connector-fixture.ts');
    const { parseGitHubSourceConfig, runGitHubSync } = await import('../src/core/github-source.ts');
    const { disposePersistenceConsumer } = await import('../src/core/persistence/service.ts');
    const { readManagedConnectorState } = await import('../src/core/persistence/connector-state.ts');
    const { engines, env, source, setup, teardown } = fx.createConnectorFixture();
    await setup();
    try {
      await withEnv(env, async () => {
        const engine = engines[0]!;
        const f = await source(engine, fx.githubConfig);
        let updated = false;
        const fetcher = async (url: string) => {
          const issue = { ...fx.issueFixture, body: updated ? 'Updated retry body' : 'Initial retry body', updated_at: updated ? '2026-01-03T00:00:00Z' : fx.issueFixture.updated_at };
          const path = new URL(url).pathname;
          if (path.endsWith('/issues')) return fx.json([issue]);
          if (path.endsWith('/issues/1')) return fx.json(issue);
          return fx.githubFetch()(url);
        };
        const cfg = parseGitHubSourceConfig(fx.githubConfig, f.dir);
        const run = (retryFailed = false) => runGitHubSync(engine, f.id, cfg, { ...fx.options, retryFailed }, fetcher);
        await fx.completeBaselineSweep(engine, f.id, run);
        await disposePersistenceConsumer(engine);
        // A real storage failure of the page write leaves a failed receipt that only an explicit retry replaces.
        await engine.executeRaw('CREATE TABLE partA_faults(source_id text PRIMARY KEY)');
        await engine.executeRaw(`CREATE FUNCTION partA_page_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF EXISTS(SELECT 1 FROM partA_faults x WHERE x.source_id=NEW.source_id) THEN RAISE EXCEPTION 'Synthetic page storage failure' USING ERRCODE='58030'; END IF;
          RETURN NEW; END $$`);
        await engine.executeRaw('CREATE TRIGGER partA_page_fault BEFORE INSERT OR UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION partA_page_fault()');
        await engine.executeRaw('INSERT INTO partA_faults(source_id) VALUES($1)', [f.id]);
        updated = true;
        await expect(run()).rejects.toMatchObject({ code: 'storage_error' });
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('DELETE FROM partA_faults WHERE source_id=$1', [f.id]);
        const [failed] = await engine.executeRaw<{ id: string; request_id: string }>("SELECT id,request_id FROM persistence_requests WHERE source_id=$1 AND state='failed'", [f.id]);
        expect(failed).toBeDefined();

        // The retry approval's first run loses its commit; before its rerun another run settles the failed request (the receipt
        // is no longer retryable), so the rerun takes the early `!mayRetry(current.row)` return and admits nothing.
        const lost = partALost(engine, code => code.includes('declarePersistenceProtocol') && code.includes('managed-connector-retry'), async () => {
          await engine.executeRaw("UPDATE persistence_requests SET state='committed' WHERE id=$1::uuid", [failed.id]);
        });
        try { await run(true); } finally { lost.restore(); }
        expect(lost.reran()).toBe(true);
        expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND intent->>'retryOf'=$2", [f.id, failed.request_id])).toHaveLength(0);
        const [row] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [f.id]);
        const lastRun = (await readManagedConnectorState(engine, f.id, row.incarnation)).last_run;
        // Before the fix the flag set by the lost run stayed true and the rerun counted an admission that never happened.
        expect(lastRun).toMatchObject({ page_admissions: 0 });
      });
    } finally { await teardown(); }
  }, 120_000);
});

// ---- audit rows below were written as separate blocks (dynamic imports, partB prefix) ----

// Part B of the L0-2 callback rerun tests (audit rows 346 and 153). Lane lead merges these blocks into
// test/optimistic-callback-rerun-l0.test.ts; only bun:test is imported statically, every helper name starts with `partB`.

/**
 * Wrap `engine.transaction` so the call chosen by `pick` runs its callback inside a real transaction and then loses the commit
 * (real ROLLBACK of its database writes; whatever the callback did outside `tx` stays), and the callback runs again for real.
 * `onDiscard` runs at the moment the wrapper discards the first run. Returns a restore function and the run counter.
 */
function partBLoseFirstCommit(engine: import('../src/core/engine.ts').BrainEngine, pick: (fn: (tx: import('../src/core/engine.ts').BrainEngine) => Promise<unknown>) => boolean,
  onDiscard: () => void) {
  type Engine = import('../src/core/engine.ts').BrainEngine;
  const outer = engine;
  const transaction = Object.getPrototypeOf(outer).transaction as Engine['transaction'];
  const LOST = new Error('lost optimistic commit');
  const state = { reran: false, callbackRuns: 0 };
  outer.transaction = async function (this: Engine, fn: (tx: Engine) => Promise<unknown>, opts?: Parameters<Engine['transaction']>[1]) {
    if (this !== outer || state.reran || !pick(fn)) return transaction.call(this, fn, opts);
    state.reran = true;
    const counted = async (tx: Engine) => { state.callbackRuns++; return fn(tx); };
    await transaction.call(outer, async tx => { await counted(tx); throw LOST; }, opts).catch((e: unknown) => { if (e !== LOST) throw e; });
    onDiscard();
    return transaction.call(outer, counted, opts);
  } as Engine['transaction'];
  return { state, restore: () => { delete (outer as { transaction?: unknown }).transaction; } };
}

describe('reconcile-backup manageReconcileBackups: remove is not done before the commit', () => {
  let engine: import('../src/core/engine.ts').BrainEngine;
  let home: string;
  const modules: Record<string, any> = {};
  beforeAll(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    home = mkdtempSync(join(tmpdir(), 'gbrain-partb-reconcile-'));
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    modules.withEnv = (await import('./helpers/with-env.ts')).withEnv;
  }, 120_000);
  afterAll(async () => {
    const { rmSync } = await import('node:fs');
    const { disposePersistenceConsumer } = await import('../src/core/persistence/service.ts');
    await modules.withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
    rmSync(home, { recursive: true, force: true });
  });

  test('row 346: a removal whose transaction callback runs again after a lost commit removes the backup once and answers removed:true', async () => {
    const { randomUUID } = await import('node:crypto');
    const { existsSync, mkdirSync, readdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { configDir } = await import('../src/core/config.ts');
    const { importFromContent } = await import('../src/core/import-file.ts');
    const { serializePageToMarkdown } = await import('../src/core/markdown.ts');
    const { claimWorktree } = await import('../src/core/persistence/ownership.ts');
    const { registerLocalWriter, withVerifiedLocalRegistration } = await import('../src/core/persistence/identity.ts');
    const { runReconcileApply, runReconcileBackups, runReconcilePreview } = await import('../src/core/persistence/reconcile.ts');
    const { disposePersistenceConsumer } = await import('../src/core/persistence/service.ts');
    await modules.withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, DATABASE_URL: undefined }, async () => {
      // A retained backup for a terminal canonical_reconcile put_page request (same fixture as test/persistence-reconcile.test.ts).
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      const id = `reconcile-${randomUUID().slice(0, 12)}`, root = join(home, id), slug = 'notes/example';
      mkdirSync(join(root, 'notes'), { recursive: true });
      await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
      await importFromContent(engine, slug, '---\ntype: note\ntitle: Example\ncustom_database: kept\n---\nA useful durable example observation.\n',
        { sourceId: id, sourcePath: `${slug}.md`, noEmbed: true });
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId: id }))!;
      writeFileSync(join(root, `${slug}.md`), serializePageToMarkdown({ ...snapshot.page, frontmatter: { custom_file: 'kept' } }, snapshot.tags));
      await claimWorktree(engine, id, root);
      const registration = await registerLocalWriter(engine, 'cli');
      await withVerifiedLocalRegistration(engine, registration, async () => {
        const { preview } = await runReconcilePreview(engine, { source_id: id, slug });
        const applied = await runReconcileApply(engine, { source_id: id, slug, preview, request_id: randomUUID() });
        expect(applied.state).toBe('committed');
        const reference = (applied.outcome as { backup_reference: string }).backup_reference;
        const directory = join(configDir(), 'reconciliation-previews');
        const path = join(directory, reference);
        expect(existsSync(path)).toBe(true);
        const bytes = (await import('node:fs')).statSync(path).size;

        // The first run of the removal's transaction callback loses its commit; look at the file when the wrapper discards it.
        let existedWhenDiscarded: boolean | undefined;
        const lost = partBLoseFirstCommit(engine, fn => fn.toString().includes('backup is not a private ordinary file'), () => { existedWhenDiscarded = existsSync(path); });
        let result: Record<string, unknown>;
        try {
          result = await runReconcileBackups(engine, { source_id: id, slug, action: 'remove', backup_reference: reference });
        } finally { lost.restore(); }
        expect(lost.state.reran).toBe(true);
        expect(lost.state.callbackRuns).toBe(2);
        // The lost first run rolled back: the file must still be there when it is discarded (nothing committed yet).
        expect(existedWhenDiscarded).toBe(true);
        // The committed run answers what really happened: the backup was removed, with its size.
        expect(result).toEqual({ removed: true, backup_reference: reference, request_id: result.request_id, bytes });
        expect(existsSync(path)).toBe(false);
        expect(readdirSync(directory).filter(name => name.endsWith('.json'))).toEqual([]);
        // A second removal of the same, now absent, backup says so.
        expect(await runReconcileBackups(engine, { source_id: id, slug, action: 'remove', backup_reference: reference }))
          .toEqual({ removed: false, backup_reference: reference, request_id: result.request_id });
      });
    });
  }, 240_000);
});

describe('mcp-provision provisionHarnessGrant: the private credential delivery is not written for a lost run', () => {
  let engine: import('../src/core/engine.ts').BrainEngine;
  let home: string;
  beforeAll(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    home = mkdtempSync(join(tmpdir(), 'gbrain-partb-provision-'));
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' }); await engine.initSchema();
  }, 120_000);
  afterAll(async () => {
    const { rmSync } = await import('node:fs');
    await engine.disconnect();
    rmSync(home, { recursive: true, force: true });
  });

  test('row 153: a grant whose transaction callback runs again after a lost commit leaves one delivery file, for the surviving client', async () => {
    const { existsSync, readdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const { withEnv } = await import('./helpers/with-env.ts');
    const { provisionHarnessGrant } = await import('../src/commands/mcp-provision.ts');
    const { deliveryPath, recoverCredentialDelivery } = await import('../src/core/harness/delivery.ts');
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const input = { name: 'partb-rerun-example', harness: 'muse', url: 'https://brain.example.com/mcp' };
      const directory = dirname(deliveryPath('gbrain_cl_probe'));
      const files = () => existsSync(directory) ? readdirSync(directory).sort() : [];
      expect(files()).toEqual([]);

      // The first run of the grant transaction registers a client and retains its handoff, then loses its commit.
      let atDiscard: string[] | undefined;
      const lost = partBLoseFirstCommit(engine, () => true, () => { atDiscard = files(); });
      let created: Awaited<ReturnType<typeof provisionHarnessGrant>>;
      try {
        created = await provisionHarnessGrant(engine, input, 'test');
      } finally { lost.restore(); }
      expect(lost.state.reran).toBe(true);
      expect(lost.state.callbackRuns).toBe(2);

      const surviving = created.grant.clientId;
      expect(await engine.executeRaw('SELECT client_id FROM oauth_clients WHERE client_name = $1', [input.name])).toEqual([{ client_id: surviving }]);
      // Exactly one handoff file remains, and it names the surviving client and secret: none for the rolled-back client.
      expect(files()).toEqual([`${surviving}.json`]);
      expect(recoverCredentialDelivery(surviving, 'https://brain.example.com/mcp').client_secret).toBe(created.credentials?.client_secret);
      expect(created.credential_action).toBe('save_private_handoff');
      // The handoff is still written before the commit (a crash after the commit must not lose the only copy of the secret), for a client
      // that never committed; the rerun removed it.
      expect(atDiscard).toHaveLength(1);
      expect(atDiscard).not.toEqual([`${surviving}.json`]);
    });
  }, 120_000);
});

// ---- audit rows below were written as separate blocks (dynamic imports, partC prefix) ----

/**
 * Part C: a transaction callback that runs again after a lost optimistic commit (multi-user Rust). The wrapper below makes
 * the FIRST matching transaction a faithful lost commit on a real database: the callback runs inside a real transaction,
 * a sentinel throw rolls its writes back, whatever the callback changed outside `tx` stays, and the callback then runs
 * again in a fresh transaction. Rows 49 (publish redaction audit line), 94 (owner page repair file) and 371/372 (belief point).
 */
type PartCEngine = import('../src/core/engine.ts').BrainEngine;
type PartCTx = (fn: (tx: PartCEngine) => Promise<unknown>, opts?: unknown) => Promise<unknown>;

/**
 * Installs the lost-commit wrapper on `engine`: the first top-level transaction whose callback text passes `match` runs
 * and rolls back, `between(tx)` (optional, a real committed write) runs after the rollback, then the callback runs for real.
 * Returns { runs, restore }.
 */
function partCLoseFirstCommit(engine: PartCEngine, match: (fnText: string) => boolean, between?: () => Promise<void>, beforeLose?: (tx: PartCEngine) => Promise<void>) {
  const outer = engine;
  const real = Object.getPrototypeOf(outer).transaction as PartCTx;
  const LOST = new Error('lost optimistic commit');
  const state = { runs: 0, lost: false };
  (outer as unknown as { transaction: PartCTx }).transaction = async function (this: PartCEngine, fn, opts) {
    if (this !== outer || state.lost || !match(fn.toString())) return real.call(this, fn, opts);
    state.lost = true;
    await real.call(outer, async tx => { state.runs++; await fn(tx); await beforeLose?.(tx); throw LOST; }, opts).catch((e: unknown) => { if (e !== LOST) throw e; });
    if (between) await between();
    return real.call(outer, async tx => { state.runs++; return fn(tx); }, opts);
  } as PartCTx;
  return { state, restore: () => { delete (outer as { transaction?: unknown }).transaction; } };
}

describe('secret-spans redactPageForPublish: the audit line is written after the commit', () => {
  let partCDir = '';
  let partCEngine: PartCEngine;
  const partCToken = 'ghp_' + 'Zt4q'.repeat(9);

  beforeAll(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    partCDir = mkdtempSync(join(tmpdir(), 'gbrain-partc-49-'));
    partCEngine = new PGLiteEngine();
    await partCEngine.connect({});
    await partCEngine.initSchema();
  }, 120_000);
  afterAll(async () => {
    const { rmSync } = await import('node:fs');
    await partCEngine?.disconnect();
    rmSync(partCDir, { recursive: true, force: true });
  });

  test('row 49: a redaction whose callback runs again after a lost commit writes one publish-redact audit line', async () => {
    const { readFileSync, readdirSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { withEnv } = await import('./helpers/with-env.ts');
    const { importFromContent } = await import('../src/core/import-file.ts');
    const { redactPageForPublish } = await import('../src/core/repair/secret-spans.ts');
    const audit = join(partCDir, 'audit');
    await withEnv({ GBRAIN_HOME: partCDir, GBRAIN_AUDIT_DIR: audit }, async () => {
      const slug = 'notes/partc-rerun-redact';
      await importFromContent(partCEngine, slug, `---\ntype: note\ntitle: Partc Rerun\n---\n\nThe deploy key is ${partCToken} in this note.\n`, { noEmbed: true, sourceId: 'default' });
      const wrapper = partCLoseFirstCommit(partCEngine, text => text.includes('lockPageKeys'));
      try {
        expect(await redactPageForPublish(partCEngine, 'default', slug)).toBe('redacted');
      } finally { wrapper.restore(); }
      expect(wrapper.state.runs).toBe(2); // the lost run and the surviving run both ran the callback
      const lines = existsSync(audit) ? readdirSync(audit).flatMap(name => readFileSync(join(audit, name), 'utf8').split('\n').filter(Boolean)) : [];
      const mine = lines.map(line => JSON.parse(line) as { kind: string; slug: string }).filter(row => row.kind === 'publish-redact' && row.slug === slug);
      expect(mine.length).toBe(1);
      const page = (await partCEngine.getPage(slug, { sourceId: 'default' }))!;
      expect(page.compiled_truth).not.toContain(partCToken);
      expect(lines.join('\n')).not.toContain(partCToken);
    });
  }, 120_000);
});

describe('page-handlers publishOwnerPage: an owner repair whose callback runs again puts the lost run\'s file back', () => {
  const PART_C_STORED = { source_kind: 'webhook', ingested_via: 'webhook', ingested_at: '2026-01-02T03:04:05.000Z' };
  let partCRoot = '';
  let partCBrain = '';
  let partCEngine: PartCEngine;
  let partCRoots: string[] = [];

  beforeAll(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    partCRoot = mkdtempSync(`${tmpdir()}/gbrain-partc-94-`);
    partCEngine = new PGLiteEngine();
    await partCEngine.connect({});
    await partCEngine.initSchema();
  }, 120_000);
  afterAll(async () => {
    const { rmSync } = await import('node:fs');
    const { disposePersistenceConsumer } = await import('../src/core/persistence/service.ts');
    await disposePersistenceConsumer(partCEngine);
    await partCEngine?.disconnect();
    rmSync(partCRoot, { recursive: true, force: true });
  });

  /** A hardened repository brain holding one page (stamped external, then rewritten by a remote writer that dropped the stamps). */
  async function partCSeed(slug: string) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { randomUUID } = await import('node:crypto');
    const { serializePageToMarkdown } = await import('../src/core/markdown.ts');
    const { withTrustPromotion, withWriteAttribution } = await import('../src/core/persistence/context.ts');
    const { durableGitRepo } = await import('./helpers/git-publication.ts');
    const { resetPgliteState } = await import('./helpers/reset-pglite.ts');
    await resetPgliteState(partCEngine as import('../src/core/pglite-engine.ts').PGLiteEngine); // each test starts with its one page only
    partCBrain = path.join(partCRoot, `brain-${partCRoots.length}`);
    partCRoots.push(partCBrain);
    fs.mkdirSync(partCBrain, { recursive: true });
    await partCEngine.setConfig('sync.repo_path', partCBrain);
    await partCEngine.transaction(async tx => {
      await tx.putPage(slug, { type: 'note', title: 'Seeded', compiled_truth: 'Captured body', timeline: '', frontmatter: PART_C_STORED, source_kind: 'webhook', ingested_via: 'webhook' } as never);
      await withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw('UPDATE pages SET trust_tier = $1, ingested_at = $4::timestamptz WHERE source_id = $2 AND slug = $3', ['unknown', 'default', slug, PART_C_STORED.ingested_at]));
    });
    const attribution = { requestId: randomUUID(), principal: { kind: 'oauth_client', id: 'client-example' } } as never;
    await partCEngine.transaction(tx => withWriteAttribution(tx, attribution, async () => {
      await tx.createVersion(slug, { sourceId: 'default' });
      await tx.putPage(slug, { type: 'note', title: 'Seeded', compiled_truth: 'Captured body, edited', timeline: '', frontmatter: {}, source_kind: 'webhook', ingested_via: 'webhook' } as never);
      await tx.executeRaw('UPDATE pages SET ingested_at = $3::timestamptz WHERE source_id = $1 AND slug = $2', ['default', slug, PART_C_STORED.ingested_at]);
    }));
    const snapshot = (await partCEngine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    const file = path.join(partCBrain, `${slug}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
    durableGitRepo(partCBrain, [`${slug}.md`]);
    return { file, rel: `${slug}.md` };
  }
  const partCRun = async (apply: boolean, opts: Record<string, unknown> = {}) => {
    const { withEnv } = await import('./helpers/with-env.ts');
    const { repairRunner } = await import('../src/core/repair/registry.ts');
    const { resolveRepairScope } = await import('../src/core/repair/core.ts');
    const logger = { info() {}, warn() {}, error() {} };
    return withEnv({ GBRAIN_HOME: `${partCRoot}/home` }, async () =>
      (await repairRunner(partCEngine, { apply, logger })).run('provenance', await resolveRepairScope(partCEngine, 'default'), { explicit: true, sourceFlag: 'default', ...opts }) as Promise<Record<string, any>>);
  };
  const partCTier = async (slug: string) => (await partCEngine.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]))[0]!.trust_tier;
  const partCSubjects = async (root: string, range: string) => (await import('./helpers/git-publication.ts')).git(root, 'log', '--format=%s', range).split('\n').filter(Boolean);

  test('row 94: a repair whose callback runs again after a lost commit applies once, and the file matches the database', async () => {
    const fs = await import('node:fs');
    const { parseMarkdown } = await import('../src/core/markdown.ts');
    const { git } = await import('./helpers/git-publication.ts');
    const slug = 'inbox/partc-rerun';
    const { file, rel } = await partCSeed(slug);
    const before = { head: git(partCBrain, 'rev-parse', 'HEAD').trim(), file: fs.readFileSync(file, 'utf8') };
    const dry = await partCRun(false);
    expect(dry.affected).toBe(1);
    const wrapper = partCLoseFirstCommit(partCEngine, text => text.includes('readPageSnapshot'));
    try {
      await partCRun(true, { expect: dry.preview_hash });
    } finally { wrapper.restore(); }
    expect(wrapper.state.runs).toBe(2);
    const stamps = parseMarkdown(fs.readFileSync(file, 'utf8'), slug).frontmatter;
    expect({ source_kind: stamps.source_kind, ingested_via: stamps.ingested_via, ingested_at: stamps.ingested_at, tier: await partCTier(slug) })
      .toEqual({ ...PART_C_STORED, tier: 'external_untrusted' });
    expect(fs.readFileSync(file, 'utf8')).not.toBe(before.file);
    expect(git(partCBrain, 'status', '--porcelain').trim()).toBe('');
    expect(git(partCBrain, 'show', `HEAD:${rel}`)).toBe(fs.readFileSync(file, 'utf8'));
    // Recorded history: initial, [lost run's write-through, restore of it], the surviving run's write-through.
    const subjects = await partCSubjects(partCBrain, `${before.head}..HEAD`);
    console.log('partC row 94 history after the rerun (newest first):', JSON.stringify(subjects));
    expect(subjects.length).toBe(3);
  }, 120_000);

  test('row 94: when the concurrent change that lost the commit moved the page revision, the repair refuses and reports what the file holds', async () => {
    const fs = await import('node:fs');
    const { git } = await import('./helpers/git-publication.ts');
    const slug = 'inbox/partc-moved';
    const { file } = await partCSeed(slug);
    const before = { head: git(partCBrain, 'rev-parse', 'HEAD').trim(), file: fs.readFileSync(file, 'utf8'), revision: (await partCEngine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision };
    const dry = await partCRun(false);
    const wrapper = partCLoseFirstCommit(partCEngine, text => text.includes('readPageSnapshot'), async () => {
      await partCEngine.putPage(slug, { type: 'note', title: 'Seeded', compiled_truth: 'Captured body, moved by a concurrent writer', timeline: '', frontmatter: {}, source_kind: 'webhook', ingested_via: 'webhook' } as never);
    });
    let error: unknown = null;
    try { await partCRun(true, { expect: dry.preview_hash }); } catch (e) { error = e; } finally { wrapper.restore(); }
    const revision = (await partCEngine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
    const after = { file: fs.readFileSync(file, 'utf8'), subjects: await partCSubjects(partCBrain, `${before.head}..HEAD`) };
    console.log('partC row 94 moved-revision:', JSON.stringify({ code: (error as { code?: string })?.code, revisionMoved: revision !== before.revision, fileRestored: after.file === before.file, subjects: after.subjects }));
    // Residual (see the lane report): the lost run's file and its write-through commit stay (restore skips a moved revision).
    expect((error as { code?: string }).code).toBe('preview_changed');
    expect((await partCEngine.readPageSnapshot(slug, { sourceId: 'default' }))!.page.compiled_truth).toBe('Captured body, moved by a concurrent writer');
  }, 120_000);
});

describe('effect-links runLinksEffect: a rerun that returns early marks no belief commit for the lost run', () => {
  let partCHome = '';
  let partCEngine: PartCEngine;
  const partCConfig = { engine: 'pglite' as const, embedding_disabled: true };

  beforeAll(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    partCHome = mkdtempSync(`${tmpdir()}/gbrain-partc-371-`);
    partCEngine = new PGLiteEngine();
    await partCEngine.connect({});
    await partCEngine.initSchema();
  }, 120_000);
  afterAll(async () => {
    const { rmSync } = await import('node:fs');
    const { disposePersistenceConsumer } = await import('../src/core/persistence/service.ts');
    await disposePersistenceConsumer(partCEngine);
    await partCEngine?.disconnect();
    rmSync(partCHome, { recursive: true, force: true });
  });

  /** A ledger-active source with mention targets, and one committed remote put_page whose links effect is queued. */
  async function partCQueuedLinksEffect(sourceId: string, content: string) {
    const { randomUUID } = await import('node:crypto');
    const { submissionAuthority } = await import('../src/core/persistence/authority.ts');
    const { admitWrite, claimNextWrite } = await import('../src/core/persistence/journal.ts');
    const { localHostId, registerLocalWriter } = await import('../src/core/persistence/identity.ts');
    const { preparePageMutation } = await import('../src/core/persistence/page-prepare.ts');
    const { publishMutation } = await import('../src/core/persistence/coordinator.ts');
    const { enableBeliefLedger } = await import('../src/core/belief/coverage.ts');
    const engine = partCEngine;
    const clientId = `client-${sourceId}`;
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    for (const slug of ['people/alice-example', 'companies/acme-example']) {
      await engine.putPage(slug, { type: slug.startsWith('people/') ? 'person' : 'company', title: slug, compiled_truth: `${slug} fixture.`, timeline: '', frontmatter: {} }, { sourceId });
    }
    await registerLocalWriter(engine, 'cli');
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id) VALUES($1,'fixture-hash','example-client','read write',$2)`, [clientId, sourceId]);
    await enableBeliefLedger(engine, sourceId);
    const remote = { remote: true, auth: { token: 'fixture', clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['read', 'write'], sourceId } };
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
    const ctx = { engine, config: partCConfig, dryRun: false, sourceId, logger: { info() {}, warn() {}, error() {} }, ...remote } as never;
    const slug = 'notes/example';
    const authority = await submissionAuthority(ctx, 'put_page', sourceId, source.incarnation, slug);
    const intent = { content };
    await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId, sourceIncarnation: source.incarnation,
      slug, pageId: null, requestId: randomUUID(), callerIntent: intent, intent } as never);
    const row = (await claimNextWrite(engine, localHostId()))!;
    expect((await publishMutation(engine, row, await preparePageMutation(engine, row, partCConfig))).state).toBe('committed');
    return { row, slug };
  }

  test('row 371/372: a links effect that appended belief events, lost its commit and whose rerun is superseded marks nothing', async () => {
    const { withEnv } = await import('./helpers/with-env.ts');
    const { localHostId } = await import('../src/core/persistence/identity.ts');
    const { runPersistenceEffects } = await import('../src/core/persistence/effects.ts');
    const sourceId = 'partc-links-superseded';
    await withEnv({ GBRAIN_HOME: partCHome }, async () => {
      const { slug } = await partCQueuedLinksEffect(sourceId,
        '---\ntype: note\ntitle: Remote example\n---\n\nMet [[people/alice-example]] who works at [[companies/acme-example]].\n');
      await partCEngine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE kind<>'links' AND state='queued'");
      const eventCount = async (db: PartCEngine) => Number((await db.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM belief_events WHERE source_id=$1', [sourceId]))[0]!.n);
      const base = await eventCount(partCEngine);
      let appendedInLostRun = 0;
      const marked: string[][] = [];
      const realMark = partCEngine.markBeliefCommits.bind(partCEngine);
      (partCEngine as unknown as { markBeliefCommits: PartCEngine['markBeliefCommits'] }).markBeliefCommits = async ids => { marked.push([...ids]); return realMark(ids); };
      // Between the lost run and the rerun the page moves: the rerun finishes the effect as superseded before it reaches beliefs.run.
      const wrapper = partCLoseFirstCommit(partCEngine, text => text.includes('lockedPage'), async () => {
        await partCEngine.putPage(slug, { type: 'note', title: 'Remote example', compiled_truth: 'Rewritten by a concurrent writer.', timeline: '', frontmatter: {} }, { sourceId });
      }, async tx => { appendedInLostRun = (await eventCount(tx)) - base; });
      try {
        await runPersistenceEffects(partCEngine, partCConfig, { hostId: localHostId() });
      } finally {
        wrapper.restore();
        delete (partCEngine as { markBeliefCommits?: unknown }).markBeliefCommits;
      }
      expect(wrapper.state.runs).toBe(2);
      expect(appendedInLostRun).toBeGreaterThan(0); // the lost run did append belief events (rolled back with its commit)
      const effect = (await partCEngine.executeRaw<{ state: string; outcome: Record<string, unknown> | null }>("SELECT state,outcome FROM persistence_effects WHERE source_id=$1 AND kind='links'", [sourceId]))[0]!;
      expect(effect).toMatchObject({ state: 'committed', outcome: { links: 'skipped', reason: 'superseded' } });
      expect(marked).toEqual([]); // the surviving run appended nothing, so no publication is marked
    });
  }, 120_000);

  test('row 371/372: the append links effect (data.range) that appended belief events, lost its commit and whose rerun is superseded marks nothing', async () => {
    const { randomUUID } = await import('node:crypto');
    const { openAppendBrain } = await import('./helpers/append-brain.ts');
    const { waitFor } = await import('./helpers/wait-for.ts');
    const { enableBeliefLedger } = await import('../src/core/belief/coverage.ts');
    const brain = await openAppendBrain('pglite');
    try {
      const engine = brain.engine;
      const page = (slug: string) => `---\ntitle: ${slug}\ntype: note\n---\n\n${slug} fixture.\n`;
      await brain.seed('notes/alice-example', page('notes/alice-example'));
      const slug = 'notes/partc-append-log';
      await brain.seed(slug, page(slug));
      await enableBeliefLedger(engine, 'default');
      await engine.executeRaw("ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT (now()+interval '1 hour')");
      const appended = await brain.call('append_page', { slug, text: 'Follow-up with [[notes/alice-example]].', request_id: randomUUID() }, { remote: true });
      await engine.executeRaw('ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT now()');
      expect(appended).toMatchObject({ isError: false });
      const effects = () => engine.executeRaw<{ state: string; outcome: Record<string, any> | null; data: Record<string, any> }>("SELECT state, outcome, data FROM persistence_effects WHERE kind='links' AND data->>'slug'=$1", [slug]);
      expect((await effects())[0]!.data.range).toBeDefined(); // the append links effect (runAppendLinksEffect)
      const eventCount = async (db: PartCEngine) => Number((await db.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM belief_events WHERE source_id='default'"))[0]!.n);
      const base = await eventCount(engine);
      let appendedInLostRun = 0;
      const marked: string[][] = [];
      let settled = false; // marks the concurrent rewrite itself made before the rerun are its own
      const realMark = engine.markBeliefCommits.bind(engine);
      (engine as unknown as { markBeliefCommits: PartCEngine['markBeliefCommits'] }).markBeliefCommits = async ids => { if (settled) marked.push([...ids]); return realMark(ids); };
      // Between the lost run and the rerun a trusted rewrite drops the appended text: the rerun finishes as superseded before beliefs.run.
      const wrapper = partCLoseFirstCommit(engine, text => text.includes('lockedPage'), async () => {
        const rewritten = await brain.call('put_page', { slug, content: page(slug) + '\nRewritten tail.\n', request_id: randomUUID(), force: true });
        expect(rewritten).toMatchObject({ isError: false });
        settled = true;
      }, async tx => { appendedInLostRun = (await eventCount(tx)) - base; });
      try {
        await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE kind='links' AND data->>'slug'=$1 AND state='queued'", [slug]);
        await waitFor(async () => (await effects()).every(e => e.state === 'committed'), { timeoutMs: 60_000, intervalMs: 50, label: 'append links effect settled' });
      } finally {
        wrapper.restore();
        delete (engine as { markBeliefCommits?: unknown }).markBeliefCommits;
      }
      expect(wrapper.state.runs).toBe(2);
      expect(appendedInLostRun).toBeGreaterThan(0);
      expect((await effects())[0]!.outcome).toEqual({ links: 'skipped', reason: 'superseded' });
      expect(marked.filter(ids => ids.length)).toEqual([]);
    } finally { await brain.close(); }
  }, 180_000);
});

// ---- audit rows below were written as separate blocks (dynamic imports, partD prefix) ----

/**
 * L0-2 part D, audit row 333: `inFencedSlices` reruns its transaction callback after a lost optimistic commit, so a `write`
 * closure that bumps an outer counter counts every item of the slice twice. The two callers that did (`retireMarkers`'
 * `state.markersRetired`, `skipDanglingLinks`' `state.dangling.released`) now count in the `committed` hook, from the
 * per-item outcomes the winning run left. Real PGLite; the first transaction after `partDArm` is a real lost commit
 * (its callback runs in a real transaction that is rolled back, its outside-state changes stay), then the real one runs.
 */
const partDLost = new Error('lost optimistic commit');

/** Makes the FIRST transaction `engine` runs after this call a lost commit; returns how many times it ran its callback. */
function partDArm(engine: import('../src/core/engine.ts').BrainEngine): { runs: () => number; disarm: () => void } {
  const real = Object.getPrototypeOf(engine).transaction as import('../src/core/engine.ts').BrainEngine['transaction'];
  let armed = true, runs = 0;
  (engine as { transaction: unknown }).transaction = async function (this: unknown, fn: (tx: import('../src/core/engine.ts').BrainEngine) => Promise<unknown>, opts?: unknown) {
    const call = (f: typeof fn) => (real as unknown as (f: typeof fn, o?: unknown) => Promise<unknown>).call(engine, f, opts);
    if (this !== engine || !armed) return call(fn);
    armed = false;
    await call(async tx => { runs++; await fn(tx); throw partDLost; }).catch((e: unknown) => { if (e !== partDLost) throw e; });
    runs++;
    return call(fn);
  };
  return { runs: () => runs, disarm: () => { delete (engine as { transaction?: unknown }).transaction; } };
}

async function partDLevel(engine: import('../src/core/engine.ts').BrainEngine, over: Record<string, unknown> = {}) {
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  return { sourceId: 'default', incarnation, scope: '', slugMode: 'git-root', mode: 'working', head: 'h', paths: [] as unknown[], ...over };
}

const partDInput = () => ({ passId: 'pass-d', observedAt: new Date().toISOString() }) as unknown as import('../src/core/persistence/sync-pass-apply.ts').PassApplyInput;

describe('sync-pass-apply retireMarkers: a slice rerun after a lost commit', () => {
  test('row 333: two markers retired in one slice count once each, not twice', async () => {
    const { managedBrain } = await import('./helpers/managed-brain.ts');
    const { withDrainLease } = await import('../src/core/persistence/sync-lease.ts');
    const { newPassApplyState, retireMarkers } = await import('../src/core/persistence/sync-pass-apply.ts');
    const { SYNC_ORIGIN_DELETED_OP } = await import('../src/core/persistence/sync-pass-row.ts');
    const { originMarkerFingerprint, readOriginDeletedMarker } = await import('../src/core/persistence/sync-markers.ts');
    await managedBrain(async ({ engine }) => {
      const level = await partDLevel(engine);
      const origins = ['notes/a.md', 'notes/b.md'];
      for (const [i, origin] of origins.entries()) {
        const marker = { source_id: 'default', incarnation: level.incarnation, kind: 'deleted', blob_oids: [], page_id: i + 1, slug: origin.replace(/\.md$/, ''), at: '2026-10-01T00:00:00.000Z' };
        await engine.executeRaw('INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,jsonb_build_array($3::text::jsonb))',
          [SYNC_ORIGIN_DELETED_OP, originMarkerFingerprint('default', level.incarnation, origin), JSON.stringify(marker)]);
      }
      level.paths = origins.map(path => ({ path, slug: null, pageId: null, revision: null, legacyPageless: false,
        state: { tree: null, present: false, page: null, marker: { kind: 'deleted', blobOids: [] }, level: null }, result: { cls: 'delete', settled: false, action: 'delete' } }));
      const state = newPassApplyState();
      const lost = partDArm(engine);
      try {
        await withDrainLease(engine, 'default', { holder: { kind: 'cli' } }, async () => { await retireMarkers(engine, level as never, state); return { status: 'synced' } as never; });
      } finally { lost.disarm(); }
      expect(lost.runs()).toBe(2);
      for (const origin of origins) expect(await readOriginDeletedMarker(engine, 'default', level.incarnation, origin)).toBeNull();
      expect(state.markersRetired).toBe(2);
    });
  }, 120_000);
});

describe('sync-pass-apply skipDanglingLinks: a slice rerun after a lost commit', () => {
  test('row 333: two held dangling links released in one slice count once each, not twice', async () => {
    const { managedBrain } = await import('./helpers/managed-brain.ts');
    const { withDrainLease } = await import('../src/core/persistence/sync-lease.ts');
    const { newPassApplyState, skipDanglingLinks } = await import('../src/core/persistence/sync-pass-apply.ts');
    const { writeGitHold } = await import('../src/core/persistence/sync-holds.ts');
    const { mkdirSync, symlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    await managedBrain(async ({ engine, root }) => {
      const level = await partDLevel(engine, { root, gitRoot: root });
      mkdirSync(join(root, 'links'));
      const paths = ['links/l0.md', 'links/l1.md'];
      for (const path of paths) {
        symlinkSync('missing-target.md', join(root, path));
        await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: level.incarnation, path, source_path: path, slug: path.replace(/\.md$/, ''), page_id: null,
          code: 'file_unreadable', message: `${path}: unreadable`, upstream_version: null, observed_at: new Date(Date.now() - 60_000).toISOString(), run_id: null, mode: 'managed', meta: {} } as never));
      }
      level.paths = paths.map(path => ({ path, slug: null, pageId: null, revision: null,
        state: { hold: { moved: false }, page: null, level: 'a'.repeat(40) }, result: { cls: 'held', settled: false, action: 'hold', inFlight: false } }));
      const state = newPassApplyState();
      const lost = partDArm(engine);
      try {
        await withDrainLease(engine, 'default', { holder: { kind: 'cli' } }, async () => { await skipDanglingLinks(engine, level as never, partDInput(), state); return { status: 'synced' } as never; });
      } finally { lost.disarm(); }
      expect(lost.runs()).toBe(2);
      expect([...state.dangling.skipped].sort()).toEqual(paths);
      const left = await engine.executeRaw<{ path: string }>("SELECT completed_keys->0->>'path' AS path FROM op_checkpoints WHERE op='sync-hold'");
      expect(left.filter(row => row.path.startsWith('links/'))).toEqual([]);
      expect(state.dangling.released).toBe(2);
    });
  }, 120_000);
});
