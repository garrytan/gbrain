import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { load, dump } from 'js-yaml';
import { installHermesPlugin } from '../src/core/harness/hermes.ts';
import { acquireHermesSetupLock, HERMES_SETUP_LOCK_STALE_MS } from '../src/core/harness/hermes-lock.ts';
import { run as runHermesCommand } from '../src/cli/commands/hermes.ts';

const assets = { 'plugin.yaml': 'name: gbrain\n', '__init__.py': '# synthetic plugin\n', 'skills/brain-ops/SKILL.md': '# synthetic skill\n' };
const text = (path: string) => readFileSync(path, 'utf8');
const config = (home: string) => load(text(join(home, 'config.yaml'))) as any;
async function withHome(run: (home: string) => Promise<void>) {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'gbrain-hermes-install-test-'));
  try { await run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

test('real YAML installation preserves unrelated config, env and identity while adding full native MCP', async () => withHome(async home => {
  writeFileSync(join(home, 'config.yaml'), 'memory:\n  provider: builtin\n  custom: retained\nmodel:\n  default: example-model\n');
  writeFileSync(join(home, '.env'), 'OTHER_KEY=retained\n', { mode: 0o600 });
  writeFileSync(join(home, 'SOUL.md'), 'original identity\n');
  const receipt = await installHermesPlugin({ home, url: 'http://127.0.0.1:3456/mcp', token: 'synthetic-token-one', assets });
  const value = config(home);
  assert.equal(value.memory.provider, 'gbrain');
  assert.deepEqual(value.memory.gbrain, { url: 'http://127.0.0.1:3456/mcp', capture: false });
  assert.equal(value.memory.custom, 'retained');
  assert.equal(value.model.default, 'example-model');
  assert.equal(value.mcp_servers.gbrain.headers.Authorization, 'Bearer ${GBRAIN_MCP_TOKEN}');
  assert.deepEqual(value.mcp_servers.gbrain.tools, { resources: true, prompts: false });
  assert.equal(text(join(home, 'SOUL.md')), 'original identity\n');
  assert.match(text(join(home, '.env')), /^OTHER_KEY=retained\nGBRAIN_MCP_TOKEN="synthetic-token-one"\n$/);
  assert.equal(receipt.native_harness_verified, false);
  assert.match(String(receipt.message), /Restart this Hermes profile/);
  assert.equal('next_action' in receipt, false);
  for (const path of ['config.yaml', '.env', '.gbrain-hermes/receipt.json', '.gbrain-hermes/config.before.yaml']) {
    assert.equal(lstatSync(join(home, path)).mode & 0o777, 0o600);
  }
  assert.equal(JSON.stringify(receipt).includes('synthetic-token-one'), false);
  assert.equal(text(join(home, 'skills/brain-ops/SKILL.md')), assets['skills/brain-ops/SKILL.md']);
}));

test('idempotent reinstall and credential renewal retain original removal ownership', async () => withHome(async home => {
  writeFileSync(join(home, 'config.yaml'), 'memory:\n  provider: builtin\n');
  await installHermesPlugin({ home, url: 'https://brain.example/mcp', token: 'synthetic-one', assets });
  await installHermesPlugin({ home, url: 'https://brain.example/mcp', token: 'synthetic-one', assets });
  await installHermesPlugin({ home, url: 'https://brain.example/mcp', token: 'synthetic-two', assets });
  assert.match(text(join(home, '.env')), /synthetic-two/);
  const value = config(home); value.extra = { retained: true };
  writeFileSync(join(home, 'config.yaml'), dump(value));
  writeFileSync(join(home, '.env'), text(join(home, '.env')) + 'NEW_KEY=retained\n', { mode: 0o600 });
  await installHermesPlugin({ home, remove: true });
  assert.equal(config(home).memory.provider, 'builtin');
  assert.equal(config(home).memory.gbrain, undefined);
  assert.equal(config(home).mcp_servers, undefined);
  assert.deepEqual(config(home).extra, { retained: true });
  assert.equal(text(join(home, '.env')), 'NEW_KEY=retained\n');
  assert.equal(existsSync(join(home, 'plugins/gbrain/plugin.yaml')), false);
  assert.equal(existsSync(join(home, 'skills/brain-ops/SKILL.md')), false);
}));

test('removal succeeds after gbrain is disabled and preserves disabled and unrelated config', async () => withHome(async home => {
  writeFileSync(join(home, 'config.yaml'), 'plugins:\n  disabled:\n    - unrelated-plugin\nmodel:\n  default: example-model\n');
  await installHermesPlugin({ home, url: 'https://brain.example/mcp', token: 'synthetic-owned-token', assets });
  const value = config(home);
  value.plugins.disabled.push('gbrain');
  value.extra = { retained: true };
  writeFileSync(join(home, 'config.yaml'), dump(value));

  await installHermesPlugin({ home, remove: true });

  assert.deepEqual(config(home).plugins.disabled, ['unrelated-plugin', 'gbrain']);
  assert.deepEqual(config(home).model, { default: 'example-model' });
  assert.deepEqual(config(home).extra, { retained: true });
  assert.equal(config(home).memory, undefined);
  assert.equal(config(home).mcp_servers, undefined);
  assert.equal(text(join(home, '.env')), '');
  assert.equal(existsSync(join(home, 'plugins/gbrain/plugin.yaml')), false);
  assert.equal(existsSync(join(home, 'plugins/gbrain/__init__.py')), false);
  assert.equal(existsSync(join(home, 'skills/brain-ops/SKILL.md')), false);
}));

test('existing profile token remains unchanged and is never adopted for removal', async () => withHome(async home => {
  const original = 'GBRAIN_MCP_TOKEN="existing-synthetic-token"\nOTHER=keep\n';
  writeFileSync(join(home, '.env'), original, { mode: 0o600 });
  await installHermesPlugin({ home, url: 'https://brain.example/mcp', assets });
  assert.equal(text(join(home, '.env')), original);
  await installHermesPlugin({ home, remove: true });
  assert.equal(text(join(home, '.env')), original);
}));

test('preflight refuses foreign config or disabled plugins without overwriting state', async () => withHome(async home => {
  for (const initial of ['memory:\n  gbrain:\n    url: https://foreign.example/mcp\n', 'plugins:\n  gbrain:\n    enabled: false\n']) {
    writeFileSync(join(home, 'config.yaml'), initial);
    await assert.rejects(installHermesPlugin({ home, url: 'https://brain.example/mcp', token: 'synthetic', assets }), /configuration_conflict/);
    assert.equal(text(join(home, 'config.yaml')), initial);
    assert.equal(existsSync(join(home, 'plugins/gbrain/plugin.yaml')), false);
    assert.equal(existsSync(join(home, '.env')), false);
  }
}));

test('owned edits block removal before any owned file is deleted', async () => withHome(async home => {
  await installHermesPlugin({ home, url: 'https://brain.example/mcp', token: 'synthetic', assets });
  const before = text(join(home, 'config.yaml'));
  writeFileSync(join(home, 'skills/brain-ops/SKILL.md'), '# local edit\n');
  await assert.rejects(installHermesPlugin({ home, remove: true }), /configuration_conflict/);
  assert.equal(text(join(home, 'config.yaml')), before);
  assert.equal(existsSync(join(home, 'plugins/gbrain/plugin.yaml')), true);
  assert.equal(text(join(home, 'skills/brain-ops/SKILL.md')), '# local edit\n');
}));

test('profile symlink, remote plaintext, missing profile credentials and public token storage refuse', async () => withHome(async home => {
  const link = join(home, 'config.yaml');
  symlinkSync(join(home, 'outside.yaml'), link);
  await assert.rejects(installHermesPlugin({ home, url: 'https://brain.example/mcp', token: 'synthetic', assets }), /symlink/);
  rmSync(link);
  await assert.rejects(installHermesPlugin({ home, url: 'http://brain.example/mcp', token: 'synthetic', assets }), /invalid_url/);
  await assert.rejects(installHermesPlugin({ home, url: 'https://brain.example/mcp', assets }), /credential_required/);
  writeFileSync(join(home, '.env'), 'GBRAIN_MCP_TOKEN=synthetic\n'); chmodSync(join(home, '.env'), 0o644);
  await assert.rejects(installHermesPlugin({ home, url: 'https://brain.example/mcp', assets }), /private/);
}));

test('prepared receipts recover an interrupted asset upgrade and keep original provider', async () => withHome(async home => {
  writeFileSync(join(home, 'config.yaml'), 'memory:\n  provider: builtin\n');
  await installHermesPlugin({ home, url: 'https://brain.example/mcp', token: 'synthetic', assets });
  const receiptPath = join(home, '.gbrain-hermes/receipt.json');
  const receipt = JSON.parse(text(receiptPath));
  receipt.state = 'prepared';
  const owned = receipt.files['plugins/gbrain/__init__.py'];
  owned.previousAfter = owned.after;
  owned.after = createHash('sha256').update('# new synthetic plugin\n').digest('hex');
  receipt.env.previousAfter = receipt.env.after;
  receipt.env.after = 'GBRAIN_MCP_TOKEN="synthetic-renewed"';
  writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  await installHermesPlugin({ home, url: 'https://brain.example/mcp', token: 'synthetic-renewed', assets: { ...assets, '__init__.py': '# new synthetic plugin\n' } });
  assert.equal(config(home).memory.gbrain.url, 'https://brain.example/mcp');
  assert.equal(text(join(home, 'plugins/gbrain/__init__.py')), '# new synthetic plugin\n');
  await installHermesPlugin({ home, remove: true });
  assert.equal(config(home).memory.provider, 'builtin');
  assert.equal(existsSync(join(home, 'plugins/gbrain/__init__.py')), false);
}));

test('quoted empty and comment-only profile token assignments refuse before config writes', async () => withHome(async home => {
  for (const assignment of ['GBRAIN_MCP_TOKEN=""', "GBRAIN_MCP_TOKEN=''", 'GBRAIN_MCP_TOKEN=# comment', 'GBRAIN_MCP_TOKEN="   "']) {
    writeFileSync(join(home, '.env'), assignment + '\n', { mode: 0o600 });
    await assert.rejects(installHermesPlugin({ home, url: 'https://brain.example/mcp', assets }), /credential_required/);
    assert.equal(text(join(home, '.env')), assignment + '\n');
    assert.equal(existsSync(join(home, 'config.yaml')), false);
    assert.equal(existsSync(join(home, 'plugins/gbrain/plugin.yaml')), false);
  }
}));

test('different generic handoff identity or endpoint cannot reinstall or remove another connection', async () => withHome(async home => {
  await installHermesPlugin({ home, url: 'https://brain.example/mcp', token: 'synthetic', clientId: 'client-a', assets });
  const paths = ['config.yaml', '.env', '.gbrain-hermes/receipt.json', 'plugins/gbrain/__init__.py'];
  const before = paths.map(path => text(join(home, path)));
  for (const options of [
    { clientId: 'client-b', url: 'https://brain.example/mcp', token: 'new-synthetic' },
    { clientId: 'client-b', url: 'https://brain.example/mcp', remove: true },
    { clientId: 'client-a', url: 'https://other.example/mcp', token: 'new-synthetic' },
    { url: 'https://other.example/mcp', token: 'new-synthetic' },
  ]) {
    await assert.rejects(installHermesPlugin({ home, assets, ...options }), /another client or endpoint/);
    assert.deepEqual(paths.map(path => text(join(home, path))), before);
  }
  await installHermesPlugin({ home, url: 'https://brain.example/mcp', token: 'renewed-synthetic', clientId: 'client-a', assets });
  assert.match(text(join(home, '.env')), /renewed-synthetic/);
}));

test('canonical skill retirement removes only unchanged obsolete package assets', async () => withHome(async home => {
  await installHermesPlugin({ home, url: 'https://brain.example/mcp', token: 'synthetic', assets: { ...assets, 'skills/old-memory/SKILL.md': '# retired skill\n' } });
  await installHermesPlugin({ home, url: 'https://brain.example/mcp', token: 'synthetic', assets });
  assert.equal(existsSync(join(home, 'skills/old-memory/SKILL.md')), false);
  assert.equal(existsSync(join(home, 'skills/brain-ops/SKILL.md')), true);
}));

test('setup retries an interrupted install after a provably dead stale owner', async () => withHome(async home => {
  await installHermesPlugin({ home, url: 'https://brain.example/mcp', token: 'synthetic', assets });
  const receiptPath = join(home, '.gbrain-hermes/receipt.json');
  const receipt = JSON.parse(text(receiptPath)); receipt.state = 'prepared';
  writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.equal(child.status, 0);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  const lock = join(home, '.gbrain-hermes/setup.lock'); mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: child.pid, host: hostname(), acquired_at: Date.now() - HERMES_SETUP_LOCK_STALE_MS - 1000, token: 'dead-synthetic-owner' }), { mode: 0o600 });
  await installHermesPlugin({ home, url: 'https://brain.example/mcp', token: 'renewed-synthetic', assets });
  assert.equal(JSON.parse(text(receiptPath)).state, 'installed');
  assert.match(text(join(home, '.env')), /renewed-synthetic/);
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(lock + '.reap'), false);
}));

test('live, young, foreign and unidentified setup owners are preserved without profile writes', async () => withHome(async home => {
  const lock = join(home, '.gbrain-hermes/setup.lock'); mkdirSync(lock, { recursive: true, mode: 0o700 });
  const child = spawnSync(process.execPath, ['-e', '']); assert.equal(child.status, 0);
  const old = Date.now() - HERMES_SETUP_LOCK_STALE_MS - 1000;
  for (const owner of [
    { pid: process.pid, host: hostname(), acquired_at: old, token: 'live-owner' },
    { pid: child.pid, host: hostname(), acquired_at: Date.now(), token: 'young-owner' },
    { pid: child.pid, host: 'foreign-host.invalid', acquired_at: old, token: 'foreign-owner' },
    null,
  ]) {
    const metadata = join(lock, 'owner.json');
    if (owner) writeFileSync(metadata, JSON.stringify(owner), { mode: 0o600 });
    else rmSync(metadata);
    await assert.rejects(installHermesPlugin({ home, url: 'https://brain.example/mcp', token: 'synthetic', assets }), /lock owner is live or unverified/);
    assert.equal(existsSync(lock), true);
    if (owner) assert.deepEqual(JSON.parse(text(metadata)), owner);
    assert.equal(existsSync(join(home, 'config.yaml')), false);
    assert.equal(existsSync(join(home, '.env')), false);
    assert.equal(existsSync(join(home, 'plugins/gbrain/plugin.yaml')), false);
  }
}));

test('releasing a replaced setup-lock handle preserves the new owner', async () => withHome(async home => {
  const path = join(home, 'setup.lock'); const lock = acquireHermesSetupLock(path);
  const metadata = join(path, 'owner.json');
  const replacement = { ...JSON.parse(text(metadata)), token: 'different-live-owner' };
  writeFileSync(metadata, JSON.stringify(replacement), { mode: 0o600 });
  lock.release();
  assert.equal(existsSync(path), true);
  assert.deepEqual(JSON.parse(text(metadata)), replacement);
}));

test('Hermes setup dispatch completes without opening a brain engine', async t => withHome(async home => {
  let opens = 0;
  t.mock.method(console, 'log', () => {});
  await runHermesCommand(['setup', '--help'], {
    connectEngine: async () => { opens++; throw new Error('setup must not open a brain'); },
  } as any);
  assert.equal(opens, 0);
  assert.equal(existsSync(join(home, 'config.yaml')), false);
}));
