/**
 * GBRA-217 lane A2: page change reasons mirrored from Git trailers by sync (A6), and purge's reach into them (A7).
 *
 * 1. Protects: a sync stamps each archived snapshot with the reason its newest first-parent commit gives for the file
 *    (`gbrain-reason: <path>: <text>`), never an older reason on newer text and never a side-branch commit's; a failed or
 *    capped trailer scan still imports content, stores NULL, marks the gap and says so; a purge redacts a quoted claim in
 *    every reason copy (snapshots, queued and retained Git effects) and tombstones the pushed commit so no re-import
 *    brings it back, refusing before it deletes anything when it cannot read the history. A repo-less brain (the default
 *    keyless install) gets reasons and purge with no refusal, no notice and no gap marker.
 * 2. Fails when: a reason lands on the wrong snapshot, a malformed or secret trailer is stored, a scan failure blocks
 *    content or is silent, a purge leaves a reason copy, a tombstoned reason returns on a cold re-import, or a repo-less
 *    source refuses or is marked.
 * 3. Real temp Git repositories, the real classic and managed sync, the real purge_fact handler; PGLite, plus Postgres
 *    when DATABASE_URL is set. The only seams are the scan caps and a failing Git runner (reason-trailers.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { operations } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { admitWrite, completeWrite } from '../src/core/persistence/journal.ts';
import { requestPrincipalForContext } from '../src/core/persistence/page-mutations.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { runSources } from '../src/commands/sources.ts';
import { performSync, type SyncResult } from '../src/commands/sync.ts';
import { runImport } from '../src/commands/import.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { __setReasonGitStreamForTests, __setReasonScanCapsForTests, clearReasonScanCache, gitTopLevel, importHistoryFor, scanSyncReasons,
  scanTrailersCarrying } from '../src/core/reason-trailers.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-reason-trailers-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
let serial = 0;

const page = (body: string) => `---\ntitle: Note\ntype: note\n---\n\n${body}\n`;
const SECRET = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const failingGit = async () => ({ ok: false as const, reason: 'timeout' as const });

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(root: string, files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), body); }
}
function commit(root: string, message: string, reasons: string[] = []): string {
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-q', '-m', message,
    ...reasons.flatMap(reason => ['--trailer', `gbrain-reason: ${reason}`]));
  return git(root, 'rev-parse', 'HEAD');
}
function newRepo(files: Record<string, string>): string {
  const root = join(home, `repo-${++serial}`);
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Example');
  git(root, 'config', 'user.email', 'example@example.invalid');
  write(root, files);
  commit(root, 'initial content');
  return root;
}

type Source = { id: string; root: string };
async function classicSource(engine: BrainEngine, files: Record<string, string>): Promise<Source> {
  const id = `rt-${++serial}`;
  const root = newRepo(files);
  await runSources(engine, ['add', id, '--path', root, '--no-federated']);
  return { id, root };
}
const sync = (engine: BrainEngine, source: Source): Promise<SyncResult> =>
  performSync(engine, { repoPath: source.root, sourceId: source.id, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });

async function reasonsOf(engine: BrainEngine, sourceId: string, slug: string): Promise<{ reasons: Array<string | null>; gap: boolean }> {
  const rows = await engine.executeRaw<{ reason: string | null }>(`SELECT v.change_reason AS reason FROM page_versions v JOIN pages p ON p.id = v.page_id
    WHERE p.source_id = $1 AND p.slug = $2 ORDER BY v.id`, [sourceId, slug]);
  const [mark] = await engine.executeRaw<{ gap: boolean }>('SELECT version_history_gap_at IS NOT NULL AS gap FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]);
  return { reasons: rows.map(row => row.reason), gap: mark?.gap ?? false };
}
async function bodyOf(engine: BrainEngine, sourceId: string, slug: string): Promise<string> {
  const [row] = await engine.executeRaw<{ body: string }>('SELECT compiled_truth AS body FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]);
  return row?.body ?? '';
}
const codes = (result: SyncResult) => (result.reason_notices ?? []).map(notice => notice.code);

const ctx = (engine: BrainEngine, sourceId: string): OperationContext => ({ engine, sourceId, remote: false, dryRun: false,
  config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} } } as OperationContext);
const opNamed = (name: string) => operations.find(o => o.name === name)!;
const run = (engine: BrainEngine, sourceId: string, name: string, params: Record<string, unknown>) =>
  opNamed(name).handler(ctx(engine, sourceId), params) as Promise<Record<string, any>>;

const factFence = (claim: string) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->`;
/** A database-only page holding the claim as a fact, so purge_fact has a target in the source. */
async function seedFact(engine: BrainEngine, sourceId: string, slug: string, claim: string): Promise<number> {
  await importFromContent(engine, slug, `---\ntitle: Holder\ntype: person\n---\n# Holder\n\nProse.\n\n## Facts\n\n${factFence(claim)}\n`, { noEmbed: true, sourceId });
  await runExtractFacts(engine, { slugs: [slug], sourceId });
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact = $1 AND entity_slug = $2', [claim, slug]);
  return Number(row!.id);
}
/** A committed journal request in the source, for Git effects to hang off. */
async function committedRequest(engine: BrainEngine, sourceId: string): Promise<string> {
  const c = ctx(engine, sourceId);
  const slug = `notes/effect-example-${++serial}`;
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id = $1', [sourceId]);
  const admitted = await admitWrite(engine, { principal: await requestPrincipalForContext(c), operation: 'remember', sourceId, sourceIncarnation: source!.incarnation,
    slug, requestId: randomUUID(), callerIntent: { note: 'effect' }, intent: { note: 'effect' },
    authority: await submissionAuthority(c, 'remember', sourceId, source!.incarnation, slug) });
  await engine.transaction(tx => completeWrite(tx, admitted, 'committed', { status: 'inserted' }));
  return admitted.id;
}
async function gitEffect(engine: BrainEngine, sourceId: string, state: string, data: Record<string, unknown>): Promise<string> {
  const [row] = await engine.executeRaw<{ id: string }>(`INSERT INTO persistence_effects(request_id, kind, data, state, source_id, source_incarnation)
    SELECT $1::uuid, 'git', $2::text::jsonb, $3, s.id, s.incarnation FROM sources s WHERE s.id = $4 RETURNING id::text AS id`,
  [await committedRequest(engine, sourceId), JSON.stringify(data), state, sourceId]);
  return row!.id;
}
async function purge(engine: BrainEngine, sourceId: string, id: number, extra: Record<string, unknown> = {}) {
  const dry = await run(engine, sourceId, 'purge_fact', { id, source_id: sourceId, dry_run: true });
  return run(engine, sourceId, 'purge_fact', { id, source_id: sourceId, confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID(), ...extra });
}
async function refusal(p: Promise<unknown>): Promise<Record<string, any>> {
  try { await p; } catch (error) { if (error instanceof OperationError) return error.toJSON() as Record<string, any>; throw error; }
  throw new Error('expected a refusal');
}

const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);

beforeAll(async () => inHome(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) await registerLocalWriter(engine, 'cli');
}), 180_000);
afterEach(() => { __setReasonScanCapsForTests(); __setReasonGitStreamForTests(); clearReasonScanCache(); });
afterAll(async () => {
  await inHome(async () => { for (const engine of engines) await disposePersistenceConsumer(engine).catch(() => undefined); });
  await engines[0]?.disconnect();
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

describe('A6: sync mirrors gbrain-reason trailers', () => {
  test('an outside commit\'s reason lands on the archived snapshot; malformed and secret trailers store nothing', async () => inHome(async () => {
    for (const engine of engines) {
      const s = await classicSource(engine, { 'notes/a.md': page('Edition one.'), 'notes/b.md': page('B one.'), 'notes/c.md': page('C one.') });
      expect((await sync(engine, s)).status).toBe('first_sync');
      write(s.root, { 'notes/a.md': page('Edition two.'), 'notes/b.md': page('B two.'), 'notes/c.md': page('C two.') });
      const head = commit(s.root, 'edit from outside gbrain', ['notes/a.md: Client asked for the 30-day window.',
        'notes/missing.md: Names a file this commit never touched.', `notes/b.md: rotated token ${SECRET}`]);
      const result = await sync(engine, s);

      expect(await reasonsOf(engine, s.id, 'notes/a')).toEqual({ reasons: ['Client asked for the 30-day window.'], gap: false });
      expect(await reasonsOf(engine, s.id, 'notes/b')).toEqual({ reasons: [null], gap: false });
      expect(await reasonsOf(engine, s.id, 'notes/c')).toEqual({ reasons: [null], gap: false });
      expect(result.reason_trailers_malformed).toBe(1);
      expect(codes(result)).toEqual(['reason_trailer_secret']);
      const notice = result.reason_notices![0]!;
      expect(notice.why).toContain(`${head.slice(0, 12)} notes/b.md`);
      expect(notice.why).toContain('rotate the credential');
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(JSON.stringify(await engine.executeRaw('SELECT change_reason FROM page_versions'))).not.toContain(SECRET);
    }
  }), 120_000);

  test('the newest commit in the range decides: an unannotated edit gives NULL, three edits give the third; both mark the gap', async () => inHome(async () => {
    for (const engine of engines) {
      const s = await classicSource(engine, { 'notes/a.md': page('A one.'), 'notes/c.md': page('C one.') });
      await sync(engine, s);
      write(s.root, { 'notes/a.md': page('A two.'), 'notes/c.md': page('C two.') });
      commit(s.root, 'first', ['notes/a.md: Annotated edit.', 'notes/c.md: First reason.']);
      write(s.root, { 'notes/a.md': page('A three.'), 'notes/c.md': page('C three.') });
      commit(s.root, 'second', ['notes/c.md: Second reason.']);
      write(s.root, { 'notes/c.md': page('C four.') });
      commit(s.root, 'third', ['notes/c.md: Third reason.']);
      await sync(engine, s);

      expect(await reasonsOf(engine, s.id, 'notes/a')).toEqual({ reasons: [null], gap: true });
      expect(await reasonsOf(engine, s.id, 'notes/c')).toEqual({ reasons: ['Third reason.'], gap: true });
    }
  }), 120_000);

  test('merges: the merge\'s own trailer decides a conflict resolution, a merge without one gives NULL, a discarded side edit never decides', async () => inHome(async () => {
    for (const engine of engines) {
      const s = await classicSource(engine, { 'notes/m.md': page('Base m.'), 'notes/d.md': page('Base d.'), 'notes/n.md': page('Base n.') });
      await sync(engine, s);
      git(s.root, 'branch', 'side');
      write(s.root, { 'notes/m.md': page('Main m.'), 'notes/d.md': page('Main d.'), 'notes/n.md': page('Main n.') });
      commit(s.root, 'main edits');
      git(s.root, 'checkout', '-q', 'side');
      write(s.root, { 'notes/m.md': page('Side m.'), 'notes/d.md': page('Side d.'), 'notes/n.md': page('Side n.') });
      commit(s.root, 'side edits', ['notes/m.md: Side reason for m.', 'notes/d.md: Side reason for d.', 'notes/n.md: Side reason for n.']);
      git(s.root, 'checkout', '-q', 'main');
      try { git(s.root, 'merge', '--no-ff', '--no-commit', 'side'); } catch (error) { if (!existsSync(join(s.root, '.git', 'MERGE_HEAD'))) throw error; }
      write(s.root, { 'notes/m.md': page('Resolved m.') });
      git(s.root, 'checkout', '--ours', 'notes/d.md');
      git(s.root, 'checkout', '--theirs', 'notes/n.md');
      git(s.root, 'add', '-A');
      git(s.root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-q', '-m', 'merge side', '-m', 'gbrain-reason: notes/m.md: Merged both drafts.');
      expect(git(s.root, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
      await sync(engine, s);

      expect((await reasonsOf(engine, s.id, 'notes/m')).reasons).toEqual(['Merged both drafts.']);
      expect((await reasonsOf(engine, s.id, 'notes/n')).reasons).toEqual([null]);
      expect((await reasonsOf(engine, s.id, 'notes/d')).reasons).toEqual([null]);
      expect(await bodyOf(engine, s.id, 'notes/n')).toContain('Side n.');
      expect(await bodyOf(engine, s.id, 'notes/d')).toContain('Main d.');
    }
  }), 120_000);

  test('a capped or failed scan imports content, stores NULL, marks the gap and says there is no backfill; an unchanged re-sync stays NULL', async () => inHome(async () => {
    for (const engine of engines) {
      const s = await classicSource(engine, { 'notes/a.md': page('A one.'), 'notes/b.md': page('B one.') });
      await sync(engine, s);
      __setReasonScanCapsForTests({ sync: 1 });
      write(s.root, { 'notes/a.md': page('A two.') });
      commit(s.root, 'a', ['notes/a.md: Reason for a.']);
      write(s.root, { 'notes/b.md': page('B two.') });
      commit(s.root, 'b', ['notes/b.md: Reason for b.']);
      const capped = await sync(engine, s);
      expect(codes(capped)).toEqual(['reason_scan_capped']);
      expect(capped.reason_notices![0]!.why).toContain('does not backfill');
      expect(await bodyOf(engine, s.id, 'notes/a')).toContain('A two.');
      expect(await reasonsOf(engine, s.id, 'notes/a')).toEqual({ reasons: [null], gap: true });
      expect(await reasonsOf(engine, s.id, 'notes/b')).toEqual({ reasons: [null], gap: true });
      __setReasonScanCapsForTests();
      expect(codes(await sync(engine, s))).toEqual([]);
      expect((await reasonsOf(engine, s.id, 'notes/a')).reasons).toEqual([null]);

      __setReasonGitStreamForTests(failingGit);
      write(s.root, { 'notes/a.md': page('A three.') });
      commit(s.root, 'a again', ['notes/a.md: Another reason for a.']);
      const failed = await sync(engine, s);
      expect(codes(failed)).toEqual(['reason_scan_failed']);
      expect(failed.reason_notices![0]!.fix).toMatchObject({ argv: expect.arrayContaining(['git', 'log', '--first-parent']) });
      expect(await bodyOf(engine, s.id, 'notes/a')).toContain('A three.');
      expect(await reasonsOf(engine, s.id, 'notes/a')).toEqual({ reasons: [null, null], gap: true });
      __setReasonGitStreamForTests();
      await sync(engine, s);
      expect((await reasonsOf(engine, s.id, 'notes/a')).reasons).toEqual([null, null]);
    }
  }), 120_000);

  test('a 5,000-path commit is read in process: every path is mapped, only the annotated one has a reason', async () => inHome(async () => {
    const root = newRepo({ 'README.md': 'seed\n' });
    const base = git(root, 'rev-parse', 'HEAD');
    const files: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) files[`bulk/f${String(i).padStart(4, '0')}.md`] = page(`File ${i}.`);
    write(root, files);
    const head = commit(root, 'bulk', ['bulk/f4321.md: Only this file has a reason.']);
    const scan = await scanSyncReasons(engines[0]!, { sourceId: 'none', sourceRoot: root, from: base, to: head });
    expect(scan?.status).toBe('complete');
    expect(scan!.byPath.size).toBe(5000);
    expect(importHistoryFor(scan, join(root, 'bulk/f4321.md'))).toEqual({ reason: 'Only this file has a reason.', historyGap: false });
    expect(importHistoryFor(scan, join(root, 'bulk/f0001.md'))).toEqual({ reason: null, historyGap: false });
  }), 120_000);
});

describe('A7: purge reaches change reasons', () => {
  test('a claim inside a longer reason is redacted on every snapshot and Git effect, and a cold re-import does not bring it back', async () => inHome(async () => {
    for (const engine of engines) {
      const claim = `Door code is ${4400 + engines.indexOf(engine)}`;
      const s = await classicSource(engine, { 'notes/a.md': page('A one.'), 'notes/b.md': page('B one.') });
      await sync(engine, s);
      write(s.root, { 'notes/a.md': page('A two.'), 'notes/b.md': page('B two.') });
      const pushed = commit(s.root, 'edit', [`notes/a.md: Updated after the call where ${claim} was confirmed.`, 'notes/b.md: Routine tidy-up.']);
      await sync(engine, s);
      expect((await reasonsOf(engine, s.id, 'notes/a')).reasons).toEqual([`Updated after the call where ${claim} was confirmed.`]);
      const id = await seedFact(engine, s.id, 'people/holder-example', claim);

      const keep = 'gbrain-reason: notes/b.md: Routine tidy-up.';
      const carrying = `gbrain-reason: notes/a.md: Updated after the call where ${claim} was confirmed.`;
      const effectData = { version: 2, commit_line: `reason ${claim}`, commit_trailers: [carrying, keep], commit_trailer: carrying };
      const queued = await gitEffect(engine, s.id, 'queued', effectData);
      const retained = await gitEffect(engine, s.id, 'committed', effectData);

      const done = await purge(engine, s.id, id);
      expect(done.state).toBe('committed');
      expect(done.purge.removed).toMatchObject({ reason_purge_tombstones: 1, persistence_effects: 2 });
      expect(done.purge.removed.page_versions).toBeGreaterThanOrEqual(1);
      expect(done.residuals).toEqual(expect.arrayContaining([expect.objectContaining({ store: 'git_commit_messages', status: 'out_of_reach', remaining: 1 })]));
      expect((await reasonsOf(engine, s.id, 'notes/a')).reasons).toEqual(['[purged]']);
      expect((await reasonsOf(engine, s.id, 'notes/b')).reasons).toEqual(['Routine tidy-up.']);
      const lower = claim.toLowerCase();
      expect(await engine.executeRaw('SELECT 1 FROM page_versions WHERE strpos(lower(change_reason), $1) > 0', [lower])).toHaveLength(0);
      for (const effect of [queued, retained]) {
        const [after] = await engine.executeRaw<{ data: Record<string, unknown> }>('SELECT data FROM persistence_effects WHERE id = $1::bigint', [effect]);
        expect(after!.data).toEqual({ version: 2, commit_line: '[purged]', commit_trailers: [keep] });
      }
      expect(await engine.executeRaw('SELECT commit_sha, path FROM reason_purge_tombstones WHERE source_id = $1', [s.id]))
        .toEqual([{ commit_sha: pushed, path: 'notes/a.md' }]);

      // Cold re-import: the database pages go back to their first editions and the source forgets its last commit.
      await importFromContent(engine, 'notes/a', page('A one.'), { noEmbed: true, sourceId: s.id });
      await importFromContent(engine, 'notes/b', page('B one.'), { noEmbed: true, sourceId: s.id });
      await engine.executeRaw('UPDATE sources SET last_commit = NULL WHERE id = $1', [s.id]);
      await sync(engine, s);
      expect(await bodyOf(engine, s.id, 'notes/a')).toContain('A two.');
      expect((await reasonsOf(engine, s.id, 'notes/a')).reasons.at(-1)).toBeNull();
      expect((await reasonsOf(engine, s.id, 'notes/b')).reasons.at(-1)).toBe('Routine tidy-up.');
    }
  }), 180_000);

  test('a running Git effect carrying the claim blocks the purge with the pending-recovery refusal', async () => inHome(async () => {
    for (const engine of engines) {
      const claim = `Vault pin is ${7100 + engines.indexOf(engine)}`;
      const s = await classicSource(engine, { 'notes/a.md': page('A one.') });
      await sync(engine, s);
      const id = await seedFact(engine, s.id, 'people/runner-example', claim);
      await gitEffect(engine, s.id, 'running', { commit_line: `pin ${claim}` });
      expect((await refusal(purge(engine, s.id, id))).code).toBe('purge_blocked_pending_recovery');
      expect(await engine.executeRaw('SELECT 1 FROM facts WHERE id = $1', [id])).toHaveLength(1);
    }
  }), 120_000);

  test('A-T7b: a scan failure refuses before deleting anything (wait); over the cap refuses with ask_user, and a chosen limit proceeds', async () => inHome(async () => {
    for (const engine of engines) {
      const claim = `Gate code is ${5200 + engines.indexOf(engine)}`;
      const s = await classicSource(engine, { 'notes/a.md': page('A one.') });
      await sync(engine, s);
      write(s.root, { 'notes/a.md': page('A two.') });
      const pushed = commit(s.root, 'edit', [`notes/a.md: Changed once ${claim} was rotated.`]);
      await sync(engine, s);
      const id = await seedFact(engine, s.id, 'people/gate-example', claim);

      __setReasonGitStreamForTests(failingGit);
      const failed = await refusal(purge(engine, s.id, id));
      expect(failed).toMatchObject({ code: 'reason_purge_scan_failed' });
      expect(failed.fix).toMatchObject({ next: 'wait' });
      expect(await engine.executeRaw('SELECT 1 FROM facts WHERE id = $1', [id])).toHaveLength(1);
      expect((await reasonsOf(engine, s.id, 'notes/a')).reasons).toEqual([`Changed once ${claim} was rotated.`]);
      __setReasonGitStreamForTests();

      __setReasonScanCapsForTests({ purge: 1 });
      const capped = await refusal(purge(engine, s.id, id));
      expect(capped).toMatchObject({ code: 'reason_purge_scan_capped' });
      expect(capped.fix).toMatchObject({ next: 'ask_user', argv: expect.arrayContaining(['--reason-scan-limit']) });
      expect(await engine.executeRaw('SELECT 1 FROM facts WHERE id = $1', [id])).toHaveLength(1);

      const limited = await purge(engine, s.id, id, { reason_scan_limit: 1 });
      expect(limited.state).toBe('committed');
      expect(limited.residuals).toEqual(expect.arrayContaining([expect.objectContaining({ store: 'git_commit_messages', reason: 'reason_scan_limit' })]));
      expect(await engine.executeRaw('SELECT commit_sha FROM reason_purge_tombstones WHERE source_id = $1', [s.id])).toEqual([{ commit_sha: pushed }]);
      expect((await reasonsOf(engine, s.id, 'notes/a')).reasons).toEqual(['[purged]']);
      __setReasonScanCapsForTests();
    }
  }), 120_000);
  test('A-T7c: a moved checkout or a corrupt .git/config refuses before anything is deleted; a plain-folder source still purges', async () => inHome(async () => {
    for (const engine of engines) {
      const n = engines.indexOf(engine);
      const claim = `Locker code is ${8100 + n}`;
      const s = await classicSource(engine, { 'notes/a.md': page('A one.') });
      await sync(engine, s);
      write(s.root, { 'notes/a.md': page('A two.') });
      commit(s.root, 'edit', [`notes/a.md: Changed once ${claim} was rotated.`]);
      await sync(engine, s);
      const id = await seedFact(engine, s.id, `people/locker-example-${n}`, claim);
      const untouched = async () => {
        expect(await engine.executeRaw('SELECT 1 FROM facts WHERE id = $1', [id])).toHaveLength(1);
        expect((await reasonsOf(engine, s.id, 'notes/a')).reasons).toEqual([`Changed once ${claim} was rotated.`]);
        expect(await engine.executeRaw('SELECT 1 FROM reason_purge_tombstones WHERE source_id = $1', [s.id])).toHaveLength(0);
      };

      renameSync(s.root, `${s.root}-moved`);
      try {
        const moved = await refusal(purge(engine, s.id, id));
        expect(moved).toMatchObject({ code: 'reason_purge_scan_failed' });
        await untouched();
      } finally { renameSync(`${s.root}-moved`, s.root); }

      const config = join(s.root, '.git', 'config');
      const intact = readFileSync(config, 'utf8');
      writeFileSync(config, `${intact}[core\n\tbroken = \n`);
      try {
        expect(gitTopLevel(s.root)).toBeNull();
        const corrupt = await refusal(purge(engine, s.id, id));
        expect(corrupt).toMatchObject({ code: 'reason_purge_scan_failed' });
        await untouched();
      } finally { writeFileSync(config, intact); }

      const folder = join(home, `plain-source-${++serial}`);
      write(folder, { 'notes/plain.md': page('Plain one.') });
      const plainId = `rt-plain-${serial}`;
      await engine.executeRaw(`INSERT INTO sources(id, name, local_path, config) VALUES ($1, $1, $2, '{}')`, [plainId, folder]);
      const plainFact = await seedFact(engine, plainId, `people/plain-example-${n}`, claim);
      const plain = await purge(engine, plainId, plainFact);
      expect(plain.state).toBe('committed');
      expect(plain.residuals.map((r: { store: string }) => r.store)).not.toContain('git_commit_messages');
      expect(await engine.executeRaw('SELECT 1 FROM facts WHERE id = $1', [plainFact])).toHaveLength(0);
    }
  }), 180_000);
  test('a purge while another process holds a cached scan of the range: its next request reads the tombstone, not the cached reason', async () => inHome(async () => {
    // A second module instance is the managed sync worker's process: the purge cannot clear its cache.
    const worker = await import(new URL('../src/core/reason-trailers.ts?sync-worker', import.meta.url).href) as typeof import('../src/core/reason-trailers.ts');
    for (const engine of engines) {
      const claim = `Safe combination is ${9300 + engines.indexOf(engine)}`;
      const s = await classicSource(engine, { 'notes/a.md': page('A one.') });
      await sync(engine, s);
      const from = git(s.root, 'rev-parse', 'HEAD');
      write(s.root, { 'notes/a.md': page('A two.') });
      const to = commit(s.root, 'edit', [`notes/a.md: Changed once ${claim} was rotated.`]);
      const range = { sourceId: s.id, sourceRoot: s.root, from, to };
      const file = join(s.root, 'notes/a.md');
      expect(worker.importHistoryFor(await worker.cachedSyncReasonScan(engine, range), file)).toEqual({ reason: `Changed once ${claim} was rotated.`, historyGap: false });
      await sync(engine, s);
      const id = await seedFact(engine, s.id, `people/safe-example-${engines.indexOf(engine)}`, claim);
      expect((await purge(engine, s.id, id)).state).toBe('committed');
      expect(worker.importHistoryFor(await worker.cachedSyncReasonScan(engine, range), file)).toEqual({ reason: null, historyGap: false });
      worker.clearReasonScanCache();
    }
  }), 120_000);
  test('a trailer whose spacing differs from the claim (double space, tab) is tombstoned, and a cold re-import does not restore it', async () => inHome(async () => {
    for (const engine of engines) {
      const n = engines.indexOf(engine);
      const claim = `the secret project name ${n}`;
      const s = await classicSource(engine, { 'notes/a.md': page('A one.') });
      await sync(engine, s);
      write(s.root, { 'notes/a.md': page('A two.') });
      const pushed = commit(s.root, 'edit', [`notes/a.md: the  secret\tproject name ${n}`]);
      await sync(engine, s);
      expect((await reasonsOf(engine, s.id, 'notes/a')).reasons).toEqual([claim]);
      const id = await seedFact(engine, s.id, `people/spacing-example-${n}`, claim);
      const done = await purge(engine, s.id, id);
      expect(done.state).toBe('committed');
      expect(await engine.executeRaw('SELECT commit_sha, path FROM reason_purge_tombstones WHERE source_id = $1', [s.id])).toEqual([{ commit_sha: pushed, path: 'notes/a.md' }]);
      await importFromContent(engine, 'notes/a', page('A one.'), { noEmbed: true, sourceId: s.id });
      await engine.executeRaw('UPDATE sources SET last_commit = NULL WHERE id = $1', [s.id]);
      await sync(engine, s);
      expect(await bodyOf(engine, s.id, 'notes/a')).toContain('A two.');
      expect((await reasonsOf(engine, s.id, 'notes/a')).reasons.at(-1)).toBeNull();
      expect(await engine.executeRaw('SELECT 1 FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.source_id = $1 AND strpos(lower(v.change_reason), $2) > 0', [s.id, claim])).toHaveLength(0);
    }
  }), 120_000);
});

describe('A-T11: repo-less brains are first class', () => {
  test('put_page reasons, purge of a quoted claim and a plain-folder import: no refusal, no notice, no gap marker', async () => inHome(async () => {
    for (const engine of engines) {
      const n = engines.indexOf(engine);
      const claim = `Alarm code is ${6300 + n}`;
      const slug = `policies/policy-4a-example-${n}`;
      const [source] = await engine.executeRaw<{ local_path: string | null }>(`SELECT local_path FROM sources WHERE id = 'default'`);
      expect(source?.local_path ?? null).toBeNull();
      await run(engine, 'default', 'put_page', { slug, content: page('Edition one.'), wait_ms: 30_000 });
      const revision = String((await run(engine, 'default', 'get_page', { slug, include_content: true })).revision);
      const second = await run(engine, 'default', 'put_page', { slug, content: page('Edition two.'), expected_revision: revision,
        reason: `Board asked because ${claim} leaked.`, wait_ms: 30_000 });
      expect((second.outcome ?? second).reason_recorded).toMatchObject({ version: true, git: 'no_repository' });
      const versions = await run(engine, 'default', 'get_versions', { slug }) as unknown as Array<Record<string, unknown>>;
      expect(versions.map(row => row.replaced_because)).toEqual([`Board asked because ${claim} leaked.`]);

      const id = await seedFact(engine, 'default', `people/alarm-example-${n}`, claim);
      const done = await purge(engine, 'default', id);
      expect(done.state).toBe('committed');
      expect(done.purge.removed.reason_purge_tombstones ?? 0).toBe(0);
      expect(done.residuals.map((r: { store: string }) => r.store)).not.toContain('git_commit_messages');
      const after = await run(engine, 'default', 'get_versions', { slug }) as unknown as Array<Record<string, unknown>>;
      expect(after.map(row => row.replaced_because)).toEqual(['[purged]']);
      expect(await engine.executeRaw(`SELECT 1 FROM pages WHERE source_id = 'default' AND slug = $1 AND version_history_gap_at IS NOT NULL`, [slug])).toHaveLength(0);

      const folder = join(home, `folder-${++serial}`);
      write(folder, { 'notes/plain.md': page('Plain one.') });
      expect(gitTopLevel(folder)).toBeNull();
      expect(await scanSyncReasons(engine, { sourceId: 'default', sourceRoot: folder, from: null, to: 'HEAD' })).toBeNull();
      expect(await scanTrailersCarrying(folder, [claim])).toEqual({ status: 'no_repository' });
      await runImport(engine, [folder, '--no-embed']);
      write(folder, { 'notes/plain.md': page('Plain two.') });
      await runImport(engine, [folder, '--no-embed']);
      expect(await bodyOf(engine, 'default', 'notes/plain')).toContain('Plain two.');
      expect(await reasonsOf(engine, 'default', 'notes/plain')).toEqual({ reasons: [null], gap: false });
    }
  }), 180_000);
});

describe('A6 on a managed source', () => {
  test('managed sync mirrors the reason on the archived snapshot; a failed scan reports on the pass result', async () => inHome(async () => {
    for (const engine of engines) {
      __setReasonGitStreamForTests();
      const id = `rt-managed-${++serial}`;
      const root = newRepo({ 'notes/a.md': page('A one.') });
      await engine.executeRaw('UPDATE persistence_brain SET enabled = false WHERE singleton = 1');
      await engine.executeRaw(`INSERT INTO sources(id, name, local_path, config) VALUES ($1, $1, $2, '{}')`, [id, root]);
      await claimWorktree(engine, id, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled = true WHERE singleton = 1');
      try {
        expect((await performManagedSync(engine, { sourceId: id, noPull: true })).status).toBe('first_sync');
        write(root, { 'notes/a.md': page('A two.') });
        commit(root, 'edit', ['notes/a.md: Managed reason.']);
        await performManagedSync(engine, { sourceId: id, noPull: true });
        expect(await reasonsOf(engine, id, 'notes/a')).toEqual({ reasons: ['Managed reason.'], gap: false });

        __setReasonGitStreamForTests(failingGit);
        clearReasonScanCache();
        write(root, { 'notes/a.md': page('A three.') });
        commit(root, 'edit again', ['notes/a.md: Lost reason.']);
        const failed = await performManagedSync(engine, { sourceId: id, noPull: true });
        expect(codes(failed)).toEqual(['reason_scan_failed']);
        expect(await reasonsOf(engine, id, 'notes/a')).toEqual({ reasons: ['Managed reason.', null], gap: true });
      } finally {
        await disposePersistenceConsumer(engine).catch(() => undefined);
        await engine.executeRaw('UPDATE persistence_brain SET enabled = false WHERE singleton = 1');
      }
    }
  }), 180_000);
});
