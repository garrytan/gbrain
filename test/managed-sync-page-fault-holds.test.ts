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
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readGitHold, readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { readManagedSyncFailures } from '../src/core/persistence/sync-failures.ts';
import { headCommittedBytes, HOLD_ATTEMPTS_NEEDS_HUMAN, pinnedWorktreeConflict } from '../src/core/persistence/sync-page-fault.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { loadSyncFailures } from '../src/core/sync-failure-ledger.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { contentHash } from '../src/core/utils.ts';

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
/** Counts the manifest identity freeze (`discoverManagedSync`'s one-statement page snapshot) for `sourceId`: zero means no rediscovery. */
function countDiscoveries(engine: BrainEngine, sourceId: string): { count: () => number; restore: () => void } {
  const executeRaw = engine.executeRaw;
  let reads = 0;
  engine.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
    if (params?.[0] === sourceId && sql.includes('SELECT id,slug,source_path,knowledge_revision FROM pages')) reads++;
    return executeRaw.call(this, sql, params);
  } as BrainEngine['executeRaw'];
  return { count: () => reads, restore: () => { engine.executeRaw = executeRaw; } };
}
const cursorOf = (engine: BrainEngine, sourceId: string) => engine.executeRaw<{ run_id: string; index: number; total: number; target: string; done: boolean | null }>(
  `SELECT completed_keys->0->>'runId' AS run_id,(completed_keys->0->>'index')::int AS index,(completed_keys->0->>'total')::int AS total,completed_keys->0->>'target' AS target,
     (completed_keys->0->>'done')::boolean AS done FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1`, [sourceId]).then(rows => rows[0]);
const dbWrite = (engine: BrainEngine, sourceId: string, slug: string, body: string) => engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.putPage(slug, {
  type: 'note', title: 'Example', compiled_truth: body, timeline: '', frontmatter: {}, content_hash: `h-${body.length}` }, { sourceId }), TEST_WRITE_ATTRIBUTION));
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

test('a resumed cursor imports a page committed past its pinned target instead of refusing it (#6320, from PR #6323)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': note('First observation, version one.'), 'b.md': note('Second observation, version one.') });
    expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
    writeFileSync(join(f.root, 'a.md'), note('First observation, version two.')); writeFileSync(join(f.root, 'b.md'), note('Second observation, version two.'));
    const pin = commit(f.root, 'version two of both');
    await interruptedAfter(engine, f.opts, 1);
    // A live checkout keeps committing while the cursor drains: b.md moves past the pin.
    writeFileSync(join(f.root, 'b.md'), note('Second observation, version three.')); const head = commit(f.root, 'version three of b, past the pin');
    expect(headCommittedBytes({ root: f.root, gitRoot: f.root }, 'b.md')).toMatchObject({ oid: git(f.root, 'rev-parse', 'HEAD:b.md') });
    const resumed = await performManagedSync(engine, f.opts);
    expect(resumed).toMatchObject({ status: 'synced', toCommit: pin }); expect(resumed.held_count ?? 0).toBe(0); expect(resumed.managedWrite).toBeUndefined();
    expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toContain('version three');
    expect(readFileSync(join(f.root, 'b.md'), 'utf8')).toBe(note('Second observation, version three.'));
    expect(git(f.root, 'status', '--porcelain')).toBe('');
    const next = await performManagedSync(engine, f.opts);
    expect(next).toMatchObject({ toCommit: head, status: 'synced', modified: 0, waived: { imports: 1, deletes: 0 } });
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

test('a page edited in the database after the manifest froze is held concurrent_write with its revisions; one that already holds the import is re-bound and waived', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': note('Alpha one.'), 'b.md': note('Beta one.'), 'c.md': note('Gamma one.'), 'd.md': note('Delta one.') });
    expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
    for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(f.root, `${name}.md`), note(`${name} two.`));
    const pin = commit(f.root, 'version two');
    await interruptedAfter(engine, f.opts, 1);
    const frozen = await cursorOf(engine, f.id);
    // b: a database-only edit that diverges from the file; c: a database write that already carries exactly what the file would import.
    await dbWrite(engine, f.id, 'b', 'Beta, edited straight in the database.');
    const parsed = parseMarkdown(note('c two.'), 'c.md');
    const page = { type: parsed.type, title: parsed.title, compiled_truth: parsed.compiled_truth, timeline: parsed.timeline ?? '', frontmatter: parsed.frontmatter };
    await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => tx.putPage('c', { ...page, content_hash: contentHash(page) }, { sourceId: f.id }), TEST_WRITE_ATTRIBUTION));
    const resumed = await performManagedSync(engine, f.opts);
    expect(resumed).toMatchObject({ status: 'synced', toCommit: pin, held_count: 1, held: [{ path: 'b.md', code: 'concurrent_write' }] });
    expect(resumed.managedWrite).toBeUndefined();
    expect((await cursorOf(engine, f.id))?.run_id).toBe(frozen.run_id);
    expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toBe('Beta, edited straight in the database.');
    expect((await engine.getPage('c', { sourceId: f.id }))?.compiled_truth).toBe(parsed.compiled_truth);
    expect((await engine.getPage('d', { sourceId: f.id }))?.compiled_truth).toContain('d two.');
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [f.id]);
    const hold = (await readGitHold(engine, f.id, source.incarnation, 'b.md'))!;
    expect(hold.meta.page_revision).toBeDefined(); expect(hold.meta.expected_revision).toBeDefined();
    expect(hold.meta.page_revision).not.toBe(hold.meta.expected_revision);
    expect(resumed.held![0]!.fix.argv).toEqual(['gbrain', 'sources', 'reconcile', f.id, 'b', '--preview']);
    expect(await readGitHold(engine, f.id, source.incarnation, 'c.md')).toBeNull();
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
    // A page deleted in the database after the freeze holds the same way; the page stays deleted.
    for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(f.root, `${name}.md`), note(`${name} three.`));
    const pin3 = commit(f.root, 'version three');
    await interruptedAfter(engine, f.opts, 1);
    await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => tx.softDeletePage('d', { sourceId: f.id }), TEST_WRITE_ATTRIBUTION));
    const third = await performManagedSync(engine, f.opts);
    expect(third).toMatchObject({ status: 'synced', toCommit: pin3 });
    expect(third.held?.map(hold => [hold.path, hold.code])).toEqual([['d.md', 'concurrent_write']]);
    expect(await engine.getPage('d', { sourceId: f.id })).toBeNull();
  }
}), 120_000);

test('a cursor an older run left blocked on a pinned-worktree conflict converts in place under --retry-failed instead of rediscovering, and counts attempts', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': note('Alpha one.'), 'b.md': note('Beta one.'), 'c.md': note('Gamma one.') });
    expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
    for (const name of ['a', 'b', 'c']) writeFileSync(join(f.root, `${name}.md`), note(`${name} two.`));
    commit(f.root, 'version two');
    const edit = note('Beta, an uncommitted edit.');
    writeFileSync(join(f.root, 'b.md'), edit);
    // The brain ran the old release: holds off, so the conflict blocked the run and left the failed request on the cursor.
    await engine.setConfig('sync.holds', 'fail');
    let blocked;
    try { blocked = await performManagedSync(engine, f.opts); } finally { await engine.executeRaw("DELETE FROM config WHERE key='sync.holds'"); }
    expect(blocked).toMatchObject({ status: 'blocked_by_failures', managedWrite: { write_error: 'source_changed', reason: 'pinned_git_worktree_conflict' } });
    expect(pinnedWorktreeConflict({ state: 'conflict', error_code: 'source_changed', error_message: 'Newer working-tree bytes and the current page disagree with this pinned Git import.' })).toBe(true);
    const before = await cursorOf(engine, f.id);
    expect(before).toMatchObject({ index: 1, total: 3 }); expect(before.done).toBeFalsy();
    // Upgraded: the operator's loop reruns with --retry-failed. The cursor converts in place (same run), nothing is rediscovered.
    const discoveries = countDiscoveries(engine, f.id);
    let converted;
    try { converted = await performManagedSync(engine, { ...f.opts, retryFailed: true }); }
    finally { discoveries.restore(); }
    expect(discoveries.count()).toBe(0);
    expect(converted).toMatchObject({ status: 'synced', held_count: 1, held: [{ path: 'b.md', code: 'worktree_dirty' }], converted_from_failed: [blocked.managedWrite!.write_request.request_id] });
    expect((await cursorOf(engine, f.id))?.run_id).toBe(before.run_id);
    expect((await engine.getPage('c', { sourceId: f.id }))?.compiled_truth).toContain('c two.');
    expect(readFileSync(join(f.root, 'b.md'), 'utf8')).toBe(edit);
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
    // Held again and again with the same code: the attempt count reaches the needs_human threshold.
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [f.id]);
    for (let round = 2; round <= HOLD_ATTEMPTS_NEEDS_HUMAN; round++) {
      const { requestGitHoldRetry } = await import('../src/core/persistence/sync-holds.ts');
      await requestGitHoldRetry(engine, f.id, source.incarnation, ['b.md']);
      const again = await performManagedSync(engine, f.opts);
      expect(again.held?.map(hold => hold.code)).toEqual(['worktree_dirty']);
      expect((await readGitHold(engine, f.id, source.incarnation, 'b.md'))?.meta.attempts).toBe(round);
    }
    expect((await readGitSourceHolds(engine, { sourceIds: [f.id] }))[0]?.holds.map(hold => hold.path)).toEqual(['b.md']);
  }
}), 120_000);

test('a dropped database connection mid-run leaves no failure-ledger row, and the relaunch resumes the same run at the stored index without discovery', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
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
    // No failure-ledger row (the read view still reports the unfinished cursor as `sync_incomplete`, which is not a recorded failure).
    expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-sync-failure' AND completed_keys::text LIKE $1", [`%${f.id}%`])).toEqual([]);
    expect((await readManagedSyncFailures(engine, [f.id])).map(row => row.code)).toEqual(['sync_incomplete']);
    const stored = await cursorOf(engine, f.id);
    expect(stored).toMatchObject({ target: pin }); expect(stored.done).toBeFalsy();
    expect(stored.index).toBeGreaterThanOrEqual(2);
    // With or without --retry-failed (the operator's loop passes it), the relaunch resumes the stored run: no rediscovery.
    for (const retryFailed of [true, false]) {
      const discoveries = countDiscoveries(engine, f.id);
      try {
        const resumed = await performManagedSync(engine, { ...f.opts, retryFailed });
        expect(resumed.status).toBe(retryFailed ? 'synced' : 'up_to_date');
        if (retryFailed) { expect(resumed).toMatchObject({ runId: stored.run_id, toCommit: pin }); expect(discoveries.count()).toBe(0); }
      } finally { discoveries.restore(); }
    }
    expect((await engine.getPage('d', { sourceId: f.id }))?.compiled_truth).toContain('d two.');
  }
}), 120_000);

test('when HEAD moves past the pinned target during the run, the drain takes exactly one more pass and ends at HEAD', async () => withEnv({ GBRAIN_HOME: home }, async () => {
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
    expect(result).toMatchObject({ status: 'synced', toCommit: moved, drain: { outcome: 'synced', extra_pass: { from: pin, to: moved } } });
    expect(result.drain!.passes).toBeGreaterThanOrEqual(2);
    expect((await engine.getPage('d', { sourceId: f.id }))?.compiled_truth).toContain('committed during the run');
    expect((await engine.getPage('c', { sourceId: f.id }))?.compiled_truth).toContain('c three');
    expect((await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(moved!);
    // Quiet checkout: no extra pass.
    const quiet = await drainManagedSync(engine, f.opts, false);
    expect(quiet.status).toBe('up_to_date'); expect(quiet.drain?.extra_pass).toBeUndefined();
  }
}), 120_000);

test('a file committed between admission and publication (raw_file_changed) is re-frozen once and imported as HEAD has it; a file that changes again is held', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': note('Alpha one.'), 'b.md': note('Beta one.'), 'c.md': note('Gamma one.') });
    expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
    for (const name of ['a', 'b', 'c']) writeFileSync(join(f.root, `${name}.md`), note(`${name} two.`));
    const pin = commit(f.root, 'version two');
    // The admission transaction's last statement re-checks the cursor still holds this entry (ENG-A7). Right after it, for b.md,
    // another agent commits version three: publication then finds the file's bytes changed after admission.
    const executeRaw = engine.executeRaw;
    let commits = 0, versions = 0;
    const armed = (sql: string, params?: unknown[]) => sql.includes("completed_keys->0->'pending'->>'requestId' AS request_id") && sql.includes('FOR SHARE') && String(params?.[2] ?? '').includes('"path":"b.md"');
    engine.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
      const rows = await executeRaw.call(this, sql, params);
      if (armed(sql, params) && commits < versions) { writeFileSync(join(f.root, 'b.md'), note(`b round ${versions} change ${commits}, committed after admission.`)); commit(f.root, `b moves after admission ${commits}`); commits++; }
      return rows;
    } as BrainEngine['executeRaw'];
    try {
      versions = 1;
      const once = await performManagedSync(engine, { ...f.opts, noBulk: true });
      expect(once).toMatchObject({ status: 'synced', toCommit: pin });
      expect(once.held ?? []).toEqual([]);
      expect(once.converted_from_failed).toHaveLength(1);
      expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toContain('b round 1 change 0');
      expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
      // A file that moves again under its re-frozen request is held (never a third request for the same entry).
      for (const name of ['a', 'b', 'c']) writeFileSync(join(f.root, `${name}.md`), note(`${name} four.`));
      const pin4 = commit(f.root, 'version four');
      commits = 0; versions = 2;
      const twice = await performManagedSync(engine, { ...f.opts, noBulk: true });
      expect(twice).toMatchObject({ status: 'synced', toCommit: pin4, held_count: 1, held: [{ path: 'b.md', code: 'worktree_dirty' }] });
      expect(commits).toBe(2);
      expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toContain('b round 1 change 0');
      // The next sync re-screens the hold (the blob at HEAD differs from the hold's) and imports the latest commit.
      const settled = await performManagedSync(engine, { ...f.opts, noBulk: true });
      expect(settled.status).toBe('synced');
      expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toContain('b round 2 change 1');
      expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
    } finally { engine.executeRaw = executeRaw; await disposePersistenceConsumer(engine); }
  }
}), 120_000);
