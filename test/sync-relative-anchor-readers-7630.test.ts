/**
 * #7630 (2 of 3; split from sync-relative-anchor-refusal-7630.test.ts by #7802): a relative stored sync anchor (a legacy
 * `sources.local_path` of ".") must never make sync treat the directory it runs from as the brain. See that file for the
 * failure this pins.
 *
 * Protects (this file: doctor, config and the readers that must ignore a relative root):
 * - doctor's `default_source_local_path` warns on a relative path, on any source, and `config set sync.repo_path` refuses one;
 * - no other reader resolves a relative root against the cwd: write-through, page and fact writes, capture origins,
 *   folder-to-source matching, fence repair, activation, import roots, remote submit_job, managed roots, and the dream,
 *   autopilot, per-phase and global maintenance cycles.
 *
 * PGLite always; Postgres when DATABASE_URL is set (test/e2e/sync-relative-anchor-readers-7630-postgres.test.ts).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { clearConnectorLocalPath } from '../src/core/persistence/connector-path.ts';
import { defaultSourceLocalPathCheck } from '../src/commands/doctor/checks/default-source-path.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

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

    test('doctor default_source_local_path warns on a relative path and names the fix', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const check = await defaultSourceLocalPathCheck(engine);
      expect(check?.status).toBe('warn');
      expect(check?.message).toContain('gbrain sources set-path default --clear');
    }, 120_000);

    test('no other reader treats the cwd as a relative source root: write-through, install fallback, cycle source match, import roots, remote submit_job, managed roots', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      await engine.setConfig('sync.repo_path', '.');
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const { resolvePageWriteTarget } = await import('../src/core/write-through.ts');
        expect(await resolvePageWriteTarget(engine, 'notes', 'default')).toEqual({ ok: false, skipped: 'repo_not_found' });
        await engine.executeRaw("UPDATE sources SET local_path=NULL WHERE id='default'");
        expect(await resolvePageWriteTarget(engine, 'notes', 'default')).toEqual({ ok: false, skipped: 'repo_not_found' });
        await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");

        const { installRepoFallback } = await import('../src/commands/autopilot/install-repo.ts');
        expect(await installRepoFallback(engine)).toBeNull();

        const { resolveSourceForDir } = await import('../src/core/cycle.ts');
        expect(await resolveSourceForDir(engine, folder)).toBeUndefined();

        const { listConfiguredRoots } = await import('../src/commands/import.ts');
        expect(await listConfiguredRoots(engine, 'default')).not.toContain(folder);

        const { prepareRemoteJob } = await import('../src/core/minions/submission-authority.ts');
        const remote = { engine, config: {}, dryRun: false, remote: true, sourceId: 'default', logger: { info() {}, warn() {}, error() {} },
          auth: { token: 'test-only', clientId: 'client-a', principal: { kind: 'oauth_client', id: 'client-a' }, scopes: ['admin'], sourceId: 'default' } };
        for (const name of ['import', 'lint']) await expect(prepareRemoteJob(remote as never, name, {})).rejects.toThrow('relative path');

        const { refreshManagedFilesystemRoots } = await import('../src/core/persistence/filesystem-guard.ts');
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        try { await refreshManagedFilesystemRoots(engine); }
        finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); }
        expect(existsSync(join(folder, '.gbrain-managed'))).toBe(false);
      });
      expect(existsSync(join(folder, '.git'))).toBe(false);
    }, 120_000);

    test('dream and the autopilot cycle run no filesystem phase against the cwd for a relative local_path or sync.repo_path', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      await engine.setConfig('sync.repo_path', '.');
      await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined }, async () => {
        const { runDream } = await import('../src/commands/dream.ts');
        const scoped = await runDream(engine, ['--source', 'default', '--phase', 'lint', '--json']) as { brain_dir: string | null };
        expect(scoped.brain_dir).toBeNull();
        const unscoped = await runDream(engine, ['--phase', 'lint', '--json']) as { brain_dir: string | null };
        expect(unscoped.brain_dir).toBeNull();

        const { registerBuiltinHandlers } = await import('../src/commands/jobs.ts');
        const handlers = new Map<string, (job: unknown) => Promise<{ report: { brain_dir: string | null } }>>();
        await registerBuiltinHandlers({ register(name: string, fn: never) { handlers.set(name, fn); } } as never, engine);
        const cycle = handlers.get('autopilot-cycle')!;
        expect((await cycle({ data: { source_id: 'default', phases: ['recompute_emotional_weight'] }, signal: undefined })).report.brain_dir).toBeNull();
        expect((await cycle({ data: { phases: ['recompute_emotional_weight'] }, signal: undefined })).report.brain_dir).toBeNull();
        expect((await cycle({ data: { repoPath: '.', phases: ['recompute_emotional_weight'] }, signal: undefined })).report.brain_dir).toBeNull();
      });
      expect(existsSync(join(folder, '.git'))).toBe(false);
      expect(await pageCount()).toBe(0);
    }, 120_000);

    // Value: protects=a relative local_path or sync.repo_path never becomes the cwd for folder-to-source matching, fence repair,
    //   page and fact write-through (including the automatic claim of an unbound PGLite source), capture origins, activation
    //   or the per-phase and global maintenance jobs; fails_when=any of those readers resolves "." against process.cwd();
    //   why_new=the reader test above covers write-through, install, cycle, import, submit_job and managed roots only; seam=none;
    //   no_claim=readers that only test whether a root is set (atom, facts and prepared maintenance refuse without an owner)
    test('the remaining readers ignore a relative root: source matching, fence repair, page and fact writes, activation, phase and global maintenance', async () => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-7630-src-')));
      try {
        mkdirSync(join(repo, 'sub'));
        await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
        await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', $1)", [repo]);
        await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined }, async () => {
          const { resolveSourceId, resolveSourceForRepoPath } = await import('../src/core/source-resolver.ts');
          process.chdir(join(repo, 'sub'));
          try {
            expect(await resolveSourceId(engine, null, join(repo, 'sub'))).toBe('notes-a');
            expect((await resolveSourceForRepoPath(engine, join(repo, 'sub')))?.source_id).toBe('notes-a');
          } finally { process.chdir(folder); }

          const { loadFenceSource } = await import('../src/core/fence-repair/repair-io.ts');
          expect((await loadFenceSource(engine, 'default'))?.root).toBeNull();

          const { resolveFactWriteTarget } = await import('../src/core/persistence/fact-write-target.ts');
          expect((await resolveFactWriteTarget(engine, 'default', { local_path: '.', kind: null }, { fileBacked: false, remote: false })).kind).toBe('publish');

          const { operations } = await import('../src/core/operations.ts');
          const ctx = { engine, config: { engine: backend }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default', deferEmbeds: true };
          await operations.find(o => o.name === 'put_page')!.handler(ctx as never, { slug: 'notes/kept-in-db', content: '---\ntype: note\ntitle: Kept\n---\n\nA page with no folder of its own.\n' });
          const { getWorktreeBinding } = await import('../src/core/persistence/ownership.ts');
          expect(await getWorktreeBinding(engine, 'default')).toBeNull();
          expect(existsSync(join(folder, 'notes'))).toBe(false);
          await operations.find(o => o.name === 'capture')!.handler(ctx as never, { slug: 'notes', content: 'A captured note.', local_file: join(folder, 'notes.md') });
          expect(await engine.executeRaw("SELECT source_uri FROM pages WHERE source_id='default' AND slug='notes'")).toEqual([{ source_uri: 'cli-file' }]);

          const { activatePersistence } = await import('../src/core/persistence/activation.ts');
          const refused = await activatePersistence(engine, { confirmQuiesced: true, dryRun: true }).then(() => ({}), (error: unknown) => error) as { detail?: string; message?: string };
          expect(refused).toMatchObject({ detail: 'source_path_missing' });
          expect(refused.message).toContain("records the relative local path .");

          await engine.setConfig('sync.repo_path', '.');
          await engine.executeRaw("UPDATE sources SET local_path=NULL WHERE id='default'");
          const { makeCyclePhaseHandler } = await import('../src/core/minions/handlers/cycle-phase.ts');
          const phase = await makeCyclePhaseHandler(engine, 'recompute_emotional_weight')({ id: 1, data: {}, signal: undefined } as never) as { report: { brain_dir: string | null } };
          expect(phase.report.brain_dir).toBeNull();
          const { makeAutopilotGlobalMaintenanceHandler } = await import('../src/core/minions/handlers/autopilot-global-maintenance.ts');
          const brainDirs: Array<string | null | undefined> = [];
          const runCycle = async (_engine: BrainEngine, opts: { phases?: string[]; brainDir?: string | null }) => {
            brainDirs.push(opts.brainDir);
            return { schema_version: '1', timestamp: new Date().toISOString(), duration_ms: 1, status: 'ok', totals: {},
              phases: [{ phase: opts.phases![0], status: 'ok', duration_ms: 1, summary: 'ok', details: {} }] };
          };
          await makeAutopilotGlobalMaintenanceHandler(engine, { runCycle: runCycle as never })({ id: 2, attempts_made: 0, signal: undefined, deadlineAtMs: null, data: { phases: ['orphans'] } } as never);
          expect(brainDirs.length).toBeGreaterThan(0);
          expect(brainDirs.every(dir => dir === null)).toBe(true);
        });
        expect(existsSync(join(folder, '.git'))).toBe(false);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }, 120_000);

    test('gbrain config set sync.repo_path refuses a relative path and writes nothing; an absolute one is stored', async () => {
      const { runConfig } = await import('../src/commands/config.ts');
      const refused = await cli(() => runConfig(engine, ['set', 'sync.repo_path', '.']));
      expect(refused.exit).toBe(1);
      expect(refused.lines.join('\n')).toContain('sync.repo_path must be an absolute directory');
      expect(await engine.getConfig('sync.repo_path')).toBeNull();
      const stored = await cli(() => runConfig(engine, ['set', 'sync.repo_path', folder]));
      expect(stored.exit).toBeUndefined();
      expect(await engine.getConfig('sync.repo_path')).toBe(folder);
    }, 120_000);

    test('doctor default_source_local_path warns for any source with a relative path, not only default', async () => {
      await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', 'notes')");
      const check = await defaultSourceLocalPathCheck(engine);
      expect(check?.status).toBe('warn');
      expect(check?.message).toContain('source "notes-a" has the relative local_path "notes"');
      expect(check?.message).toContain('gbrain sources set-path <id> <absolute-directory>');
    }, 120_000);

    // /ship coverage audit (GBRA-207, #7630).
    // Value: protects=doctor default_source_local_path stays ok when every live source path is absolute and only an archived source is relative;
    //   fails_when=the relative-source query drops its isAbsolute filter or its archived exclusion, so every multi-source brain warns;
    //   why_new=the two doctor cases above assert only the warn side; seam=none; no_claim=other doctor checks (only this check runs)
    test('doctor default_source_local_path stays ok with absolute sources and a relative path only on an archived source', async () => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-7630-abs-')));
      try {
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [folder]);
        await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', $1)", [repo]);
        await engine.executeRaw("INSERT INTO sources (id, name, local_path, archived, archived_at) VALUES ('notes-b', 'notes-b', 'notes', true, now())");
        const check = await defaultSourceLocalPathCheck(engine);
        expect(check?.status).toBe('ok');
        expect(check?.message).not.toContain('relative local_path');
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }, 120_000);

    // /ship review fixes (GBRA-207, #7630).
    // Value: protects=doctor names a relative legacy sync.repo_path behind a null default local_path instead of reporting the fallback healthy;
    //   fails_when=the wrapper resolves "." against the cwd (existsSync is true) and the assessor reports "write through sync.repo_path (.)";
    //   why_new=the doctor cases above set a relative local_path, never the legacy key; seam=none; no_claim=other doctor checks
    test('doctor default_source_local_path warns on a relative sync.repo_path behind a null default local_path', async () => {
      await engine.setConfig('sync.repo_path', '.');
      await engine.putPage('notes/live', { type: 'note', title: 'Live', compiled_truth: 'A live default page.', timeline: '' }, { sourceId: 'default' });
      const check = await defaultSourceLocalPathCheck(engine);
      expect(check?.status).toBe('warn');
      expect(check?.message).toContain('sync.repo_path is the relative path "."');
      expect(check?.message).toContain('gbrain config set sync.repo_path <absolute-directory>');
      expect(check?.message).toContain('gbrain sources set-path default <absolute-directory>');
      expect(check?.message).not.toContain('sync refuses it');
    }, 120_000);

    // Value: protects=a successful sync of another source never runs .gitignore upkeep on the cwd's Git repo through a stored relative root;
    //   fails_when=post-sync upkeep takes getDefaultSourcePath's "." (a second non-default source keeps the cwd chain on default)
    //   and writes the managed block into the cwd repo's .gitignore;
    //   why_new=the --all case above never reaches the single-source post-sync upkeep; seam=none;
    //   no_claim=watch mode (the same expression at its second call site), parallel import workers (--workers 1)
    test('gbrain sync --source of an absolute source leaves the cwd repo\'s .gitignore alone when default\'s local_path is "."', async () => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-7630-repo-')));
      try {
        execSync('git init -q && git config user.email t@example.com && git config user.name T', { cwd: repo, stdio: 'pipe' });
        writeFileSync(join(repo, 'kept.md'), '---\ntype: note\ntitle: Kept\n---\n\nA page of the absolute source.\n');
        execSync('git add -A && git commit -q -m initial', { cwd: repo, stdio: 'pipe' });
        execSync('git init -q', { cwd: folder, stdio: 'pipe' });
        writeFileSync(join(folder, 'gbrain.yml'), 'storage:\n  db_only:\n    - media/x/\n');
        await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
        await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', $1)", [repo]);
        await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-b', 'notes-b', $1)", [join(repo, 'elsewhere')]);
        const { exit } = await cli(async () => {
          const { runSync } = await import('../src/commands/sync.ts');
          await runSync(engine, ['--source', 'notes-a', '--no-pull', '--no-embed', '--workers', '1']);
        });
        expect(exit ?? 0).toBe(0);
        expect(await pagesOf('notes-a')).toBe(1);
        expect(existsSync(join(folder, '.gitignore'))).toBe(false);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }, 120_000);

    // Value: protects=a local_path that is absolute only for another OS (a Windows drive path read on POSIX, stored by a host sharing
    //   the brain) still refuses sync, but the refusal neither calls it relative nor offers `set-path --clear`, which refuses that
    //   path; fails_when=syncAnchorRelativeError gives it the relative-path text and the --clear suggestion, a dead end;
    //   why_new=the --clear case only pins that --clear refuses it, and no sync case stores a foreign path; seam=none;
    //   no_claim=a POSIX path read on Windows (rooted, so absolute there)
    test.skipIf(process.platform === 'win32')('sync of a Windows-absolute local_path on POSIX refuses with set-path only, not as relative', async () => {
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", ['C:\\brain-example']);
      const refused = await sync({ sourceId: 'default' }) as { code?: string; message?: string; suggestion?: string; fix?: { argv?: string[]; user_message?: string } } | null;
      expect(refused?.code).toBe('sync_anchor_relative');
      expect(refused?.message).toContain('not an absolute path on this host');
      expect(refused?.message).not.toContain('relative local_path');
      expect(`${refused?.suggestion ?? ''} ${refused?.fix?.user_message ?? ''}`).not.toContain('--clear');
      expect(refused?.fix?.argv).toEqual(['gbrain', 'sources', 'set-path', 'default', '<dir>']);
      expect(existsSync(join(folder, '.git'))).toBe(false);
      expect((await clearConnectorLocalPath(engine, 'default').catch(error => error)).code).toBe('invalid_params');
    }, 120_000);

    // Value: protects=the untested cells of the relative-anchor hold: set-path over a stored "." stores the absolute directory, --clear
    //   leaves a relative legacy sync.repo_path alone (its fix is config set), and a sibling stored as another OS's absolute path is
    //   never matched to a folder nor counted as an overlap; fails_when=set-path keeps the relative row, --clear rewrites the config key,
    //   or resolveSourceForDir/assertNoOverlappingPath resolve the foreign path against the cwd; why_new=the existing cases start from an
    //   absolute prior or a "." sibling; seam=none; no_claim=the CLI rendering of set-path (covered by sources-set-path tests)
    test('set-path over ".", --clear beside a relative sync.repo_path, and a foreign-OS sibling in folder matching and overlap', async () => {
      await engine.executeRaw("UPDATE sources SET local_path=NULL WHERE id='default'");
      await engine.setConfig('sync.repo_path', '.');
      expect(await clearConnectorLocalPath(engine, 'default')).toEqual({ prior: null, connector: false });
      expect(await engine.getConfig('sync.repo_path')).toBe('.');
      await engine.setConfig('sync.repo_path', folder);
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      await cli(async () => {
        const { runSources } = await import('../src/commands/sources.ts');
        await runSources(engine, ['set-path', 'default', folder]);
      });
      expect((await engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'"))[0]!.local_path).toBe(folder);
      await engine.executeRaw("UPDATE sources SET local_path=NULL WHERE id='default'");
      await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('win-host', 'win-host', $1)", ['C:\\brain-example']);
      const { resolveSourceForDir } = await import('../src/core/cycle.ts');
      expect(await resolveSourceForDir(engine, folder)).toBeUndefined();
      const { assertNoOverlappingPath } = await import('../src/core/sources-ops.ts');
      expect(await assertNoOverlappingPath(engine, 'default', folder).then(() => null, (error: { code?: string }) => error.code ?? String(error))).toBeNull();
    }, 120_000);
  });
}
