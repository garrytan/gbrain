import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installSharedBrainBridge } from '../src/core/skillpack/shared-brain-bridge.ts';
import { createSharedSkillsAdapter, type SharedSkillsToolCaller } from '../src/core/shared-skills/adapter.ts';
import { registerLocalWriter, revokeLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { setSharedSkillPolicy } from '../src/core/shared-skills/policy.ts';
import { operationsByName } from '../src/core/operations.ts';
import { privateWrite, sha256 } from '../src/core/agent-install/state.ts';
import { withEnv } from './helpers/with-env.ts';
import type { GBrainConfig } from '../src/core/config.ts';

let root: string, engine: PGLiteEngine, config: GBrainConfig, brainId: string;
const env = () => ({ GBRAIN_HOME: root, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: 'default', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined });
const context = () => ({ engine, config, sourceId: 'default', remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } });
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-bridge-identity-'));
  config = { engine: 'pglite', database_path: join(root, '.gbrain', 'brain.pglite'), mcp: { publish_skills: true } };
  privateWrite(join(root, '.gbrain', 'config.json'), JSON.stringify(config));
  engine = new PGLiteEngine(); await engine.connect(config); await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('secondary','Secondary fixture')");
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx); await tx.executeRaw("SELECT set_config('gbrain.writer_quiesced','true',true)");
    await tx.executeRaw('UPDATE persistence_brain SET enabled=true,skill_bundles_enabled=true,writer_protocol_floor=2 WHERE singleton=1');
  });
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1'); brainId = brain.brain_id;
  await withEnv(env(), async () => {
    for (const source of ['default', 'secondary']) await setSharedSkillPolicy(context(), source,
      { version: 1, enabled: true, allow_follow: true, classes: ['prose'], audiences: ['readers'], requirements: [] });
  });
}, 120_000);
afterAll(async () => { await engine?.disconnect(); if (root) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  rmSync(join(root, '.gbrain', 'skillpack-shared'), { recursive: true, force: true });
  const registration = await registerLocalWriter(engine, 'cli', { sourceIds: ['default', 'secondary'], scopes: ['read', 'write'], operations: null, slugPrefixes: null }, true);
  const destination = join(root, 'native', randomUUID());
  const options = (name: string, policy: 'follow' | 'memory-only' = 'follow', harness = 'codex') => ({
    engine, config, harness, dest: join(destination, name), policy,
  });
  const metadataRoot = (name: string, source = 'default', harness = 'codex') => join(root, '.gbrain', 'skillpack-shared',
    sha256(JSON.stringify([brainId, source, harness, join(destination, name)])).slice(0, 32));
  const rows = () => engine.executeRaw('SELECT * FROM shared_skill_members WHERE principal_id=$1 ORDER BY adapter', [registration.id]);
  const call: SharedSkillsToolCaller = async <T>(name: string, params: Record<string, unknown>): Promise<T> =>
    withVerifiedLocalRegistration(engine, registration, async () => await operationsByName[name].handler(context(), params) as T);
  const legacyTarget = async (first: { launcher: string }, name: string) => {
    const target = metadataRoot(name), launcher = join(target, 'gbrain');
    const body = readFileSync(first.launcher, 'utf8');
    privateWrite(launcher, body, 0o700);
    privateWrite(join(target, 'installation.json'), JSON.stringify({ policy: 'follow', launcher_hash: sha256(body) }));
    return createSharedSkillsAdapter({ call, root: join(target, 'shared-skills'), adapter: 'codex', launcher,
      nativeSkillsDir: options(name).dest, connectionName: `bridge-${target.split('/').at(-1)}` }).join({ approved: true, source_ids: ['default'] });
  };
  return { registration, destination, options, metadataRoot, rows, call, legacyTarget,
    claim: (harness = 'codex') => `shared_skills.bridge_owner.v1.${registration.id}.${harness}` };
}

test('a second destination is refused before files or enrollment change and cannot disable the first', () => withEnv(env(), async () => {
  const f = await fixture();
  const first: any = await installSharedBrainBridge(f.options('first'));
  expect(first.status).toBe('restart_required');
  const before = await f.rows(), receipt = readFileSync(join(f.metadataRoot('first'), 'installation.json'), 'utf8');
  const native = readFileSync(first.native_router_path, 'utf8');
  const second = await installSharedBrainBridge(f.options('second'));
  expect(second?.reason).toBe('independent_principal_required');
  expect(second?.next_action).toContain('separate private-handoff principals');
  expect(existsSync(f.options('second').dest)).toBe(false);
  expect(existsSync(f.metadataRoot('second'))).toBe(false);
  expect(await f.rows()).toEqual(before);
  expect(readFileSync(join(f.metadataRoot('first'), 'installation.json'), 'utf8')).toBe(receipt);
  expect(readFileSync(first.native_router_path, 'utf8')).toBe(native);
  await installSharedBrainBridge(f.options('second', 'memory-only'));
  expect(await f.rows()).toEqual(before);
  const view: any = await f.call('sync_brain_skills', { installation_id: first.installation_id, enrollment_epoch: first.enrollment_epoch });
  expect(view.complete).toBe(true); expect(view.installation_id).toBe(first.installation_id);
}));

test('changing source or harness alias cannot bypass the same-principal target binding', () => withEnv(env(), async () => {
  const f = await fixture();
  const first: any = await installSharedBrainBridge(f.options('same'));
  const before = await f.rows();
  const otherSource = await withEnv({ GBRAIN_SOURCE: 'secondary' }, () => installSharedBrainBridge(f.options('same')));
  expect(otherSource?.reason).toBe('independent_principal_required');
  expect(existsSync(f.metadataRoot('same', 'secondary'))).toBe(false);
  expect(await f.rows()).toEqual(before);
  const canonical: any = await installSharedBrainBridge(f.options('claude-first', 'follow', 'claude-code'));
  expect(canonical.status).toBe('restart_required');
  const alias = await installSharedBrainBridge(f.options('claude-other', 'follow', 'claude'));
  expect(alias?.reason).toBe('independent_principal_required');
  expect(existsSync(f.metadataRoot('claude-other', 'default', 'claude-code'))).toBe(false);
  expect(existsSync(first.native_router_path)).toBe(true);
}));

test('concurrent independent targets elect one owner atomically without creating a loser receipt', () => withEnv(env(), async () => {
  const f = await fixture();
  const results: any[] = await Promise.all(['left', 'right'].map(name => installSharedBrainBridge(f.options(name))));
  expect(results.filter(result => result.status === 'restart_required')).toHaveLength(1);
  expect(results.filter(result => result.reason === 'independent_principal_required')).toHaveLength(1);
  const winner = results.findIndex(result => result.status === 'restart_required');
  expect(existsSync(f.metadataRoot(['left', 'right'][1 - winner]))).toBe(false);
  expect(await f.rows()).toHaveLength(1);
  const receipt = results[winner];
  const view: any = await f.call('sync_brain_skills', { installation_id: receipt.installation_id, enrollment_epoch: receipt.enrollment_epoch });
  expect(view.complete).toBe(true);
}));

test('same target retries and rejoins work but leaving never transfers the principal to a second target', () => withEnv(env(), async () => {
  const f = await fixture();
  const first: any = await installSharedBrainBridge(f.options('owner'));
  const retry: any = await installSharedBrainBridge(f.options('owner'));
  expect(retry.installation_id).toBe(first.installation_id); expect(retry.enrollment_epoch).toBe(first.enrollment_epoch);
  expect((await installSharedBrainBridge(f.options('owner', 'memory-only')))?.status).toBe('left');
  const before = await f.rows();
  expect((await installSharedBrainBridge(f.options('replacement')))?.reason).toBe('independent_principal_required');
  expect(await f.rows()).toEqual(before);
  const rejoined: any = await installSharedBrainBridge(f.options('owner'));
  expect(rejoined.status).toBe('restart_required'); expect(rejoined.installation_id).toBe(first.installation_id);
  expect(rejoined.enrollment_epoch).toBeGreaterThan(first.enrollment_epoch);
}));

test('edited retained native files keep their original binding until explicit owner repair', () => withEnv(env(), async () => {
  const f = await fixture();
  const first: any = await installSharedBrainBridge(f.options('owner'));
  const original = readFileSync(first.native_router_path, 'utf8');
  writeFileSync(first.native_router_path, 'Preserve these user edits');
  const left: any = await installSharedBrainBridge(f.options('owner', 'memory-only'));
  expect(left.status).toBe('left_with_retained_files'); expect(left.retained_files).toContain('native-router');
  const before = await f.rows();
  expect((await installSharedBrainBridge(f.options('replacement')))?.reason).toBe('independent_principal_required');
  expect(await f.rows()).toEqual(before);
  expect(readFileSync(first.native_router_path, 'utf8')).toBe('Preserve these user edits');
  writeFileSync(first.native_router_path, original);
  expect((await installSharedBrainBridge(f.options('owner')))?.status).toBe('restart_required');
}));

test('one legacy receipt is adopted only by its authenticated existing target', () => withEnv(env(), async () => {
  const f = await fixture();
  const first: any = await installSharedBrainBridge(f.options('legacy'));
  await engine.unsetConfig(f.claim());
  const before = await f.rows();
  expect((await installSharedBrainBridge(f.options('other')))?.reason).toBe('independent_principal_required');
  expect(await f.rows()).toEqual(before); expect(await engine.getConfig(f.claim())).toBeNull();
  const adopted: any = await installSharedBrainBridge(f.options('legacy'));
  expect(adopted.status).toBe('restart_required'); expect(adopted.installation_id).toBe(first.installation_id);
  expect(await engine.getConfig(f.claim())).not.toBeNull();
}));

test('duplicate legacy receipts allow only owned local cleanup while withholding shared server leave', () => withEnv(env(), async () => {
  const f = await fixture();
  const first: any = await installSharedBrainBridge(f.options('legacy-first'));
  const secondRoot = f.metadataRoot('legacy-second');
  const second = await f.legacyTarget(first, 'legacy-second');
  expect(second.installation_id).toBe(first.installation_id);
  await engine.unsetConfig(f.claim());
  const before = await f.rows();
  const secondReceipt = readFileSync(join(secondRoot, 'installation.json'), 'utf8');
  const left: any = await installSharedBrainBridge(f.options('legacy-first', 'memory-only'));
  expect(left.reason).toBe('bridge_ownership_conflict'); expect(left.status).toBe('pending');
  expect(left.remote_membership_pending).toBe(true); expect(left.native).toBe('unverified');
  expect((await installSharedBrainBridge(f.options('legacy-second')))?.reason).toBe('bridge_ownership_conflict');
  expect(await f.rows()).toEqual(before); expect(await engine.getConfig(f.claim())).toBeNull();
  expect(JSON.parse(readFileSync(join(f.metadataRoot('legacy-first'), 'installation.json'), 'utf8')).policy).toBe('memory-only');
  expect(JSON.parse(readFileSync(join(f.metadataRoot('legacy-first'), 'shared-skills', 'receipt.json'), 'utf8')).remote_membership_pending).toBe(true);
  expect(existsSync(join(f.metadataRoot('legacy-first'), 'shared-skills', 'active.json'))).toBe(false);
  expect(readFileSync(join(secondRoot, 'installation.json'), 'utf8')).toBe(secondReceipt);
  expect(existsSync(first.native_router_path)).toBe(false); expect(existsSync(second.native_router_path!)).toBe(true);
}));

test('forged old installation IDs and revoked credentials never become enrollment authority', () => withEnv(env(), async () => {
  const f = await fixture();
  const first: any = await installSharedBrainBridge(f.options('owner'));
  const otherRoot = f.metadataRoot('forged');
  privateWrite(join(otherRoot, 'installation.json'), JSON.stringify({ policy: 'follow' }));
  privateWrite(join(otherRoot, 'shared-skills', 'receipt.json'), JSON.stringify({ format_version: 1, adapter: 'codex', brain_id: brainId, installation_id: first.installation_id, owned_files: {}, pending_files: {} }));
  const before = await f.rows();
  expect((await installSharedBrainBridge(f.options('forged', 'memory-only')))?.reason).toBe('independent_principal_required');
  expect(await f.rows()).toEqual(before);
  await revokeLocalWriter(engine, f.registration.id);
  const removed: any = await installSharedBrainBridge(f.options('owner', 'memory-only'));
  expect(removed.status).toBe('pending'); expect(removed.reason).toBe('remote_membership_pending');
  expect(existsSync(first.native_router_path)).toBe(false);
  expect((await f.rows())[0].active).toBe(true);
  expect((await installSharedBrainBridge(f.options('owner')))?.reason).toBe('bridge_ownership_unavailable');
}));

test('a valid different principal cannot adopt or leave a foreign installation through a copied UUID', () => withEnv(env(), async () => {
  const f = await fixture();
  const first: any = await installSharedBrainBridge(f.options('owner'));
  const foreign = await withEnv({ GBRAIN_HOME: join(root, 'other-principal') }, () => registerLocalWriter(engine, 'cli'));
  privateWrite(join(root, '.gbrain', 'persistence', `${brainId}.cli.json`), JSON.stringify(foreign));
  const otherRoot = f.metadataRoot('copied');
  privateWrite(join(otherRoot, 'installation.json'), JSON.stringify({ policy: 'follow' }));
  privateWrite(join(otherRoot, 'shared-skills', 'receipt.json'), JSON.stringify({ format_version: 1, adapter: 'codex', brain_id: brainId, installation_id: first.installation_id, owned_files: {}, pending_files: {} }));
  const before = await f.rows();
  expect((await installSharedBrainBridge(f.options('copied', 'memory-only')))?.reason).toBe('bridge_ownership_conflict');
  expect(await f.rows()).toEqual(before);
  expect(existsSync(first.native_router_path)).toBe(true);
  expect(await engine.executeRaw('SELECT installation_id FROM shared_skill_members WHERE principal_id=$1', [foreign.id])).toEqual([]);
  const view: any = await f.call('sync_brain_skills', { installation_id: first.installation_id, enrollment_epoch: first.enrollment_epoch });
  expect(view.complete).toBe(true);
}));

test('conflicting legacy cleanup preserves edited native files and never touches the other destination', () => withEnv(env(), async () => {
  const f = await fixture();
  const first: any = await installSharedBrainBridge(f.options('first'));
  const second = await f.legacyTarget(first, 'second');
  await engine.unsetConfig(f.claim());
  writeFileSync(second.native_router_path!, 'Retain these native user edits');
  const firstNative = readFileSync(first.native_router_path, 'utf8'), before = await f.rows();
  const result: any = await installSharedBrainBridge(f.options('second', 'memory-only'));
  expect(result.status).toBe('pending'); expect(result.remote_membership_pending).toBe(true);
  expect(result.retained_files).toContain('native-router'); expect(result.native).toBe('unverified');
  expect(readFileSync(second.native_router_path!, 'utf8')).toBe('Retain these native user edits');
  expect(readFileSync(first.native_router_path, 'utf8')).toBe(firstNative);
  expect(existsSync(join(f.metadataRoot('second'), 'shared-skills', 'active.json'))).toBe(false);
  expect(await f.rows()).toEqual(before);
}));

test('copied native ownership pointing at another destination cannot authorize local deletion', () => withEnv(env(), async () => {
  const f = await fixture();
  const first: any = await installSharedBrainBridge(f.options('first'));
  const second = await f.legacyTarget(first, 'second');
  await engine.unsetConfig(f.claim());
  privateWrite(join(f.metadataRoot('second'), 'shared-skills', 'native-router.json'),
    readFileSync(join(f.metadataRoot('first'), 'shared-skills', 'native-router.json'), 'utf8'));
  const before = await f.rows();
  expect((await installSharedBrainBridge(f.options('second', 'memory-only')))?.reason).toBe('bridge_local_cleanup_conflict');
  expect(existsSync(first.native_router_path)).toBe(true); expect(existsSync(second.native_router_path!)).toBe(true);
  expect(await f.rows()).toEqual(before);
}));
