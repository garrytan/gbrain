import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { SHARED_CONTENT_MIGRATION_VERSION } from '../src/commands/migrations/shared-content.ts';

async function cli(home: string, args: string[], expectCode = 0) {
  const env: NodeJS.ProcessEnv = { ...process.env, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1' };
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_BRAIN_ID', 'GBRAIN_IN_AGENT_SETUP']) delete env[key];
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ args, code, failure: code !== expectCode ? stdout + stderr : '' }).toEqual({ args, code: expectCode, failure: '' });
  return { stdout, stderr };
}

const ledger = (home: string) => readFileSync(join(home, '.gbrain', 'migrations', 'completed.jsonl'), 'utf8').trim().split('\n')
  .map(line => JSON.parse(line) as { version: string; status: string }).filter(entry => entry.version === SHARED_CONTENT_MIGRATION_VERSION);

test('a wedged 0.53.0 migration resumes through --force-retry, parks the oversized source once and completes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-shared-park-')), root = join(home, 'pack');
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const engine = new PGLiteEngine();
    const database = { engine: 'pglite' as const, database_path: join(home, '.gbrain', 'brain.pglite') };
    try {
      await cli(home, ['init', '--pglite', '--no-embedding', '--non-interactive', '--db-only']);
      mkdirSync(join(root, 'skills', 'big'), { recursive: true });
      writeFileSync(join(root, 'skillpack.json'), JSON.stringify({ skills: ['skills/big'] }));
      writeFileSync(join(root, 'skills', 'big', 'SKILL.md'), `# Big\n${'x'.repeat(300_000)}\n`);
      await engine.connect(database);
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
      await engine.disconnect();
      mkdirSync(join(home, '.gbrain', 'migrations'), { recursive: true });
      for (let attempt = 0; attempt < 3; attempt++) appendFileSync(join(home, '.gbrain', 'migrations', 'completed.jsonl'), `${JSON.stringify({ version: SHARED_CONTENT_MIGRATION_VERSION, status: 'partial' })}\n`);
      const listed = JSON.parse((await cli(home, ['apply-migrations', '--list', '--json'])).stdout);
      expect(listed.plan.wedged).toContain(SHARED_CONTENT_MIGRATION_VERSION);

      await cli(home, ['apply-migrations', '--force-retry', SHARED_CONTENT_MIGRATION_VERSION]);
      const applied = await cli(home, ['apply-migrations', '--migration', SHARED_CONTENT_MIGRATION_VERSION, '--yes']);
      expect(ledger(home).at(-1)!.status).toBe('complete');
      expect(applied.stderr).toContain('payload_too_large');
      expect(applied.stderr).toContain('gbrain sources shared-skills default off');

      const status = JSON.parse((await cli(home, ['sources', 'shared-skills', 'default', 'status', '--json'])).stdout);
      expect(status).toMatchObject({ schema_version: 1, action: 'status', source_id: 'default', configured: null, mode: 'content',
        parked: { limit: 'shared_skills.inventory.max_file_bytes' } });
      const parkedAt = status.parked.parked_at;
      const doctor = JSON.parse((await cli(home, ['doctor', '--only', 'shared_skills_sources', '--json'])).stdout);
      expect(doctor.checks.find((check: { name: string }) => check.name === 'shared_skills_sources')).toMatchObject({ status: 'warn', details: { parked: [{ source_id: 'default' }] } });

      await cli(home, ['apply-migrations', '--migration', SHARED_CONTENT_MIGRATION_VERSION, '--yes']);
      expect(JSON.parse((await cli(home, ['sources', 'shared-skills', 'default', 'status', '--json'])).stdout).parked.parked_at).toBe(parkedAt);
      expect(ledger(home).map(entry => entry.status)).toEqual(['partial', 'partial', 'partial', 'retry', 'complete']);

      await cli(home, ['config', 'set', 'shared_skills.inventory.max_file_bytes', String(64 * 1024 * 1024)], 2);
      await cli(home, ['config', 'set', 'shared_skills.inventory.max_file_bytes', '524288']);
      await cli(home, ['apply-migrations', '--migration', SHARED_CONTENT_MIGRATION_VERSION, '--yes']);
      const resumed = JSON.parse((await cli(home, ['sources', 'status', 'default', '--json'])).stdout);
      expect(resumed.sources[0].shared_skills).toMatchObject({ source_id: 'default', configured: null, mode: 'content', parked: null });
      await engine.connect(database);
      const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
      const record = JSON.parse((await engine.getConfig(`shared_skills.migration.v1.default.${source!.incarnation}`))!);
      expect(record.stages.find((stage: { stage: string }) => stage.stage === 'inventory').status).toBe('complete');
      await engine.disconnect();
    } finally { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); }
  });
}, 240_000);

test('sources shared-skills off/on through the CLI: help, opError refusals and the opt-out resume path', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-shared-optout-cli-')), root = join(home, 'pack');
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const engine = new PGLiteEngine();
    const database = { engine: 'pglite' as const, database_path: join(home, '.gbrain', 'brain.pglite') };
    try {
      await cli(home, ['init', '--pglite', '--no-embedding', '--non-interactive', '--db-only']);
      mkdirSync(join(root, 'skills', 'big'), { recursive: true });
      writeFileSync(join(root, 'skillpack.json'), JSON.stringify({ skills: ['skills/big'] }));
      writeFileSync(join(root, 'skills', 'big', 'SKILL.md'), `# Big\n${'x'.repeat(300_000)}\n`);
      await engine.connect(database);
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
      await engine.disconnect();

      expect((await cli(home, ['sources', 'shared-skills', '--help'])).stdout).toContain('Usage: gbrain sources shared-skills <id> on|off|status [--json]');
      const invalid = JSON.parse((await cli(home, ['sources', 'shared-skills', 'default', 'maybe', '--json'], 2)).stdout);
      expect({ code: invalid.code, argv: invalid.fix.argv.slice(0, 6) }).toEqual({ code: 'invalid_params', argv: ['gbrain', 'sources', 'shared-skills', 'default', 'status', '--json'] });
      const missing = JSON.parse((await cli(home, ['sources', 'shared-skills', 'absent-source', 'off', '--json'], 1)).stdout);
      expect(missing.code).toBe('not_found');

      await cli(home, ['apply-migrations', '--migration', SHARED_CONTENT_MIGRATION_VERSION, '--yes']);
      expect(ledger(home).at(-1)!.status).toBe('complete');
      const off = await cli(home, ['sources', 'shared-skills', 'default', 'off']);
      expect(off.stdout).toContain('config.shared_skills = false; effective policy preserve_files (source_shared_skills_disabled)');
      await cli(home, ['apply-migrations', '--migration', SHARED_CONTENT_MIGRATION_VERSION, '--yes']);
      const human = (await cli(home, ['sources', 'status', 'default'])).stdout;
      expect(human).toContain('default: config.shared_skills = false');
      const doctor = JSON.parse((await cli(home, ['doctor', '--only', 'shared_skills_sources', '--json'], 0)).stdout);
      expect(doctor.checks.find((check: { name: string }) => check.name === 'shared_skills_sources')).toMatchObject({ status: 'ok', details: { opted_out: ['default'], parked: [] } });
      const on = JSON.parse((await cli(home, ['sources', 'shared-skills', 'default', 'on', '--json'])).stdout);
      expect(on).toMatchObject({ action: 'on', changed: true, configured: null, mode: 'content' });
    } finally { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); }
  });
}, 240_000);

test('a thin client is refused with trusted_local_only, the host command and a read-only verify', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-shared-thin-'));
  try {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres',
      remote_mcp: { issuer_url: 'https://brain-host.example', mcp_url: 'https://brain-host.example/mcp', oauth_client_id: 'cid', oauth_client_secret: 'csecret' } }));
    const refusal = JSON.parse((await cli(home, ['sources', 'shared-skills', 'default', 'off', '--json'], 1)).stdout);
    expect(refusal).toMatchObject({ code: 'trusted_local_only', fix: { actor: 'host_admin', next: 'tell_user_to_run' } });
    expect(refusal.fix.argv.slice(0, 5)).toEqual(['gbrain', 'sources', 'shared-skills', 'default', 'off']);
    expect(refusal.fix.verify.argv.slice(0, 6)).toEqual(['gbrain', 'sources', 'shared-skills', 'default', 'status', '--json']);
    expect((await cli(home, ['sources', 'shared-skills', '--help'])).stdout).toContain('Runs only on the brain host.');
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 60_000);
