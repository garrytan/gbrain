import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { inspectCompanyBrain } from '../src/core/company-brain/inspection.ts';
import { admitCompanyBrain, previewCompanyBrain } from '../src/core/company-brain/admission.ts';
import { companyBrainProfile } from '../src/core/company-brain/profile.ts';
import { getSourceIngestionReceipt } from '../src/core/company-brain/receipts.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { connectCompanyBrain, resumeCompanyBrain } from '../src/core/company-brain/runtime.ts';
import { performSync } from '../src/commands/sync.ts';
import { purgeStaleCheckpoints } from '../src/core/op-checkpoint.ts';
import { submitEmbedBackfill } from '../src/core/embed-backfill-submit.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import * as verification from '../src/core/company-brain/verification.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-company-runtime-'));
const engines: BrainEngine[] = [];
let closePg: (() => Promise<void>) | undefined;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', root, ...args], { encoding: 'utf8' }).trim();
async function fixture() {
  const root = mkdtempSync(join(home, 'repo-'));
  await makeGitFixture(root);
  for (const [path, body] of Object.entries({
    'people/operator.md': '---\ntype: person\ntitle: Example Operator\n---\n# Example Operator\nOwns the account.\n',
    'customers/account.md': '---\ntype: customer\ntitle: Example Account\nowner: "[[people/operator]]"\naudience: internal\n---\n# Example Account\nA synthetic account with an explicit owner.\n',
    'README.md': '# Excluded scaffolding\n',
  })) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); }
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Synthetic source fixture');
  return root;
}
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePg = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePg?.();
  });
  rmSync(home, { recursive: true, force: true });
});

for (const managed of [false, true]) describe(`company source lifecycle ${managed ? 'managed' : 'legacy'}`, () => {
  test('admission is local-only, atomic and replayable without repository or host schema edits', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
      const root = await fixture();
      const plan = await inspectCompanyBrain({ path: root, profile: 'company-brain' });
      expect(plan.ready).toBe(true);
      const sourceId = `company-${randomUUID().slice(0, 8)}`;
      const input = { brainId: 'company-example', sourceId, path: root, plan, remote: false, requestId: randomUUID() };
      const preview = await previewCompanyBrain(engine, input);
      expect(preview).toMatchObject({ sourceId, managed, policy: { audience: 'internal', federated: false, grantsUnchanged: true } });
      await expect(admitCompanyBrain(engine, { ...input, remote: true })).rejects.toMatchObject({ code: 'permission_denied' });
      expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [sourceId])).toHaveLength(0);
      const admitted = await admitCompanyBrain(engine, input);
      expect(await admitCompanyBrain(engine, input)).toEqual(admitted);
      const [row] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [sourceId]);
      expect(companyBrainProfile(row.config)).toMatchObject({ receiptId: input.requestId, noEmbed: true, noWriteback: true });
      expect((await getSourceIngestionReceipt(engine, { sourceId, sourceIncarnation: admitted.sourceIncarnation, receiptId: admitted.receiptId }))?.phase).toBe('ADMITTED');
      expect(await engine.getConfig('schema_pack')).toBe('company-brain');
      expect(existsSync(join(root, '.gitignore'))).toBe(false);
      expect(existsSync(join(home, 'config.json'))).toBe(false);
    }
  }), 120_000);
  test('connect verifies content and ownership, preserves history, and ordinary sync reconciles new targets', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
      const root = await fixture();
      const path = join(root, 'customers/account.md');
      const body = readFileSync(path, 'utf8') + '\n---\n- **2026-09-01** | Meeting — Account approved.\n';
      writeFileSync(path, body); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Synthetic account history');
      const plan = await inspectCompanyBrain({ path: root, profile: 'company-brain' });
      const sourceId = `company-${randomUUID().slice(0, 8)}`;
      const input = { brainId: 'company-example', sourceId, path: root, plan, remote: false, requestId: randomUUID() };
      const result = await connectCompanyBrain(engine, input);
      expect(result).toMatchObject({ ok: true, code: 'complete', receipt: { phase: 'COMPLETE', counts: { importedPages: 2 } } });
      expect(readFileSync(path, 'utf8')).toBe(body);
      expect(existsSync(join(root, '.gitignore'))).toBe(false);
      expect(await engine.getPage('readme', { sourceId })).toBeNull();
      expect(await engine.executeRaw('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND text_projection_revision IS DISTINCT FROM knowledge_revision', [sourceId])).toEqual([]);
      expect((await engine.getLinks('customers/account', { sourceId })).some(link => link.to_slug === 'people/operator' && link.link_type === 'owned_by')).toBe(true);
      expect(await engine.executeRaw('SELECT t.summary FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1', [sourceId])).toContainEqual({ summary: 'Account approved.' });
      const unchanged = await resumeCompanyBrain(engine, input);
      expect(unchanged.receipt.id).toBe(result.receipt.id);
      writeFileSync(path, body.replace('people/operator', 'people/replacement'));
      writeFileSync(join(root, 'people/replacement.md'), '---\ntype: person\ntitle: Example Replacement\n---\n# Example Replacement\nThe new account owner.\n');
      git(root, 'add', '.'); git(root, 'commit', '-qm', 'Synthetic owner change');
      const next = await performSync(engine, { sourceId });
      expect(next.status).toBe('synced');
      const links = await engine.getLinks('customers/account', { sourceId });
      expect(links.some(link => link.to_slug === 'people/replacement' && link.link_type === 'owned_by')).toBe(true);
      expect(links.some(link => link.to_slug === 'people/operator' && link.link_type === 'owned_by')).toBe(false);
      expect(await engine.executeRaw('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND text_projection_revision IS DISTINCT FROM knowledge_revision', [sourceId])).toEqual([]);
    }
  }), 120_000);
  test('graph failure retains real cursors beyond GC and zero-diff resume completes only missing phases', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
      const root = await fixture();
      const input = { brainId: 'company-example', sourceId: `company-${randomUUID().slice(0, 8)}`, path: root,
        plan: await inspectCompanyBrain({ path: root, profile: 'company-brain' }), remote: false, requestId: randomUUID() };
      const original = engine.replaceDerivedLinks;
      engine.replaceDerivedLinks = async () => { throw new Error('Synthetic interruption before graph publication'); };
      let interrupted;
      try { interrupted = await connectCompanyBrain(engine, input); } finally { engine.replaceDerivedLinks = original; }
      expect(interrupted).toMatchObject({ ok: false, code: 'graph_incomplete', receipt: { phase: 'GRAPH', outcome: 'incomplete' } });
      const refs = interrupted!.receipt.checkpointRefs;
      expect(refs.some(ref => ref.kind === (managed ? 'managed_cursor' : 'content'))).toBe(true);
      await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '30 days'");
      await purgeStaleCheckpoints(engine);
      for (const ref of refs.filter(ref => ref.kind !== 'graph')) expect(await engine.executeRaw('SELECT op FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [ref.op, ref.fingerprint])).toHaveLength(1);
      const [before] = await engine.executeRaw<{ count: string }>('SELECT count(*)::text AS count FROM persistence_requests WHERE source_id=$1', [input.sourceId]);
      const resumed = await resumeCompanyBrain(engine, input);
      expect(resumed).toMatchObject({ ok: true, receipt: { id: input.requestId, phase: 'COMPLETE' } });
      expect((await engine.executeRaw<{ count: string }>('SELECT count(*)::text AS count FROM persistence_requests WHERE source_id=$1', [input.sourceId]))[0].count).toBe(before.count);
      if (engine.kind === 'pglite') expect(await submitEmbedBackfill(engine, input.sourceId, { reason: 'sync_handler' })).toMatchObject({ status: 'no_worker_surface' });
      else await expect(submitEmbedBackfill(engine, input.sourceId, { reason: 'sync_handler' })).rejects.toMatchObject({ code: 'source_profile_no_backfill' });
      await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '30 days'");
      await purgeStaleCheckpoints(engine);
      expect((await resumeCompanyBrain(engine, input)).ok).toBe(true);
    }
  }), 120_000);
  test('interrupted content reads the approved commit after detached HEAD and missing working files', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
      await engine.setConfig('sync.include_working_tree', 'true');
      const root = await fixture();
      const input = { brainId: 'company-example', sourceId: `company-${randomUUID().slice(0, 8)}`, path: root,
        plan: await inspectCompanyBrain({ path: root, profile: 'company-brain' }), remote: false, requestId: randomUUID() };
      await admitCompanyBrain(engine, input);
      const interrupted = await resumeCompanyBrain(engine, input, { signal: AbortSignal.abort() });
      expect(interrupted.ok).toBe(false);
      expect(interrupted.receipt.phase).toBe('CONTENT');
      writeFileSync(join(root, 'customers/account.md'), '---\ntype: customer\ntitle: Newer Account\n---\nNot the approved content.\n');
      git(root, 'add', '.'); git(root, 'commit', '-qm', 'Newer synthetic revision'); git(root, 'checkout', '--detach', '-q');
      rmSync(join(root, 'people/operator.md'));
      const result = await resumeCompanyBrain(engine, input);
      expect(result).toMatchObject({ ok: true, receipt: { approvedRevision: input.plan.revision!.commit } });
      expect((await engine.getPage('customers/account', { sourceId: input.sourceId }))?.title).toBe('Example Account');
      expect(await engine.getPage('people/operator', { sourceId: input.sourceId })).not.toBeNull();
      expect(existsSync(join(root, 'people/operator.md'))).toBe(false);
      await engine.setConfig('sync.include_working_tree', 'false');
    }
  }), 120_000);
  test('verification catches missing explicit edges and repairs them on zero-diff retry', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
      const root = await fixture();
      const input = { brainId: 'company-example', sourceId: `company-${randomUUID().slice(0, 8)}`, path: root,
        plan: await inspectCompanyBrain({ path: root, profile: 'company-brain' }), remote: false, requestId: randomUUID() };
      const original = engine.replaceDerivedLinks;
      engine.replaceDerivedLinks = async function (...args) {
        const result = await original.apply(this, args);
        await this.executeRaw('DELETE FROM links WHERE origin_page_id IN (SELECT id FROM pages WHERE source_id=$1)', [input.sourceId]);
        return result;
      };
      let result;
      try { result = await connectCompanyBrain(engine, input); } finally { engine.replaceDerivedLinks = original; }
      expect(result).toMatchObject({ ok: false, code: 'verification_failed', receipt: { phase: 'VERIFY', outcome: 'incomplete' } });
      expect((await resumeCompanyBrain(engine, input)).ok).toBe(true);
    }
  }), 120_000);
  test('same-source frontmatter reattribution cannot cross the completion fence', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
      const root = await fixture();
      const input = { brainId: 'company-example', sourceId: `company-${randomUUID().slice(0, 8)}`, path: root,
        plan: await inspectCompanyBrain({ path: root, profile: 'company-brain' }), remote: false, requestId: randomUUID() };
      const original = verification.companyBrainGraphStamp;
      let reads = 0;
      const stamps: string[] = [];
      const probe = spyOn(verification, 'companyBrainGraphStamp').mockImplementation(async (tx, sourceId) => {
        if (sourceId === input.sourceId && ++reads === 2) {
          await tx.executeRaw(`UPDATE links l SET origin_page_id=l.to_page_id FROM pages p
            WHERE p.id=l.from_page_id AND p.source_id=$1 AND l.link_source='frontmatter'`, [sourceId]);
        }
        const stamp = await original(tx, sourceId);
        stamps.push(stamp);
        return stamp;
      });
      let result;
      try { result = await connectCompanyBrain(engine, input); } finally { probe.mockRestore(); }
      expect(stamps).toHaveLength(2);
      expect(stamps[0]).not.toBe(stamps[1]);
      expect(result).toMatchObject({ ok: false, code: 'verification_failed', receipt: { phase: 'VERIFY', outcome: 'incomplete' } });
      expect((await resumeCompanyBrain(engine, input)).ok).toBe(true);
    }
  }), 120_000);
  test('canonical tag overlays refuse source writeback instead of changing approved bytes', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
      const root = await fixture();
      const input = { brainId: 'company-example', sourceId: `company-${randomUUID().slice(0, 8)}`, path: root,
        plan: await inspectCompanyBrain({ path: root, profile: 'company-brain' }), remote: false, requestId: randomUUID() };
      expect((await connectCompanyBrain(engine, input)).ok).toBe(true);
      await engine.transaction(tx => withCoordinatedWrite(tx, [input.sourceId], () => tx.addTag('customers/account', 'retained-tag', { sourceId: input.sourceId })));
      const file = join(root, 'customers/account.md');
      const changed = readFileSync(file, 'utf8') + '\nA committed source update.\n';
      writeFileSync(file, changed); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Synthetic source update');
      const result = await performSync(engine, { sourceId: input.sourceId });
      expect(result.status).toBe('blocked_by_failures');
      expect(result.failureCodes).toContainEqual({ code: 'source_writeback_required', count: 1 });
      expect(readFileSync(file, 'utf8')).toBe(changed);
      expect(existsSync(join(root, '.gitignore'))).toBe(false);
    }
  }), 120_000);
  test('private audience and incompatible destination schema never register a source', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
      const root = await fixture();
      const file = join(root, 'customers/account.md');
      writeFileSync(file, readFileSync(file, 'utf8').replace('audience: internal', 'visibility: private'));
      git(root, 'add', '.'); git(root, 'commit', '-qm', 'Synthetic restricted source');
      const input = { brainId: 'company-example', sourceId: `company-${randomUUID().slice(0, 8)}`, path: root,
        plan: await inspectCompanyBrain({ path: root, profile: 'company-brain' }), remote: false, requestId: randomUUID() };
      await expect(admitCompanyBrain(engine, input)).rejects.toMatchObject({ code: 'destination_not_ready' });
      expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [input.sourceId])).toHaveLength(0);
      const schemaBefore = await engine.getConfig('schema_pack');
      await engine.setConfig('schema_pack.source.conflict', 'gbrain-base-v2');
      const clean = await fixture();
      try { await expect(admitCompanyBrain(engine, { ...input, path: clean, plan: await inspectCompanyBrain({ path: clean, profile: 'company-brain' }) })).rejects.toMatchObject({ code: 'schema_identity_mismatch' }); }
      finally { await engine.executeRaw("DELETE FROM config WHERE key='schema_pack.source.conflict'"); }
      expect(await engine.getConfig('schema_pack')).toBe(schemaBefore);
    }
  }), 120_000);
  test('unchanged origins gain newly resolvable edges and lose edges after target retyping or deletion', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
      const root = await fixture();
      mkdirSync(join(root, 'decisions'));
      mkdirSync(join(root, 'meetings'));
      writeFileSync(join(root, 'decisions/choice.md'), '---\ntype: decision\ntitle: Example Choice\n---\n# Example Choice\nApproved in [[meetings/future]].\n');
      git(root, 'add', '.'); git(root, 'commit', '-qm', 'Synthetic unresolved meeting');
      const input = { brainId: 'company-example', sourceId: `company-${randomUUID().slice(0, 8)}`, path: root,
        plan: await inspectCompanyBrain({ path: root, profile: 'company-brain' }), remote: false };
      const first = await connectCompanyBrain(engine, input);
      expect(first.ok).toBe(true);
      expect(first.receipt.counts.unresolvedLinks).toBeGreaterThan(0);
      const future = join(root, 'meetings/future.md');
      const meeting = '---\ntype: meeting\ntitle: Example Future\n---\n# Example Future\nThe decision meeting.\n';
      writeFileSync(future, meeting); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Synthetic target addition');
      expect((await performSync(engine, { sourceId: input.sourceId })).status).toBe('synced');
      const owned = async () => (await engine.getLinks('decisions/choice', { sourceId: input.sourceId })).filter(link => link.link_type === 'decided_in');
      expect(await owned()).toHaveLength(1);
      writeFileSync(future, meeting.replace('type: meeting', 'type: customer'));
      git(root, 'add', '.'); git(root, 'commit', '-qm', 'Synthetic target retyping');
      expect((await performSync(engine, { sourceId: input.sourceId })).status).toBe('synced');
      expect(await owned()).toHaveLength(0);
      rmSync(future); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Synthetic target deletion');
      expect((await performSync(engine, { sourceId: input.sourceId })).status).toBe('synced');
      expect(await owned()).toHaveLength(0);
    }
  }), 120_000);
});
