/**
 * GBRA-133: a held `file_gone` file names its provenance, and `gbrain repair file-drift --held --side deleted --state file_gone`
 * selects by it (`--provenance`):
 *   - each previewed page names the newest commit of HEAD's full history that deleted its file (sha, author, date,
 *     subject; a side branch's own deleting commit, not the merge that kept it), `never_committed` when no commit held it,
 *     or `deletion_uncommitted` when HEAD still holds it; the preview counts each provenance;
 *   - `--provenance never_committed --prefer database` keeps each page database-only: the apply writes no file, the page
 *     forgets its recorded path (`database_only_reason=detached`) and the hold is cleared, and the next sync, incremental and
 *     full, holds nothing again and keeps the page live; `--prefer file` with it is refused (the page holds the only copy);
 *   - `--provenance deleted_by_commit --prefer file` accepts the deletion (soft-deletes exactly those pages).
 * Before: every held gone file looked alike, so one --prefer recreated culled pages or deleted the only copy of others.
 * Real PGLite (and Postgres when DATABASE_URL is set), a real managed sync and real Git; the committed deletion's hold is
 * written as sync writes it (a page changed since its import), the never-committed one by sync itself.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { readDeletionProvenance } from '../src/core/persistence/sync-origin-evidence.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const logger = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
async function holds(engine: BrainEngine): Promise<Record<string, { code: string; meta: Record<string, unknown> }>> {
  const rows = await engine.executeRaw<{ fingerprint: string; record: { code: string; meta: Record<string, unknown> } }>(
    "SELECT fingerprint, completed_keys->0 AS record FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint");
  return Object.fromEntries(rows.map(row => [row.fingerprint.split(':').slice(2).join(':'), row.record]));
}
const pageRow = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ deleted_at: unknown; source_path: string | null; database_only_reason: string | null }>(
  "SELECT deleted_at, source_path, database_only_reason FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0];
const refusal = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error as OperationError; } throw new Error('expected a refusal'); };

describe('GBRA-133: readDeletionProvenance', () => {
  test('a side branch\'s deleting commit, a merge that dropped a file, a worktree-only deletion, a never-committed file, and an unborn checkout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-provenance-'));
    try {
      const root = join(dir, 'repo'); mkdirSync(join(root, 'notes'), { recursive: true });
      git(root, 'init', '-q', '-b', 'main');
      expect([...(await readDeletionProvenance(root, ['notes/x.md']))]).toEqual([['notes/x.md', { kind: 'never_committed' }]]);
      for (const name of ['a', 'b', 'c d', 'm']) writeFileSync(join(root, `notes/${name}.md`), `${name}\n`);
      commit(root, 'init');
      git(root, 'checkout', '-qb', 'side'); git(root, 'rm', '-q', 'notes/b.md'); git(root, 'commit', '-qm', 'cull b');
      git(root, 'checkout', '-q', 'main'); writeFileSync(join(root, 'x.md'), 'x\n'); commit(root, 'x'); git(root, 'merge', '-q', '--no-edit', 'side');
      git(root, 'checkout', '-qb', 'side2'); writeFileSync(join(root, 'notes/m.md'), 'm2\n'); commit(root, 'edit m');
      git(root, 'checkout', '-q', 'main'); writeFileSync(join(root, 'z.md'), 'z\n'); commit(root, 'z');
      try { git(root, 'merge', '-q', '--no-commit', 'side2'); } catch { /* stopped before committing */ }
      git(root, 'rm', '-qf', 'notes/m.md'); git(root, 'commit', '-qm', 'merge side2 dropping m');
      git(root, 'rm', '-q', 'notes/c d.md'); git(root, 'commit', '-qm', 'move c');
      rmSync(join(root, 'notes/a.md'));
      const read = await readDeletionProvenance(root, ['notes/a.md', 'notes/b.md', 'notes/c d.md', 'notes/m.md', 'notes/never.md']);
      const subject = (path: string) => { const found = read.get(path)!; return found.kind === 'deleted_by_commit' ? found.subject : found.kind; };
      expect(['notes/a.md', 'notes/b.md', 'notes/c d.md', 'notes/m.md', 'notes/never.md'].map(subject))
        .toEqual(['deletion_uncommitted', 'cull b', 'move c', 'merge side2 dropping m', 'never_committed']);
      expect(read.get('notes/b.md')).toMatchObject({ kind: 'deleted_by_commit', author: expect.any(String), date: expect.any(String), commit: git(root, 'log', '-1', '--format=%H', 'side', '--', 'notes/b.md') });
      // Read from a directory inside the work tree, paths relative to it.
      const inner = await readDeletionProvenance(join(root, 'notes'), ['b.md', 'never.md']);
      expect([inner.get('b.md')!.kind, inner.get('never.md')!.kind]).toEqual(['deleted_by_commit', 'never_committed']);
      expect((await readDeletionProvenance(dir, ['repo/notes/a.md'])).get('repo/notes/a.md')).toEqual({ kind: 'unknown' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

for (const backend of testBackends()) describe(`[${backend}] GBRA-133: held gone files by provenance`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (const name of ['a', 'b']) writeFileSync(join(root, `notes/${name}.md`), note(`notes/${name}`, `The committed body of notes/${name}.`));
    commit(root, 'notes');
  };

  test('never_committed keeps the page database-only and the next sync holds nothing; deleted_by_commit --prefer file accepts the deletion', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    // A working-tree page no commit ever held, then removed from the disk.
    await engine.setConfig('sync.include_working_tree', 'true');
    writeFileSync(join(root, 'notes/w.md'), note('notes/w', 'An untracked note only the brain holds.'));
    expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
    await engine.setConfig('sync.include_working_tree', 'false');
    rmSync(join(root, 'notes/w.md'));
    await performManagedSync(engine, OPTS);
    expect((await holds(engine))['notes/w.md']).toMatchObject({ code: 'file_drift', meta: { side: 'deleted', state: 'file_gone', reason: 'never_committed' } });
    // A committed page removed by a commit, held as the file_gone Decision (as sync holds one whose page changed since its import).
    git(root, 'rm', '-q', 'notes/b.md'); git(root, 'commit', '-qm', 'cull b');
    const b = (await engine.readPageSnapshot('notes/b', { sourceId: 'default' }))!;
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: source!.incarnation, path: 'notes/b.md', source_path: 'notes/b.md', slug: 'notes/b',
      page_id: Number(b.page.id), code: 'file_drift', message: 'notes/b.md is held: file drift (deleted file_gone)', upstream_version: null,
      observed_at: new Date().toISOString(), run_id: null, mode: 'managed', meta: { recovery_version: RECOVERY_VERSION, side: 'deleted', state: 'file_gone', page_revision: b.revision } }));

    const run = async (opts: { prefer: 'file' | 'database'; provenance?: string; expect?: string }) =>
      (await repairRunner(engine, { apply: opts.expect !== undefined, logger })).run('file-drift', await resolveRepairScope(engine, 'default'),
        { explicit: true, sourceFlag: 'default', prefer: opts.prefer, held: true, side: 'deleted', state: 'file_gone',
          ...(opts.provenance ? { provenance: opts.provenance } : {}), ...(opts.expect ? { expect: opts.expect } : {}) });
    type Page = { slug: string; action?: string; provenance?: { kind: string; subject?: string; commit?: string } };
    const pages = (result: Awaited<ReturnType<typeof run>>) => result.details!.pages as Page[];

    const all = await run({ prefer: 'database' });
    expect(all.preview_hash).toBeTruthy();
    expect(all.details!.provenance).toEqual({ deleted_by_commit: 1, deletion_uncommitted: 0, never_committed: 1, unknown: 0 });
    expect(pages(all).map(page => [page.slug, page.provenance?.kind, page.provenance?.subject])).toEqual([['notes/b', 'deleted_by_commit', 'cull b'], ['notes/w', 'never_committed', undefined]]);
    expect(pages(all).find(page => page.slug === 'notes/b')!.provenance!.commit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(all.listing!.find(entry => entry.item === 'default:notes/b')!.detail).toContain(`deleted by commit ${git(root, 'rev-parse', 'HEAD').slice(0, 12)}`);
    expect(all.listing!.find(entry => entry.item === 'default:notes/w')!.detail).toContain('never committed');

    const unsafe = await refusal(run({ prefer: 'file', provenance: 'never_committed' }));
    expect(unsafe.code).toBe('invalid_params');
    expect(unsafe.suggestion).toContain('each page holds the only copy');
    const unknownKind = await refusal(run({ prefer: 'database', provenance: 'deleted' }));
    expect(unknownKind.code).toBe('invalid_params');

    const accept = await run({ prefer: 'file', provenance: 'deleted_by_commit' });
    expect(pages(accept).map(page => [page.slug, page.action])).toEqual([['notes/b', 'soft_delete']]);
    expect(accept.residuals).toMatchObject({ other_provenance: 1 });
    const accepted = await run({ prefer: 'file', provenance: 'deleted_by_commit', expect: accept.preview_hash! });
    expect(accepted.outcomes).toEqual({ repaired: 1 });
    expect((await pageRow(engine, 'notes/b'))!.deleted_at).not.toBeNull();

    const keep = await run({ prefer: 'database', provenance: 'never_committed' });
    expect(pages(keep).map(page => [page.slug, page.action])).toEqual([['notes/w', 'detach_page']]);
    expect(keep.apply_command).toContain('--provenance never_committed --prefer database --apply --expect');
    const kept = await run({ prefer: 'database', provenance: 'never_committed', expect: keep.preview_hash! });
    expect(kept.outcomes).toEqual({ repaired: 1 });
    expect(existsSync(join(root, 'notes/w.md'))).toBe(false);
    expect(await pageRow(engine, 'notes/w')).toMatchObject({ deleted_at: null, source_path: null, database_only_reason: 'detached' });
    expect((await holds(engine))['notes/w.md']).toBeUndefined();
    // The next sync, incremental and full, holds nothing again and keeps the page.
    await performManagedSync(engine, OPTS);
    await performManagedSync(engine, { ...OPTS, full: true });
    expect((await holds(engine))['notes/w.md']).toBeUndefined();
    expect(await pageRow(engine, 'notes/w')).toMatchObject({ deleted_at: null, database_only_reason: 'detached' });
    expect((await engine.readPageSnapshot('notes/w', { sourceId: 'default' }))!.page.compiled_truth).toContain('only the brain holds');

  }, { databaseUrl, setup }), 300_000);
});
