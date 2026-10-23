/**
 * Authoring gate: protects explicitly reviewed recovery from a real canonical
 * source-writeback refusal without deleting source identity or widening grants.
 * Reverting reapproval makes the corrected-revision case fail at source_id_taken.
 * Existing runtime recovery tests resume the same approved revision; none replaces
 * a genuinely unimportable CONTENT receipt. Uses existing production APIs only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { inspectCompanyBrain } from '../src/core/company-brain/inspection.ts';
import { admitCompanyBrain, previewCompanyBrain, type CompanyBrainConnectInput } from '../src/core/company-brain/admission.ts';
import { connectCompanyBrain, resumeCompanyBrain } from '../src/core/company-brain/runtime.ts';
import { companyBrainProfile } from '../src/core/company-brain/profile.ts';
import { getSourceIngestionReceipt } from '../src/core/company-brain/receipts.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { loadSyncFailures } from '../src/core/sync-failure-ledger.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

for (const backend of testBackends()) describe(`company reapproval (${backend})`, () => {
const home = realpathSync(mkdtempSync(join(tmpdir(), 'company-reapproval-')));
let engine: BrainEngine;
let closePg: (() => Promise<void>) | undefined;
const selected = ['docs/guide.md', 'docs/transient.md', 'people/owner.md'];
const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', root, ...args], { encoding: 'utf8' }).trim();
const doc = (title: string, body: string, type = 'concept') => `---\ntype: ${type}\ntitle: ${title}\naudience: internal\n---\n# ${title}\n${body}\n`;
const originalOwner = doc('Fictional owner', 'ORIGINAL_OWNER_BODY', 'person');
const fence = `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Fictional fixture claim | partnership | 1.0 | private | medium | 2026-01-01 |  | fixture |  |
<!--- gbrain:facts:end -->`;
type Replacement = CompanyBrainConnectInput & { replaceIncomplete: string };

beforeAll(async () => {
  if (backend === 'postgres') {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePg = pg.close;
  } else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); await closePg?.(); });
  rmSync(home, { recursive: true, force: true });
});

async function sourceState(sourceId: string) {
  return (await engine.executeRaw<{ incarnation: string; local_path: string; config: unknown }>(
    'SELECT incarnation,local_path,config FROM sources WHERE id=$1', [sourceId]))[0];
}
async function grants(clientId: string) {
  return engine.executeRaw('SELECT client_id,scope,source_id,federated_read,allowed_operations,deleted_at FROM oauth_clients WHERE client_id=$1', [clientId]);
}
async function setup(managed: boolean) {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
  const root = mkdtempSync(join(home, 'repo-'));
  await makeGitFixture(root);
  for (const [path, body] of Object.entries({ 'docs/guide.md': doc('Fictional guide', 'ORIGINAL_GUIDE_BODY'), 'people/owner.md': originalOwner,
    'private/excluded.md': doc('Excluded', 'UNAPPROVED_SENTINEL') })) {
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body);
  }
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Fictional approved baseline');
  const inspect = () => inspectCompanyBrain({ path: root, profile: 'company-brain', include: selected });
  const input: CompanyBrainConnectInput = { brainId: 'company-example', sourceId: `reapproval-${randomUUID().slice(0, 8)}`, path: root,
    plan: await inspect(), remote: false, requestId: randomUUID() };
  expect(input.plan.ready, JSON.stringify(input.plan.findings)).toBe(true);
  const first = await connectCompanyBrain(engine, input);
  expect(first.ok).toBe(true);
  return { root, input, first, inspect };
}
async function incomplete(managed: boolean) {
  const f = await setup(managed);
  writeFileSync(join(f.root, 'docs/guide.md'), doc('Fictional guide', 'NEW_GUIDE_BODY'));
  writeFileSync(join(f.root, 'docs/transient.md'), doc('Partial page', 'PARTIAL_PAGE_WITHDRAWN_BY_CORRECTION'));
  writeFileSync(join(f.root, 'people/owner.md'), doc('Fictional owner', `REFUSED_OWNER_BODY\n${fence}`, 'person'));
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'Fictional canonical normalization refusal');
  const failed = await resumeCompanyBrain(engine, f.input);
  expect(failed).toMatchObject({ ok: false, receipt: { phase: 'CONTENT', outcome: 'incomplete' } });
  expect(failed.receipt.counts.failedFiles).toBeGreaterThan(0);
  expect((await engine.getPage('docs/transient', { sourceId: f.input.sourceId }))?.compiled_truth).toContain('PARTIAL_PAGE_WITHDRAWN_BY_CORRECTION');
  expect(readFileSync(join(f.root, 'people/owner.md'), 'utf8')).toContain('| partnership |');
  const state = await sourceState(f.input.sourceId);
  writeFileSync(join(f.root, 'people/owner.md'), doc('Fictional owner', 'CORRECTED_OWNER_BODY', 'person'));
  rmSync(join(f.root, 'docs/transient.md'));
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'Review correction to refused source');
  const replacement: Replacement = { ...f.input, plan: await f.inspect(), requestId: randomUUID(), replaceIncomplete: failed.receipt.id };
  return { ...f, failed, state, replacement };
}

for (const managed of [false, true]) describe(`company reapproval ${managed ? 'managed' : 'legacy'}`, () => {
  test('an explicitly reviewed corrected revision completes without replacing source identity or grants', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await incomplete(managed);
    const plain = await resumeCompanyBrain(engine, f.input);
    expect(plain).toMatchObject({ ok: false, receipt: { id: f.failed.receipt.id, approvedRevision: f.failed.receipt.approvedRevision, outcome: 'incomplete' } });
    const clientId = `fixture-reader-${randomUUID()}`;
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id,federated_read,allowed_operations)
      VALUES($1,'Fictional source reader','read',$2,$3,$4)`, [clientId, f.input.sourceId, [f.input.sourceId], ['search', 'get_page']]);
    const beforeGrants = await grants(clientId);
    const beforePolicy = companyBrainProfile(f.state.config)!;
    const preview = await previewCompanyBrain(engine, f.replacement);
    expect(preview).toMatchObject({ sourceId: f.input.sourceId, policy: { grantsUnchanged: true, federated: false } });
    expect(await sourceState(f.input.sourceId)).toEqual(f.state);
    const result = await connectCompanyBrain(engine, f.replacement);
    expect(result).toMatchObject({ ok: true, receipt: { id: f.replacement.requestId, phase: 'COMPLETE', approvedRevision: f.replacement.plan.revision!.commit } });
    const after = await sourceState(f.input.sourceId);
    expect(after.incarnation).toBe(f.state.incarnation);
    expect(after.local_path).toBe(f.state.local_path);
    const afterPolicy = companyBrainProfile(after.config)!;
    for (const field of ['brainId', 'databaseId', 'repository', 'selection', 'limits', 'schema', 'extractorVersion', 'committedOnly', 'noPull', 'noEmbed', 'noBackfill', 'noWriteback'] as const) {
      expect(afterPolicy[field]).toEqual(beforePolicy[field]);
    }
    expect((after.config as { federated: boolean }).federated).toBe(false);
    expect(await grants(clientId)).toEqual(beforeGrants);
    const old = await getSourceIngestionReceipt(engine, { sourceId: f.input.sourceId, sourceIncarnation: f.state.incarnation, receiptId: f.failed.receipt.id });
    expect(old).toMatchObject({ id: f.failed.receipt.id, outcome: 'discarded', approvedRevision: f.failed.receipt.approvedRevision });
    expect(old!.discardedAt).not.toBeNull();
    expect((await engine.getPage('docs/guide', { sourceId: f.input.sourceId }))?.compiled_truth).toContain('NEW_GUIDE_BODY');
    expect((await engine.getPage('people/owner', { sourceId: f.input.sourceId }))?.compiled_truth).toContain('CORRECTED_OWNER_BODY');
    expect(await engine.getPage('docs/transient', { sourceId: f.input.sourceId })).toBeNull();
    expect(await engine.getPage('private/excluded', { sourceId: f.input.sourceId })).toBeNull();
    expect(git(f.root, 'status', '--porcelain')).toBe('');
    const completedState = await sourceState(f.input.sourceId);
    writeFileSync(join(f.root, 'docs/guide.md'), doc('Fictional guide', 'UNREVIEWED_AFTER_COMPLETE'));
    git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'Advance after reviewed replacement completed');
    const replay = await connectCompanyBrain(engine, f.replacement);
    expect(replay).toMatchObject({ ok: true, receipt: { id: result.receipt.id, approvedRevision: result.receipt.approvedRevision } });
    expect(await sourceState(f.input.sourceId)).toEqual(completedState);
    expect((await engine.getPage('docs/guide', { sourceId: f.input.sourceId }))?.compiled_truth).toContain('NEW_GUIDE_BODY');
    await expect(connectCompanyBrain(engine, { ...f.replacement, plan: await f.inspect() })).rejects.toBeDefined();
    expect(await sourceState(f.input.sourceId)).toEqual(completedState);
  }), 120_000);

  test('ordinary resume after replacement admission reconciles pages from the discarded partial batch', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await incomplete(managed);
    const admitted = await admitCompanyBrain(engine, f.replacement);
    expect(admitted).toMatchObject({ sourceIncarnation: f.state.incarnation, receiptId: f.replacement.requestId });
    const result = await resumeCompanyBrain(engine, f.replacement);
    expect(result).toMatchObject({ ok: true, receipt: { id: f.replacement.requestId, phase: 'COMPLETE' } });
    expect(await engine.getPage('docs/transient', { sourceId: f.input.sourceId })).toBeNull();
    expect((await engine.getPage('people/owner', { sourceId: f.input.sourceId }))?.compiled_truth).toContain('CORRECTED_OWNER_BODY');
    expect((await sourceState(f.input.sourceId)).incarnation).toBe(f.state.incarnation);
  }), 120_000);

  test('replacement refuses wrong receipt, destination, scope, schema, selection, audience and untrusted callers without changing approval', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await incomplete(managed);
    const reject = async (input: Replacement) => {
      await expect(previewCompanyBrain(engine, input)).rejects.toBeDefined();
      await expect(connectCompanyBrain(engine, input)).rejects.toBeDefined();
      expect(await sourceState(f.input.sourceId)).toEqual(f.state);
      expect((await getSourceIngestionReceipt(engine, { sourceId: f.input.sourceId, sourceIncarnation: f.state.incarnation, receiptId: f.failed.receipt.id }))?.outcome).toBe('incomplete');
    };
    await reject({ ...f.replacement, plan: undefined as unknown as CompanyBrainConnectInput['plan'] });
    await reject({ ...f.replacement, replaceIncomplete: randomUUID() });
    await reject({ ...f.replacement, brainId: 'different-brain' });
    await reject({ ...f.replacement, sourceId: `different-${randomUUID().slice(0, 8)}` });
    await reject({ ...f.replacement, path: join(f.root, 'docs') });
    await reject({ ...f.replacement, remote: true });
    await reject({ ...f.replacement, remote: undefined as unknown as boolean });
    await reject({ ...f.replacement, plan: await inspectCompanyBrain({ path: f.root, profile: 'company-brain', include: ['docs/guide.md'] }) });
    await engine.setConfig(`schema_pack.source.${f.input.sourceId}`, 'gbrain-base-v2');
    try { await reject(f.replacement); } finally { await engine.executeRaw('DELETE FROM config WHERE key=$1', [`schema_pack.source.${f.input.sourceId}`]); }
    const ownerPath = join(f.root, 'people/owner.md');
    writeFileSync(ownerPath, readFileSync(ownerPath, 'utf8').replace('audience: internal', 'audience: private'));
    git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'Fictional narrower audience');
    await reject({ ...f.replacement, plan: await f.inspect() });
  }), 120_000);

  if (managed) test('running or recovery-bearing writes prevent replacement without cancelling work', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await incomplete(managed);
    await disposePersistenceConsumer(engine);
    const [request] = await engine.executeRaw<{ request_id: string; state: string; recovery: unknown }>(
      "SELECT request_id,state,recovery FROM persistence_requests WHERE source_id=$1 AND slug='people/owner' AND state='failed' ORDER BY updated_at DESC LIMIT 1", [f.input.sourceId]);
    expect(request).toBeDefined();
    try {
      await engine.executeRaw("UPDATE persistence_requests SET state='running' WHERE request_id=$1::uuid", [request.request_id]);
      await expect(previewCompanyBrain(engine, f.replacement)).rejects.toMatchObject({ code: 'write_pending' });
      await expect(connectCompanyBrain(engine, f.replacement)).rejects.toMatchObject({ code: 'write_pending' });
      expect(await sourceState(f.input.sourceId)).toEqual(f.state);
      expect((await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [request.request_id]))[0].state).toBe('running');
      await engine.executeRaw("UPDATE persistence_requests SET state='failed',recovery='{\"version\":1}'::jsonb WHERE request_id=$1::uuid", [request.request_id]);
      await expect(previewCompanyBrain(engine, f.replacement)).rejects.toMatchObject({ code: 'write_pending' });
      await expect(connectCompanyBrain(engine, f.replacement)).rejects.toMatchObject({ code: 'write_pending' });
      expect(await sourceState(f.input.sourceId)).toEqual(f.state);
      expect((await engine.executeRaw<{ recovery: unknown }>('SELECT recovery FROM persistence_requests WHERE request_id=$1::uuid', [request.request_id]))[0].recovery).toEqual({ version: 1 });
    } finally {
      await engine.executeRaw('UPDATE persistence_requests SET state=$2,recovery=$3::text::jsonb WHERE request_id=$1::uuid',
        [request.request_id, request.state, request.recovery === null ? null : JSON.stringify(request.recovery)]);
    }
  }), 120_000);

  if (managed) test('a late admission conflict rolls back cursor retirement and keeps its failure mirror for retry', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await incomplete(managed);
    const receiptScope = { sourceId: f.input.sourceId, sourceIncarnation: f.state.incarnation, receiptId: f.failed.receipt.id };
    const beforeReceipt = await getSourceIngestionReceipt(engine, receiptScope);
    const fingerprints = f.failed.receipt.checkpointRefs.map(ref => ref.fingerprint);
    const checkpoints = () => engine.executeRaw(`SELECT op,fingerprint,completed_keys FROM op_checkpoints
      WHERE fingerprint=ANY($1::text[]) OR completed_keys->0->>'source_id'=$2 OR completed_keys->0->>'sourceId'=$2 ORDER BY op,fingerprint`,
    [fingerprints, f.input.sourceId]);
    const beforeCheckpoints = await checkpoints();
    const mirror = () => loadSyncFailures().filter(row => row.source_id === f.input.sourceId);
    const beforeMirror = mirror();
    expect(beforeMirror.length).toBeGreaterThan(0);
    // A real unique-key failure occurs after old-cursor retirement, inside the
    // outer admission transaction. No mock or production fault hook is needed.
    await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('company-brain-plan',$1,'[]'::jsonb)", [f.replacement.requestId!]);
    try {
      await expect(admitCompanyBrain(engine, f.replacement)).rejects.toMatchObject({ code: '23505' });
      expect(await sourceState(f.input.sourceId)).toEqual(f.state);
      expect(await getSourceIngestionReceipt(engine, receiptScope)).toEqual(beforeReceipt);
      expect(await checkpoints()).toEqual(beforeCheckpoints);
      expect(mirror()).toEqual(beforeMirror);
    } finally {
      await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='company-brain-plan' AND fingerprint=$1", [f.replacement.requestId!]);
    }
    const retried = await connectCompanyBrain(engine, f.replacement);
    expect(retried).toMatchObject({ ok: true, receipt: { id: f.replacement.requestId, phase: 'COMPLETE' } });
    expect((await sourceState(f.input.sourceId)).incarnation).toBe(f.state.incarnation);
    expect(await engine.getPage('docs/transient', { sourceId: f.input.sourceId })).toBeNull();
  }), 120_000);

  test('completed receipts and stale reviewed plans cannot be replaced', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const complete = await setup(managed);
    const before = await sourceState(complete.input.sourceId);
    const replacement = { ...complete.input, requestId: randomUUID(), replaceIncomplete: complete.first.receipt.id };
    await expect(connectCompanyBrain(engine, replacement)).rejects.toBeDefined();
    expect(await sourceState(complete.input.sourceId)).toEqual(before);
    const f = await incomplete(managed);
    writeFileSync(join(f.root, 'docs/guide.md'), doc('Fictional guide', 'NEWER_UNREVIEWED_GUIDE'));
    git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'Advance beyond saved replacement plan');
    await expect(connectCompanyBrain(engine, f.replacement)).rejects.toMatchObject({ code: 'plan_stale' });
    expect(await sourceState(f.input.sourceId)).toEqual(f.state);
  }), 120_000);
});
});
