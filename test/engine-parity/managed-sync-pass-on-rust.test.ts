/**
 * Engine parity: the managed sync pass, its page faults and holds, and `gbrain sync status` on a Rust brain (lane LM, slice 2, part B).
 *
 * Every case lifts the `managed_persistence` hold on its own Rust test engine (rust-managed.ts `liftManagedHold`), claims and
 * activates a Git checkout and drives the real code path: a managed sync, a database edit that moves a page under it, a hold,
 * a recorded failure, a dry run, a pinned slug-root mode, the status read. `servedCapabilities()` now reports the capability
 * on single-host and multi-user Rust, so the lift changes nothing there.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the page-fault proofs of a sync (`pageChangeProof`, `idempotentDeletionProof`), a file held because its page moved
 *    in the database, `gbrain sync status` of a source with holds, a recorded failure and a cursor, a managed dry run, a slug-root
 *    mode the source pins and a second pass over a changed checkout answer the same on PGLite, Postgres and Rust.
 *  - Regression: each of these read its rows through `executeRaw`, which the Rust engine refuses, so on a Rust brain the status read,
 *    the dry run and the page-fault proofs stopped on `engine_capability_missing` (conflict row 47).
 *  - Why existing coverage misses it: the managed sync suites run PGLite and Postgres only, and managed-sync-on-rust.test.ts stops
 *    at the first pass, the hold and the statement table.
 *  - Seam: real engines and real Git checkouts; no fault hooks.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { liftManagedHold } from './rust-managed.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { performSync } from '../../src/commands/sync.ts';
import { runSyncStatus } from '../../src/commands/sync/operator.ts';
import { readGitSourceHolds } from '../../src/core/persistence/sync-holds.ts';
import { readSyncStatus } from '../../src/core/persistence/sync-status.ts';
import { readLandingGaps } from '../../src/core/persistence/landing-gaps.ts';
import { readSyncFreshness } from '../../src/core/persistence/sync-freshness.ts';
import { recordManagedSyncFailure } from '../../src/core/persistence/sync-failures.ts';
import { idempotentDeletionProof, pageChangeProof } from '../../src/core/persistence/sync-page-fault.ts';
import { readDryRunWriterState } from '../../src/core/persistence/sync-dry-run-writer.ts';
import { recordedStop } from '../../src/core/persistence/sync-stop-class.ts';
import { proveConfirm, readLevelMark } from '../../src/core/persistence/sync-pass-confirm.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { hostIdFor, readLocalWriter } from '../../src/core/persistence/identity.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { randomUUID } from 'node:crypto';

import { fenceOpts } from '../../src/core/persistence/host-fence.ts';
import { ensureProcessRegistration } from '../../src/core/persistence/managed-registration.ts';
const { parityTest } = parityArms(testBackends());

const GIT_ID = ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid'];
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const note = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}\n`;
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, ...GIT_ID, 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD').trim(); };

type Result = { status: string; held?: Array<{ path: string; code: string }>; error?: { code?: string } } & Record<string, unknown>;

/** Lifts the hold on the Rust arm's engine, then runs `run` with source `work` claimed and activated on a Git checkout (`scope`: a subdirectory of the repository). */
async function withManagedSource<T>(engine: BrainEngine, backend: ParityBackend, files: Record<string, string>,
  run: (ctx: { root: string; repo: string; sync: (options?: Record<string, unknown>) => Promise<Result> }) => Promise<T>, opts: { scope?: string; config?: Record<string, unknown>; others?: Record<string, Record<string, unknown>> } = {}): Promise<T> {
  if (backend === 'rust') liftManagedHold(engine);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-managed-sync-pass-on-rust-')));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const repo = join(home, 'checkout');
      const root = opts.scope ? join(repo, opts.scope) : repo;
      mkdirSync(join(root, 'notes'), { recursive: true });
      git(repo, 'init', '-q', '-b', 'main');
      for (const [path, body] of Object.entries(files)) writeFileSync(join(root, path), body);
      commit(repo, 'notes');
      await createSource(engine, backend, 'work', opts.config ?? {}, root);
      for (const [id, config] of Object.entries(opts.others ?? {})) await createSource(engine, backend, id, config);
      try {
        const reviewed = async (operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
        await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed('writer_claim') });
        await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed('writer_activate') });
        // A refusal on the Rust arm ends the case as stopped; any other refusal is an answer the arms compare.
        const sync = (options: Record<string, unknown> = {}) => performSync(engine, { sourceId: 'work', repoPath: root, noPull: true, noEmbed: true, noExtract: true, ...options })
          .then(r => r as unknown as Result, (error: { code?: string }) => {
            if (error?.code === 'engine_capability_missing') throw error;
            return { status: `refused: ${error?.code ?? String(error)}` } as Result;
          });
        return await run({ root, repo, sync });
      } finally { await disposePersistenceConsumer(engine); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const dbEdit = (engine: BrainEngine, slug: string, body: string) => engine.transaction(tx => withCoordinatedWrite(tx, ['work'], () => tx.putPage(slug, {
  type: 'note', title: 'Edited in the database', compiled_truth: body, timeline: '', frontmatter: {}, content_hash: `h-${body.length}` }, { sourceId: 'work' }), TEST_WRITE_ATTRIBUTION));
const dbDelete = (engine: BrainEngine, slug: string) => engine.transaction(tx => withCoordinatedWrite(tx, ['work'], () => tx.softDeletePage(slug, { sourceId: 'work' }), TEST_WRITE_ATTRIBUTION));

/** `gbrain sync status --source work --json`, run for real: what it writes to stdout, parsed. */
async function statusJson(engine: BrainEngine): Promise<Record<string, any>> {
  const chunks: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { chunks.push(args.map(String).join(' ')); };
  try { await runSyncStatus(engine, ['--source', 'work', '--json']); } finally { console.log = log; }
  return JSON.parse(chunks.join(''));
}

const holdsOf = async (engine: BrainEngine) => ((await readGitSourceHolds(engine, { sourceIds: ['work'] }))[0]?.holds ?? [])
  .map(hold => ({ path: hold.path, code: hold.code })).sort((a, b) => a.path.localeCompare(b.path));
const titles = async (engine: BrainEngine) => Object.fromEntries((await engine.listPages({ sourceId: 'work', limit: 100 })).map(page => [page.slug, page.title ?? null]).sort(([a], [b]) => String(a).localeCompare(String(b))));
const incarnationOf = async (engine: BrainEngine) => (await engine.readSourceMembership('work'))!.incarnation;

const ctxFor = (engine: BrainEngine) => ({ engine, sourceId: 'work', remote: false as const,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {} } });

/** A put_page to `work` through the managed write path, then bounded effect passes until its Git effects settle. */
async function putSettled(engine: BrainEngine, slug: string, title: string, body: string, expectedRevision: string): Promise<void> {
  const request_id = randomUUID();
  await submitPageMutation(ctxFor(engine) as never, { operation: 'put_page', params: { slug, content: `---\ntype: note\ntitle: ${title}\n---\n${body}\n`, request_id, expected_revision: expectedRevision } });
  const row = await engine.readWriteRequest('local_cli', (await readLocalWriter(engine, 'cli')).id, request_id);
  for (let i = 0; i < 100; i++) {
    const open = row ? (await engine.readRequestEffects(row.id)).some(e => e.state === 'queued' || e.state === 'running') : false;
    if (!open) return;
    await runPersistenceEffects(engine, { engine: engine.kind } as never, { hostId: hostIdFor(engine), limit: 20 });
    await Bun.sleep(50);
  }
  throw new Error(`the effects of ${slug} did not settle`);
}

describe('the managed sync pass, its page faults and `gbrain sync status` on a Rust brain, hold kept for users', () => {
  parityTest('the page-fault proofs name the committed write that moved a page, and the deletion that removed it', {
    methods: ['worktreeClaimStore', 'readPageSnapshot'],
    timeout: 240_000,
  }, async (engine, backend) => withManagedSource(engine, backend, {
    'notes/alice-example.md': note('Alice Example', 'Works at acme-example.'),
  }, async ({ sync }) => {
    const first = await sync();
    const incarnation = await incarnationOf(engine);
    const before = (await engine.readPageSnapshot('notes/alice-example', { sourceId: 'work' }))!;
    await putSettled(engine, 'notes/alice-example', 'Alice Example', 'Moved by a managed write.', before.revision);
    const after = (await engine.readPageSnapshot('notes/alice-example', { sourceId: 'work' }))!;
    const pageId = after.page.id;
    // #6194's proof: the live revision differs from the frozen one and a committed non-sync request of this incarnation wrote it.
    const proof = await pageChangeProof(engine, { sourceId: 'work', incarnation, pageId, expectedRevision: before.revision });
    const unmoved = await pageChangeProof(engine, { sourceId: 'work', incarnation, pageId, expectedRevision: after.revision });
    const noPage = await pageChangeProof(engine, { sourceId: 'work', incarnation, pageId: null, expectedRevision: null });
    const unknownPage = await pageChangeProof(engine, { sourceId: 'work', incarnation, pageId: 987654, expectedRevision: before.revision });
    // The deletion the database carried out: soft-deleted at that revision, by a delete request, nothing live at the file's origin.
    await dbDelete(engine, 'notes/alice-example');
    const gone = (await engine.readPageSnapshot('notes/alice-example', { sourceId: 'work', includeDeleted: true }))!;
    const deletion = await idempotentDeletionProof(engine, { sourceId: 'work', incarnation, pageId, revision: gone.revision, sourcePath: 'notes/alice-example.md' });
    const wrongRevision = await idempotentDeletionProof(engine, { sourceId: 'work', incarnation, pageId, revision: after.revision, sourcePath: 'notes/alice-example.md' });
    const out = { first: first.status, proof: proof && { operation: proof.operation, moved: proof.revision === after.revision }, unmoved, noPage, unknownPage,
      deleted: gone.page.deleted_at != null, deletion: deletion && { named: typeof deletion.request_id === 'string' }, wrongRevision };
    expect(out).toMatchObject({ first: 'first_sync', proof: { operation: 'put_page', moved: true }, unmoved: null, noPage: null, unknownPage: null, wrongRevision: null });
    return out;
  }));

  parityTest('a page edited in the database under a changed file is held file_drift while the other changed file imports', {
    methods: ['worktreeClaimStore', 'listPages', 'readPageSnapshot'],
    timeout: 240_000,
  }, async (engine, backend) => withManagedSource(engine, backend, {
    'notes/alice-example.md': note('Alice Example', 'Works at acme-example.'),
    'notes/bob-example.md': note('Bob Example', 'Works at widget-co.'),
  }, async ({ repo, root, sync }) => {
    const first = await sync();
    // Alice moves in the database and her file changes in Git: the pass cannot pick a side and holds the file; Bob's file imports.
    await dbEdit(engine, 'notes/alice-example', 'Edited straight in the database.');
    writeFileSync(join(root, 'notes', 'alice-example.md'), note('Alice Example', 'Edited in Git.'));
    writeFileSync(join(root, 'notes', 'bob-example.md'), note('Bob Example', 'Now at widget-co-two.'));
    commit(repo, 'edit alice and bob');
    const second = await sync();
    const third = await sync();
    const alice = (await engine.readPageSnapshot('notes/alice-example', { sourceId: 'work' }))!;
    const out = { first: first.status, second: second.status, third: third.status, holds: await holdsOf(engine), pages: await titles(engine),
      alice: alice.page.compiled_truth.trim(), bob: (await engine.getPage('notes/bob-example', { sourceId: 'work' }))!.compiled_truth.trim() };
    expect(out).toMatchObject({ second: 'synced', holds: [{ path: 'notes/alice-example.md', code: 'file_drift' }], alice: 'Edited straight in the database.', bob: 'Now at widget-co-two.' });
    return out;
  }));

  parityTest('a managed dry run reports the writer state and imports nothing, before and after the first sync', {
    methods: ['worktreeClaimStore', 'listPages'],
    timeout: 240_000,
  }, async (engine, backend) => withManagedSource(engine, backend, {
    'notes/alice-example.md': note('Alice Example', 'Works at acme-example.'),
    'notes/broken-example.md': '---\ntitle: [broken\n---\nCommitted, but its frontmatter does not parse.\n',
  }, async ({ repo, root, sync }) => {
    const shape = (r: Result) => ({ status: r.status, writer: r.writer ? { open: (r.writer as { open_requests: number }).open_requests, oldest: (r.writer as { oldest_open_age_seconds: number | null }).oldest_open_age_seconds } : null,
      pagesWritten: r.managedWrite ?? null });
    const dryFirst = shape(await sync({ dryRun: true }));
    const pagesAfterDry = await titles(engine);
    const first = await sync();
    writeFileSync(join(root, 'notes', 'alice-example.md'), note('Alice Example', 'Moved on.'));
    commit(repo, 'edit alice');
    const dryNext = shape(await sync({ dryRun: true }));
    const state = await readDryRunWriterState(engine, 'work');
    const out = { dryFirst, pagesAfterDry, first: first.status, dryNext, state: { open: state.open_requests, oldest: state.oldest_open_age_seconds, next: state.next }, pages: await titles(engine), holds: await holdsOf(engine) };
    expect(out).toMatchObject({ pagesAfterDry: {}, first: 'first_sync', state: { open: 0, oldest: null }, pages: { 'notes/alice-example': 'Alice Example' } });
    return out;
  }));

  parityTest('the stop a run recorded and the dry-run writer state read the same', {
    methods: ['worktreeClaimStore', 'listPages'],
    timeout: 240_000,
  }, async (engine, backend) => withManagedSource(engine, backend, { 'notes/alice-example.md': note('Alice Example', 'Works at acme-example.') }, async ({ sync }) => {
    const first = await sync();
    const incarnation = await incarnationOf(engine);
    const none = await recordedStop(engine, 'cursor-example', 'run-example');
    await recordManagedSyncFailure(engine, { source_id: 'work', source_incarnation: incarnation, path: 'notes/alice-example.md', code: 'storage_error', message: 'The write did not commit.',
      request_id: null, run_id: 'run-example', target: null, cursor_key: 'cursor-example', phase: 'freeze', state: 'failed', observation_id: 'observation-example' });
    const stop = await recordedStop(engine, 'cursor-example', 'run-example');
    const otherRun = await recordedStop(engine, 'cursor-example', 'run-other');
    const state = await readDryRunWriterState(engine, 'work');
    const out = { first: first.status, none, stop: stop && { versioned: typeof stop.gbrain_version === 'string' }, otherRun, state, pages: await titles(engine) };
    expect(out).toMatchObject({ none: null, stop: { versioned: true }, otherRun: null, state: { open_requests: 0, oldest_open_age_seconds: null } });
    return out;
  }));

  parityTest('gbrain sync status of a managed source with a hold, a recorded failure and an unfinished cursor reads the same', {
    methods: ['worktreeClaimStore', 'runSyncStatement'],
    timeout: 240_000,
  }, async (engine, backend) => withManagedSource(engine, backend, {
    'notes/alice-example.md': note('Alice Example', 'Works at acme-example.'),
    'notes/broken-example.md': '---\ntitle: [broken\n---\nCommitted, but its frontmatter does not parse.\n',
  }, async ({ sync }) => {
    const first = await sync();
    const incarnation = await incarnationOf(engine);
    const settled = await readSyncStatus(engine, 'work');
    // A recorded failure and an older release's unfinished cursor, seeded through the same statements a sync writes them with.
    await recordManagedSyncFailure(engine, { source_id: 'work', source_incarnation: incarnation, path: 'notes/alice-example.md', code: 'storage_error', message: 'The write did not commit.',
      request_id: null, run_id: 'run-example', target: null, cursor_key: 'cursor-example', phase: 'freeze', state: 'failed', observation_id: 'observation-example' });
    await engine.runSyncStatement('checkpoint_put_first', ['managed-sync', 'cursor-example', JSON.stringify({ runId: 'run-example', index: 2, total: 5, sourceId: 'work', incarnation, target: null, from: null,
      done: false, authority: { writer: { principal: { kind: 'local_cli', id: 'writer-example' } } }, processingOptions: {}, syncOptions: {} })]);
    const status = await readSyncStatus(engine, 'work');
    const freshness = await readSyncFreshness(engine, { sourceIds: ['work'] });
    const cli = await statusJson(engine);
    const project = (st: typeof status) => ({ holds: st.holds.map(hold => [hold.path, hold.code, hold.needs_human]), needs_human: st.needs_human, needs_human_from: st.needs_human_from,
      last_error: st.last_error && { code: st.last_error.code, phase: st.last_error.phase, path: st.last_error.path, attempts: st.last_error.attempts, superseded: !!st.last_error.superseded },
      cursor: st.cursor && { index: st.cursor.index, total: st.cursor.total, done: st.cursor.done }, run_id: st.run_id, blockers: st.checkpoint_blockers.length,
      cursors: st.cursors.map(cursor => ({ run_id: cursor.run_id, index: cursor.index, total: cursor.total, done: cursor.done, shown: cursor.shown, last_error_code: cursor.last_error_code })) });
    const out = { first: first.status, settled: project(settled), status: project(status),
      freshness: freshness.map(f => ({ source_id: f.source_id, samples: f.commit_to_searchable.samples, commits: f.commits })),
      cli: { holds: cli.holds_summary, last_error: cli.last_error?.code ?? null, freshness: cli.freshness && { samples: cli.freshness.commit_to_searchable.samples }, cursor: cli.cursor } };
    expect(out).toMatchObject({ first: 'first_sync', settled: { holds: [['notes/broken-example.md', 'invalid_frontmatter', expect.anything()]], last_error: null },
      status: { last_error: { code: 'storage_error', phase: 'freeze' }, cursor: { index: 2, total: 5, done: false } } });
    return out;
  }));

  parityTest('commit-to-searchable freshness and the landing gaps of a source synced twice read the same', {
    methods: ['worktreeClaimStore', 'listFreshnessTargets', 'listEmbeddingStateRows'],
    timeout: 240_000,
  }, async (engine, backend) => withManagedSource(engine, backend, {
    'notes/alice-example.md': note('Alice Example', 'Works at acme-example.'),
    'notes/bob-example.md': note('Bob Example', 'Works at widget-co.'),
  }, async ({ repo, root, sync }) => {
    const first = await sync();
    writeFileSync(join(root, 'notes', 'alice-example.md'), note('Alice Example Two', 'Now at globex-example.'));
    const head = commit(repo, 'edit alice');
    const second = await sync();
    await Bun.sleep(1_100);
    const [fresh] = await readSyncFreshness(engine, { sourceIds: ['work'], behind: async () => ({ commits: 0, oldest: null }) });
    const landing = await readLandingGaps(engine, 'work', { afterSeconds: 1 });
    const seconds = (value: number | null) => value === null ? null : value >= 0;
    const out = { first: first.status, second: second.status,
      fresh: { source: fresh!.source_id, samples: fresh!.commit_to_searchable.samples, p50: seconds(fresh!.commit_to_searchable.p50_seconds), p95: seconds(fresh!.commit_to_searchable.p95_seconds),
        embedded: fresh!.commit_to_embedded.samples, pending: fresh!.commit_to_embedded.pending, commits: fresh!.commits, unresolved: fresh!.unresolved_commits, waiting: fresh!.waiting_commits },
      landing: landing.status === 'ok' ? { checked: landing.checked, complete: landing.complete, gaps: landing.gaps, by_state: landing.by_state, slugs: landing.pages.map(page => page.slug).sort() } : landing,
      head: head.length };
    expect(out).toMatchObject({ second: 'synced', fresh: { samples: 1, p50: true, commits: 1, pending: 1 }, landing: { checked: 2, gaps: 2, by_state: { pending_embedding: 2 } } });
    return out;
  }));

  parityTest('the older cursor and checkpoint statements, the live-incarnation reads and the knock-on read answer the same', {
    methods: ['worktreeClaimStore', 'runSyncStatement', 'readPageSnapshot'],
    timeout: 240_000,
  }, async (engine, backend) => withManagedSource(engine, backend, { 'notes/alice-example.md': note('Alice Example', 'Works at acme-example.') }, async ({ sync }) => {
    const first = await sync();
    const incarnation = await incarnationOf(engine);
    const rows = async <R = Record<string, unknown>>(name: Parameters<BrainEngine['runSyncStatement']>[0], params: unknown[]) => { await ensureProcessRegistration(engine, 'parity'); return engine.runSyncStatement<R>(name, params, fenceOpts(engine)); };
    // The older cursor's frozen manifest (three entries) and its cursor, written as a sync writes them, then read as its checkpoint does.
    const entries = [0, 1, 2].map(i => ({ path: `notes/n${i}.md`, sourcePath: `notes/n${i}.md`, action: 'delete', working: false }));
    await rows('slice_put', ['managed-sync-manifest', 'run-example', JSON.stringify(entries)]);
    await rows('slice_put', ['managed-sync', 'cursor-example', JSON.stringify([{ runId: 'run-example', index: 3, total: 3, sourceId: 'work', incarnation, done: false }])]);
    const manifest = { at: (await rows<{ entry: { path: string } | null }>('manifest_entry', ['run-example', 1])).map(r => r.entry?.path ?? null),
      last: (await rows<{ entry: { path: string } | null }>('manifest_entry', ['run-example', -1])).map(r => r.entry?.path ?? null),
      beyond: (await rows<{ entry: unknown }>('manifest_entry', ['run-example', 7])).map(r => r.entry), missing: (await rows('manifest_entry', ['run-missing', 0])).length,
      length: (await rows<{ count: number }>('manifest_length', ['run-example'])).map(r => Number(r.count)), noLength: (await rows('manifest_length', ['run-missing'])).length };
    const locked = (await rows<{ completed_keys: Array<{ done: boolean }> }>('cursor_keys_locked', ['cursor-example'])).map(r => r.completed_keys[0]!.done);
    await rows('cursor_mark_done', ['cursor-example']);
    await rows('cursor_mark_done', ['cursor-missing']);
    const marked = (await rows<{ completed_keys: Array<{ done: boolean; runId: string }> }>('cursor_keys_locked', ['cursor-example'])).map(r => [r.completed_keys[0]!.done, r.completed_keys[0]!.runId]);
    const alice = (await engine.readPageSnapshot('notes/alice-example', { sourceId: 'work' }))!;
    const origin = { live: (await rows('live_page_at_origin', ['work', alice.page.id + 1000, 'notes/alice-example.md'])).length, own: (await rows('live_page_at_origin', ['work', alice.page.id, 'notes/alice-example.md'])).length,
      elsewhere: (await rows('live_page_at_origin', ['work', 0, 'notes/other.md'])).length };
    const sources = { live: (await rows<{ incarnation: string }>('source_live_incarnation', ['work'])).map(r => r.incarnation === incarnation), unknown: (await rows('source_live_incarnation', ['no-such-source'])).length,
      company: (await rows('source_company_brain', ['work'])).length, companyBrain: (await rows('source_company_brain', ['company-example'])).length, companyUnknown: (await rows('source_company_brain', ['no-such-source'])).length };
    // An id no request carries is no knock-on.
    const knockOn = (await rows('knock_on_requests', [['00000000-0000-4000-8000-000000000000', 'not-a-request-id']])).length;
    const out = { first: first.status, manifest, locked, marked, origin, sources, knockOn };
    expect(out).toMatchObject({ manifest: { at: ['notes/n1.md'], last: ['notes/n2.md'], beyond: [null], missing: 0, length: [3], noLength: 0 }, locked: [false], marked: [[true, 'run-example']],
      origin: { live: 1, own: 0, elsewhere: 0 }, sources: { live: [true], unknown: 0, company: 0, companyBrain: 1, companyUnknown: 0 }, knockOn: 0 });
    return out;
  }, { others: { 'company-example': { company_brain: { profile: 'example' } } } }));

  parityTest('a source that pins a slug-root mode at a subdirectory imports under that mode', {
    methods: ['worktreeClaimStore', 'listPages'],
    timeout: 240_000,
  }, async (engine, backend) => {
    const pinned = await withManagedSource(engine, backend, { 'notes/alice-example.md': note('Alice Example', 'Works at acme-example.') },
      async ({ sync }) => ({ status: (await sync()).status, pages: Object.keys(await titles(engine)) }), { scope: 'brain', config: { slug_root_mode: 'git-root' } });
    expect(pinned.pages).toEqual(['brain/notes/alice-example']);
    return pinned;
  });

  parityTest('a second pass over a changed checkout reads the whole table on Rust, with the pages the proof-carrying reuse gives the SQL engines', {
    methods: ['worktreeClaimStore', 'listPages'],
    timeout: 240_000,
  }, async (engine, backend) => withManagedSource(engine, backend, {
    'notes/alice-example.md': note('Alice Example', 'Works at acme-example.'),
    'notes/bob-example.md': note('Bob Example', 'Works at widget-co.'),
    'notes/carol-example.md': note('Carol Example', 'Works at initech-example.'),
  }, async ({ repo, root, sync }) => {
    const first = await sync();
    const incarnation = await incarnationOf(engine);
    writeFileSync(join(root, 'notes', 'alice-example.md'), note('Alice Example Two', 'Now at globex-example.'));
    commit(repo, 'edit alice');
    const second = await sync();
    writeFileSync(join(root, 'notes', 'dave-example.md'), note('Dave Example', 'Works at hooli-example.'));
    writeFileSync(join(root, 'notes', 'bob-example.md'), note('Bob Example Two', 'Now at pied-piper.'));
    commit(repo, 'add dave, edit bob');
    const third = await sync();
    // The confirm proof reads transaction ids: a Rust brain keeps none, so it answers `no_xids` and the round reads whole (the answers above are equal).
    const proof = await proveConfirm(engine, { sourceId: 'work', incarnation, passId: 'pass-example', base: { xmin: '1', ops: {}, holds: [] }, postgres: false })
      .then(p => p.ok ? 'proved' : p.reason, (error: { code?: string }) => `refused: ${error?.code ?? String(error)}`);
    // The fold's proof runs on the publishing transaction: its handle is a Rust one too.
    const txProof = await engine.transaction(tx => proveConfirm(tx, { sourceId: 'work', incarnation, passId: 'pass-example', base: { xmin: '1', ops: {}, holds: [] }, postgres: false, self: 'request-example' }))
      .then(p => p.ok ? 'proved' : p.reason, (error: { code?: string }) => `refused: ${error?.code ?? String(error)}`);
    const mark = backend === 'rust' ? null : await readLevelMark(engine, 'work', incarnation).then(m => typeof m.xmin, () => 'refused');
    const out = { first: first.status, second: second.status, third: third.status, pages: await titles(engine), holds: await holdsOf(engine) };
    expect(backend === 'rust' ? { proof, txProof, mark } : { proofTaken: proof !== 'no_xids' && txProof !== 'no_xids', mark }).toEqual(backend === 'rust' ? { proof: 'no_xids', txProof: 'no_xids', mark: null } : { proofTaken: true, mark: 'string' });
    expect(out).toMatchObject({ second: 'synced', third: 'synced', pages: { 'notes/alice-example': 'Alice Example Two', 'notes/bob-example': 'Bob Example Two', 'notes/dave-example': 'Dave Example' } });
    return out;
  }));
});
