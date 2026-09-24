import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packagedSharedSkills } from '../src/core/shared-skills/setup-bundle.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { joinBrain } from '../src/core/shared-skills/membership.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function temp() { const path = mkdtempSync(join(tmpdir(), 'gbrain-shared-init-')); directories.push(path); return path; }

async function init(home: string, args: string[] = [], binary?: string) {
  const command = binary ? [binary] : [process.execPath, join(import.meta.dir, '../src/cli.ts')];
  const env = { ...process.env, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1' };
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_BRAIN_ID', 'GBRAIN_IN_AGENT_SETUP']) delete env[key as keyof typeof env];
  const child = Bun.spawn([...command, 'init', '--pglite', '--no-embedding', '--non-interactive', '--json', ...args], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, error: code ? stderr + stdout : '' }).toEqual({ code: 0, error: '' });
  const result = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(row => row.status === 'success');
  expect(result).toBeDefined();
  return result;
}

describe('real combined brain initialization', () => {
  test('fresh ordinary init publishes packaged files and resumes without overwriting knowledge', async () => {
    const home = temp();
    const first = await init(home);
    expect(first.content.status).toBe('ready');
    expect(first.content.repository_kind).toBe('content_directory');
    expect(first.content.root).toBe(join(home, '.gbrain', 'content', first.content.brain_id, 'default'));
    expect(existsSync(join(first.content.root, '.git'))).toBe(false);
    for (const [path, body] of Object.entries(packagedSharedSkills())) {
      expect(existsSync(join(first.content.root, path))).toBe(true);
      if (path !== 'skillpack.json') expect(readFileSync(join(first.content.root, path), 'utf8')).toBe(body);
    }
    const manifest = JSON.parse(readFileSync(join(first.content.root, 'skillpack.json'), 'utf8'));
    expect(manifest.provenance.release).toBe(JSON.parse(packagedSharedSkills()['skillpack.json']).version);
    const second = await init(home);
    expect(second.content.root).toBe(first.content.root);
    expect(second.content.brain_id).toBe(first.content.brain_id);
    expect(second.content.status).toBe('ready');
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const engine = new PGLiteEngine();
      try {
        await engine.connect({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') });
        const joined = await joinBrain({ engine, config: { engine: 'pglite', mcp: { publish_skills: true } }, sourceId: 'default', remote: false, dryRun: false,
          logger: { info() {}, warn() {}, error() {} } }, { adapter: 'generic', follow_policy: { approved: true } });
        expect(joined.skills).toHaveLength(3);
        expect(joined.blocked_skills).toEqual([]);
        expect(joined.status).toBe('catalog_visible');
        expect(joined.delivery.native).toBe('unverified');
        const scopes = ['read', 'write', 'skills_member_self'];
        const operations = ['join_brain', 'sync_brain_skills', 'leave_brain', 'list_skills', 'get_skill', 'get_skill_asset', 'recall', 'remember', 'forget'];
        const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
        const client = await provider.registerClientManual('fresh-follow-fixture', ['client_credentials'], scopes.join(' '), [], 'default');
        await engine.executeRaw('UPDATE oauth_clients SET allowed_operations=$2::text[] WHERE client_id=$1', [client.clientId, operations]);
        const remote = await joinBrain({ engine, config: { engine: 'pglite', mcp: { publish_skills: true } }, sourceId: 'default', remote: true, dryRun: false,
          logger: { info() {}, warn() {}, error() {} }, auth: { token: '', clientId: client.clientId, principal: { kind: 'oauth_client', id: client.clientId }, scopes, issuedScopes: scopes,
            allowedOperations: operations, sourceId: 'default', allowedSources: ['default'] } }, { adapter: 'generic', follow_policy: { approved: true } });
        expect(remote.skills).toHaveLength(3);
        expect(remote.blocked_skills).toEqual([]);
        expect(remote.status).toBe('catalog_visible');
        const [policy] = await engine.executeRaw<{ policy: { allow_follow: boolean; classes: string[]; requirements: string[] } }>('SELECT policy FROM shared_skill_policies');
        expect(policy.policy.allow_follow).toBe(true);
        expect(policy.policy.classes).toEqual(['prose']);
        expect(policy.policy.requirements).toContain('tool:remember');
        expect(policy.policy.requirements).toContain('tool:get_skill');
        expect((await engine.executeRaw<{ count: number }>('SELECT COUNT(*)::integer AS count FROM shared_skill_policy_audit'))[0].count).toBe(1);
      } finally { await engine.disconnect(); }
    });
  }, 120_000);
  test('Git is initialized only when explicitly authorized in a new owned root', async () => {
    const home = temp();
    const result = await init(home, ['--git']);
    expect(result.content.repository_kind).toBe('git');
    expect(existsSync(join(result.content.root, '.git', 'HEAD'))).toBe(true);
    const git = Bun.spawn(['git', '-C', result.content.root, 'remote'], { stdout: 'pipe', stderr: 'pipe' });
    expect((await new Response(git.stdout).text()).trim()).toBe('');
    expect(await git.exited).toBe(0);
  }, 120_000);
  test('DB-only init stays memory-capable but does not claim content publication', async () => {
    const home = temp();
    const result = await init(home, ['--db-only']);
    expect(result.content.repository_kind).toBe('db_only');
    expect(result.content.status).toBe('action_required');
    expect(result.content.root).toBeNull();
    expect(existsSync(join(home, '.gbrain', 'content'))).toBe(false);
    expect(existsSync(join(home, '.gbrain', 'brain.pglite'))).toBe(true);
  }, 120_000);
  test('compiled CLI creates the same useful pack without runtime checkout assets', async () => {
    const root = temp(), binary = join(root, 'gbrain'), home = temp();
    const build = Bun.spawn([process.execPath, 'build', '--compile', '--no-compile-autoload-bunfig', '--outfile', binary, join(import.meta.dir, '../src/cli.ts')], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
    expect({ code, error: code ? out + err : '' }).toEqual({ code: 0, error: '' });
    const result = await init(home, [], binary);
    expect(result.content.status).toBe('ready');
    expect(readFileSync(join(result.content.root, 'skills/memory-care/SKILL.md'), 'utf8')).toBe(packagedSharedSkills()['skills/memory-care/SKILL.md']);
    expect(readFileSync(join(result.content.root, 'LICENSE'), 'utf8')).toContain('MIT License');
  }, 120_000);
});
