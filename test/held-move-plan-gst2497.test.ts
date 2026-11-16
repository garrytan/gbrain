/**
 * GST-2497: the sync's held-fact move on a strict source (moveRuledSharedHeld), after the review of GST-2492.
 *
 * 1. Protects: the move's due check is true only when a rule covers a held row's entity and not its holding page (the
 *    planner then moves or re-homes the row), so a rule over the holding page alone never makes every sync plan a move
 *    for nothing; a rule that narrows a held row below its holding page's readers still moves it right after the sync.
 *    On Postgres the plan's config read (holdingHome's sync.write_through) ends at the plan's deadline like its other reads.
 * 2. Fails when: the second of two syncs on such a source runs the held-move plan; a rule over the entity does not move
 *    the row after its sync; the move waits on a session holding the config table past the sync preparation budget.
 * 3. Existing coverage: test/folder-holding-page-gst2492.test.ts (the move, the rule apply, the pages and page_aliases locks).
 * 4. Real seams: the coordinated write on PGLite and Postgres (DATABASE_URL), a managed Git checkout, the policy file
 *    committed to Git and applied by performSync, a second Postgres session holding a table lock, and the engine's raw read.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { performSync } from '../src/commands/sync.ts';
import { serializePolicyYaml, type FolderRule } from '../src/core/access/folder-rules.ts';
import { policySeams, proposeRevision } from '../src/core/access/policy.ts';
import { commitPolicyFile, POLICY_FILE } from '../src/core/access/policy-git.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { resetSyncPreparationBudget, syncPreparationBudgetMs } from '../src/core/persistence/sync-waivers.ts';
import { moveRuledSharedHeld } from '../src/core/facts/held-fact-move.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects, type ManagedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const HOLD = 'memory/unattributed';
const gitRepo = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
const remember = (ctx: OperationContext, fact: string, entity: string) => call(ctx, 'remember', { fact, entity, provenance: 'chat 2026-11-13' });
const rule = (id: string, prefix: string, readers: string[]): FolderRule => ({ id, prefix, readable_by: readers.map(r => `member:${r}`).sort() });
const heldOn = async (engine: BrainEngine, claim: string) => (await engine.executeRaw<{ slug: string }>(
  `SELECT source_markdown_slug AS slug FROM facts WHERE source_id = 'default' AND fact = $1 AND expired_at IS NULL`, [claim])).map(r => r.slug);
const caught = <T>(p: Promise<T>) => p.then(() => null, (error: Record<string, any>) => error);

for (const backend of testBackends()) describe(`[${backend}] the sync's held-fact move (GST-2497)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => { policySeams.afterInstall = undefined; });
  const strict = (run: (brain: ManagedBrain) => Promise<void>) => managedBrain(async brain => {
    await brain.engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    await run(brain);
  }, { databaseUrl, setup: gitRepo });

  test('a rule over the holding page but not the entity makes no sync plan a move; a rule over the entity still moves it after its sync', () => strict(async ({ engine, ctx, root }) => {
    const policy = (list: FolderRule[]) => commitPolicyFile(root, POLICY_FILE, () => serializePolicyYaml(list), 'access: rule');
    const sync = () => performSync(engine, { sourceId: 'default', repoPath: root, noPull: true, noEmbed: true } as never);
    policy([rule('memory', 'memory/', ['alice-example', 'bob-example'])]);
    await sync();
    const claim = 'The bob-example garden plan starts in spring.';
    expect(await remember(ctx, claim, 'people/bob-example')).toMatchObject({ page: HOLD });
    await settleManagedGitEffects(engine);
    const plans: string[] = [];
    const real = engine.executeRaw;
    const counted = spyOn(engine, 'executeRaw').mockImplementation(function (this: BrainEngine, sql: string, ...rest: unknown[]) {
      if (sql.includes('source_markdown_slug AS from_slug')) plans.push(sql);
      return (real as (...a: unknown[]) => Promise<unknown>).call(this, sql, ...rest);
    } as BrainEngine['executeRaw']);
    try {
      await sync();
      const first = plans.length;
      await sync();
      expect([first, plans.length - first]).toEqual([0, 0]);
      expect(await moveRuledSharedHeld(engine, 'default')).toBeNull();
    } finally { counted.mockRestore(); }
    expect(await heldOn(engine, claim)).toEqual([HOLD]);
    policy([rule('memory', 'memory/', ['alice-example', 'bob-example']), rule('people', 'people/', ['alice-example'])]);
    await sync();
    await settleManagedGitEffects(engine);
    expect(await heldOn(engine, claim)).toEqual(['people/memory/unattributed']);
    expect(await moveRuledSharedHeld(engine, 'default')).toBeNull();
  }), 300_000);

  test.skipIf(backend !== 'postgres')('on the sync path a due held move ends at the sync preparation budget while another session locks the config table; once the lock drops it moves', () => strict(async ({ engine, ctx }) => {
    const entity = 'clients/acme-example/brief';
    const claim = 'The acme-example brief carries a config-locked clause.';
    expect(await remember(ctx, claim, entity)).toMatchObject({ page: HOLD });
    policySeams.afterInstall = () => { throw new Error('interrupted'); };
    await expect(proposeRevision(engine, 'default', [rule('clients', 'clients/acme-example/', ['alice-example'])], { origin: 'cli', store: 'database', approved: false })).rejects.toThrow('interrupted');
    policySeams.afterInstall = undefined;
    __resetPrivateVisibilityCacheForTests();
    const budget = 1_000;
    await engine.setConfig('persistence.sync_preparation_ms', String(budget));
    resetSyncPreparationBudget();
    expect(await syncPreparationBudgetMs(engine)).toBe(budget);
    const [{ db }] = await engine.executeRaw<{ db: string }>('SELECT current_database() AS db');
    const url = new URL(databaseUrl!); url.pathname = `/${db}`;
    const holder = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
    try {
      const ended = await holder.begin(async sql => {
        await sql.unsafe('LOCK TABLE config IN ACCESS EXCLUSIVE MODE');
        const started = performance.now();
        const error = await caught(moveRuledSharedHeld(engine, 'default'));
        return { code: error?.code, ms: performance.now() - started };
      });
      expect(ended.code).toBe('preparation_deadline');
      expect(ended.ms).toBeLessThan(budget + 3_000);
    } finally { await holder.end(); resetSyncPreparationBudget(); }
    expect(await moveRuledSharedHeld(engine, 'default')).toMatchObject({ rehomed: 1, unmovable: [], write_errors: 0 });
    expect(await heldOn(engine, claim)).toEqual(['clients/acme-example/memory/unattributed']);
  }), 300_000);
});
