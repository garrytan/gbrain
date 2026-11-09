/**
 * Wave C 1I-a (spec §3.1, dx-r3-native-5): \`--wait-indexed <s>\` keeps a strict git-first write whose receipt reads
 * \`indexing\` waiting past \`--wait\` for its index step, polling at the receipt's delay, and stops at \`committed\` or at a
 * content hold (index_held, exit 1). It has an env/config pair (GBRAIN_WAIT_INDEXED_MS, persistence.wait_indexed_ms),
 * \`--accept-pending\` exits 0 on \`indexing\`, and without it a receipt that still reads \`indexing\` exits 10. Agents poll
 * get_write_request; only CLI entry points set the indexed wait.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGlobalFlags } from '../../src/core/cli-options.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations } from '../../src/core/operations.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { _resetGitFirstGateForTests, _resetIndexSplitPageConsumerForTests, registerIndexSplitPageConsumer } from '../../src/core/persistence/git-first-gate.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { indexSplitPage } from '../../src/core/persistence/index-split-page.ts';
import { MAX_WAIT_INDEXED_MS, replayWhilePending, resolveCliWaitIndexedMs, WAIT_INDEXED_CONFIG_KEY, WAIT_INDEXED_ENV, writeErrorExitCode } from '../../src/core/persistence/write-wait.ts';
import { PENDING_WRITE_EXIT_CODE } from '../../src/core/exit-codes.ts';
import { durableGitRepo, git } from '../helpers/git-publication.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { MiB, pageBody } from './helpers.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: OperationError) => error);
const pendingError = (state: string) => Object.assign(new Error('pending'), { toJSON: () => ({ error: 'write_pending',
  write_request: { request_id: '0190f7d2-6c1e-7a00-8000-000000000001', state, retry_after_ms: 5 } }) });
const requestState = async (engine: BrainEngine, requestId: string) => (await engine.executeRaw<{ state: string }>(
  'SELECT state FROM persistence_requests WHERE request_id = $1', [requestId]))[0]?.state ?? null;

describe('--wait-indexed resolution and exits (no database)', () => {
  test('the flag takes seconds up to an hour; env and config are milliseconds; the flag wins, then env, then config, else off', () => {
    expect(parseGlobalFlags(['--wait-indexed', '900', 'put', 'a']).cliOpts.waitIndexedMs).toBe(900_000);
    expect(parseGlobalFlags(['--wait-indexed=2.5', 'put', 'a']).cliOpts.waitIndexedMs).toBe(2_500);
    expect(parseGlobalFlags(['--wait', '45', 'put', 'a']).cliOpts.waitIndexedMs).toBeUndefined();
    expect(() => parseGlobalFlags(['--wait-indexed', '3601', 'put', 'a'])).toThrow(/0 to 3600/);
    expect(() => parseGlobalFlags(['--wait-indexed', '15m', 'put', 'a'])).toThrow(/no units/);
    expect(resolveCliWaitIndexedMs({ env: {}, config: null })).toBe(0);
    expect(resolveCliWaitIndexedMs({ env: {}, config: { persistence: { wait_indexed_ms: 120000 } } as never })).toBe(120_000);
    expect(resolveCliWaitIndexedMs({ env: { [WAIT_INDEXED_ENV]: '300000' }, config: { persistence: { wait_indexed_ms: 120000 } } as never })).toBe(300_000);
    expect(resolveCliWaitIndexedMs({ flagMs: 5_000, env: { [WAIT_INDEXED_ENV]: '300000' } })).toBe(5_000);
    expect(() => resolveCliWaitIndexedMs({ env: { [WAIT_INDEXED_ENV]: String(MAX_WAIT_INDEXED_MS + 1) } })).toThrow(new RegExp(WAIT_INDEXED_ENV));
    expect(() => resolveCliWaitIndexedMs({ env: {}, config: { persistence: { wait_indexed_ms: 'soon' } } as never })).toThrow(new RegExp(WAIT_INDEXED_CONFIG_KEY.replace('.', '\\.')));
  });

  test('a replay keeps an indexing receipt waiting to the indexed total, never a queued one', async () => {
    let sends = 0;
    const indexing = await replayWhilePending(async () => { if (++sends < 4) throw pendingError('indexing'); return 'committed'; }, 0, async () => undefined, 60_000);
    expect(indexing).toBe('committed');
    expect(sends).toBe(4);
    sends = 0;
    await expect(replayWhilePending(async () => { sends++; throw pendingError('indexing'); }, 0, async () => undefined)).rejects.toThrow('pending');
    expect(sends).toBe(1);
    sends = 0;
    await expect(replayWhilePending(async () => { sends++; throw pendingError('queued'); }, 0, async () => undefined, 60_000)).rejects.toThrow('pending');
    expect(sends).toBe(1);
  });

  test('exit codes: indexing exits 10 (0 with --accept-pending); index_held exits 1', () => {
    expect(writeErrorExitCode(pendingError('indexing'), false)).toBe(PENDING_WRITE_EXIT_CODE);
    expect(writeErrorExitCode(pendingError('indexing'), true)).toBe(0);
    const held = new OperationError('index_held', 'held', 'do not resend');
    expect(writeErrorExitCode(held, false)).toBe(1);
    expect(writeErrorExitCode(held, true)).toBe(1);
  });
});

for (const backend of testBackends()) describe(`[${backend}] --wait-indexed on a strict git-first write (1I-a)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  let release: () => void = () => undefined;
  let tamper: ((engine: BrainEngine) => void) | null = null;
  beforeEach(() => {
    _resetIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests();
    const gate = new Promise<void>(resolve => { release = resolve; });
    tamper = null;
    registerIndexSplitPageConsumer({ run: async (engine, config, effect, hostId) => { await gate; tamper?.(engine); return indexSplitPage.run(engine, config, effect, hostId); } });
  });
  afterEach(() => { release(); _resetIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });

  /** Opens the gate once the write reads indexing and its wait_ms (3 s) has passed, then drives effects to the flip. */
  const indexLater = async (engine: BrainEngine, requestId: string, settled: () => boolean) => {
    const started = performance.now();
    while (await requestState(engine, requestId) !== 'indexing' && performance.now() - started < 60_000) await Bun.sleep(50);
    while (performance.now() - started < 4_000) await Bun.sleep(100);
    release();
    while (!settled() && performance.now() - started < 90_000) {
      await runPersistenceEffects(engine, { engine: engine.kind } as never, { hostId: localHostId(), limit: 10 }).catch(() => undefined);
      await Bun.sleep(100);
    }
  };

  test('without it the write returns write_pending reading indexing; with it the same write returns committed after the flip', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    const pendingResult = await refusal(op('put_page').handler(ctx, { slug: 'notes/plain', content: pageBody(2 * MiB, 'MARKERPLAIN'), request_id: randomUUID(), wait_ms: 3_000 }));
    expect(pendingResult?.code).toBe('write_pending');
    expect(pendingResult?.writeRequest?.state).toBe('indexing');
    release();

    const waited = randomUUID();
    let done = false;
    const run = op('put_page').handler({ ...ctx, waitIndexedMs: 120_000 }, { slug: 'notes/waited', content: pageBody(2 * MiB, 'MARKERWAITED'), request_id: waited, wait_ms: 3_000 })
      .finally(() => { done = true; });
    await indexLater(engine, waited, () => done);
    const receipt = await run as { state: string; index?: { state: string } };
    expect(receipt.state).toBe('committed');
    expect(receipt.index?.state).toBe('indexed');
    expect(await requestState(engine, waited)).toBe('committed');
  }, { databaseUrl, setup }), 240_000);

  test('a content hold during the indexed wait ends index_held with the rebuild fix, and a replay of the request says the same', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const slug = 'notes/held';
    const requestId = randomUUID();
    tamper = () => appendFileSync(join(root, `${slug}.md`), 'tampered after the door\n');
    let done = false;
    const run = refusal(op('put_page').handler({ ...ctx, waitIndexedMs: 120_000 }, { slug, content: pageBody(2 * MiB, 'MARKERHELD'), request_id: requestId, wait_ms: 3_000 }))
      .finally(() => { done = true; });
    await indexLater(engine, requestId, () => done);
    const held = await run;
    expect(held?.code).toBe('index_held');
    expect(held?.detail).toBe('hash_mismatch');
    expect(held?.fix?.argv).toEqual(['gbrain', 'pages', 'reindex', slug, '--from-git', '--source', 'default', '--dry-run', '--json']);
    expect(held?.writeRequest?.state).toBe('committed');
    expect(writeErrorExitCode(held, false)).toBe(1);
    expect(git(root, 'log', '--format=%H', '--', `${slug}.md`).trim().split('\n')).toHaveLength(1);
    const replay = await refusal(op('put_page').handler(ctx, { slug, content: pageBody(2 * MiB, 'MARKERHELD'), request_id: requestId, wait_ms: 3_000 }));
    expect(replay?.code).toBe('index_held');
    expect(git(root, 'log', '--format=%H', '--', `${slug}.md`).trim().split('\n')).toHaveLength(1);
  }, { databaseUrl, setup }), 240_000);
});
