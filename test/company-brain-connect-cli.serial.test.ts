import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { COMPANY_BRAIN_SAMPLE } from '../src/core/company-brain/sample.ts';
import { parseCompanyBrainConnectArgs } from '../src/commands/company-brain-connect.ts';
import { withEnv } from './helpers/with-env.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';

const cli = resolve(import.meta.dir, '../src/cli.ts');
const roots: string[] = [];
const childBase = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith('GBRAIN_') && !key.startsWith('GIT_') &&
  !['DATABASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'PGLITE_DATA_DIR'].includes(key)));

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'company-connect-cli-'));
  roots.push(root);
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  const database = join(home, 'brain.pglite');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(repo);
  for (const page of COMPANY_BRAIN_SAMPLE) {
    const file = join(repo, `${page.slug}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, page.content);
  }
  await makeGitFixture(repo);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'Fictional company input']);
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const engine = new PGLiteEngine();
    try { await engine.connect({ database_path: database }); await engine.initSchema(); }
    finally { await engine.disconnect(); }
  });
  const configFile = join(home, '.gbrain/config.json');
  writeFileSync(configFile, JSON.stringify({ engine: 'pglite', database_path: database, embedding_disabled: true, schema_pack: 'gbrain-base-v2' }));
  return { root, home, repo, database, configFile };
}

function run(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  const child = Bun.spawnSync([process.execPath, cli, ...args], {
    env: { ...childBase, GBRAIN_HOME: home, GBRAIN_NO_BANNER: '1', ...extraEnv }, cwd: home,
    stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', timeout: 90_000,
  });
  return { code: child.exitCode, out: child.stdout.toString(), err: child.stderr.toString() };
}

async function sources(f: Awaited<ReturnType<typeof fixture>>) {
  return withEnv({ GBRAIN_HOME: f.home }, async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({ database_path: f.database });
      return await engine.executeRaw<{ id: string }>('SELECT id FROM sources ORDER BY id');
    } finally { await engine.disconnect(); }
  });
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('company connect public CLI', () => {
  test('requires explicit destinations and does not reinterpret a false consent flag', () => {
    const valid = parseCompanyBrainConnectArgs(['repo', '--source=wiki', '--profile', 'company-brain', '--yes', '--json'], 'company-example');
    expect(valid).toMatchObject({ brainId: 'company-example', sourceId: 'wiki', yes: true, json: true });
    for (const [args, brain] of [
      [['repo', '--source', 'wiki'], null],
      [['repo'], 'host'],
      [['repo', '--source', 'wiki', '--yes=false'], 'host'],
      [['repo', '--plan', 'plan.json', '--source', 'wiki'], 'host'],
      [['--plan', 'plan.json', '--include', '**', '--source', 'wiki'], 'host'],
    ] as Array<[string[], string | null]>) expect(() => parseCompanyBrainConnectArgs(args, brain)).toThrow();
  });

  test('previews without consent, then verifies the full fictional source and keeps config/files unchanged', async () => {
    const f = await fixture();
    const config = readFileSync(f.configFile);
    const out = join(f.root, 'review.json');
    const inspected = run(f.home, ['sources', 'inspect', f.repo, '--profile', 'company-brain', '--json', '--out', out]);
    expect(inspected.code).toBe(0);
    const command = ['sources', 'connect', '--plan', out, '--brain', 'host', '--source', 'wiki', '--json'];
    const preview = run(f.home, command);
    expect(preview.code).toBe(2);
    expect(JSON.parse(preview.out)).toMatchObject({ schema_version: 1, code: 'confirmation_required', preview: { sourceId: 'wiki', managed: false } });
    expect(await sources(f)).toEqual([{ id: 'default' }]);
    expect(readFileSync(f.configFile)).toEqual(config);
    const requestId = randomUUID();
    const connected = run(f.home, [...command, '--yes', '--request-id', requestId]);
    expect(connected.code).toBe(0);
    const result = JSON.parse(connected.out);
    expect(result).toMatchObject({ schema_version: 1, status: 'complete', ok: true, receipt: { phase: 'COMPLETE', outcome: 'complete', counts: { eligibleFiles: 15, importedPages: 15, verificationFailures: 0 } } });
    expect(result.evidence.ownership).toMatchObject({ status: 'verified', page: 'Acme Example', owner: 'Alice Example' });
    expect(result.evidence.ownership.citations).toHaveLength(2);
    expect(result.evidence.supersession.status).toBe('verified');
    const replayed = run(f.home, [...command, '--yes', '--request-id', requestId]);
    expect(replayed.code).toBe(0);
    expect(JSON.parse(replayed.out).receipt.id).toBe(result.receipt.id);
    const status = run(f.home, ['sources', 'status', '--brain', 'host', '--json']);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out).sources.find((source: { source_id: string }) => source.source_id === 'wiki').ingestion)
      .toMatchObject({ state: 'complete', receipt_id: result.receipt.id });
    const sync = run(f.home, ['sync', '--brain', 'host', '--source', 'wiki', '--json']);
    expect(sync.code).toBe(0);
    expect(await sources(f)).toEqual([{ id: 'default' }, { id: 'wiki' }]);
    expect(readFileSync(f.configFile)).toEqual(config);
    expect(execFileSync('git', ['-C', f.repo, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
    for (const page of COMPANY_BRAIN_SAMPLE) expect(readFileSync(join(f.repo, `${page.slug}.md`), 'utf8')).toBe(page.content);
  }, 180_000);

  test('rejects changed plans and implicit routing before registering a source', async () => {
    const f = await fixture();
    const planFile = join(f.root, 'plan.json');
    expect(run(f.home, ['sources', 'inspect', f.repo, '--profile', 'company-brain', '--out', planFile]).code).toBe(0);
    writeFileSync(join(f.repo, 'company.md'), `${COMPANY_BRAIN_SAMPLE[0].content}\nA later change.\n`);
    execFileSync('git', ['-C', f.repo, 'add', '.']);
    execFileSync('git', ['-C', f.repo, 'commit', '-qm', 'Changed approved input']);
    const stale = run(f.home, ['sources', 'connect', '--plan', planFile, '--brain', 'host', '--source', 'wiki', '--yes', '--json']);
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.out).code).toBe('plan_stale');
    const implicit = run(f.home, ['sources', 'connect', f.repo, '--yes', '--json'], { GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: 'wiki' });
    expect(implicit.code).toBe(2);
    expect(JSON.parse(implicit.out).code).toBe('invalid_params');
    expect(await sources(f)).toEqual([{ id: 'default' }]);
  }, 120_000);
});
