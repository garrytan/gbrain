import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkedManagedPaths, checkedRoot, confinedPath, isolatedAgentEnv, readFileConfigState } from '../src/core/agent-install/state.ts';
import { renderAgentLauncher } from '../src/core/agent-install/launcher.ts';
import { extractPgliteDump, readBackupArchive, writeBackupArchive } from '../src/core/backup/archive.ts';
import { AGENT_ENV_SHELL_PATTERN, shouldDropAgentEnv } from '../src/core/agent-install/environment.ts';
import { listRecipes } from '../src/core/ai/recipes/index.ts';

let temporary: string;
beforeEach(() => { temporary = mkdtempSync(join(tmpdir(), 'gbrain-agent-files-')); });
afterEach(() => { rmSync(temporary, { recursive: true, force: true }); });

test('absolute root and archive paths refuse traversal and intermediate symlinks', () => {
  expect(() => checkedRoot('relative')).toThrow('absolute');
  expect(() => checkedRoot('/tmp/../elsewhere')).toThrow('traversal');
  symlinkSync(temporary, join(temporary, 'alias'));
  expect(() => checkedRoot(join(temporary, 'alias', 'child'))).toThrow('symlink');
  expect(() => confinedPath(temporary, '../escape')).toThrow();
  expect(() => confinedPath(temporary, 'a\\b')).toThrow();
  expect(() => checkedManagedPaths(temporary, ['.gbrain/credential-deliveries'])).toThrow();
  expect(() => checkedManagedPaths(temporary, ['memory', 'memory/files'])).toThrow();
});

test('configuration classification never treats malformed existing content as absent', () => {
  const path = join(temporary, 'config.json');
  expect(readFileConfigState(path).kind).toBe('absent');
  writeFileSync(path, '{broken');
  expect(readFileConfigState(path).kind).toBe('invalid');
  writeFileSync(path, '[]');
  expect(readFileConfigState(path).kind).toBe('invalid');
});

test('installer environment drops ambient brain and provider overrides without changing inherited values', () => {
  const inherited = { PATH: '/bin', HOME: '/home/example', DATABASE_URL: 'postgres://foreign', GBRAIN_DATABASE_URL: 'postgres://other', GBRAIN_BRAIN_ID: 'foreign', GBRAIN_SOURCE: 'other', OPENAI_API_KEY: 'private-key', OPENAI_BASE_URL: 'https://ambient.invalid', AZURE_OPENAI_USE_ENTRA: 'true', NODE_OPTIONS: '--require arbitrary' };
  const env = isolatedAgentEnv(temporary, inherited);
  expect(env.GBRAIN_HOME).toBe(temporary);
  expect(env.GBRAIN_BRAIN_ID).toBe('host');
  expect(env.DATABASE_URL).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.OPENAI_BASE_URL).toBeUndefined();
  expect(env.AZURE_OPENAI_USE_ENTRA).toBeUndefined();
  expect(env.PATH).toBe('/bin');
  expect(inherited.DATABASE_URL).toBe('postgres://foreign');
});

test('production setup policy covers recipe settings and the standalone shell uses the same policy', () => {
  const settings = listRecipes().flatMap(recipe => [...(recipe.auth_env?.required ?? []), ...(recipe.auth_env?.optional ?? [])]);
  expect(settings.filter(key => !shouldDropAgentEnv(key))).toEqual([]);
  for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_BASE_URL', 'GEMINI_API_KEY']) expect(shouldDropAgentEnv(key)).toBe(true);
  const trampoline = readFileSync(new URL('../scripts/setup-in-agent.sh', import.meta.url), 'utf8');
  expect(trampoline).toContain(`${AGENT_ENV_SHELL_PATTERN}) unset "$gbrain_env_name" ;;`);
});

test('real launcher pairs private configured keys only with private configured provider endpoints', async () => {
  const home = join(temporary, '.gbrain'); mkdirSync(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ engine: 'pglite', anthropic_api_key: 'private-anthropic-fixture',
    provider_base_urls: { anthropic: 'https://private-anthropic.example/v1', openai: 'https://private-openai.example/v1' } }));
  // Private per-install .env remains usable after ambient provider state is
  // scrubbed; a blanket empty-value export would break this supported channel.
  writeFileSync(join(home, '.env'), 'OPENAI_API_KEY=private-openai-fixture\n', { mode: 0o600 });
  const gatewayModule = new URL('../src/core/ai/build-gateway-config.ts', import.meta.url).pathname;
  const configModule = new URL('../src/core/config.ts', import.meta.url).pathname;
  const probe = join(temporary, 'gateway-probe.ts');
  writeFileSync(probe, `import { buildGatewayConfig } from ${JSON.stringify(gatewayModule)};
import { loadConfig } from ${JSON.stringify(configModule)};
const cfg = buildGatewayConfig(loadConfig()!);
console.log(JSON.stringify({ anthropic: cfg.env.ANTHROPIC_BASE_URL, openai: cfg.env.OPENAI_BASE_URL,
  privateAnthropicKey: cfg.env.ANTHROPIC_API_KEY === 'private-anthropic-fixture',
  privateOpenAIKey: cfg.env.OPENAI_API_KEY === 'private-openai-fixture',
  azure: cfg.env.AZURE_OPENAI_ENDPOINT ?? null, ollama: cfg.base_urls?.ollama ?? null,
  authToken: cfg.env.ANTHROPIC_AUTH_TOKEN ?? null, organization: cfg.env.OPENAI_ORG_ID ?? null }));\n`);
  const launcher = join(temporary, 'gbrain');
  writeFileSync(launcher, renderAgentLauncher({ root: temporary, bunPath: process.execPath, cliPath: probe }), { mode: 0o700 });
  const hostile = { ANTHROPIC_BASE_URL: 'https://ambient.invalid', OPENAI_BASE_URL: 'https://ambient.invalid',
    ANTHROPIC_API_KEY: 'ambient-key', OPENAI_API_KEY: 'ambient-key', ANTHROPIC_AUTH_TOKEN: 'ambient-token',
    OPENAI_ORG_ID: 'ambient-tenant', AZURE_OPENAI_ENDPOINT: 'https://ambient.invalid', OLLAMA_BASE_URL: 'https://ambient.invalid' };
  const child = Bun.spawn(['bash', launcher], { cwd: '/', env: { ...process.env, ...hostile }, stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(output)).toEqual({ anthropic: 'https://private-anthropic.example/v1', openai: 'https://private-openai.example/v1',
    privateAnthropicKey: true, privateOpenAIKey: true, azure: null, ollama: null, authToken: null, organization: null });
});

test('missing runtime reports the recovery owned by its installer', async () => {
  const launcher = join(temporary, 'gbrain');
  writeFileSync(launcher, renderAgentLauncher({ root: temporary, bunPath: join(temporary, 'missing'),
    repairHint: 'Reinstall GBrain, then repeat connect with your private handoff.' }), { mode: 0o700 });
  const child = Bun.spawn(['bash', launcher], { stdout: 'pipe', stderr: 'pipe' });
  const errors = await new Response(child.stderr).text();
  expect(await child.exited).toBe(1);
  expect(errors).toContain('repeat connect with your private handoff');
  expect(errors).not.toContain('gbrain-setup');
});

test('generated executable launcher really scrubs environment and survives a hostile cwd', async () => {
  const executable = join(temporary, 'fake-gbrain');
  writeFileSync(executable, '#!/usr/bin/env bash\nprintf "%s\\n" "$GBRAIN_HOME" "$GBRAIN_BRAIN_ID" "$GBRAIN_SOURCE" "$DATABASE_URL" "${OPENAI_API_KEY-unset}" "$PWD" "$@"\n', { mode: 0o700 });
  const launcher = join(temporary, 'gbrain');
  writeFileSync(launcher, renderAgentLauncher({ root: temporary, bunPath: executable }), { mode: 0o700 });
  const child = Bun.spawn(['bash', launcher, 'recall', 'example'], { cwd: '/', env: { ...process.env, DATABASE_URL: 'postgres://foreign', GBRAIN_SOURCE: 'foreign', OPENAI_API_KEY: 'private' }, stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output.split('\n')).toEqual([temporary, 'host', 'default', '', 'unset', temporary, '--brain', 'host', 'recall', 'example', '']);
});

test('private archive round trip verifies exact bytes and refuses an existing output', () => {
  const source = join(temporary, 'source'); writeFileSync(source, 'private memory\n');
  const archive = join(temporary, 'snapshot.gbrain-backup');
  writeBackupArchive(archive, { kind: 'test' }, [{ path: 'memory/fact.txt', file: source }]);
  expect(statSync(archive).mode & 0o777).toBe(0o600);
  expect(() => writeBackupArchive(archive, {}, [{ path: 'other', file: source }])).toThrow();
  const into = join(temporary, 'into'); mkdirSync(into, { mode: 0o700 });
  readBackupArchive(archive, into);
  expect(readFileSync(join(into, 'memory', 'fact.txt'), 'utf8')).toBe('private memory\n');
  expect(statSync(join(into, 'memory', 'fact.txt')).mode & 0o777).toBe(0o600);
});

test('corrupt archive fails checksum and untrusted manifest paths cannot escape', () => {
  const source = join(temporary, 'source'); writeFileSync(source, 'original');
  const archive = join(temporary, 'snapshot');
  writeBackupArchive(archive, {}, [{ path: 'memory', file: source }]);
  const bytes = readFileSync(archive); bytes[bytes.length - 1] ^= 1; writeFileSync(archive, bytes);
  const into = join(temporary, 'into'); mkdirSync(into);
  expect(() => readBackupArchive(archive, into)).toThrow('checksum');
  expect(() => writeBackupArchive(join(temporary, 'unsafe'), {}, [{ path: '../escaped', file: source }])).toThrow();
  expect(existsSync(join(temporary, 'escaped'))).toBe(false);
});

test('hostile archive manifests and PGLite tar links are rejected before filesystem escape', () => {
  const archive = join(temporary, 'hostile');
  const manifest = Buffer.from(JSON.stringify({ format_version: 1, entries: [{ path: '../escaped', size: 0, sha256: '0'.repeat(64) }] }));
  const length = Buffer.alloc(4); length.writeUInt32BE(manifest.length);
  writeFileSync(archive, Buffer.concat([Buffer.from('GBRAIN-BACKUP-1\n'), length, manifest]));
  const into = join(temporary, 'into'); mkdirSync(into);
  expect(() => readBackupArchive(archive, into)).toThrow('Invalid managed relative path');
  const header = Buffer.alloc(512);
  header.write('unsafe-link'); header.write('00000000000\0', 124); header[156] = 50;
  header.fill(32, 148, 156);
  header.write(header.reduce((n, byte) => n + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  writeFileSync(archive, Buffer.concat([header, Buffer.alloc(1024)]));
  expect(() => extractPgliteDump(archive, into)).toThrow('unsupported entry type');
  expect(existsSync(join(temporary, 'escaped'))).toBe(false);
});
