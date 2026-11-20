/**
 * Engine parity for a write to a worktree-bound source: after `gbrain sources writer claim`, a put_page to the claimed
 * source is admitted, prepared against the checkout file, published and committed on every engine, and a refusal at
 * publication ends the request in a terminal state through recovery.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a put_page to the claimed source commits the page and writes its file into the checkout. A storage
 *    refusal at the publication boundary moves the request to recovering (its recovery record kept), and the recovery
 *    pass ends it `failed` with the refusal's code: no page, no file, never left pending.
 *  - Regression: an engine that refuses a step of the bound publication (the held-import check, the recovery record,
 *    the publication stamp, markRecovering or recoverPublication's writes), so a claimed source takes no write, or a
 *    refused publication stays recovering with nothing to finish it.
 *  - Why existing coverage misses it: test/persistence-*.test.ts run on PGLite and Postgres only; the Rust engine
 *    refused every raw-SQL step of the bound publication (engine-sql/publication-journal.ts).
 *  - Seam: the publication fault hook (persistence/fault-points.ts) throws the refusal; real engines, real Git checkout.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { installFaultHook, type FaultPoint } from '../../src/core/persistence/fault-points.ts';
import { readLocalWriter } from '../../src/core/persistence/identity.ts';
import { OperationError } from '../../src/core/ops/contract.ts';

const { parityTest } = parityArms(testBackends());

async function withClaimedCheckout<T>(engine: BrainEngine, backend: ParityBackend, run: (root: string) => Promise<T>): Promise<T> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-bound-write-parity-')));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const root = join(home, 'checkout');
      mkdirSync(join(root, 'notes'), { recursive: true });
      execFileSync('git', ['-C', root, 'init', '-q']);
      writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
      execFileSync('git', ['-C', root, 'add', '.']);
      execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes']);
      await createSource(engine, backend, 'work', {}, root);
      const expected_state = await writerAdminState(engine);
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, admin_intent: 'writer_claim', expected_state });
      try { return await run(root); } finally { await disposePersistenceConsumer(engine); }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const ctxFor = (engine: BrainEngine) => ({ engine, sourceId: 'work', remote: false as const,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {} } });

describe('a write to a worktree-bound source', () => {
  parityTest('claim the checkout, put_page to the bound source: the page and its file are written', {
    methods: ['worktreeClaimStore'],
    timeout: 120_000,
  }, async (engine, backend) => withClaimedCheckout(engine, backend, async (root) => {
    await submitPageMutation(ctxFor(engine) as never, { operation: 'put_page',
      params: { slug: 'notes/bob-example', content: '---\ntype: note\ntitle: Bob Example\n---\nWorks at widget-co.\n', request_id: randomUUID() } });
    const page = await engine.getPage('notes/bob-example', { sourceId: 'work' });
    const file = join(root, 'notes', 'bob-example.md');
    const answers = { title: page?.title ?? null, file: existsSync(file) ? readFileSync(file, 'utf8').includes('Works at widget-co.') : false };
    expect(answers).toEqual({ title: 'Bob Example', file: true });
    return answers;
  }));

  parityTest('a refusal at publication moves the request to recovering, then ends it failed: no page, no file', {
    methods: ['worktreeClaimStore'],
    timeout: 120_000,
  }, async (engine, backend) => withClaimedCheckout(engine, backend, async (root) => {
    const request_id = randomUUID();
    // The local writer registers on the first write, so it is read after the submit starts.
    const stored = async () => engine.readWriteRequest('local_cli', (await readLocalWriter(engine, 'cli')).id, request_id);
    // The request as the recovery pass leaves it, before its recovery record is cleared: terminal, the record still held.
    // markRecovering is the only route to that pass from a refused publication, and no seam sits between the two.
    let recovered: { state: string; recovery: boolean; blocked_reason: string | null } | null = null;
    const seen: FaultPoint[] = [];
    installFaultHook(async (point) => {
      seen.push(point);
      if (point === 'publication:before_publication') throw new OperationError('storage_error', 'Injected refusal at publication.', 'Test fault.');
      if (point === 'publication_recovery:before_clear') {
        const row = await stored();
        recovered = row && { state: row.state, recovery: row.recovery != null, blocked_reason: row.blocked_reason };
      }
    });
    let code: string | undefined;
    try {
      await submitPageMutation(ctxFor(engine) as never, { operation: 'put_page',
        params: { slug: 'notes/carol-example', content: '---\ntype: note\ntitle: Carol Example\n---\nWorks at widget-co.\n', request_id } });
    } catch (e) {
      code = (e as { code?: string }).code;
    } finally { installFaultHook(undefined); }
    const final = await stored();
    const page = await engine.getPage('notes/carol-example', { sourceId: 'work' });
    const answers = { code, recovered, seen: seen.includes('publication_recovery:before_clear'),
      final: final && { state: final.state, error_code: final.error_code, recovery: final.recovery != null },
      page: page?.title ?? null, file: existsSync(join(root, 'notes', 'carol-example.md')) };
    expect(answers).toEqual({ code: 'storage_error', recovered: { state: 'failed', recovery: true, blocked_reason: null }, seen: true,
      final: { state: 'failed', error_code: 'storage_error', recovery: false }, page: null, file: false });
    return answers;
  }));
});
