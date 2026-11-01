/**
 * Upgrade matrix harness (GBRA-224 W2): from-version resolution, the GitHub
 * fixture the old updater sees, preservation snapshots on real PGLite, and
 * the verdict rules. The matrix itself runs in .github/workflows/upgrade-matrix.yml.
 */
import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFromVersions, type Release } from '../../scripts/upgrade-matrix/versions.ts';
import { parseFixturePath, startGithubFixture } from '../../scripts/upgrade-matrix/github-fixture.ts';
import { compareInstalledTree } from '../../scripts/upgrade-matrix/cell.ts';
import { diffCatalog, diffContent, takeSnapshot, type Query } from '../../scripts/upgrade-matrix/snapshot.ts';
import { CHECKS, doctorVerdict, judgeCell, loadKnownExceptions, summarize, validateKnownExceptions, type CellSummary } from '../../scripts/upgrade-matrix/verdict.ts';
import { buildSummary, type Plan } from '../../scripts/upgrade-matrix.ts';

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-27T00:00:00Z');
/** 80 releases v0.60.1.0 .. v0.60.80.0, one a day, newest last. */
const releases: Release[] = Array.from({ length: 80 }, (_, i) => ({ tag: 'v0.60.' + (i + 1) + '.0', version: '0.60.' + (i + 1) + '.0', published_at: new Date(T0 - (80 - i) * DAY).toISOString() }));

describe('from-version resolution', () => {
  test('N-1, N-10, N-50 and 30 days are picked from releases older than the candidate; a missing stable is skipped with its reason', () => {
    const candidate = releases[79]!;
    const r = resolveFromVersions(releases, candidate, { profile: 'full', stableVersion: null });
    const byRole = Object.fromEntries(r.from.flatMap(f => f.roles.map(role => [role, f.tag])));
    expect(byRole).toEqual({ 'N-1': 'v0.60.79.0', 'N-10': 'v0.60.70.0', 'N-50': 'v0.60.30.0', '30d': 'v0.60.50.0' });
    expect(r.skipped).toEqual([{ role: 'stable', reason: expect.stringContaining('stable') }]);
  });

  test('a role shared by two picks is one from-version with both roles; too few releases skips N-50 instead of dropping it', () => {
    const few = releases.slice(0, 12);
    const r = resolveFromVersions(few, few[11]!, { profile: 'full', stableVersion: '0.60.2.0' });
    expect(r.skipped.map(s => s.role)).toEqual(['N-50']);
    expect(r.skipped[0]!.reason).toContain('only 11 published releases');
    const stable = r.from.find(f => f.roles.includes('stable'))!;
    expect(stable.tag).toBe('v0.60.2.0');
    const tags = r.from.map(f => f.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  test('an unreleased candidate (a pull-request head) upgrades from releases below its version; the pr profile keeps N-1 and N-50', () => {
    const r = resolveFromVersions(releases, { version: '0.60.81.0', published_at: new Date(T0).toISOString() }, { profile: 'pr' });
    expect(r.from.map(f => [f.tag, f.roles])).toEqual([['v0.60.80.0', ['N-1']], ['v0.60.31.0', ['N-50']]]);
    expect(r.skipped).toEqual([]);
  });
});

function gitRepo(): { dir: string; first: string; second: string } {
  const dir = mkdtempSync(join(tmpdir(), 'um-src-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'master');
  writeFileSync(join(dir, 'VERSION'), '0.0.1\n');
  writeFileSync(join(dir, 'package.json'), '{"name":"gbrain","version":"0.0.1"}\n');
  git('add', '.'); git('commit', '-qm', 'one');
  const first = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'VERSION'), '0.0.2\n');
  git('commit', '-qam', 'two');
  return { dir, first, second: git('rev-parse', 'HEAD') };
}

/** Async on purpose: the fixture serves from this process, so a blocking spawn would starve it. */
async function curl(args: string[]): Promise<{ status: number; stdout: string }> {
  const p = Bun.spawn(['curl', '-sS', '--max-time', '20', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(p.stdout).text();
  return { status: await p.exited, stdout };
}

describe('GitHub fixture', () => {
  test('parses the tarball, codeload and raw paths it serves, and nothing else', () => {
    expect(parseFixturePath('loopback', '/repos/garrytan/gbrain/tarball/v1.2.3.4')).toEqual({ kind: 'tarball', ref: 'v1.2.3.4' });
    expect(parseFixturePath('api.github.com', '/repos/garrytan/gbrain/tarball')).toEqual({ kind: 'tarball', ref: 'HEAD' });
    expect(parseFixturePath('codeload.github.com', '/garrytan/gbrain/tar.gz/master')).toEqual({ kind: 'tarball', ref: 'master' });
    expect(parseFixturePath('raw.githubusercontent.com', '/garrytan/gbrain/refs/heads/master/VERSION')).toEqual({ kind: 'raw', ref: 'master', file: 'VERSION' });
    expect(parseFixturePath('api.github.com', '/repos/garrytan/gbrain/releases/latest')).toEqual({ kind: 'api', ref: 'releases/latest' });
    expect(parseFixturePath('raw.githubusercontent.com', '/someone/else/master/VERSION')).toBeNull();
    expect(parseFixturePath('github.com', '/garrytan/gbrain')).toBeNull();
  });

  test('serves only the refs it names, over the proxy with its CA, and logs the commit behind each answer', async () => {
    const src = gitRepo(), work = mkdtempSync(join(tmpdir(), 'um-fx-'));
    const fx = await startGithubFixture({ source: src.dir, mirrorDir: join(work, 'mirror.git'), archiveDir: join(work, 'archives'), certDir: join(work, 'certs') });
    try {
      fx.setRefs({ HEAD: src.first, 'v0.0.1': src.first });
      const raw = async (ref: string) => (await curl(['--proxy', fx.proxyUrl, '--cacert', fx.caFile, 'https://raw.githubusercontent.com/garrytan/gbrain/' + ref + '/VERSION'])).stdout;
      expect(await raw('master')).toBe('0.0.1\n');
      expect(await raw('v0.0.2')).toBe('404: Not Found');
      fx.setRefs({ HEAD: src.second, 'v0.0.2': src.second });
      expect(await raw('master')).toBe('0.0.2\n');
      expect(await raw('v0.0.1')).toBe('404: Not Found');
      const tar = join(work, 't.tgz');
      expect((await curl(['-o', tar, fx.apiUrl + '/repos/garrytan/gbrain/tarball/v0.0.2'])).status).toBe(0);
      const listing = execFileSync('tar', ['-tzf', tar], { encoding: 'utf8' });
      expect(listing).toContain('garrytan-gbrain-' + src.second.slice(0, 7) + '/VERSION');
      const lsRemote = execFileSync('git', ['ls-remote', fx.mirror], { encoding: 'utf8' });
      expect(lsRemote).toContain(src.second + '\trefs/tags/v0.0.2');
      expect(lsRemote).not.toContain('v0.0.1');
      expect(fx.requests.filter(r => r.status === 200).map(r => r.sha)).toEqual([src.first, src.second, src.second]);
      expect(fx.proxy.every(p => p.action === 'fixture')).toBe(true);
    } finally {
      fx.stop();
      rmSync(work, { recursive: true, force: true }); rmSync(src.dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('refuses every host that is neither GitHub nor allowlisted, and relays a forwarded provider host to its local stand-in', async () => {
    const src = gitRepo(), work = mkdtempSync(join(tmpdir(), 'um-fx-'));
    const provider = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => Response.json({ path: new URL(req.url).pathname, body: await req.text() }) });
    const fx = await startGithubFixture({ source: src.dir, mirrorDir: join(work, 'mirror.git'), archiveDir: join(work, 'archives'), certDir: join(work, 'certs'), forward: { 'api.voyageai.com': 'http://127.0.0.1:' + provider.port, 'evil.example.com': 'http://127.0.0.1:1' }, allowHosts: [] });
    try {
      const denied = await curl(['--proxy', fx.proxyUrl, '--cacert', fx.caFile, 'https://example.com/']);
      expect(denied.status).not.toBe(0);
      const notForwardable = await curl(['--proxy', fx.proxyUrl, '--cacert', fx.caFile, 'https://evil.example.com/']);
      expect(notForwardable.status).not.toBe(0);
      expect(fx.proxy.filter(p => p.action === 'denied').map(p => p.host)).toEqual(['example.com', 'evil.example.com']);
      const relayed = await curl(['--proxy', fx.proxyUrl, '--cacert', fx.caFile, '-H', 'content-type: application/json', '-d', '{"input":["x"]}', 'https://api.voyageai.com/v1/embeddings']);
      expect(JSON.parse(relayed.stdout)).toEqual({ path: '/v1/embeddings', body: '{"input":["x"]}' });
    } finally {
      fx.stop(); provider.stop(true);
      rmSync(work, { recursive: true, force: true }); rmSync(src.dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('compareInstalledTree finds an installed file that differs from the commit, and one that is missing', () => {
    const src = gitRepo(), installed = mkdtempSync(join(tmpdir(), 'um-inst-'));
    try {
      execFileSync('sh', ['-c', 'git -C "$0" archive ' + src.second + ' | tar -x -C "$1"', src.dir, installed]);
      expect(compareInstalledTree(src.dir, src.second, installed)).toEqual({ checked: 2, mismatches: [], missing: [] });
      expect(compareInstalledTree(src.dir, src.first, installed).mismatches).toEqual(['VERSION']);
      unlinkSync(join(installed, 'package.json'));
      expect(compareInstalledTree(src.dir, src.second, installed)).toEqual({ checked: 1, mismatches: [], missing: ['package.json'] });
    } finally {
      rmSync(installed, { recursive: true, force: true }); rmSync(src.dir, { recursive: true, force: true });
    }
  });
});

describe('preservation and mixed-version snapshots (real PGLite)', () => {
  test('timestamps and bookkeeping changes are not differences; canonical changes are', async () => {
    const db = await PGlite.create();
    try {
      await db.exec(`
        CREATE TABLE config (key text PRIMARY KEY, value text);
        INSERT INTO config VALUES ('version', '270');
        CREATE TABLE sources (id text PRIMARY KEY, name text, archived boolean DEFAULT false);
        INSERT INTO sources (id, name) VALUES ('default', 'default');
        CREATE TABLE pages (id serial PRIMARY KEY, source_id text, slug text, type text, title text, content_hash text, frontmatter jsonb, deleted_at timestamptz, updated_at timestamptz DEFAULT now());
        INSERT INTO pages (source_id, slug, type, title, content_hash, frontmatter) VALUES
          ('default', 'concepts/alpha-example', 'concept', 'Alpha', 'h1', '{"b":1,"a":2}'),
          ('default', 'notes/gone-example', 'note', 'Gone', 'h2', '{}');
        UPDATE pages SET deleted_at = now() WHERE slug = 'notes/gone-example';
        CREATE TABLE facts (id serial PRIMARY KEY, source_id text, entity_slug text, fact text, row_num int, confidence real, expired_at timestamptz);
        INSERT INTO facts (source_id, entity_slug, fact, row_num, confidence) VALUES ('default', 'concepts/alpha-example', 'alpha ships', 1, 0.9);
      `);
      const query: Query = async (sql, params) => (await db.query(sql, params ?? [])).rows as Record<string, unknown>[];
      const before = await takeSnapshot(query, { catalog: true });
      expect(before.content.pages!.rows.map(r => [r.slug, r.deleted])).toEqual([['concepts/alpha-example', false], ['notes/gone-example', true]]);
      expect(before.catalog!.schema_version).toEqual({ version: '270' });

      await db.exec("UPDATE pages SET updated_at = now() + interval '1 day'; ALTER TABLE pages ADD COLUMN embedding_model text; UPDATE pages SET frontmatter = '{\"a\":2,\"b\":1}' WHERE slug = 'concepts/alpha-example'");
      const bookkeeping = await takeSnapshot(query, { catalog: true });
      expect(diffContent(before, bookkeeping)).toEqual([]);
      expect(diffCatalog(before, bookkeeping).map(d => d.where)).toEqual(['columns pages.embedding_model']);

      await db.exec("UPDATE pages SET title = 'Alpha (changed)' WHERE slug = 'concepts/alpha-example'; UPDATE pages SET deleted_at = NULL WHERE slug = 'notes/gone-example'; UPDATE facts SET expired_at = now(); ALTER TABLE pages DROP COLUMN content_hash");
      const after = await takeSnapshot(query, { catalog: false });
      expect(diffContent(before, after).map(d => d.kind + ' ' + d.where)).toEqual([
        'column_dropped pages.content_hash',
        'field_changed pages ["default","concepts/alpha-example"] title',
        'field_changed pages ["default","notes/gone-example"] deleted',
        'field_changed facts ["default","concepts/alpha-example","alpha ships",1] expired',
      ]);
    } finally {
      await db.close();
    }
  }, 60_000);
});

const cell = (id: string, verdict: CellSummary['verdict'], extra: Partial<CellSummary> = {}): CellSummary => ({ id, from: 'v0.60.1.0', roles: ['N-1'], shape: 'pglite keyless repo-less', verdict, open: [], excepted: [], ...extra });

describe('verdicts', () => {
  test('doctor: a failing check outside the skill category fails; skill checks never do; an alert verdict wins when present', () => {
    expect(doctorVerdict({ checks: [{ name: 'schema_version', status: 'ok' }, { name: 'skill_health', status: 'fail', category: 'skill' }] })).toEqual({ ok: true, failing: [], source: 'legacy' });
    expect(doctorVerdict({ checks: [{ name: 'minions_migration', status: 'fail', message: 'pending' }] })).toMatchObject({ ok: false, failing: ['minions_migration: pending'] });
    expect(doctorVerdict(null).ok).toBe(false);
    expect(doctorVerdict({ alert: { level: 'none', items: [] }, checks: [{ name: 'x', status: 'fail' }] })).toEqual({ ok: true, failing: [], source: 'alert' });
    expect(doctorVerdict({ alert: { level: 'page', items: [{ code: 'schema_behind' }] } })).toEqual({ ok: false, failing: ['page', 'schema_behind'], source: 'alert' });
  });

  test('known exceptions name explicit releases and an issue; the shipped list is valid', () => {
    const good = { id: 'x', check: 'preservation', from: ['v0.59.2.0'], issue: 'https://github.com/garrytan/gbrain/issues/1', reason: 'the old release rewrites every page' };
    expect(validateKnownExceptions([good])).toEqual([]);
    expect(validateKnownExceptions([{ ...good, from: ['v0.59.*'] }])[0]).toContain('no wildcards');
    expect(validateKnownExceptions([{ ...good, from: [] }])[0]).toContain('explicit release tags');
    expect(validateKnownExceptions([{ ...good, issue: 'https://example.com/1' }])[0]).toContain('issue');
    expect(validateKnownExceptions([{ ...good, check: 'setup' }])[0]).toContain('never excepted');
    expect(validateKnownExceptions([{ ...good, check: 'nope' }])[0]).toContain('check must be one of');
    for (const e of loadKnownExceptions()) expect(Object.keys(CHECKS)).toContain(e.check);
  });

  test('a cell passes only with no open failures; an exception covers only its own check and releases', () => {
    const ex = [{ id: 'x', check: 'preservation' as const, from: ['v0.59.2.0'], issue: 'https://github.com/garrytan/gbrain/issues/1', reason: 'r'.repeat(20) }];
    expect(judgeCell('v0.60.1.0', [], ex).verdict).toBe('pass');
    expect(judgeCell('v0.59.2.0', [{ check: 'preservation', detail: 'd' }], ex).verdict).toBe('known_exception');
    expect(judgeCell('v0.59.3.0', [{ check: 'preservation', detail: 'd' }], ex).verdict).toBe('fail');
    expect(judgeCell('v0.59.2.0', [{ check: 'preservation', detail: 'd' }, { check: 'doctor', detail: 'd' }], ex)).toMatchObject({ verdict: 'fail', open: [{ check: 'doctor' }] });
    expect(judgeCell('v0.59.2.0', [{ check: 'setup', detail: 'init exited 1' }], ex).verdict).toBe('error');
  });

  test('a run is red on any failing, missing, faulted or foreign cell; an old release that cannot be set up, or a held door, holds instead of passing', () => {
    expect(summarize(['a', 'b'], [cell('a', 'pass'), cell('b', 'known_exception')])).toMatchObject({ green: true, red: [], holds: [] });
    expect(summarize(['a', 'b'], [cell('a', 'pass')]).red.map(c => [c.id, c.verdict])).toEqual([['b', 'missing']]);
    expect(summarize(['a'], [cell('a', 'fail')]).green).toBe(false);
    expect(summarize(['a'], [cell('a', 'pass', { fault: 'corrupt-after-upgrade' })]).red.map(c => c.id)).toEqual(['a']);
    expect(summarize(['a'], [cell('a', 'error')])).toMatchObject({ green: false, red: [], holds: [{ id: 'a' }] });

    const plan = { harness: { sha: 'h' }, candidate: { sha: 'c' }, cells: ['a'], profile: 'full', from: [], skipped: [] } as unknown as Plan;
    const receipt = (over: Record<string, unknown> = {}) => ({ schema: 'gbrain-upgrade-matrix-cell/1', id: 'a', harness_sha: 'h', candidate: { sha: 'c' }, from: { tag: 'v0.60.1.0', roles: ['N-1'] }, shape: { engine: 'pglite', keys: 'keyless', brain: 'repo-less' }, verdict: 'pass', failures: [], known_exceptions: [], fault: null, ...over });
    expect(buildSummary(plan, [receipt()]).status).toBe('green');
    expect(buildSummary(plan, [receipt({ verdict: 'error', failures: [{ check: 'setup', detail: 'x' }] })]).status).toBe('hold');
    expect(buildSummary(plan, [receipt({ candidate: { sha: 'other' } })]).status).toBe('red');
    const door = (verdict: string) => ({ schema: 'gbrain-upgrade-matrix-door/1', door: 'hermes', harness_sha: 'h', candidate: { sha: 'c' }, verdict });
    expect(buildSummary(plan, [receipt(), door('hold')])).toMatchObject({ status: 'hold', holds: ['door:hermes'] });
    expect(buildSummary(plan, [receipt(), door('fail')]).status).toBe('red');
  });
});
