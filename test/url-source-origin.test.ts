import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as childProcess from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runManagedSourceClone } from '../src/core/persistence/topology-clone.ts';
import { topologyPrincipal } from '../src/core/persistence/topology-locks.ts';
import { LFS_OFF_CLONE_CONFIG } from '../src/core/git-remote.ts';
import { lfsDownloadsOff } from '../src/core/sources-ops.ts';
import { defaultCloneDir } from '../src/core/url-clone.ts';
import { operations } from '../src/core/operations.ts';
import { recordSourceOrigin } from '../src/core/url-source-origin.ts';
import { managedSourceAddInput } from '../src/core/persistence/managed-sources.ts';
import { urlSourceOriginCheck } from '../src/commands/doctor/checks/url-source-origin.ts';
import { runRecordOrigin } from '../src/commands/sources-record-origin.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';

const URL_CONFIG = { managed_clone: true, remote_url: 'https://example.invalid/source-a.git' };
const git = (args: string[]) => execFileSync('git', ['-c', 'user.email=alice-example@example.invalid', '-c', 'user.name=alice-example', '-c', 'commit.gpgsign=false', ...args],
  { stdio: 'pipe', env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } });

/** A bare repository with one note, plus a git-lfs-tracked file when `lfs`. */
function bareRepo(home: string, lfs: boolean): string {
  const work = join(home, 'work'), bare = join(home, 'remote.git');
  git(['init', '-q', '-b', 'main', work]);
  writeFileSync(join(work, 'example.md'), '---\ntitle: Example\ntype: note\n---\n\nCanonical\n');
  if (lfs) { writeFileSync(join(work, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n'); writeFileSync(join(work, 'blob.bin'), 'binary-example'); }
  git(['-C', work, 'add', '-A']);
  git(['-C', work, 'commit', '-q', '-m', 'init']);
  git(['clone', '-q', '--bare', work, bare]);
  return bare;
}

const databaseUrl = process.env.DATABASE_URL;
for (const flavor of ['pglite', ...(databaseUrl ? ['postgres'] : [])] as const) describe(`URL source origin (${flavor})`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (flavor === 'postgres') { const fixture = await isolatedPersistencePostgres(databaseUrl!); engine = fixture.engine; closePostgres = fixture.close; }
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => { if (!engine) return; await disposePersistenceConsumer(engine); if (closePostgres) await closePostgres(); else await engine.disconnect(); });

  async function brain(run: (home: string) => Promise<void>) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-url-origin-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        await resetPgliteState(engine as PGLiteEngine);
        await run(home);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  const insert = (id: string, localPath: string | null, config: Record<string, unknown>) =>
    engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, localPath, JSON.stringify(config)]);
  const config = async (id: string) => (await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [id]))[0]!.config;
  const check = () => urlSourceOriginCheck(engine);

  /** A managed brain whose URL source was cloned before any origin was recorded, at the default clone directory. */
  async function managedUrlSource(home: string, lfs: boolean) {
    const source = 'source-a', root = defaultCloneDir(source), bare = bareRepo(home, lfs);
    mkdirSync(join(home, 'clones'), { recursive: true });
    git(['clone', '-q', bare, root]);
    await registerLocalWriter(engine, 'cli');
    await insert(source, root, URL_CONFIG);
    await claimWorktree(engine, source, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    return { source, root, bare };
  }

  test('doctor lists a URL source with no recorded origin at the default clone directory, and nothing on a brain without URL sources', () => brain(async home => {
    const empty = await check();
    expect(empty).toMatchObject({ name: 'url_source_origin', status: 'ok', details: { count: 0 } });
    await insert('source-a', defaultCloneDir('source-a'), URL_CONFIG);
    await insert('source-b', defaultCloneDir('source-b'), { ...URL_CONFIG, added_by_remote_caller: true });
    await insert('source-c', join(home, 'elsewhere', 'source-c'), URL_CONFIG);
    await insert('source-d', defaultCloneDir('source-d'), { ...URL_CONFIG, added_by_remote_caller: false });
    await insert('source-e', join(home, 'notes'), {});
    const found = await check();
    expect(found.status).toBe('warn');
    expect((found.details as { sources: Array<{ id: string }> }).sources.map(source => source.id)).toEqual(['source-a']);
    expect(found.message).toContain('cannot tell whether a remote caller or the local operator added');
    expect(found.fix).toMatchObject({ ask_user: true, argv: ['gbrain', 'sources', 'record-origin', 'source-a', '--remote'], verify: { argv: ['gbrain', 'doctor', '--only', 'url_source_origin', '--json'] } });
  }), 60_000);

  test('record-origin previews, then records; the next managed reclone clones with the remote-add settings and matches the manifest', () => brain(async home => {
    const { source, root, bare } = await managedUrlSource(home, false);
    const preview = await recordSourceOrigin(engine, [source], { origin: 'remote', apply: false, remote: false });
    expect(preview.results).toEqual([expect.objectContaining({ source_id: source, status: 'would_record' })]);
    expect(lfsDownloadsOff(await config(source))).toBe(false);
    expect((await check()).status).toBe('warn');

    const applied = await recordSourceOrigin(engine, [source], { origin: 'remote', apply: true, remote: false });
    expect(applied.results).toEqual([expect.objectContaining({ source_id: source, status: 'recorded' })]);
    expect(lfsDownloadsOff(await config(source))).toBe(true);
    expect((await check()).status).toBe('ok');
    expect((await recordSourceOrigin(engine, [source], { origin: 'local', apply: true, remote: false })).results[0]).toMatchObject({ status: 'refused', code: 'recorded_remote' });

    const seen: Array<{ skipLfs: boolean }> = [];
    const input = { operation: 'reclone' as const, sourceId: source, requestId: randomUUID() };
    const result = await runManagedSourceClone(engine, input, await topologyPrincipal(engine), input.requestId, { ...input, requestId: undefined, dryRun: undefined }, {
      clone: async (_url, stage, _budget, options) => { seen.push(options); git(['clone', '-q', ...(options.skipLfs ? LFS_OFF_CLONE_CONFIG : []), bare, stage]); },
    });
    expect(result).toMatchObject({ state: 'committed' });
    expect(seen).toEqual([{ skipLfs: true }]);
    expect(execFileSync('git', ['-C', root, 'config', '--local', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim()).toBe('/dev/null');
  }), 120_000);

  test('record-origin refuses a checkout that tracks git-lfs files, or one it cannot inspect, and writes nothing', () => brain(async home => {
    const { source, root } = await managedUrlSource(home, true);
    for (const apply of [false, true]) {
      const report = await recordSourceOrigin(engine, [source], { origin: 'remote', apply, remote: false });
      expect(report.results).toEqual([expect.objectContaining({ source_id: source, status: 'refused', code: 'lfs_tracked' })]);
      expect(report.results[0]!.reason).toContain('nothing changed');
    }
    expect(await config(source)).toEqual(URL_CONFIG);
    rmSync(root, { recursive: true, force: true });
    expect((await recordSourceOrigin(engine, [source], { origin: 'remote', apply: true, remote: false })).results[0]).toMatchObject({ status: 'refused', code: 'lfs_unknown' });
    expect(await config(source)).toEqual(URL_CONFIG);
  }), 120_000);

  test('--local records the local operator, so doctor stops listing it; a clone outside the default directory is never recorded as remote', () => brain(async home => {
    await insert('source-a', defaultCloneDir('source-a'), URL_CONFIG);
    await insert('source-c', join(home, 'elsewhere', 'source-c'), URL_CONFIG);
    expect((await recordSourceOrigin(engine, ['source-a'], { origin: 'local', apply: true, remote: false })).results[0]).toMatchObject({ status: 'recorded' });
    expect(await config('source-a')).toEqual({ ...URL_CONFIG, added_by_remote_caller: false });
    expect((await check()).status).toBe('ok');
    expect((await recordSourceOrigin(engine, ['source-c'], { origin: 'remote', apply: true, remote: false })).results[0]).toMatchObject({ status: 'refused', code: 'custom_clone_dir' });
    expect(await config('source-c')).toEqual(URL_CONFIG);
  }), 60_000);

  test('a remote caller cannot record an origin: trusted local CLI only, and no MCP operation reaches it', () => brain(async () => {
    await insert('source-a', defaultCloneDir('source-a'), URL_CONFIG);
    for (const remote of [true, undefined])
      await expect(recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply: true, remote })).rejects.toMatchObject({ canonical: 'trusted_local_only' });
    expect(await config('source-a')).toEqual(URL_CONFIG);
    expect(operations.filter(op => /record.?origin/.test(op.name) || 'added_by_remote_caller' in (op.params ?? {})).map(op => op.name)).toEqual([]);
  }), 60_000);
  test('--remote refuses a clone directory that is not its own repository, even inside an enclosing one, and writes nothing', () => brain(async home => {
    git(['init', '-q', home]);
    mkdirSync(defaultCloneDir('source-a'), { recursive: true });
    await insert('source-a', defaultCloneDir('source-a'), URL_CONFIG);
    for (const apply of [false, true])
      expect((await recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply, remote: false })).results[0]).toMatchObject({ status: 'refused', code: 'lfs_unknown' });
    expect(await config('source-a')).toEqual(URL_CONFIG);
  }), 60_000);

  test('missing, archived and non-URL sources are refused with their own codes, a repeated id is checked once, and nothing is written', () => brain(async home => {
    await insert('source-a', defaultCloneDir('source-a'), URL_CONFIG);
    await insert('source-b', defaultCloneDir('source-b'), URL_CONFIG);
    await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', ['source-b']);
    await insert('source-e', join(home, 'notes'), {});
    const preview = await recordSourceOrigin(engine, ['nope', 'source-b', 'source-e', 'source-a', 'source-a'], { origin: 'local', apply: false, remote: false });
    expect(preview.results.map(result => [result.source_id, result.code ?? result.status])).toEqual([['nope', 'not_found'], ['source-b', 'archived'], ['source-e', 'not_url_clone'], ['source-a', 'would_record']]);
    for (const apply of [false, true]) {
      const refused = await recordSourceOrigin(engine, ['nope', 'source-b', 'source-e'], { origin: 'remote', apply, remote: false });
      expect(refused.results.map(result => result.code)).toEqual(['not_found', 'archived', 'not_url_clone']);
    }
    expect(await config('source-a')).toEqual(URL_CONFIG);
    expect(await config('source-b')).toEqual(URL_CONFIG);
    expect(await config('source-e')).toEqual({});
  }), 60_000);

  test('apply refuses source_changed when the row moves between its check and its locked re-read, and leaves the row as it found it', () => brain(async () => {
    await insert('source-a', defaultCloneDir('source-a'), URL_CONFIG);
    const moved = { ...URL_CONFIG, remote_url: 'https://example.invalid/source-other.git' };
    const transaction = engine.transaction.bind(engine);
    const patched = spyOn(engine, 'transaction').mockImplementation(async fn => {
      await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1', ['source-a', JSON.stringify(moved)]);
      return transaction(fn);
    });
    try {
      expect((await recordSourceOrigin(engine, ['source-a'], { origin: 'local', apply: true, remote: false })).results[0]).toMatchObject({ status: 'refused', code: 'source_changed' });
    } finally { patched.mockRestore(); }
    expect(await config('source-a')).toEqual(moved);
  }), 60_000);

  test('the CLI exits 2 on a usage error before reading anything, and sets exit 1 when any id is refused', () => brain(async () => {
    await insert('source-a', defaultCloneDir('source-a'), URL_CONFIG);
    const priorExitCode = process.exitCode;
    const exit = spyOn(process, 'exit').mockImplementation(code => { throw new Error(`EXIT ${code}`); });
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    const logs = spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (const args of [['source-a', '--remote', '--local'], ['source-a'], ['--remote'], ['source-a', '--remote', '--force']])
        await expect(runRecordOrigin(engine, args)).rejects.toThrow('EXIT 2');
      expect(errors.mock.calls.flat().join('\n')).toContain('Usage: gbrain sources record-origin');
      expect(await config('source-a')).toEqual(URL_CONFIG);

      _resetCliExitVerdictForTests();
      await runRecordOrigin(engine, ['source-a', '--local']);
      expect(currentExitCode()).toBe(0);
      expect(logs.mock.calls.flat().join('\n')).toContain('Apply with: gbrain sources record-origin source-a --local --apply');
      await runRecordOrigin(engine, ['source-a', 'nope', '--local', '--apply']);
      expect(currentExitCode()).toBe(1);
      expect(await config('source-a')).toEqual({ ...URL_CONFIG, added_by_remote_caller: false });
    } finally { exit.mockRestore(); errors.mockRestore(); logs.mockRestore(); _resetCliExitVerdictForTests(); process.exitCode = priorExitCode ?? 0; }
  }), 60_000);

  test('--remote refuses a checkout whose clone-local attributes hide its git-lfs files, and writes nothing', () => brain(async home => {
    const { source, root } = await managedUrlSource(home, true);
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    writeFileSync(join(root, '.git', 'info', 'attributes'), '*.bin -filter\n');
    for (const apply of [false, true])
      expect((await recordSourceOrigin(engine, [source], { origin: 'remote', apply, remote: false })).results[0]).toMatchObject({ status: 'refused', code: 'lfs_tracked' });
    expect(await config(source)).toEqual(URL_CONFIG);
  }), 120_000);

  test('--remote --apply inspects the checkout again under the row lock, so git-lfs files that arrive after the first check are refused', () => brain(async home => {
    const { source, root } = await managedUrlSource(home, false);
    const transaction = engine.transaction.bind(engine);
    const patched = spyOn(engine, 'transaction').mockImplementation(async fn => {
      writeFileSync(join(root, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
      writeFileSync(join(root, 'blob.bin'), 'binary-example');
      git(['-C', root, 'add', '-A']);
      git(['-C', root, 'commit', '-q', '-m', 'lfs']);
      return transaction(fn);
    });
    try {
      expect((await recordSourceOrigin(engine, [source], { origin: 'remote', apply: true, remote: false })).results[0]).toMatchObject({ status: 'refused', code: 'lfs_tracked' });
    } finally { patched.mockRestore(); }
    expect(await config(source)).toEqual(URL_CONFIG);
  }), 120_000);

  test('doctor lists a URL clone at the default clone directory that has no ownership marker, and record-origin accepts it', () => brain(async home => {
    const unmarked = { remote_url: URL_CONFIG.remote_url };
    await insert('source-a', defaultCloneDir('source-a'), unmarked);
    await insert('source-c', join(home, 'elsewhere', 'source-c'), unmarked);
    expect(((await check()).details as { sources: Array<{ id: string }> }).sources.map(source => source.id)).toEqual(['source-a']);
    expect((await recordSourceOrigin(engine, ['source-a', 'source-c'], { origin: 'local', apply: true, remote: false })).results.map(result => result.code ?? result.status))
      .toEqual(['recorded', 'not_url_clone']);
    expect(await config('source-a')).toEqual({ ...unmarked, added_by_remote_caller: false });
    expect(await config('source-c')).toEqual(unmarked);
    expect((await check()).status).toBe('ok');
  }), 60_000);

  test('a local URL add records the local operator; a row with no record stays unknown and never reads as added by a remote caller', () => brain(async () => {
    expect(managedSourceAddInput({ id: 'source-a', remoteUrl: URL_CONFIG.remote_url }).config).toMatchObject({ added_by_remote_caller: false });
    expect(managedSourceAddInput({ id: 'source-b', remoteUrl: URL_CONFIG.remote_url, addedByRemoteCaller: true }).config).toMatchObject({ added_by_remote_caller: true });
    await insert('source-a', defaultCloneDir('source-a'), URL_CONFIG);
    expect(lfsDownloadsOff(await config('source-a'))).toBe(false);
    const found = await check();
    expect(found.status).toBe('warn');
    expect((found.details as { sources: Array<{ id: string }> }).sources.map(source => source.id)).toEqual(['source-a']);
    expect((await recordSourceOrigin(engine, ['source-a'], { origin: 'local', apply: false, remote: false })).results[0]).toMatchObject({ status: 'would_record' });
  }), 60_000);
  /** A repository at root with these committed files and no remote. */
  function repoAt(root: string, files: Record<string, string>) {
    git(['init', '-q', '-b', 'main', root]);
    for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); }
    git(['-C', root, 'add', '-A']);
    git(['-C', root, 'commit', '-q', '-m', 'init']);
  }
  const localConfig = (root: string, key: string) => {
    try { return execFileSync('git', ['-C', root, 'config', '--local', '--get', key], { encoding: 'utf8', stdio: 'pipe' }).trim(); } catch { return null; }
  };
  const cloneFrom = (bare: string, seen: Array<{ skipLfs: boolean }>) => async (_url: string, stage: string, _budget: number, options: { skipLfs: boolean }) => {
    seen.push(options);
    git(['clone', '-q', ...(options.skipLfs ? LFS_OFF_CLONE_CONFIG : []), bare, stage]);
  };
  const reclone = async (source: string, hooks: Parameters<typeof runManagedSourceClone>[5]) => {
    const input = { operation: 'reclone' as const, sourceId: source, requestId: randomUUID() };
    return runManagedSourceClone(engine, input, await topologyPrincipal(engine), input.requestId, { ...input, requestId: undefined, dryRun: undefined }, hooks);
  };

  test('--remote --apply takes the reclone lifecycle lock: while a reclone holds it the record is refused source_busy and writes nothing', () => brain(async home => {
    const { source, root, bare } = await managedUrlSource(home, false);
    const seen: Array<{ skipLfs: boolean }> = [];
    let during: Awaited<ReturnType<typeof recordSourceOrigin>> | undefined;
    const result = await reclone(source, {
      boundary: async name => { if (name === 'reserved') during = await recordSourceOrigin(engine, [source], { origin: 'remote', apply: true, remote: false }); },
      clone: cloneFrom(bare, seen),
    });
    expect(result).toMatchObject({ state: 'committed' });
    expect(during!.results).toEqual([expect.objectContaining({ source_id: source, status: 'refused', code: 'source_busy' })]);
    expect(during!.results[0]!.reason).toContain('nothing changed');
    expect(lfsDownloadsOff(await config(source))).toBe(false);
    expect(seen).toEqual([{ skipLfs: false }]);
    expect(localConfig(root, 'core.hooksPath')).toBeNull();
  }), 120_000);

  test('a reclone that read the source before a record landed clones with the recorded settings, because it reads them again under its own locks', () => brain(async home => {
    const { source, root, bare } = await managedUrlSource(home, false);
    const executeRaw = engine.executeRaw;
    let recorded: Awaited<ReturnType<typeof recordSourceOrigin>> | undefined;
    let fired = false;
    const patched = spyOn(engine, 'executeRaw').mockImplementation((async function (this: BrainEngine, sql: string, params?: unknown[]) {
      const rows = await executeRaw.call(this, sql, params);
      if (!fired && this === engine && sql.startsWith('SELECT incarnation,config,last_commit,local_path FROM sources')) {
        fired = true;
        recorded = await recordSourceOrigin(engine, [source], { origin: 'remote', apply: true, remote: false });
      }
      return rows;
    }) as typeof engine.executeRaw);
    const seen: Array<{ skipLfs: boolean }> = [];
    try {
      expect(await reclone(source, { clone: cloneFrom(bare, seen) })).toMatchObject({ state: 'committed' });
    } finally { patched.mockRestore(); }
    expect(recorded!.results).toEqual([expect.objectContaining({ source_id: source, status: 'recorded' })]);
    expect(seen).toEqual([{ skipLfs: true }]);
    expect(localConfig(root, 'core.hooksPath')).toBe('/dev/null');
  }), 120_000);

  test('--remote --apply turns git-lfs downloads and hooks off in the existing checkout too; the preview changes nothing', () => brain(async home => {
    const { source, root } = await managedUrlSource(home, false);
    const preview = await recordSourceOrigin(engine, [source], { origin: 'remote', apply: false, remote: false });
    expect(preview.results[0]!.reason).toContain('turned off in its checkout');
    expect(localConfig(root, 'core.hooksPath')).toBeNull();
    expect((await recordSourceOrigin(engine, [source], { origin: 'remote', apply: true, remote: false })).results[0]).toMatchObject({ status: 'recorded' });
    expect([localConfig(root, 'lfs.fetchexclude'), localConfig(root, 'core.hooksPath'), localConfig(root, 'lfs.locksverify')]).toEqual(['*', '/dev/null', 'false']);
  }), 120_000);

  test('--remote reads a committed .gitattributes under a directory whose name holds a tab, so clone-local attributes cannot hide its git-lfs files', () => brain(async () => {
    const root = defaultCloneDir('source-a');
    repoAt(root, { 'example.md': 'Canonical\n', 'dir\tname/.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'dir\tname/blob.bin': 'binary-example' });
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    writeFileSync(join(root, '.git', 'info', 'attributes'), '*.bin -filter\n');
    await insert('source-a', root, URL_CONFIG);
    for (const apply of [false, true])
      expect((await recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply, remote: false })).results[0]).toMatchObject({ status: 'refused', code: 'lfs_tracked' });
    expect(await config('source-a')).toEqual(URL_CONFIG);
  }), 60_000);

  test('--remote ignores commented-out filter=lfs lines, and says an LFS filter is declared when a committed rule names one that matches no file', () => brain(async () => {
    repoAt(defaultCloneDir('source-a'), { 'example.md': 'Canonical\n', '.gitattributes': '# *.bin filter=lfs diff=lfs merge=lfs -text\n   # *.psd filter=lfs\n*.md text\n' });
    repoAt(defaultCloneDir('source-b'), { 'example.md': 'Canonical\n', 'assets/.gitattributes': '*.psd filter=lfs diff=lfs merge=lfs -text\n' });
    await insert('source-a', defaultCloneDir('source-a'), URL_CONFIG);
    await insert('source-b', defaultCloneDir('source-b'), URL_CONFIG);
    const report = await recordSourceOrigin(engine, ['source-a', 'source-b'], { origin: 'remote', apply: false, remote: false });
    expect(report.results.map(result => result.code ?? result.status)).toEqual(['would_record', 'lfs_tracked']);
    expect(report.results[1]!.reason).toContain('declares a git-lfs filter');
    expect(report.results[1]!.reason).not.toContain('tracks files with git-lfs');
  }), 60_000);

  test('--remote records a clone of an empty repository: an unborn HEAD has no committed attributes, so there is nothing to restore', () => brain(async home => {
    const bare = join(home, 'empty.git');
    git(['init', '-q', '--bare', '-b', 'main', bare]);
    mkdirSync(join(home, 'clones'), { recursive: true });
    git(['clone', '-q', bare, defaultCloneDir('source-a')]);
    await insert('source-a', defaultCloneDir('source-a'), URL_CONFIG);
    expect((await recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply: true, remote: false })).results[0]).toMatchObject({ status: 'recorded' });
    expect(lfsDownloadsOff(await config('source-a'))).toBe(true);
  }), 60_000);

  test('lfs_unknown names its cause: a missing checkout, or a clone directory that is not the top level of its own repository', () => brain(async home => {
    await insert('source-a', defaultCloneDir('source-a'), URL_CONFIG);
    const missing = (await recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply: false, remote: false })).results[0]!;
    expect(missing).toMatchObject({ code: 'lfs_unknown' });
    expect(missing.reason).toContain('is missing');
    git(['init', '-q', home]);
    mkdirSync(defaultCloneDir('source-a'), { recursive: true });
    const enclosed = (await recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply: false, remote: false })).results[0]!;
    expect(enclosed).toMatchObject({ code: 'lfs_unknown' });
    expect(enclosed.reason).toContain('not the top level of its own Git repository');
    expect(enclosed.reason).not.toContain('is missing');
  }), 60_000);

  test('a write that throws mid-batch is reported for its id, and the ids before and after it keep their own results', () => brain(async () => {
    for (const id of ['source-a', 'source-b', 'source-c']) await insert(id, defaultCloneDir(id), URL_CONFIG);
    const transaction = engine.transaction.bind(engine);
    let calls = 0;
    const patched = spyOn(engine, 'transaction').mockImplementation(async fn => {
      if (++calls === 2) throw new Error('connection reset (example)');
      return transaction(fn);
    });
    let report: Awaited<ReturnType<typeof recordSourceOrigin>>;
    try { report = await recordSourceOrigin(engine, ['source-a', 'source-b', 'source-c'], { origin: 'local', apply: true, remote: false }); }
    finally { patched.mockRestore(); }
    expect(report.results.map(result => [result.source_id, result.code ?? result.status])).toEqual([['source-a', 'recorded'], ['source-b', 'write_failed'], ['source-c', 'recorded']]);
    expect(report.results[1]!.reason).toContain('connection reset (example)');
    expect(await config('source-b')).toEqual(URL_CONFIG);
    expect(await config('source-c')).toEqual({ ...URL_CONFIG, added_by_remote_caller: false });
  }), 60_000);

  test('--remote --apply on a managed source whose worktree has an active refresh is refused source_busy and writes nothing', () => brain(async home => {
    const { source, root } = await managedUrlSource(home, false);
    const [binding] = await engine.executeRaw<{ worktree_id: string }>('SELECT worktree_id::text FROM persistence_source_bindings WHERE source_id=$1', [source]);
    await engine.executeRaw(`INSERT INTO persistence_worktree_refreshes(worktree_id,source_ids,principal_id,owner_epoch,topology_generation,state,old_head,target_head,upstream_ref)
      VALUES($1::uuid,ARRAY[$2::text],$3::uuid,1,1,'draining','a','b','origin/main')`, [binding!.worktree_id, source, randomUUID()]);
    const [result] = (await recordSourceOrigin(engine, [source], { origin: 'remote', apply: true, remote: false })).results;
    expect(result).toMatchObject({ source_id: source, status: 'refused', code: 'source_busy' });
    expect(result!.reason).toContain('refresh');
    expect(result!.reason).toContain('nothing changed');
    expect(lfsDownloadsOff(await config(source))).toBe(false);
    expect(localConfig(root, 'core.hooksPath')).toBeNull();
  }), 120_000);

  test('a lock-down that fails part way leaves the checkout config as it was, and the record is not written', () => brain(async () => {
    const root = defaultCloneDir('source-a');
    repoAt(root, { 'example.md': 'Canonical\n' });
    await insert('source-a', root, URL_CONFIG);
    const original = childProcess.execFileSync;
    let writes = 0;
    const patched = spyOn(childProcess, 'execFileSync').mockImplementation(((file: string, args?: readonly string[], options?: object) => {
      if (file === 'git' && args?.includes('--file') && !args.includes('--unset-all') && ++writes === 2) throw new Error('config write failed (example)');
      return original(file, args as string[], options as never);
    }) as typeof childProcess.execFileSync);
    let report: Awaited<ReturnType<typeof recordSourceOrigin>>;
    try { report = await recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply: true, remote: false }); }
    finally { patched.mockRestore(); }
    expect(report.results[0]).toMatchObject({ source_id: 'source-a', status: 'refused', code: 'write_failed' });
    expect(report.results[0]!.reason).not.toContain('already has git-lfs downloads and hooks off');
    expect(localConfig(root, 'lfs.fetchexclude')).toBeNull();
    expect(existsSync(join(root, '.git', 'config.lock'))).toBe(false);
    expect(await config('source-a')).toEqual(URL_CONFIG);
  }), 60_000);

  test('a failed relock keeps the lock-down keys its checkout already had', () => brain(async () => {
    const root = defaultCloneDir('source-a');
    repoAt(root, { 'example.md': 'Canonical\n' });
    git(['-C', root, 'config', 'lfs.fetchexclude', '*']);
    await insert('source-a', root, { ...URL_CONFIG, added_by_remote_caller: true });
    const original = childProcess.execFileSync;
    const patched = spyOn(childProcess, 'execFileSync').mockImplementation(((file: string, args?: readonly string[], options?: object) => {
      if (file === 'git' && args?.includes('--file') && !args.includes('--unset-all') && args.includes('lfs.fetchexclude')) throw new Error('config write failed (example)');
      return original(file, args as string[], options as never);
    }) as typeof childProcess.execFileSync);
    let report: Awaited<ReturnType<typeof recordSourceOrigin>>;
    try { report = await recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply: true, remote: false }); }
    finally { patched.mockRestore(); }
    expect(report.results[0]).toMatchObject({ source_id: 'source-a', status: 'refused', code: 'write_failed' });
    expect(localConfig(root, 'lfs.fetchexclude')).toBe('*');
    expect(existsSync(join(root, '.git', 'config.lock'))).toBe(false);
  }), 60_000);

  test('the lock-down keeps a group-writable config mode and a symlinked config, as Git does', () => brain(async home => {
    const root = defaultCloneDir('source-a');
    repoAt(root, { 'example.md': 'Canonical\n' });
    const target = join(home, 'shared-config');
    writeFileSync(target, readFileSync(join(root, '.git', 'config')));
    chmodSync(target, 0o664);
    rmSync(join(root, '.git', 'config'));
    symlinkSync(target, join(root, '.git', 'config'));
    await insert('source-a', root, URL_CONFIG);
    expect((await recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply: true, remote: false })).results[0]).toMatchObject({ status: 'recorded' });
    expect(lstatSync(join(root, '.git', 'config')).isSymbolicLink()).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o664);
    expect(localConfig(root, 'core.hooksPath')).toBe('/dev/null');
    expect(existsSync(`${target}.lock`) || existsSync(join(root, '.git', 'config.lock'))).toBe(false);
  }), 60_000);

  test('a config.lock another Git process holds refuses the lock-down write_failed and leaves both files alone', () => brain(async () => {
    const root = defaultCloneDir('source-a');
    repoAt(root, { 'example.md': 'Canonical\n' });
    await insert('source-a', root, URL_CONFIG);
    writeFileSync(join(root, '.git', 'config.lock'), 'held (example)\n');
    const [result] = (await recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply: true, remote: false })).results;
    expect(result).toMatchObject({ source_id: 'source-a', status: 'refused', code: 'write_failed' });
    expect(result!.reason).toContain('config.lock exists');
    expect(readFileSync(join(root, '.git', 'config.lock'), 'utf8')).toBe('held (example)\n');
    expect(localConfig(root, 'core.hooksPath')).toBeNull();
    expect(await config('source-a')).toEqual(URL_CONFIG);
  }), 60_000);

  const effective = (root: string, key: string) => {
    try { return execFileSync('git', ['-C', root, 'config', '--get', key], { encoding: 'utf8', stdio: 'pipe' }).trim(); } catch { return null; }
  };

  test('a worktree-scoped setting that overrides the lock-down is refused write_failed, naming the key, and the record is not written', () => brain(async () => {
    const root = defaultCloneDir('source-a');
    repoAt(root, { 'example.md': 'Canonical\n' });
    git(['-C', root, 'config', 'extensions.worktreeConfig', 'true']);
    git(['-C', root, 'config', '--worktree', 'core.hooksPath', '/example/hooks']);
    await insert('source-a', root, URL_CONFIG);
    const [result] = (await recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply: true, remote: false })).results;
    expect(result).toMatchObject({ source_id: 'source-a', status: 'refused', code: 'write_failed' });
    expect(result!.reason).toContain('core.hooksPath');
    expect(result!.reason).toContain('already written');
    expect(effective(root, 'core.hooksPath')).toBe('/example/hooks');
    expect(await config('source-a')).toEqual(URL_CONFIG);
  }), 60_000);

  test('a linked worktree gets the lock-down in the config Git reads for it', () => brain(async home => {
    const main = join(home, 'main-checkout'), root = defaultCloneDir('source-a');
    repoAt(main, { 'example.md': 'Canonical\n' });
    mkdirSync(dirname(root), { recursive: true });
    git(['-C', main, 'worktree', 'add', '-q', '-b', 'source-a', root]);
    await insert('source-a', root, URL_CONFIG);
    expect((await recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply: true, remote: false })).results[0]).toMatchObject({ status: 'recorded' });
    expect([effective(root, 'lfs.fetchexclude'), effective(root, 'core.hooksPath'), effective(root, 'lfs.locksverify')]).toEqual(['*', '/dev/null', 'false']);
  }), 60_000);

  test('--remote --apply locks down a source recorded as remote before the lock-down existed, then reports already_recorded', () => brain(async () => {
    const root = defaultCloneDir('source-a');
    repoAt(root, { 'example.md': 'Canonical\n' });
    await insert('source-a', root, { ...URL_CONFIG, added_by_remote_caller: true });
    const preview = (await recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply: false, remote: false })).results[0]!;
    expect(preview).toMatchObject({ status: 'would_record' });
    expect(effective(root, 'core.hooksPath')).toBeNull();
    const applied = (await recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply: true, remote: false })).results[0]!;
    expect(applied).toMatchObject({ status: 'recorded' });
    expect(applied.reason).toContain('already recorded');
    expect([effective(root, 'lfs.fetchexclude'), effective(root, 'core.hooksPath'), effective(root, 'lfs.locksverify')]).toEqual(['*', '/dev/null', 'false']);
    expect(await config('source-a')).toEqual({ ...URL_CONFIG, added_by_remote_caller: true });
    expect((await recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply: true, remote: false })).results[0]).toMatchObject({ status: 'already_recorded' });
  }), 60_000);

  test('a source recorded as remote whose remote later committed a git-lfs rule still gets the lock-down, not an lfs_tracked refusal', () => brain(async () => {
    const root = defaultCloneDir('source-a');
    repoAt(root, { 'example.md': 'Canonical\n', '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n' });
    await insert('source-a', root, { ...URL_CONFIG, added_by_remote_caller: true });
    expect((await recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply: false, remote: false })).results[0]).toMatchObject({ status: 'would_record' });
    const applied = (await recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply: true, remote: false })).results[0]!;
    expect(applied).toMatchObject({ status: 'recorded' });
    expect(applied.reason).not.toContain('sources remove');
    expect([effective(root, 'lfs.fetchexclude'), effective(root, 'core.hooksPath'), effective(root, 'lfs.locksverify')]).toEqual(['*', '/dev/null', 'false']);
    expect(await config('source-a')).toEqual({ ...URL_CONFIG, added_by_remote_caller: true });
  }), 60_000);

  test('a shared config that already holds several values for a lock-down key gets one clone-time value, so the record is written', () => brain(async () => {
    const root = defaultCloneDir('source-a');
    repoAt(root, { 'example.md': 'Canonical\n' });
    git(['-C', root, 'config', '--add', 'lfs.fetchexclude', 'docs/*']);
    git(['-C', root, 'config', '--add', 'lfs.fetchexclude', 'media/*']);
    await insert('source-a', root, URL_CONFIG);
    expect((await recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply: true, remote: false })).results[0]).toMatchObject({ status: 'recorded' });
    expect(execFileSync('git', ['-C', root, 'config', '--get-all', 'lfs.fetchexclude'], { encoding: 'utf8' }).trim()).toBe('*');
    expect(await config('source-a')).toEqual({ ...URL_CONFIG, added_by_remote_caller: true });
  }), 60_000);

  test('lfs_unknown tells a corrupt .git and a safe.directory refusal apart from a directory outside its own repository', () => brain(async () => {
    const root = defaultCloneDir('source-a');
    repoAt(root, { 'example.md': 'Canonical\n' });
    await insert('source-a', root, URL_CONFIG);
    writeFileSync(join(root, '.git', 'config'), '[core\n');
    const corrupt = (await recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply: false, remote: false })).results[0]!;
    expect(corrupt).toMatchObject({ code: 'lfs_unknown' });
    expect(corrupt.reason).toContain('Git could not list or read');
    expect(corrupt.reason).not.toContain('not the top level');
    const original = childProcess.spawnSync;
    const patched = spyOn(childProcess, 'spawnSync').mockImplementation(((file: string, args?: readonly string[], options?: object) => {
      if (file === 'git' && args?.includes('--show-toplevel'))
        return { pid: 0, output: [], stdout: Buffer.from(''), stderr: Buffer.from(`fatal: detected dubious ownership in repository at '${root}'\n`), status: 128, signal: null };
      return original(file, args as string[], options as never);
    }) as typeof childProcess.spawnSync);
    let unsafe: Awaited<ReturnType<typeof recordSourceOrigin>>;
    try { unsafe = await recordSourceOrigin(engine, ['source-a'], { origin: 'remote', apply: false, remote: false }); }
    finally { patched.mockRestore(); }
    expect(unsafe.results[0]).toMatchObject({ code: 'lfs_unknown' });
    expect(unsafe.results[0]!.reason).toContain('another user owns it');
  }), 60_000);
});
