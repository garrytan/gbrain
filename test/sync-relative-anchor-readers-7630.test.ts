/**
 * #7630: a relative stored sync anchor (a legacy `sources.local_path` of ".") must never make the cwd the brain; this file
 * covers every reader other than sync (the sync refusal itself: test/sync-relative-anchor-refusal-7630.test.ts).
 *
 * Protects:
 * - no other reader resolves a relative root against the cwd: write-through, page and fact writes, capture origins,
 *   folder-to-source matching, fence repair, activation, import roots and freshness, remote submit_job, managed roots, the
 *   commit-anchor and repoint guards, and the dream, autopilot, per-phase and global maintenance cycles;
 * - a stalled foreground write's diagnosis inspects the writer and says to resubmit with a new request_id, while a
 *   recorded sync fault keeps its sync retry.
 *
 * Shared fixture: test/helpers/sync-relative-anchor-7630.ts.
 * PGLite always; Postgres when DATABASE_URL is set (test/e2e/sync-relative-anchor-readers-7630-postgres.test.ts).
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { isAnchorOwnedSyncPath } from '../src/core/sync-anchor.ts';
import { classifyRecordedFault, classifyTerminal } from '../src/core/persistence/terminal-classify.ts';
import { renderAction } from '../src/core/agent-output.ts';
import { withEnv } from './helpers/with-env.ts';
import { describe7630 } from './helpers/sync-relative-anchor-7630.ts';

describe7630('no other reader resolves it', (t, backend) => {
  const { pageCount, cli, pagesOf } = t;

  test('no other reader treats the cwd as a relative source root: write-through, install fallback, cycle source match, import roots, remote submit_job, managed roots', async () => {
    const { engine, home, folder } = t;
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
    const { engine, home, folder } = t;
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
    const { engine, home, folder } = t;
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

  // Value: protects=an explicit absolute --repo that passes the refusal never stamps its HEAD into, or repoints, a source whose stored
  //   local_path is relative; fails_when=sourceCommitAnchorAllowed or ownsSourceSyncAnchor resolve "." against the cwd, so a cwd that
  //   contains (or is) the --repo directory proves ownership and poisons the source's incremental anchor; why_new=the cases above cover
  //   isAnchorOwnedSyncPath only; seam=none; no_claim=the default source's repo_path repoint (ownsGlobalSyncAnchor, follow-up #7646)
  test('a relative local_path proves no ownership to the commit-anchor and repoint guards', async () => {
    const { engine, folder } = t;
    await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', '.')");
    const { ownsSourceSyncAnchor, sourceCommitAnchorAllowed } = await import('../src/core/sync-anchor.ts');
    expect(await sourceCommitAnchorAllowed(engine, 'notes-a', folder)).toEqual({ owns: false, configured: '.' });
    expect(await sourceCommitAnchorAllowed(engine, 'notes-a', join(folder, 'nested'))).toEqual({ owns: false, configured: '.' });
    expect(await ownsSourceSyncAnchor(engine, 'notes-a', folder)).toEqual({ owns: false, configured: '.' });
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='notes-a'", [folder]);
    expect((await sourceCommitAnchorAllowed(engine, 'notes-a', folder)).owns).toBe(true);
    expect((await ownsSourceSyncAnchor(engine, 'notes-a', folder)).owns).toBe(true);
  }, 120_000);

  // Value: protects=a source whose local_path is absolute only on another OS (a Windows drive path read on POSIX) proves no ownership
  //   to the commit-anchor and repoint guards either; fails_when=either guard resolves the foreign path against the cwd (pathResolve
  //   treats it as relative on POSIX), so a matching cwd advances or repoints that source; why_new=the case above seeds only ".";
  //   seam=none; no_claim=Windows hosts (the path is absolute there)
  test.skipIf(process.platform === 'win32')('a Windows-absolute local_path on POSIX proves no ownership to the commit-anchor and repoint guards', async () => {
    const { engine, folder } = t;
    await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-w', 'notes-w', $1)", ['C:\\brain-example']);
    const { ownsSourceSyncAnchor, sourceCommitAnchorAllowed } = await import('../src/core/sync-anchor.ts');
    expect(await sourceCommitAnchorAllowed(engine, 'notes-w', folder)).toEqual({ owns: false, configured: 'C:\\brain-example' });
    expect(await sourceCommitAnchorAllowed(engine, 'notes-w', join(folder, 'C:\\brain-example'))).toEqual({ owns: false, configured: 'C:\\brain-example' });
    expect(await ownsSourceSyncAnchor(engine, 'notes-w', join(folder, 'C:\\brain-example'))).toEqual({ owns: false, configured: 'C:\\brain-example' });
  }, 120_000);

  // Value: protects=a default source whose row was set to an absolute directory while the legacy sync.repo_path is still "." keeps
  //   advancing its sync position (the relative global key no longer outranks the row); fails_when=sourceCommitAnchorAllowed reads
  //   the relative global key first and refuses, so every sync of the repaired source re-imports from the old commit; why_new=the
  //   ownership cases above use non-default sources; seam=none; no_claim=the default repo_path repoint (ownsGlobalSyncAnchor, #7646)
  test('default with an absolute row and a relative sync.repo_path still advances its commit anchor', async () => {
    const { engine, folder } = t;
    await engine.setConfig('sync.repo_path', '.');
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [folder]);
    const { sourceCommitAnchorAllowed } = await import('../src/core/sync-anchor.ts');
    expect(await sourceCommitAnchorAllowed(engine, 'default', folder)).toEqual({ owns: true, configured: folder });
    await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
    expect(await sourceCommitAnchorAllowed(engine, 'default', folder)).toEqual({ owns: false, configured: '.' });
  }, 120_000);

  // Value: protects=the remote sources_resolve_path read and the fence census never treat a relative local_path as the host's cwd;
  //   fails_when=resolveSourcePaths realpaths "." (the cwd's Git repo answers) or the census walks the cwd's files;
  //   why_new=the reader cases above cover write and maintenance roots, not these two reads; seam=none; no_claim=the MCP transport
  test('sources_resolve_path refuses and the fence census walks no files for a relative local_path', async () => {
    const { engine, folder } = t;
    execSync('git init -q && git config user.email t@example.com && git config user.name T && git add -A && git commit -q -m initial', { cwd: folder, stdio: 'pipe' });
    await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
    const { resolveSourcePaths } = await import('../src/core/persistence/resolve-paths.ts');
    const refused = await resolveSourcePaths(engine, 'default', ['notes.md']).then(() => null, (error: { code?: string; message?: string }) => error);
    expect(refused?.code).toBe('sync_anchor_relative');
    expect(refused?.message).toContain('relative local_path');
    expect(refused?.message).not.toContain('"."');
    expect((refused as { fix?: { ask_user?: boolean; argv?: string[]; user_message?: string } } | null)?.fix).toMatchObject({ ask_user: true, argv: ['gbrain', 'sources', 'set-path', 'default', '<dir>'] });
    expect((refused as { fix?: { user_message?: string } } | null)?.fix?.user_message).not.toContain('"."');
    const { runFenceCensus } = await import('../src/core/fence-repair/census.ts');
    const [run] = await runFenceCensus(engine, { sourceIds: ['default'], deadline: Date.now() + 60_000 });
    expect(run?.files).toBe('none');
  }, 120_000);

  // Value: protects=gbrain maintain cycles a stale source with a relative local_path without a brain directory (database phases only);
  //   fails_when=maintain passes "." as brainDir, so the lint phase (fixes on by default) and other filesystem phases run in the cwd;
  //   why_new=the dream/autopilot/phase handlers above are separate readers; seam=runCycle spied to record its options and run orphans only;
  //   no_claim=what each filesystem phase would have written (none runs)
  test('gbrain maintain cycles a stale relative-path source with no brain directory', async () => {
    const { engine } = t;
    const cycle = await import('../src/core/cycle.ts');
    const stale = new Date(Date.now() - 48 * 3_600_000).toISOString();
    await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ('notes-a', 'notes-a', '.', $1::jsonb)", [JSON.stringify({ last_full_cycle_at: stale })]);
    await engine.putPage('notes/a-note', { type: 'note', title: 'A note', compiled_truth: 'A note in notes-a.', timeline: '' }, { sourceId: 'notes-a' });
    const real = cycle.runCycle;
    const seen: Array<{ sourceId?: string; brainDir: string | null }> = [];
    const spy = spyOn(cycle, 'runCycle').mockImplementation(async (e, opts) => {
      seen.push({ sourceId: opts.sourceId, brainDir: opts.brainDir ?? null });
      return real(e, { ...opts, phases: ['orphans'] });
    });
    try {
      const { runMaintain } = await import('../src/commands/maintain.ts');
      await cli(() => runMaintain(engine, ['--safe', '--json']));
    } finally { spy.mockRestore(); }
    expect(seen.find(s => s.sourceId === 'notes-a')).toEqual({ sourceId: 'notes-a', brainDir: null });
  }, 120_000);

  // Value: protects=a cycle on a legacy "." default row refuses its sync phase even when run from the repo, instead of syncing on
  //   the global anchors; fails_when=resolveSourceForDir finds no source and performSync advances the global sync.last_commit while
  //   default's anchor stays stale; why_new=the cycle cases above never reach runPhaseSync with an absolute sync.repo_path; seam=none;
  //   no_claim=the other cycle phases
  test('a cycle on a legacy "." default row refuses its sync phase from the repo and leaves every anchor untouched', async () => {
    const { engine, home, folder } = t;
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-7630-cycle-')));
    try {
      execSync('git init -q && git config user.email t@example.com && git config user.name T', { cwd: repo, stdio: 'pipe' });
      writeFileSync(join(repo, 'note.md'), '---\ntype: note\ntitle: Note\n---\n\nA note in the brain repo.\n');
      execSync('git add -A && git commit -q -m initial', { cwd: repo, stdio: 'pipe' });
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      await engine.setConfig('sync.repo_path', repo);
      process.chdir(repo);
      const { runCycle } = await import('../src/core/cycle.ts');
      const report = await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined }, () => runCycle(engine, { brainDir: repo, phases: ['sync'], pull: false }));
      const phase = report.phases.find(p => p.phase === 'sync')!;
      expect(phase.status).toBe('fail');
      expect(phase.code).toBe('sync_anchor_relative');
      expect(phase.fix?.next).toBe('ask_user');
      expect(phase.fix?.argv).toEqual(['gbrain', 'sources', 'set-path', 'default', '<dir>']);
      expect(await engine.getConfig('sync.last_commit')).toBeFalsy();
      expect(await engine.executeRaw("SELECT local_path, last_commit FROM sources WHERE id='default'")).toEqual([{ local_path: '.', last_commit: null }]);
      expect(await pageCount()).toBe(0);
    } finally {
      process.chdir(folder);
      rmSync(repo, { recursive: true, force: true });
    }
  }, 120_000);

  test('gbrain import of the cwd into a source whose local_path is "." does not stamp it fresh', async () => {
    const { engine, folder } = t;
    await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', '.')");
    const { runImport } = await import('../src/commands/import.ts');
    await cli(() => runImport(engine, [folder, '--source', 'notes-a', '--no-embed']));
    expect(await pagesOf('notes-a')).toBe(1);
    const [row] = await engine.executeRaw<{ last_sync_at: unknown }>("SELECT last_sync_at FROM sources WHERE id='notes-a'");
    expect(row!.last_sync_at).toBeNull();
  }, 120_000);
});

describe('#7630: a stalled write\'s diagnosis matches its operation', () => {
  const receipt = (operation: string) => classifyTerminal({ request_id: '11111111-2222-4333-8444-555555555555', source_id: 'default', slug: 'notes/example',
    operation, state: 'failed', error_code: 'preparation_stalled', error_detail: null, recovery: null, blocked_reason: null, compacted: false, intent_kind: null })!;
  const mcp = { transport: 'stdio' as const, isCallable: () => false, preapproved: () => false };

  for (const operation of ['remember', 'put_page', 'add_tag', 'add_link', 'add_timeline_entry', 'takes_add', 'forget_fact']) {
    test(`a foreground ${operation} that ended preparation_stalled inspects the writer and resubmits, never a sync`, () => {
      const verdict = receipt(operation);
      expect(verdict.action.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', 'default', '--json']);
      expect(verdict.action.why).toContain('new request_id');
      const rendered = renderAction(verdict.action, mcp);
      expect(rendered.command).not.toContain('gbrain sync');
    });
  }

  for (const operation of ['extract_facts', 'writer_deactivate']) {
    test(`a stalled ${operation} (maintenance or administration) inspects the writer, with no resubmit and no sync`, () => {
      const verdict = receipt(operation);
      expect(verdict.action.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', 'default', '--json']);
      expect(verdict.action.why).not.toContain('request_id');
      expect(renderAction(verdict.action, mcp).command).not.toContain('gbrain sync');
    });
  }

  test('a recorded sync fault and a sync page receipt keep the sync retry', () => {
    expect(classifyRecordedFault({ source_id: 'default', code: 'preparation_stalled' }).action.argv?.slice(0, 2)).toEqual(['gbrain', 'sync']);
    expect(receipt('submit_job').action.argv?.slice(0, 2)).toEqual(['gbrain', 'sync']);
  });

  test('a stalled canonical reconcile (a sync pass keep_db admission, stored as put_page) keeps the sync retry and names the manual rerun', () => {
    const verdict = classifyTerminal({ request_id: '11111111-2222-4333-8444-555555555555', source_id: 'default', slug: 'notes/example', operation: 'put_page',
      state: 'failed', error_code: 'preparation_stalled', error_detail: null, recovery: null, blocked_reason: null, compacted: false, intent_kind: 'canonical_reconcile' })!;
    expect(verdict.action.argv?.slice(0, 2)).toEqual(['gbrain', 'sync']);
    expect(verdict.action.why).toContain('gbrain sources reconcile');
    expect(verdict.action.why).not.toContain('new request_id');
  });
});
