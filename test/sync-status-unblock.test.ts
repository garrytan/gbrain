/**
 * #6340: the operator contract. `gbrain sync status --json` turns every hold and
 * the last error into `class` / `safe_actions` / `needs_human`, and
 * `gbrain sync unblock --apply` performs the safe action for each hold that has
 * one and refuses the rest by name. The classifier table and the runbook are
 * pinned to each other in `test/sync-runbook-table.test.ts`. Synthetic content.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus, unblockSync } from '../src/core/persistence/sync-status.ts';
import { classifySyncFault, HOLD_ATTEMPTS_NEEDS_HUMAN, SYNC_FAULT_TABLE } from '../src/core/persistence/sync-fault-class.ts';
import { readGitHoldRetryPaths, readGitHold } from '../src/core/persistence/sync-holds.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-sync-status-'));
let engine: BrainEngine;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); };
const note = (body: string) => `---\ntitle: Example\n---\n${body}\n`;
async function fixture(files: Record<string, string>) {
  const id = `st-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) writeFileSync(join(root, path), body);
  commit(root, 'fixture');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, opts: { sourceId: id, noPull: true, noEmbed: true, noExtract: true } };
}

beforeAll(async () => { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('the classifier: every table code has a class and at least one safe action; attempts exhaust a page code into needs_human; unknown codes are systemic and human', () => {
  for (const rule of SYNC_FAULT_TABLE) {
    expect(['page', 'connection', 'systemic']).toContain(rule.class);
    expect(rule.safe_actions.length).toBeGreaterThan(0);
    if (rule.needs_human) expect(rule.human_reason).toBeDefined();
    const verdict = classifySyncFault({ code: rule.code });
    expect(verdict).toMatchObject({ class: rule.class, safe_actions: rule.safe_actions, needs_human: rule.needs_human });
  }
  expect(classifySyncFault({ code: 'worktree_dirty', attempts: 1 })).toMatchObject({ class: 'page', safe_actions: ['retry_when_clean'], needs_human: false });
  expect(classifySyncFault({ code: 'worktree_dirty', attempts: HOLD_ATTEMPTS_NEEDS_HUMAN })).toMatchObject({ class: 'page', safe_actions: ['none'], needs_human: true });
  expect(classifySyncFault({ code: 'worktree_dirty', attempts: HOLD_ATTEMPTS_NEEDS_HUMAN }).human_reason).toContain(`held ${HOLD_ATTEMPTS_NEEDS_HUMAN} times`);
  expect(classifySyncFault({ code: 'concurrent_write' })).toMatchObject({ class: 'page', safe_actions: ['reconcile'], needs_human: true });
  expect(classifySyncFault({ code: 'source_changed', detail: 'pinned_git_worktree_conflict' })).toMatchObject({ class: 'page', safe_actions: ['retry'], needs_human: false });
  expect(classifySyncFault({ code: 'storage_error', message: 'write ECONNABORTED db.example.invalid:5432' })).toMatchObject({ class: 'connection', safe_actions: ['retry'], needs_human: false });
  expect(classifySyncFault({ code: 'connection_lost' })).toMatchObject({ class: 'connection', needs_human: false });
  expect(classifySyncFault({ code: 'preparation_systemic' })).toMatchObject({ class: 'systemic', needs_human: true });
  expect(classifySyncFault({ code: 'something_new' })).toMatchObject({ class: 'systemic', safe_actions: ['none'], needs_human: true });
  expect(classifySyncFault({ code: 'something_new' }).human_reason).toContain('gbrain errors something_new');
});

test('status joins the cursor, the recent commits, each hold with its triple and one next; unblock schedules a committed dirty file, refuses a still-dirty one and a concurrent write by name', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const f = await fixture({ 'a.md': note('Alpha one.'), 'b.md': note('Beta one.'), 'c.md': note('Gamma one.'), 'd.md': note('Delta one.') });
  expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
  const clean = await readSyncStatus(engine, f.id);
  expect(clean).toMatchObject({ source_id: f.id, cursor: { index: 4, total: 4, done: true }, holds: [], last_error: null, needs_human: false, next: null });
  expect(clean.committed_last_10m).toBe(4);
  expect(clean.resume_argv).toEqual(['--source', f.id, '--no-pull', '--no-embed', '--no-extract']);
  for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(f.root, `${name}.md`), note(`${name} two.`));
  const pin = commit(f.root, 'version two');
  const abort = new AbortController();
  expect(await performManagedSync(engine, { ...f.opts, signal: abort.signal, onProgress: p => { if (p.bankedFiles === 1) abort.abort(); } })).toMatchObject({ status: 'partial', filesImported: 1 });
  // b and c: uncommitted edits; d: a database-only edit.
  writeFileSync(join(f.root, 'b.md'), note('Beta, edited and not committed.'));
  writeFileSync(join(f.root, 'c.md'), note('Gamma, edited and not committed.'));
  await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => tx.putPage('d', { type: 'note', title: 'Example', compiled_truth: 'Delta, edited in the database.', timeline: '', frontmatter: {}, content_hash: 'd-db' }, { sourceId: f.id }), TEST_WRITE_ATTRIBUTION));
  const resumed = await performManagedSync(engine, f.opts);
  expect(resumed.status).toBe('synced');
  expect(resumed.held?.map(hold => [hold.path, hold.code]).sort()).toEqual([['b.md', 'worktree_dirty'], ['c.md', 'worktree_dirty'], ['d.md', 'concurrent_write']]);

  const status = await readSyncStatus(engine, f.id);
  expect(status.cursor).toMatchObject({ index: 4, total: 4, pinned_target: pin, done: true });
  expect(status.holds.map(hold => ({ path: hold.path, code: hold.code, class: hold.class, safe_actions: hold.safe_actions, needs_human: hold.needs_human, attempts: hold.attempts })).sort((x, y) => x.path.localeCompare(y.path))).toEqual([
    { path: 'b.md', code: 'worktree_dirty', class: 'page', safe_actions: ['retry_when_clean'], needs_human: false, attempts: 1 },
    { path: 'c.md', code: 'worktree_dirty', class: 'page', safe_actions: ['retry_when_clean'], needs_human: false, attempts: 1 },
    { path: 'd.md', code: 'concurrent_write', class: 'page', safe_actions: ['reconcile'], needs_human: true, attempts: 1 },
  ]);
  expect(status.needs_human).toBe(true);
  expect(status.human_reason).toContain('reconcile');
  expect(status.next).toMatchObject({ argv: ['gbrain', 'sources', 'reconcile', f.id, 'd', '--preview'] });
  expect(status.next!.user_message).toContain('page d');
  expect(JSON.stringify(status)).not.toContain('edited and not committed');

  // The agent commits b; c stays dirty. Preview writes nothing; apply schedules b only and refuses c and d by name.
  git(f.root, 'add', 'b.md'); git(f.root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'b committed');
  expect(git(f.root, 'status', '--porcelain')).toMatch(/^ ?M c\.md$/);
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [f.id]);
  const preview = await unblockSync(engine, f.id, { apply: false });
  expect(preview.applied.map(entry => [entry.path, entry.action])).toEqual([['b.md', 'retry_when_clean']]);
  expect(preview.refused.map(entry => [entry.path, entry.code, entry.needs_human]).sort()).toEqual([['c.md', 'worktree_dirty', false], ['d.md', 'concurrent_write', true]]);
  expect(preview.refused.find(entry => entry.path === 'c.md')!.reason).toContain('still_dirty');
  expect(preview.next).toMatchObject({ argv: ['gbrain', 'sync', 'unblock', '--source', f.id, '--apply', '--json'] });
  expect(await readGitHoldRetryPaths(engine, f.id, source.incarnation)).toEqual([]);
  const applied = await unblockSync(engine, f.id, { apply: true });
  expect(applied.applied.map(entry => entry.path)).toEqual(['b.md']);
  expect(applied.next).toMatchObject({ argv: ['gbrain', 'sync', '--source', f.id, '--no-pull', '--no-embed', '--no-extract'] });
  expect(await readGitHoldRetryPaths(engine, f.id, source.incarnation)).toEqual(['b.md']);
  // Idempotent.
  await unblockSync(engine, f.id, { apply: true });
  expect(await readGitHoldRetryPaths(engine, f.id, source.incarnation)).toEqual(['b.md']);
  // The sync it names imports b, keeps c held, keeps d held; status then points the agent at d's human step only.
  const after = await performManagedSync(engine, f.opts);
  expect(after.status).toBe('synced');
  expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toContain('edited and not committed');
  expect(await readGitHold(engine, f.id, source.incarnation, 'b.md')).toBeNull();
  expect(readFileSync(join(f.root, 'c.md'), 'utf8')).toContain('Gamma, edited and not committed');
  const again = await readSyncStatus(engine, f.id);
  expect(again.holds.map(hold => hold.path).sort()).toEqual(['c.md', 'd.md']);
  expect(again.needs_human).toBe(true);
  // With d reconciled away, status would hand the loop the unblock command for c once it is committed.
  const noHuman = again.holds.filter(hold => !hold.needs_human);
  expect(noHuman.map(hold => hold.path)).toEqual(['c.md']);
}), 120_000);

test('status reports an older release\'s recorded failure as a retryable page fault with --retry-failed as next', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  const f = await fixture({ 'a.md': note('Alpha one.'), 'b.md': note('Beta one.') });
  expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
  writeFileSync(join(f.root, 'a.md'), note('Alpha two.')); writeFileSync(join(f.root, 'b.md'), note('Beta two.'));
  commit(f.root, 'version two');
  writeFileSync(join(f.root, 'b.md'), note('Beta, uncommitted.'));
  await engine.setConfig('sync.holds', 'fail');
  try { expect((await performManagedSync(engine, f.opts)).status).toBe('blocked_by_failures'); }
  finally { await engine.executeRaw("DELETE FROM config WHERE key='sync.holds'"); }
  const status = await readSyncStatus(engine, f.id);
  expect(status.cursor).toMatchObject({ index: 1, total: 2, done: false });
  expect(status.last_error).toMatchObject({ code: 'source_changed', class: 'page', safe_actions: ['retry'], needs_human: false, path: 'b.md', phase: 'receipt' });
  expect(status.needs_human).toBe(false);
  expect(status.next).toMatchObject({ argv: ['gbrain', 'sync', '--source', f.id, '--no-pull', '--no-embed', '--no-extract', '--retry-failed'] });
  const converted = await performManagedSync(engine, { ...f.opts, retryFailed: true });
  expect(converted).toMatchObject({ status: 'synced', held: [{ path: 'b.md', code: 'worktree_dirty' }] });
  expect((await readSyncStatus(engine, f.id)).last_error).toBeNull();
}), 120_000);
