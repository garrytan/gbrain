/**
 * GBRA-133: `gbrain repair file-drift --held` previews one bounded window of the selected holds, in held-path order.
 *   - a window stops at 200 pages, or starts no page once its time budget (or the run's deadline) has passed;
 *   - a partial window prints `next_cursor` and the next preview command, and its hash and apply command cover only it
 *     (the apply carries `--cursor`); the windows of one held set cover every page exactly once;
 *   - the preview reports each page to its progress reporter (stderr on the CLI);
 *   - a cursor no preview printed, or `--cursor` without `--held`, is refused before any page is read.
 * Before: the preview prepared every held page before printing anything (each page costs a few dozen round trips), so a
 * large held set against a remote database printed nothing for an hour.
 * Real PGLite (and Postgres when DATABASE_URL is set) with a claimed canonical Git worktree and real files; no seams.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { gitBlobOid } from '../src/core/persistence/digest.ts';
import { SYNC_ORIGIN_DELETED_OP } from '../src/core/persistence/sync-pass-row.ts';
import { gitHoldItem, readGitHold, writeGitHold, type FileDriftDeletedState, type FileDriftSide } from '../src/core/persistence/sync-holds.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { readArtifact } from '../src/core/repair/file-drift.ts';
import { withEnv } from './helpers/with-env.ts';
import type { ProgressReporter } from '../src/core/progress.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const logger = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n${body}\n`;

for (const backend of testBackends()) describe(`GBRA-133: a held file-drift preview is one bounded window (${backend})`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    if (backend === 'pglite') {
      const pglite = new PGLiteEngine();
      await pglite.connect({}); await pglite.initSchema(); engine = pglite;
    } else {
      const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase());
      engine = pg.engine; closePostgres = pg.close;
    }
  }, 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    if (closePostgres) await closePostgres(); else await engine.disconnect();
  });

  interface Fixture { root: string; sourceId: string; ctx: OperationContext; incarnation: string }
  async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-6712-held-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const sourceId = `held6712-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
        const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
        await run({ root, sourceId, ctx, incarnation: source!.incarnation });
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const put = (ctx: OperationContext, slug: string, body: string) =>
    submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: page(slug, body), request_id: randomUUID() } });
  const snapshot = (sourceId: string, slug: string) => engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  const remove = async (ctx: OperationContext, sourceId: string, slug: string, purge = false) => submitPageMutation(ctx, { operation: 'delete_page',
    params: { slug, request_id: randomUUID(), expected_revision: (await snapshot(sourceId, slug))!.revision, ...(purge ? { purge: true } : {}) } });
  const commitAll = (root: string, message: string) => { git(root, 'add', '-A'); git(root, 'commit', '-q', '--allow-empty', '-m', message); };
  /** The `file_drift` hold sync writes for a Decision (design v3.2 §4): its side, and for a deleted side its state. */
  const hold = (f: Fixture, input: { path: string; slug: string | null; pageId: number | null; side: FileDriftSide; state?: FileDriftDeletedState; revision?: string }) =>
    engine.transaction(tx => writeGitHold(tx, { source_id: f.sourceId, incarnation: f.incarnation, path: input.path, source_path: input.path, slug: input.slug,
      page_id: input.pageId, code: 'file_drift', message: `${input.path} is held: file drift (${input.side}${input.state ? ` ${input.state}` : ''})`, upstream_version: null,
      observed_at: new Date().toISOString(), run_id: null, mode: 'managed',
      meta: { recovery_version: RECOVERY_VERSION, side: input.side, ...(input.state ? { state: input.state } : {}), ...(input.revision ? { page_revision: input.revision } : {}) } }));
  const run = async (sourceId: string, opts: { cursor?: string; deadline?: number; expect?: string; progress?: ProgressReporter; held?: boolean; slugs?: string[] }) =>
    (await repairRunner(engine, { apply: opts.expect !== undefined, logger })).run('file-drift', await resolveRepairScope(engine, sourceId),
      { explicit: true, sourceFlag: sourceId, prefer: 'database', ...(opts.held === false ? {} : { held: true, side: 'deleted', state: 'file_gone' }), ...(opts.slugs ? { slugs: opts.slugs } : {}),
        ...(opts.cursor ? { cursor: opts.cursor } : {}), ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}), ...(opts.expect ? { expect: opts.expect } : {}),
        ...(opts.progress ? { progress: opts.progress } : {}) });
  const refusal = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error as OperationError; } throw new Error('expected a refusal'); };
  /** `count` live pages whose committed files are then removed in one commit, each held as the file_gone Decision. */
  async function fileGone(f: Fixture, count: number): Promise<string[]> {
    const slugs = Array.from({ length: count }, (_, i) => `notes/gone-${String(i).padStart(4, '0')}`);
    for (const slug of slugs) await put(f.ctx, slug, `The page ${slug}.`);
    commitAll(f.root, 'pages');
    git(f.root, 'rm', '-q', '--', ...slugs.map(slug => `${slug}.md`)); git(f.root, 'commit', '-q', '-m', 'remove');
    for (const slug of slugs) {
      const live = (await snapshot(f.sourceId, slug))!;
      await hold(f, { path: `${slug}.md`, slug, pageId: Number(live.page.id), side: 'deleted', state: 'file_gone', revision: live.revision });
    }
    return slugs;
  }
  const window = (result: Awaited<ReturnType<typeof run>>) => (result.details as { window?: { previewed: number; remaining: number; complete: boolean; next_cursor?: string; next_command?: string } }).window!;
  const slugsOf = (result: Awaited<ReturnType<typeof run>>) => (result.details!.pages as Array<{ slug: string }>).map(page => page.slug);

  test('past its time budget a window previews one page; the cursors walk the held set once, and an apply covers only its window', () => fixture(async f => {
    const slugs = await fileGone(f, 3);
    const ticks: string[] = [];
    const progress = { start: (phase: string, total?: number) => ticks.push(`start ${phase} ${total}`), tick: (_n?: number, note?: string) => ticks.push(`tick ${note}`),
      heartbeat() {}, finish: () => ticks.push('finish'), child: () => progress } as unknown as ProgressReporter;
    const first = await run(f.sourceId, { deadline: Date.now() - 1, progress });
    expect(slugsOf(first)).toEqual([slugs[0]]);
    expect(ticks).toEqual(['start repair.file_drift.provenance 3', 'finish', 'start repair.file_drift.preview 3', `tick ${slugs[0]}`, 'finish']);
    expect(window(first)).toMatchObject({ previewed: 1, remaining: 2, complete: false });
    expect(first.residuals).toMatchObject({ after_window: 2 });
    const cursor = window(first).next_cursor!;
    expect(window(first).next_command).toBe(`gbrain repair file-drift --source ${f.sourceId} --held --side deleted --state file_gone --cursor ${cursor} --prefer database`);
    expect(first.warnings!.join('\n')).toContain(`preview the next one: ${window(first).next_command}`);
    expect(first.apply_command).not.toContain('--cursor');

    const second = await run(f.sourceId, { cursor, deadline: Date.now() - 1 });
    expect(slugsOf(second)).toEqual([slugs[1]]);
    expect(second.residuals).toMatchObject({ before_cursor: 1, after_window: 1 });
    expect(second.apply_command).toContain(`--cursor ${cursor} --prefer database --apply --expect ${second.preview_hash}`);
    const third = await run(f.sourceId, { cursor: window(second).next_cursor! });
    expect(slugsOf(third)).toEqual([slugs[2]]);
    expect(window(third)).toEqual({ previewed: 1, remaining: 0, complete: true });
    expect((third.warnings ?? []).filter(warning => warning.includes('preview the next one'))).toEqual([]);

    // The second window's apply recreates only its page; the hash is bound to its cursor.
    const applied = await run(f.sourceId, { cursor, expect: second.preview_hash! });
    expect(applied.outcomes).toEqual({ repaired: 1 });
    expect(existsSync(join(f.root, `${slugs[1]}.md`))).toBe(true);
    for (const slug of [slugs[0], slugs[2]]) expect(existsSync(join(f.root, `${slug}.md`))).toBe(false);
    const elsewhere = await refusal(run(f.sourceId, { expect: third.preview_hash! }));
    expect(elsewhere.code).toBe('preview_changed');
  }), 240_000);

  test('an apply parses the preview artifact once while it is unchanged, and reports each item to its progress reporter', () => fixture(async f => {
    const slugs = await fileGone(f, 3);
    const preview = await run(f.sourceId, {});
    const hash = preview.preview_hash!;
    // Git durability is off in this fixture: the preview leads with what the next sync does to an uncommitted recreate.
    expect(preview.warnings![0]).toStartWith('The next sync undoes this repair unless the recreated files are committed');
    expect(preview.warnings![0]).toEndWith(`Commit them right after the apply: gbrain git commit-push --path ${f.root} -m 'gbrain: repair file drift in ${f.sourceId}' -- ${slugs.map(slug => `${slug}.md`).join(' ')}`);
    expect(preview.details).toMatchObject({ undone_by_next_sync_unless_committed: { recreated: 3, removed: 0 } });
    const command = `gbrain repair file-drift --source ${f.sourceId}`;
    const first = readArtifact(hash, command);
    expect([...first.keys()]).toEqual(slugs);
    expect(readArtifact(hash, command)).toBe(first);
    const ticks: string[] = [];
    const progress = { start: (phase: string, total?: number) => ticks.push(`start ${phase} ${total}`), tick: (_n?: number, note?: string) => ticks.push(`tick ${note}`),
      heartbeat() {}, finish: () => ticks.push('finish'), child: () => progress } as unknown as ProgressReporter;
    const applied = await run(f.sourceId, { expect: hash, progress });
    expect(applied.outcomes).toEqual({ repaired: 3 });
    expect(ticks).toEqual(['start repair.file-drift.apply 3', ...slugs.map(slug => `tick ${f.sourceId}:${slug}`), 'finish']);
    for (const slug of slugs) expect(existsSync(join(f.root, `${slug}.md`))).toBe(true);
  }), 240_000);

  test('a window stops at 200 pages and the next one previews the rest', () => fixture(async f => {
    const slugs = await fileGone(f, 203);
    const first = await run(f.sourceId, {});
    expect(slugsOf(first)).toEqual(slugs.slice(0, 200));
    expect(window(first)).toMatchObject({ previewed: 200, remaining: 3, complete: false });
    const rest = await run(f.sourceId, { cursor: window(first).next_cursor! });
    expect(slugsOf(rest)).toEqual(slugs.slice(200));
    expect(window(rest)).toEqual({ previewed: 3, remaining: 0, complete: true });
  }), 600_000);

  test('a cursor no preview printed, or --cursor without --held, is refused', () => fixture(async f => {
    await fileGone(f, 1);
    const forged = await refusal(run(f.sourceId, { cursor: 'not-a-cursor' }));
    expect(forged.code).toBe('invalid_params');
    expect(forged.suggestion).toContain('Pass the next_cursor the previous preview printed');
    const unheld = await refusal(run(f.sourceId, { held: false, slugs: ['notes/gone-0000'], cursor: 'h1.bm90ZXM' }));
    expect(unheld.code).toBe('invalid_params');
    expect(unheld.message).toBe('--cursor only continues a --held preview.');
  }), 240_000);
});
