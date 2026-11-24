/**
 * BrainEngine parity — a forgotten or purged claim cannot be saved again by a whole remember on the holding page.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: after the claim's purge tombstone is in the source's fact purge ledger (subject '*', world), a whole
 *    remember of it (the remember operation, no entity, holding page `memory/unattributed`) is refused and saves
 *    nothing, and a claim that was never purged still saves into the same fence. After a forget withdraws a remembered
 *    claim, a whole remember of the same claim is refused too. The answers are equal on every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: the whole remember's purge check answered "not purged" on the Rust engine, which kept no fact purge
 *    ledger, so a purged claim saved again on a Rust brain while PGLite and Postgres refused it. Once the ledger
 *    answered, the import's purge overlay (facts/purge-overlay.ts) read it through raw SQL, so on a Rust brain every
 *    later remember into a fenced page of that source stopped short of committing.
 *  - Why existing coverage misses it: test/engine-parity/fact-purge-ledger.test.ts reads the ledger through the typed
 *    members only, and test/engine-parity/remember-whole.test.ts remembers claims that were never forgotten or purged.
 *  - Seam: the forget and the purge are their ledger commits, not the whole commands. The withdrawal is written with
 *    `insertFactWithdrawal` + `expireFactsByWithdrawal`, the pair `forget` commits through (facts/withdrawal.ts; a
 *    subjectless claim withdraws source-wide, subject '*'); the tombstone with `insertFactPurge`, the ledger writer
 *    `gbrain forget <id> --purge` commits through (facts/purge.ts). The forget command's target discovery
 *    (facts/withdrawal-discovery.ts) and the purge's sweep still send raw SQL, which the Rust engine refuses, so the
 *    whole commands cannot run on every arm yet (TODOS rust-forget-commands). The remember handler runs whole, on the
 *    arm's engine with the persistence consumer it starts. The brain is keyless, as in remember-whole.test.ts. Ids and
 *    times differ between arms, so they are folded out.
 *  - The remember's fact_withdrawn refusal reads the withdrawal it names through the typed readClaimWithdrawal member
 *    (facts/single-prepare.ts factWithdrawnRefusal), so the forget case runs whole on every arm.
 */
import { afterAll, afterEach, describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
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

/** The outcome of one whole remember: its status, or the refusal's code and message. */
async function rememberOutcome(ctx: OperationContext, fact: string): Promise<R> {
  try {
    const r = await operationsByName.remember.handler(ctx, { fact, provenance: 'parity notes 2026-11-19', request_id: randomUUID() }) as R;
    const outcome = (r.outcome ?? r) as R;
    return { status: outcome.status, state: r.state ?? null };
  } catch (e) {
    const err = e as { code?: string; message: string };
    // The remember answers an engine refusal with its frozen wire code (unavailable) and the capability as `reason`;
    // turn it back into the typed refusal so the harness counts the case as stopped there.
    if ((e as { reason?: unknown }).reason === 'raw_sql') throw Object.assign(new Error(err.message), { code: 'engine_capability_missing', reason: 'raw_sql' });
    return { refused: err.code ?? null, message: err.message.split('\n')[0] };
  }
}

describe('engine parity: a whole remember of a purged or forgotten claim', () => {
  parityTest('a purged claim is refused by a whole remember; a new claim still saves into the fence', {
    methods: ['loadPurgeTarget', 'insertFactPurge', 'isFactPurged', 'readSourcePurgeFlags',
      'readFenceOverlayRows', 'getPage', 'listFactsForPage'],
    timeout: 180_000,
  }, async (engine) => {
    opened.push(engine);
    configureGateway({ embedding_identity_unverified: true, env: { ...process.env } });
    const ctx = { engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote: false, sourceId: SRC } as unknown as OperationContext;

    // The claim is remembered onto the holding page, then purged: a tombstone for it under every subject of the source.
    const purgedClaim = 'The purged example fact.';
    const before = await rememberOutcome(ctx, purgedClaim);
    const row = (await engine.listFactsForPage(SRC, HOLDING)).find((f) => f.fact === purgedClaim);
    const target = await engine.loadPurgeTarget(Number(row!.id), SRC);
    const tombstone = await engine.insertFactPurge({ sourceId: SRC, visibility: 'world', subject: '*', factHash: target!.fact_hash,
      requestId: randomUUID(), actor: 'owner:local', reason: 'parity' });
    const purged = await rememberOutcome(ctx, purgedClaim);

    // A claim that was never purged still saves; re-importing the holding page drops the purged row from its fence.
    const fresh = await rememberOutcome(ctx, 'The fresh example fact.');

    const page = await engine.getPage(HOLDING);
    const fence = parseFactsFence(page!.compiled_truth).facts.map((f) => ({ fact: f.claim, active: f.active }));
    const facts = (await engine.listFactsForPage(SRC, HOLDING)).map((f) => ({ fact: f.fact, expired: f.expired_at !== null }))
      .sort((a, b) => a.fact.localeCompare(b.fact));

    expect(tombstone).toBe(true);
    expect(purged).toEqual({ refused: 'invalid_params', message: 'purged_content: this claim was purged from this source and cannot be saved again.' });
    expect(before.status).toBe('inserted');
    expect(fresh.status).toBe('inserted');
    expect(fence).toEqual([{ fact: 'The fresh example fact.', active: true }]);
    return { before, tombstone, purged, fresh, fence, facts };
  });

  parityTest('a forgotten claim is refused by a whole remember', {
    methods: ['insertFactWithdrawal', 'expireFactsByWithdrawal', 'isFactWithdrawn', 'readClaimWithdrawal', 'listFactsForPage'],
    timeout: 180_000,
  }, async (engine) => {
    opened.push(engine);
    configureGateway({ embedding_identity_unverified: true, env: { ...process.env } });
    const ctx = { engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote: false, sourceId: SRC } as unknown as OperationContext;

    const forgotten = 'The forgotten example fact.';
    const first = await rememberOutcome(ctx, forgotten);
    // Forget's commit: a source-wide withdrawal of a subjectless claim, and the expiry of the rows it reaches.
    const forget = {
      withdrawn: await engine.insertFactWithdrawal(SRC, 'world', forgotten, '*', null),
      expired: (await engine.expireFactsByWithdrawal(SRC, 'world', forgotten, '*')).length,
    };
    const again = await rememberOutcome(ctx, forgotten);
    const facts = (await engine.listFactsForPage(SRC, HOLDING)).map((f) => ({ fact: f.fact, expired: f.expired_at !== null }));

    expect(first.status).toBe('inserted');
    expect(forget).toEqual({ withdrawn: true, expired: 1 });
    expect(again).toEqual({ refused: 'invalid_params', message: 'fact_withdrawn: this exact claim was explicitly forgotten in this source and visibility.' });
    expect(facts).toEqual([{ fact: forgotten, expired: true }]);
    return { first, forget, again, facts };
  });
});
