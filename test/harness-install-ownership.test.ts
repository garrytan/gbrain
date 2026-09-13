import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHarnessConnection } from '../src/core/harness/install.ts';
import { readCredentials, validateCredentials, type HarnessCredentials } from '../src/core/harness/credentials.ts';
import { sha256 } from '../src/core/agent-install/state.ts';
import { parseMcpGrant } from '../src/commands/mcp.ts';
import { validateHarnessArguments } from '../src/core/harness/arguments.ts';

const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'gbrain-owned-client-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const credentials: HarnessCredentials = { version: 1, mcp_url: 'https://brain.example.com/mcp', issuer_url: 'https://brain.example.com', client_id: 'gbrain_cl_owned_fixture', client_secret: 'fixture-secret-not-real', access_token: 'fixture-token-not-real', profile: 'memory-writer' };

test('provisioning refuses misspelled restrictions and duplicate aliases before creating authority', () => {
  expect(() => parseMcpGrant(['grant', 'fixture', '--budget-usd-perday', '1'])).toThrow('Unknown');
  expect(() => parseMcpGrant(['grant', 'fixture', '--bound-slug-prefix', 'private/'])).toThrow('Unknown');
  expect(() => parseMcpGrant(['grant', 'fixture', '--profile', 'full', '--profile', 'memory-reader'])).toThrow('Duplicate');
  expect(() => parseMcpGrant(['grant', 'fixture', '--harness', 'muse', '--agent', 'codex'])).toThrow('Duplicate');
  expect(parseMcpGrant(['grant', 'fixture', '--agent', 'muse']).harness).toBe('muse');
  expect(() => validateHarnessArguments(['--install', '--remove'], { flags: ['--install', '--remove'], exclusive: [['--install', '--remove']] })).toThrow('Conflicting');
});

test('thin install preserves edited files before any rewrite, then removes only owned artifacts idempotently', async () => {
  const root = temp();
  await installHarnessConnection(credentials, { harness: 'muse', root });
  const path = join(root, 'GBRAIN-INSTRUCTIONS.md'); const generated = readFileSync(path, 'utf8');
  const configPath = join(root, '.gbrain', 'config.json'); const before = readFileSync(configPath, 'utf8');
  writeFileSync(path, 'my personal instructions');
  await expect(installHarnessConnection({ ...credentials, client_secret: 'new-fixture-secret' }, { harness: 'muse', root })).rejects.toThrow('edited');
  await expect(installHarnessConnection(credentials, { harness: 'muse', root, remove: true })).rejects.toThrow('edited');
  expect(readFileSync(configPath, 'utf8')).toBe(before);
  expect(readFileSync(path, 'utf8')).toBe('my personal instructions');
  writeFileSync(path, generated);
  writeFileSync(join(root, 'personal-note.md'), 'keep this');
  for (let i = 0; i < 2; i++) expect((await installHarnessConnection(credentials, { harness: 'muse', root, remove: true })).status).toBe('removed');
  expect(existsSync(configPath)).toBe(false);
  expect(existsSync(join(root, 'bin', 'gbrain'))).toBe(false);
  expect(readFileSync(join(root, 'personal-note.md'), 'utf8')).toBe('keep this');
  expect(readFileSync(join(root, '.gbrain', 'harness-connection.json'), 'utf8')).not.toContain(credentials.client_secret!);
});

test('thin setup resumes a recorded interrupted file write without claiming arbitrary edits', async () => {
  const root = temp();
  await installHarnessConnection(credentials, { harness: 'grok-bot', root });
  const path = 'GBRAIN-INSTRUCTIONS.md'; const target = join(root, path);
  const generated = readFileSync(target, 'utf8');
  const receiptPath = join(root, '.gbrain', 'harness-connection.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const staged = generated + '\ninterrupted generated revision\n';
  receipt.pending_files = { [path]: { before: sha256(generated), after: sha256(staged) } };
  writeFileSync(receiptPath, JSON.stringify(receipt)); writeFileSync(target, staged);
  await installHarnessConnection(credentials, { harness: 'grok-bot', root });
  expect(readFileSync(target, 'utf8')).toBe(generated);
  expect(JSON.parse(readFileSync(receiptPath, 'utf8')).pending_files).toEqual({});
});

for (const harness of ['codex', 'opencode']) test(`${harness} refuses edited and same-URL unowned entries`, async () => {
  const root = temp(); const configPath = join(root, harness === 'codex' ? 'config.toml' : 'config.jsonc');
  await installHarnessConnection(credentials, { harness, configPath });
  const original = readFileSync(configPath, 'utf8');
  writeFileSync(configPath, original.replace('fixture-token-not-real', 'edited-token'));
  await expect(installHarnessConnection(credentials, { harness, configPath })).rejects.toThrow('edited');
  await expect(installHarnessConnection(credentials, { harness, configPath, remove: true })).rejects.toThrow('edited');
  writeFileSync(configPath, original);
  rmSync(join(root, `.gbrain-connection-${harness}-gbrain.json`));
  await expect(installHarnessConnection(credentials, { harness, configPath })).rejects.toThrow('unowned');
  expect(readFileSync(configPath, 'utf8')).toBe(original);
});

test('credentials and roots reject intermediate symlinks and credential-bearing issuer URLs', async () => {
  const root = temp(); const real = join(root, 'real'); mkdirSync(real);
  symlinkSync(real, join(root, 'alias'));
  writeFileSync(join(real, 'credentials.json'), JSON.stringify(credentials), { mode: 0o600 });
  expect(() => readCredentials(join(root, 'alias', 'credentials.json'))).toThrow('symlink');
  await expect(installHarnessConnection(credentials, { harness: 'muse', root: join(root, 'alias', 'new') })).rejects.toThrow('symlink');
  expect(existsSync(join(real, 'new'))).toBe(false);
  expect(() => validateCredentials({ ...credentials, issuer_url: 'https://secret@brain.example.com' })).toThrow('credentials');
  expect(() => validateCredentials({ ...credentials, issuer_url: 'https://brain.example.com?token=private' })).toThrow('query');
});
