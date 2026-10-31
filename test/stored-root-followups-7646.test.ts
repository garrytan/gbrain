/**
 * #7646: follow-ups to the #7630 relative stored-anchor refusal (#7640).
 *
 * Protects:
 * - a relative sync.repo_path behind a default row with no path never lets an explicit foreign --repo advance default's
 *   last_commit (the commit-anchor guard refuses instead of bootstrapping), and the refusal names sources set-path;
 * - with a stored ".", sync --repo ./ is refused like --repo . (the relative --repo is compared after resolving);
 * - sync, sources set-path --clear and doctor read one "absolute on this host" predicate, so a Windows drive path on
 *   POSIX and a root-relative path get the same verdict from all three;
 * - doctor's default_source_local_path survives a failed sibling scan and names every pathless source the relative
 *   sibling keeps database-only;
 * - sync --all --json carries the refusal's code and fix per source, prices no relative source in the cost gate with
 *   embedding on, and refuses a foreign-OS path the same way;
 * - a queued sync job on a relative anchor completes as a skip carrying the ask-the-user fix (no stored path);
 * - page and fact writes record the database-only reason relative_root;
 * - gbrain dream names the failed phase's ask-the-user fix instead of a rerun that refuses again.
 *
 * PGLite always; Postgres when DATABASE_URL is set (test/e2e/stored-root-followups-7646-postgres.test.ts).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { isForeignAbsolutePath, isHostAbsolutePath } from '../src/core/path-confine.ts';
import { clearConnectorLocalPath } from '../src/core/persistence/connector-path.ts';
import { defaultSourceLocalPathCheck } from '../src/commands/doctor/checks/default-source-path.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SYNC = { noPull: true, noEmbed: true, noExtract: true, full: true };
const WINDOWS_PATH = 'C:\\brain-example';

describe('#7646: one absolute-path predicate per host', () => {
  const cells: Array<[string, NodeJS.Platform, boolean, boolean]> = [
    ['/srv/brain-example', 'linux', true, false],
    [WINDOWS_PATH, 'linux', false, true],
    ['\\\\server-example\\share', 'linux', false, true],
    ['.', 'linux', false, false],
    ['\\brain-example', 'linux', false, false],
    [WINDOWS_PATH, 'win32', true, false],
    ['C:/brain-example', 'win32', true, false],
    ['/c/brain-example', 'win32', true, false],
    ['\\\\server-example\\share', 'win32', true, false],
    ['\\brain-example', 'win32', false, false],
    ['/brain-example', 'win32', false, true],
    ['C:brain-example', 'win32', false, false],
    ['.', 'win32', false, false],
  ];
  for (const [path, platform, host, foreign] of cells) {
    test(`${JSON.stringify(path)} on ${platform}: absolute=${host}, foreign=${foreign}`, () => {
      expect(isHostAbsolutePath(path, platform)).toBe(host);
      expect(isForeignAbsolutePath(path, platform)).toBe(foreign);
    });
  }
});

// Value: protects=a stray --path that agent, autopilot and dream ignored before #7640 keeps passing flag validation for one
//   release; fails_when=the registry drops it and the command exits unknown_flag; why_new=#7640 dropped it as a side effect;
//   seam=none; no_claim=any command reading --path (none does)
test('#7646: agent, autopilot and dream still accept a stray --path', () => {
  for (const command of ['agent', 'autopilot', 'dream']) expect(CLI_FLAG_REGISTRY[command]).toContain('--path');
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`#7646 [${backend}]: stored-root follow-ups`, () => {
    let engine: BrainEngine, close: () => Promise<void>, home: string, folder: string, previousCwd: string;

    beforeEach(async () => {
      home = mkdtempSync(join(tmpdir(), 'gbrain-7646-home-'));
      folder = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-7646-unrelated-')));
      writeFileSync(join(folder, 'notes.md'), '---\ntype: note\ntitle: Notes\n---\n\nA note that is not part of any brain.\n');
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

    const gitRepo = (prefix: string) => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
      execSync('git init -q && git config user.email t@example.com && git config user.name T', { cwd: repo, stdio: 'pipe' });
      writeFileSync(join(repo, 'kept.md'), '---\ntype: note\ntitle: Kept\n---\n\nA page of an absolute source.\n');
      execSync('git add -A && git commit -q -m initial', { cwd: repo, stdio: 'pipe' });
      return repo;
    };
    const sync = async (opts: Record<string, unknown>) => withEnv({ GBRAIN_HOME: home }, async () => {
      const { performSync } = await import('../src/commands/sync.ts');
      return performSync(engine, { ...SYNC, ...opts }).then(() => null, (error: unknown) => error as { code?: string; message?: string; suggestion?: string; fix?: { argv?: string[] } });
    });
    const cli = async (run: () => Promise<unknown>) => {
      const lines: string[] = [];
      let exit: number | undefined;
      let refused: { code?: string } | undefined;
      const push = (...a: unknown[]) => { lines.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
      const spies = [spyOn(console, 'log').mockImplementation(push), spyOn(console, 'error').mockImplementation(push),
        spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { lines.push(String(chunk)); return true; }) as never),
        spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code; throw new Error(`__exit__${code}`); }) as never)];
      try {
        await withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, GBRAIN_ALLOW_DEFAULT_WRITE: undefined }, run);
      } catch (error) {
        if (!String(error).includes('__exit__')) refused = error as { code?: string };
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      return { lines, exit, refused };
    };
    const runSync = (args: string[]) => cli(async () => { const { runSync } = await import('../src/commands/sync.ts'); await runSync(engine, args); });
    const envelopeOf = (lines: string[]) => JSON.parse(lines.find(line => line.startsWith('{"schema_version"'))!) as
      { sources: Array<{ source_id: string; status: string; error?: string; code?: string; fix?: { argv?: string[] } }>; error_count: number };

    // Value: protects=an explicit foreign --repo never advances default's last_commit when the only stored path is a relative
    //   sync.repo_path; fails_when=sourceCommitAnchorAllowed treats the relative key as no identity and bootstraps;
    //   why_new=the #7630 commit-anchor cases always store an absolute or relative default row; seam=none; no_claim=the repo_path repoint
    test('a relative sync.repo_path behind a pathless default row refuses the commit anchor and names set-path', async () => {
      const foreign = gitRepo('gbrain-7646-foreign-');
      try {
        await engine.setConfig('sync.repo_path', '.');
        expect((await engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'"))[0]!.local_path).toBeNull();
        const { sourceCommitAnchorAllowed, writeSyncAnchor } = await import('../src/core/sync-anchor.ts');
        expect(await sourceCommitAnchorAllowed(engine, 'default', foreign)).toEqual({ owns: false, configured: '.' });
        const { lines } = await cli(() => writeSyncAnchor(engine, 'default', 'last_commit', 'f'.repeat(40), undefined, foreign));
        expect((await engine.executeRaw<{ last_commit: string | null }>("SELECT last_commit FROM sources WHERE id='default'"))[0]!.last_commit).toBeNull();
        expect(lines.join('\n')).toContain('gbrain sources set-path default <absolute-directory>');
      } finally {
        rmSync(foreign, { recursive: true, force: true });
      }
    }, 120_000);

    // Value: protects=with a stored ".", --repo ./ is refused like --repo . (no .git, no import of the cwd);
    //   fails_when=the explicit-repo exemption compares spellings, so ./ passes and the cwd is synced; why_new=the #7630 case passes
    //   only "."; seam=none; no_claim=an absolute --repo (the explicit exemption, unchanged)
    test('sync --repo ./ with a stored "." is refused sync_anchor_relative like --repo .', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      for (const spelling of ['./', '.']) {
        const result = await runSync(['--repo', spelling, '--no-pull', '--no-embed', '--json']);
        expect(result.refused?.code).toBe('sync_anchor_relative');
      }
      expect(existsSync(join(folder, '.git'))).toBe(false);
      expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id='default'"))[0]!.n).toBe(0);
    }, 120_000);

    // Value: protects=sync, set-path --clear and doctor agree that a root-relative path is relative, and sync refuses a path absolute
    //   only on Windows while --clear and doctor leave it to the host that set it (the #7630 verdict);
    //   fails_when=--clear, doctor and sync disagree on "\brain", or a Windows drive path reads as relative;
    //   why_new=#7630 pinned each reader separately; seam=none; no_claim=a Windows host (cells above cover the predicate there)
    test.skipIf(process.platform === 'win32')('a root-relative path gets one verdict from sync, --clear and doctor; a Windows drive path stays the other host\'s', async () => {
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [folder]);
      await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('win-host', 'win-host', $1), ('root-rel', 'root-rel', $2)", [WINDOWS_PATH, '\brain-example']);
      const foreign = await sync({ sourceId: 'win-host' });
      expect(foreign?.code).toBe('sync_anchor_relative');
      expect(foreign?.message).toContain('not an absolute path on this host');
      expect(await clearConnectorLocalPath(engine, 'win-host').then(() => 'cleared', (error: { code?: string }) => error.code)).toBe('invalid_params');
      const rootRelative = await sync({ sourceId: 'root-rel' });
      expect(rootRelative?.code).toBe('sync_anchor_relative');
      const check = await defaultSourceLocalPathCheck(engine);
      expect(check?.status).toBe('warn');
      expect(check?.message).not.toContain('win-host');
      expect(check?.message).toContain('source "root-rel" has the relative local_path "\brain-example"');
      expect(await clearConnectorLocalPath(engine, 'root-rel')).toEqual({ prior: '\brain-example', connector: false });
    }, 120_000);

    // Value: protects=doctor still reports default_source_local_path when the other-source scan fails; fails_when=the scan error
    //   propagates and doctor's bare catch hides the whole check; why_new=no case injects a failing scan; seam=executeRaw throws
    //   for the scan's SQL only; no_claim=a failure of the default row read itself (still best-effort in local-audits)
    test('doctor default_source_local_path survives a failed sibling scan and says it was not checked', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const original = engine.executeRaw.bind(engine);
      const failing = new Proxy(engine, { get(target, key) {
        if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
          if (sql.includes("id <> 'default' AND local_path IS NOT NULL")) throw new Error('scan failed in test');
          return original(sql, params);
        };
        return Reflect.get(target, key);
      } }) as BrainEngine;
      const check = await defaultSourceLocalPathCheck(failing);
      expect(check?.status).toBe('warn');
      expect(check?.message).toContain('default source local_path is the relative path "."');
      expect(check?.message).toContain("could not be read, so they were not checked (scan failed in test)");
    }, 120_000);

    // Value: protects=doctor names a pathless sibling as database-only when default has its own path and a relative sibling makes
    //   the leak guard refuse every write under sync.repo_path; fails_when=the note is computed only when default has no path;
    //   why_new=the #7630 case has a pathless default; seam=none; no_claim=the write path itself (write-through's leak guard)
    test('doctor names every live pathless source a relative sibling keeps database-only, not only default', async () => {
      const repo = gitRepo('gbrain-7646-repo-');
      const own = gitRepo('gbrain-7646-default-');
      try {
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [own]);
        await engine.setConfig('sync.repo_path', repo);
        await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', '.'), ('notes-c', 'notes-c', NULL)");
        const { otherSourceOwning } = await import('../src/core/write-through.ts');
        expect(await otherSourceOwning(engine, 'notes-c', join(repo, '.sources', 'notes-c', 'x.md'))).toBe('notes-a');
        const check = await defaultSourceLocalPathCheck(engine);
        expect(check?.status).toBe('warn');
        expect(check?.message).toContain('Until then, pages of "notes-c" (no local_path) are saved to the database only');
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(own, { recursive: true, force: true });
      }
    }, 120_000);

    // Value: protects=sync --all --json gives a refused source its code and ask-the-user fix (single-source parity), for a "."
    //   and for a Windows drive path on POSIX; fails_when=the per-source entry carries only free text; why_new=the #7630 --all
    //   case asserts only the error text and seeds only "."; seam=none; no_claim=parallel import workers (--workers 1)
    test.skipIf(process.platform === 'win32')('sync --all --json carries code and fix for a relative and a Windows-absolute source', async () => {
      const repo = gitRepo('gbrain-7646-all-');
      try {
        await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
        await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', $1), ('win-host', 'win-host', $2)", [repo, WINDOWS_PATH]);
        const { lines, exit } = await runSync(['--all', '--no-pull', '--no-embed', '--json', '--workers', '1']);
        const bySource = Object.fromEntries(envelopeOf(lines).sources.map(s => [s.source_id, s]));
        expect(bySource.default).toMatchObject({ status: 'error', code: 'sync_anchor_relative' });
        expect(bySource.default?.fix?.argv).toEqual(['gbrain', 'sources', 'set-path', 'default', '<dir>']);
        expect(bySource['win-host']).toMatchObject({ status: 'error', code: 'sync_anchor_relative' });
        expect(bySource['win-host']?.error).toContain('not an absolute path on this host');
        expect(bySource['win-host']?.fix?.argv).toEqual(['gbrain', 'sources', 'set-path', 'win-host', '<dir>']);
        expect(bySource['notes-a']?.status).not.toBe('error');
        expect(exit).toBe(1);
        expect(existsSync(join(folder, '.git'))).toBe(false);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }, 120_000);

    // Value: protects=sync --all with embedding on never hands a relative source to the cost gate, which would walk and price the
    //   cwd; fails_when=the --all fan-out guard (run.ts) is removed or moved after the gate; why_new=the #7630 --all case runs
    //   --no-embed; seam=resolveSyncAllEmbedPlan spied to record its sources and stop; no_claim=what the estimate would cost
    test('sync --all with embedding on prices only the absolute source in the cost gate', async () => {
      const repo = gitRepo('gbrain-7646-gate-');
      try {
        await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
        await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', $1)", [repo]);
        for (let i = 0; i < 5; i++) writeFileSync(join(folder, `page-${i}.md`), `---\ntype: note\ntitle: Page ${i}\n---\n\n${'word '.repeat(200)}\n`);
        configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test-7646' } });
        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => { throw new Error('#7646 test: no provider call'); }) as never);
        const embedBackfill = await import('../src/core/sync-embed-backfill.ts');
        const priced: string[][] = [];
        const gate = spyOn(embedBackfill, 'resolveSyncAllEmbedPlan').mockImplementation(async (_e, sources) => {
          priced.push(sources.map(s => s.id));
          return { stop: true } as never;
        });
        let fetchCalls: number;
        try {
          await runSync(['--all', '--no-pull', '--json', '--workers', '1']);
        } finally {
          fetchCalls = fetchSpy.mock.calls.length;
          gate.mockRestore();
          fetchSpy.mockRestore();
          resetGateway();
        }
        expect(priced).toEqual([['notes-a']]);
        expect(fetchCalls).toBe(0);
        expect(existsSync(join(folder, '.git'))).toBe(false);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }, 120_000);

    // Value: protects=a queued sync job on a relative (or foreign-OS) anchor completes as a skip carrying the ask-the-user fix and no
    //   stored path, so it does not fail and use up its attempts; fails_when=the handler rethrows sync_anchor_relative;
    //   why_new=only sync_not_applicable had the skip; seam=none; no_claim=the dispatcher pre-skip (automaticSyncSkip)
    test.skipIf(process.platform === 'win32')('a sync job on a relative or foreign-OS anchor completes as a skip with the fix', async () => {
      const { makeSyncHandler } = await import('../src/core/minions/handlers/sync.ts');
      const job = (data: Record<string, unknown>) => ({ id: 1, name: 'sync', data, signal: new AbortController().signal }) as never;
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const relative = await cli(async () => {
        const result = await withEnv({ GBRAIN_HOME: home }, () => makeSyncHandler(engine)(job({ sourceId: 'default', pull: false, auto_embed_backfill: false })));
        expect(result).toMatchObject({ skipped: true, reason: 'sync_anchor_relative', source_id: 'default',
          fix: { argv: ['gbrain', 'sources', 'set-path', 'default', '<dir>'], ask_user: true } });
      });
      expect(relative.refused).toBeUndefined();
      await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('win-host', 'win-host', $1)", [WINDOWS_PATH]);
      const foreign = await cli(async () => {
        const result = await withEnv({ GBRAIN_HOME: home }, () => makeSyncHandler(engine)(job({ sourceId: 'win-host', pull: false, auto_embed_backfill: false })));
        expect(result).toMatchObject({ skipped: true, reason: 'sync_anchor_relative', source_id: 'win-host' });
        expect(JSON.stringify(result)).not.toContain('brain-example');
      });
      expect(foreign.refused).toBeUndefined();
      expect(existsSync(join(folder, '.git'))).toBe(false);
    }, 120_000);

    // Value: protects=a page or fact write whose stored root is relative names that cause (relative_root), not "no repo
    //   configured", and a remote write's warning points at set-path; fails_when=page admission files it under no_repo_configured
    //   and the fact target sets no reason; why_new=#7630 asserted only that nothing was written to the cwd; seam=none;
    //   no_claim=the managed (bound) path, which publishes through its binding
    test('page and fact writes on a relative root record the database-only reason relative_root', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const { resolveFactWriteTarget } = await import('../src/core/persistence/fact-write-target.ts');
      expect(await resolveFactWriteTarget(engine, 'default', { local_path: '.', kind: null }, { fileBacked: false, remote: false }))
        .toEqual({ kind: 'publish', binding: null, databaseOnlyReason: 'relative_root' });
      await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined }, async () => {
        const { operations } = await import('../src/core/operations.ts');
        const put = operations.find(o => o.name === 'put_page')!;
        const local = { engine, config: { engine: backend }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default', deferEmbeds: true };
        const result = await put.handler(local as never, { slug: 'notes/kept-in-db', content: '---\ntype: note\ntitle: Kept\n---\n\nA page with no folder of its own.\n' }) as { write_through?: { skipped?: string } };
        expect(result.write_through?.skipped).toBe('relative_root');
      });
      expect(existsSync(join(folder, 'notes'))).toBe(false);
      const { withNoRepoWriteThroughWarning } = await import('../src/core/write-through.ts');
      expect(withNoRepoWriteThroughWarning<{ written: boolean; skipped?: string; warning?: string }>({ written: false, skipped: 'relative_root' }, 'default').warning).toContain('gbrain sources set-path default <absolute-directory>');
    }, 120_000);

    // Value: protects=gbrain dream on a relative default row names the sync phase's ask-the-user step instead of telling the user to
    //   rerun the phase, which refuses again; fails_when=the cycle_failed line keeps the generic rerun advice; why_new=#7630 pinned
    //   the phase result only; seam=none; no_claim=the --json envelope (needs the CLI's JSON guard; same askPhase lookup)
    test('gbrain dream names the failed sync phase\'s ask-the-user fix', async () => {
      const repo = gitRepo('gbrain-7646-dream-');
      try {
        await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
        await engine.setConfig('sync.repo_path', repo);
        process.chdir(repo);
        const { lines, exit } = await cli(async () => { const { runDream } = await import('../src/commands/dream.ts'); await runDream(engine, ['--dir', repo, '--phase', 'sync']); });
        expect(exit).toBe(1);
        const text = lines.join('\n');
        expect(text).toContain('the sync phase needs the user before it can run');
        expect(text).toContain('gbrain sources set-path default <absolute-directory>');
        expect(text).not.toContain('re-run one with: gbrain dream --phase sync');
      } finally {
        process.chdir(folder);
        rmSync(repo, { recursive: true, force: true });
      }
    }, 120_000);
  });
}
