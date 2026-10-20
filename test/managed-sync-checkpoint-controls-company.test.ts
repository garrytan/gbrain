/**
 * The checkpoint apply's controls (Wave 16 G3.4, [R11]), on a company brain: a company approval is the one sync that
 * still publishes a cursor checkpoint (#6712 PR 4b: a non-company source syncs by the live pass).
 *
 * A checkpoint whose cursor index lags its total under the same run keeps `revision_conflict` ("not fully committed") and
 * is recorded as a managed-sync failure; one whose run manifest is gone keeps `storage_error` ("manifest is
 * incomplete"). Both are injected inside the publishing transaction, right before the final locked compare-and-swap, and
 * roll back with the refusal. Moved here from managed-sync-checkpoint-replaced.test.ts, whose cursor-replacement cases
 * went with the non-company cursor (nothing replaces a company cursor's run: it re-freezes in place). Synthetic content only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { inspectCompanyBrain } from '../src/core/company-brain/inspection.ts';
import { admitCompanyBrain } from '../src/core/company-brain/admission.ts';
import { performSync } from '../src/commands/sync.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-company-ckpt-controls-'));
const stores: Array<{ engine: BrainEngine; close: () => Promise<void> }> = [];
beforeAll(async () => {
  const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  stores.push({ engine, close: () => engine.disconnect() });
  if (process.env.DATABASE_URL) stores.push(await isolatedPersistencePostgres(process.env.DATABASE_URL));
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { for (const store of stores) { await disposePersistenceConsumer(store.engine); await store.close(); } });
  rmSync(home, { recursive: true, force: true });
});

async function companySource(engine: BrainEngine) {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const root = mkdtempSync(join(home, 'source-')), git = await makeGitFixture(root);
  for (const [path, content] of Object.entries({
    'people/operator.md': '---\ntype: person\ntitle: Example Operator\n---\n# Example Operator\nOwns the account.\n',
    'customers/account.md': '---\ntype: customer\ntitle: Example Account\nowner: "[[people/operator]]"\naudience: internal\n---\n# Example Account\nA synthetic account.\n',
  })) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
  git.commitAll('Add approved synthetic source');
  const plan = await inspectCompanyBrain({ path: root, profile: 'company-brain' });
  expect(plan.ready).toBe(true);
  const f = { brainId: 'company-example', sourceId: `company-${randomUUID().slice(0, 12)}`, path: root, plan, remote: false, requestId: randomUUID() };
  await admitCompanyBrain(engine, f);
  return f;
}

/** The checkpoint apply's locked compare-and-swap, after the shared validator passed. */
const FINAL_CAS = /SELECT completed_keys FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=\$1 FOR UPDATE/;
/** Inside the publishing transaction, right before the final CAS of a checkpoint: move the index back one, or delete the run's manifest. Fires once. */
function interfere(engine: BrainEngine, at: 'lag' | 'manifest'): { restore: () => void; fired: () => boolean } {
  const transaction = engine.transaction;
  let fired = false;
  engine.transaction = async function<T>(this: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
    return transaction.call(this, tx => run(new Proxy(tx, { get(target, property) {
      if (property === 'executeRaw') return async (sql: string, params?: unknown[]) => {
        if (!fired && FINAL_CAS.test(sql)) {
          const key = params![0] as string;
          const [head] = await target.executeRaw<{ kind: string | null; run_id: string; total: number }>(
            "SELECT completed_keys->0->'pending'->'intent'->>'kind' AS kind,completed_keys->0->>'runId' AS run_id,(completed_keys->0->>'total')::int AS total FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1", [key]);
          if (head?.kind === 'managed_sync_checkpoint') {
            fired = true;
            if (at === 'lag') await target.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,index}',to_jsonb($2::int)) WHERE op='managed-sync' AND fingerprint=$1", [key, head.total - 1]);
            else await target.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [head.run_id]);
          }
        }
        return target.executeRaw(sql, params);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as BrainEngine)) as Promise<T>;
  } as BrainEngine['transaction'];
  return { restore: () => { engine.transaction = transaction; }, fired: () => fired };
}

test('controls on a company checkpoint: a same-run index lag keeps revision_conflict and is still recorded; a missing manifest keeps storage_error', () =>
  withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined }, async () => {
    for (const { engine } of stores) {
      for (const [at, code, message] of [['lag', 'revision_conflict', 'not fully committed'], ['manifest', 'storage_error', 'manifest is incomplete']] as const) {
        const f = await companySource(engine);
        const hook = interfere(engine, at);
        let result: Awaited<ReturnType<typeof performSync>>;
        try { result = await performSync(engine, { sourceId: f.sourceId }); } finally { hook.restore(); }
        expect(hook.fired()).toBe(true);
        const [receipt] = await engine.executeRaw<{ state: string; error_code: string | null; error_message: string | null }>(
          "SELECT state,error_code,error_message FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_checkpoint' ORDER BY sequence", [f.sourceId]);
        expect({ at, state: receipt!.state, code: receipt!.error_code }).toEqual({ at, state: code === 'revision_conflict' ? 'conflict' : 'failed', code });
        expect(receipt!.error_message).toContain(message);
        expect(result).toMatchObject({ status: 'blocked_by_failures', failureCodes: [{ code, count: 1 }] });
        const [key] = await engine.executeRaw<{ fingerprint: string }>("SELECT fingerprint FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [f.sourceId]);
        expect((await engine.executeRaw<{ code: string }>("SELECT completed_keys->0->>'code' AS code FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=$1", [key!.fingerprint])).map(row => row.code)).toEqual([code]);
        expect((await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.sourceId]))[0]!.last_commit).toBeNull();
      }
    }
  }), 240_000);
