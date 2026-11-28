/**
 * Engine parity: a managed sync and the git-gap census when a transaction runs its callback again.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a transaction callback may run more than once (the multi-user Rust engine runs it again from a fresh snapshot
 *    after a commit lost on write_conflict, design interface I-1), and only the run that commits counts. So a managed sync
 *    whose cursor steps run twice still admits, holds and imports what a sync with no rerun does; a pass whose marker
 *    retirement runs twice counts each retired marker once; a git-gap census whose batch runs twice counts and collects each
 *    page once. Every arm answers the same.
 *  - Regression: the in-memory batch of a live pass (sync-pass-batch.ts) moved inside the step's transaction, so a rerun saw
 *    the batch already moved: its compare-and-swap failed, the admission or the hold write that rode the step was rolled
 *    back, and the pass went on from a batch that named work no committed row held. retireMarkers counted inside
 *    inFencedSlices' write, so a rerun counted a marker twice. censusGitGap added to its census and called `collect` inside
 *    the batch transaction, so a rerun counted and collected each page twice.
 *  - Why existing coverage misses it: no case makes these transactions run twice; the multi-user lanes meet a rerun only
 *    under contention, by chance.
 *  - Seam: none in production. force-rerun.ts wraps engine.transaction and forces each run that a spy marks (the spy wraps
 *    the function the callback calls with its tx and calls the original). On a multi-user Rust brain the forced run ends with
 *    a write_conflict error, so the engine's real optimistic retry runs the callback again; every other arm runs it once in
 *    a transaction it rolls back and once for real.
 *  - Not forced on the served Rust arm (GBRAIN_TEST_RUST_SERVED=1): there the owner behind the served client runs the
 *    transactions on its own engine, out of the case's reach. The cases still run there and check the same end state.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, spyOn } from 'bun:test';
import express from 'express';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { liftManagedHold } from './rust-managed.ts';
import { rustMuArmRequested, rustServedRequested } from './rust-arm.ts';
import { forceRerunOnHit, type ForcedRerun } from './force-rerun.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { performSync } from '../../src/commands/sync.ts';
import { censusGitGap, type GitGapPage } from '../../src/commands/sources-git-gap.ts';
import { mountAdminRegistration } from '../../src/commands/serve-http-registration.ts';
import { readGitSourceHolds } from '../../src/core/persistence/sync-holds.ts';
import { readPassRow } from '../../src/core/persistence/sync-pass-row.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import * as passBatch from '../../src/core/persistence/sync-pass-batch.ts';
import * as markers from '../../src/core/persistence/sync-markers.ts';

const { parityTest } = parityArms(testBackends());

const GIT_ID = ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid'];
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const note = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}\n`;
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, ...GIT_ID, 'commit', '-qm', message); };

type Result = { status: string } & Record<string, unknown>;

/** Whether this arm forces anything: the served arm's owner runs the transactions where the case cannot reach them (header). */
const forcing = () => !rustServedRequested();

/** On the multi-user arm the engine must take the optimistic path, or the case proves nothing about it. */
function assertArm(engine: BrainEngine, backend: ParityBackend, rerun: ForcedRerun | null): void {
  if (backend === 'rust' && rustMuArmRequested() && !rustServedRequested()) {
    expect((engine as { multiuser?: boolean }).multiuser).toBe(true);
    expect(rerun?.seen.multiuser).toBe(true);
  }
}

/** Lifts the hold on the Rust arm's engine, then runs `run` with source `work` claimed and activated on a Git checkout. */
async function withManagedSource<T>(engine: BrainEngine, backend: ParityBackend, files: Record<string, string>,
  run: (ctx: { root: string; sync: (options?: Record<string, unknown>) => Promise<Result> }) => Promise<T>): Promise<T> {
  if (backend === 'rust') liftManagedHold(engine);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-sync-txn-rerun-')));
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
        const sync = (options: Record<string, unknown> = {}) => performSync(engine, { sourceId: 'work', repoPath: root, noPull: true, noEmbed: true, noExtract: true, ...options })
          .then(r => r as unknown as Result, (error: { code?: string }) => {
            if (error?.code === 'engine_capability_missing') throw error;
            return { status: `refused: ${error?.code ?? String(error)}` } as Result;
          });
        return await run({ root, sync });
      } finally { await disposePersistenceConsumer(engine); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Runs `body` with every transaction run that `mark` flags forced once; the spies and the wrapper are restored after. */
async function forced<T>(engine: BrainEngine, mark: (rerun: ForcedRerun) => Array<{ mockRestore(): void }>, body: (rerun: ForcedRerun | null) => Promise<T>,
  opts: Parameters<typeof forceRerunOnHit>[1] = {}): Promise<T> {
  if (!forcing()) return body(null);
  const rerun = forceRerunOnHit(engine, opts);
  const spies = mark(rerun);
  try { return await body(rerun); } finally { for (const spy of spies) spy.mockRestore(); rerun.restore(); }
}

const holdsOf = async (engine: BrainEngine) => ((await readGitSourceHolds(engine, { sourceIds: ['work'] }))[0]?.holds ?? [])
  .map(hold => ({ path: hold.path, code: hold.code })).sort((a, b) => a.path.localeCompare(b.path));
const titles = async (engine: BrainEngine) => Object.fromEntries((await engine.listPages({ sourceId: 'work', limit: 100 }))
  .map(page => [page.slug, page.title ?? null]).sort(([a], [b]) => String(a).localeCompare(String(b))));
const dbEdit = (engine: BrainEngine, slug: string, body: string) => engine.transaction(tx => withCoordinatedWrite(tx, ['work'], () => tx.putPage(slug, {
  type: 'note', title: 'Edited in the database', compiled_truth: body, timeline: '', frontmatter: {}, content_hash: `h-${body.length}` }, { sourceId: 'work' }), TEST_WRITE_ATTRIBUTION));
const ctxFor = (engine: BrainEngine) => ({ engine, sourceId: 'work', remote: false as const,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {} } });

describe('engine parity: a managed sync and the git-gap census when a transaction runs again', () => {
  parityTest('a sync whose pass-batch steps each run twice admits, holds and imports what a sync with no rerun does', {
    methods: ['worktreeClaimStore', 'listPages', 'readPageSnapshot'],
    timeout: 240_000,
  }, async (engine, backend) => withManagedSource(engine, backend, {
    'notes/alice-example.md': note('Alice Example', 'Works at acme-example.'),
    'notes/bob-example.md': note('Bob Example', 'Works at widget-co.'),
    'notes/carol-example.md': note('Carol Example', 'Works at fund-a.'),
  }, async ({ root, sync }) => {
    const first = await sync();
    await dbEdit(engine, 'notes/alice-example', 'Edited straight in the database.');
    writeFileSync(join(root, 'notes', 'alice-example.md'), note('Alice Example', 'Edited in Git.'));
    writeFileSync(join(root, 'notes', 'bob-example.md'), note('Bob Example', 'Now at widget-co-two.'));
    writeFileSync(join(root, 'notes', 'dave-example.md'), note('Dave Example', 'New at acme-example.'));
    commit(root, 'edit alice and bob, add dave');
    // Every transaction run in which a step of the pass's in-memory batch landed is forced to run once more.
    const { second, forcedSteps } = await forced(engine, rerun => {
      const step = passBatch.passBatchStep;
      return [spyOn(passBatch, 'passBatchStep').mockImplementation((async (tx: Parameters<typeof step>[0], ...rest: unknown[]) => {
        const landed = await (step as (...args: unknown[]) => Promise<boolean>)(tx, ...rest);
        if (landed) rerun.hit(tx);
        return landed;
      }) as typeof step)];
    }, async rerun => {
      assertArm(engine, backend, rerun);
      const second = await sync();
      return { second, forcedSteps: rerun?.seen.forced ?? null };
    });
    if (forcing()) expect(forcedSteps).toBeGreaterThan(0);
    const third = await sync();
    const alice = (await engine.readPageSnapshot('notes/alice-example', { sourceId: 'work' }))!;
    const out = { first: first.status, second: second.status, third: third.status, holds: await holdsOf(engine), pages: await titles(engine),
      alice: alice.page.compiled_truth.trim(), bob: (await engine.getPage('notes/bob-example', { sourceId: 'work' }))!.compiled_truth.trim() };
    expect(out).toMatchObject({ second: 'synced', holds: [{ path: 'notes/alice-example.md', code: 'file_drift' }], alice: 'Edited straight in the database.', bob: 'Now at widget-co-two.',
      pages: { 'notes/alice-example': 'Edited in the database', 'notes/bob-example': 'Bob Example', 'notes/carol-example': 'Carol Example', 'notes/dave-example': 'Dave Example' } });
    return out;
  }));

  parityTest('a pass whose marker retirement runs twice counts the retired marker once', {
    methods: ['worktreeClaimStore', 'listPages'],
    timeout: 240_000,
  }, async (engine, backend) => withManagedSource(engine, backend, {
    'notes/alice-example.md': note('Alice Example', 'Works at acme-example.'),
    'notes/bob-example.md': note('Bob Example', 'Works at widget-co.'),
  }, async ({ root, sync }) => {
    await engine.setConfig('sync.write_through', 'false');
    const first = await sync();
    // git rm, delete, purge, commit: the next full round retires the origin-deleted marker (probe 44).
    git(root, 'rm', '-q', 'notes/alice-example.md');
    for (const purge of [false, true]) {
      const snapshot = await engine.readPageSnapshot('notes/alice-example', { sourceId: 'work', includeDeleted: true });
      const outcome = await submitPageMutation(ctxFor(engine) as never, { operation: 'delete_page',
        params: { slug: 'notes/alice-example', request_id: randomUUID(), expected_revision: snapshot!.revision, ...(purge ? { purge: true } : {}) }, waitMs: 30_000 });
      expect(outcome.state).toBe('committed');
    }
    commit(root, 'remove alice');
    const { second, forcedRuns } = await forced(engine, rerun => {
      const retire = markers.retireOriginDeletedMarker;
      return [spyOn(markers, 'retireOriginDeletedMarker').mockImplementation(async (tx, input) => {
        const retired = await retire(tx, input);
        if (retired) rerun.hit(tx);
        return retired;
      })];
    }, async rerun => {
      assertArm(engine, backend, rerun);
      const second = await sync();
      return { second, forcedRuns: rerun?.seen.forced ?? null };
    });
    if (forcing()) expect(forcedRuns).toBe(1);
    const incarnation = (await engine.readSourceMembership('work'))!.incarnation;
    const row = await readPassRow(engine, 'work', incarnation);
    const out = { first: first.status, second: second.status, markersRetired: row?.value.telemetry.counts.markers_retired ?? null, pages: await titles(engine) };
    expect(out).toMatchObject({ second: 'synced', markersRetired: 1, pages: { 'notes/bob-example': 'Bob Example' } });
    return out;
  }));

  parityTest('a git-gap census whose page batch stops mid-run and runs again counts and collects each page once', {
    methods: ['readGitGapPageBatch', 'countGitGapLivePages', 'countGitGapTimelineOnPages'],
    timeout: 120_000,
  }, async (engine, backend) => {
    // A checkout with none of the pages' files: each page counts as a page with no file, whose facts and timeline rows the
    // batch counts after it counted the page.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-sync-txn-rerun-census-')));
    try {
      git(root, 'init', '-q', '-b', 'main');
      writeFileSync(join(root, 'README.md'), 'Not a page.\n');
      commit(root, 'readme');
      await createSource(engine, backend, 'work', {}, root);
      for (const name of ['alice-example', 'bob-example', 'carol-example']) {
        await engine.putPage(`notes/${name}`, { type: 'note', title: name, compiled_truth: `About ${name}.`, timeline: '', frontmatter: {} }, { sourceId: 'work' });
      }
      return await censusCase(engine, backend);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  parityTest('a client registration whose duplicate-name check runs again registers when the committed run saw no duplicate', {
    methods: ['lockOauthClientName', 'readLiveOauthClients', 'readOauthClientColumns'],
    timeout: 120_000,
  }, async (engine, backend) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-sync-txn-rerun-register-')));
    const name = 'rerun-register-example';
    try {
      return await withEnv({ GBRAIN_HOME: home }, () => forced(engine, () => [], async rerun => {
        assertArm(engine, backend, rerun);
        // The first run of the registration's transaction reads a live client under the same name; the run it is forced into
        // reads the real rows, which hold none. Only the committed run's answer counts.
        let first = true;
        const seen = new Proxy(engine, { get(target, key) {
          if (key === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>, opts?: Parameters<BrainEngine['transaction']>[1]) => target.transaction((tx: BrainEngine) => fn(new Proxy(tx, { get(inner, prop) {
            if (prop === 'readLiveOauthClients' && first && rerun) return async () => {
              first = false;
              rerun.hit(tx);
              return [...await inner.readLiveOauthClients(), { client_id: 'gbrain_cl_duplicate-example', client_name: name }];
            };
            const value = Reflect.get(inner, prop);
            return typeof value === 'function' ? value.bind(inner) : value;
          } })), opts);
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        const app = express();
        mountAdminRegistration(app, (_req, _res, next) => next(), seen, new URL('https://brain.example/mcp'), new URL('https://brain.example'));
        const server = app.listen(0, '127.0.0.1');
        try {
          const { port } = server.address() as { port: number };
          const response = await fetch(`http://127.0.0.1:${port}/admin/api/register-client`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, harness: 'generic', tokenEndpointAuthMethod: 'client_secret_post', grantTypes: ['authorization_code', 'refresh_token'], redirectUris: ['https://client.example/callback'] }) });
          const body = await response.json() as Record<string, unknown>;
          if (rerun) expect(rerun.seen.forced).toBe(1);
          const live = (await engine.readLiveOauthClients()).filter(client => client.client_name === name);
          const out = { status: response.status, error: body.error ?? null, live: live.length, sameClient: live.length === 1 && body.clientId === live[0]!.client_id };
          expect(out).toEqual({ status: 200, error: null, live: 1, sameClient: true });
          return { status: out.status, live: out.live };
        } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
      }));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

/** Two censuses of source `work`, the second with its first page batch stopped mid-run once: both count and collect the same. */
async function censusCase(engine: BrainEngine, backend: ParityBackend) {
  const census = async () => {
    const pages: GitGapPage[] = [];
    const result = await censusGitGap(engine, 'work', { sample: 10, collect: page => { pages.push(page); } });
    return { result, collected: pages.map(page => `${page.slug}:${page.state}`).sort() };
  };
  const plain = await census();
  // The first page batch's run stops at its count of the batch's timeline rows, after it counted the batch's pages: a read
  // that met a held key, which the multi-user engine answers with write_conflict mid-run.
  const rerunCensus = await forced(engine, () => [], async rerun => {
    assertArm(engine, backend, rerun);
    const out = await census();
    if (rerun) expect(rerun.seen.forced).toBe(1);
    return out;
  }, { conflictAt: ['countGitGapTimelineOnPages'], limit: 1 });
  expect(plain.result.pages).toBe(3);
  expect(rerunCensus).toEqual(plain);
  // Each arm's checkout lives in its own temporary directory, with its own commit; the arms compare the rest.
  return { ...plain, result: { ...plain.result, checkout: null, head: null } };
}
