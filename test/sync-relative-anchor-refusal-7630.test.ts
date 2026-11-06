/**
 * #7630: a relative stored sync anchor (a legacy `sources.local_path` of ".") must never make sync treat the directory
 * it runs from as the brain.
 *
 * Before the fix, `gbrain sync --source default` (or `--all`) run from an unrelated folder resolved "." to that folder,
 * `isAnchorOwnedSyncPath` compared realpath(".") with realpath(cwd) (always equal), and preflight Git-initialized the
 * folder, committed everything in it as a baseline and imported its markdown. A foreground write that ended
 * `preparation_stalled` meanwhile got a receipt telling the user to run exactly that sync.
 *
 * Protects (this file: sync itself):
 * - sync refuses `sync_anchor_relative` (exit 3, a fix asking the user for `gbrain sources set-path <id> <dir>`) for a relative
 *   `local_path` reached by `--source` (the anchor read) or by `--all` (the row's path passed through), and for a relative
 *   legacy `sync.repo_path`; the folder gets no `.git` and nothing is imported;
 * - a relative anchor never proves ownership, so even an explicit absolute path to the cwd is not auto-initialized;
 * - a foreign-OS absolute anchor still refuses, without the relative-path wording.
 *
 * Siblings, split so each Postgres arm stays well under run-e2e.sh's per-file cap:
 * test/sync-relative-anchor-sources-doctor-7630.test.ts (set-path, config, doctor) and
 * test/sync-relative-anchor-readers-7630.test.ts (every other reader, and the stalled-write diagnosis).
 * Shared fixture: test/helpers/sync-relative-anchor-7630.ts.
 *
 * PGLite always; Postgres when DATABASE_URL is set (test/e2e/sync-relative-anchor-refusal-7630-postgres.test.ts).
 */
import { expect, spyOn, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAnchorOwnedSyncPath } from '../src/core/sync-anchor.ts';
import { clearConnectorLocalPath } from '../src/core/persistence/connector-path.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { describe7630 } from './helpers/sync-relative-anchor-7630.ts';

describe7630('', (t) => {
  const { pageCount, sync, cli, pagesOf, runSyncCli } = t;

  test('--source default with local_path "." refuses sync_anchor_relative: no .git, no commit, no import', async () => {
    const { engine, folder } = t;
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
    const { engine, folder } = t;
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
    const { engine, folder } = t;
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
    const { engine, folder } = t;
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
    const { engine, folder } = t;
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
    const { engine, folder } = t;
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
    const { engine, folder } = t;
    await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
    const result = await runSyncCli(['--repo', '.', '--no-pull', '--no-embed', '--json']);
    expect(result.refused?.code).toBe('sync_anchor_relative');
    expect(existsSync(join(folder, '.git'))).toBe(false);
    expect(await pagesOf('default')).toBe(0);
  }, 120_000);

  test('a relative legacy sync.repo_path refuses with the config fix', async () => {
    const { engine, folder } = t;
    await engine.setConfig('sync.repo_path', '.');
    const refused = await sync({});
    expect(refused?.code).toBe('sync_anchor_relative');
    expect(refused?.fix?.argv).toEqual(['gbrain', 'config', 'set', 'sync.repo_path', '<dir>']);
    expect(existsSync(join(folder, '.git'))).toBe(false);
  }, 120_000);

  test('a relative anchor proves no ownership: an explicit absolute path to the cwd is not auto-initialized', async () => {
    const { engine, folder } = t;
    await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
    expect(await isAnchorOwnedSyncPath(engine, { sourceId: 'default' } as never, folder)).toBe(false);
    const failed = await sync({ sourceId: 'default', repoPath: folder });
    expect(failed).not.toBeNull();
    expect(failed?.code).not.toBe('sync_anchor_relative');
    expect(existsSync(join(folder, '.git'))).toBe(false);
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [folder]);
    expect(await isAnchorOwnedSyncPath(engine, { sourceId: 'default' } as never, folder)).toBe(true);
  }, 120_000);

  // Value: protects=a successful sync of another source never runs .gitignore upkeep on the cwd's Git repo through a stored relative root;
  //   fails_when=post-sync upkeep takes getDefaultSourcePath's "." (a second non-default source keeps the cwd chain on default)
  //   and writes the managed block into the cwd repo's .gitignore;
  //   why_new=the --all case above never reaches the single-source post-sync upkeep; seam=none;
  //   no_claim=watch mode (the same expression at its second call site), parallel import workers (--workers 1)
  test('gbrain sync --source of an absolute source leaves the cwd repo\'s .gitignore alone when default\'s local_path is "."', async () => {
    const { engine, folder } = t;
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
    const { engine, folder } = t;
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

  // Value: protects=the foreign-OS cells of both stored-anchor holds: a Windows-absolute legacy sync.repo_path refuses without calling
  //   itself relative and keeps the config fix, config set over it stores this host's directory, config set of a Windows path is refused
  //   on POSIX with nothing written, and set-path over a Windows-absolute local_path releases the sync refusal; fails_when=the
  //   sync.repo_path branch keeps the relative wording beside the foreign why, or either exit (config set, set-path) does not settle the
  //   hold; why_new=the foreign cases above cover only sources.local_path refusals; seam=none; no_claim=Windows hosts (rooted, absolute)
  test.skipIf(process.platform === 'win32')('a Windows-absolute sync.repo_path or local_path on POSIX: refusal wording and both exits', async () => {
    const { engine, folder } = t;
    await engine.executeRaw("UPDATE sources SET local_path=NULL WHERE id='default'");
    await engine.setConfig('sync.repo_path', 'C:\\brain-example');
    const refused = await sync({}) as { code?: string; message?: string; fix?: { argv?: string[]; user_message?: string } } | null;
    expect(refused?.code).toBe('sync_anchor_relative');
    expect(refused?.message).toContain('not an absolute path on this host');
    expect(refused?.message).not.toContain('relative path');
    expect(refused?.fix?.user_message ?? '').not.toContain('relative path');
    expect(refused?.fix?.argv).toEqual(['gbrain', 'config', 'set', 'sync.repo_path', '<dir>']);
    const { runConfig } = await import('../src/commands/config.ts');
    expect((await cli(() => runConfig(engine, ['set', 'sync.repo_path', folder]))).exit).toBeUndefined();
    expect(await engine.getConfig('sync.repo_path')).toBe(folder);
    expect((await cli(() => runConfig(engine, ['set', 'sync.repo_path', 'C:\\brain-example']))).exit).toBe(1);
    expect(await engine.getConfig('sync.repo_path')).toBe(folder);
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", ['C:\\brain-example']);
    await cli(async () => {
      const { runSources } = await import('../src/commands/sources.ts');
      await runSources(engine, ['set-path', 'default', folder]);
    });
    expect((await engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'"))[0]!.local_path).toBe(folder);
    expect((await sync({ sourceId: 'default' }))?.code).not.toBe('sync_anchor_relative');
  }, 120_000);
});
