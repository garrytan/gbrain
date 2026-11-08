import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { urlSourceOriginCheck } from '../src/commands/doctor/checks/url-source-origin.ts';

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
});
