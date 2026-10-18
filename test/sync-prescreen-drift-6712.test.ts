/**
 * #6712 PR 1 (L1): the content-addressed discovery prescreen, the `file_drift` drift guard and the re-discovery of a
 * lost manifest against HEAD.
 *
 * Protects:
 * - a page whose import provenance matches the pinned blob, the frozen revision and this parser is prescreened in
 *   discovery and passed by the guarded no-op kernel: no request, no preparation, no new revision;
 * - a fingerprint change, `--full`, a byte change and a revision change each fall through to the ordinary path (the
 *   prescreen fails toward importing);
 * - a database-only edit to a page whose file did not change is held `file_drift` and not imported; under a
 *   `storage.keep_db` prefix it is neither held nor imported (the keep_db worker gets it as a drift candidate);
 * - cold upgrade: a page with missing, partial (pre-PR 0) or obsolete-fingerprint provenance and a database-only edit
 *   that predates discovery is held, in a tree walk and under `--full`, instead of being overwritten by the file; the
 *   equal-content controls (no edit, an unattributed revision whose content equals the file, a changed file on a page
 *   sync wrote last) still skip or import as before;
 * - a cursor whose manifest is gone re-discovers against HEAD and finishes, the pages the lost run imported prescreened.
 * - review follow-ups: `sync.holds=fail` refuses the drift with `file_drift`; a lost manifest walks HEAD's whole tree (a
 *   file the lost run imported and HEAD reverted is restored, a page it added is removed); a fingerprint that changes
 *   after discovery and an oversized working copy each fall through to the ordinary path.
 *
 * Each test fails on the base: there `prescreened` is absent, the tree walk overwrites the database edit, and the
 * missing manifest stops the run with `storage_error`.
 * PGLite always; Postgres too when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { readGitHold, readSyncImportProvenance, SYNC_IMPORT_PARSER_VERSION, SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { readDriftSkips } from '../src/core/persistence/drift-conflicts.ts';
import { SYNC_READ_BOUND } from '../src/core/persistence/sync-blobs.ts';
import { resolveBulkSettings } from '../src/core/persistence/sync-group.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { waitFor } from './helpers/wait-for.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\n---\n\n${body}\n`;
const SLUGS = ['notes/a', 'notes/b', 'notes/c', 'notes/d', 'notes/e', 'notes/f'];
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
/** A history rewrite (HEAD's tree as a new root commit, then gc) makes the checkpoint unreachable, so the next sync walks the whole tree at HEAD. */
function rewriteHistory(root: string): void {
  const rewritten = git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit-tree', 'HEAD^{tree}', '-m', `rewritten ${randomUUID().slice(0, 8)}`);
  git(root, 'reset', '-q', '--soft', rewritten);
  git(root, 'reflog', 'expire', '--expire=now', '--all'); git(root, 'gc', '-q', '--prune=now');
}
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of SLUGS) writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
  commit(root, 'notes');
};
const incarnationOf = async (engine: BrainEngine) => (await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text FROM sources WHERE id='default'"))[0]!.incarnation;
const pageIdOf = async (engine: BrainEngine, slug: string) => Number((await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page.id);
const bodyOf = async (engine: BrainEngine, slug: string) => (await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth ?? '';
const revisionOf = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
const importRequests = async (engine: BrainEngine) => Number((await engine.executeRaw<{ n: number | string }>(
  "SELECT count(*) AS n FROM persistence_requests WHERE intent->>'kind'='managed_sync_import'"))[0]!.n);
/** Rewrites one page's provenance record in place (`set` is a jsonb path → value list), or deletes it. */
async function tamper(engine: BrainEngine, slug: string, change: Array<[string, unknown]> | 'delete' | { drop: string[] }): Promise<void> {
  const fingerprint = `default:${await incarnationOf(engine)}:${await pageIdOf(engine, slug)}`;
  if (change === 'delete') { await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [SYNC_IMPORT_PROVENANCE_OP, fingerprint]); return; }
  if ('drop' in change) {
    for (const key of change.drop) await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_build_array((completed_keys->0)-$3::text) WHERE op=$1 AND fingerprint=$2`, [SYNC_IMPORT_PROVENANCE_OP, fingerprint, key]);
    return;
  }
  for (const [path, value] of change) await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,$3::text[],$4::text::jsonb) WHERE op=$1 AND fingerprint=$2`,
    [SYNC_IMPORT_PROVENANCE_OP, fingerprint, `{0,${path}}`, JSON.stringify(value)]);
}
/** A database-only `put_page` (write-through off): the page moves, its file does not. */
async function databaseOnlyEdit(engine: BrainEngine, ctx: OperationContext, slug: string, body: string): Promise<string> {
  const requestId = randomUUID();
  const current = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: requestId, expected_revision: current!.revision, content: note(slug, body) } });
  await waitFor(async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]?.state === 'committed',
    { timeoutMs: 20_000, label: `the database-only put_page of ${slug} commits` });
  return requestId;
}
const heldOf = (result: Awaited<ReturnType<typeof performManagedSync>>) => (result.held ?? []).map(hold => ({ path: hold.path, code: hold.code })).sort((a, b) => a.path.localeCompare(b.path));

for (const databaseUrl of process.env.DATABASE_URL ? [undefined, process.env.DATABASE_URL] : [undefined]) describe(`#6712 PR 1 prescreen and drift guard (${databaseUrl ? 'postgres' : 'pglite'})`, () => {
  test('a provenance match is prescreened and passed by the kernel: no request, no preparation, no new revision', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const revisions = new Map(await Promise.all(SLUGS.map(async slug => [slug, await revisionOf(engine, slug)] as const)));
    const requests = await importRequests(engine);
    rewriteHistory(root);
    const walk = await performManagedSync(engine, OPTS);
    expect(walk).toMatchObject({ status: 'synced', prescreened: SLUGS.length, waived: { imports: SLUGS.length, deletes: 0 }, added: 0, modified: 0 });
    expect(await importRequests(engine)).toBe(requests);
    for (const slug of SLUGS) expect(await revisionOf(engine, slug)).toBe(revisions.get(slug)!);
  }, { databaseUrl, setup }), 180_000);

  test('a fingerprint change, a revision change, a byte change and --full each fall through to the ordinary path', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await tamper(engine, 'notes/a', [['parser,parser_version', 'an-older-parser']]);
    await tamper(engine, 'notes/b', [['revision', '1']]);
    writeFileSync(join(root, 'notes/c.md'), note('notes/c', 'A changed body of notes/c.')); commit(root, 'change c');
    rewriteHistory(root);
    const walk = await performManagedSync(engine, OPTS);
    // d, e and f are prescreened; a and b are screened (and waived) by the ordinary path; c is imported.
    expect(walk).toMatchObject({ status: 'synced', prescreened: 3, waived: { imports: 5 } });
    expect(heldOf(walk)).toEqual([]);
    expect(await bodyOf(engine, 'notes/c')).toContain('A changed body of notes/c.');
    const incarnation = await incarnationOf(engine);
    expect((await readSyncImportProvenance(engine, 'default', incarnation, await pageIdOf(engine, 'notes/a')))?.parser?.parser_version).toBe(SYNC_IMPORT_PARSER_VERSION);
    expect((await readSyncImportProvenance(engine, 'default', incarnation, await pageIdOf(engine, 'notes/b')))?.revision).toBe(await revisionOf(engine, 'notes/b'));
    const full = await performManagedSync(engine, { ...OPTS, full: true });
    expect(full).toMatchObject({ prescreened: 0, waived: { imports: SLUGS.length } });
  }, { databaseUrl, setup }), 180_000);

  test('in a bulk drain a prescreened entry between changed files ends the group and is passed by the kernel', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const bulk = await resolveBulkSettings(engine, false);
    expect(bulk.enabled).toBe(engine.kind === 'postgres'); // bulk groups are Postgres-only
    // a, c, e change; b, d, f change only their mode (same blob): one Git delta interleaves them.
    for (const slug of ['notes/a', 'notes/c', 'notes/e']) writeFileSync(join(root, `${slug}.md`), note(slug, `A changed body of ${slug}.`));
    for (const slug of ['notes/b', 'notes/d', 'notes/f']) chmodSync(join(root, `${slug}.md`), 0o755);
    commit(root, 'interleave');
    const delta = await performManagedSync(engine, { ...OPTS, bulk });
    expect(delta).toMatchObject({ status: 'synced', prescreened: 3, modified: 3 });
  }, { databaseUrl, setup }), 180_000);

  test('a fingerprint that changes after discovery froze the prescreen falls through to the ordinary path', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    rewriteHistory(root);
    // One page per slice: the kernel passes notes/a and the rest of the frozen manifest waits, still marked prescreened.
    expect(await performManagedSync(engine, OPTS, { maxPages: 1, maxMs: 60_000 })).toMatchObject({ status: 'partial', prescreened: 1 });
    // As if another binary (another parser) resumed the cursor.
    for (const slug of SLUGS.slice(1)) await tamper(engine, slug, [['parser,parser_version', 'an-older-parser']]);
    expect(await performManagedSync(engine, OPTS)).toMatchObject({ status: 'synced', prescreened: 1 });
    const incarnation = await incarnationOf(engine);
    for (const slug of SLUGS.slice(1)) expect((await readSyncImportProvenance(engine, 'default', incarnation, await pageIdOf(engine, slug)))?.parser?.parser_version).toBe(SYNC_IMPORT_PARSER_VERSION);
  }, { databaseUrl, setup }), 180_000);

  test('an oversized working copy of a prescreened file falls through to the ordinary path instead of failing the run', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    rewriteHistory(root);
    writeFileSync(join(root, 'notes/a.md'), Buffer.alloc(SYNC_READ_BOUND + 1, 'a'));
    const walk = await performManagedSync(engine, OPTS);
    expect(walk).toMatchObject({ status: 'synced', prescreened: SLUGS.length - 1 });
    expect(heldOf(walk)).toEqual([{ path: 'notes/a.md', code: 'file_too_large' }]);
    expect(await bodyOf(engine, 'notes/a')).toContain('The committed body of notes/a.');
  }, { databaseUrl, setup }), 180_000);

  test('a database-only edit to a page whose file did not change is held file_drift and not imported', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const requestId = await databaseOnlyEdit(engine, ctx, 'notes/a', 'The database-only edit of notes/a.');
    rewriteHistory(root);
    const walk = await performManagedSync(engine, OPTS);
    expect(walk.status).not.toBe('blocked_by_failures');
    expect(heldOf(walk)).toEqual([{ path: 'notes/a.md', code: 'file_drift' }]);
    expect(walk.holds_escalated ?? false).toBe(false);
    const item = walk.held![0]!;
    expect(item.fix.argv).toEqual(['gbrain', 'repair', 'file-drift', '--source', 'default', '--slug', 'notes/a', '--prefer', 'database']);
    expect(item.fix.why).toContain(requestId);
    expect(await bodyOf(engine, 'notes/a')).toContain('The database-only edit of notes/a.');
    expect(await readGitHold(engine, 'default', await incarnationOf(engine), 'notes/a.md')).toMatchObject({ code: 'file_drift',
      meta: { sides: 'database', competing_request_id: requestId, competing_operation: 'put_page', page_revision: await revisionOf(engine, 'notes/a') } });
    // Another tree walk keeps it held; the database version is never overwritten.
    rewriteHistory(root);
    await performManagedSync(engine, OPTS);
    expect(await bodyOf(engine, 'notes/a')).toContain('The database-only edit of notes/a.');
    // A further database edit moves the page: the hold is re-screened (a delta run, the file unchanged) and held again.
    await databaseOnlyEdit(engine, ctx, 'notes/a', 'A second database-only edit of notes/a.');
    writeFileSync(join(root, 'notes/f.md'), note('notes/f', 'A changed body of notes/f.')); commit(root, 'change f');
    const delta = await performManagedSync(engine, OPTS);
    expect(heldOf(delta)).toEqual([{ path: 'notes/a.md', code: 'file_drift' }]);
    expect(await bodyOf(engine, 'notes/a')).toContain('A second database-only edit of notes/a.');
  }, { databaseUrl, setup }), 180_000);

  test('with sync.holds=fail the same drift stops the run with file_drift instead of importing over the database edit', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyEdit(engine, ctx, 'notes/a', 'The database-only edit of notes/a.');
    await engine.setConfig('sync.holds', 'fail');
    rewriteHistory(root);
    const outcome = await performManagedSync(engine, OPTS).then(result => result, (error: unknown) => error);
    expect(outcome).toMatchObject({ code: 'file_drift' });
    expect(await bodyOf(engine, 'notes/a')).toContain('The database-only edit of notes/a.');
  }, { databaseUrl, setup }), 180_000);

  test('under a storage.keep_db prefix the drifted page is neither held nor imported; the keep_db worker gets it as a candidate', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyEdit(engine, ctx, 'notes/a', 'The database-only edit of notes/a.');
    writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  keep_db:\n    - notes/\n'); commit(root, 'keep_db');
    rewriteHistory(root);
    const walk = await performManagedSync(engine, OPTS);
    expect(heldOf(walk)).toEqual([]);
    expect(await bodyOf(engine, 'notes/a')).toContain('The database-only edit of notes/a.');
    expect(Object.keys(await readDriftSkips(engine))).toContain('default:notes/a');
    expect(walk).toMatchObject({ prescreened: SLUGS.length - 1 });
  }, { databaseUrl, setup }), 180_000);

  test('cold upgrade: missing, partial and obsolete provenance with a database-only edit are held, in a tree walk and under --full', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    for (const slug of ['notes/a', 'notes/b', 'notes/c']) await databaseOnlyEdit(engine, ctx, slug, `The database-only edit of ${slug}.`);
    await tamper(engine, 'notes/a', 'delete');
    await tamper(engine, 'notes/b', { drop: ['revision', 'disk_sha256', 'disk_blob_oid', 'parser'] });
    await tamper(engine, 'notes/c', [['parser,parser_version', 'an-older-parser']]);
    // Equal-content controls: d has no record and no edit (sync wrote its revision); e has no record and an unattributed
    // revision whose content still equals the file; f has no record and a changed file on a page sync wrote last.
    await tamper(engine, 'notes/d', 'delete');
    await tamper(engine, 'notes/e', 'delete');
    await engine.executeRaw("UPDATE pages SET revision_write_request_id=NULL WHERE source_id='default' AND slug='notes/e'");
    await tamper(engine, 'notes/f', 'delete');
    writeFileSync(join(root, 'notes/f.md'), note('notes/f', 'A changed body of notes/f.')); commit(root, 'change f');
    rewriteHistory(root);
    const walk = await performManagedSync(engine, OPTS);
    expect(heldOf(walk)).toEqual([{ path: 'notes/a.md', code: 'file_drift' }, { path: 'notes/b.md', code: 'file_drift' }, { path: 'notes/c.md', code: 'file_drift' }]);
    const incarnation = await incarnationOf(engine);
    expect((await readGitHold(engine, 'default', incarnation, 'notes/a.md'))?.meta.sides).toBe('unknown');
    expect((await readGitHold(engine, 'default', incarnation, 'notes/b.md'))?.meta.sides).toBe('unknown');
    expect((await readGitHold(engine, 'default', incarnation, 'notes/c.md'))?.meta.sides).toBe('database');
    for (const slug of ['notes/a', 'notes/b', 'notes/c']) expect(await bodyOf(engine, slug)).toContain(`The database-only edit of ${slug}.`);
    expect(await bodyOf(engine, 'notes/f')).toContain('A changed body of notes/f.');
    expect(walk).toMatchObject({ waived: { imports: 2 } });
    for (const slug of ['notes/d', 'notes/e']) expect(await readSyncImportProvenance(engine, 'default', incarnation, await pageIdOf(engine, slug))).not.toBeNull();
    const full = await performManagedSync(engine, { ...OPTS, full: true });
    expect(heldOf(full)).toEqual([{ path: 'notes/a.md', code: 'file_drift' }, { path: 'notes/b.md', code: 'file_drift' }, { path: 'notes/c.md', code: 'file_drift' }]);
    for (const slug of ['notes/a', 'notes/b', 'notes/c']) expect(await bodyOf(engine, slug)).toContain(`The database-only edit of ${slug}.`);
  }, { databaseUrl, setup }), 240_000);

  test('a cursor whose manifest is gone re-discovers against HEAD and finishes; what the lost run imported is prescreened', () => managedBrain(async ({ engine }) => {
    const abort = new AbortController();
    const partial = await performManagedSync(engine, { ...OPTS, signal: abort.signal, onProgress: p => { if (p.bankedFiles === 2) abort.abort(); } });
    expect(partial).toMatchObject({ status: 'partial', filesImported: 2 });
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync-manifest'");
    // The lost run's own admitted request may still be finishing: the swap waits for it (writer_pending), then re-discovers.
    let resumed = await performManagedSync(engine, OPTS);
    for (let i = 0; i < 5 && resumed.status === 'partial'; i++) { await new Promise(resolve => setTimeout(resolve, 500)); resumed = await performManagedSync(engine, OPTS); }
    expect(resumed.status).toBe('first_sync');
    expect(resumed.prescreened).toBeGreaterThanOrEqual(2);
    for (const slug of SLUGS) expect(await bodyOf(engine, slug)).toContain(`The committed body of ${slug}.`);
  }, { databaseUrl, setup }), 180_000);

  test('a lost manifest re-discovers the whole tree at HEAD: files the lost run imported and HEAD reverted are restored, its added page is removed', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const original = SLUGS.map(slug => note(slug, `The committed body of ${slug}.`));
    writeFileSync(join(root, 'notes/0-added.md'), note('notes/0-added', 'A page the lost run added.'));
    for (const slug of SLUGS) writeFileSync(join(root, `${slug}.md`), note(slug, `The lost run's body of ${slug}.`));
    commit(root, 'change everything');
    const abort = new AbortController();
    const partial = await performManagedSync(engine, { ...OPTS, signal: abort.signal, onProgress: p => { if (p.bankedFiles === 2) abort.abort(); } });
    expect(partial).toMatchObject({ status: 'partial', filesImported: 2 });
    expect(await bodyOf(engine, 'notes/a')).toContain("The lost run's body of notes/a.");
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync-manifest'");
    // HEAD reverts every file the lost run saw, so last_commit..HEAD is empty: only a walk of HEAD's tree finds them.
    SLUGS.forEach((slug, i) => writeFileSync(join(root, `${slug}.md`), original[i]!));
    git(root, 'rm', '-q', 'notes/0-added.md'); commit(root, 'revert');
    let resumed = await performManagedSync(engine, OPTS);
    for (let i = 0; i < 5 && resumed.status === 'partial'; i++) { await new Promise(resolve => setTimeout(resolve, 500)); resumed = await performManagedSync(engine, OPTS); }
    expect(resumed.status).toBe('synced');
    for (const slug of SLUGS) expect(await bodyOf(engine, slug)).toContain(`The committed body of ${slug}.`);
    expect(await engine.getPage('notes/0-added', { sourceId: 'default' })).toBeNull();
  }, { databaseUrl, setup }), 180_000);
});
