/**
 * Engine parity: a managed publication whose transaction runs again after it wrote the page file
 * (src/core/persistence/coordinator.ts publishMutation), on every engine arm (PGLite always; Postgres with DATABASE_URL;
 * the Rust arm with GBRAIN_TEST_RUST_ARM=1, multi-user with GBRAIN_TEST_RUST_MU_ARM=1).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a bound put_page publishes its file inside the publication transaction. When that transaction loses
 *    and runs again (a multi-user Rust `write_conflict`: the engine runs the body again), the write still commits once:
 *    the request ends committed with no error, the page row exists and the file holds the new bytes.
 *  - Regression: the run that lost left the new file in place, so the next run's "file still holds its prior bytes"
 *    check refused the write as a local edit (`source_changed`) and the request ended failed, with the file put back.
 *  - Why existing coverage misses it: no case made the publication transaction lose after its file publication; the
 *    single-writer engines never run a transaction body twice.
 *  - Seam: the publication fault hook (persistence/fault-points.ts) marks the run that published, and `forceRerun`
 *    replaces the engine's `transaction` for the case. It makes the first publishing run lose once, at the named point:
 *    on a multi-user Rust engine it throws `write_conflict`, so the engine's own optimistic retry runs the body again;
 *    on the other arms it rolls the run back and runs the body again in a new transaction, as that retry does.
 *    Real engines, real Git checkouts.
 *  - The grouped cases pin the same contract for a managed file import, which the owner publishes as one group
 *    (group-publish.ts publishGroup). Their files hold text the import rewrites to canonical form, so a rerun after the
 *    files were written meets its own new bytes: the group rolls back, restores the files and requeues its members, and
 *    each member then commits on its own.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, rustArmMultiuser, type ParityBackend } from './harness.ts';
import { liftManagedHold } from './rust-managed.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { readLocalWriter } from '../../src/core/persistence/identity.ts';
import { resetWriteSwitches } from '../../src/core/persistence/switches.ts';
import { importManagedFiles } from '../../src/core/persistence/import-mutations.ts';

const { parityTest } = parityArms(testBackends());

const GIT_ID = ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid'];
const FORCED = 'forced rerun of the publication transaction (test seam)';
const BODY = 'Works at widget-co.';

/** Runs `run` under a scratch GBRAIN_HOME with source `work` on a one-note Git checkout, claimed by this host. */
async function withClaimedCheckout<T>(engine: BrainEngine, backend: ParityBackend, run: (root: string) => Promise<T>): Promise<T> {
  if (backend === 'rust') liftManagedHold(engine);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-publication-rerun-')));
  try {
    // The single-write group path (Postgres only) publishes through a reserved connection's transaction, which the seam
    // does not replace; with it off every arm publishes through publishMutation, the path a multi-user Rust engine takes.
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SINGLE_WRITE_GROUP: '0' }, async () => {
      resetWriteSwitches();
      const root = join(home, 'checkout');
      mkdirSync(join(root, 'notes'), { recursive: true });
      execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
      execFileSync('git', ['-C', root, 'config', 'user.name', 'Example']);
      execFileSync('git', ['-C', root, 'config', 'user.email', 'example@example.invalid']);
      writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
      execFileSync('git', ['-C', root, 'add', '.']);
      execFileSync('git', ['-C', root, ...GIT_ID, 'commit', '-qm', 'notes']);
      await createSource(engine, backend, 'work', {}, root);
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root,
        admin_intent: 'writer_claim', expected_state: await writerAdminState(engine) });
      try { return await run(root); } finally { await disposePersistenceConsumer(engine); }
    }).finally(resetWriteSwitches);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Makes the first publication run that wrote its file lose once: at `after_publication` (inside the body, right after
 * the file was written) or at `body_end` (the body finished; the commit is what loses).
 */
function forceRerun(engine: BrainEngine, at: 'after_publication' | 'body_end') {
  const seen = { forced: 0, publications: 0 };
  const multiuser = (engine as { multiuser?: boolean }).multiuser === true;
  const lose = () => multiuser ? Object.assign(new Error(FORCED), { code: 'write_conflict' }) : new Error(FORCED);
  installFaultHook(async (point) => {
    if (point !== 'publication:after_publication') return;
    seen.publications++;
    if (at === 'after_publication' && seen.forced === 0) { seen.forced++; throw lose(); }
  });
  let holder: object | null = engine;
  let found: PropertyDescriptor | undefined;
  while (holder && !(found = Object.getOwnPropertyDescriptor(holder, 'transaction'))) holder = Object.getPrototypeOf(holder);
  const original = found!.value as (...args: unknown[]) => Promise<unknown>;
  const transaction = async function (this: unknown, fn: (tx: BrainEngine) => Promise<unknown>, ...rest: unknown[]) {
    const call = (cb: (tx: BrainEngine) => Promise<unknown>) => original.call(this, cb, ...rest);
    const before = seen.forced;
    const once = async (tx: BrainEngine) => {
      // Counted, not flagged: a transaction the body opens itself runs inside this one and publishes nothing.
      const start = seen.publications;
      const value = await fn(tx);
      if (at === 'body_end' && seen.publications > start && seen.forced === 0) { seen.forced++; throw lose(); }
      return value;
    };
    if (multiuser) return call(once);
    try { return await call(once); }
    catch (error) {
      if (seen.forced === before || (error as Error)?.message !== FORCED) throw error;
      return call(once);
    }
  };
  const own = Object.getOwnPropertyDescriptor(engine, 'transaction');
  Object.defineProperty(engine, 'transaction', { value: transaction, configurable: true, writable: true });
  const restore = () => {
    installFaultHook(undefined);
    if (own) Object.defineProperty(engine, 'transaction', own); else delete (engine as { transaction?: unknown }).transaction;
  };
  return { seen, multiuser, restore };
}

/** A bound put_page whose publication transaction loses once at `at`, and what it left. */
async function putWithRerun(engine: BrainEngine, backend: ParityBackend, root: string, at: 'after_publication' | 'body_end') {
  const request_id = randomUUID();
  const ctx = { engine, sourceId: 'work', remote: false as const, config: { engine: engine.kind, embedding_disabled: true }, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } };
  const { seen, multiuser, restore } = forceRerun(engine, at);
  let thrown: string | null = null;
  try {
    await submitPageMutation(ctx as never, { operation: 'put_page',
      params: { slug: 'notes/bob-example', content: `---\ntype: note\ntitle: Bob Example\n---\n${BODY}\n`, request_id } })
      .catch((error: { code?: string }) => { thrown = error?.code ?? String(error); });
  } finally { restore(); }
  // The rerun this case is about happens only where the engine runs a transaction body again: assert the arm is the one named.
  expect(multiuser).toBe(backend === 'rust' && rustArmMultiuser() !== 'off');
  const row = await engine.readWriteRequest('local_cli', (await readLocalWriter(engine, 'cli')).id, request_id);
  const page = await engine.getPage('notes/bob-example', { sourceId: 'work' });
  const file = join(root, 'notes', 'bob-example.md');
  return { forced: seen.forced, publications: seen.publications, thrown, state: row?.state ?? null, error_code: row?.error_code ?? null, recovery: row?.recovery ?? null,
    title: page?.title ?? null, file: existsSync(file) ? readFileSync(file, 'utf8').includes(BODY) : false };
}

// Two publications: the run that lost, then the run that committed.
const COMMITTED: Awaited<ReturnType<typeof putWithRerun>> = { forced: 1, publications: 2, thrown: null, state: 'committed', error_code: null, recovery: null, title: 'Bob Example', file: true };

const IMPORTS = ['notes/gus-example', 'notes/hope-example', 'notes/ivan-example'];

/** A managed import of three files whose publication transaction loses once at `at`, and what it left. */
async function importWithRerun(engine: BrainEngine, backend: ParityBackend, root: string, at: 'after_publication' | 'body_end') {
  // Quoted titles and no trailing newline: the import publishes each file in canonical form, so publication changes the bytes.
  const written = IMPORTS.map(slug => {
    const text = `---\ntitle: "${slug.split('/')[1]}"\n---\n${BODY}`;
    writeFileSync(join(root, `${slug}.md`), text);
    return text;
  });
  const { seen, multiuser, restore } = forceRerun(engine, at);
  let settled: Awaited<ReturnType<typeof importManagedFiles>>;
  try {
    settled = await importManagedFiles(engine, IMPORTS.map(slug => ({ filePath: join(root, `${slug}.md`), sourcePath: `${slug}.md` })),
      { sourceId: 'work', noEmbed: true });
  } finally { restore(); }
  expect(multiuser).toBe(backend === 'rust' && rustArmMultiuser() !== 'off');
  const files = IMPORTS.map(slug => readFileSync(join(root, `${slug}.md`), 'utf8'));
  return { forced: seen.forced, publications: seen.publications,
    import: settled.map(result => result.status === 'fulfilled' ? 'fulfilled' : `rejected:${(result.reason as { code?: string })?.code}`),
    titles: await Promise.all(IMPORTS.map(async slug => (await engine.getPage(slug, { sourceId: 'work' }))?.title ?? null)),
    rewritten: files.map((text, i) => text !== written[i]), body: files.map(text => text.includes(BODY)) };
}

// The group publishes once (one file, or all three), rolls back on the rerun, then each member publishes on its own.
const IMPORTED = { forced: 1, import: ['fulfilled', 'fulfilled', 'fulfilled'], titles: ['gus-example', 'hope-example', 'ivan-example'],
  rewritten: [true, true, true], body: [true, true, true] };

describe('engine parity: a managed publication whose transaction runs again after it wrote the file', () => {
  parityTest('a publication that loses right after writing its file commits once on the next run: committed, page and file', {
    methods: ['worktreeClaimStore', 'getPage', 'readWriteRequest'],
    timeout: 120_000,
  }, async (engine, backend) => withClaimedCheckout(engine, backend, async (root) => {
    const out = await putWithRerun(engine, backend, root, 'after_publication');
    expect(out).toEqual(COMMITTED);
    return out;
  }));

  parityTest('a publication whose commit loses after its whole body ran commits once on the next run: committed, page and file', {
    methods: ['worktreeClaimStore', 'getPage', 'readWriteRequest'],
    timeout: 120_000,
  }, async (engine, backend) => withClaimedCheckout(engine, backend, async (root) => {
    const out = await putWithRerun(engine, backend, root, 'body_end');
    expect(out).toEqual(COMMITTED);
    return out;
  }));

  parityTest('a grouped import whose publication loses right after writing a file commits every member: committed pages and files', {
    methods: ['worktreeClaimStore', 'getPage'],
    timeout: 180_000,
  }, async (engine, backend) => withClaimedCheckout(engine, backend, async (root) => {
    const out = await importWithRerun(engine, backend, root, 'after_publication');
    expect(out).toMatchObject({ ...IMPORTED, publications: 1 + IMPORTS.length });
    return out;
  }));

  parityTest('a grouped import whose commit loses after its whole body ran commits every member: committed pages and files', {
    methods: ['worktreeClaimStore', 'getPage'],
    timeout: 180_000,
  }, async (engine, backend) => withClaimedCheckout(engine, backend, async (root) => {
    const out = await importWithRerun(engine, backend, root, 'body_end');
    expect(out).toMatchObject({ ...IMPORTED, publications: 2 * IMPORTS.length });
    return out;
  }));
});
