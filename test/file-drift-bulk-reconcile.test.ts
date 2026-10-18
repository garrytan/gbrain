/**
 * #6696 PR C, C7: bulk file-drift reconcile.
 *
 * `gbrain repair file-drift` takes repeatable `--only` / `--skip` globs over
 * the canonical file path, like the other kinds' `--only` (`*` within a
 * segment, `**` across segments, an exact path matches itself), bound into the preview hash and
 * carried through the printed apply command, so executing that exact command
 * applies exactly the selected pages. `--keep` is refused on file-drift with a
 * pointer at `--prefer database`. An opt-in `storage.keep_db` list in
 * gbrain.yml lets the trusted local maintenance worker on the canonical owner
 * host reconcile drifted pages under those prefixes with the database copy, one
 * rate-limited request per page; doctor `maintenance_write_drift` echoes the
 * policy, how many drifted pages it matches and their receipt cost.
 *
 * Runs on PGLite, and on Postgres when DATABASE_URL is set
 * (test/e2e/file-drift-bulk-reconcile-postgres.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { DRIFT_SKIPS_KEY, liveFileDrift } from '../src/core/persistence/drift-conflicts.ts';
import { existingLocalHostId } from '../src/core/persistence/identity.ts';
import { argvFromCommand } from '../src/core/agent-output.ts';
import { parseRepairArgs, runRepairCommand } from '../src/commands/repair.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { maintenanceWriteDriftCheck } from '../src/commands/doctor/checks/maintenance-drift.ts';
import { __resetMissingStorageWarning, loadStorageConfig } from '../src/core/storage-config.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const logger = { info() {}, warn() {}, error() {} };
const CONCEPTS = ['concepts/alpha-example', 'concepts/beta-example', 'concepts/gamma-example'];
const PERSON = 'people/alice-example';

describe('C7 file-drift argument rules', () => {
  test('--only and --skip are repeatable file path globs on file-drift', () => {
    const parsed = parseRepairArgs(['file-drift', '--source', 'default', '--all-drifted', '--only', 'concepts/**', '--only', 'ideas/*',
      '--skip', 'concepts/archive/**', '--prefer', 'database']);
    expect(parsed).toMatchObject({ kind: 'file-drift', allDrifted: true, prefer: 'database', only: ['concepts/**', 'ideas/*'], skip: ['concepts/archive/**'] });
  });
  test('--keep on file-drift is refused with a pointer at --prefer database, wherever it appears', () => {
    for (const args of [['file-drift', '--source', 'default', '--all-drifted', '--keep', 'db'], ['--keep', 'prior', 'file-drift', '--slug', 'notes/a'],
      ['file-drift', '--keep=disk', '--slug', 'notes/a', '--apply', '--expect', 'abc']]) {
      let error: { code?: string; message?: string; suggestion?: string; fix?: { argv?: string[] } } | undefined;
      try { parseRepairArgs(args); } catch (caught) { error = caught as never; }
      expect(error?.code).toBe('invalid_params');
      expect(error?.message).toContain('--keep');
      expect(error?.suggestion).toContain('--prefer database');
      expect(error?.fix?.argv).toContain('--prefer');
      expect(error?.fix?.argv).not.toContain('--keep');
      expect(error?.fix?.argv).not.toContain('--apply');
    }
  });
  test('stuck-recovery keeps validating --keep values', () => {
    expect(() => parseRepairArgs(['stuck-recovery', '--keep', 'db'])).toThrow('--keep must be prior, disk or withdrawn');
    expect(parseRepairArgs(['stuck-recovery', '--keep', 'disk']).keep).toBe('disk');
  });
});

describe('C7 doctor on a fresh keyless PGLite brain', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });
  test('maintenance_write_drift stays ok and echoes no keep_db policy', async () => {
    const check = await maintenanceWriteDriftCheck(engine);
    expect(check.status).toBe('ok');
    expect(check.details).not.toHaveProperty('keep_db_policy');
  });
});

describe('C7 storage.keep_db in gbrain.yml', () => {
  test('keep_db is a declared prefix list, normalized like the tiers, and an unknown storage key warns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-c7-yml-'));
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      __resetMissingStorageWarning();
      writeFileSync(join(dir, 'gbrain.yml'), 'storage:\n  db_tracked:\n    - people/\n  keep_db:\n    - concepts\n    - ideas/\n  kep_db:\n    - extracts/\n');
      expect(loadStorageConfig(dir)).toEqual({ db_tracked: ['people/'], db_only: [], keep_db: ['concepts/', 'ideas/'] });
      expect(warnings.some(line => line.includes("'kep_db'") && line.includes('keep_db'))).toBe(true);
      __resetMissingStorageWarning();
      warnings.length = 0;
      writeFileSync(join(dir, 'gbrain.yml'), 'storage:\n  keep_db:\n    - concepts/\n');
      expect(loadStorageConfig(dir)).toEqual({ db_tracked: [], db_only: [], keep_db: ['concepts/'] });
      expect(warnings.filter(line => line.includes('no storage configuration'))).toEqual([]);
    } finally {
      console.warn = original;
      __resetMissingStorageWarning();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

for (const backend of testBackends()) describe(`C7 bulk file-drift reconcile (${backend})`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-c7-db-'));

  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    if (backend === 'pglite') {
      const pglite = new PGLiteEngine();
      await pglite.connect({ database_path: dataDir }); await pglite.initSchema(); engine = pglite;
    } else {
      const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase());
      engine = pg.engine; closePostgres = pg.close;
    }
  }, 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    if (closePostgres) await closePostgres(); else await engine.disconnect();
    resetGateway(); rmSync(dataDir, { recursive: true, force: true });
  });

  async function fixture(run: (input: { root: string; sourceId: string; ctx: OperationContext }) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-c7-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const sourceId = `c7-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
        await run({ root, sourceId, ctx });
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.unsetConfig(DRIFT_SKIPS_KEY);
      await engine.unsetConfig('persistence.limits.principal_lifetime_ids');
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const put = (ctx: OperationContext, slug: string, content: string) =>
    submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, request_id: randomUUID() } });
  const drift = (root: string, slug: string, edit: (text: string) => string) => {
    const file = join(root, `${slug}.md`);
    writeFileSync(file, edit(readFileSync(file, 'utf8')));
  };
  /** A caller write refused source_changed: one conflict receipt for the slug. */
  const refusedWrite = async (ctx: OperationContext, slug: string) => {
    const expected_revision = (await engine.readPageSnapshot(slug, { sourceId: ctx.sourceId! }))!.revision;
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: '---\ntype: note\ntitle: Refused\n---\nRefused.\n', expected_revision, request_id: randomUUID() } })
      .then(() => { throw new Error(`write to ${slug} committed`); }, (error: { code?: string }) => expect(error.code).toBe('source_changed'));
  };
  const requests = async (sourceId: string) => Number((await engine.executeRaw<{ n: number }>(
    'SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1', [sourceId]))[0].n);
  const stillDrifted = async (sourceId: string, slugs: string[]) => {
    const drifted: string[] = [];
    for (const slug of slugs) if ((await liveFileDrift(engine, sourceId, slug)).still_present === true) drifted.push(slug);
    return drifted;
  };
  /** Three concepts drifted by an appended line, one person rewritten (another drift class); each with a conflict receipt. */
  async function driftedPages(root: string, ctx: OperationContext): Promise<void> {
    for (const slug of CONCEPTS) await put(ctx, slug, `---\ntype: concept\ntitle: ${slug.slice(9)}\n---\nStored ${slug}.\n`);
    await put(ctx, PERSON, '---\ntype: person\ntitle: Alice Example\n---\nOriginal sentence.\n');
    for (const slug of CONCEPTS) drift(root, slug, text => `${text}\nA line added in the file only.\n`);
    drift(root, PERSON, text => text.replace('Original sentence.', 'A different sentence.'));
    for (const slug of [...CONCEPTS, PERSON]) await refusedWrite(ctx, slug);
    expect(await stillDrifted(ctx.sourceId!, [...CONCEPTS, PERSON])).toEqual([...CONCEPTS, PERSON]);
  }
  async function json(args: string[]): Promise<{ results: Array<Record<string, unknown>> }> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...values: unknown[]) => { lines.push(values.join(' ')); };
    try { await runRepairCommand(engine, [...args, '--json']); } finally { console.log = original; }
    return JSON.parse(lines.join('\n'));
  }

  test('--all-drifted --only concepts/** previews 3 of 4 drifted pages, and executing the exact returned command applies exactly those 3', () => fixture(async ({ root, sourceId, ctx }) => {
    await driftedPages(root, ctx);
    const preview = (await json(['file-drift', '--source', sourceId, '--all-drifted', '--only', 'concepts/**', '--prefer', 'database'])).results[0]!;
    expect(preview).toMatchObject({ mode: 'dry_run', affected: 3 });
    expect(preview.sample).toEqual(CONCEPTS.map(slug => `${sourceId}:${slug}`));
    const command = String(preview.apply_command);
    expect(command).toContain("--only 'concepts/**'");
    expect(command).toContain(`--expect ${preview.preview_hash}`);
    const argv = argvFromCommand(command)!;
    expect(argv.slice(0, 2)).toEqual(['gbrain', 'repair']);
    const before = await requests(sourceId);
    const applied = (await json(argv.slice(2))).results[0]!;
    expect(applied).toMatchObject({ mode: 'apply', applied: 3, complete: true, outcomes: { repaired: 3 } });
    expect(await requests(sourceId)).toBe(before + 3);
    expect(await stillDrifted(sourceId, [...CONCEPTS, PERSON])).toEqual([PERSON]);
    expect((await engine.getPage(CONCEPTS[0]!, { sourceId }))!.compiled_truth).toBe(`Stored ${CONCEPTS[0]}.`);
  }), 240_000);

  test('#6712 PR 2: --all-drifted --since 7d keeps pages drifted since that instant, and the returned command carries the instant and applies exactly them', () => fixture(async ({ root, sourceId, ctx }) => {
    await driftedPages(root, ctx);
    // The person's conflict is ten days old; the concepts' are new.
    await engine.executeRaw("UPDATE persistence_requests SET created_at=now()-interval '10 days' WHERE source_id=$1 AND slug=$2 AND state='conflict'", [sourceId, PERSON]);
    // A group of drift conflicts on several pages is fixed with one --since preview at the group's oldest conflict, never an age.
    const { readTerminalFailures } = await import('../src/core/persistence/terminal-failures.ts');
    const grouped = await readTerminalFailures(engine, { sourceId, groupBy: 'category', state: 'all', sinceDays: 30 });
    const group = grouped.status === 'ok' ? grouped.groups!.find(g => g.category === 'file_conflict') : undefined;
    expect(group?.fix.argv?.slice(0, 7)).toEqual(['gbrain', 'repair', 'file-drift', '--source', sourceId, '--all-drifted', '--since']);
    expect(group!.fix.argv![7]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Date.parse(group!.fix.argv![7]!)).toBeLessThan(Date.now() - 9 * 86_400_000);
    const future = (await json(['file-drift', '--source', sourceId, '--all-drifted', '--since', new Date(Date.now() + 3_600_000).toISOString(), '--prefer', 'database'])).results[0]!;
    expect(future).toMatchObject({ affected: 0, residuals: { not_selected: 4 } });
    const preview = (await json(['file-drift', '--source', sourceId, '--all-drifted', '--since', '7d', '--prefer', 'database'])).results[0]!;
    expect(preview).toMatchObject({ mode: 'dry_run', affected: 3, residuals: { not_selected: 1 } });
    const command = String(preview.apply_command);
    const since = /--since (\S+)/.exec(command)?.[1];
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(command).not.toContain('--since 7d');
    const applied = (await json(argvFromCommand(command)!.slice(2))).results[0]!;
    expect(applied).toMatchObject({ mode: 'apply', applied: 3, complete: true, outcomes: { repaired: 3 } });
    expect(await stillDrifted(sourceId, [...CONCEPTS, PERSON])).toEqual([PERSON]);
  }), 240_000);

  test('the globs are bound into the preview hash: --skip narrows the set, and an apply under other globs refuses preview_changed', () => fixture(async ({ root, sourceId, ctx }) => {
    await driftedPages(root, ctx);
    const scope = await resolveRepairScope(engine, sourceId);
    const runner = await repairRunner(engine, { apply: false, logger });
    const mixed = await runner.run('file-drift', scope, { explicit: true, sourceFlag: sourceId, allDrifted: true, prefer: 'database' }).then(() => null, error => error);
    expect(mixed).toMatchObject({ code: 'invalid_params' });
    const all = await runner.run('file-drift', scope, { explicit: true, sourceFlag: sourceId, allDrifted: true, prefer: 'database', only: ['concepts/*'] });
    const skipped = await runner.run('file-drift', scope, { explicit: true, sourceFlag: sourceId, allDrifted: true, prefer: 'database',
      only: ['concepts/*'], skip: ['concepts/beta-*'] });
    expect(all.affected).toBe(3);
    expect(skipped.affected).toBe(2);
    expect(skipped.sample).toEqual([`${sourceId}:${CONCEPTS[0]}`, `${sourceId}:${CONCEPTS[2]}`]);
    expect(skipped.preview_hash).not.toBe(all.preview_hash);
    expect(skipped.apply_command).toContain("--skip 'concepts/beta-*'");
    const other = await (await repairRunner(engine, { apply: true, logger })).run('file-drift', scope,
      { explicit: true, sourceFlag: sourceId, allDrifted: true, prefer: 'database', only: ['concepts/*'], expect: skipped.preview_hash })
      .then(() => null, error => error);
    expect(other).toMatchObject({ code: 'preview_changed' });
    const bySlug = await runner.run('file-drift', scope, { explicit: true, sourceFlag: sourceId, allDrifted: true, prefer: 'database', only: [CONCEPTS[0]!] });
    expect(bySlug).toMatchObject({ affected: 0, residuals: { not_selected: 4 } });
    const exact = await runner.run('file-drift', scope, { explicit: true, sourceFlag: sourceId, slugs: [CONCEPTS[0]!, PERSON], prefer: 'database',
      only: [`${CONCEPTS[0]}.md`] });
    expect(exact).toMatchObject({ affected: 1, sample: [`${sourceId}:${CONCEPTS[0]}`], residuals: { not_selected: 1 } });
    const bad = await runner.run('file-drift', scope, { explicit: true, sourceFlag: sourceId, allDrifted: true, prefer: 'database', only: ['../concepts/*'] })
      .then(() => null, error => error);
    expect(bad).toMatchObject({ code: 'invalid_params' });
  }), 240_000);

  test('storage.keep_db: the owner host submits one rate-limited reconcile per drifted page under the prefixes; elsewhere and for callers nothing changes', () => fixture(async ({ root, sourceId, ctx }) => {
    writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  keep_db:\n    - concepts/\n');
    await driftedPages(root, ctx);
    const doctor = await maintenanceWriteDriftCheck(engine, [sourceId]);
    expect(doctor).toMatchObject({ status: 'warn', details: { count: 4, keep_db_policy: [{ source_id: sourceId, keep_db: ['concepts/'], matched: 3,
      receipt_cost: { lifetime_ids: 3, receipt_bytes: 3 * 16_384 } }] } });
    expect(doctor.message).toContain('storage.keep_db');

    const { runKeepDbPolicy } = await import('../src/core/repair/keep-db-policy.ts');
    const ownerHost = () => existingLocalHostId()!;
    const before = await requests(sourceId);
    const elsewhere = await runKeepDbPolicy(engine, { hostId: randomUUID(), sourceIds: [sourceId] });
    expect(elsewhere.submitted).toBe(0);
    expect(await requests(sourceId)).toBe(before);

    const ids = (await engine.executeRaw<{ lifetime_ids: string }>("SELECT lifetime_ids::text FROM persistence_counters WHERE key LIKE 'principal:%' ORDER BY lifetime_ids DESC LIMIT 1"))[0]!;
    await engine.setConfig('persistence.limits.principal_lifetime_ids', ids.lifetime_ids);
    const full = await runKeepDbPolicy(engine, { hostId: ownerHost(), sourceIds: [sourceId] });
    expect(full).toMatchObject({ submitted: 0, stopped: 'capacity' });
    expect(await requests(sourceId)).toBe(before);
    await engine.unsetConfig('persistence.limits.principal_lifetime_ids');

    const first = await runKeepDbPolicy(engine, { hostId: ownerHost(), sourceIds: [sourceId], limit: 2 });
    expect(first).toMatchObject({ submitted: 2, stopped: 'rate_limit' });
    expect(await requests(sourceId)).toBe(before + 2);
    expect(await stillDrifted(sourceId, [...CONCEPTS, PERSON])).toEqual([CONCEPTS[2]!, PERSON]);
    const second = await runKeepDbPolicy(engine, { hostId: ownerHost(), sourceIds: [sourceId], limit: 2 });
    expect(second.submitted).toBe(1);
    expect(await stillDrifted(sourceId, [...CONCEPTS, PERSON])).toEqual([PERSON]);
    expect(readFileSync(join(root, `${CONCEPTS[0]}.md`), 'utf8')).not.toContain('A line added in the file only.');
    const third = await runKeepDbPolicy(engine, { hostId: ownerHost(), sourceIds: [sourceId] });
    expect(third.submitted).toBe(0);
    expect(await requests(sourceId)).toBe(before + 3);
    const reconciles = await engine.executeRaw<{ slug: string; state: string }>(
      "SELECT slug, state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='canonical_reconcile' ORDER BY slug", [sourceId]);
    expect(reconciles).toEqual(CONCEPTS.map(slug => ({ slug, state: 'committed' })));
    await refusedWrite(ctx, PERSON);
  }), 240_000);

  test('storage.keep_db at 81% of a cumulative cap: the worker is refused write_capacity_backpressure and writes no receipt (#6696 A5)', () => fixture(async ({ root, sourceId, ctx }) => {
    writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  keep_db:\n    - concepts/\n');
    await driftedPages(root, ctx);
    const { runKeepDbPolicy } = await import('../src/core/repair/keep-db-policy.ts');
    const ownerHost = existingLocalHostId()!;
    const [writer] = await engine.executeRaw<{ key: string }>("SELECT 'principal:'||principal_kind||':'||principal_id AS key FROM persistence_requests WHERE source_id=$1 LIMIT 1", [sourceId]);
    const lifetime = async () => (await engine.executeRaw<{ n: string }>('SELECT lifetime_ids::text AS n FROM persistence_counters WHERE key=$1', [writer!.key]))[0]!.n;
    const used = Number(await lifetime());
    const limit = Math.ceil(used * 100 / 81);
    expect(used / limit).toBeGreaterThanOrEqual(0.8);
    expect(used / limit).toBeLessThan(0.9);
    await engine.setConfig('persistence.limits.principal_lifetime_ids', String(limit));
    const before = await requests(sourceId);
    // The default seam sees the pause line before preparing anything.
    expect(await runKeepDbPolicy(engine, { hostId: ownerHost, sourceIds: [sourceId] })).toMatchObject({ submitted: 0, stopped: 'write_capacity_backpressure' });
    // Admission itself refuses this background producer even with the seam open.
    expect(await runKeepDbPolicy(engine, { hostId: ownerHost, sourceIds: [sourceId], admission: async () => null })).toMatchObject({ submitted: 0, stopped: 'write_capacity_backpressure' });
    expect(await requests(sourceId)).toBe(before);
    expect(await lifetime()).toBe(String(used));
    expect(await stillDrifted(sourceId, [...CONCEPTS])).toEqual([...CONCEPTS]);
  }), 240_000);
});
