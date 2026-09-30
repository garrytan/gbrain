import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createSharedSkillsAdapter, type SharedSkillsToolCaller } from '../src/core/shared-skills/adapter.ts';
import { sharedSkillKey, type MembershipSnapshot } from '../src/core/shared-skills/membership-types.ts';
import { sha256 } from '../src/core/agent-install/state.ts';
import { installHarnessConnection } from '../src/core/harness/install.ts';
import type { HarnessCredentials } from '../src/core/harness/credentials.ts';
import { operations } from '../src/core/operations.ts';

const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'gbrain-shared-adapter-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const brain = randomUUID(), incarnation = randomUUID(), installation = randomUUID();
  let revision = 'r1', body = '# Fixture\n\nUse synthetic examples.', helper = 'first helper', active = true, epoch = 1;
  let empty = false, offline = false, loseAck = false, partial = false, leaveDuringFetch = false;
  const calls: string[] = [];
  const skill = () => ({ brain_id: brain, source_id: 'default', source_incarnation: incarnation, pack_id: 'example', name: 'fixture', revision, requirements: [], description: 'Use fixture', triggers: ['fixture'] });
  const snapshot = (): MembershipSnapshot => ({ schema_version: 2, status: 'catalog_visible', complete: !partial as true, brain_id: brain, installation_id: installation,
    enrollment_epoch: epoch, view_token: empty ? 'empty' : revision, batch_token: revision, sequence: 1, skills: empty ? [] : [skill()], blocked_skills: [],
    delivery: { transport: 'verified', installation: 'unverified', native: 'unverified', freshness: 'advisory_refresh' } });
  const call: SharedSkillsToolCaller = async <T>(name: string, params: Record<string, unknown>): Promise<T> => {
    calls.push(name);
    if (offline) throw new Error('offline');
    if (name === 'join_brain') { if (!active) epoch++; active = true; return snapshot() as T; }
    if (name === 'leave_brain') { active = false; return { status: 'left' } as T; }
    if (!active) throw new Error('membership_inactive');
    if (name === 'sync_brain_skills') {
      if (params.acknowledgment && loseAck) { loseAck = false; throw new Error('lost acknowledgment response'); }
      return snapshot() as T;
    }
    if (name === 'get_skill') return { ...skill(), usable: true, delivery: 'complete', unavailable_requirements: [], files: [{ path: 'SKILL.md', sha256: sha256(body), size: Buffer.byteLength(body) }, { path: 'references/helper.txt', sha256: sha256(helper), size: Buffer.byteLength(helper) }] } as T;
    if (name === 'get_skill_asset') { if (leaveDuringFetch) active = false; return { content: params.path === 'SKILL.md' ? body : helper, encoding: 'utf8' } as T; }
    throw new Error(`Unexpected operation ${name}`);
  };
  return { call, calls, skill, update: () => { revision = 'r2'; body = '# New fixture'; helper = 'second helper'; },
    empty: () => { empty = true; }, offline: (value = true) => { offline = value; }, partial: (value = true) => { partial = value; },
    loseAck: () => { loseAck = true; }, leaveDuringFetch: () => { leaveDuringFetch = true; } };
}

test('qualified revision cache refreshes body and helper without notifications and never claims native activation', async () => {
  const f = fixture(), root = temp();
  const adapter = createSharedSkillsAdapter({ call: f.call, root, adapter: 'codex', connectionName: 'team-brain' });
  const receipt = await adapter.join({ approved: true });
  expect(receipt.status).toBe('restart_required'); expect(receipt.native).toBe('unverified');
  const first = await adapter.admit(sharedSkillKey(f.skill()));
  expect(readFileSync(join(root, first.files['references/helper.txt']), 'utf8')).toBe('first helper');
  f.update();
  const updated = await adapter.admit(sharedSkillKey(f.skill()));
  expect(updated.revision).toBe('r2');
  expect(readFileSync(join(root, updated.files['references/helper.txt']), 'utf8')).toBe('second helper');
  expect(readFileSync(join(root, first.files['references/helper.txt']), 'utf8')).toBe('first helper');
  expect(statSync(join(root, updated.files['SKILL.md'])).mode & 0o111).toBe(0);
  expect(readFileSync(join(root, 'router/SKILL.md'), 'utf8')).toContain('team-brain');
  expect(readFileSync(join(root, 'router/SKILL.md'), 'utf8')).toContain('advisory, not an enforced invocation hook');
});

test('offline and partial enumeration block admission without deleting the prior authorized cache', async () => {
  const f = fixture(), root = temp();
  const adapter = createSharedSkillsAdapter({ call: f.call, root, adapter: 'muse', launcher: '/example/bin/gbrain' });
  await adapter.join({ approved: true });
  const before = readFileSync(join(root, 'active.json'), 'utf8');
  f.offline();
  await expect(adapter.admit(sharedSkillKey(f.skill()))).rejects.toThrow('offline');
  expect(adapter.status()?.status).toBe('stale_unavailable');
  expect(readFileSync(join(root, 'active.json'), 'utf8')).toBe(before);
  f.offline(false); f.partial();
  await expect(adapter.refresh()).rejects.toThrow('complete');
  expect(readFileSync(join(root, 'active.json'), 'utf8')).toBe(before);
});

test('ownership preflight preserves edits and leave reports retained files without changing identity', async () => {
  const f = fixture(), root = temp();
  const adapter = createSharedSkillsAdapter({ call: f.call, root, adapter: 'codex' });
  await adapter.join({ approved: true });
  writeFileSync(join(root, 'router/SKILL.md'), '# User edited router');
  writeFileSync(join(root, 'identity.md'), 'Unrelated identity');
  const before = readFileSync(join(root, 'active.json'), 'utf8'); f.update();
  await expect(adapter.refresh()).rejects.toThrow('edited');
  expect(readFileSync(join(root, 'active.json'), 'utf8')).toBe(before);
  const left = await adapter.leave();
  expect(left.status).toBe('left_with_retained_files');
  expect(readFileSync(join(root, 'router/SKILL.md'), 'utf8')).toBe('# User edited router');
  expect(readFileSync(join(root, 'identity.md'), 'utf8')).toBe('Unrelated identity');
  await expect(adapter.refresh()).rejects.toThrow('left');
});

test('offline leave deactivates owned cache before remote acknowledgment and retries safely', async () => {
  const f = fixture(), root = temp();
  const adapter = createSharedSkillsAdapter({ call: f.call, root, adapter: 'generic' });
  await adapter.join({ approved: true });
  f.offline();
  const left = await adapter.leave();
  expect(left.status).toBe('left');
  expect('remote_membership_pending' in left && left.remote_membership_pending).toBe(true);
  expect(existsSync(join(root, 'active.json'))).toBe(false);
  expect(existsSync(join(root, 'router', 'SKILL.md'))).toBe(false);
  await expect(adapter.admit(sharedSkillKey(f.skill()))).rejects.toMatchObject({ code: 'membership_inactive' });
  f.offline(false);
  const retried = await adapter.leave();
  expect('remote_membership_pending' in retried && retried.remote_membership_pending).toBe(false);
  expect(retried.status).toBe('left');
});

test('rejoin clears stale leave warnings only after delivery succeeds and preserves a new failure', async () => {
  const f = fixture(), root = temp();
  const adapter = createSharedSkillsAdapter({ call: f.call, root, adapter: 'generic' });
  await adapter.join({ approved: true });
  f.offline(); await adapter.leave();
  expect(adapter.status()?.remote_membership_pending).toBe(true);
  f.offline(false); f.loseAck();
  await expect(adapter.join({ approved: true })).rejects.toThrow('lost acknowledgment');
  expect(adapter.status()?.status).toBe('stale_unavailable');
  expect(adapter.status()?.remote_membership_pending).toBe(true);
  expect(adapter.status()?.remote_membership_reason).toBe('remote_unavailable');
  const ready = await adapter.refresh();
  expect(ready.acknowledged_view).toBe(ready.installed_view);
  expect(ready.remote_membership_pending).toBeUndefined();
  expect(ready.remote_membership_reason).toBeUndefined();
});

test('leave while fetching prevents activating downloaded revisions', async () => {
  const f = fixture(), root = temp();
  const adapter = createSharedSkillsAdapter({ call: f.call, root, adapter: 'generic' });
  await adapter.join({ approved: true });
  const before = readFileSync(join(root, 'active.json'), 'utf8');
  f.update(); f.leaveDuringFetch();
  await expect(adapter.refresh()).rejects.toThrow('membership_inactive');
  expect(readFileSync(join(root, 'active.json'), 'utf8')).toBe(before);
});

test('lost acknowledgment resumes from durable files in a fresh adapter instance', async () => {
  const f = fixture(), root = temp(); f.loseAck();
  await expect(createSharedSkillsAdapter({ call: f.call, root, adapter: 'generic' }).join({ approved: true })).rejects.toThrow('lost acknowledgment');
  expect(existsSync(join(root, 'active.json'))).toBe(true);
  const fresh = createSharedSkillsAdapter({ call: f.call, root, adapter: 'generic' });
  const synced = await fresh.refresh();
  expect(synced.acknowledged_view).toBe('r1');
  f.empty(); await fresh.refresh();
  expect(JSON.parse(readFileSync(join(root, 'active.json'), 'utf8')).skills).toEqual({});
});

test('two local adapter instances serialize refresh without losing the durable reference', async () => {
  const f = fixture(), root = temp();
  const first = createSharedSkillsAdapter({ call: f.call, root, adapter: 'codex' });
  await first.join({ approved: true }); f.update();
  const second = createSharedSkillsAdapter({ call: f.call, root, adapter: 'codex' });
  const results = await Promise.all([first.refresh(), second.refresh()]);
  expect(results.map(r => r.installed_view)).toEqual(['r2', 'r2']);
  expect(JSON.parse(readFileSync(join(root, 'active.json'), 'utf8')).view_token).toBe('r2');
  expect(first.status()?.pending_files).toEqual({});
});

for (const detail of [{ usable: false }, { delivery: 'prose_only' }, { delivery: undefined }, { unavailable_requirements: ['tool:missing-fixture'] }]) {
  test(`admission rejects unusable detail ${JSON.stringify(detail)} even when all file hashes match`, async () => {
    const f = fixture(), root = temp(); let invalid = false;
    const call: SharedSkillsToolCaller = async <T>(name: string, params: Record<string, unknown>): Promise<T> => {
      const result = await f.call<T>(name, params);
      return invalid && name === 'get_skill' ? { ...result, ...detail } as T : result;
    };
    const adapter = createSharedSkillsAdapter({ call, root, adapter: 'generic' });
    await adapter.join({ approved: true });
    invalid = true;
    const assets = f.calls.filter(name => name === 'get_skill_asset').length;
    await expect(adapter.admit(sharedSkillKey(f.skill()))).rejects.toMatchObject({ code: 'requirements_changed' });
    expect(f.calls.filter(name => name === 'get_skill_asset').length).toBe(assets);
    expect(JSON.parse(readFileSync(join(root, 'active.json'), 'utf8')).skills[sharedSkillKey(f.skill())]).toBeUndefined();
    expect(adapter.status()?.blocked_skills).toContainEqual({ key: sharedSkillKey(f.skill()), reason: 'requirements_changed' });
  });
}

test('admission rejects a blocked follow-policy skill instead of using its prior local copy', async () => {
  const f = fixture(), root = temp(); let blocked = false;
  const call: SharedSkillsToolCaller = async <T>(name: string, params: Record<string, unknown>): Promise<T> => {
    const result = await f.call<T>(name, params);
    return blocked && name === 'sync_brain_skills' ? { ...result, skills: [], blocked_skills: [f.skill()], status: 'requirements_changed' } as T : result;
  };
  const adapter = createSharedSkillsAdapter({ call, root, adapter: 'generic' });
  await adapter.join({ approved: true }); blocked = true;
  await expect(adapter.admit(sharedSkillKey(f.skill()))).rejects.toMatchObject({ code: 'requirements_changed' });
  expect(adapter.status()?.status).toBe('requirements_changed');
});

test('a thousand-skill authoritative view installs completely without the former 512-skill ceiling', async () => {
  const root = temp();
  const brain = randomUUID(), source = randomUUID(), installation = randomUUID();
  const body = '# Synthetic skill';
  const skills = Array.from({ length: 1000 }, (_, i) => ({ brain_id: brain, source_id: 'default', source_incarnation: source,
    pack_id: 'fixture', name: `fixture-${i}`, revision: randomUUID(), requirements: [], usable: true }));
  const snapshot: MembershipSnapshot = { schema_version: 2, complete: true, status: 'catalog_visible', brain_id: brain,
    installation_id: installation, enrollment_epoch: 1, sequence: 1, view_token: 'fixture-view', batch_token: randomUUID(), skills, blocked_skills: [],
    delivery: { transport: 'verified', installation: 'unverified', native: 'unverified', freshness: 'advisory_refresh' } };
  let acknowledged = 0;
  const call: SharedSkillsToolCaller = async <T>(name: string, params: Record<string, unknown>): Promise<T> => {
    if (name === 'join_brain' || name === 'sync_brain_skills') {
      if (params.acknowledgment) acknowledged = (params.acknowledgment as { evidence: { revisions: unknown[] } }).evidence.revisions.length;
      return snapshot as T;
    }
    if (name === 'get_skill') return { ...params, brain_id: params.expected_brain_id, delivery: 'complete', usable: true, files: [{ path: 'SKILL.md', sha256: sha256(body), size: Buffer.byteLength(body) }] } as T;
    if (name === 'get_skill_asset') return { content: body, encoding: 'utf8' } as T;
    throw new Error('Unexpected fixture operation');
  };
  const result = await createSharedSkillsAdapter({ call, root, adapter: 'generic' }).join({ approved: true });
  expect(result.installed_view).toBe('fixture-view');
  expect(acknowledged).toBe(1000);
  expect(Object.keys(JSON.parse(readFileSync(join(root, 'active.json'), 'utf8')).skills).length).toBe(1000);
});

test('connect install performs approved enrollment while preserving unrelated harness config', async () => {
  const f = fixture(), root = temp();
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ identity: 'keep', mcpServers: { unrelated: { command: 'local-fixture' } } }));
  const c: HarnessCredentials = { version: 1, mcp_url: 'https://brain.example.com/mcp', issuer_url: 'https://brain.example.com', client_id: 'fixture', access_token: 'synthetic-fixture-token', shared_skills: { follow: true } };
  const result = await installHarnessConnection(c, { harness: 'claude-code', configPath, toolCaller: f.call, nativeSkillsDir: join(root, 'native-skills') });
  expect(result.shared_skills?.status).toBe('restart_required');
  expect(f.calls).toContain('join_brain'); expect(f.calls).toContain('get_skill_asset');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(config.identity).toBe('keep'); expect(config.mcpServers.unrelated.command).toBe('local-fixture');
});

test('memory-only install neither enrolls nor expands authority', async () => {
  const root = temp(); const f = fixture();
  const c: HarnessCredentials = { version: 1, mcp_url: 'https://brain.example.com/mcp', issuer_url: 'https://brain.example.com', client_id: 'fixture', access_token: 'synthetic-fixture-token', shared_skills: { follow: false } };
  const result = await installHarnessConnection(c, { harness: 'claude-code', configPath: join(root, 'config.json'), toolCaller: f.call });
  expect(result.shared_skills?.status).toBe('pending'); expect(f.calls).toEqual([]);
});

test('launcher router uses registered CLI commands, exact schema flags and shell-safe absolute paths', async () => {
  const root = temp(), f = fixture();
  const launcher = join(root, "fixture launcher 'with spaces'");
  writeFileSync(launcher, '#!/bin/sh\nprintf \'%s\\0\' "$@"\n', { mode: 0o700 });
  const cache = join(root, 'cache');
  await createSharedSkillsAdapter({ call: f.call, root: cache, adapter: 'muse', launcher }).join({ approved: true });
  const router = readFileSync(join(cache, 'router', 'SKILL.md'), 'utf8');
  const commands = [...router.matchAll(/```sh\n([^\n]+)\n```/g)].map(match => match[1]);
  expect(commands).toHaveLength(6);
  const skill = f.skill();
  const env = { ...process.env, SKILL_NAME: skill.name, BRAIN_ID: skill.brain_id, SOURCE_ID: skill.source_id,
    SOURCE_INCARNATION: skill.source_incarnation, PACK_ID: skill.pack_id, REVISION: skill.revision,
    ASSET_PATH: 'references/helper.txt', APPROVED_FOLLOW_POLICY_JSON: JSON.stringify({ approved: true, source_ids: ['default'] }) };
  const seen: string[] = [];
  for (const command of commands) {
    expect(command.startsWith(`'${launcher.replace(/'/g, "'\\''")}' `)).toBe(true);
    const run = spawnSync('bash', ['-c', command], { env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    const [name, ...args] = run.stdout.split('\0').filter(Boolean);
    seen.push(name);
    const operation = operations.find(operation => operation.cliHints?.name === name)!;
    expect(operation).toBeDefined();
    const flags = args.filter(arg => arg.startsWith('--'));
    for (const flag of flags) if (flag !== '--json') expect(operation.params[flag.slice(2).replaceAll('-', '_')]).toBeDefined();
    if (name === 'skills' || name === 'skill') {
      expect(args[args.indexOf('--schema-version') + 1]).toBe('2');
    } else expect(args).not.toContain('--schema-version');
    if (name === 'skill' || name === 'skill-asset') {
      expect(args[args.indexOf('--expected-brain-id') + 1]).toBe(skill.brain_id);
      expect(args).not.toContain('--brain-id');
      expect(args[args.indexOf('--source-id') + 1]).toBe(skill.source_id);
      expect(args[args.indexOf('--source-incarnation') + 1]).toBe(skill.source_incarnation);
      expect(args[args.indexOf('--pack-id') + 1]).toBe(skill.pack_id);
      expect(args[args.indexOf('--revision') + 1]).toBe(skill.revision);
    }
  }
  expect(seen).toEqual(['sync-brain-skills', 'skills', 'skill', 'skill-asset', 'join-brain', 'leave-brain']);
  expect(router).not.toContain('call sync_brain_skills');
  expect(router).not.toContain('get_skill with schema_version');
});
