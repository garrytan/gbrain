/**
 * Engine parity for the three bench save failures (gbrain-evals N1/N5, surface-parity, N14): a page write to a
 * source a user can save to commits on every engine and never stays queued.
 *
 * Fail-first: on rust-engine/main 0ce95bbf7f and rust-engine/bound-write-rust 3d53109dc0 every case here fails on the
 * Rust arm only. Each fix lane keeps its case as written and makes it pass on Rust. Case 2's pin is gone (the Rust
 * createVersion member serves the preimage option, so the write commits), and so is case 3's: the chronicle decision
 * runs through typed members (rust-engine/chronicle-decision-rust), so the page commits on every arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: (1) a put_page to a git-rooted source that no writer claimed commits the page and writes its file on
 *    a single-process engine (PGLite), refuses owner_unavailable on Postgres until a writer claims it, and refuses
 *    engine_capability_missing (managed_persistence) on a Rust brain, which holds managed mode;
 *    (2) a forced update of an existing page commits, and a later write in the same source behind it commits;
 *    (3) a new conversation page (chronicle-shaped) commits.
 *  - Regression: (1) persistence/unbound-source.ts decideUnboundWrite auto-claims only for PGLite, so Rust refuses
 *    owner_unavailable (unbound_source); (2) the Rust createVersion member refuses the `preimage` option
 *    (import-file.ts), and coordinator.ts finishUnpublishedFailure releases a publication-stage capability refusal
 *    back to queued with no attempt limit, so the write and every write behind it stay write_pending; (3) the
 *    chronicle decision ran raw SQL (chronicle/ledger.ts), refused on Rust the same way; it now runs through typed
 *    engine members, so case 3 commits on every arm (test/engine-parity/chronicle-decision.test.ts).
 *  - Why existing coverage misses it: test/persistence-*.test.ts run on PGLite and Postgres only, and the Rust arm of
 *    the other parity cases never writes to an unclaimed rooted source, updates a page through put_page, or writes a
 *    chronicle-shaped page.
 *  - Seam: none. Real engines, the put_page/add_tag operation handlers, a real Git checkout for case 1.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';

const { parityTest } = parityArms(testBackends());

const ctxFor = (engine: BrainEngine, sourceId: string) => ({ engine, sourceId, remote: false as const, writeWaitMs: 8000,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {}, debug() {} } });
const run = async (engine: BrainEngine, name: string, params: Record<string, unknown>, sourceId = 'default') => {
  try {
    const r = await operations.find(o => o.name === name)!.handler(ctxFor(engine, sourceId) as never, params) as Record<string, unknown>;
    return { ok: true, state: r.state ?? null, status: r.status ?? null };
  } catch (error) {
    // The raw error rides along unseen by toEqual, so a case that ends on a typed refusal can rethrow it.
    return Object.defineProperty({ ok: false, code: (error as { code?: string }).code ?? String(error) }, 'error', { value: error, enumerable: false });
  }
};
const person = (n: string) => `---\ntitle: Carol\ntype: person\n---\nCarol ${n}.\n`;
const COMMITTED = { ok: true, state: 'committed', status: 'created_or_updated' };

describe('the bench save failures', () => {
  parityTest('case 1: put_page to a git-rooted source no writer claimed commits the page and its file', {
    methods: ['getPage'],
    requires: 'managed_persistence',
    timeout: 60_000,
  }, async (engine, backend) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-bench-save-parity-')));
    try {
      return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const root = join(home, 'vault');
        mkdirSync(join(root, 'notes'), { recursive: true });
        execFileSync('git', ['-C', root, 'init', '-q']);
        writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
        execFileSync('git', ['-C', root, 'add', '.']);
        execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes']);
        await createSource(engine, backend, 'vault', {}, root);
        try {
          const put = await run(engine, 'put_page', { slug: 'notes/bob-example', content: '---\ntitle: Bob Example\n---\nBob works at widget-co.\n' }, 'vault');
          const page = await engine.getPage('notes/bob-example', { sourceId: 'vault' });
          const file = join(root, 'notes', 'bob-example.md');
          const out = { put, page: page !== null, file: existsSync(file) && readFileSync(file, 'utf8').includes('widget-co') };
          // Postgres is a multi-process engine: an unclaimed rooted source refuses until `gbrain sources writer claim`
          // (by design, #6608). PGLite is a single-process engine (consumer-election.ts) and claims it. A Rust brain refuses
          // managed mode (capability managed_persistence, held in store-capabilities.ts), so the claim refuses by name and
          // nothing is written.
          // With the hold lifted on this test engine (GBRAIN_TEST_RUST_MANAGED=1, rust-managed.ts), Rust is a
          // single-process engine like PGLite and follows PGLite's rule below.
          const lifted = backend === 'rust' && engine.capabilities?.has('managed_persistence') === true;
          if (backend === 'rust' && !lifted) {
            // Named stop, by design (Garry, B2, Nov 22): managed_persistence refused by design on Rust (B2) until the
            // Rust engine carries managed mode. A capability refusal takes the in-test pin (harness.ts: assert the
            // refusal, rethrow it), so the Rust arm counts the case as stopped and never as equal.
            const refusal = (put as { error?: { detail?: unknown } }).error;
            expect({ ...out, managedPersistence: String(refusal?.detail ?? '').includes('capability=managed_persistence') },
              'managed_persistence refused by design on Rust (B2)').toEqual(
              { put: { ok: false, code: 'engine_capability_missing' }, page: false, file: false, managedPersistence: true });
            throw refusal;
          }
          const rule = backend === 'postgres'
            ? { put: { ok: false, code: 'owner_unavailable' }, page: false, file: false }
            : { put: COMMITTED, page: true, file: true };
          expect(out).toEqual(rule);
          return { followedItsEngineRule: true };
        } finally { await disposePersistenceConsumer(engine); }
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  parityTest('case 2: a forced update of an existing page commits, and a later write behind it commits', { methods: ['createVersion', 'getPage'] }, async (engine) => {
    try {
      const created = await run(engine, 'put_page', { slug: 'people/carol-example', content: person('v1') });
      const updated = await run(engine, 'put_page', { slug: 'people/carol-example', content: person('v2'), force: true });
      const later = await run(engine, 'add_tag', { slug: 'people/carol-example', tag: 'friend' });
      const page = await engine.getPage('people/carol-example', { sourceId: 'default' });
      const out = { created, updated, later, hasV2: String(page?.compiled_truth ?? '').includes('v2') };
      expect(out).toEqual({ created: COMMITTED, updated: COMMITTED, later: { ok: true, state: 'committed', status: 'ok' }, hasV2: true });
      return out;
    } finally { await disposePersistenceConsumer(engine); }
  });

  parityTest('case 3: a new conversation part (chronicle-shaped) commits', { methods: ['readPageSnapshot'] }, async (engine) => {
    try {
      const big = '---\ntitle: Conv\ntype: conversation\n---\n' + 'User: hello there, this is a long line of conversation text.\n'.repeat(90);
      const part = await run(engine, 'put_page', { slug: 'conversations/conv-example/part-1', content: big });
      expect(part).toEqual(COMMITTED);
      return part;
    } finally { await disposePersistenceConsumer(engine); }
  });
});
