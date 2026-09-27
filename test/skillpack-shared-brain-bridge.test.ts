import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sharedBrainBridgePlan, installSharedBrainBridge } from '../src/core/skillpack/shared-brain-bridge.ts';
import { sha256 } from '../src/core/agent-install/state.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-shared-bridge-')); roots.push(root);
  const dest = join(root, 'skills'), statePath = join(root, 'bridge.json');
  mkdirSync(join(dest, 'recall'), { recursive: true });
  mkdirSync(join(dest, 'unrelated'));
  writeFileSync(join(dest, 'recall', 'SKILL.md'), 'old owned copy');
  writeFileSync(join(dest, 'unrelated', 'SKILL.md'), 'unrelated identity skill');
  writeFileSync(statePath, JSON.stringify({ schema_version: 'gbrain-skillpack-bridge-v1', entries: [{
    harness: 'codex', dest, written: { recall: { mode: 'full', files: { 'recall/SKILL.md': sha256('old owned copy') } } },
  }] }));
  const engine = { executeRaw: async () => [{ skill_bundles_enabled: true }] } as unknown as BrainEngine;
  return { root, dest, statePath, engine, config: { engine: 'pglite' } as GBrainConfig, harness: 'codex' };
}

test('active shared brains inventory unchanged owned copies without installing or removing stale bodies', async () => {
  const f = fixture(); const before = readFileSync(f.statePath, 'utf8');
  const result = await sharedBrainBridgePlan(f);
  expect(result?.reason).toBe('legacy_skill_migration_required');
  expect(result?.migration.owned_unchanged).toEqual(['recall/SKILL.md']);
  expect(result?.legacy_copy_written).toBe(false);
  expect(readFileSync(join(f.dest, 'recall', 'SKILL.md'), 'utf8')).toBe('old owned copy');
  expect(readFileSync(join(f.dest, 'unrelated', 'SKILL.md'), 'utf8')).toBe('unrelated identity skill');
  expect(readFileSync(f.statePath, 'utf8')).toBe(before);
});

test('edited and escaping ledger paths remain visible conflicts without modifying user files', async () => {
  const f = fixture(); writeFileSync(join(f.dest, 'recall', 'SKILL.md'), 'local user changes');
  const ledger = JSON.parse(readFileSync(f.statePath, 'utf8'));
  ledger.entries[0].written.recall.files['../outside.md'] = sha256('outside');
  writeFileSync(f.statePath, JSON.stringify(ledger));
  writeFileSync(join(f.root, 'outside.md'), 'outside');
  const result = await sharedBrainBridgePlan(f);
  expect(result?.reason).toBe('legacy_skill_conflict');
  expect(result?.migration.modified).toEqual(['recall/SKILL.md', '../outside.md']);
  expect(readFileSync(join(f.dest, 'recall', 'SKILL.md'), 'utf8')).toBe('local user changes');
  expect(readFileSync(join(f.root, 'outside.md'), 'utf8')).toBe('outside');
});

test('thin connection needs its explicit remote grant and never probes or mints from a local brain', async () => {
  const f = fixture(); let touched = false;
  const result = await sharedBrainBridgePlan({ ...f, dest: undefined,
    config: { remote_mcp: { mcp_url: 'https://brain.example/mcp' } } as GBrainConfig,
    engine: { executeRaw: async () => { touched = true; throw new Error('wrong local brain'); } } as unknown as BrainEngine });
  expect(touched).toBe(false);
  expect(result?.reason).toBe('follow_approval_required');
  expect(result?.next_action).toContain('skills_member_self');
  expect(result?.next_action).toContain('sync_brain_skills');
  expect(result?.native).toBe('unverified');
});

test('plain unconfigured and known legacy brains keep their existing bridge lane', async () => {
  expect(await sharedBrainBridgePlan({ engine: null, config: null, harness: 'codex' })).toBeNull();
  expect(await sharedBrainBridgePlan({ engine: { executeRaw: async () => [{ skill_bundles_enabled: false }] } as unknown as BrainEngine,
    config: { engine: 'pglite' }, harness: 'codex' })).toBeNull();
  expect((await installSharedBrainBridge({ engine: null, config: null, harness: 'codex', policy: 'follow' }))?.reason).toBe('shared_content_migration_required');
  expect((await installSharedBrainBridge({ engine: null, config: null, harness: 'codex', policy: 'memory-only' }))?.reason).toBe('memory_only');
});

test('unavailable configured brain cannot silently fall back to unqualified copies', async () => {
  const f = fixture(); const absent = join(f.root, 'new-skills');
  const result = await sharedBrainBridgePlan({ ...f, dest: absent, engine: null });
  expect(result?.reason).toBe('shared_brain_unavailable');
  expect(existsSync(absent)).toBe(false);
});
