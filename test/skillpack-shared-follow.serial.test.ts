import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installSharedBrainBridge } from '../src/core/skillpack/shared-brain-bridge.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { setSharedSkillPolicy } from '../src/core/shared-skills/policy.ts';
import { privateWrite, sha256 } from '../src/core/agent-install/state.ts';
import { withEnv } from './helpers/with-env.ts';
import type { GBrainConfig } from '../src/core/config.ts';

let root: string, engine: PGLiteEngine, config: GBrainConfig;
const env = () => ({ GBRAIN_HOME: root, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: 'default', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined });
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-bridge-follow-'));
  config = { engine: 'pglite', database_path: join(root, '.gbrain', 'brain.pglite'), mcp: { publish_skills: true } };
  privateWrite(join(root, '.gbrain', 'config.json'), JSON.stringify(config));
  engine = new PGLiteEngine(); await engine.connect(config); await engine.initSchema();
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx); await tx.executeRaw("SELECT set_config('gbrain.writer_quiesced','true',true)");
    await tx.executeRaw('UPDATE persistence_brain SET enabled=true,skill_bundles_enabled=true,writer_protocol_floor=2 WHERE singleton=1');
  });
  await withEnv(env(), () => setSharedSkillPolicy({ engine, config, sourceId: 'default', remote: false, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } }, 'default', { version: 1, enabled: true, allow_follow: true, classes: ['prose'], audiences: ['readers'], requirements: [] }));
}, 120_000);
afterAll(async () => { await engine?.disconnect(); if (root) rmSync(root, { recursive: true, force: true }); });

test('new managed bridge installs the common native router after explicit follow approval and preserves unrelated skills', async () => {
  const dest = join(root, 'codex-skills'); mkdirSync(join(dest, 'unrelated'), { recursive: true });
  writeFileSync(join(dest, 'unrelated', 'SKILL.md'), 'User identity and unrelated skill');
  const result = await withEnv(env(), () => installSharedBrainBridge({ engine, config, harness: 'codex', dest, policy: 'follow' }));
  expect(result?.status).toBe('restart_required');
  expect(result?.reason).toBe('native_activation_unverified');
  const installed = result as { native_router_path: string; launcher: string; native: string; source_id: string };
  expect(installed.native).toBe('unverified'); expect(installed.source_id).toBe('default');
  expect(readFileSync(installed.native_router_path, 'utf8')).toContain(installed.launcher);
  expect(readFileSync(installed.native_router_path, 'utf8')).toContain('sync-brain-skills');
  expect(readFileSync(installed.launcher, 'utf8')).toContain("export GBRAIN_SOURCE=default");
  expect(readFileSync(join(dest, 'unrelated', 'SKILL.md'), 'utf8')).toBe('User identity and unrelated skill');
  const again = await withEnv(env(), () => installSharedBrainBridge({ engine, config, harness: 'codex', dest }));
  expect(again?.status).toBe('restart_required');
  const off = await withEnv(env(), () => installSharedBrainBridge({ engine, config, harness: 'codex', dest, policy: 'memory-only' }));
  expect(off?.reason).toBe('memory_only');
  expect(existsSync(installed.native_router_path)).toBe(false);
  expect(readFileSync(join(dest, 'unrelated', 'SKILL.md'), 'utf8')).toBe('User identity and unrelated skill');
});

test('unapproved and dry-run bridge targets remain pending without native or launcher writes', async () => {
  const dest = join(root, 'unapproved');
  const pending = await withEnv(env(), () => installSharedBrainBridge({ engine, config, harness: 'opencode', dest }));
  expect(pending?.reason).toBe('follow_approval_required'); expect(existsSync(dest)).toBe(false);
  const dry = await withEnv(env(), () => installSharedBrainBridge({ engine, config, harness: 'opencode', dest, policy: 'follow', dryRun: true }));
  expect(dry?.status).toBe('pending'); expect(existsSync(dest)).toBe(false);
});

test('copied legacy bodies require safe explicit migration even with follow approval', async () => {
  const dest = join(root, 'old-copy'); mkdirSync(join(dest, 'recall'), { recursive: true });
  writeFileSync(join(dest, 'recall', 'SKILL.md'), 'owned legacy content');
  const statePath = join(root, 'legacy-ledger.json');
  writeFileSync(statePath, JSON.stringify({ schema_version: 'gbrain-skillpack-bridge-v1', entries: [{ harness: 'opencode', dest,
    written: { recall: { mode: 'stub', files: { 'recall/SKILL.md': sha256('owned legacy content') } } } }] }));
  const result = await withEnv(env(), () => installSharedBrainBridge({ engine, config, harness: 'opencode', dest, statePath, policy: 'follow' }));
  expect(result?.reason).toBe('legacy_skill_migration_required');
  expect(readFileSync(join(dest, 'recall', 'SKILL.md'), 'utf8')).toBe('owned legacy content');
});

test('ambient database override cannot produce a launcher bound to the wrong persisted brain', async () => {
  const dest = join(root, 'wrong-database');
  const result = await withEnv(env(), () => installSharedBrainBridge({ engine, config: { ...config, database_path: join(root, 'elsewhere.pglite') },
    harness: 'opencode', dest, policy: 'follow' }));
  expect(result?.reason).toBe('bound_connection_required'); expect(existsSync(dest)).toBe(false);
});
