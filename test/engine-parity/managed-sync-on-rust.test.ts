/**
 * Engine parity: a whole managed sync on a Rust brain, with the user-facing hold kept (lane LM, slice 2).
 *
 * Every case lifts the `managed_persistence` hold on its own Rust test engine (rust-managed.ts `liftManagedHold`), then runs
 * `performSync` of a claimed, activated Git checkout; `servedCapabilities()` still withholds the capability.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a managed sync imports the committed notes, a second sync with no new commit answers `up_to_date`, a sync after a
 *    commit that adds, edits and deletes notes applies exactly those changes, and a file the sync cannot import is held (the
 *    page is not written and the sync reports it) while the others import. Each is equal to PGLite and Postgres.
 *  - Regression: the managed sync read its rows through `executeRaw`, which the Rust engine refuses, so a managed import
 *    could not run on a Rust brain (conflict row 47; gbrain-evals bb9-004, bb9-007, bb9-009).
 *  - Why existing coverage misses it: sync-stamp.test.ts counted the Rust refusal as a named stop, and the managed sync suites
 *    run PGLite and Postgres only.
 *  - Seam: real engines and real Git checkouts; no fault hooks.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { liftManagedHold } from './rust-managed.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { performSync } from '../../src/commands/sync.ts';
import { readGitSourceHolds } from '../../src/core/persistence/sync-holds.ts';
import { servedCapabilities } from '../../src/core/rust-engine/store-capabilities.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';

const { parityTest } = parityArms(testBackends());

const GIT_ID = ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid'];
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const note = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}\n`;
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, ...GIT_ID, 'commit', '-qm', message); };

/** Lifts the hold on the Rust arm's engine, then runs `run` with source `work` claimed and activated on a Git checkout. */
async function withSyncedCheckout<T>(engine: BrainEngine, backend: ParityBackend, files: Record<string, string>,
  run: (root: string, sync: () => Promise<{ status: string; error?: { code?: string } }>) => Promise<T>): Promise<T> {
  if (backend === 'rust') liftManagedHold(engine);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-managed-sync-on-rust-')));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const root = join(home, 'checkout');
      mkdirSync(join(root, 'notes'), { recursive: true });
      git(root, 'init', '-q', '-b', 'main');
      for (const [path, body] of Object.entries(files)) writeFileSync(join(root, path), body);
      commit(root, 'notes');
      await createSource(engine, backend, 'work', {}, root);
      try {
        const reviewed = async (operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
        await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed('writer_claim') });
        await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed('writer_activate') });
        // The raw error rides along unseen by toEqual so a refusal on the Rust arm still ends the case as stopped.
        const sync = () => performSync(engine, { sourceId: 'work', repoPath: root, noPull: true, noEmbed: true, noExtract: true })
          .then(r => r as { status: string; error?: { code?: string } }, (error: { code?: string }) => {
            if (error?.code === 'engine_capability_missing') throw error;
            return Object.defineProperty({ status: `refused: ${error?.code ?? String(error)}` }, 'error', { value: error, enumerable: false }) as { status: string };
          });
        return await run(root, sync);
      } finally { await disposePersistenceConsumer(engine); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** The live pages of source `work`, slug to title, and the sync's own status word. */
async function pagesOf(engine: BrainEngine): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const page of await engine.listPages({ sourceId: 'work', limit: 100 })) out[page.slug] = page.title ?? null;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
const imported = (status: string) => ['first_sync', 'synced'].includes(status) ? 'imported' : status;

describe('a whole managed sync on a Rust brain', () => {
  parityTest('managed mode is served on a single-host Rust brain', { methods: ['getConfig'] }, async (engine) => {
    await engine.getConfig('managed_sync_on_rust_probe');
    const out = { served: servedCapabilities().has('managed_persistence') };
    expect(out).toEqual({ served: true });
    return out;
  });

  parityTest('a managed sync imports the checkout, and a second sync with no new commit answers up_to_date', {
    methods: ['worktreeClaimStore', 'listPages', 'getSource'],
    timeout: 180_000,
  }, async (engine, backend) => withSyncedCheckout(engine, backend, {
    'notes/alice-example.md': note('Alice Example', 'Works at acme-example.'),
    'notes/bob-example.md': note('Bob Example', 'Works at widget-co.'),
  }, async (_root, sync) => {
    const first = await sync();
    const firstPages = await pagesOf(engine);
    const stamped = (await engine.getSource('work'))?.last_sync_at != null;
    const second = await sync();
    const out = { first: imported(first.status), firstPages, stamped, second: second.status, secondPages: await pagesOf(engine) };
    expect(out).toEqual({ first: 'imported', firstPages: { 'notes/alice-example': 'Alice Example', 'notes/bob-example': 'Bob Example' },
      stamped: true, second: 'up_to_date', secondPages: { 'notes/alice-example': 'Alice Example', 'notes/bob-example': 'Bob Example' } });
    return out;
  }));

  parityTest('a sync after a commit that adds, edits and deletes notes applies exactly those changes', {
    methods: ['worktreeClaimStore', 'listPages', 'getPage'],
    timeout: 180_000,
  }, async (engine, backend) => withSyncedCheckout(engine, backend, {
    'notes/alice-example.md': note('Alice Example', 'Works at acme-example.'),
    'notes/bob-example.md': note('Bob Example', 'Works at widget-co.'),
  }, async (root, sync) => {
    const first = await sync();
    writeFileSync(join(root, 'notes', 'carol-example.md'), note('Carol Example', 'Works at initech-example.'));
    writeFileSync(join(root, 'notes', 'alice-example.md'), note('Alice Example Edited', 'Now at globex-example.'));
    unlinkSync(join(root, 'notes', 'bob-example.md'));
    commit(root, 'add carol, edit alice, delete bob');
    const second = await sync();
    const out = { first: imported(first.status), second: imported(second.status), pages: await pagesOf(engine),
      bobGone: (await engine.getPage('notes/bob-example', { sourceId: 'work' })) === null,
      aliceBody: ((await engine.getPage('notes/alice-example', { sourceId: 'work' }))?.compiled_truth ?? '').trim() };
    expect(out).toEqual({ first: 'imported', second: 'imported', pages: { 'notes/alice-example': 'Alice Example Edited', 'notes/carol-example': 'Carol Example' },
      bobGone: true, aliceBody: 'Now at globex-example.' });
    return out;
  }));

  parityTest('a file the sync cannot import is held while the others import', {
    methods: ['worktreeClaimStore', 'listPages'],
    timeout: 180_000,
  }, async (engine, backend) => withSyncedCheckout(engine, backend, {
    'notes/alice-example.md': note('Alice Example', 'Works at acme-example.'),
    'notes/broken-example.md': '---\ntitle: [broken\n---\nCommitted, but its frontmatter does not parse.\n',
  }, async (_root, sync) => {
    const first = await sync();
    const holds = ((await readGitSourceHolds(engine, { sourceIds: ['work'] }))[0]?.holds ?? []).map(hold => ({ path: hold.path, code: hold.code })).sort((a, b) => a.path.localeCompare(b.path));
    const out = { first: first.status, pages: await pagesOf(engine), holds };
    expect(out).toEqual({ first: 'first_sync', pages: { 'notes/alice-example': 'Alice Example' }, holds: [{ path: 'notes/broken-example.md', code: 'invalid_frontmatter' }] });
    return out;
  }));

  parityTest('a named sync statement answers the source row and the pass checkpoint the sync left', {
    methods: ['worktreeClaimStore', 'runSyncStatement'],
    timeout: 180_000,
  }, async (engine, backend) => withSyncedCheckout(engine, backend, { 'notes/alice-example.md': note('Alice Example', 'Works at acme-example.') }, async (root, sync) => {
    const before = (await engine.runSyncStatement<{ archived: boolean; local_path: string | null; last_commit: string | null }>('source_row', ['work']))[0];
    await sync();
    const after = (await engine.runSyncStatement<{ last_commit: string | null }>('source_row', ['work']))[0];
    const head = git(root, 'rev-parse', 'HEAD').trim();
    const passRows = await engine.runSyncStatement<{ value: { telemetry?: { outcome?: string } } | null }>('checkpoint_first',
      ['managed-sync-pass', `work:${(await engine.readSourceMembership('work'))!.incarnation}`]);
    const missing = await engine.runSyncStatement('source_row', ['no-such-source']);
    const out = { archived: before!.archived, rooted: before!.local_path === root, beforeCommit: before!.last_commit, imported: after!.last_commit === head,
      pass: passRows.length, missing: missing.length };
    expect(out).toEqual({ archived: false, rooted: true, beforeCommit: null, imported: true, pass: 1, missing: 0 });
    return out;
  }));
});
