/**
 * BrainEngine parity — a whole remember that replaces an earlier fact (operations remember with `replaces`, the supersession
 * bookkeeping end to end).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a remember that names an active fact in `replaces` saves the new claim on the holding page `memory/unattributed`,
 *    answers `superseded`, ends the old fact (expired, valid_until set, superseded_by pointing at the new fact) and leaves the
 *    new one active; a remember that names a replaced fact answers target_superseded, one that names a fact that is gone
 *    answers not_found, one that changes the visibility answers replaces_visibility_mismatch, each saving nothing. The answers
 *    and the rows are equal on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1), except that a Rust brain stops the first case at the raw statement that ends the old fact.
 *  - Regression: readReplacementTarget and readFactVisibility refused on a Rust brain, so every remember that replaces a fact
 *    stopped before it read its target. The refusal case now runs whole on Rust.
 *  - Why existing coverage misses it: test/engine-parity/remember-whole.test.ts remembers claims that replace nothing, and
 *    test/engine-parity/remember-members.test.ts drives the members one by one.
 *  - Seam: none. The remember handler runs whole on the arm's engine with the persistence consumer it starts; the holding page
 *    is read back with typed reads. Ids and times differ between arms, so facts are named by text and times are folded out.
 *    The brain is keyless (no recorded embedding identity), as in remember-whole.test.ts.
 */
import { afterAll, afterEach, describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const SRC = 'default';
const HOLDING = 'memory/unattributed';
const opened: BrainEngine[] = [];

afterEach(async () => {
  for (const engine of opened.splice(0)) await disposePersistenceConsumer(engine).catch(() => undefined);
});

// The case configures the process-global gateway; put back the preload's baseline for the next file.
afterAll(() => resetGateway());

type R = Record<string, unknown>;

/** The outcome of one whole remember: its status, or the refusal's code and first message line. */
async function remember(ctx: OperationContext, fact: string, extra: R = {}): Promise<R> {
  try {
    const r = await operationsByName.remember.handler(ctx, { fact, provenance: 'parity notes 2026-11-19', request_id: randomUUID(), ...extra }) as R;
    const outcome = (r.outcome ?? r) as R;
    return { status: outcome.status, state: r.state ?? null };
  } catch (e) {
    const err = e as { code?: string; message: string };
    // An engine refusal reaches the caller with its frozen wire code; turn it back into the typed refusal so the
    // harness counts the case as stopped there. `unavailable` is a write the consumer could not finish: the raw statement
    // that ends a replaced fact (src/core/persistence/memory-prepare.ts), which a Rust brain refuses (raw_sql).
    if (err.code === 'unavailable') throw Object.assign(new Error(err.message), { code: 'engine_capability_missing', reason: 'raw_sql' });
    if ((e as { reason?: unknown }).reason !== undefined && err.code !== 'invalid_params') {
      throw Object.assign(new Error(err.message), { code: 'engine_capability_missing', reason: (e as { reason?: unknown }).reason });
    }
    return { refused: err.code ?? null, message: err.message.split('\n')[0].replace(/#\d+/g, '#N') };
  }
}

const facts = async (engine: BrainEngine) => (await engine.listFactsForPage(SRC, HOLDING)).map((f) => ({ id: Number(f.id), fact: f.fact, row_num: Number(f.row_num),
  expired: f.expired_at !== null, ended: f.valid_until !== null, superseded_by: f.superseded_by == null ? null : Number(f.superseded_by) }));
/** The holding page's rows by text, so ids (which differ between arms) never reach the comparison. */
async function named(engine: BrainEngine) {
  const rows = await facts(engine);
  const name = new Map(rows.map((r) => [r.id, r.fact]));
  return rows.map((r) => ({ fact: r.fact, row_num: r.row_num, expired: r.expired, ended: r.ended, superseded_by: r.superseded_by === null ? null : name.get(r.superseded_by) ?? 'unknown' }))
    .sort((a, b) => a.row_num - b.row_num);
}

function ctxFor(engine: BrainEngine): OperationContext {
  configureGateway({ embedding_identity_unverified: true, env: { ...process.env } });
  return { engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote: false, sourceId: SRC } as unknown as OperationContext;
}

describe('engine parity: a whole remember that replaces an earlier fact', () => {
  // The persistence consumer ends the old fact through retireSupersededFact (src/core/persistence/memory-prepare.ts).
  parityTest('remember with replaces saves the new claim, ends the old fact and links it to the new one', {
    methods: ['readReplacementTarget', 'readFactVisibility', 'retireSupersededFact', 'listFactsForPage', 'getPage'],
    timeout: 180_000,
  }, async (engine) => {
    opened.push(engine);
    const ctx = ctxFor(engine);
    const first = await remember(ctx, 'the example office is in boston.');
    const old = (await facts(engine)).find((f) => f.fact === 'the example office is in boston.')!;
    const replaced = await remember(ctx, 'the example office is in denver.', { replaces: String(old.id) });
    const afterReplace = await named(engine);

    expect([first.status, replaced.status]).toEqual(['inserted', 'superseded']);
    expect(afterReplace).toEqual([
      { fact: 'the example office is in boston.', row_num: 1, expired: true, ended: true, superseded_by: 'the example office is in denver.' },
      { fact: 'the example office is in denver.', row_num: 2, expired: false, ended: false, superseded_by: null },
    ]);
    const again = await remember(ctx, 'the example office is in denver.', { replaces: String(old.id) });
    const stale = await remember(ctx, 'the example office is in austin.', { replaces: String(old.id) });
    return { first, replaced, afterReplace, again, stale, after: await named(engine), page: (await engine.getPage(HOLDING)) !== null };
  });

  // The consumer's supersede member alone: an until ends the old fact there, none keeps its end, and an expired or
  // other-source fact is left as it is.
  parityTest('retireSupersededFact expires and links the old fact, ending it only at a given until', {
    methods: ['retireSupersededFact', 'listFactsForPage', 'getPage'],
    timeout: 180_000,
  }, async (engine) => {
    opened.push(engine);
    const ctx = ctxFor(engine);
    for (const city of ['boston', 'denver', 'austin']) await remember(ctx, `the example office is in ${city}.`);
    const byCity = async (city: string) => (await facts(engine)).find((f) => f.fact.endsWith(`${city}.`))!;
    const [boston, denver, austin] = [await byCity('boston'), await byCity('denver'), await byCity('austin')];
    const counts = {
      kept: await engine.retireSupersededFact({ oldId: boston.id, sourceId: SRC, newId: denver.id, until: null }),
      again: await engine.retireSupersededFact({ oldId: boston.id, sourceId: SRC, newId: austin.id, until: null }),
      otherSource: await engine.retireSupersededFact({ oldId: denver.id, sourceId: 'no-such-source', newId: austin.id, until: null }),
      ended: await engine.retireSupersededFact({ oldId: String(denver.id), sourceId: SRC, newId: austin.id, until: new Date('2026-01-02T03:04:05Z') }),
    };
    const after = await named(engine);
    expect(counts).toEqual({ kept: 1, again: 0, otherSource: 0, ended: 1 });
    expect(after.map((r) => [r.fact, r.expired, r.ended, r.superseded_by])).toEqual([
      ['the example office is in boston.', true, false, 'the example office is in denver.'],
      ['the example office is in denver.', true, true, 'the example office is in austin.'],
      ['the example office is in austin.', false, false, null],
    ]);
    const denverRow = (await engine.listFactsForPage(SRC, HOLDING)).find((f) => f.fact.endsWith('denver.'))!;
    return { counts, after, denverUntil: new Date(denverRow.valid_until as unknown as string).toISOString() };
  });

  // The refusals read the target through readReplacementTarget and readFactVisibility and save nothing, so they run whole on
  // every arm. The pair is set up with expireSupersededFact (the member the review's accept uses), not with a remember.
  parityTest('a replaced or gone target is refused and saves nothing', {
    methods: ['readReplacementTarget', 'readFactVisibility', 'expireSupersededFact', 'listFactsForPage', 'getPage'],
    timeout: 180_000,
  }, async (engine) => {
    opened.push(engine);
    const ctx = ctxFor(engine);
    await remember(ctx, 'the example office is in boston.');
    await remember(ctx, 'the example office is in denver.');
    const [boston, denver] = [(await facts(engine)).find((f) => f.fact.endsWith('boston.'))!, (await facts(engine)).find((f) => f.fact.endsWith('denver.'))!];
    expect(await engine.expireSupersededFact({ oldId: boston.id, sourceId: SRC, newId: denver.id, until: null })).toBe(1);
    const before = await named(engine);

    const replacedTarget = await remember(ctx, 'the example office is in austin.', { replaces: String(boston.id) });
    const gone = await remember(ctx, 'the example office is in dallas.', { replaces: '999999' });
    const activeTarget = await remember(ctx, 'the example office is in austin.', { replaces: String(denver.id), visibility: 'private' });
    expect(replacedTarget).toMatchObject({ refused: 'invalid_params' });
    expect(gone).toMatchObject({ refused: 'not_found' });
    expect(activeTarget).toMatchObject({ refused: 'invalid_params' });
    expect(await named(engine)).toEqual(before);
    return { before, replacedTarget, gone, activeTarget, page: (await engine.getPage(HOLDING)) !== null };
  });
});
