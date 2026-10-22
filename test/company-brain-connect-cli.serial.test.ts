import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

async function fixture(pages: ReadonlyArray<{ slug: string; content: string }> = COMPANY_BRAIN_SAMPLE) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'company-connect-cli-')));
  roots.push(root);
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  const database = join(home, 'brain.pglite');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(repo);
  for (const page of pages) {
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
    const receipt = randomUUID();
    expect(parseCompanyBrainConnectArgs(['--plan', 'reviewed.json', '--source', 'wiki', '--replace-incomplete', receipt], 'host'))
      .toMatchObject({ planFile: 'reviewed.json', replaceIncomplete: receipt, yes: false });
    for (const [args, brain] of [
      [['repo', '--source', 'wiki'], null],
      [['repo'], 'host'],
      [['repo', '--source', 'wiki', '--yes=false'], 'host'],
      [['repo', '--plan', 'plan.json', '--source', 'wiki'], 'host'],
      [['--plan', 'plan.json', '--include', '**', '--source', 'wiki'], 'host'],
      [['repo', '--source', 'wiki', '--replace-incomplete', receipt], 'host'],
      [['--plan', 'reviewed.json', '--source', 'wiki', '--replace-incomplete', 'not-a-receipt'], 'host'],
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
    expect(preview.code).toBe(3); // exit 3 is confirmation_required's only meaning (contract v1)
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

  // Authoring gate: the public loader must preserve exact approval replay after
  // HEAD advances while refusing a stale NEW replacement request. Core-only
  // tests miss CLI plan validation order and the consent/repair output. The real
  // canonical fence refusal needs no mock or production-only testing seam.
  test('corrected receipt replacement requires consent, gives its repair command, and replays only the reviewed request', async () => {
    const page = (title: string, body: string, type = 'concept') => `---\ntype: ${type}\ntitle: ${title}\naudience: internal\n---\n# ${title}\n${body}\n`;
    const fence = `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Fictional fixture claim | partnership | 1.0 | private | medium | 2026-01-01 |  | fixture |  |
<!--- gbrain:facts:end -->`;
    const f = await fixture([{ slug: 'docs/guide', content: page('Guide', 'GUIDE_INITIAL') },
      { slug: 'people/owner', content: page('Owner', fence, 'person') }]);
    const commit = (message: string) => {
      execFileSync('git', ['-C', f.repo, 'add', '.']);
      execFileSync('git', ['-C', f.repo, 'commit', '-qm', message]);
    };
    const inspect = (name: string) => {
      const file = join(f.root, `${name}.json`);
      const result = run(f.home, ['sources', 'inspect', f.repo, '--profile', 'company-brain', '--include', 'docs/guide.md', '--include', 'people/owner.md', '--out', file, '--json']);
      expect(result.code, result.err).toBe(0); return file;
    };
    const bad = run(f.home, ['sources', 'connect', '--plan', inspect('bad'), '--brain', 'host', '--source', 'wiki', '--yes', '--json']);
    expect(bad.code).toBe(1);
    const failed = JSON.parse(bad.out);
    expect(failed.receipt).toMatchObject({ phase: 'CONTENT', outcome: 'incomplete' });
    expect(failed.next_action).toContain('--replace-incomplete');
    expect(failed.next_action).toContain(failed.receipt.id);
    const single = run(f.home, ['sync', '--brain', 'host', '--source', 'wiki', '--no-pull', '--json']);
    expect(single.code).toBe(1);
    expect(JSON.parse(single.out).source_correction).toContain(`--replace-incomplete ${failed.receipt.id}`);
    const all = run(f.home, ['sync', '--brain', 'host', '--all', '--no-pull', '--json']);
    expect(all.code).toBe(1);
    expect(JSON.parse(all.out).sources.find((source: { source_id: string }) => source.source_id === 'wiki').source_correction)
      .toContain(`--replace-incomplete ${failed.receipt.id}`);
    writeFileSync(join(f.repo, 'people/owner.md'), page('Owner', 'OWNER_CORRECTED', 'person')); commit('Correct fictional fence');
    const correctedPlan = inspect('corrected');
    const requestId = randomUUID();
    const command = (plan: string, request = requestId) => ['sources', 'connect', '--plan', plan, '--brain', 'host', '--source', 'wiki',
      '--replace-incomplete', failed.receipt.id, '--request-id', request, '--json'];
    const preview = run(f.home, command(correctedPlan));
    expect(preview.code).toBe(3);
    expect(JSON.parse(preview.out)).toMatchObject({ code: 'confirmation_required', request_id: requestId });
    const status = run(f.home, ['sources', 'status', 'wiki', '--json']);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out).sources[0].ingestion).toMatchObject({ state: 'incomplete', receipt_id: failed.receipt.id });
    writeFileSync(join(f.repo, 'docs/guide.md'), page('Guide', 'GUIDE_REVIEWED')); commit('Advance before replacement approval');
    const staleNew = run(f.home, [...command(correctedPlan, randomUUID()), '--yes']);
    expect(staleNew.code).toBe(1);
    expect(['plan_stale', 'source_not_ready']).toContain(JSON.parse(staleNew.out).code);
    const stillIncomplete = run(f.home, ['sources', 'status', 'wiki', '--json']);
    expect(stillIncomplete.code).toBe(0);
    expect(JSON.parse(stillIncomplete.out).sources[0].ingestion).toMatchObject({ state: 'incomplete', receipt_id: failed.receipt.id });
    const reviewedPlan = inspect('reviewed');
    const approved = command(reviewedPlan, randomUUID());
    const recovered = run(f.home, [...approved, '--yes']);
    expect(recovered.code, recovered.err).toBe(0);
    const result = JSON.parse(recovered.out);
    expect(result).toMatchObject({ ok: true, receipt: { phase: 'COMPLETE', sourceIncarnation: failed.receipt.sourceIncarnation } });
    writeFileSync(join(f.repo, 'docs/guide.md'), page('Guide', 'GUIDE_NOT_APPROVED_BY_THIS_REQUEST')); commit('Advance after approval');
    const replay = run(f.home, [...approved, '--yes']);
    expect(replay.code, replay.err).toBe(0);
    expect(JSON.parse(replay.out).receipt).toMatchObject({ id: result.receipt.id, approvedRevision: result.receipt.approvedRevision });
    const read = run(f.home, ['get', 'docs/guide', '--source-id', 'wiki', '--include-content', '--json']);
    expect(read.code).toBe(0);
    expect(JSON.parse(read.out).compiled_truth).toContain('GUIDE_REVIEWED');
    expect(JSON.parse(read.out).compiled_truth).not.toContain('GUIDE_NOT_APPROVED_BY_THIS_REQUEST');
  }, 180_000);
});
