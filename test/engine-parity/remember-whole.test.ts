/**
 * BrainEngine parity — a whole remember on the holding page (operations remember, fence append end to end).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: seven remembers without an entity, run through the remember operation, save each claim on the holding
 *    page `memory/unattributed` and answer the same way on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1): each outcome, the fence rows, the facts rows, the page
 *    tier and the saved versions, of which the append keeps the newest five (LARGE_PAGE_VERSIONS_KEPT). Every
 *    remember after the first appends to a page that exists.
 *  - Regression: an engine that cannot run a read the fence append needs (the withdrawal and purge checks, the
 *    restated private copy, the fence chunk overlay, the safe-chunk read, the stored page tier) leaves the remember
 *    queued on that engine (exit 10 write_pending) while the other engines save it: a Rust brain could not remember.
 *  - Why existing coverage misses it: each typed read has its own parity case, but no case runs the whole remember,
 *    so a read the chain still sends as raw SQL shows only when the claim never lands.
 *  - Seam: none. The remember handler runs on the arm's engine with the persistence consumer it starts; the holding
 *    page is read back with typed reads (getPage, listFenceFactRows). Ids and times differ between arms, so they are
 *    folded out. The brain is keyless, as `gbrain init` leaves it (no recorded embedding identity), so the consumer
 *    has no embedding signature and skips the no-op embedding settle, as the CLI does; the test preload's legacy
 *    embedding config comes back before the next test.
 */
import { afterAll, afterEach, describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { LARGE_PAGE_VERSIONS_KEPT } from '../../src/core/page-body/limits.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const HOLDING = 'memory/unattributed';
/** More saves than the holding page keeps versions of, so the append's version prune runs. */
const SAVES = LARGE_PAGE_VERSIONS_KEPT + 2;
const opened: BrainEngine[] = [];

afterEach(async () => {
  for (const engine of opened.splice(0)) await disposePersistenceConsumer(engine).catch(() => undefined);
});

// The case configures the process-global gateway; put back the preload's baseline for the next file.
afterAll(() => resetGateway());

type R = Record<string, unknown>;

describe('engine parity: a whole remember on the holding page', () => {
  parityTest('seven remembers without an entity save every claim on memory/unattributed and keep its newest five versions', {
    methods: ['getPage', 'listFenceFactRows', 'readFenceOverlayRows', 'isFactWithdrawn', 'isFactPurged', 'readSourcePurgeFlags',
      'listFactsForPage', 'readPageTrustRows', 'getVersions'],
    timeout: 180_000,
  }, async (engine) => {
    opened.push(engine);
    configureGateway({ embedding_identity_unverified: true, env: { ...process.env } });
    const ctx = { engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote: false, sourceId: 'default' } as unknown as OperationContext;
    const claims = Array.from({ length: SAVES }, (_, i) => `The weather example fact number ${i + 1}.`);
    const outcomes = [];
    for (const fact of claims) {
      const r = await operationsByName.remember.handler(ctx, { fact, provenance: 'parity notes 2026-11-18', request_id: randomUUID() }) as R;
      const outcome = (r.outcome ?? r) as R;
      outcomes.push({ status: outcome.status, entity_slug: outcome.entity_slug, warnings: outcome.warnings, state: r.state,
        embedding_state: outcome.embedding_state, persistence: outcome.persistence, write_through: outcome.write_through });
    }
    const page = await engine.getPage(HOLDING);
    expect(page).not.toBeNull();
    const fence = parseFactsFence(page!.compiled_truth).facts.map((f) => ({ row_num: f.rowNum, fact: f.claim, visibility: f.visibility, active: f.active }));
    const facts = (await engine.listFactsForPage('default', HOLDING)).map((f) => ({ row_num: Number(f.row_num), fact: f.fact, kind: f.kind,
      visibility: f.visibility, expired: f.expired_at !== null, superseded: f.superseded_by !== null }))
      .sort((a, b) => a.row_num - b.row_num);
    const [trust] = await engine.readPageTrustRows({ keys: [{ source_id: 'default', slug: HOLDING }] });
    const versions = await engine.getVersions(HOLDING, { sourceId: 'default' });
    // The fence guard's read of the page sees no row above the writer and none held or opened.
    const guarded = await engine.listFenceFactRows({ sourceId: 'default', slug: HOLDING,
      incoming: JSON.stringify(fence.map((f) => ({ row_num: f.row_num, fact: f.fact, visibility: 'world' }))) });
    expect(outcomes.map((o) => o.status)).toEqual(claims.map(() => 'inserted'));
    expect(fence.map((f) => f.fact)).toEqual(claims);
    expect(versions.length).toBe(LARGE_PAGE_VERSIONS_KEPT);
    return { outcomes, page: { type: page!.type, title: page!.title }, fence, facts, tier: trust?.trust_tier ?? null, flagged: trust?.flagged ?? null,
      versions: versions.length, guarded: guarded.map((g) => ({ row_num: g.row_num, fact: g.fact })) };
  });
});
