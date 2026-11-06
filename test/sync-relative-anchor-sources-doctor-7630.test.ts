/**
 * #7630: a relative stored sync anchor (a legacy `sources.local_path` of ".") must never make the cwd the brain; this file
 * covers the repair and reporting surfaces (the sync refusal itself: test/sync-relative-anchor-refusal-7630.test.ts).
 *
 * Protects:
 * - `gbrain sources set-path <id> --clear` clears a relative filesystem path without SQL, and still refuses an absolute one or
 *   a source with a canonical owner binding; set-path over "." and beside relative or foreign-OS siblings;
 * - doctor's `default_source_local_path` warns on a relative path, on any source, and on a relative legacy `sync.repo_path`,
 *   and `config set sync.repo_path` refuses one;
 * - the default-write leak guard fails closed on a relative sibling, not on a foreign-OS absolute one.
 *
 * Shared fixture: test/helpers/sync-relative-anchor-7630.ts.
 * PGLite always; Postgres when DATABASE_URL is set (test/e2e/sync-relative-anchor-sources-doctor-7630-postgres.test.ts).
 */
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearConnectorLocalPath } from '../src/core/persistence/connector-path.ts';
import { defaultSourceLocalPathCheck } from '../src/commands/doctor/checks/default-source-path.ts';
import { describe7630 } from './helpers/sync-relative-anchor-7630.ts';

describe7630('sources, config and doctor', (t) => {
  const { cli } = t;

  test('sources set-path --clear clears a relative filesystem path without SQL; an absolute one stays refused', async () => {
    const { engine, folder } = t;
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
    const { engine } = t;
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

  test('doctor default_source_local_path warns on a relative path and names the fix', async () => {
    const { engine } = t;
    await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
    const check = await defaultSourceLocalPathCheck(engine);
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('gbrain sources set-path default --clear');
  }, 120_000);

  test('gbrain config set sync.repo_path refuses a relative path and writes nothing; an absolute one is stored', async () => {
    const { engine, folder } = t;
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
    const { engine } = t;
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
    const { engine, folder } = t;
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
    const { engine } = t;
    await engine.setConfig('sync.repo_path', '.');
    await engine.putPage('notes/live', { type: 'note', title: 'Live', compiled_truth: 'A live default page.', timeline: '' }, { sourceId: 'default' });
    const check = await defaultSourceLocalPathCheck(engine);
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('sync.repo_path is the relative path "."');
    expect(check?.message).toContain('gbrain config set sync.repo_path <absolute-directory>');
    expect(check?.message).toContain('gbrain sources set-path default <absolute-directory>');
    expect(check?.message).not.toContain('sync refuses it');
  }, 120_000);

  // Value: protects=the untested cells of the relative-anchor hold: set-path over a stored "." stores the absolute directory, --clear
  //   leaves a relative legacy sync.repo_path alone (its fix is config set), and a sibling stored as another OS's absolute path is
  //   never matched to a folder nor counted as an overlap; fails_when=set-path keeps the relative row, --clear rewrites the config key,
  //   or resolveSourceForDir/assertNoOverlappingPath resolve the foreign path against the cwd; why_new=the existing cases start from an
  //   absolute prior or a "." sibling; seam=none; no_claim=the CLI rendering of set-path (covered by sources-set-path tests)
  test('set-path over ".", --clear beside a relative sync.repo_path, and a foreign-OS sibling in folder matching and overlap', async () => {
    const { engine, folder } = t;
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

  // Value: protects=the repair command (sources set-path) never treats a sibling's relative local_path as the cwd's tree, and the
  //   #2018 write-through leak guard fails closed on it wherever gbrain runs; fails_when=assertNoOverlappingPath realpaths "." to the
  //   cwd, so set-path refuses overlapping_path, or otherSourceOwning ignores the relative sibling (or matches it only when run from
  //   its tree); why_new=no other case has a relative sibling; seam=none; no_claim=company-brain admission (same helper)
  test('a sibling with a relative local_path: set-path to the cwd passes and the leak guard fails closed on it', async () => {
    const { engine, folder } = t;
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
    const { engine, folder } = t;
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
    const { engine } = t;
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
});
