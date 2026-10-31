/**
 * #6712 PR 1 (L1) prescreen and drift guard, rewritten for PR 4b: a non-company source runs the live pass, which compares
 * the whole tree with what the database absorbed, so the cursor's prescreen, manifest and tree walk are gone and these tests
 * assert the pass's behavior on the same data.
 *
 * Protects:
 * - a page whose import provenance matches the level's blob, the page revision and this parser is not a candidate: no
 *   request, no preparation, no new revision;
 * - a parser change and a byte change are candidates (reparse and import); a record whose revision no longer names the
 *   page is db_ahead and the page is kept; --full screens every matched page;
 * - a database-only edit to a page whose file did not change is db_ahead: neither imported nor held, the body survives
 *   repeated passes, a second edit and sync.holds=fail; under a storage.keep_db prefix the pass admits its keep_db write
 *   (the working copy gets the database bytes);
 * - cold upgrade: a database-only edit with no provenance is held file_drift (sides unknown); with partial or obsolete
 *   provenance it is db_ahead; equal-content controls get records, a changed file on a page sync wrote last imports;
 * - an interrupted first pass resumes and does not re-import what it imported; a pass interrupted before HEAD reverted
 *   everything restores the files and removes the page it added.
 * PGLite always; Postgres too when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { readGitHold, readSyncImportProvenance, SYNC_IMPORT_PARSER_VERSION, SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { readDriftSkips } from '../src/core/persistence/drift-conflicts.ts';
import { SYNC_READ_BOUND } from '../src/core/persistence/sync-blobs.ts';
import { resolveBulkSettings } from '../src/core/persistence/sync-group.ts';
import { readShadowLevel } from '../src/core/persistence/sync-pass.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { waitFor } from './helpers/wait-for.ts';
import { isWriteCapacityWait } from '../src/core/persistence/admission-retry.ts';

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
const classOf = async (engine: BrainEngine, path: string) => (await readShadowLevel(engine, { sourceId: 'default' }))!.paths.find(entry => entry.path === path)?.result;
/** A binary with another parser: the pass row's parser fingerprint and the named pages' records name the older parser. */
async function olderParser(engine: BrainEngine, slugs: string[]): Promise<void> {
  for (const slug of slugs) await tamper(engine, slug, [['parser,parser_version', 'an-older-parser']]);
  await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,obligations,converged,parser_fp}','\"an-older-parser\"'::jsonb) WHERE op='managed-sync-pass'");
}
const heldOf = (result: Awaited<ReturnType<typeof performManagedSync>>) => (result.held ?? []).map(hold => ({ path: hold.path, code: hold.code })).sort((a, b) => a.path.localeCompare(b.path));

for (const databaseUrl of process.env.DATABASE_URL ? [undefined, process.env.DATABASE_URL] : [undefined]) describe(`#6712 PR 1 prescreen and drift guard (${databaseUrl ? 'postgres' : 'pglite'})`, () => {
  test('a provenance match is not a pass candidate: no request, no preparation, no new revision', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const revisions = new Map(await Promise.all(SLUGS.map(async slug => [slug, await revisionOf(engine, slug)] as const)));
    const requests = await importRequests(engine);
    rewriteHistory(root);
    const walk = await performManagedSync(engine, OPTS);
    expect(walk).toMatchObject({ status: 'synced', pass: { kind: 'full', candidates: 0 }, added: 0, modified: 0 });
    expect(await importRequests(engine)).toBe(requests);
    for (const slug of SLUGS) expect(await revisionOf(engine, slug)).toBe(revisions.get(slug)!);
  }, { databaseUrl, setup }), 180_000);

  test('a parser change and a byte change are pass candidates; a record revision that no longer names the page is db_ahead; --full admits every current page in place', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await tamper(engine, 'notes/a', [['parser,parser_version', 'an-older-parser']]);
    await tamper(engine, 'notes/b', [['revision', '1']]);
    writeFileSync(join(root, 'notes/c.md'), note('notes/c', 'A changed body of notes/c.')); commit(root, 'change c');
    rewriteHistory(root);
    const walk = await performManagedSync(engine, OPTS);
    // a reparses (screened and waived), c imports; b's record no longer names the page's revision, so the database is ahead and kept.
    expect(walk).toMatchObject({ status: 'synced', pass: { kind: 'full', candidates: 2 }, waived: { imports: 1 }, modified: 1 });
    expect(heldOf(walk)).toEqual([]);
    expect(await bodyOf(engine, 'notes/c')).toContain('A changed body of notes/c.');
    expect(await bodyOf(engine, 'notes/b')).toContain('The committed body of notes/b.');
    expect(await classOf(engine, 'notes/b.md')).toMatchObject({ cls: 'db_ahead', settled: true });
    const incarnation = await incarnationOf(engine);
    expect((await readSyncImportProvenance(engine, 'default', incarnation, await pageIdOf(engine, 'notes/a')))?.parser?.parser_version).toBe(SYNC_IMPORT_PARSER_VERSION);
    // Every page is the import of its blob with its derived state current (b stays db_ahead), so --full admits each in place
    // (sync-classify.ts `inPlace`): no candidate, no screen, no new revision.
    const settled = new Map(await Promise.all(SLUGS.map(async slug => [slug, await revisionOf(engine, slug)] as const)));
    const full = await performManagedSync(engine, { ...OPTS, full: true });
    expect(full).toMatchObject({ status: 'synced', pass: { kind: 'full', candidates: 0 }, waived: { imports: 0 }, modified: 0 });
    for (const slug of SLUGS) expect(await revisionOf(engine, slug)).toBe(settled.get(slug)!);
  }, { databaseUrl, setup }), 180_000);

  test('in a bulk drain a mode-only change between changed files is not a candidate; only the changed files import', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const bulk = await resolveBulkSettings(engine, false);
    expect(bulk.enabled).toBe(engine.kind === 'postgres'); // bulk groups are Postgres-only
    // a, c, e change; b, d, f change only their mode (same blob): one Git delta interleaves them.
    for (const slug of ['notes/a', 'notes/c', 'notes/e']) writeFileSync(join(root, `${slug}.md`), note(slug, `A changed body of ${slug}.`));
    for (const slug of ['notes/b', 'notes/d', 'notes/f']) chmodSync(join(root, `${slug}.md`), 0o755);
    commit(root, 'interleave');
    const delta = await performManagedSync(engine, { ...OPTS, bulk });
    expect(delta).toMatchObject({ status: 'synced', pass: { candidates: 3 }, modified: 3 });
    for (const slug of ['notes/a', 'notes/c', 'notes/e']) expect(await bodyOf(engine, slug)).toContain(`A changed body of ${slug}.`);
  }, { databaseUrl, setup }), 180_000);

  test('a parser change between passes re-imports the pages whose records name the older parser', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    rewriteHistory(root);
    expect(await performManagedSync(engine, OPTS)).toMatchObject({ status: 'synced', pass: { candidates: 0 } });
    // As if another binary (another parser) wrote these records.
    await olderParser(engine, SLUGS.slice(1));
    expect(await performManagedSync(engine, OPTS)).toMatchObject({ pass: { kind: 'full', candidates: SLUGS.length - 1 } });
    const incarnation = await incarnationOf(engine);
    for (const slug of SLUGS.slice(1)) expect((await readSyncImportProvenance(engine, 'default', incarnation, await pageIdOf(engine, slug)))?.parser?.parser_version).toBe(SYNC_IMPORT_PARSER_VERSION);
  }, { databaseUrl, setup }), 180_000);

  test('an oversized working copy of a matched file in committed mode is not read: no candidate, no hold, the page keeps the committed body', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    rewriteHistory(root);
    writeFileSync(join(root, 'notes/a.md'), Buffer.alloc(SYNC_READ_BOUND + 1, 'a'));
    const walk = await performManagedSync(engine, OPTS);
    expect(walk).toMatchObject({ status: 'synced', pass: { candidates: 0 } });
    expect(heldOf(walk)).toEqual([]);
    expect(await bodyOf(engine, 'notes/a')).toContain('The committed body of notes/a.');
  }, { databaseUrl, setup }), 180_000);

  test('a database-only edit to a page whose file did not change is db_ahead: not imported, not held, the page body survives', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyEdit(engine, ctx, 'notes/a', 'The database-only edit of notes/a.');
    const requests = await importRequests(engine);
    rewriteHistory(root);
    const walk = await performManagedSync(engine, OPTS);
    expect(walk).toMatchObject({ status: 'synced', pass: { candidates: 0 } });
    expect(heldOf(walk)).toEqual([]);
    expect(await importRequests(engine)).toBe(requests);
    expect(await bodyOf(engine, 'notes/a')).toContain('The database-only edit of notes/a.');
    expect(await classOf(engine, 'notes/a.md')).toMatchObject({ cls: 'db_ahead', action: 'none', settled: true });
    expect(await readGitHold(engine, 'default', await incarnationOf(engine), 'notes/a.md')).toBeNull();
    // Another tree walk keeps it; the database version is never overwritten.
    rewriteHistory(root);
    await performManagedSync(engine, OPTS);
    expect(await bodyOf(engine, 'notes/a')).toContain('The database-only edit of notes/a.');
    // A further database edit and an unrelated committed change: still db_ahead, the newer database body kept.
    await databaseOnlyEdit(engine, ctx, 'notes/a', 'A second database-only edit of notes/a.');
    writeFileSync(join(root, 'notes/f.md'), note('notes/f', 'A changed body of notes/f.')); commit(root, 'change f');
    const delta = await performManagedSync(engine, OPTS);
    expect(heldOf(delta)).toEqual([]);
    expect(await bodyOf(engine, 'notes/a')).toContain('A second database-only edit of notes/a.');
    expect(await bodyOf(engine, 'notes/f')).toContain('A changed body of notes/f.');
    expect(await classOf(engine, 'notes/a.md')).toMatchObject({ cls: 'db_ahead', settled: true });
  }, { databaseUrl, setup }), 180_000);

  test('with sync.holds=fail a db_ahead page is nothing to refuse: the run finishes and the database edit survives', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyEdit(engine, ctx, 'notes/a', 'The database-only edit of notes/a.');
    await engine.setConfig('sync.holds', 'fail');
    rewriteHistory(root);
    expect(await performManagedSync(engine, OPTS)).toMatchObject({ status: 'synced', pass: { candidates: 0 } });
    expect(await bodyOf(engine, 'notes/a')).toContain('The database-only edit of notes/a.');
  }, { databaseUrl, setup }), 180_000);

  test('under a storage.keep_db prefix the drifted page is neither held nor imported; the pass admits its keep_db write, the file gets the database bytes', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyEdit(engine, ctx, 'notes/a', 'The database-only edit of notes/a.');
    writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  keep_db:\n    - notes/\n'); commit(root, 'keep_db');
    rewriteHistory(root);
    const walk = await performManagedSync(engine, OPTS);
    expect(heldOf(walk)).toEqual([]);
    expect(await bodyOf(engine, 'notes/a')).toContain('The database-only edit of notes/a.');
    // The keep_db write publishes the database bytes to the working copy: committed L still differs, so the path is
    // dirty and settled (design v3.2 §4, published).
    expect(walk).toMatchObject({ pass: { candidates: 0 } });
    const [row] = await engine.executeRaw<{ admitted: string | null }>("SELECT completed_keys->0->'telemetry'->'counts'->>'keep_db_admitted' AS admitted FROM op_checkpoints WHERE op='managed-sync-pass'");
    expect(Number(row?.admitted)).toBe(1);
    expect(await classOf(engine, 'notes/a.md')).toMatchObject({ cls: 'dirty', settled: true });
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toContain('The database-only edit of notes/a.');
  }, { databaseUrl, setup }), 180_000);

  test('two-sided keep_db pages whose keep_db write is refused for write capacity wait as keep_db_pending and are never held file_drift; later passes admit them', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const twoSided = ['notes/a', 'notes/b', 'notes/c', 'notes/d'];
    for (const slug of twoSided) {
      await databaseOnlyEdit(engine, ctx, slug, `The database-only edit of ${slug}.`);
      writeFileSync(join(root, `${slug}.md`), note(slug, `A committed edit of ${slug}.`));
    }
    writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  keep_db:\n    - notes/\n'); commit(root, 'keep_db and file edits');
    // Two outstanding requests per writer: the pass's third keep_db admission is refused queue_capacity while the first two are in flight.
    await engine.setConfig('persistence.limits.principal_outstanding', '2');
    const incarnation = await incarnationOf(engine);
    for (let pass = 0; pass < 8; pass++) {
      // The drain (sync-drain.ts) waits out an outstanding-cap refusal of a sync's own write; a direct pass call does the same here.
      const result = await performManagedSync(engine, OPTS).catch(async error => { if (!isWriteCapacityWait(error)) throw error; await new Promise(r => setTimeout(r, 200)); return null; });
      if (result) expect(heldOf(result)).toEqual([]);
      for (const slug of twoSided) expect(await readGitHold(engine, 'default', incarnation, `${slug}.md`)).toBeNull();
    }
    for (const slug of twoSided) {
      expect(await bodyOf(engine, slug)).toContain(`The database-only edit of ${slug}.`);
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain(`The database-only edit of ${slug}.`);
    }
  }, { databaseUrl, setup }), 180_000);

  test('cold upgrade: a database-only edit with no provenance is held, with partial or obsolete provenance it is db_ahead; no edit is overwritten, in a tree walk or under --full', () => managedBrain(async ({ engine, ctx, root }) => {
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
    // a has no record at all, so nothing attests either side: held. b and c keep a record of the file they imported
    // and their pages moved since, so the database is ahead: kept, not held.
    expect(heldOf(walk)).toEqual([{ path: 'notes/a.md', code: 'file_drift' }]);
    const incarnation = await incarnationOf(engine);
    expect((await readGitHold(engine, 'default', incarnation, 'notes/a.md'))?.meta.sides).toBe('unknown');
    for (const path of ['notes/b.md', 'notes/c.md']) expect(await classOf(engine, path)).toMatchObject({ cls: 'db_ahead', settled: true });
    for (const slug of ['notes/a', 'notes/b', 'notes/c']) expect(await bodyOf(engine, slug)).toContain(`The database-only edit of ${slug}.`);
    expect(await bodyOf(engine, 'notes/f')).toContain('A changed body of notes/f.');
    expect(walk).toMatchObject({ waived: { imports: 2 } });
    for (const slug of ['notes/d', 'notes/e']) expect(await readSyncImportProvenance(engine, 'default', incarnation, await pageIdOf(engine, slug))).not.toBeNull();
    const full = await performManagedSync(engine, { ...OPTS, full: true });
    expect(heldOf(full)).toEqual([]);
    expect(await readGitHold(engine, 'default', incarnation, 'notes/a.md')).toMatchObject({ code: 'file_drift' });
    for (const slug of ['notes/a', 'notes/b', 'notes/c']) expect(await bodyOf(engine, slug)).toContain(`The database-only edit of ${slug}.`);
  }, { databaseUrl, setup }), 240_000);

  test('an interrupted first pass resumes on the next run; what it imported is no longer a candidate', () => managedBrain(async ({ engine }) => {
    const abort = new AbortController();
    const partial = await performManagedSync(engine, { ...OPTS, signal: abort.signal, onProgress: p => { if (p.bankedFiles === 2) abort.abort(); } });
    expect(partial).toMatchObject({ status: 'partial', filesImported: 2 });
    // The interrupted pass's own admitted request may still be finishing.
    let resumed = await performManagedSync(engine, OPTS);
    for (let i = 0; i < 5 && resumed.status === 'partial'; i++) { await new Promise(resolve => setTimeout(resolve, 500)); resumed = await performManagedSync(engine, OPTS); }
    expect(resumed.status).toBe('first_sync');
    expect(resumed.pass!.candidates).toBeLessThanOrEqual(SLUGS.length - 2);
    for (const slug of SLUGS) expect(await bodyOf(engine, slug)).toContain(`The committed body of ${slug}.`);
  }, { databaseUrl, setup }), 180_000);
  test('an interrupted pass whose HEAD then reverts everything: the next pass restores what it imported and removes the page it added', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const original = SLUGS.map(slug => note(slug, `The committed body of ${slug}.`));
    writeFileSync(join(root, 'notes/0-added.md'), note('notes/0-added', 'A page the lost run added.'));
    for (const slug of SLUGS) writeFileSync(join(root, `${slug}.md`), note(slug, `The lost run's body of ${slug}.`));
    commit(root, 'change everything');
    const abort = new AbortController();
    const partial = await performManagedSync(engine, { ...OPTS, signal: abort.signal, onProgress: p => { if (p.bankedFiles === 2) abort.abort(); } });
    expect(partial).toMatchObject({ status: 'partial', filesImported: 2 });
    expect(await bodyOf(engine, 'notes/a')).toContain("The lost run's body of notes/a.");
    // HEAD reverts every file the interrupted pass saw, so last_commit..HEAD is empty: only the whole-tree comparison finds them.
    SLUGS.forEach((slug, i) => writeFileSync(join(root, `${slug}.md`), original[i]!));
    git(root, 'rm', '-q', 'notes/0-added.md'); commit(root, 'revert');
    let resumed = await performManagedSync(engine, OPTS);
    for (let i = 0; i < 5 && resumed.status === 'partial'; i++) { await new Promise(resolve => setTimeout(resolve, 500)); resumed = await performManagedSync(engine, OPTS); }
    expect(resumed.status).toBe('synced');
    for (const slug of SLUGS) expect(await bodyOf(engine, slug)).toContain(`The committed body of ${slug}.`);
    expect(await engine.getPage('notes/0-added', { sourceId: 'default' })).toBeNull();
  }, { databaseUrl, setup }), 180_000);
});
