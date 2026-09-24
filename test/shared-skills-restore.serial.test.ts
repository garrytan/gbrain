import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { createPgliteBackup, restorePgliteBackup } from '../src/core/backup/snapshot.ts';
import { hashFile } from '../src/core/backup/archive.ts';
import { writeInstallReceipt } from '../src/core/agent-install/state.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { registerLocalWriter, verifyLocalWriter, type LocalRegistration } from '../src/core/persistence/identity.ts';
import { normalizeSkillFiles, skillMetadata } from '../src/core/shared-skills/manifest.ts';
import { getSharedSkill, listSharedSkills } from '../src/core/shared-skills/catalog.ts';
import { joinBrain, leaveBrain, syncBrain } from '../src/core/shared-skills/membership.ts';
import { setSharedSkillPolicy } from '../src/core/shared-skills/policy.ts';
import { quarantineSharedSkillRestore } from '../src/core/shared-skills/restore.ts';
import type { MembershipSnapshot } from '../src/core/shared-skills/membership-types.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { hashToken } from '../src/core/utils.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';

let temporary: string, root: string, archive: string, restored: string, incarnation: string;
let oldIdentity: { brain_id: string; serving_epoch: string; token_secret: string };
let oldContext: OperationContext, member: MembershipSnapshot, oldCursor: string, oldKey: string;
let localRegistration: LocalRegistration;
let legacyBearer: string;
let originalRows: Record<string, unknown>[], originalArchiveHash: string;
const bearer = 'synthetic-restore-bearer';
const policy = { version: 1 as const, enabled: true, allow_follow: true, classes: ['prose' as const], audiences: ['readers'], requirements: [] };
const operations = ['list_skills', 'get_skill', 'get_skill_asset', 'join_brain', 'sync_brain_skills', 'leave_brain'];
const body = '# Example\nCanonical skill content, never executed.\n';
const recoveryOptions = { mode: 'recovery' as const, confirmQuiesced: true, confirmBackupCompatible: true, confirmAuthorityReviewed: true };

async function withBrain<T>(at: string, fn: (engine: PGLiteEngine) => Promise<T>): Promise<T> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: join(at, '.gbrain', 'brain.pglite') });
  try { return await fn(engine); } finally { await engine.disconnect(); }
}
function local(engine: PGLiteEngine): OperationContext {
  return { engine, remote: false, sourceId: 'default', dryRun: false, config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {} } };
}
function provider(engine: PGLiteEngine) {
  return new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
}
async function identity(engine: PGLiteEngine) {
  return (await engine.executeRaw<typeof oldIdentity>('SELECT b.brain_id,s.serving_epoch,s.token_secret FROM persistence_brain b CROSS JOIN shared_skill_state s'))[0];
}
async function authorityRows(engine: PGLiteEngine) {
  return engine.executeRaw(`SELECT jsonb_build_object('brain',(SELECT to_jsonb(b) FROM persistence_brain b),
    'members',(SELECT jsonb_agg(m) FROM shared_skill_members m),'owners',(SELECT jsonb_agg(w) FROM persistence_worktrees w),
    'clients',(SELECT jsonb_agg(c) FROM oauth_clients c),'state',(SELECT to_jsonb(s) FROM shared_skill_state s),
    'requests',(SELECT jsonb_agg(r) FROM persistence_requests r),'effects',(SELECT jsonb_agg(e) FROM persistence_effects e)) AS value`);
}

beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), 'gbrain-shared-restore-'));
  root = join(temporary, 'original'); restored = join(temporary, 'restored'); archive = join(temporary, 'original.gbrain-backup');
  mkdirSync(join(root, '.gbrain'), { recursive: true });
  mkdirSync(join(root, 'memory'));
  writeFileSync(join(root, 'memory', 'note.md'), '# Private memory\nPreserve this source.\n');
  writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(root, '.gbrain', 'brain.pglite'), mcp: { publish_skills: true } }));
  writeInstallReceipt({ format_version: 1, installation_id: randomUUID(), root, harness: 'grok-bot', source_id: 'default',
    database_path: join(root, '.gbrain', 'brain.pglite'), state: 'ready', initialized: true, adopted: false, managed_paths: ['memory'],
    owned_files: {}, native: { skill_id: 'old-native-id', routine_id: 'old-routine', verification: 'unverified' },
    search_mode_confirmation_required: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  await withBrain(root, async engine => {
    await engine.initSchema();
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [join(root, 'memory')]);
    await engine.executeRaw("INSERT INTO facts(fact,source,source_id) VALUES('Private fixture fact','fixture','default')");
    const binding = await claimWorktree(engine, 'default', join(root, 'memory'));
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    localRegistration = await registerLocalWriter(engine, 'cli');
    await engine.setConfig('mcp.publish_skills', 'true');
    ({ incarnation } = (await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'"))[0]);
    const { policy_epoch } = await setSharedSkillPolicy(local(engine), 'default', policy, null);
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw("SELECT set_config('gbrain.write_sources','[\"default\"]',true)");
      for (const name of ['alpha', 'beta', 'private']) {
        mkdirSync(join(root, 'memory', 'skills', name), { recursive: true });
        writeFileSync(join(root, 'memory', 'skills', name, 'SKILL.md'), body);
        const files = normalizeSkillFiles(name, [{ path: `skills/${name}/SKILL.md`, content: body, file_class: 'prose', audience: ['readers'] }]);
        const metadata = skillMetadata(name, files, { private: name === 'private' });
        const revision = randomUUID();
        await tx.executeRaw(`INSERT INTO shared_skill_heads(source_id,source_incarnation,pack_id,name,revision,metadata,policy_epoch)
          VALUES('default',$1::uuid,'example',$2,$3::uuid,$4::text::jsonb,$5)`, [incarnation, name, revision, JSON.stringify(metadata), policy_epoch]);
        await tx.executeRaw(`INSERT INTO shared_skill_revisions(source_id,source_incarnation,pack_id,name,revision,metadata,files,policy_epoch,request_id)
          VALUES('default',$1::uuid,'example',$2,$3::uuid,$4::text::jsonb,$5::text::jsonb,$6,$7::uuid)`, [incarnation, name, revision, JSON.stringify(metadata), JSON.stringify(files), policy_epoch, randomUUID()]);
      }
    });
    const registered = await provider(engine).registerClientManual('restore-example', ['client_credentials'], 'read skills_member_self', [], 'default');
    await engine.executeRaw('UPDATE oauth_clients SET allowed_operations=$2::text[] WHERE client_id=$1', [registered.clientId, operations]);
    await engine.executeRaw("INSERT INTO oauth_tokens(token_hash,token_type,client_id,scopes,expires_at) VALUES($1,'access',$2,$3::text[],$4)", [hashToken(bearer), registered.clientId, ['read', 'skills_member_self'], Math.floor(Date.now() / 1000) + 3600]);
    oldContext = { ...local(engine), remote: true, auth: { token: bearer, principal: { kind: 'oauth_client', id: registered.clientId },
      clientId: registered.clientId, scopes: ['read', 'skills_member_self'], issuedScopes: ['read', 'skills_member_self'], allowedOperations: operations, sourceId: 'default', allowedSources: ['default'] } };
    member = await joinBrain(oldContext, { adapter: 'codex', follow_policy: { approved: true } });
    const list = await listSharedSkills(local(engine), { limit: 1 }); oldCursor = list.next_cursor!; oldKey = list.skills[0].qualified_id;
    expect(oldCursor).toBeDefined();
    expect((await provider(engine).verifyAccessToken(bearer)).clientId).toBe(registered.clientId);
    legacyBearer = (await mintLegacyToken(engine, { name: 'restore-legacy-example', scopes: ['read'], takesHolders: [], sourceGrant: ['default'] })).token;
    expect((await provider(engine).verifyAccessToken(legacyBearer)).scopes).toContain('read');
    oldIdentity = await identity(engine);
    const principal = { kind: 'local_cli' as const, id: localRegistration.id };
    for (const target of ['page', 'skill_bundle'] as const) {
      const request = await admitWrite(engine, { principal, operation: target === 'page' ? 'put_page' : 'put_skill',
        targetKind: target, protocolVersion: target === 'page' ? 1 : 2, sourceId: 'default', sourceIncarnation: incarnation,
        worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation, slug: 'pending-example', callerIntent: {}, intent: { private: 'preserved pending intent' },
        authority: { version: 1, principal, remote: false, sourceId: 'default', sourceIncarnation: incarnation, scopes: ['read', 'write', 'skill_editor'], operations: null, slugPrefixes: null } });
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw("INSERT INTO persistence_effects(request_id,kind,data,state,execution_token) VALUES($1::uuid,'embedding','{}'::jsonb,'running',$2::uuid)", [request.id, randomUUID()]);
      });
    }
  });
  await createPgliteBackup({ root, output: archive });
  originalArchiveHash = hashFile(archive).sha256;
  await withBrain(root, async engine => {
    await leaveBrain({ ...oldContext, engine }, { installation_id: member.installation_id, enrollment_epoch: member.enrollment_epoch });
    await engine.executeRaw('UPDATE oauth_clients SET deleted_at=now()');
    originalRows = await authorityRows(engine);
  });
}, 120_000);

afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

test('full stale backup restores content as a new unpublished brain without resurrecting authority', async () => {
  const originalMarkers = ['.gbrain-owner.json', '.gbrain-managed'].map(name => readFileSync(join(root, 'memory', name)));
  const result = await restorePgliteBackup({ archive, into: restored });
  expect(['.gbrain-owner.json', '.gbrain-managed'].map(name => readFileSync(join(root, 'memory', name)))).toEqual(originalMarkers);
  expect(result.reconnect_required.some(value => value.includes('new independent brain'))).toBe(true);
  expect(readFileSync(join(restored, 'memory', 'note.md'), 'utf8')).toBe(readFileSync(join(root, 'memory', 'note.md'), 'utf8'));
  for (const name of ['alpha', 'beta', 'private']) expect(readFileSync(join(restored, 'memory', 'skills', name, 'SKILL.md'), 'utf8')).toBe(body);
  expect(existsSync(join(restored, 'memory', '.gbrain-owner.json'))).toBe(false);
  expect(existsSync(join(restored, '.gbrain', 'restore-ownership', 'memory', '.gbrain-owner.json'))).toBe(true);
  expect(existsSync(join(restored, 'bin', 'gbrain'))).toBe(false);
  const receipt = JSON.parse(readFileSync(join(restored, 'restore-receipt.json'), 'utf8'));
  expect(receipt.shared_skills.mode).toBe('new_brain'); expect(receipt.launcher_ready).toBe(false);
  const installed = JSON.parse(readFileSync(join(restored, '.gbrain', 'agent-install', 'receipt.json'), 'utf8'));
  expect(installed.state).toBe('installing'); expect(installed.native.skill_id).not.toBe('old-native-id');
  await withBrain(restored, async engine => {
    const current = await identity(engine);
    expect(current.brain_id).not.toBe(oldIdentity.brain_id);
    expect(current.serving_epoch).not.toBe(oldIdentity.serving_epoch);
    expect(current.token_secret === oldIdentity.token_secret).toBe(false);
    const [state] = await engine.executeRaw<{ writer_protocol_floor: number; skill_bundles_enabled: boolean; enabled: boolean }>('SELECT writer_protocol_floor,skill_bundles_enabled,enabled FROM persistence_brain');
    expect(state).toEqual({ writer_protocol_floor: 2, skill_bundles_enabled: false, enabled: true });
    expect((await engine.executeRaw('SELECT * FROM persistence_host_bindings')).length).toBe(0);
    expect((await engine.executeRaw('SELECT * FROM persistence_source_bindings')).length).toBe(0);
    expect((await engine.executeRaw('SELECT * FROM persistence_writer_protocols')).length).toBe(0);
    expect((await engine.executeRaw("SELECT * FROM facts WHERE fact='Private fixture fact'")).length).toBe(1);
    const revisions = await engine.executeRaw<{ files: Array<{ content: string }> }>('SELECT files FROM shared_skill_revisions');
    expect(revisions).toHaveLength(3);
    expect(revisions.every(row => Buffer.from(row.files[0].content, 'base64').toString() === body)).toBe(true);
    expect((await engine.executeRaw('SELECT * FROM shared_skill_policy_audit')).length).toBeGreaterThan(0);
    expect((await listSharedSkills(local(engine))).skills).toEqual([]);
    await expect(provider(engine).verifyAccessToken(bearer)).rejects.toThrow();
    await expect(provider(engine).verifyAccessToken(legacyBearer)).rejects.toThrow();
    await expect(verifyLocalWriter(engine, localRegistration)).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(syncBrain({ ...oldContext, engine }, { installation_id: member.installation_id, enrollment_epoch: member.enrollment_epoch })).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(listSharedSkills(local(engine), { limit: 1, cursor: oldCursor })).rejects.toMatchObject({ code: 'full_resync_required' });
    await expect(getSharedSkill(local(engine), { qualified_id: oldKey })).rejects.toThrow();
    expect((await engine.executeRaw('SELECT * FROM shared_skill_revision_leases WHERE expires_at>now()')).length).toBe(0);
    expect((await engine.executeRaw('SELECT * FROM shared_skill_delivery_batches')).length).toBeGreaterThan(0);
    expect((await engine.executeRaw("SELECT * FROM persistence_requests WHERE state='cancelled' AND intent->>'private'='preserved pending intent'")).length).toBe(2);
    expect((await engine.executeRaw("SELECT * FROM persistence_effects WHERE state='failed' AND execution_token IS NULL AND error_code='restore_new_brain'")).length).toBe(2);
    expect((await engine.executeRaw('SELECT * FROM persistence_counters WHERE outstanding_count<>0 OR intent_bytes<>0')).length).toBe(0);
    await engine.executeRaw('UPDATE oauth_clients SET deleted_at=NULL');
    await expect(syncBrain({ ...oldContext, engine }, { installation_id: member.installation_id, enrollment_epoch: member.enrollment_epoch,
      acknowledgment: { batch_token: member.batch_token, view_token: member.view_token, evidence: { stage: 'installed', revisions: member.skills } } })).rejects.toMatchObject({ code: 'membership_inactive' });
    await engine.executeRaw('UPDATE oauth_clients SET deleted_at=now()');
    await expect(engine.executeRaw('UPDATE persistence_brain SET writer_protocol_floor=1')).rejects.toThrow('cannot be lowered');
    await expect(engine.executeRaw("UPDATE shared_skill_heads SET deleted=true")).rejects.toThrow('writer_upgrade_required');
    await expect(engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw('UPDATE shared_skill_heads SET deleted=true'); })).rejects.toThrow('publication is disabled');
    await expect(engine.executeRaw("UPDATE sources SET local_path='/wrong' WHERE id='default'")).rejects.toThrow('writer_coordinator_required');
  });
  expect(hashFile(archive).sha256).toBe(originalArchiveHash);
  await withBrain(root, async engine => {
    expect(await authorityRows(engine)).toEqual(originalRows);
    expect((await provider(engine).verifyAccessToken(legacyBearer)).scopes).toContain('read');
    expect((await verifyLocalWriter(engine, localRegistration)).principal.id).toBe(localRegistration.id);
  });
}, 120_000);

test('independent replay gets another identity and refuses an existing destination', async () => {
  await expect(restorePgliteBackup({ archive, into: restored })).rejects.toMatchObject({ code: 'restore_target_exists' });
  const second = join(temporary, 'second');
  await restorePgliteBackup({ archive, into: second });
  const firstIdentity = await withBrain(restored, identity);
  await withBrain(second, async engine => {
    expect((await identity(engine)).brain_id).not.toBe(firstIdentity.brain_id);
    expect((await engine.executeRaw('SELECT * FROM shared_skill_members WHERE active')).length).toBe(0);
    await expect(claimWorktree(engine, 'default', join(second, 'memory'))).rejects.toMatchObject({ code: 'writer_registration_required' });
    await registerLocalWriter(engine, 'cli');
    await claimWorktree(engine, 'default', join(second, 'memory'));
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    const [policyRow] = await engine.executeRaw<{ epoch: string }>('SELECT epoch FROM shared_skill_policies');
    await setSharedSkillPolicy(local(engine), 'default', policy, policyRow.epoch);
    expect((await listSharedSkills(local(engine))).skills).toHaveLength(3);
    await expect(getSharedSkill(local(engine), { qualified_id: oldKey })).rejects.toThrow();
    await expect(listSharedSkills(local(engine), { limit: 1, cursor: oldCursor })).rejects.toMatchObject({ code: 'full_resync_required' });
    expect((await engine.executeRaw('SELECT * FROM persistence_host_bindings')).length).toBe(1);
  });
}, 120_000);

test('recovery requires every attestation and explicit mode before creating the destination', async () => {
  for (const missing of ['confirmQuiesced', 'confirmBackupCompatible', 'confirmAuthorityReviewed'] as const) {
    const into = join(temporary, `missing-${missing}`);
    await expect(restorePgliteBackup({ archive, into, ...recoveryOptions, [missing]: false })).rejects.toMatchObject({ code: 'restore_attestation_required' });
    expect(existsSync(into)).toBe(false);
  }
  const implicit = join(temporary, 'implicit-recovery');
  await expect(restorePgliteBackup({ archive, into: implicit, ...recoveryOptions, mode: undefined })).rejects.toMatchObject({ code: 'invalid_restore_mode' });
  expect(existsSync(implicit)).toBe(false);
});

test('explicit recovery CLI preserves brain identity but revokes old service authority', async () => {
  const into = join(temporary, 'recovered');
  const child = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, '..', 'src', 'cli.ts'), 'backup', 'restore', archive,
    '--into', into, '--mode', 'recovery', '--confirm-quiesced', '--confirm-backup-compatible', '--confirm-authority-reviewed', '--json'],
  { env: { ...process.env, GBRAIN_HOME: join(temporary, 'recovery-cli-home') }, stdout: 'pipe', stderr: 'pipe' });
  const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(`Recovery CLI failed: ${output} ${errors}`);
  const result = JSON.parse(output);
  expect(result.shared_skills).toMatchObject({ mode: 'recovery', brain_id: oldIdentity.brain_id,
    recovery_attestation: { old_service_quiesced: true, compatible_backup_reviewed: true, authority_reviewed: true,
      external_enforcement: 'operator_required_unverified' } });
  expect(result.reconnect_required.some((value: string) => value.includes('operator-required and unverified'))).toBe(true);
  const receipt = JSON.parse(readFileSync(join(into, 'restore-receipt.json'), 'utf8'));
  expect(receipt.shared_skills).toEqual(result.shared_skills);
  expect(receipt.launcher_ready).toBe(false);
  await withBrain(into, async engine => {
    const recovered = await identity(engine);
    expect(recovered.brain_id).toBe(oldIdentity.brain_id);
    expect(recovered.serving_epoch).not.toBe(oldIdentity.serving_epoch);
    expect(recovered.token_secret === oldIdentity.token_secret).toBe(false);
    await expect(provider(engine).verifyAccessToken(bearer)).rejects.toThrow();
    await expect(provider(engine).verifyAccessToken(legacyBearer)).rejects.toThrow();
    await expect(verifyLocalWriter(engine, localRegistration)).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(syncBrain({ ...oldContext, engine }, { installation_id: member.installation_id, enrollment_epoch: member.enrollment_epoch })).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(listSharedSkills(local(engine), { limit: 1, cursor: oldCursor })).rejects.toMatchObject({ code: 'full_resync_required' });
    expect((await engine.executeRaw('SELECT * FROM shared_skill_members WHERE active')).length).toBe(0);
    expect((await engine.executeRaw('SELECT * FROM shared_skill_revision_leases WHERE expires_at>now()')).length).toBe(0);
    expect((await engine.executeRaw('SELECT * FROM persistence_host_bindings')).length).toBe(0);
    expect((await engine.executeRaw('SELECT * FROM persistence_source_bindings')).length).toBe(0);
    expect(await engine.getConfig('mcp.publish_skills')).toBe('false');
    expect(await engine.executeRaw('SELECT writer_protocol_floor,skill_bundles_enabled FROM persistence_brain')).toEqual([{ writer_protocol_floor: 2, skill_bundles_enabled: false }]);
    expect((await engine.executeRaw('SELECT * FROM shared_skill_revisions')).length).toBe(3);
    expect((await engine.executeRaw("SELECT * FROM facts WHERE fact='Private fixture fact'")).length).toBe(1);
  });
  for (const name of ['alpha', 'beta', 'private']) expect(readFileSync(join(into, 'memory', 'skills', name, 'SKILL.md'), 'utf8')).toBe(body);
  expect(hashFile(archive).sha256).toBe(originalArchiveHash);
  await withBrain(root, async engine => { expect(await authorityRows(engine)).toEqual(originalRows); });
}, 120_000);

test('recovery attestations cannot bless a corrupt archive', async () => {
  const corrupt = join(temporary, 'corrupt-recovery.gbrain-backup'), into = join(temporary, 'corrupt-recovery');
  writeFileSync(corrupt, 'not a backup');
  await expect(restorePgliteBackup({ archive: corrupt, into, ...recoveryOptions })).rejects.toMatchObject({ code: 'invalid_backup' });
  expect(existsSync(join(into, '.gbrain', 'config.json'))).toBe(false);
  expect(JSON.parse(readFileSync(join(into, 'restore-receipt.json'), 'utf8'))).toMatchObject({ state: 'failed', mode: 'recovery', original_preserved: true });
});

test('recovery refuses missing operational authority metadata', async () => {
  await withBrain(restored, async engine => {
    const before = await authorityRows(engine);
    await expect(engine.transaction(async tx => {
      await tx.executeRaw('DROP TABLE shared_skill_state');
      await quarantineSharedSkillRestore(tx, randomUUID(), recoveryOptions);
    })).rejects.toMatchObject({ code: 'restore_recovery_unsupported' });
    expect(await authorityRows(engine)).toEqual(before);
  });
});

test('unresolved topology recovery refuses publication and retains a private failed stage', async () => {
  await withBrain(root, async engine => {
    await engine.executeRaw(`INSERT INTO persistence_topology_changes(principal_id,request_id,digest,operation,source_id,state,recovery)
      VALUES($1::uuid,$2::uuid,'fixture','rebind','default','recovering','{}'::jsonb)`, [randomUUID(), randomUUID()]);
  });
  const pending = join(temporary, 'pending.gbrain-backup'), target = join(temporary, 'failed');
  await createPgliteBackup({ root, output: pending });
  const originalMarkers = ['.gbrain-owner.json', '.gbrain-managed'].map(name => readFileSync(join(root, 'memory', name)));
  await expect(restorePgliteBackup({ archive: pending, into: target })).rejects.toMatchObject({ code: 'restore_recovery_required' });
  const recoveryTarget = join(temporary, 'failed-identity-recovery');
  await expect(restorePgliteBackup({ archive: pending, into: recoveryTarget, ...recoveryOptions })).rejects.toMatchObject({ code: 'restore_recovery_required' });
  expect(existsSync(join(recoveryTarget, '.gbrain', 'config.json'))).toBe(false);
  expect(['.gbrain-owner.json', '.gbrain-managed'].map(name => readFileSync(join(root, 'memory', name)))).toEqual(originalMarkers);
  expect(existsSync(join(target, '.gbrain', 'config.json'))).toBe(false);
  expect(JSON.parse(readFileSync(join(target, 'restore-receipt.json'), 'utf8')).state).toBe('failed');
  expect(readdirSync(target).some(name => name.startsWith('.restore-'))).toBe(true);
  await expect(restorePgliteBackup({ archive: pending, into: target })).rejects.toMatchObject({ code: 'restore_target_exists' });
  await withBrain(root, async engine => { expect(await authorityRows(engine)).toEqual(originalRows); });
}, 120_000);

test('a later restore transaction failure rolls back every identity and authority change', async () => {
  await withBrain(restored, async engine => {
    const before = await authorityRows(engine);
    await expect(engine.transaction(async tx => { await quarantineSharedSkillRestore(tx, randomUUID()); throw new Error('synthetic restore failure'); })).rejects.toThrow('synthetic restore failure');
    expect(await authorityRows(engine)).toEqual(before);
  });
});

test.each(['page', 'skill_bundle', 'effect'])('unresolved %s file recovery cannot cross the restore boundary', async kind => {
  await withBrain(restored, async engine => {
    const before = await authorityRows(engine);
    await expect(engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      if (kind === 'effect') await tx.executeRaw("UPDATE persistence_effects SET recovery='{\"version\":1}'::jsonb WHERE id=(SELECT MIN(id) FROM persistence_effects)");
      else await tx.executeRaw('UPDATE persistence_requests SET recovery=$1::text::jsonb WHERE target_kind=$2', [JSON.stringify(kind === 'page' ? { version: 1 } : { version: 2, target: 'skill_bundle', files: [] }), kind]);
      await quarantineSharedSkillRestore(tx, randomUUID());
    })).rejects.toMatchObject({ code: 'restore_recovery_required' });
    expect(await authorityRows(engine)).toEqual(before);
  });
});

test('external Postgres authority is never reset through the local restore helper', async () => {
  await expect(quarantineSharedSkillRestore({ kind: 'postgres' } as BrainEngine, randomUUID())).rejects.toMatchObject({ code: 'pglite_required' });
});
