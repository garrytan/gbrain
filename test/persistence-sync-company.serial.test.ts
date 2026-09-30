import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { inspectCompanyBrain } from '../src/core/company-brain/inspection.ts';
import { admitCompanyBrain } from '../src/core/company-brain/admission.ts';
import { connectCompanyBrain, resumeCompanyBrain } from '../src/core/company-brain/runtime.ts';
import { companyBrainProfile, companyBrainPolicyFingerprint } from '../src/core/company-brain/policy.ts';
import { performSync } from '../src/commands/sync.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { admitWrite, getWriteRequest } from '../src/core/persistence/journal.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import type { SyncIntent } from '../src/core/persistence/sync-prepare.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { APPLICATION_AUTHORITY, withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-sync-company-'));
const stores: Array<{ engine: BrainEngine; close: () => Promise<void> }> = [];
beforeAll(async () => {
  const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  stores.push({ engine, close: () => engine.disconnect() });
  if (process.env.DATABASE_URL) stores.push(await isolatedPersistencePostgres(process.env.DATABASE_URL));
}, 120_000);
afterAll(async () => {
  for (const store of stores) { await disposePersistenceConsumer(store.engine); await store.close(); }
  rmSync(home, { recursive: true, force: true });
});
const check = (name: string, run: (engine: BrainEngine) => Promise<void>) => test(name, () =>
  withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined }, async () => {
    for (const { engine } of stores) await run(engine);
  }), 120_000);
async function input(engine: BrainEngine, managed: boolean) {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
  const root = mkdtempSync(join(home, 'source-')), git = await makeGitFixture(root);
  for (const [path, content] of Object.entries({
    'people/operator.md': '---\ntype: person\ntitle: Example Operator\n---\n# Example Operator\nOwns the account.\n',
    'customers/account.md': '---\ntype: customer\ntitle: Example Account\nowner: "[[people/operator]]"\naudience: internal\n---\n# Example Account\nA synthetic account.\n',
  })) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
  git.commitAll('Add approved synthetic source');
  const plan = await inspectCompanyBrain({ path: root, profile: 'company-brain' });
  expect(plan.ready).toBe(true);
  return { brainId: 'company-example', sourceId: `company-${randomUUID().slice(0, 12)}`, path: root, plan, remote: false, requestId: randomUUID() };
}

check('company GRAPH resume is refused before any receipt or graph update when claimed but inactive', async engine => {
  const f = await input(engine, false), replace = engine.replaceDerivedLinks;
  engine.replaceDerivedLinks = async () => { throw new Error('Synthetic graph interruption'); };
  try {
    expect(await connectCompanyBrain(engine, f)).toMatchObject({ ok: false, receipt: { phase: 'GRAPH' } });
  } finally { engine.replaceDerivedLinks = replace; }
  await claimWorktree(engine, f.sourceId, f.path);
  const receipts = await engine.executeRaw('SELECT * FROM source_ingestion_receipts WHERE source_id=$1', [f.sourceId]);
  const pages = await engine.executeRaw('SELECT id,knowledge_revision FROM pages WHERE source_id=$1 ORDER BY id', [f.sourceId]);
  const checkpoints = await engine.executeRaw('SELECT * FROM op_checkpoints ORDER BY op,fingerprint');
  await expect(performSync(engine, { sourceId: f.sourceId })).rejects.toMatchObject({ code: 'writer_coordinator_required' });
  expect(await engine.executeRaw('SELECT * FROM source_ingestion_receipts WHERE source_id=$1', [f.sourceId])).toEqual(receipts);
  expect(await engine.executeRaw('SELECT id,knowledge_revision FROM pages WHERE source_id=$1 ORDER BY id', [f.sourceId])).toEqual(pages);
  expect(await engine.executeRaw('SELECT * FROM op_checkpoints ORDER BY op,fingerprint')).toEqual(checkpoints);
  expect(await engine.executeRaw('SELECT enabled FROM persistence_brain WHERE singleton=1')).toEqual([{ enabled: false }]);
});

check('legacy company consent retry preserves the approved manifest and original terminal receipt', async engine => {
  const f = await input(engine, true);
  await admitCompanyBrain(engine, f);
  const abort = new AbortController(), transaction = engine.transaction;
  let cursorCommitted = false;
  engine.transaction = async function<T>(this: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
    const value = await transaction.call(this, run) as T;
    if (value && typeof value === 'object' && 'runId' in value && 'sourceId' in value && value.sourceId === f.sourceId) {
      cursorCommitted = true; abort.abort();
    }
    return value;
  };
  try {
    expect(await resumeCompanyBrain(engine, f, { signal: abort.signal })).toMatchObject({ ok: false, receipt: { phase: 'CONTENT' } });
  } finally { engine.transaction = transaction; }
  expect(cursorCommitted).toBe(true);
  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.sourceId])).toEqual([]);
  const [stored] = await engine.executeRaw<{ fingerprint: string; completed_keys: any[] }>(
    "SELECT fingerprint,completed_keys FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [f.sourceId]);
  const cursor = stored.completed_keys[0];
  const [manifest] = await engine.executeRaw<{ completed_keys: any[] }>("SELECT completed_keys FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [cursor.runId]);
  const entry = manifest.completed_keys[0], requestId = randomUUID();
  const content = readFileSync(join(f.path, entry.path), 'utf8');
  const [source] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [f.sourceId]);
  const intent: SyncIntent = { kind: 'managed_sync_import', expected_revision: null, path: entry.path, sourcePath: entry.sourcePath,
    content, rawHash: sha256(content), ownerEpoch: cursor.binding.owner_epoch, syncAuthority: cursor.authority, cursorKey: stored.fingerprint,
    runId: cursor.runId, index: 0, total: cursor.total, from: cursor.from, target: cursor.target, slugMode: cursor.slugMode,
    companyApproval: { schema: f.plan.schema!, planDigest: f.plan.plan_digest, extractorVersion: f.plan.extractor_version,
      policyFingerprint: companyBrainPolicyFingerprint(companyBrainProfile(source.config)!, f.sourceId) } };
  delete cursor.processingOptions;
  cursor.pending = { requestId, slug: entry.slug, pageId: null, intent };
  await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=$2::text::jsonb WHERE op='managed-sync' AND fingerprint=$1", [stored.fingerprint, JSON.stringify([cursor])]);
  const admission = { requestId, operation: 'submit_job', sourceId: f.sourceId, sourceIncarnation: cursor.incarnation, slug: entry.slug,
    pageId: null, worktreeId: cursor.binding.worktree_id, topologyGeneration: cursor.binding.topology_generation,
    principal: cursor.authority.writer.principal, authority: cursor.authority.writer, callerIntent: intent, intent };
  await admitWrite(engine, admission);
  expect(await performSync(engine, { sourceId: f.sourceId })).toMatchObject({ status: 'blocked_by_failures', managedWrite: { write_request: { request_id: requestId } } });
  const failed = (await getWriteRequest(engine, admission.principal, requestId))!;
  expect(failed.error_code).toBe('invalid_params');
  expect(await performSync(engine, { sourceId: f.sourceId, retryFailed: true })).toMatchObject({ status: 'synced' });
  expect((await getWriteRequest(engine, admission.principal, requestId))?.intent).toEqual(intent);
  expect((await getWriteRequest(engine, admission.principal, requestId))?.state).toBe(failed.state);
  expect(await engine.executeRaw("SELECT completed_keys FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [cursor.runId])).toEqual([manifest]);
  const [after] = await engine.executeRaw<{ completed_keys: any[] }>("SELECT completed_keys FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1", [stored.fingerprint]);
  expect(after.completed_keys[0]).toMatchObject({ runId: cursor.runId, done: true, processingOptions: { noEmbed: true, noExtract: true, noSchemaPack: false } });
  expect(await engine.executeRaw("SELECT id FROM persistence_effects WHERE source_id=$1 AND kind='embedding'", [f.sourceId])).toEqual([]);
});

for (const phase of ['admitted', 'complete']) for (const caller of ['explicit', 'job']) {
  check(`${caller} cancellation during a real ${phase} company profile read preserves every receipt`, async engine => {
    const f = await input(engine, true);
    if (phase === 'complete') {
      expect(await connectCompanyBrain(engine, f)).toMatchObject({ ok: true, receipt: { outcome: 'complete' } });
      await disposePersistenceConsumer(engine);
      writeFileSync(join(f.path, 'people/operator.md'), '---\ntype: person\ntitle: Example Operator\n---\n# Example Operator\nOwns the updated synthetic account.\n');
      (await makeGitFixture(f.path)).commitAll('Update synthetic company source');
    } else await admitCompanyBrain(engine, f);
    const execute = engine.executeRaw;
    const snapshot = async () => ({
      sources: await execute.call(engine, 'SELECT * FROM sources WHERE id=$1', [f.sourceId]),
      receipts: await execute.call(engine, 'SELECT * FROM source_ingestion_receipts WHERE source_id=$1 ORDER BY id', [f.sourceId]),
      pages: await execute.call(engine, 'SELECT * FROM pages WHERE source_id=$1 ORDER BY id', [f.sourceId]),
      requests: await execute.call(engine, 'SELECT * FROM persistence_requests WHERE source_id=$1 ORDER BY id', [f.sourceId]),
      checkpoints: await execute.call(engine, 'SELECT * FROM op_checkpoints ORDER BY op,fingerprint'),
      effects: await execute.call(engine, 'SELECT * FROM persistence_effects WHERE source_id=$1 ORDER BY id', [f.sourceId]),
    });
    const before = await snapshot(), controller = new AbortController();
    let observed = false, networkCalls = 0;
    const fetcher = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      networkCalls++; throw new Error('Unexpected network call in company cancellation fixture');
    }) as unknown as typeof fetch);
    engine.executeRaw = async function(this: BrainEngine, sql, params) {
      const rows = await execute.call(this, sql, params);
      if (!observed && sql === 'SELECT config,incarnation FROM sources WHERE id=$1' && params?.[0] === f.sourceId) {
        expect((rows[0] as { config: { company_brain: unknown } }).config.company_brain).toBeDefined();
        observed = true; controller.abort(new Error('company profile fixture cancelled'));
      }
      return rows;
    } as BrainEngine['executeRaw'];
    try {
      if (caller === 'job') {
        await expect(withSubmissionAuthority(APPLICATION_AUTHORITY, () => performSync(engine, { sourceId: f.sourceId }), controller.signal))
          .rejects.toMatchObject({ name: 'AbortError', message: 'company profile fixture cancelled' });
      } else expect(await performSync(engine, { sourceId: f.sourceId, signal: controller.signal }))
        .toMatchObject({ status: 'partial', reason: 'timeout', filesImported: 0, added: 0, modified: 0, deleted: 0 });
      expect(observed).toBe(true);
      expect(networkCalls).toBe(0);
      expect(await snapshot()).toEqual(before);
    } finally { engine.executeRaw = execute; fetcher.mockRestore(); await disposePersistenceConsumer(engine); }
  });
}
