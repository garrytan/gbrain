/**
 * #6340: a page that moves under a managed catch-up holds the page, not the run.
 *
 * On a live checkout (agents commit to the brain repo every few minutes while a
 * multi-hour catch-up drains a frozen manifest) four recoverable faults ended
 * the whole run and every relaunch re-froze the manifest: `revision_conflict`
 * and `page_identity_changed` at freeze time, `pinned_git_worktree_conflict`
 * at publication, and a pooler drop (`write ECONNABORTED`) that the retry
 * classifier did not know. Each probe here fails on master (the run throws or
 * returns `blocked_by_failures`, or the next run rediscovers from index 0) and
 * passes with the resolver (`sync-page-fault.ts`), the receipt conversions and
 * the ledger skip. Synthetic content only.
 *
 * #6712 PR 4b: a non-company source runs the live pass, which has no frozen manifest or cursor. The rewritten probes
 * protect the same data under the pass: after an interrupted pass the next pass pins the new HEAD and imports a page
 * committed since, without re-importing what the interrupted pass absorbed; a database edit landing between passes on a
 * page whose file changed too is held file_drift (both sides), one that already holds the file's import is waived, and
 * one deleted there is held file_drift on its deleted side (tombstone_edited) and stays deleted;
 * a dropped connection leaves no failure-ledger row and the relaunch imports only what is left; a file committed after
 * admission is passed over and imported in a later round, and one that moves under every request stops the pass
 * not_converged after PASS_MAX_ROUNDS requests without a hold. A source an older release left blocked on a pinned-worktree or
 * canonical-writeback conflict (simulated with sync.holds=fail) is held worktree_dirty by the next --retry-failed pass once holds
 * are on, under its own receipt, with the blocked receipt unchanged and attempts counted on the one hold.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { DEFER_PER_ENTRY, performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readGitHold, readGitSourceHolds, requestGitHoldRetry } from '../src/core/persistence/sync-holds.ts';
import { readManagedSyncFailures } from '../src/core/persistence/sync-failures.ts';
import { headCommittedBytes, HOLD_ATTEMPTS_NEEDS_HUMAN, pinnedWorktreeConflict } from '../src/core/persistence/sync-page-fault.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { loadSyncFailures } from '../src/core/sync-failure-ledger.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { contentHash } from '../src/core/utils.ts';
import { PASS_MAX_ROUNDS } from '../src/core/persistence/sync-pass-run.ts';
import { readShadowLevel } from '../src/core/persistence/sync-pass.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-page-fault-holds-'));
const engines: BrainEngine[] = [];
const sources: string[] = [];
let closePostgres: (() => Promise<void>) | undefined;
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function commit(root: string, message = 'synthetic content'): string { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); }
const note = (body: string) => `---\ntitle: Example\n---\n${body}\n`;
async function fixture(engine: BrainEngine, files: Record<string, string>) {
  const id = `fault-${randomUUID().replace(/-/g, '').slice(0, 20)}`; sources.push(id);
  const root = join(home, id); mkdirSync(root); git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) { const full = join(root, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, body); }
  const head = commit(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, head, opts: { sourceId: id, noPull: true, noEmbed: true, noExtract: true } };
}
const cursorOf = (engine: BrainEngine, sourceId: string) => engine.executeRaw<{ run_id: string; index: number; total: number; target: string; done: boolean | null }>(
  `SELECT completed_keys->0->>'runId' AS run_id,(completed_keys->0->>'index')::int AS index,(completed_keys->0->>'total')::int AS total,completed_keys->0->>'target' AS target,
     (completed_keys->0->>'done')::boolean AS done FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1`, [sourceId]).then(rows => rows[0]);
const dbWrite = (engine: BrainEngine, sourceId: string, slug: string, body: string) => engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.putPage(slug, {
  type: 'note', title: 'Example', compiled_truth: body, timeline: '', frontmatter: {}, content_hash: `h-${body.length}` }, { sourceId }), TEST_WRITE_ATTRIBUTION));
/** The receipts of `path`, oldest first: what a later pass must leave as it was. */
const receiptsOf = (engine: BrainEngine, sourceId: string, path: string) => engine.executeRaw<{ request_id: string; state: string; error_code: string | null; error_message: string | null; pass_id: string | null }>(
  "SELECT request_id::text AS request_id,state,error_code,error_message,intent->>'passId' AS pass_id FROM persistence_requests WHERE source_id=$1 AND intent->>'path'=$2 ORDER BY sequence", [sourceId, path]);
/** Interrupts the first sync after `pages` committed pages, so the cursor's pinned target trails the commits the test makes next. */
async function interruptedAfter(engine: BrainEngine, opts: { sourceId: string; noPull: boolean }, pages: number) {
  const abort = new AbortController();
  const partial = await performManagedSync(engine, { ...opts, signal: abort.signal, onProgress: p => { if (p.bankedFiles === pages) abort.abort(); } });
  expect(partial).toMatchObject({ status: 'partial', filesImported: pages });
  return partial;
}

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const id of sources) await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]); await engine.disconnect(); }
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

test('after an interrupted pass, the next pass pins the new HEAD and imports a page committed past the interrupted target instead of refusing it (#6320, from PR #6323)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': note('First observation, version one.'), 'b.md': note('Second observation, version one.') });
    expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
    writeFileSync(join(f.root, 'a.md'), note('First observation, version two.')); writeFileSync(join(f.root, 'b.md'), note('Second observation, version two.'));
    commit(f.root, 'version two of both');
    await interruptedAfter(engine, f.opts, 1);
    // A live checkout keeps committing: b.md moves past the interrupted pass's target.
    writeFileSync(join(f.root, 'b.md'), note('Second observation, version three.')); const head = commit(f.root, 'version three of b, past the pin');
    expect(headCommittedBytes({ root: f.root, gitRoot: f.root }, 'b.md')).toMatchObject({ oid: git(f.root, 'rev-parse', 'HEAD:b.md') });
    const before = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'path'='a.md'", [f.id]);
    const resumed = await performManagedSync(engine, f.opts);
    // a.md was absorbed by the interrupted pass, so only b.md is a candidate, imported at HEAD.
    expect(resumed).toMatchObject({ status: 'synced', toCommit: head, modified: 1, pass: { kind: 'full', candidates: 1, outcome: 'synced' } });
    expect(resumed.held_count ?? 0).toBe(0); expect(resumed.managedWrite).toBeUndefined();
    expect(await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'path'='a.md'", [f.id])).toEqual(before);
    expect((await engine.getPage('a', { sourceId: f.id }))?.compiled_truth).toContain('version two');
    expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toContain('version three');
    expect(readFileSync(join(f.root, 'b.md'), 'utf8')).toBe(note('Second observation, version three.'));
    expect(git(f.root, 'status', '--porcelain')).toBe('');
    const next = await performManagedSync(engine, f.opts);
    expect(next).toMatchObject({ toCommit: head, status: 'up_to_date', modified: 0 });
    expect(next.pass).toBeUndefined();
    expect(loadSyncFailures().filter(row => row.source_id === f.id)).toHaveLength(0);
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
  }
}), 120_000);

test('an uncommitted edit under the catch-up is held worktree_dirty with the pinned blob; committing it imports on the next sync and clears the hold', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': note('Alpha, version one.'), 'b.md': note('Beta, version one.'), 'c.md': note('Gamma, version one.') });
    expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
    for (const name of ['a', 'b', 'c']) writeFileSync(join(f.root, `${name}.md`), note(`${name} version two.`));
    const pin = commit(f.root, 'version two');
    await interruptedAfter(engine, f.opts, 1);
    // Another agent is mid-edit on b.md (the iMessage monitor case): the bytes match neither the pin nor the page and are not committed.
    const edit = note('Beta, a private edit still in progress.');
    writeFileSync(join(f.root, 'b.md'), edit);
    const resumed = await performManagedSync(engine, f.opts);
    expect(resumed).toMatchObject({ status: 'synced', toCommit: pin, held_count: 1, held: [{ path: 'b.md', code: 'worktree_dirty' }] });
    expect(resumed.managedWrite).toBeUndefined();
    expect(JSON.stringify(resumed)).not.toContain('private edit');
    expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toContain('version one');
    expect((await engine.getPage('c', { sourceId: f.id }))?.compiled_truth).toContain('version two');
    expect(readFileSync(join(f.root, 'b.md'), 'utf8')).toBe(edit);
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [f.id]);
    const hold = (await readGitHold(engine, f.id, source.incarnation, 'b.md'))!;
    expect(hold).toMatchObject({ code: 'worktree_dirty', slug: 'b', meta: { blob_oid: git(f.root, 'rev-parse', `${pin}:b.md`), attempts: 1 } });
    expect(hold.meta.working_hash).toBeDefined();
    expect(resumed.held![0]!.fix.why).toContain('commit');
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
    // Still dirty on the next run: nothing to re-screen (the pinned blob is unchanged), the hold stays, the run is up to date.
    expect((await performManagedSync(engine, f.opts)).status).toBe('up_to_date');
    expect((await readGitHold(engine, f.id, source.incarnation, 'b.md'))?.meta.attempts).toBe(1);
    // The agent commits its edit: the blob at the new target differs from the hold's, so discovery re-screens and imports it.
    const head = commit(f.root, 'the agent commits its edit');
    const after = await performManagedSync(engine, f.opts);
    expect(after).toMatchObject({ status: 'synced', toCommit: head, modified: 1 });
    expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toContain('private edit still in progress');
    expect(await readGitHold(engine, f.id, source.incarnation, 'b.md')).toBeNull();
  }
}), 120_000);

// #6513: a pinned import whose canonical correction (a fixable facts fence: `partnership` maps to `fact`) must rewrite the
// file, when the file already holds newer uncommitted bytes.
const FB = '<!--- gbrain:facts:begin -->', FBE = '<!--- gbrain:facts:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const fixable = (body = 'A synthetic page.') => `---\ntitle: Fixable\n---\n${body}\n\n${FB}\n${FH}\n| 1 | Sentinelzq8 partners with an example vendor | partnership | 1.0 | private | medium | 2026-01-01 |  | chat |  |\n${FBE}\n`;
const WRITEBACK_CONFLICT = 'Canonical sanitization cannot overwrite newer working-tree bytes.';

test('#6513: a canonical writeback refused for newer uncommitted bytes is held worktree_dirty instead of blocking the cursor; the committed edit imports next', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': note('Alpha one.'), 'b.md': note('Beta one.') });
    expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
    writeFileSync(join(f.root, 'a.md'), note('Alpha two.')); writeFileSync(join(f.root, 'b.md'), note('Beta two.'));
    mkdirSync(join(f.root, 'people')); writeFileSync(join(f.root, 'people/fixable.md'), fixable());
    const pin = commit(f.root, 'version two with a fixable fence');
    await interruptedAfter(engine, f.opts, 1);
    // An agent edits the new page before the catch-up reaches it: the pinned import wants to rewrite the fence, the file is newer.
    const edit = fixable('A synthetic page, edited while the catch-up drained.');
    writeFileSync(join(f.root, 'people/fixable.md'), edit);
    const resumed = await performManagedSync(engine, f.opts);
    expect(resumed).toMatchObject({ status: 'synced', toCommit: pin, held_count: 1, held: [{ path: 'people/fixable.md', code: 'worktree_dirty' }] });
    expect(resumed.managedWrite).toBeUndefined();
    expect(resumed.held![0]!.message).toContain('canonical correction');
    expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toContain('Beta two.');
    expect(await engine.getPage('people/fixable', { sourceId: f.id })).toBeNull();
    expect(readFileSync(join(f.root, 'people/fixable.md'), 'utf8')).toBe(edit);
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
    expect(pinnedWorktreeConflict({ state: 'conflict', error_code: 'source_changed', error_message: WRITEBACK_CONFLICT })).toBe(true);
    // The cursor is finished, so the checkout is movable again; the agent commits and the next sync imports (and corrects) its edit.
    const head = commit(f.root, 'the agent commits its edit');
    const after = await performManagedSync(engine, f.opts);
    expect(after).toMatchObject({ status: 'synced', toCommit: head, added: 1 });
    expect((await engine.getPage('people/fixable', { sourceId: f.id }))?.compiled_truth).toContain('edited while the catch-up drained');
    expect((await engine.getPage('people/fixable', { sourceId: f.id }))?.compiled_truth).toContain('| fact |');
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [f.id]);
    expect(await readGitHold(engine, f.id, source.incarnation, 'people/fixable.md')).toBeNull();
  }
}), 120_000);

test('#6513: working-tree bytes that already are the canonical correction import without a second writeback', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    // The correction gbrain itself writes for this fence, taken from a clean sync of the same bytes.
    const reference = await fixture(engine, { 'people/fixable.md': fixable() });
    expect((await performManagedSync(engine, reference.opts)).status).toBe('first_sync');
    const canonical = readFileSync(join(reference.root, 'people/fixable.md'), 'utf8');
    expect(canonical).not.toBe(fixable()); expect(canonical).toContain('| fact |');

    const f = await fixture(engine, { 'a.md': note('Alpha one.'), 'b.md': note('Beta one.') });
    expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
    writeFileSync(join(f.root, 'a.md'), note('Alpha two.')); writeFileSync(join(f.root, 'b.md'), note('Beta two.'));
    mkdirSync(join(f.root, 'people')); writeFileSync(join(f.root, 'people/fixable.md'), fixable());
    const pin = commit(f.root, 'version two with a fixable fence');
    await interruptedAfter(engine, f.opts, 1);
    // The writeback landed on disk but the request that carried it never settled: the file is the correction, the page is not there.
    writeFileSync(join(f.root, 'people/fixable.md'), canonical);
    const resumed = await performManagedSync(engine, f.opts);
    expect(resumed).toMatchObject({ status: 'synced', toCommit: pin });
    expect(resumed.held_count ?? 0).toBe(0); expect(resumed.managedWrite).toBeUndefined();
    expect((await engine.getPage('people/fixable', { sourceId: f.id }))?.compiled_truth).toContain('| fact |');
    expect(readFileSync(join(f.root, 'people/fixable.md'), 'utf8')).toBe(canonical);
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
    // Once the correction is committed, the pin..HEAD diff re-imports the same bytes as a no-op.
    const head = commit(f.root, 'the correction is committed');
    expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'synced', toCommit: head, added: 0, modified: 0 });
  }
}), 120_000);

// #6712 PR 4b: a non-company source has no cursor to convert in place (the first pass retires a legacy cursor row,
// sync-pass-cursor-retirement-6712). What survives is the release path: under sync.holds=fail the canonical-writeback
// refusal blocks the pass on its receipt; once holds are on, --retry-failed (a plain sync) re-admits the file under a new
// request of its own pass and holds it worktree_dirty (one attempt), imports the rest, keeps the agent's edit, and leaves the
// blocked receipt exactly as it was.
test('#6513: a pass blocked on the canonical-writeback conflict under sync.holds=fail is held worktree_dirty by the --retry-failed pass once holds are on, leaving the blocked receipt as it was', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': note('Alpha one.'), 'b.md': note('Beta one.') });
    expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
    writeFileSync(join(f.root, 'a.md'), note('Alpha two.')); writeFileSync(join(f.root, 'b.md'), note('Beta two.'));
    mkdirSync(join(f.root, 'people')); writeFileSync(join(f.root, 'people/fixable.md'), fixable());
    const pin = commit(f.root, 'version two with a fixable fence');
    const edit = fixable('A synthetic page, edited while the catch-up drained.');
    writeFileSync(join(f.root, 'people/fixable.md'), edit);
    await engine.setConfig('sync.holds', 'fail');
    let blocked;
    try { blocked = await performManagedSync(engine, f.opts); } finally { await engine.executeRaw("DELETE FROM config WHERE key='sync.holds'"); }
    expect(blocked).toMatchObject({ status: 'blocked_by_failures', managedWrite: { write_error: 'source_changed', reason: 'pinned_git_worktree_conflict' },
      failures: [{ path: 'people/fixable.md', code: 'source_changed', message: WRITEBACK_CONFLICT }], pass: { outcome: 'blocked' } });
    const failedId = blocked.managedWrite!.write_request.request_id;
    const before = await receiptsOf(engine, f.id, 'people/fixable.md');
    expect(before).toEqual([{ request_id: failedId, state: 'conflict', error_code: 'source_changed', error_message: WRITEBACK_CONFLICT, pass_id: blocked.pass!.pass_id }]);
    const held = await performManagedSync(engine, { ...f.opts, retryFailed: true });
    expect(held).toMatchObject({ status: 'synced', toCommit: pin, held_count: 1, held: [{ path: 'people/fixable.md', code: 'worktree_dirty' }], pass: { outcome: 'synced' } });
    expect(held.managedWrite).toBeUndefined();
    expect(held.held![0]!.message).toContain('canonical correction');
    const after = await receiptsOf(engine, f.id, 'people/fixable.md');
    expect(after).toEqual([before[0], { request_id: expect.any(String), state: 'conflict', error_code: 'source_changed', error_message: WRITEBACK_CONFLICT, pass_id: held.pass!.pass_id }]);
    expect(after[1]!.request_id).not.toBe(failedId);
    const [source] = await engine.executeRaw<{ incarnation: string; last_commit: string }>('SELECT incarnation::text AS incarnation,last_commit FROM sources WHERE id=$1', [f.id]);
    expect(source.last_commit).toBe(pin);
    expect(await readGitHold(engine, f.id, source.incarnation, 'people/fixable.md')).toMatchObject({ code: 'worktree_dirty', run_id: held.pass!.pass_id,
      meta: { attempts: 1, blob_oid: git(f.root, 'rev-parse', pin + ':people/fixable.md') } });
    expect((await engine.getPage('a', { sourceId: f.id }))?.compiled_truth).toContain('Alpha two.');
    expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toContain('Beta two.');
    expect(await engine.getPage('people/fixable', { sourceId: f.id })).toBeNull();
    expect(readFileSync(join(f.root, 'people/fixable.md'), 'utf8')).toBe(edit);
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
    expect(loadSyncFailures().filter(row => row.source_id === f.id)).toHaveLength(0);
    // Still dirty: the next plain sync is up to date and mints no receipt.
    expect((await performManagedSync(engine, f.opts)).status).toBe('up_to_date');
    expect(await receiptsOf(engine, f.id, 'people/fixable.md')).toEqual(after);
  }
}), 120_000);

test('a page edited in the database after an interrupted pass, whose file changed too, is held file_drift with both sides; one that already holds the import is waived; one deleted there is held on its deleted side and stays deleted', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': note('Alpha one.'), 'b.md': note('Beta one.'), 'c.md': note('Gamma one.'), 'd.md': note('Delta one.') });
    expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
    for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(f.root, `${name}.md`), note(`${name} two.`));
    const pin = commit(f.root, 'version two');
    await interruptedAfter(engine, f.opts, 1);
    // b: a database-only edit that diverges from the file; c: a database write that already carries exactly what the file would import.
    // No import of either is in flight when they land, so the pass classifies them: b moved on both sides, c already holds the file's import.
    await dbWrite(engine, f.id, 'b', 'Beta, edited straight in the database.');
    const parsed = parseMarkdown(note('c two.'), 'c.md');
    const page = { type: parsed.type, title: parsed.title, compiled_truth: parsed.compiled_truth, timeline: parsed.timeline ?? '', frontmatter: parsed.frontmatter };
    await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => tx.putPage('c', { ...page, content_hash: contentHash(page) }, { sourceId: f.id }), TEST_WRITE_ATTRIBUTION));
    // GBRA-130 (4b Postgres sweep): a raw putPage leaves the text projection a revision behind until the owner's resident
    // rebuild seals it; on Postgres that rebuild races this sync, and an unsealed c is admitted for projection_work instead
    // of waived. Seal it first, so c holds exactly what the file would import as the scenario states.
    await rebuildPendingPageProjections(engine);
    const [cProjection] = await engine.executeRaw<{ sealed: boolean }>("SELECT text_projection_revision=knowledge_revision AS sealed FROM pages WHERE source_id=$1 AND slug='c'", [f.id]);
    expect(cProjection!.sealed).toBe(true);
    const resumed = await performManagedSync(engine, f.opts);
    expect(resumed).toMatchObject({ status: 'synced', toCommit: pin, held_count: 1, held: [{ path: 'b.md', code: 'file_drift' }], modified: 1, waived: { imports: 1 } });
    expect(resumed.managedWrite).toBeUndefined();
    expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toBe('Beta, edited straight in the database.');
    expect((await engine.getPage('c', { sourceId: f.id }))?.compiled_truth).toBe(parsed.compiled_truth);
    expect((await engine.getPage('d', { sourceId: f.id }))?.compiled_truth).toContain('d two.');
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [f.id]);
    const hold = (await readGitHold(engine, f.id, source.incarnation, 'b.md'))!;
    expect(hold.meta).toMatchObject({ sides: 'both', page_revision: (await engine.readPageSnapshot('b', { sourceId: f.id }))!.revision, blob_oid: git(f.root, 'rev-parse', `${pin}:b.md`) });
    expect(resumed.held![0]!.fix.argv).toEqual(['gbrain', 'repair', 'file-drift', '--source', f.id, '--slug', 'b', '--prefer', 'database']);
    expect(await readGitHold(engine, f.id, source.incarnation, 'c.md')).toBeNull();
    const level = (await readShadowLevel(engine, { sourceId: f.id }))!;
    expect(level.paths.find(entry => entry.path === 'b.md')?.result).toMatchObject({ cls: 'held', settled: true });
    expect(level.paths.find(entry => entry.path === 'c.md')?.result).toMatchObject({ cls: 'matched', settled: true });
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
    // A page deleted in the database after an interrupted pass, whose file changed too, is held file_drift on its deleted
    // side and stays deleted; b's file moved again, so its hold is re-screened at the new level and held again.
    for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(f.root, `${name}.md`), note(`${name} three.`));
    const pin3 = commit(f.root, 'version three');
    await interruptedAfter(engine, f.opts, 1);
    await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => tx.softDeletePage('d', { sourceId: f.id }), TEST_WRITE_ATTRIBUTION));
    const third = await performManagedSync(engine, f.opts);
    expect(third).toMatchObject({ status: 'synced', toCommit: pin3 });
    expect(third.held?.map(hold => [hold.path, hold.code])).toEqual([['b.md', 'file_drift'], ['d.md', 'file_drift']]);
    expect(await readGitHold(engine, f.id, source.incarnation, 'd.md')).toMatchObject({ code: 'file_drift', meta: { side: 'deleted', state: 'tombstone_edited', blob_oid: git(f.root, 'rev-parse', `${pin3}:d.md`) } });
    expect(await readGitHold(engine, f.id, source.incarnation, 'b.md')).toMatchObject({ code: 'file_drift', meta: { sides: 'both', blob_oid: git(f.root, 'rev-parse', `${pin3}:b.md`) } });
    expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toBe('Beta, edited straight in the database.');
    expect(await engine.getPage('d', { sourceId: f.id })).toBeNull();
    expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toBe('Beta, edited straight in the database.');
    expect((await engine.getPage('c', { sourceId: f.id }))?.compiled_truth).toContain('c three.');
  }
}), 120_000);

// #6712 PR 4b: the same release path for a pinned-worktree conflict (no cursor to convert, nothing to rediscover). The
// --retry-failed pass holds the file worktree_dirty under its own receipt, the blocked receipt stays as it was, and each
// retry-held re-screen holds it again under a new receipt with the same code, counting attempts on the one hold row up to
// the needs_human threshold.
test('a pass blocked on a pinned-worktree conflict under sync.holds=fail is held worktree_dirty by the --retry-failed pass once holds are on, and each retry-held re-screen counts an attempt on the one hold', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': note('Alpha one.'), 'b.md': note('Beta one.'), 'c.md': note('Gamma one.') });
    expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
    for (const name of ['a', 'b', 'c']) writeFileSync(join(f.root, name + '.md'), note(name + ' two.'));
    const pin = commit(f.root, 'version two');
    const edit = note('Beta, an uncommitted edit.');
    writeFileSync(join(f.root, 'b.md'), edit);
    await engine.setConfig('sync.holds', 'fail');
    let blocked;
    try { blocked = await performManagedSync(engine, f.opts); } finally { await engine.executeRaw("DELETE FROM config WHERE key='sync.holds'"); }
    expect(blocked).toMatchObject({ status: 'blocked_by_failures', managedWrite: { write_error: 'source_changed', reason: 'pinned_git_worktree_conflict' }, pass: { outcome: 'blocked' } });
    expect(pinnedWorktreeConflict({ state: 'conflict', error_code: 'source_changed', error_message: 'Newer working-tree bytes and the current page disagree with this pinned Git import.' })).toBe(true);
    // The blocked pass stopped at b.md: c.md waits for the next pass.
    expect((await engine.getPage('c', { sourceId: f.id }))?.compiled_truth).toContain('Gamma one.');
    const unsettled = async () => (await receiptsOf(engine, f.id, 'b.md')).filter(row => row.state !== 'committed');
    const failed = await unsettled();
    expect(failed).toEqual([expect.objectContaining({ request_id: blocked.managedWrite!.write_request.request_id, state: 'conflict', error_code: 'source_changed', pass_id: blocked.pass!.pass_id })]);
    const held = await performManagedSync(engine, { ...f.opts, retryFailed: true });
    expect(held).toMatchObject({ status: 'synced', toCommit: pin, held_count: 1, held: [{ path: 'b.md', code: 'worktree_dirty' }], pass: { outcome: 'synced' } });
    expect((await engine.getPage('c', { sourceId: f.id }))?.compiled_truth).toContain('c two.');
    expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toContain('Beta one.');
    expect(readFileSync(join(f.root, 'b.md'), 'utf8')).toBe(edit);
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [f.id]);
    expect(await readGitHold(engine, f.id, source.incarnation, 'b.md')).toMatchObject({ code: 'worktree_dirty', run_id: held.pass!.pass_id, meta: { attempts: 1 } });
    expect(await unsettled()).toEqual([failed[0], expect.objectContaining({ state: 'conflict', error_code: 'source_changed', pass_id: held.pass!.pass_id })]);
    // Held again and again with the same code: the attempt count on the one hold reaches the needs_human threshold, each
    // re-screen under a receipt of its own pass, the earlier receipts unchanged.
    for (let round = 2; round <= HOLD_ATTEMPTS_NEEDS_HUMAN; round++) {
      const earlier = await unsettled();
      await requestGitHoldRetry(engine, f.id, source.incarnation, ['b.md']);
      const again = await performManagedSync(engine, f.opts);
      expect(again.held?.map(hold => hold.code)).toEqual(['worktree_dirty']);
      expect((await readGitHold(engine, f.id, source.incarnation, 'b.md'))?.meta.attempts).toBe(round);
      expect(await unsettled()).toEqual([...earlier, expect.objectContaining({ state: 'conflict', error_code: 'source_changed', pass_id: again.pass!.pass_id })]);
    }
    expect((await readGitSourceHolds(engine, { sourceIds: [f.id] }))[0]?.holds.map(hold => hold.path)).toEqual(['b.md']);
  }
}), 120_000);

test('a dropped database connection mid-pass leaves no failure-ledger row, and the relaunch finishes without re-importing what the dropped pass committed', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': note('Alpha one.'), 'b.md': note('Beta one.'), 'c.md': note('Gamma one.'), 'd.md': note('Delta one.') });
    expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
    for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(f.root, `${name}.md`), note(`${name} two.`));
    const pin = commit(f.root, 'version two');
    // The pooler drops the socket after the second page commits: the pass throws the raw socket error.
    const executeRaw = engine.executeRaw;
    let armed = false;
    engine.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
      if (armed && sql.includes("NOT(COALESCE(intent->>'kind','') LIKE 'managed_sync_%')")) { armed = false; throw Object.assign(new Error('write ECONNABORTED db.example.invalid:5432'), { code: 'ECONNABORTED' }); }
      return executeRaw.call(this, sql, params);
    } as BrainEngine['executeRaw'];
    let died: unknown;
    try {
      await performManagedSync(engine, { ...f.opts, onProgress: p => { if (p.phase === 'managed_sync.page_committed' && p.bankedFiles === 2) armed = true; } }).catch(error => { died = error; });
    } finally { engine.executeRaw = executeRaw; await disposePersistenceConsumer(engine); }
    expect(String((died as Error)?.message)).toContain('ECONNABORTED');
    // No failure-ledger row, and no unfinished cursor for the read view to report.
    expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-sync-failure' AND completed_keys::text LIKE $1", [`%${f.id}%`])).toEqual([]);
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
    expect(await cursorOf(engine, f.id)).toBeUndefined();
    const importsOf = async (path: string) => (await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'path'=$2 AND state='committed'", [f.id, path]))[0]!.n;
    // The dropped pass committed a and b (one import each since the first sync); c and d are still the first sync's.
    expect(await importsOf('a.md')).toBe(2); expect(await importsOf('b.md')).toBe(2);
    expect((await engine.getPage('c', { sourceId: f.id }))?.compiled_truth).toContain('Gamma one.');
    // With or without --retry-failed (the operator's loop passes it), the relaunch's pass imports only c and d, then the source is idle.
    for (const retryFailed of [true, false]) {
      const resumed = await performManagedSync(engine, { ...f.opts, retryFailed });
      if (retryFailed) expect(resumed).toMatchObject({ status: 'synced', toCommit: pin, modified: 2, pass: { kind: 'full', candidates: 2, outcome: 'synced' } });
      else expect(resumed).toMatchObject({ status: 'up_to_date', toCommit: pin });
    }
    for (const path of ['a.md', 'b.md', 'c.md', 'd.md']) expect(await importsOf(path)).toBe(2);
    for (const name of ['a', 'b', 'c', 'd']) expect((await engine.getPage(name, { sourceId: f.id }))?.compiled_truth).toContain(`${name} two.`);
  }
}), 120_000);

test('when HEAD moves past the pass\'s first level during the run, its next round reads the new HEAD and the drain ends there in one pass', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const { drainManagedSync } = await import('../src/core/persistence/sync-drain.ts');
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': note('Alpha one.'), 'b.md': note('Beta one.'), 'c.md': note('Gamma one.') });
    expect((await drainManagedSync(engine, f.opts, false)).drain).toMatchObject({ outcome: 'synced', written: 3 });
    for (const name of ['a', 'b', 'c']) writeFileSync(join(f.root, `${name}.md`), note(`${name} two.`));
    const pin = commit(f.root, 'version two');
    // Another agent commits d.md and a third version of c.md while the run drains its pinned manifest.
    let moved: string | null = null;
    const result = await drainManagedSync(engine, { ...f.opts, onProgress: p => {
      if (p.phase === 'managed_sync.page_committed' && p.bankedFiles === 1 && !moved) {
        writeFileSync(join(f.root, 'd.md'), note('Delta, committed during the run.')); writeFileSync(join(f.root, 'c.md'), note('c three, committed during the run.'));
        moved = commit(f.root, 'commits during the run');
      } } }, false);
    expect(moved).not.toBeNull();
    // #6712 PR 4b: each round reads the current HEAD, so the pass that started at pin imports the commits made under it.
    expect(pin).not.toBe(moved);
    expect(result).toMatchObject({ status: 'synced', toCommit: moved, drain: { outcome: 'synced', passes: 1 } });
    expect(result.drain?.extra_pass).toBeUndefined();
    expect((await engine.getPage('d', { sourceId: f.id }))?.compiled_truth).toContain('committed during the run');
    expect((await engine.getPage('c', { sourceId: f.id }))?.compiled_truth).toContain('c three');
    expect((await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(moved!);
    // Quiet checkout: no extra pass.
    const quiet = await drainManagedSync(engine, f.opts, false);
    expect(quiet.status).toBe('up_to_date'); expect(quiet.drain?.extra_pass).toBeUndefined();
  }
}), 120_000);

test('a file committed between admission and publication (raw_file_changed) is passed over and imported in a later round as HEAD has it; #6712: a file that keeps changing stops the pass not_converged after PASS_MAX_ROUNDS requests, unheld, and the next sync imports it', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': note('Alpha one.'), 'b.md': note('Beta one.'), 'c.md': note('Gamma one.') });
    expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
    for (const name of ['a', 'b', 'c']) writeFileSync(join(f.root, `${name}.md`), note(`${name} two.`));
    const pin = commit(f.root, 'version two');
    // Right after the pass admits b.md's import (its request row is inserted), another agent commits a newer version:
    // publication then finds the file's bytes changed after admission.
    const executeRaw = engine.executeRaw;
    let commits = 0, versions = 0;
    const armed = (sql: string, params?: unknown[]) => { const text = JSON.stringify(params ?? []).replaceAll('\\"', '"'); return sql.includes('INSERT INTO persistence_requests') && text.includes('"path":"b.md"') && text.includes('managed_sync_import'); };
    engine.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
      const rows = await executeRaw.call(this, sql, params);
      if (armed(sql, params) && commits < versions) { writeFileSync(join(f.root, 'b.md'), note(`b round ${versions} change ${commits}, committed after admission.`)); commit(f.root, `b moves after admission ${commits}`); commits++; }
      return rows;
    } as BrainEngine['executeRaw'];
    let seen = 0;
    /** b.md's import requests since the last call, as [state, error_message]. */
    const newRequests = async () => {
      const rows = await engine.executeRaw<{ state: string; error_message: string | null }>("SELECT state, error_message FROM persistence_requests WHERE source_id=$1 AND intent->>'path'='b.md' ORDER BY sequence", [f.id]);
      const fresh = rows.slice(seen).map(row => [row.state, row.error_message]); seen = rows.length;
      return fresh;
    };
    const CHANGED = ['conflict', 'The imported file changed after sync admission.'];
    try {
      await newRequests();
      versions = 1;
      const once = await performManagedSync(engine, { ...f.opts, noBulk: true });
      // #6712 PR 4b: the round after the refusal reads the new HEAD, so the pass ends at the commit it imported, past pin.
      expect(once).toMatchObject({ status: 'synced', toCommit: git(f.root, 'rev-parse', 'HEAD'), pass: { outcome: 'synced' } });
      expect(once.toCommit).not.toBe(pin);
      expect(once.held ?? []).toEqual([]);
      // One refused request, passed over; the next round imports the file as HEAD has it. No second refusal, no double import.
      expect(await newRequests()).toEqual([CHANGED, ['committed', null]]);
      expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toContain('b round 1 change 0');
      expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
      // #6712: a file that moves again under its next request is passed over again, and imported once it holds still.
      for (const name of ['a', 'b', 'c']) writeFileSync(join(f.root, `${name}.md`), note(`${name} four.`));
      commit(f.root, 'version four');
      commits = 0; versions = 2;
      const twice = await performManagedSync(engine, { ...f.opts, noBulk: true });
      expect(twice).toMatchObject({ status: 'synced', pass: { outcome: 'synced' } });
      expect(twice.held ?? []).toEqual([]);
      expect(commits).toBe(2);
      expect(await newRequests()).toEqual([CHANGED, CHANGED, ['committed', null]]);
      expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toContain('b round 2 change 1');
      // A file that moves under every request gets one per round: PASS_MAX_ROUNDS of them, then the pass stops not_converged.
      // It is not held, and the page keeps the last version it imported.
      for (const name of ['a', 'b', 'c']) writeFileSync(join(f.root, `${name}.md`), note(`${name} five.`));
      const pin5 = commit(f.root, 'version five');
      commits = 0; versions = PASS_MAX_ROUNDS + 1;
      const restless = await performManagedSync(engine, { ...f.opts, noBulk: true });
      // Its last round read the commit before the one made under that round's request.
      expect(restless.toCommit).not.toBe(pin5);
      expect(restless).toMatchObject({ status: 'partial', reason: 'not_converged', toCommit: git(f.root, 'rev-parse', 'HEAD~1'), pass: { round: PASS_MAX_ROUNDS, outcome: 'resumable', stop_reason: 'not_converged', not_converged_streak: 1 } });
      expect(restless.held_count ?? 0).toBe(0);
      expect(commits).toBe(PASS_MAX_ROUNDS);
      expect(await newRequests()).toEqual(Array.from({ length: PASS_MAX_ROUNDS }, () => CHANGED));
      expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toContain('b round 2 change 1');
      expect((await engine.getPage('a', { sourceId: f.id }))?.compiled_truth).toContain('a five.');
      // Once the file holds still, the next sync imports the latest commit.
      versions = 0;
      const settled = await performManagedSync(engine, { ...f.opts, noBulk: true });
      expect(settled).toMatchObject({ status: 'synced', modified: 1, pass: { outcome: 'synced' } });
      expect(await newRequests()).toEqual([['committed', null]]);
      expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toContain(`b round ${PASS_MAX_ROUNDS + 1} change ${PASS_MAX_ROUNDS - 1}`);
      expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
      const [row] = await engine.executeRaw<{ streak: number }>("SELECT (completed_keys->0->'obligations'->>'not_converged_streak')::int AS streak FROM op_checkpoints WHERE op='managed-sync-pass' AND completed_keys->0->>'source_id'=$1", [f.id]);
      expect(row?.streak).toBe(0);
      expect((await performManagedSync(engine, { ...f.opts, noBulk: true })).status).toBe('up_to_date');
    } finally { engine.executeRaw = executeRaw; await disposePersistenceConsumer(engine); }
  }
}), 120_000);
