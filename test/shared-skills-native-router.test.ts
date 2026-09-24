import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withEnv } from './helpers/with-env.ts';
import { installHarnessConnection } from '../src/core/harness/install.ts';
import { nativeSharedSkillsDirectory, prepareNativeRouter, installNativeRouter, removeNativeRouter } from '../src/core/harness/native-router.ts';
import { sha256 } from '../src/core/agent-install/state.ts';
import type { HarnessCredentials } from '../src/core/harness/credentials.ts';
import type { SharedSkillsToolCaller } from '../src/core/shared-skills/adapter.ts';
import { readHarnessConnectionStatus } from '../src/core/harness/status.ts';
import { runCli } from './helpers/cli-spawn.ts';

const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'gbrain-native-router-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const body = '---\nname: gbrain-shared-router\ndescription: Discover relevant authorized shared-brain skills.\n---\nUse only the named connection. Native use remains unverified.\n';

function fixture() {
  const brain = randomUUID(), installation = randomUUID();
  let epoch = 1, active = false, sequence = 0;
  let checkAcknowledgment = () => {};
  const call: SharedSkillsToolCaller = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    if (name === 'join_brain') { if (!active && sequence > 0) epoch++; active = true; sequence++; }
    if (name === 'leave_brain') { active = false; return { status: 'left' } as T; }
    if (!active || (name === 'sync_brain_skills' && args.enrollment_epoch !== epoch)) throw new Error('membership_inactive');
    if (name === 'sync_brain_skills' && args.acknowledgment) checkAcknowledgment();
    return { schema_version: 2, complete: true, status: 'catalog_visible', brain_id: brain, installation_id: installation,
      enrollment_epoch: epoch, view_token: `view-${epoch}`, batch_token: `batch-${epoch}`, sequence: 1, skills: [], blocked_skills: [],
      delivery: { transport: 'verified', installation: 'unverified', native: 'unverified', freshness: 'advisory_refresh' } } as T;
  };
  const credentials: HarnessCredentials = { version: 1, mcp_url: 'https://brain.example.com/mcp', issuer_url: 'https://brain.example.com',
    client_id: `fixture-${installation}`, access_token: 'synthetic-fixture-token', shared_skills: { follow: true } };
  return { call, credentials, setAckCheck: (check: () => void) => { checkAcknowledgment = check; } };
}

for (const harness of ['claude-code', 'codex', 'opencode']) test(`${harness} connect installs a namespaced owned router in the documented native directory`, async () => {
  const root = temp(), f = fixture();
  await withEnv({ HOME: root, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: join(root, '.codex'), XDG_CONFIG_HOME: join(root, '.config') }, async () => {
    const expected = harness === 'claude-code' ? join(root, '.claude', 'skills') : harness === 'codex' ? join(root, '.agents', 'skills') : join(root, '.config', 'opencode', 'skills');
    expect(nativeSharedSkillsDirectory(harness)).toBe(expected);
    mkdirSync(join(expected, 'unrelated'), { recursive: true });
    writeFileSync(join(expected, 'unrelated', 'SKILL.md'), 'User-owned skill');
    f.setAckCheck(() => {
      const names = readdirSync(expected).filter(p => p.startsWith('gbrain-shared-'));
      expect(names.length).toBe(1);
      expect(existsSync(join(expected, names[0], 'SKILL.md'))).toBe(true);
    });
    const installed = await installHarnessConnection(f.credentials, { harness, toolCaller: f.call });
    const shared = installed.shared_skills as any;
    expect(shared.status).toBe('restart_required'); expect(shared.native_registration).toBe('installed'); expect(shared.native).toBe('unverified');
    const path = shared.native_router_path as string;
    expect(path.startsWith(`${expected}/gbrain-shared-`)).toBe(true);
    const content = readFileSync(path, 'utf8'); const name = path.split('/').at(-2)!;
    expect(content).toContain(`name: ${name}\n`); expect(content).toContain('enrollment_epoch 1');
    expect(installed.native_harness_verified).toBe(false);
    const again = await installHarnessConnection(f.credentials, { harness, toolCaller: f.call });
    expect((again.shared_skills as any).native_router_path).toBe(path); expect(readFileSync(path, 'utf8')).toBe(content);
    expect(readdirSync(expected).filter(p => p.startsWith('gbrain-shared-')).length).toBe(1);
    const removed = await installHarnessConnection(f.credentials, { harness, toolCaller: f.call, remove: true });
    expect(removed.shared_skills?.status).toBe('left'); expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(expected, 'unrelated', 'SKILL.md'), 'utf8')).toBe('User-owned skill');
  });
});

test('native edits block reinstall before active-reference changes and survive leave', async () => {
  const root = temp(), f = fixture();
  const opts = { harness: 'codex', configPath: join(root, 'config.toml'), nativeSkillsDir: join(root, 'skills'), toolCaller: f.call };
  const first = await installHarnessConnection(f.credentials, opts);
  const shared = first.shared_skills as any;
  writeFileSync(shared.native_router_path, '# User edited native router');
  const refPath = join(root, '.gbrain-codex-gbrain', 'shared-skills', 'active.json');
  const before = readFileSync(refPath, 'utf8');
  const next = await installHarnessConnection(f.credentials, opts);
  expect((next.shared_skills as any).reason).toBe('local_conflict');
  expect(readFileSync(refPath, 'utf8')).toBe(before);
  const left = await installHarnessConnection(f.credentials, { ...opts, remove: true });
  expect(left.shared_skills?.status).toBe('left_with_retained_files');
  expect(readFileSync(shared.native_router_path, 'utf8')).toBe('# User edited native router');
});

test('unowned and symlinked native destinations are never adopted', async () => {
  const root = temp();
  const identity = { brain_id: randomUUID(), installation_id: randomUUID(), adapter: 'claude-code' };
  const input = { ...identity, state_root: join(root, 'state'), skills_dir: join(root, 'skills'), connection_name: 'fixture', content: body };
  const plan = prepareNativeRouter(input);
  mkdirSync(join(input.skills_dir, plan.name), { recursive: true }); writeFileSync(plan.path, body);
  expect(() => prepareNativeRouter(input)).toThrow('unowned');
  rmSync(join(input.skills_dir, plan.name), { recursive: true });
  const foreign = join(root, 'foreign'); mkdirSync(foreign); symlinkSync(foreign, join(input.skills_dir, plan.name));
  expect(() => prepareNativeRouter(input)).toThrow('symlink');
  expect(readdirSync(foreign)).toEqual([]);
});

test('native write-ahead receipt resumes an interrupted installation and different connections do not collide', async () => {
  const root = temp();
  const identity = { brain_id: randomUUID(), installation_id: randomUUID(), adapter: 'opencode' };
  const input = { ...identity, state_root: join(root, 'state'), skills_dir: join(root, 'skills'), connection_name: 'first', content: body };
  const plan = prepareNativeRouter(input);
  await installNativeRouter(plan);
  const path = join(input.state_root, 'native-router.json');
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  const changed = body + '\nAdditional owned router guidance.\n';
  const next = prepareNativeRouter({ ...input, content: changed });
  receipt.state = 'prepared'; receipt.pending = { before: receipt.owned_hash, after: sha256(next.content) };
  writeFileSync(path, JSON.stringify(receipt)); writeFileSync(next.path, next.content);
  await installNativeRouter(next);
  expect(JSON.parse(readFileSync(path, 'utf8')).state).toBe('installed');
  const other = prepareNativeRouter({ ...input, state_root: join(root, 'other-state'), connection_name: 'second' });
  expect(other.path).not.toBe(next.path);
  await installNativeRouter(other);
  expect((await removeNativeRouter(input.state_root, identity)).retained).toBe(false);
  expect(existsSync(other.path)).toBe(true);
});

test('manual harnesses have no invented native discovery directory', () => {
  for (const harness of ['muse', 'grok-bot', 'generic', 'openclaw']) expect(nativeSharedSkillsDirectory(harness)).toBeNull();
  expect(nativeSharedSkillsDirectory('claude')).toBe(nativeSharedSkillsDirectory('claude-code'));
});

for (const edited of [false, true]) test(`expired credentials do not prevent local native cleanup (edited=${edited})`, async () => {
  const root = temp(), f = fixture();
  const opts = { harness: 'codex', configPath: join(root, 'config.toml'), nativeSkillsDir: join(root, 'skills') };
  const installed = await installHarnessConnection(f.credentials, { ...opts, toolCaller: f.call });
  const path = (installed.shared_skills as { native_router_path: string }).native_router_path;
  if (edited) writeFileSync(path, 'User edited native router');
  const result = await installHarnessConnection({ ...f.credentials, expires_at: 1 }, { ...opts, remove: true });
  expect(result.shared_skills.status).toBe(edited ? 'left_with_retained_files' : 'left');
  expect('remote_membership_pending' in result && result.remote_membership_pending).toBe(true);
  expect(existsSync(path)).toBe(edited);
  if (edited) expect(readFileSync(path, 'utf8')).toBe('User edited native router');
  expect(readHarnessConnectionStatus(opts).current_authority).toBe('unprobed');
});

test('connect status reads only the local receipt without credentials, network or writes', async () => {
  const root = temp(), f = fixture();
  await withEnv({ HOME: root, CLAUDE_CONFIG_DIR: join(root, '.claude') }, async () => {
    const installed = await installHarnessConnection(f.credentials, { harness: 'claude-code', toolCaller: f.call });
    const receipt = installed.shared_skills as { native_router_path: string; desired_view: string };
    const before = readFileSync(receipt.native_router_path, 'utf8');
    const status = await runCli(['connect', '--harness', 'claude-code', '--status', '--json'], { env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, '.claude') } });
    expect(status.exitCode).toBe(0);
    const result = JSON.parse(status.stdout);
    expect(result.current_authority).toBe('unprobed');
    expect(result.desired_view).toBe(receipt.desired_view);
    expect(result.native_registration).toBe('installed');
    expect(result.native_use).toBe('unverified');
    expect(result.recorded_skills).toEqual([]);
    expect(result.usability).toBe('last_checked_unverified');
    expect(result.blocked_skills).toEqual([]);
    expect(result.local_reference).toBe('owned');
    expect(status.stdout).not.toContain(f.credentials.access_token!);
    expect(readFileSync(receipt.native_router_path, 'utf8')).toBe(before);
  });
});
