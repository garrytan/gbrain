/**
 * #6340: the operator contract. `gbrain sync status --json` turns every hold and
 * the last error into `class` / `safe_actions` / `needs_human`, and
 * `gbrain sync unblock --apply` performs the safe action for each hold that has
 * one and refuses the rest by name. The classifier table and the runbook are
 * pinned to each other in `test/sync-runbook-table.test.ts`. Synthetic content.
 *
 * #6377 (T4): `unblock --apply` repairs an `invalid_fence` hold through the
 * `fences` kind of the content-repair lane on exactly that path, reports the
 * structured per-path outcome with its location-only receipt, schedules the
 * re-screen and prints the sync; a hold whose stored state needs a person (a
 * manual fence reason) is listed and never retried, and `sync status` says so;
 * `--no-llm` keeps the model-tier file held; `--no-repair` refuses every
 * repair-class hold as before. Sentinel claim text must never reach a hold,
 * an outcome, a receipt or a printed line.
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
import { readGitHoldRetryPaths, readGitHold, readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { runSyncUnblock } from '../src/commands/sync/operator.ts';
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

// #6377: fence fixtures (as test/repair-fences.test.ts builds them). Sentinel strings must never leave a file.
const CLAIM = 'Sentinelclaimub77 ships quarterly', HOLDER = 'Alice Example', MCLAIM = 'Sentinelmanualub77 opens an office';
const FB = '<!--- gbrain:facts:begin -->', FBE = '<!--- gbrain:facts:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const T = '<!--- gbrain:takes:begin -->', TE = '<!--- gbrain:takes:end -->';
const TH = '| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|';
const md = (title: string, body: string) => `---\ntitle: ${title}\n---\nA synthetic page.\n\n${body}`;
/** Tier 2: a display-name holder, resolved against people/alice-example. */
const holder = () => `${T}\n${TH}\n| 1 | Synthetic take | take | ${HOLDER} | 0.7 | 2026-01 | chat |\n${TE}\n`;
/** Manual: a visibility word with no mapping. */
const manual = () => `${FB}\n${FH}\n| 1 | ${MCLAIM} | fact | 0.9 | sideways | high | 2026-01-01 |  | chat | ctx |\n${FBE}\n`;
/** Tier 3: rows but no header. */
const noHeader = () => `${FB}\n| 1 | ${CLAIM} | fact | 0.9 | private | high | 2026-01-01 |  | chat | ctx |\n${FBE}\n`;
const expectNoSecrets = (value: unknown) => { const text = typeof value === 'string' ? value : JSON.stringify(value); for (const secret of ['Sentinelclaimub77', 'Sentinelmanualub77', HOLDER]) expect(text).not.toContain(secret); };

async function printed(run: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => { out.push(parts.join(' ')); };
  try { await run(); } finally { console.log = log; }
  return out.join('\n');
}

test('#6377: unblock --apply repairs an invalid_fence hold through the fences kind, lists structured outcomes, schedules the re-screen and prints the sync; a manual hold is listed, not retried; --no-llm and --no-repair', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_FENCE_REPAIR_SCAN_MS: '60000', OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, VOYAGE_API_KEY: undefined }, async () => {
  const f = await fixture({ 'a.md': note('Alpha one.') });
  mkdirSync(join(f.root, 'people'));
  writeFileSync(join(f.root, 'people/alice-example.md'), md('Alice Example', 'A synthetic person.\n'));
  commit(f.root, 'a person page');
  expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
  writeFileSync(join(f.root, 'people/holder.md'), md('Holder', holder()));
  writeFileSync(join(f.root, 'people/manual.md'), md('Manual', manual()));
  writeFileSync(join(f.root, 'people/model.md'), md('Model', noHeader()));
  commit(f.root, 'three malformed fences');
  const synced = await performManagedSync(engine, f.opts);
  expect(synced.held?.map(hold => [hold.path, hold.code, hold.reason]).sort()).toEqual([['people/holder.md', 'invalid_fence', 'holder_unresolved'], ['people/manual.md', 'invalid_fence', 'enum_unmapped'], ['people/model.md', 'invalid_fence', 'no_header']]);
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [f.id]);

  // status: the manual hold needs a person and says why; the other two are actionable, and next is the unblock apply naming the repairs.
  const status = await readSyncStatus(engine, f.id);
  const byPath = new Map(status.holds.map(hold => [hold.path, hold]));
  expect(byPath.get('people/manual.md')).toMatchObject({ code: 'invalid_fence', class: 'page', safe_actions: ['none'], needs_human: true });
  expect(byPath.get('people/manual.md')!.human_reason).toContain('enum_unmapped');
  expect(byPath.get('people/holder.md')).toMatchObject({ safe_actions: ['repair'], needs_human: false });
  expect(byPath.get('people/model.md')).toMatchObject({ safe_actions: ['repair'], needs_human: false });
  expect(status.needs_human).toBe(true);
  expectNoSecrets(status);

  // --no-repair: every repair-class hold is refused by name, as before #6377.
  const refuseOnly = await unblockSync(engine, f.id, { apply: true, noRepair: true });
  expect(refuseOnly.applied).toEqual([]);
  expect(refuseOnly.refused.map(entry => [entry.path, entry.needs_human]).sort()).toEqual([['people/holder.md', false], ['people/manual.md', true], ['people/model.md', false]]);
  expect(refuseOnly.refused.find(entry => entry.path === 'people/holder.md')!.reason).toContain('not something unblock performs');
  expect(await readGitHoldRetryPaths(engine, f.id, source.incarnation)).toEqual([]);

  // Preview: the two actionable holds would be repaired, the manual one is listed with its state; nothing is written.
  const preview = await unblockSync(engine, f.id, { apply: false });
  expect(preview.applied.map(entry => [entry.path, entry.action, entry.action === 'repair' ? entry.repair.outcome : null]).sort()).toEqual([['people/holder.md', 'repair', 'skipped'], ['people/model.md', 'repair', 'skipped']]);
  expect(preview.refused.map(entry => [entry.path, entry.needs_human])).toEqual([['people/manual.md', true]]);
  expect(preview.refused[0]!.reason).toContain('enum_unmapped');
  expect(preview.next).toMatchObject({ argv: ['gbrain', 'sync', 'unblock', '--source', f.id, '--apply', '--json'] });
  expect(preview.next!.why).toContain('hash-bound repairs');
  expect(await readGitHold(engine, f.id, source.incarnation, 'people/holder.md')).not.toBeNull();

  // --no-llm apply: the resolver repairs the holder file (receipt, re-screen scheduled, the sync printed); the model-tier file stays held llm_disabled; the manual one is listed, not retried.
  const applied = await unblockSync(engine, f.id, { apply: true, noLlm: true });
  const repaired = applied.applied.find(entry => entry.path === 'people/holder.md');
  expect(repaired).toMatchObject({ code: 'invalid_fence', action: 'repair', repair: { kind: 'fences', outcome: 'repaired', tier: 'resolver', receipt: { mode: 'managed', path: 'people/holder.md', tier: 'resolver', classes: 'holder_verified', hold_cleared: true, committed: 'queued' } } });
  expect(repaired!.action === 'repair' && repaired!.repair.next).toMatchObject({ argv: ['gbrain', 'sync', '--source', f.id, '--no-pull', '--no-embed', '--no-extract'] });
  const model = applied.applied.find(entry => entry.path === 'people/model.md');
  // The model-tier file was kept out of the plan (--no-llm); the kind recorded llm_disabled on its hold, and its next step is the hold's own paid fix.
  expect(model).toMatchObject({ action: 'repair', repair: { kind: 'fences', outcome: 'held', reason: 'llm_disabled', next: { argv: ['gbrain', 'config', 'set', 'fences.repair.llm', 'true'], consent: ['paid'] } } });
  expect(applied.refused.map(entry => entry.path)).toEqual(['people/manual.md']);
  expect(applied.next).toMatchObject({ argv: ['gbrain', 'sync', '--source', f.id, '--no-pull', '--no-embed', '--no-extract'] });
  expect(applied.next!.why).toContain('1 repaired by the content-repair lane');
  expect(await readGitHoldRetryPaths(engine, f.id, source.incarnation)).toEqual(['people/holder.md']);
  expect(readFileSync(join(f.root, 'people/holder.md'), 'utf8')).toContain('people/alice-example');
  expectNoSecrets(applied);
  const holdsAfter = (await readGitSourceHolds(engine, { sourceIds: [f.id] }))[0]!.holds;
  expect(holdsAfter.find(hold => hold.path === 'people/model.md')?.meta.fence_repair?.reason).toBe('llm_disabled');
  expect(holdsAfter.find(hold => hold.path === 'people/manual.md')?.meta.fence_repair).toBeUndefined();
  expectNoSecrets(holdsAfter);

  // The printed sync imports the repaired file; the hold set is the manual one and the model-tier one.
  const after = await performManagedSync(engine, f.opts);
  expect(after.status).toBe('synced');
  expect(await readGitHold(engine, f.id, source.incarnation, 'people/holder.md')).toBeNull();
  expect((await readSyncStatus(engine, f.id)).holds.map(hold => hold.path).sort()).toEqual(['people/manual.md', 'people/model.md']);

  // Idempotent: the second apply finds the model-tier hold in its recorded paid state (llm_disabled) and lists it beside the manual one; nothing is retried.
  const text = await printed(() => runSyncUnblock(engine, ['--source', f.id, '--apply', '--no-llm']));
  expect(text).toContain('0 held file(s) scheduled for a re-screen, 2 refused');
  expect(text).toContain('people/manual.md: invalid_fence refused');
  expect(text).toContain('people/model.md: invalid_fence refused');
  expect(text).toContain('llm_disabled');
  expect(text).toContain('NEEDS HUMAN');
  expectNoSecrets(text);
  expect(await readGitHoldRetryPaths(engine, f.id, source.incarnation)).toEqual([]);
  // --json renders each refusal's fix with its next verb (the paid setting asks the user).
  const json = JSON.parse(await printed(() => runSyncUnblock(engine, ['--source', f.id, '--no-llm', '--json']))) as { applied: unknown[]; refused: Array<{ path: string; fix: { next: string } }> };
  expect(json.applied).toEqual([]);
  expect(json.refused.find(entry => entry.path === 'people/model.md')?.fix.next).toBe('ask_user');
  expect(json.refused.find(entry => entry.path === 'people/manual.md')?.fix.next).toBe('run');
  expectNoSecrets(json);
}), 180_000);
