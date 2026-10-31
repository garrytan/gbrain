/**
 * #7630 (3 of 3; split from sync-relative-anchor-refusal-7630.test.ts by #7802): a relative stored sync anchor (a legacy
 * `sources.local_path` of ".") must never make sync treat the directory it runs from as the brain. See that file for the
 * failure this pins.
 *
 * Protects (this file: foreign-OS anchors, the commit-anchor guards, maintenance cycles and imports):
 * - a relative or foreign-OS anchor proves no ownership to the commit-anchor and repoint guards, and the leak guard fails
 *   closed on a relative sibling only;
 * - path resolution, the fence census, `gbrain maintain` and a cycle on a legacy "." default row never walk the cwd;
 * - `gbrain import` of the cwd into a source whose `local_path` is "." does not stamp it fresh;
 * - a stalled foreground write's diagnosis inspects the writer and says to resubmit with a new request_id, while a
 *   recorded sync fault keeps its sync retry.
 *
 * PGLite always; Postgres when DATABASE_URL is set (test/e2e/sync-relative-anchor-guards-7630-postgres.test.ts).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { isAnchorOwnedSyncPath } from '../src/core/sync-anchor.ts';
import { defaultSourceLocalPathCheck } from '../src/commands/doctor/checks/default-source-path.ts';
import { classifyRecordedFault, classifyTerminal } from '../src/core/persistence/terminal-classify.ts';
import { renderAction } from '../src/core/agent-output.ts';
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

    // Value: protects=the foreign-OS cells of both stored-anchor holds: a Windows-absolute legacy sync.repo_path refuses without calling
    //   itself relative and keeps the config fix, config set over it stores this host's directory, config set of a Windows path is refused
    //   on POSIX with nothing written, and set-path over a Windows-absolute local_path releases the sync refusal; fails_when=the
    //   sync.repo_path branch keeps the relative wording beside the foreign why, or either exit (config set, set-path) does not settle the
    //   hold; why_new=the foreign cases above cover only sources.local_path refusals; seam=none; no_claim=Windows hosts (rooted, absolute)
    test.skipIf(process.platform === 'win32')('a Windows-absolute sync.repo_path or local_path on POSIX: refusal wording and both exits', async () => {
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

    // Value: protects=an explicit absolute --repo that passes the refusal never stamps its HEAD into, or repoints, a source whose stored
    //   local_path is relative; fails_when=sourceCommitAnchorAllowed or ownsSourceSyncAnchor resolve "." against the cwd, so a cwd that
    //   contains (or is) the --repo directory proves ownership and poisons the source's incremental anchor; why_new=the cases above cover
    //   isAnchorOwnedSyncPath only; seam=none; no_claim=the default source's repo_path repoint (ownsGlobalSyncAnchor, follow-up #7646)
    test('a relative local_path proves no ownership to the commit-anchor and repoint guards', async () => {
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

    // Value: protects=the repair command (sources set-path) never treats a sibling's relative local_path as the cwd's tree, and the
    //   #2018 write-through leak guard fails closed on it wherever gbrain runs; fails_when=assertNoOverlappingPath realpaths "." to the
    //   cwd, so set-path refuses overlapping_path, or otherSourceOwning ignores the relative sibling (or matches it only when run from
    //   its tree); why_new=no other case has a relative sibling; seam=none; no_claim=company-brain admission (same helper)
    test('a sibling with a relative local_path: set-path to the cwd passes and the leak guard fails closed on it', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', '.')");
      const { assertNoOverlappingPath } = await import('../src/core/sources-ops.ts');
      expect(await assertNoOverlappingPath(engine, 'notes-a', folder).then(() => null, (error: { code?: string }) => error.code ?? String(error))).toBeNull();
      const { otherSourceOwning } = await import('../src/core/write-through.ts');
      expect(await otherSourceOwning(engine, 'default', join(folder, 'notes.md'))).toBe('notes-a');
      expect(await otherSourceOwning(engine, 'default', join(tmpdir(), 'elsewhere', 'notes.md'))).toBe('notes-a');
      await engine.executeRaw("UPDATE sources SET archived=true, archived_at=now() WHERE id='notes-a'");
      expect(await otherSourceOwning(engine, 'default', join(folder, 'notes.md'))).toBeNull();
    }, 120_000);

    // Value: protects=a sibling whose local_path is absolute for another OS (a Windows drive path read on POSIX) never blocks default
    //   write-through, the same reading doctor and set-path --clear use; fails_when=the leak guard calls it relative with the host's
    //   isAbsolute, so every sync.repo_path write goes database-only while doctor reports ok; why_new=the case above has only a "."
    //   sibling; seam=none; no_claim=what a Windows host does with a POSIX path (posix.isAbsolute covers it there)
    test('a sibling with another OS\'s absolute local_path does not make the leak guard fail closed', async () => {
      await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('win-host', 'win-host', $1)", ['C:\\brain-example']);
      const { otherSourceOwning } = await import('../src/core/write-through.ts');
      expect(await otherSourceOwning(engine, 'default', join(folder, 'notes.md'))).toBeNull();
      await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', '.')");
      expect(await otherSourceOwning(engine, 'default', join(folder, 'notes.md'))).toBe('notes-a');
    }, 120_000);

    // /ship review fixes (GBRA-207, #7630).
    // Value: protects=doctor reports a relative sibling that blocks default write-through as a relative path, never as a #2018 containment
    //   with an invented alias diagnosis, and ignores an empty local_path; fails_when=the wrapper passes the relative leak-guard match to
    //   the assessor ("own working tree") or the relative query keeps ''; why_new=no doctor case has a null default local_path beside a
    //   relative sibling; seam=none; no_claim=other doctor checks (only this check runs)
    test('doctor names a relative sibling that blocks default writes as relative, not as a containment, and skips an empty local_path', async () => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-7630-repo-')));
      try {
        await engine.setConfig('sync.repo_path', repo);
        await engine.putPage('notes/live', { type: 'note', title: 'Live', compiled_truth: 'A live default page.', timeline: '' }, { sourceId: 'default' });
        await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', '.'), ('notes-b', 'notes-b', '')");
        const check = await defaultSourceLocalPathCheck(engine);
        expect(check?.status).toBe('warn');
        expect(check?.message).toContain('source "notes-a" has the relative local_path "."');
        expect(check?.message).toContain('pages of every source with no local_path (the default source and any `.sources/<id>` source) are saved to the database only');
        expect(check?.message).not.toContain('own working tree');
        expect(check?.message).not.toContain('write through sync.repo_path');
        expect(check?.message).not.toContain('notes-b');
        await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('z-abs', 'z-abs', $1)", [repo]);
        const both = await defaultSourceLocalPathCheck(engine);
        expect(both?.message).toContain('source "notes-a" has the relative local_path "."');
        expect(both?.message).toContain('"z-abs"\'s own working tree');
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }, 120_000);

    test('gbrain import of the cwd into a source whose local_path is "." does not stamp it fresh', async () => {
      await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', '.')");
      const { runImport } = await import('../src/commands/import.ts');
      await cli(() => runImport(engine, [folder, '--source', 'notes-a', '--no-embed']));
      expect(await pagesOf('notes-a')).toBe(1);
      const [row] = await engine.executeRaw<{ last_sync_at: unknown }>("SELECT last_sync_at FROM sources WHERE id='notes-a'");
      expect(row!.last_sync_at).toBeNull();
    }, 120_000);
  });
}

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
