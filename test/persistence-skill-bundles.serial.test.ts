import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { BUNDLE_FILE_LIMITS } from '../src/core/persistence/bundle-files.ts';
import { publishMutation, recoverPublication, type PreparedMutation } from '../src/core/persistence/coordinator.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { advanceEffectCursor, claimPersistenceEffect, completeEffect, renewPersistenceEffectClaim } from '../src/core/persistence/effect-journal.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite, compactWriteReceipts, getWriteRequestById, prepareRecovery, type WriteAdmission } from '../src/core/persistence/journal.ts';
import { acquireWorktree, claimWorktree, type WorktreeBinding } from '../src/core/persistence/ownership.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { preparePersistedMutation } from '../src/core/persistence/service.ts';
import { prepareManagedSyncMutation, type SyncIntent } from '../src/core/persistence/sync-prepare.ts';
import { managedSyncAuthority } from '../src/core/persistence/sync-authority.ts';
import { SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS } from '../src/core/shared-skills/persistence-schema.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-skill-persistence-'));
const oldHome = process.env.GBRAIN_HOME;
const fixtures: Array<{ engine: BrainEngine; root: string; binding: WorktreeBinding; close(): Promise<void> }> = [];
const sourceId = 'bundle-example';
let hostId: string;

beforeAll(async () => {
  process.env.GBRAIN_HOME = home;
  hostId = localHostId();
  const engines: Array<{ engine: BrainEngine; close(): Promise<void> }> = [];
  if (backends.includes('pglite')) {
    const local = new PGLiteEngine();
    await local.connect({}); await local.initSchema();
    engines.push({ engine: local, close: () => local.disconnect() });
  }
  if (backends.includes('postgres')) engines.push(await isolatedPersistencePostgres(process.env.DATABASE_URL!));
  for (const item of engines) {
    for (const statement of SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS) await item.engine.executeRaw(statement);
    const gitRoot = join(home, item.engine.kind); mkdirSync(gitRoot);
    await makeGitFixture(gitRoot);
    const root = join(gitRoot, 'content'); mkdirSync(root);
    await item.engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    await registerLocalWriter(item.engine, 'cli');
    const binding = await claimWorktree(item.engine, sourceId, root);
    await expect(activateSharedSkillPersistence(item.engine)).rejects.toMatchObject({ code: 'writer_not_quiesced' });
    await activateSharedSkillPersistence(item.engine, { confirmQuiesced: true });
    await item.engine.executeRaw('CREATE TABLE bundle_projection_fixture (slug text PRIMARY KEY, revision uuid NOT NULL, body text NOT NULL)');
    fixtures.push({ ...item, root, binding });
  }
}, 120_000);

afterAll(async () => {
  for (const fixture of fixtures) await fixture.close();
  if (oldHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

async function prepare(f: typeof fixtures[number], name: string, expected: string | null = null) {
  const ctx: OperationContext = { engine: f.engine, config: { engine: f.engine.kind }, sourceId, remote: false,
    dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  const authority = await submissionAuthority(ctx, 'put_skill', sourceId, f.binding.source_incarnation, name);
  const path = join(f.root, 'skills', name); mkdirSync(path, { recursive: true });
  const files = [
    { path: join(path, 'SKILL.md'), root: f.root, content: 'new instructions', expectedBeforeHash: sha256('old instructions') },
    { path: join(path, 'helper.txt'), root: f.root, content: 'new helper', expectedBeforeHash: null },
    { path: join(path, 'obsolete.txt'), root: f.root, content: null, expectedBeforeHash: sha256('obsolete') },
  ];
  writeFileSync(files[0].path, 'old instructions'); chmodSync(files[0].path, 0o640);
  writeFileSync(files[2].path, 'obsolete'); chmodSync(files[2].path, 0o600);
  const admission: WriteAdmission = { principal: authority.principal, operation: 'put_skill', targetKind: 'skill_bundle', protocolVersion: 2,
    sourceId, sourceIncarnation: f.binding.source_incarnation, slug: name, worktreeId: f.binding.worktree_id,
    topologyGeneration: f.binding.topology_generation, requestId: randomUUID(), callerIntent: { name, expected }, intent: { name }, authority };
  const revision = randomUUID();
  const prepared: PreparedMutation = { target: 'skill_bundle', observedRevision: expected, files,
    validate: async tx => {
      const [head] = await tx.executeRaw<{ revision: string }>('SELECT revision FROM bundle_projection_fixture WHERE slug=$1 FOR UPDATE', [name]);
      if ((head?.revision ?? null) !== expected) throw new OperationError('revision_conflict', 'Skill revision changed.');
    },
    apply: async tx => {
      await tx.executeRaw('INSERT INTO bundle_projection_fixture(slug,revision,body) VALUES($1,$2::uuid,$3) ON CONFLICT(slug) DO UPDATE SET revision=excluded.revision,body=excluded.body', [name, revision, 'new instructions']);
      return { revision, name };
    },
  };
  return { admission, prepared, files, revision };
}

async function claim(f: typeof fixtures[number], admission: WriteAdmission) {
  const accepted = await admitWrite(f.engine, admission);
  const row = (await claimNextWrite(f.engine, hostId))!;
  expect(row.id).toBe(accepted.id);
  return row;
}

async function recoveryBytes(engine: BrainEngine) {
  const [counter] = await engine.executeRaw<{ bytes: string }>("SELECT recovery_bytes::text AS bytes FROM persistence_counters WHERE key='brain'");
  return Number(counter?.bytes ?? 0);
}

describe('typed skill bundle persistence', () => {
  test('seals a complete file set and durable replay without any page snapshot or page row', async () => {
    for (const f of fixtures) {
      const p = await prepare(f, 'complete');
      const row = await claim(f, p.admission);
      const forbidSnapshots = (engine: BrainEngine): BrainEngine => new Proxy(engine, { get(target, property) {
        if (property === 'readPageSnapshot' || property === 'lockPageKeys') return () => { throw new Error('skill target entered page pipeline'); };
        if (property === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) => target.transaction(tx => fn(forbidSnapshots(tx)));
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const done = await publishMutation(forbidSnapshots(f.engine), row, p.prepared, hostId);
      expect(done.state).toBe('committed'); expect(done.outcome?.revision).toBe(p.revision);
      expect(readFileSync(p.files[0].path, 'utf8')).toBe('new instructions');
      expect(readFileSync(p.files[1].path, 'utf8')).toBe('new helper');
      expect(existsSync(p.files[2].path)).toBe(false);
      expect(statSync(p.files[0].path).mode & 0o777).toBe(0o640);
      expect((await f.engine.executeRaw('SELECT id FROM pages WHERE source_id=$1', [sourceId])).length).toBe(0);
      expect(await recoveryBytes(f.engine)).toBe(0);
      await compactWriteReceipts(f.engine, 0);
      const replay = await admitWrite(f.engine, p.admission);
      expect(replay.id).toBe(row.id); expect(replay.outcome).toEqual(done.outcome); expect(replay.compacted).toBe(true);
      await expect(admitWrite(f.engine, { ...p.admission, callerIntent: { changed: true } })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    }
  });

  test('a database failure restores all additions, replacements, removals and modes', async () => {
    for (const f of fixtures) {
      const p = await prepare(f, 'rollback');
      p.prepared.apply = async () => { throw new Error('fixture SQL failure'); };
      const done = await publishMutation(f.engine, await claim(f, p.admission), p.prepared, hostId);
      expect(done.state).toBe('failed');
      expect(readFileSync(p.files[0].path, 'utf8')).toBe('old instructions');
      expect(existsSync(p.files[1].path)).toBe(false);
      expect(readFileSync(p.files[2].path, 'utf8')).toBe('obsolete');
      expect(statSync(p.files[2].path).mode & 0o777).toBe(0o600);
      expect(await recoveryBytes(f.engine)).toBe(0);
    }
  });

  test('preflights every recovery file before restoring any and preserves unexpected human bytes', async () => {
    for (const f of fixtures) {
      const p = await prepare(f, 'human-edit');
      const row = await claim(f, p.admission);
      const done = await publishMutation(f.engine, row, p.prepared, hostId, { boundary: async name => {
        if (name === 'after_publication') { writeFileSync(p.files[2].path, 'human bytes'); throw new Error('fixture failed transaction'); }
      } });
      expect(done.state).toBe('recovering'); expect(done.blocked_reason).toBe('unexpected_file_bytes');
      expect(readFileSync(p.files[0].path, 'utf8')).toBe('new instructions');
      expect(readFileSync(p.files[2].path, 'utf8')).toBe('human bytes');
      expect(await recoveryBytes(f.engine)).toBeGreaterThan(0);
      expect(await claimNextWrite(f.engine, hostId)).toBeNull();
      rmSync(p.files[2].path);
      expect((await recoverPublication(f.engine, row.id, hostId)).state).toBe('failed');
      expect(readFileSync(p.files[0].path, 'utf8')).toBe('old instructions');
      expect(await recoveryBytes(f.engine)).toBe(0);
    }
  });

  test('committed receipts never restore old canonical bytes after a lost response', async () => {
    for (const f of fixtures) {
      const p = await prepare(f, 'lost-response');
      const row = await claim(f, p.admission);
      const done = await publishMutation(f.engine, row, p.prepared, hostId, { boundary: async name => {
        if (name === 'after_commit') throw new Error('fixture lost response');
      } });
      expect(done.state).toBe('committed'); expect(done.outcome?.revision).toBe(p.revision);
      expect(readFileSync(p.files[0].path, 'utf8')).toBe('new instructions');
      expect((await admitWrite(f.engine, p.admission)).outcome).toEqual(done.outcome);
      expect(await recoveryBytes(f.engine)).toBe(0);
    }
  });

  test('CAS losers and whole-set invalid inputs have no file effects', async () => {
    for (const f of fixtures) for (const failure of ['cas', 'duplicate', 'large', 'symlink', 'hardlink', 'hash', 'quota', 'unicode', 'surrogate', 'escape']) {
      const p = await prepare(f, `invalid-${failure}`);
      if (failure === 'cas') p.prepared.validate = async () => { throw new OperationError('revision_conflict', 'Fixture CAS lost.'); };
      if (failure === 'duplicate') p.prepared.files!.push({ ...p.files[0], path: p.files[0].path.toUpperCase() });
      if (failure === 'large') p.files[1].content = 'x'.repeat(BUNDLE_FILE_LIMITS.fileBytes + 1);
      if (failure === 'symlink') symlinkSync(p.files[0].path, p.files[1].path);
      if (failure === 'hardlink') linkSync(p.files[0].path, p.files[1].path);
      if (failure === 'hash') p.files[2].expectedBeforeHash = null;
      if (failure === 'unicode') p.files[1].path = join(f.root, 'e\u0301.txt');
      if (failure === 'surrogate') p.files[1].path = `${f.root}/\ud800.txt`;
      if (failure === 'escape') p.files[1].path = join(f.root, '..', 'outside.txt');
      if (failure === 'quota') await f.engine.setConfig('persistence.limits.worktree_recovery_bytes', '1024');
      const done = await publishMutation(f.engine, await claim(f, p.admission), p.prepared, hostId);
      if (failure === 'quota') await f.engine.setConfig('persistence.limits.worktree_recovery_bytes', String(256 * 1024 ** 2));
      expect({ case: failure, state: done.state }).toMatchObject({ case: failure, state: expect.stringMatching(/^(conflict|failed)$/) });
      expect(readFileSync(p.files[0].path, 'utf8')).toBe('old instructions');
      expect(readFileSync(p.files[2].path, 'utf8')).toBe('obsolete');
      expect(await recoveryBytes(f.engine)).toBe(0);
    }
  });

  test('database denies old protocol claims and recovery updates before changing the durable row', async () => {
    for (const f of fixtures) {
      const p = await prepare(f, 'old-writer');
      const accepted = await admitWrite(f.engine, p.admission);
      await expect(f.engine.executeRaw("UPDATE persistence_requests SET state='running',execution_token=gen_random_uuid() WHERE id=$1::uuid", [accepted.id])).rejects.toThrow('writer_upgrade_required');
      expect((await getWriteRequestById(f.engine, accepted.id))?.state).toBe('queued');
      await expect(f.engine.executeRaw('UPDATE persistence_brain SET writer_protocol_floor=1 WHERE singleton=1')).rejects.toThrow('cannot be lowered');
      const row = (await claimNextWrite(f.engine, hostId))!;
      await expect(preparePersistedMutation(f.engine, { ...row, operation: 'future_unknown_mutation' }, { engine: f.engine.kind })).rejects.toMatchObject({ code: 'unsupported_mutation_protocol' });
      const done = await publishMutation(f.engine, row, p.prepared, hostId, { boundary: async name => {
        if (name === 'prepared') await expect(f.engine.executeRaw("UPDATE persistence_requests SET state='recovering' WHERE id=$1::uuid", [row.id])).rejects.toThrow('writer_upgrade_required');
      } });
      expect(done.state).toBe('committed');
      await f.engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw(`INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation,worktree_id)
          VALUES($1::uuid,'git','{}',$2,$3::uuid,$4::uuid)`, [row.id, sourceId, f.binding.source_incarnation, f.binding.worktree_id]);
      });
      await expect(f.engine.executeRaw("UPDATE persistence_effects SET state='running',execution_token=gen_random_uuid() WHERE request_id=$1::uuid", [row.id])).rejects.toThrow('writer_upgrade_required');
      const effect = (await claimPersistenceEffect(f.engine, hostId))!;
      expect(effect.request_id).toBe(row.id);
      await completeEffect(f.engine, effect);
      await expect(f.engine.executeRaw("SELECT gbrain_require_persistence_protocol(2)")).rejects.toThrow('writer_upgrade_required');
      await f.engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw('SELECT gbrain_require_persistence_protocol(2)'); });
    }
  });

  test('embedding claim renewal and cursor advancement retain protocol-2 fencing', async () => {
    for (const f of fixtures) {
      const p = await prepare(f, 'embedding-protocol');
      const row = await claim(f, p.admission);
      expect((await publishMutation(f.engine, row, p.prepared, hostId)).state).toBe('committed');
      await f.engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw(`INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation,worktree_id)
          VALUES($1::uuid,'embedding','{"source_scan":true}',$2,$3::uuid,$4::uuid)`,
        [row.id, sourceId, f.binding.source_incarnation, f.binding.worktree_id]);
      });
      const effect = (await claimPersistenceEffect(f.engine, hostId))!;
      expect(effect.request_id).toBe(row.id);
      await expect(f.engine.executeRaw('UPDATE persistence_effects SET updated_at=now() WHERE id=$1', [effect.id]))
        .rejects.toThrow('writer_upgrade_required');
      await f.engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw("UPDATE persistence_effects SET claim_expires_at=now()-interval '1 second' WHERE id=$1", [effect.id]);
      });
      const direct = { executeRaw: f.engine.executeRawDirect.bind(f.engine) };
      expect(await renewPersistenceEffectClaim(direct, { ...effect, execution_token: randomUUID() })).toBe(false);
      expect(await renewPersistenceEffectClaim(direct, effect)).toBe(true);
      expect(await f.engine.executeRaw("SELECT claim_expires_at>now()+interval '1 minute' AS renewed FROM persistence_effects WHERE id=$1", [effect.id]))
        .toEqual([{ renewed: true }]);
      await expect(f.engine.executeRaw('SELECT gbrain_require_persistence_protocol(2)')).rejects.toThrow('writer_upgrade_required');
      await advanceEffectCursor(f.engine, effect, 'notes/next');
      expect(await f.engine.executeRaw('SELECT state,execution_token,data FROM persistence_effects WHERE id=$1', [effect.id]))
        .toEqual([{ state: 'queued', execution_token: null, data: { source_scan: true, after_slug: 'notes/next', embedding_attempt_base: effect.attempts } }]);
      expect(await renewPersistenceEffectClaim(direct, effect)).toBe(false);
      const next = (await claimPersistenceEffect(f.engine, hostId))!;
      expect(next.execution_token).not.toBe(effect.execution_token);
      expect(await renewPersistenceEffectClaim(direct, effect)).toBe(false);
      expect(await renewPersistenceEffectClaim(direct, next)).toBe(true);
      await completeEffect(f.engine, next);
      await expect(f.engine.executeRaw('SELECT gbrain_require_persistence_protocol(2)')).rejects.toThrow('writer_upgrade_required');
    }
  });

  test('canonical SQL guards require protocol and both original and destination source capabilities', async () => {
    for (const f of fixtures) {
      const query = `INSERT INTO shared_skill_heads(source_id,source_incarnation,pack_id,name,revision,metadata,policy_epoch)
        VALUES($1,$2::uuid,'example-pack','guarded-example',$3::uuid,'{}','example-policy')`;
      const params = [sourceId, f.binding.source_incarnation, randomUUID()];
      await expect(f.engine.executeRaw(query, params)).rejects.toThrow('writer_upgrade_required');
      await expect(f.engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw(query, params); })).rejects.toThrow('writer_coordinator_required');
      await f.engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(query, params));
      });
      await expect(f.engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await withCoordinatedWrite(tx, ['default'], () => tx.executeRaw("DELETE FROM shared_skill_heads WHERE name='guarded-example'"));
      })).rejects.toThrow('writer_coordinator_required');
      await expect(f.engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw("UPDATE shared_skill_heads SET source_id='default' WHERE name='guarded-example'"));
      })).rejects.toThrow('writer_coordinator_required');
      const [head] = await f.engine.executeRaw<{ source_id: string }>("SELECT source_id FROM shared_skill_heads WHERE name='guarded-example'");
      expect(head.source_id).toBe(sourceId);
    }
  });

  test('activation refuses an occupied native root, queued work, and an unverified remote owner', async () => {
    for (const f of fixtures) {
      const lock = (await acquireWorktree(f.binding))!;
      expect(lock).not.toBeNull();
      try { await expect(activateSharedSkillPersistence(f.engine, { confirmQuiesced: true })).rejects.toMatchObject({ code: 'writer_not_quiesced' }); }
      finally { await lock.release(); }
      const p = await prepare(f, 'activation-pending');
      const row = await admitWrite(f.engine, p.admission);
      await expect(activateSharedSkillPersistence(f.engine, { confirmQuiesced: true })).rejects.toMatchObject({ code: 'writer_not_quiesced' });
      expect((await getWriteRequestById(f.engine, row.id))?.state).toBe('queued');
      await cancelWriteRequest(f.engine, p.admission.principal, row.request_id);
      await f.engine.executeRaw('UPDATE persistence_writer_protocols SET owner_epoch=owner_epoch+1 WHERE worktree_id=$1::uuid', [f.binding.worktree_id]);
      try { await expect(admitWrite(f.engine, { ...p.admission, requestId: randomUUID() })).rejects.toMatchObject({ code: 'writer_not_quiesced' }); }
      finally { await f.engine.executeRaw('UPDATE persistence_writer_protocols SET owner_epoch=$2 WHERE worktree_id=$1::uuid', [f.binding.worktree_id, f.binding.owner_epoch]); }
      await f.engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$2::uuid WHERE id=$1::uuid', [f.binding.worktree_id, randomUUID()]);
      try { await expect(activateSharedSkillPersistence(f.engine, { confirmQuiesced: true })).rejects.toMatchObject({ code: 'writer_not_quiesced' }); }
      finally { await f.engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$2::uuid WHERE id=$1::uuid', [f.binding.worktree_id, hostId]); }
      expect((await activateSharedSkillPersistence(f.engine, { confirmQuiesced: true })).activated).toBe(true);
    }
  });

  test('new protocol consumers recover unchanged version-one page records after the floor is raised', async () => {
    for (const f of fixtures) {
      const p = await prepare(f, 'legacy-page-recovery');
      const admission = { ...p.admission, operation: 'put_page', targetKind: undefined, protocolVersion: undefined };
      const row = await claim(f, admission);
      const record = { version: 1 as const, path: p.files[0].path, root: f.root, before: Buffer.from('old instructions').toString('base64'),
        beforeHash: sha256('old instructions'), afterHash: sha256('new instructions'), mode: 0o640,
        ownerEpoch: String(f.binding.owner_epoch), attempt: row.execution_token! };
      await prepareRecovery(f.engine, row, record, 8192);
      writeFileSync(record.path, 'new instructions');
      const recovered = await recoverPublication(f.engine, row.id, hostId);
      expect(recovered.state).toBe('queued'); expect(recovered.recovery).toBeNull();
      expect(readFileSync(record.path, 'utf8')).toBe('old instructions');
      expect(statSync(record.path).mode & 0o777).toBe(0o640);
      expect(await recoveryBytes(f.engine)).toBe(0);
      await cancelWriteRequest(f.engine, admission.principal, row.request_id);
    }
  });

  test('managed sync rechecks its frozen physical path when a pack is adopted after preparation', async () => {
    for (const f of fixtures) {
      const body = 'A synthetic source observation that remains knowledge data.\n';
      const manifest = { name: 'race-example-pack', brain_resident: true, skills: ['skills/late-adoption'] };
      const packBytes = JSON.stringify(manifest);
      writeFileSync(join(f.root, 'skillpack.json'), packBytes);
      const authority = await managedSyncAuthority(f.engine, sourceId, f.binding.source_incarnation, f.root);
      const prepareImport = async (name: string) => {
        const path = `skills/${name}/SKILL.md`;
        const sourcePath = `content/${path}`;
        const slug = `content/skills/${name}/skill`;
        mkdirSync(join(f.root, 'skills', name), { recursive: true });
        writeFileSync(join(f.root, path), body);
        const intent: SyncIntent = { kind: 'managed_sync_import', expected_revision: null, sourcePath, path,
          processingOptions: { noEmbed: true, noExtract: true, noSchemaPack: true },
          rawHash: sha256(body), content: body, ownerEpoch: String(f.binding.owner_epoch), syncAuthority: authority,
          cursorKey: 'example-frozen-sync', runId: randomUUID(), index: 0, total: 1, from: null,
          target: execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), slugMode: 'git-root' };
        const admission: WriteAdmission = { principal: authority.writer.principal, operation: 'submit_job', sourceId,
          sourceIncarnation: f.binding.source_incarnation, slug, worktreeId: f.binding.worktree_id,
          topologyGeneration: f.binding.topology_generation, authority: authority.writer, requestId: randomUUID(), callerIntent: intent, intent };
        const row = await claim(f, admission);
        const prepared = await prepareManagedSyncMutation(f.engine, row, { engine: f.engine.kind });
        expect(prepared.file).toBeUndefined();
        return { row, prepared, path, slug };
      };
      const control = await prepareImport('data-only-control');
      expect((await publishMutation(f.engine, control.row, control.prepared, hostId)).state).toBe('committed');
      expect((await f.engine.getPage(control.slug, { sourceId }))?.compiled_truth).toContain('remains knowledge data');
      expect(await f.engine.executeRaw('SELECT source_id FROM shared_skill_packs WHERE source_id=$1', [sourceId])).toEqual([]);

      const pending = await prepareImport('late-adoption');
      await f.engine.transaction(async tx => { await pending.prepared.validate!(tx); });
      const revision = randomUUID();
      await f.engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await withCoordinatedWrite(tx, [sourceId], async () => {
          await tx.executeRaw(`INSERT INTO shared_skill_packs(source_id,source_incarnation,pack_id,revision,manifest,manifest_hash)
            VALUES($1,$2::uuid,'race-example-pack',$3::uuid,$4::text::jsonb,$5)`,
          [sourceId, f.binding.source_incarnation, revision, packBytes, sha256(packBytes)]);
        });
      });
      const canonical = { bytes: readFileSync(join(f.root, pending.path), 'base64'), manifest: readFileSync(join(f.root, 'skillpack.json'), 'base64'),
        packs: await f.engine.executeRaw('SELECT * FROM shared_skill_packs ORDER BY source_id'),
        heads: await f.engine.executeRaw('SELECT * FROM shared_skill_heads ORDER BY source_id,name'),
        revisions: await f.engine.executeRaw('SELECT * FROM shared_skill_revisions ORDER BY source_id,name,revision') };
      await expect(f.engine.transaction(async tx => { await pending.prepared.validate!(tx); })).rejects.toMatchObject({ code: 'skill_bundle_required' });
      const done = await publishMutation(f.engine, pending.row, pending.prepared, hostId);
      expect(done).toMatchObject({ state: 'failed', error_code: 'skill_bundle_required', recovery: null });
      expect(await f.engine.getPage(pending.slug, { sourceId })).toBeNull();
      expect({ bytes: readFileSync(join(f.root, pending.path), 'base64'), manifest: readFileSync(join(f.root, 'skillpack.json'), 'base64'),
        packs: await f.engine.executeRaw('SELECT * FROM shared_skill_packs ORDER BY source_id'),
        heads: await f.engine.executeRaw('SELECT * FROM shared_skill_heads ORDER BY source_id,name'),
        revisions: await f.engine.executeRaw('SELECT * FROM shared_skill_revisions ORDER BY source_id,name,revision') }).toEqual(canonical);
    }
  });
});
