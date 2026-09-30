import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installLocalSharedSkills } from '../src/core/agent-install/shared-skills.ts';
import { registerLocalWriter, revokeLocalWriter } from '../src/core/persistence/identity.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { setSharedSkillPolicy } from '../src/core/shared-skills/policy.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const roots: string[] = [];
const config = { engine: 'pglite' as const, mcp: { publish_skills: true } };
const context = (): OperationContext => ({ engine, config, remote: false, sourceId: 'default', dryRun: false,
  logger: { info() {}, warn() {}, error() {} } });

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw("SELECT set_config('gbrain.writer_quiesced','true',true)");
    await tx.executeRaw('UPDATE persistence_brain SET enabled=true,skill_bundles_enabled=true,writer_protocol_floor=2 WHERE singleton=1');
  });
  await engine.setConfig('mcp.publish_skills', 'true');
  await setSharedSkillPolicy(context(), 'default', { version: 1, enabled: true, classes: ['prose'], audiences: ['readers'], requirements: [], allow_follow: true });
}, 120_000);
afterAll(async () => { await engine?.disconnect(); for (const root of roots) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-local-enrollment-')); roots.push(root);
  const registration = await withEnv({ GBRAIN_HOME: root, DATABASE_URL: undefined }, () => registerLocalWriter(engine, 'cli', {
    sourceIds: ['default'], operations: null, scopes: ['read', 'write'], slugPrefixes: null,
  }));
  return { root, registration, options: { root, harness: 'grok-bot' as const, sourceId: 'default', follow: true } };
}

test('approved local installation uses its own verified principal and fixed-source absolute router', async () => {
  const f = await fixture();
  const before = await engine.executeRaw('SELECT grant_ceiling FROM persistence_local_writers WHERE id=$1', [f.registration.id]);
  const result = await withEnv({ GBRAIN_HOME: '/nonexistent-foreign-fixture', DATABASE_URL: 'postgres://foreign.invalid/other' }, () => installLocalSharedSkills(context(), f.options));
  expect(result.status).toBe('pending'); expect(result.reason).toBe('native_registration_required');
  expect(result.native).toBe('unverified'); expect(result.catalog_delivery).toBe('advisory_refresh');
  const router = readFileSync(result.router_path!, 'utf8');
  expect(router).toContain(join(f.root, 'bin', 'gbrain'));
  expect(router).toContain('sync-brain-skills');
  expect(router).toContain('Preserve the user');
  const rows = await engine.executeRaw<{ principal_id: string; follow_policy: { source_ids: string[] } }>('SELECT principal_id,follow_policy FROM shared_skill_members WHERE principal_id=$1', [f.registration.id]);
  expect(rows).toHaveLength(1); expect(rows[0].follow_policy.source_ids).toEqual(['default']);
  expect(await engine.executeRaw('SELECT grant_ceiling FROM persistence_local_writers WHERE id=$1', [f.registration.id])).toEqual(before);
});

test('existing memory-only installation never enrolls or silently widens its writer grant', async () => {
  const f = await fixture();
  const before = await engine.executeRaw('SELECT grant_ceiling FROM persistence_local_writers WHERE id=$1', [f.registration.id]);
  const result = await installLocalSharedSkills(context(), { ...f.options, follow: false });
  expect(result.status).toBe('memory_only');
  expect(existsSync(join(f.root, '.gbrain', 'agent-install', 'shared-skills'))).toBe(false);
  expect(await engine.executeRaw('SELECT installation_id FROM shared_skill_members WHERE principal_id=$1', [f.registration.id])).toEqual([]);
  expect(await engine.executeRaw('SELECT grant_ceiling FROM persistence_local_writers WHERE id=$1', [f.registration.id])).toEqual(before);
});

test('changed source, remote context and missing own registration cannot borrow ambient authority', async () => {
  const f = await fixture();
  expect((await installLocalSharedSkills({ ...context(), sourceId: 'elsewhere' }, f.options)).reason).toBe('installation_context_required');
  expect((await installLocalSharedSkills({ ...context(), remote: true }, f.options)).reason).toBe('installation_context_required');
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  rmSync(join(f.root, '.gbrain', 'persistence', `${brain.brain_id}.cli.json`));
  expect((await installLocalSharedSkills(context(), f.options)).reason).toBe('local_enrollment_unavailable');
  expect(await engine.executeRaw('SELECT installation_id FROM shared_skill_members WHERE principal_id=$1', [f.registration.id])).toEqual([]);
});

test('edited router is retained on repair and opt-out stops only this local membership', async () => {
  const f = await fixture();
  const first = await installLocalSharedSkills(context(), f.options);
  writeFileSync(first.router_path!, 'User-maintained router changes');
  expect((await installLocalSharedSkills(context(), f.options)).reason).toBe('local_conflict');
  const left = await installLocalSharedSkills(context(), { ...f.options, follow: false });
  expect(left.status).toBe('memory_only'); expect(left.retained_files).toContain('router/SKILL.md');
  expect(readFileSync(first.router_path!, 'utf8')).toBe('User-maintained router changes');
  const [row] = await engine.executeRaw<{ active: boolean }>('SELECT active FROM shared_skill_members WHERE principal_id=$1', [f.registration.id]);
  expect(row.active).toBe(false);
});

test('revoked local registration remains pending and is never silently replaced', async () => {
  const f = await fixture(); await revokeLocalWriter(engine, f.registration.id);
  const result = await installLocalSharedSkills(context(), f.options);
  expect(result.reason).toBe('local_enrollment_unavailable');
  expect(await engine.executeRaw('SELECT installation_id FROM shared_skill_members WHERE principal_id=$1', [f.registration.id])).toEqual([]);
});

test('lost writer access still removes unchanged owned router files while retaining pending enrollment cleanup', async () => {
  const f = await fixture();
  const followed = await installLocalSharedSkills(context(), f.options);
  await revokeLocalWriter(engine, f.registration.id);
  const left = await installLocalSharedSkills(context(), { ...f.options, follow: false });
  expect(left.status).toBe('pending'); expect(left.reason).toBe('remote_membership_pending');
  expect(existsSync(followed.router_path!)).toBe(false);
  const [row] = await engine.executeRaw<{ active: boolean }>('SELECT active FROM shared_skill_members WHERE principal_id=$1', [f.registration.id]);
  expect(row.active).toBe(true);
});
