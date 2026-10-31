/**
 * #7630 (1 of 3; split from one file by #7802 so each Postgres run stays well under run-e2e.sh's per-file cap): a relative
 * stored sync anchor (a legacy `sources.local_path` of ".") must never make sync treat the directory it runs from as the
 * brain.
 *
 * Before the fix, `gbrain sync --source default` (or `--all`) run from an unrelated folder resolved "." to that folder,
 * `isAnchorOwnedSyncPath` compared realpath(".") with realpath(cwd) (always equal), and preflight Git-initialized the
 * folder, committed everything in it as a baseline and imported its markdown. A foreground write that ended
 * `preparation_stalled` meanwhile got a receipt telling the user to run exactly that sync.
 *
 * Protects (this file: the sync refusal and the clear fix):
 * - sync refuses `sync_anchor_relative` (exit 3, a fix asking the user for `gbrain sources set-path <id> <dir>`) for a relative
 *   `local_path` reached by `--source` (the anchor read) or by `--all` (the row's path passed through), and for a relative
 *   legacy `sync.repo_path`; the folder gets no `.git` and nothing is imported;
 * - a relative anchor never proves ownership, so even an explicit absolute path to the cwd is not auto-initialized;
 * - `gbrain sources set-path <id> --clear` clears a relative filesystem path without SQL, and still refuses an absolute one.
 *
 * The other cases live in sync-relative-anchor-readers-7630.test.ts and sync-relative-anchor-guards-7630.test.ts.
 * PGLite always; Postgres when DATABASE_URL is set (test/e2e/sync-relative-anchor-refusal-7630-postgres.test.ts).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { isAnchorOwnedSyncPath } from '../src/core/sync-anchor.ts';
import { clearConnectorLocalPath } from '../src/core/persistence/connector-path.ts';
import { defaultSourceLocalPathCheck } from '../src/commands/doctor/checks/default-source-path.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

const SYNC = { noPull: true, noEmbed: true, noExtract: true, full: true };

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`#7630 [${backend}]: a relative stored anchor never makes the cwd the brain`, () => {
    let engine: BrainEngine, close: () => Promise<void>, home: string, folder: string, previousCwd: string;

    beforeEach(async () => {
      home = mkdtempSync(join(tmpdir(), 'gbrain-7630-home-'));
      folder = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-7630-unrelated-')));
      writeFileSync(join(folder, 'notes.md'), '---\ntype: note\ntitle: Notes\n---\n\nA note that is not part of any brain.\n');
      writeFileSync(join(folder, 'private.txt'), 'not for any brain\n');
      ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl));
      previousCwd = process.cwd();
      process.chdir(folder);
    }, 120_000);

    afterEach(async () => {
      process.chdir(previousCwd);
      await close();
      rmSync(folder, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });

    const pageCount = async () => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages'))[0]!.n;
    const sync = async (opts: Record<string, unknown>) => withEnv({ GBRAIN_HOME: home }, async () => {
      const { performSync } = await import('../src/commands/sync.ts');
      return performSync(engine, { ...SYNC, ...opts }).then(() => null, (error: unknown) => error as { code?: string; fix?: { argv?: string[]; ask_user?: boolean } });
    });
    const cli = async (run: () => Promise<unknown>) => {
      const lines: string[] = [];
      let exit: number | undefined;
      const push = (...a: unknown[]) => { lines.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
      const spies = [spyOn(console, 'log').mockImplementation(push), spyOn(console, 'error').mockImplementation(push),
        spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { lines.push(String(chunk)); return true; }) as never),
        spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code; throw new Error(`__exit__${code}`); }) as never)];
      try {
        await withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, GBRAIN_ALLOW_DEFAULT_WRITE: undefined }, run);
      } catch (error) {
        if (!String(error).includes('__exit__')) throw error;
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      return { lines, exit };
    };
    const pagesOf = async (sourceId: string) =>
      (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1', [sourceId]))[0]!.n;

    const runSyncCli = async (args: string[]) => {
      let refused: { code?: string } | undefined;
      const result = await cli(async () => {
        const { runSync } = await import('../src/commands/sync.ts');
        await runSync(engine, args).catch((error: { code?: string }) => {
          if (String(error).includes('__exit__')) throw error;
          refused = error;
        });
      });
      return { ...result, refused };
    };

    test('--source default with local_path "." refuses sync_anchor_relative: no .git, no commit, no import', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const before = await pageCount();
      const refused = await sync({ sourceId: 'default' });
      expect(refused?.code).toBe('sync_anchor_relative');
      expect(refused?.fix?.argv).toEqual(['gbrain', 'sources', 'set-path', 'default', '<dir>']);
      expect(refused?.fix?.ask_user).toBe(true);
      expect(existsSync(join(folder, '.git'))).toBe(false);
      expect(await pageCount()).toBe(before);
    }, 120_000);

    test('--all passes the row\'s "." through as repoPath: refused the same way', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const refused = await sync({ sourceId: 'default', repoPath: '.' });
      expect(refused?.code).toBe('sync_anchor_relative');
      expect(existsSync(join(folder, '.git'))).toBe(false);
    }, 120_000);

    // Value: protects=gbrain sync --all fails only the source with a relative local_path and still syncs an absolute one;
    //   fails_when=the --all fan-out guard aborts the whole run, drops the source, or reports it ok / imports the cwd;
    //   why_new=the performSync cases above never enter runSyncAll's fan-out or its per-source JSON envelope; seam=none;
    //   no_claim=the cost-gate walk ordering (--no-embed skips the gate), the exit-3 mapping of a single-source run, and parallel
    //   import workers (--workers 1: a worker opens the configured DATABASE_URL, not this test's isolated Postgres database)
    test('gbrain sync --all fails only the relative source: an absolute source still syncs and the cwd is untouched', async () => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-7630-repo-')));
      try {
        execSync('git init -q && git config user.email t@example.com && git config user.name T', { cwd: repo, stdio: 'pipe' });
        writeFileSync(join(repo, 'kept.md'), '---\ntype: note\ntitle: Kept\n---\n\nA page of the absolute source.\n');
        execSync('git add -A && git commit -q -m initial', { cwd: repo, stdio: 'pipe' });
        await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
        await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', $1)", [repo]);
        const before = await pagesOf('default');
        const { lines, exit } = await cli(async () => {
          const { runSync } = await import('../src/commands/sync.ts');
          await runSync(engine, ['--all', '--no-pull', '--no-embed', '--json', '--workers', '1']);
        });
        const envelope = JSON.parse(lines.find(line => line.startsWith('{"schema_version"'))!) as { sources: Array<{ source_id: string; status: string; error?: string }>; error_count: number };
        const bySource = Object.fromEntries(envelope.sources.map(s => [s.source_id, s]));
        expect(bySource.default?.status).toBe('error');
        expect(bySource.default?.error).toContain('relative local_path');
        expect(bySource['notes-a']?.status).not.toBe('error');
        expect(envelope.error_count).toBe(1);
        expect(exit).toBe(1);
        expect(existsSync(join(folder, '.git'))).toBe(false);
        expect(await pagesOf('default')).toBe(before);
        expect(await pagesOf('notes-a')).toBe(1);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }, 120_000);

    // Value: protects=gbrain sync --source with a relative anchor refuses before the embed cost gate estimates the cwd or calls a provider;
    //   fails_when=the runSingleSourceSync guard is removed or moved after the cost gate, which then walks and prices the cwd's files;
    //   why_new=every other refusal case uses performSync or --no-embed, which skips the gate; seam=none;
    //   no_claim=a real provider (dummy key via configureGateway; fetch is watched, never answered)
    test('gbrain sync --source default refuses a relative anchor before the embed cost gate: no estimate, no provider call', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      for (let i = 0; i < 5; i++) writeFileSync(join(folder, `page-${i}.md`), `---\ntype: note\ntitle: Page ${i}\n---\n\n${'word '.repeat(200)}\n`);
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test-7630' } });
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => { throw new Error('#7630 test: no provider call'); }) as never);
      let result: Awaited<ReturnType<typeof runSyncCli>>, fetchCalls: number;
      try {
        result = await runSyncCli(['--source', 'default', '--no-pull']);
      } finally {
        fetchCalls = fetchSpy.mock.calls.length;
        fetchSpy.mockRestore();
        resetGateway();
      }
      expect(result.refused?.code).toBe('sync_anchor_relative');
      expect(fetchCalls).toBe(0);
      expect(result.lines.join('\n')).not.toMatch(/cost gate floor|Exceeds floor/);
      expect(existsSync(join(folder, '.git'))).toBe(false);
      expect(await pagesOf('default')).toBe(0);
    }, 120_000);

    // Value: protects=with an explicit absolute --repo and a stored "." the embed cost gate prices the --repo directory, never the cwd;
    //   fails_when=the gate input prefers the stored relative local_path, so the estimate runs git and walks files in whatever folder
    //   gbrain runs from; why_new=the gate case above refuses before the gate (no --repo); seam=resolveSingleSyncEmbedPlan spied to
    //   record its source and stop the run; no_claim=what the estimate would cost
    test('gbrain sync --repo <absolute> with a stored "." prices the --repo directory in the cost gate, never the cwd', async () => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-7630-gate-')));
      try {
        execSync('git init -q && git config user.email t@example.com && git config user.name T', { cwd: repo, stdio: 'pipe' });
        writeFileSync(join(repo, 'inside.md'), '---\ntype: note\ntitle: Inside\n---\n\nA page of the brain.\n');
        execSync('git add -A && git commit -q -m initial', { cwd: repo, stdio: 'pipe' });
        await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
        configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test-7630' } });
        const embedBackfill = await import('../src/core/sync-embed-backfill.ts');
        const priced: Array<string | null> = [];
        const gate = spyOn(embedBackfill, 'resolveSingleSyncEmbedPlan').mockImplementation(async (_e, source) => {
          priced.push(source.local_path ?? null);
          return { stop: true, workerSurface: { status: 'ok' } as never, autoDeferEmbeds: false };
        });
        try {
          await runSyncCli(['--repo', repo, '--source', 'default', '--no-pull']);
        } finally {
          gate.mockRestore();
          resetGateway();
        }
        expect(priced).toEqual([repo]);
        expect(existsSync(join(folder, '.git'))).toBe(false);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }, 120_000);

    // Value: protects=an explicit relative --repo that differs from the stored relative anchor is honored: that directory syncs;
    //   fails_when=the guard starts refusing every relative repoPath instead of only the stored anchor itself;
    //   why_new=no other case passes a relative repoPath other than the anchor; seam=none; no_claim=parallel import workers
    //   (--workers 1: a worker opens the configured DATABASE_URL, not this test's isolated Postgres database)
    test('gbrain sync --repo brain (relative, not the stored ".") is honored: brain syncs, the cwd stays untouched', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const brain = join(folder, 'brain');
      mkdirSync(brain);
      execSync('git init -q && git config user.email t@example.com && git config user.name T', { cwd: brain, stdio: 'pipe' });
      writeFileSync(join(brain, 'inside.md'), '---\ntype: note\ntitle: Inside\n---\n\nA page of the brain.\n');
      execSync('git add -A && git commit -q -m initial', { cwd: brain, stdio: 'pipe' });
      const result = await runSyncCli(['--repo', 'brain', '--no-pull', '--no-embed', '--json', '--workers', '1']);
      expect(result.refused?.code).toBeUndefined();
      expect(result.exit).toBeUndefined();
      const slugs = (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' ORDER BY slug")).map(row => row.slug);
      expect(slugs).toEqual(['inside']);
      expect(existsSync(join(folder, '.git'))).toBe(false);
    }, 120_000);

    // Value: protects=gbrain sync --repo . with a stored anchor of "." refuses sync_anchor_relative and git-inits nothing (decided: keep the refusal);
    //   fails_when=an explicit --repo bypasses the guard and the cwd is resolved as the brain; why_new=the performSync "." case never runs the CLI
    //   --repo flag through runSingleSourceSync; seam=none; no_claim=none beyond protects
    test('gbrain sync --repo . with a stored "." is refused sync_anchor_relative: no .git, no import', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const result = await runSyncCli(['--repo', '.', '--no-pull', '--no-embed', '--json']);
      expect(result.refused?.code).toBe('sync_anchor_relative');
      expect(existsSync(join(folder, '.git'))).toBe(false);
      expect(await pagesOf('default')).toBe(0);
    }, 120_000);

    test('a relative legacy sync.repo_path refuses with the config fix', async () => {
      await engine.setConfig('sync.repo_path', '.');
      const refused = await sync({});
      expect(refused?.code).toBe('sync_anchor_relative');
      expect(refused?.fix?.argv).toEqual(['gbrain', 'config', 'set', 'sync.repo_path', '<dir>']);
      expect(existsSync(join(folder, '.git'))).toBe(false);
    }, 120_000);

    test('a relative anchor proves no ownership: an explicit absolute path to the cwd is not auto-initialized', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      expect(await isAnchorOwnedSyncPath(engine, { sourceId: 'default' } as never, folder)).toBe(false);
      const failed = await sync({ sourceId: 'default', repoPath: folder });
      expect(failed).not.toBeNull();
      expect(failed?.code).not.toBe('sync_anchor_relative');
      expect(existsSync(join(folder, '.git'))).toBe(false);
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [folder]);
      expect(await isAnchorOwnedSyncPath(engine, { sourceId: 'default' } as never, folder)).toBe(true);
    }, 120_000);

    test('sources set-path --clear clears a relative filesystem path without SQL; an absolute one stays refused', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      expect(await clearConnectorLocalPath(engine, 'default')).toEqual({ prior: '.', connector: false });
      expect((await engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'"))[0]!.local_path).toBeNull();
      expect(await clearConnectorLocalPath(engine, 'default')).toEqual({ prior: null, connector: false });
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [folder]);
      expect((await clearConnectorLocalPath(engine, 'default').catch(error => error)).code).toBe('invalid_params');
      expect((await engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'"))[0]!.local_path).toBe(folder);
      // A Windows-absolute path stored by another host sharing the brain is never relative: --clear refuses it and doctor does not list it.
      await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-w', 'notes-w', $1)", ['C:\\brain-example']);
      expect((await clearConnectorLocalPath(engine, 'notes-w').catch(error => error)).code).toBe('invalid_params');
      expect((await defaultSourceLocalPathCheck(engine))?.message ?? '').not.toContain('notes-w');
      await engine.executeRaw("DELETE FROM sources WHERE id='notes-w'");
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", ['C:\\brain-example']);
      expect((await defaultSourceLocalPathCheck(engine))?.message ?? '').not.toContain('relative path');
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [folder]);
      // Value: protects=a relative local_path whose source has a canonical owner binding is never cleared (writer_transfer_required);
      //   fails_when=the relative-path clear is moved ahead of the binding check; why_new=sources-set-path-clear covers only a bound
      //   connector; seam=none; no_claim=a real activated managed brain (the binding row is inserted directly)
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
      const [worktree] = await engine.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees DEFAULT VALUES RETURNING id');
      await engine.executeRaw('INSERT INTO persistence_source_bindings (source_id, source_incarnation, worktree_id) VALUES ($1, $2::uuid, $3::uuid)',
        ['default', incarnation, worktree!.id]);
      expect((await clearConnectorLocalPath(engine, 'default').catch(error => error)).code).toBe('writer_transfer_required');
      expect((await engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'"))[0]!.local_path).toBe('.');
    }, 120_000);

    // Value: protects=the CLI clear of a relative filesystem path says sync refuses until a directory is set, not that autopilot syncs it;
    //   fails_when=runClearPath drops the connector branch and prints the connector's autopilot line for a filesystem source;
    //   why_new=the case above calls clearConnectorLocalPath directly and never reads the CLI output; seam=none; no_claim=none beyond protects
    test('gbrain sources set-path default --clear on a relative path names the absolute set-path and never promises autopilot sync', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const { lines, exit } = await cli(async () => {
        const { runSources } = await import('../src/commands/sources.ts');
        await runSources(engine, ['set-path', 'default', '--clear']);
      });
      const text = lines.join('\n');
      expect(exit, text).toBeUndefined();
      expect(text).toContain('Cleared source "default" local_path (was .).');
      expect(text).toContain('Sync of "default" refuses until a directory is set: gbrain sources set-path default <absolute-directory>.');
      expect(text).not.toContain('Autopilot keeps syncing');
      expect((await engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'"))[0]!.local_path).toBeNull();
    }, 120_000);
  });
}
