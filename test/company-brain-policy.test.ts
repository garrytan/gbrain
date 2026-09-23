import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { inspectCompanyBrain } from '../src/core/company-brain/inspection.ts';
import { admitCompanyBrain, previewCompanyBrain } from '../src/core/company-brain/admission.ts';
import { connectCompanyBrain, resumeCompanyBrain } from '../src/core/company-brain/runtime.ts';
import { companyBrainProfile, companyBrainPolicyFingerprint } from '../src/core/company-brain/policy.ts';
import { performSync } from '../src/commands/sync.ts';
import { runSources } from '../src/commands/sources.ts';
import { submitEmbedBackfill } from '../src/core/embed-backfill-submit.ts';
import { purgeStaleCheckpoints } from '../src/core/op-checkpoint.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { removeSource } from '../src/core/sources-ops.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';

const home = mkdtempSync(join(tmpdir(), 'company-policy-'));
const engines: BrainEngine[] = [];
let closePg: (() => Promise<void>) | undefined;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', root, ...args], { encoding: 'utf8' }).trim();
async function fixture() {
  const root = mkdtempSync(join(home, 'repo-')); mkdirSync(join(root, 'people'));
  for (let index = 1; index <= 15; index++) writeFileSync(join(root, `people/person-${String(index).padStart(2, '0')}.md`), `---\ntype: person\ntitle: Example ${index}\n---\n# Example ${index}\nA synthetic contact for policy validation.\n`);
  await makeGitFixture(root); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Synthetic policy fixture');
  return root;
}
async function input(root: string) {
  return { brainId: 'company-example', sourceId: `policy-${randomUUID().slice(0, 8)}`, remote: false, requestId: randomUUID(), path: root,
    plan: await inspectCompanyBrain({ path: root, profile: 'company-brain', include: ['people/person-01.md'],
      limits: { maxEntries: 30, maxMetadataBytes: 1_048_576, maxFileBytes: 8192 } }) };
}
async function state(engine: BrainEngine, sourceId: string) {
  return { source: await engine.executeRaw('SELECT * FROM sources WHERE id=$1', [sourceId]),
    receipts: await engine.executeRaw('SELECT * FROM source_ingestion_receipts WHERE source_id=$1 ORDER BY id', [sourceId]),
    pages: await engine.executeRaw('SELECT slug,type,compiled_truth,knowledge_revision FROM pages WHERE source_id=$1 ORDER BY slug', [sourceId]) };
}
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePg = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } await closePg?.(); });
  rmSync(home, { recursive: true, force: true });
});

for (const managed of [false, true]) describe(`immutable company approval (${managed ? 'managed' : 'legacy'})`, () => {
  test('malformed or valid changed policy never broadens the approved one-page selection after plan GC', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
      const request = await input(await fixture());
      const connected = await connectCompanyBrain(engine, request);
      expect(connected.ok).toBe(true);
      expect(connected.receipt.counts.importedPages).toBe(1);
      await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '30 days'"); await purgeStaleCheckpoints(engine);
      expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='company-brain-plan' AND fingerprint=$1", [request.requestId])).toHaveLength(0);
      const [row] = await engine.executeRaw<{ config: Record<string, unknown> }>('SELECT config FROM sources WHERE id=$1', [request.sourceId]);
      const profile = companyBrainProfile(row.config)!;
      const edits: Record<string, unknown>[] = [
        { selection: {} }, { selection: { include: [], exclude: [] } }, { selection: { include: 'people/**', exclude: [], defaults_version: 1 } },
        { selection: { include: [], exclude: [], defaults_version: 2 } }, { selection: { include: ['../escape/**'], exclude: [], defaults_version: 1 } },
        { limits: {} }, { limits: { maxEntries: 0, maxMetadataBytes: 1, maxFileBytes: 1 } },
        { schema: {} }, { schema: { ...profile.schema, identity: 'wrong' } }, { schema: { ...profile.schema, resolved_digest: 'short' } },
        { receiptId: 'not-a-uuid' }, { databaseId: 'not-a-uuid' }, { planDigest: 'short' }, { approvedRevision: 'short' },
        { brainId: '../other' }, { extractorVersion: '' }, { noBackfill: false },
        { selection: { include: [], exclude: [], defaults_version: 1 } },
        { selection: { ...profile.selection, exclude: ['people/person-01.md'] } },
        { limits: { ...profile.limits, maxEntries: 31 } }, { databaseId: randomUUID() }, { brainId: 'other-example' },
        { repository: { ...profile.repository, root: `${request.path}-other`, git_root: `${request.path}-other`, git_dir: `${request.path}-other/.git` } },
      ];
      for (const edit of edits) {
        await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1', [request.sourceId, JSON.stringify({ ...row.config, company_brain: { ...profile, ...edit } })]);
        const before = await state(engine, request.sourceId);
        await expect(performSync(engine, { sourceId: request.sourceId, full: true })).rejects.toBeDefined();
        expect(await state(engine, request.sourceId)).toEqual(before);
      }
      for (const config of [{ ...row.config, federated: 'true' }, { ...row.config, federated: null }, { ...row.config, federated: undefined }, { ...row.config, strategy: 'auto' }, { ...row.config, company_brain: undefined }]) {
        await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1', [request.sourceId, JSON.stringify(config)]);
        const before = await state(engine, request.sourceId);
        await expect(performSync(engine, { sourceId: request.sourceId })).rejects.toMatchObject({ code: 'profile_incompatible' });
        expect(await state(engine, request.sourceId)).toEqual(before);
      }
      await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1', [request.sourceId, JSON.stringify(row.config)]);
      expect((await resumeCompanyBrain(engine, request)).ok).toBe(true);
      expect((await state(engine, request.sourceId)).pages).toHaveLength(1);
    }
  }), 120_000);

  test('explicit federation preserves keyless import approval and cannot enqueue automatic enrichment', async () => withEnv({
    GBRAIN_HOME: home, OPENAI_API_KEY: 'synthetic-unused-company-key',
  }, async () => {
    let providerCalls = 0;
    const rejectProvider = () => { providerCalls++; throw new Error('Provider calls are prohibited for this profile'); };
    const providerFetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => rejectProvider(), { preconnect: rejectProvider }));
    try {
      for (const engine of engines) {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
        await engine.setConfig('sync.federated_v2', 'true');
        const request = await input(await fixture());
        const connected = await connectCompanyBrain(engine, request);
        expect(connected.ok).toBe(true);
        const [initial] = await engine.executeRaw<{ config: Record<string, unknown> }>('SELECT config FROM sources WHERE id=$1', [request.sourceId]);
        expect(initial.config.federated).toBe(false);
        const approval = companyBrainPolicyFingerprint(companyBrainProfile(initial.config)!, request.sourceId);
        expect(connected.receipt.policyFingerprint).toBe(approval);
        await runSources(engine, ['federate', request.sourceId]);
        const [shared] = await engine.executeRaw<{ config: Record<string, unknown> }>('SELECT config FROM sources WHERE id=$1', [request.sourceId]);
        expect(shared.config.federated).toBe(true);
        expect(companyBrainPolicyFingerprint(companyBrainProfile(shared.config)!, request.sourceId)).toBe(approval);
        if (engine.kind === 'pglite') expect(await submitEmbedBackfill(engine, request.sourceId, { reason: 'federation_flip' })).toMatchObject({ status: 'no_worker_surface' });
        else await expect(submitEmbedBackfill(engine, request.sourceId, { reason: 'federation_flip' })).rejects.toMatchObject({ code: 'source_profile_no_backfill' });
        const file = join(request.path, 'people/person-01.md');
        const content = readFileSync(file, 'utf8') + '\nAn explicitly committed update after sharing.\n';
        writeFileSync(file, content); git(request.path, 'add', '.'); git(request.path, 'commit', '-qm', 'Synthetic shared source update');
        expect(await performSync(engine, { sourceId: request.sourceId })).toMatchObject({ status: 'synced', embedded: 0 });
        const [after] = await engine.executeRaw<{ config: Record<string, unknown> }>('SELECT config FROM sources WHERE id=$1', [request.sourceId]);
        expect(after.config.federated).toBe(true);
        expect((await resumeCompanyBrain(engine, request)).receipt.policyFingerprint).toBe(approval);
        expect((await state(engine, request.sourceId)).pages).toHaveLength(1);
        expect(readFileSync(file, 'utf8')).toBe(content);
        expect(existsSync(join(request.path, '.gitignore'))).toBe(false);
        expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='embed-backfill' AND data->>'sourceId'=$1", [request.sourceId])).toHaveLength(0);
      }
      expect(providerCalls).toBe(0);
    } finally { providerFetch.mockRestore(); }
  }), 120_000);

  test('old extractor approval refuses same-commit, changed-commit, and full sync without a new receipt', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
      const request = await input(await fixture());
      const connected = await connectCompanyBrain(engine, request); expect(connected.ok).toBe(true);
      const [row] = await engine.executeRaw<{ config: Record<string, unknown> }>('SELECT config FROM sources WHERE id=$1', [request.sourceId]);
      const profile = { ...companyBrainProfile(row.config)!, extractorVersion: '2000-01-01T00:00:00Z' };
      await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1', [request.sourceId, JSON.stringify({ ...row.config, company_brain: profile })]);
      await engine.executeRaw('UPDATE source_ingestion_receipts SET extractor_version=$2,policy_fingerprint=$3 WHERE id=$1::uuid', [connected.receipt.id, profile.extractorVersion, companyBrainPolicyFingerprint(profile, request.sourceId)]);
      await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '30 days'"); await purgeStaleCheckpoints(engine);
      for (const changed of [false, true]) {
        if (changed) { writeFileSync(join(request.path, 'people/person-02.md'), '---\ntype: person\ntitle: Changed Example\n---\nA changed but excluded synthetic contact.\n'); git(request.path, 'add', '.'); git(request.path, 'commit', '-qm', 'Synthetic new revision'); }
        for (const full of [false, true]) {
          const before = await state(engine, request.sourceId);
          await expect(performSync(engine, { sourceId: request.sourceId, full })).rejects.toMatchObject({ code: 'extractor_identity_mismatch' });
          expect(await state(engine, request.sourceId)).toEqual(before);
        }
      }
    }
  }), 120_000);

  test('preview replays only the exact prior request, source incarnation, principal, repository and approval', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
      const request = await input(await fixture());
      const admitted = await admitCompanyBrain(engine, request);
      const before = await state(engine, request.sourceId);
      expect(await previewCompanyBrain(engine, request)).toMatchObject({ replayed: true, receiptId: admitted.receiptId, approvedRevision: request.plan.revision!.commit });
      expect(await state(engine, request.sourceId)).toEqual(before);
      expect((await connectCompanyBrain(engine, request)).ok).toBe(true);
      expect((await previewCompanyBrain(engine, request)).replayed).toBe(true);
      await expect(previewCompanyBrain(engine, { ...request, requestId: randomUUID() })).rejects.toMatchObject({ code: 'source_id_taken' });
      await expect(previewCompanyBrain(engine, { ...request, requestId: undefined })).rejects.toMatchObject({ code: 'source_id_taken' });
      await expect(previewCompanyBrain(engine, { ...request, brainId: 'other-example' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
      const different = await inspectCompanyBrain({ path: request.path, profile: 'company-brain', include: ['people/person-02.md'] });
      await expect(previewCompanyBrain(engine, { ...request, plan: different })).rejects.toMatchObject({ code: 'idempotency_conflict' });
      await expect(previewCompanyBrain(engine, { ...request, path: await fixture() })).rejects.toBeDefined();
      await removeSource(engine, { id: request.sourceId, confirmDestructive: true, yes: true, keepStorage: true, requestId: randomUUID() });
      const replacement = { ...request, requestId: randomUUID(), plan: await inspectCompanyBrain({ path: request.path, profile: 'company-brain',
        include: request.plan.selection.include, exclude: request.plan.selection.exclude, limits: request.plan.limits }) };
      expect((await admitCompanyBrain(engine, replacement)).sourceIncarnation).not.toBe(admitted.sourceIncarnation);
      await expect(previewCompanyBrain(engine, request)).rejects.toMatchObject({ code: 'source_id_taken' });
      await registerLocalWriter(engine, 'cli', undefined, true);
      await expect(previewCompanyBrain(engine, replacement)).rejects.toMatchObject({ code: 'source_id_taken' });
    }
  }), 120_000);
});
