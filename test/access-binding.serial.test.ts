/**
 * GBRA-218 A1 identity: the operator CLI as real subprocesses against a
 * repo-less PGLite brain on disk (no git checkout).
 *
 * 1. Protects: `gbrain auth create|rescope|register-client --member` binds a
 *    credential to an enabled member and refuses an unknown one before any
 *    credential is minted or changed; `--member none` unbinds; `--dry-run`
 *    writes no binding; `--may-act-for` is stored normalized; `gbrain access
 *    member rm` previews without `--yes` and a removed id is refused on re-add
 *    with access_member_id_retired (the contract envelope under --json).
 * 2. Fails when: a typo mints an unbound token, a rescope preview writes, a
 *    removed id is reused, or the refusal loses its code.
 * 3. Existing coverage: test/access-members.test.ts (the service in process).
 * 4. Real seams: src/cli.ts subprocesses, the PGLite file lock, the generated
 *    flag registry.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEngine } from '../src/core/engine-factory.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

const CLI = join(resolve(import.meta.dir, '..'), 'src', 'cli.ts');
let root: string, home: string, db: string;

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) delete out[key];
  return { ...out, HOME: home, GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0' };
}

async function cli(args: string[], stdin?: string) {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env: env(), stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

async function withBrain<T>(run: (engine: BrainEngine) => Promise<T>): Promise<T> {
  const config = { engine: 'pglite' as const, database_path: db };
  const engine = await createEngine(config);
  await engine.connect(config);
  try { return await run(engine); } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
}

/** A repo-less PGLite brain on disk (no git checkout), the default keyless install. */
async function makeBrain(prefix: string, seed: (engine: BrainEngine) => Promise<void>): Promise<void> {
  root = mkdtempSync(join(tmpdir(), prefix));
  home = join(root, 'home');
  db = join(root, 'db');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: db }));
  await withBrain(async engine => { await engine.initSchema(); await seed(engine); });
}

async function binding(table: 'access_tokens' | 'oauth_clients', key: string, value: string) {
  return withBrain(async engine => (await engine.executeRaw<{ member_id: string | null; may_act_for: string[] | null }>(
    `SELECT member_id, may_act_for FROM ${table} WHERE ${key} = $1`, [value]))[0]);
}

beforeAll(async () => {
  await makeBrain('gb-access-binding-', async engine => {
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-a', 'source-a') ON CONFLICT DO NOTHING");
  });
}, 120_000);

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('access and auth binding CLI (repo-less PGLite)', () => {
  test('member add, then auth create --member binds the new token', async () => {
    const added = await cli(['access', 'member', 'add', 'alice-example', '--name', 'Alice Example', '--groups', 'team-a']);
    expect(added.exitCode).toBe(0);
    expect(added.stdout).toContain('Member added: alice-example');
    expect((await cli(['access', 'member', 'add', 'bob-example'])).exitCode).toBe(0);
    const created = await cli(['auth', 'create', 'alice-laptop', '--scopes', 'read', '--member', 'alice-example']);
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain('Member: alice-example');
    expect(await binding('access_tokens', 'name', 'alice-laptop')).toEqual({ member_id: 'alice-example', may_act_for: null });
  }, 120_000);

  test('an unknown --member is refused before any token is minted', async () => {
    const refused = await cli(['auth', 'create', 'typo-laptop', '--scopes', 'read', '--member', 'alise-example', '--json']);
    expect(refused.exitCode).not.toBe(0);
    expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'access_member_invalid', reason: 'unknown' });
    expect(await binding('access_tokens', 'name', 'typo-laptop')).toBeUndefined();
  }, 120_000);

  test('auth rescope --member rebinds, --dry-run writes nothing, --member none unbinds, --may-act-for is stored normalized', async () => {
    expect((await cli(['auth', 'create', 'shared-bot', '--scopes', 'read'])).exitCode).toBe(0);
    const preview = await cli(['auth', 'rescope', '--token', 'shared-bot', '--member', 'bob-example', '--dry-run']);
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain('preview, not written');
    expect(await binding('access_tokens', 'name', 'shared-bot')).toEqual({ member_id: null, may_act_for: null });
    const bound = await cli(['auth', 'rescope', '--token', 'shared-bot', '--member', 'bob-example', '--may-act-for', 'Alice-Example,group:team-a', '--json']);
    expect(bound.exitCode).toBe(0);
    expect(JSON.parse(bound.stdout).binding).toEqual({ member: 'bob-example', may_act_for: ['group:team-a', 'member:alice-example'], changed: true });
    expect(await binding('access_tokens', 'name', 'shared-bot')).toEqual({ member_id: 'bob-example', may_act_for: ['group:team-a', 'member:alice-example'] });
    expect((await cli(['auth', 'rescope', '--token', 'shared-bot', '--member', 'none', '--may-act-for', 'none'])).exitCode).toBe(0);
    expect(await binding('access_tokens', 'name', 'shared-bot')).toEqual({ member_id: null, may_act_for: null });
    const bad = await cli(['auth', 'rescope', '--token', 'shared-bot', '--member', 'Not Valid!']);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain('access_member_invalid');
  }, 180_000);

  test('auth register-client --member binds the new OAuth client', async () => {
    const registered = await cli(['auth', 'register-client', 'client-a-example', '--scopes', 'read', '--member', 'alice-example']);
    expect(registered.exitCode).toBe(0);
    const clientId = (registered.stdout.match(/gbrain_cl_[A-Za-z0-9_-]+/) ?? [''])[0];
    expect(clientId).not.toBe('');
    expect(await binding('oauth_clients', 'client_id', clientId)).toEqual({ member_id: 'alice-example', may_act_for: null });
    const rebound = await cli(['auth', 'rescope', '--client', clientId, '--member', 'bob-example']);
    expect(rebound.exitCode).toBe(0);
    expect(await binding('oauth_clients', 'client_id', clientId)).toEqual({ member_id: 'bob-example', may_act_for: null });
  }, 120_000);

  test('access check reports the binding; member rm previews, --yes removes, and the id is never reused', async () => {
    const check = await cli(['access', 'check', '--token', 'alice-laptop', '--json']);
    expect(check.exitCode).toBe(0);
    expect(JSON.parse(check.stdout)).toMatchObject({ verdict: 'reads_as_member', identity: ['group:team-a', 'member:alice-example'] });
    const preview = await cli(['access', 'member', 'rm', 'alice-example', '--json']);
    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ applied: false, member: { status: 'enabled' }, bound_credentials: [expect.objectContaining({ kind: 'token', name: 'alice-laptop' })] });
    expect((await cli(['access', 'member', 'rm', 'alice-example', '--yes'])).exitCode).toBe(0);
    expect(JSON.parse((await cli(['access', 'check', '--token', 'alice-laptop', '--json'])).stdout)).toMatchObject({ verdict: 'refused' });
    const readd = await cli(['access', 'member', 'add', 'alice-example', '--json']);
    expect(readd.exitCode).not.toBe(0);
    expect(JSON.parse(readd.stdout)).toMatchObject({ code: 'access_member_id_retired', docs: expect.stringContaining('docs/guides/write-refusals.md#access_member_id_retired') });
  }, 180_000);
});
