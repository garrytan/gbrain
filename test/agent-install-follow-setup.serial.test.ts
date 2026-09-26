import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setupInAgent, type AgentSetupResult } from '../src/core/agent-install/setup.ts';
import { isolatedAgentEnv, readInstallReceipt, writeInstallReceipt } from '../src/core/agent-install/state.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let temporary: string, bundle: string, fresh: string;
let installed: AgentSetupResult;
const sourceRef = 'a'.repeat(40), repo = resolve(import.meta.dir, '..');

beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), 'gbrain-follow-setup-'));
  bundle = join(temporary, 'bundle'); fresh = join(temporary, 'fresh');
  const pkg = join(bundle, 'app', 'node_modules', 'gbrain');
  mkdirSync(join(pkg, 'src', 'core', 'agent-install'), { recursive: true }); mkdirSync(join(pkg, 'scripts'));
  copyFileSync(process.execPath, join(bundle, 'bun')); chmodSync(join(bundle, 'bun'), 0o700);
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'gbrain', version: '0.0.0-test' }));
  writeFileSync(join(pkg, 'src', 'cli.ts'), `const child=Bun.spawn([process.execPath,'--no-env-file',${JSON.stringify(join(repo, 'src', 'cli.ts'))},...process.argv.slice(2)],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});process.exit(await child.exited);\n`);
  writeFileSync(join(pkg, 'src', 'core', 'agent-install', 'entry.ts'), '');
  copyFileSync(join(repo, 'scripts', 'setup-in-agent.sh'), join(pkg, 'scripts', 'setup-in-agent.sh'));
  writeFileSync(join(temporary, 'SOUL.md'), 'Existing personal agent identity');
  installed = await setupInAgent({ root: fresh, harness: 'grok-bot', bundle, sourceRef });
}, 120_000);
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

test('genuinely fresh setup follows packaged shared skills through the owned absolute router without claiming native activation', () => {
  expect(readInstallReceipt(fresh)?.skills_policy).toBe('follow');
  expect(installed.shared_skills.reason).toBe('native_registration_required');
  expect(installed.shared_skills.native).toBe('unverified');
  expect(installed.shared_skills.catalog_delivery).toBe('advisory_refresh');
  const instructions = readFileSync(installed.instructions, 'utf8');
  expect(instructions).toContain('Do not replace the agent');
  expect(instructions).toContain('sync-brain-skills');
  expect(instructions).toContain(join(fresh, 'bin', 'gbrain'));
  const active = JSON.parse(readFileSync(join(fresh, '.gbrain', 'agent-install', 'shared-skills', 'active.json'), 'utf8'));
  expect(Object.keys(active.skills).length).toBeGreaterThan(0);
  expect(readFileSync(join(temporary, 'SOUL.md'), 'utf8')).toBe('Existing personal agent identity');
});

test('existing receipt without a prior choice stays pending until explicit approval and retains native identity', async () => {
  const root = join(temporary, 'existing');
  await setupInAgent({ root, harness: 'muse', bundle, sourceRef, skills: 'memory-only' });
  const receipt = readInstallReceipt(root)!;
  const identity = { installation_id: receipt.installation_id, skill_id: receipt.native.skill_id, source_id: receipt.source_id };
  delete receipt.skills_policy; writeInstallReceipt(receipt);
  const pending = await setupInAgent({ root, harness: 'muse', bundle, sourceRef });
  expect(pending.shared_skills.reason).toBe('follow_approval_required');
  expect(existsSync(join(root, '.gbrain', 'agent-install', 'shared-skills', 'receipt.json'))).toBe(false);
  const followed = await setupInAgent({ root, harness: 'muse', bundle, sourceRef, skills: 'follow' });
  expect(followed.shared_skills.catalog_delivery).toBe('advisory_refresh');
  const after = readInstallReceipt(root)!;
  expect({ installation_id: after.installation_id, skill_id: after.native.skill_id, source_id: after.source_id }).toEqual(identity);
  expect(readFileSync(followed.instructions, 'utf8')).toContain('sync-brain-skills');
}, 120_000);

test('adopted local brain stays memory-only pending approval and never acquires a new identity instruction', async () => {
  const root = join(temporary, 'adopted'); mkdirSync(root);
  const child = Bun.spawn([process.execPath, join(repo, 'src', 'cli.ts'), 'init', '--pglite', '--no-embedding', '--non-interactive'], {
    cwd: root, env: { ...isolatedAgentEnv(root), GBRAIN_IN_AGENT_SETUP: '1' }, stdout: 'pipe', stderr: 'pipe',
  });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, `${output}\n${error}`).toBe(0);
  const adopted = await setupInAgent({ root, harness: 'grok-bot', bundle, sourceRef, adopt: true });
  expect(adopted.shared_skills.reason).toBe('follow_approval_required');
  expect(readInstallReceipt(root)?.adopted).toBe(true);
  expect(readInstallReceipt(root)?.skills_policy).toBeUndefined();
  expect(readFileSync(adopted.instructions, 'utf8')).not.toContain('sync-brain-skills');
}, 120_000);

test('explicit opt-out leaves membership, keeps source routing and refuses to overwrite edited generated instructions', async () => {
  const before = readInstallReceipt(fresh)!;
  const result = await setupInAgent({ root: fresh, harness: 'grok-bot', bundle, sourceRef, skills: 'memory-only' });
  expect(result.shared_skills.status).toBe('memory_only');
  expect(readFileSync(result.instructions, 'utf8')).not.toContain('sync-brain-skills');
  expect(readInstallReceipt(fresh)?.source_id).toBe(before.source_id);
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: before.database_path });
  try {
    const members = await engine.executeRaw<{ active: boolean }>('SELECT active FROM shared_skill_members');
    expect(members.every(member => !member.active)).toBe(true);
  } finally { await engine.disconnect(); }
  writeFileSync(result.instructions, 'User edited generated instructions');
  await expect(setupInAgent({ root: fresh, harness: 'grok-bot', bundle, sourceRef, skills: 'follow' })).rejects.toThrow('will not be overwritten');
  expect(readFileSync(result.instructions, 'utf8')).toBe('User edited generated instructions');
  expect(readFileSync(join(temporary, 'SOUL.md'), 'utf8')).toBe('Existing personal agent identity');
}, 120_000);
