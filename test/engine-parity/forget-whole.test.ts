/**
 * BrainEngine parity — the legacy fence helper a forget shares with supersession and retirement.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `forgetFactInFence` (facts/forget.ts) withdraws, supersedes (to a given end) or retires a fenced claim
 *    on a source without a checkout, expires it and strikes its row in the stored body; a second expiry answers
 *    `already_expired`, and an unknown id or one outside the caller's source answers `not_found`. The answers are
 *    equal on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1). The
 *    forget operation (operations.ts `forget`) on an inline page commits, expires
 *    the claim, strikes its fence row and rebuilds the page's chunks after the commit, equal on every arm.
 *  - Regression: `forgetFactInFence` read the fact, expired it and read the stored body through raw SQL, which the
 *    Rust engine refuses, so on a Rust brain every withdrawal, supersession and retirement through it stopped before
 *    it expired anything.
 *  - Why existing coverage misses it: test/engine-parity/forget-commit.test.ts commits a withdrawal through the typed
 *    ledger members, and test/engine-parity/withdrawal-forget.test.ts drives recordFactWithdrawal on a fact with no
 *    page; neither calls `forgetFactInFence`, the path facts/retire.ts and facts/write-single.ts take.
 *  - Seam: the page and its fact rows are seeded with `importFromContent` and `insertFacts` under operator trust, not
 *    `put_page`. `forgetFactInFence` is called directly, as its callers do; their own reads are not in this file.
 *    Ids and times differ between arms, so they are folded out; the supersession's end is a fixed date and is compared.
 *    The segmented page is published with test/helpers/page-body-fixtures.ts `publishSegmentedPage` (typed body
 *    members); the forget operation on it commits on every arm.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { forgetFactInFence } from '../../src/core/facts/forget.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { publishSegmentedPage, segmentText } from '../helpers/page-body-fixtures.ts';

const { parityTest } = parityArms(testBackends());
const SRC = 'default';
const SLUG = 'people/alice-example';
const SEGMENTED = 'people/bob-example';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const opened: BrainEngine[] = [];

afterEach(async () => {
  for (const engine of opened.splice(0)) await disposePersistenceConsumer(engine).catch(() => undefined);
});

// The cases configure the process-global gateway; put back the preload's baseline for the next file.
afterAll(() => resetGateway());

const CLAIMS = ['Prefers the window seat', 'Walks to work', 'Drinks green tea', 'Reads before bed'];

const fence = (claims: readonly string[]) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${claims.map((c, i) => `| ${i + 1} | ${c} | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |`).join('\n')}
<!--- gbrain:facts:end -->`;

/** An inline page holding `claims` in its fence, with one fact row per claim, written under operator trust. */
async function seed(engine: BrainEngine, claims: readonly string[]): Promise<Map<string, number>> {
  opened.push(engine);
  configureGateway({ embedding_identity_unverified: true, env: { ...process.env } });
  const content = `---\ntitle: Alice\ntype: person\n---\n\n# Alice\n\n## Facts\n\n${fence(claims)}\n\n` +
    '## Notes\n\nNotes on hiring and the budget review.\n';
  await importFromContent(engine, SLUG, content, { sourceId: SRC, noEmbed: true });
  await engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'],
      ['operator_curated', 'operator_curated', JSON.stringify({ channel: 'operator_curated' })]);
    await tx.insertFacts(claims.map((fact, i) => ({ fact, entity_slug: SLUG, source_markdown_slug: SLUG, row_num: i + 1,
      kind: 'preference', visibility: 'world', source: 'chat', valid_from: new Date(Date.UTC(2026, 0, 1)) })) as never,
    { source_id: SRC });
  });
  const rows = await engine.listFactsForPage(SRC, SLUG);
  return new Map(rows.map(r => [r.fact, Number(r.id)]));
}

const iso = (v: Date | string | null) => v === null ? null : new Date(v).toISOString();

/** The page's fact rows (claim, expired) and its stored fence rows (claim, live, context), with ids folded out. */
async function pageState(engine: BrainEngine) {
  const facts = (await engine.listFactsForPage(SRC, SLUG)).map(f => ({ fact: f.fact, expired: f.expired_at !== null }));
  const page = await engine.getPage(SLUG, { sourceId: SRC });
  const fenceRows = parseFactsFence(page?.compiled_truth ?? '').facts.map(f => ({
    rowNum: f.rowNum, claim: f.claim, active: f.active, context: (f.context ?? '').replace(/\d{4}-\d{2}-\d{2}/g, 'DATE'),
  }));
  return { facts, fenceRows };
}

describe('a whole forget', () => {
  parityTest('forgetFactInFence withdraws a fenced claim on a source without a checkout',
    { methods: ['readFactForForget', 'listFactsForPage', 'getPage'], timeout: 180_000 },
    async (engine) => {
      const ids = await seed(engine, CLAIMS.slice(0, 2));
      const withdrawn = await forgetFactInFence(engine, ids.get(CLAIMS[0])!, { sourceId: SRC });
      return { withdrawn, ...await pageState(engine) };
    });

  parityTest('forgetFactInFence supersedes to a given end and retires on a source without a checkout',
    { methods: ['readFactForForget', 'expireFactSuperseded', 'listFactsForPage', 'getPage'], timeout: 180_000 },
    async (engine) => {
      const ids = await seed(engine, CLAIMS);
      const id = (claim: string) => ids.get(claim)!;
      const end = new Date(Date.UTC(2026, 5, 1));
      const superseded = await forgetFactInFence(engine, id(CLAIMS[1]), { supersededBy: { rowNum: null, validUntil: end } });
      const retired = await forgetFactInFence(engine, id(CLAIMS[2]),
        { sourceId: SRC, retired: 'source item deleted' });
      const again = await forgetFactInFence(engine, id(CLAIMS[1]), { supersededBy: { rowNum: null } });
      const missing = await forgetFactInFence(engine, Math.max(...ids.values()) + 1000);
      const elsewhere = await forgetFactInFence(engine, id(CLAIMS[3]), { sourceId: 'other-source' });
      const [supersededRow] = (await engine.listFactsForPage(SRC, SLUG)).filter(f => f.fact === CLAIMS[1]);
      const supersededEnd = iso(supersededRow?.valid_until ?? null);
      // The fact read the helper starts from, ids and times folded out.
      const read = await engine.readFactForForget(id(CLAIMS[1]));
      const target = read && { ...read, id: Number(read.id) === id(CLAIMS[1]), expired_at: read.expired_at !== null };
      const unknown = await engine.readFactForForget(Math.max(...ids.values()) + 1000);
      return { superseded, retired, again, missing, elsewhere, supersededEnd, target, unknown, ...await pageState(engine) };
    });

  parityTest('the forget operation commits on an inline page, expires the claim and strikes its fence row',
    { methods: ['listFactsForPage', 'getPage', 'getChunks'], timeout: 180_000 }, async (engine) => {
      const ids = await seed(engine, CLAIMS.slice(0, 2));
      const ctx = { engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote: false, sourceId: SRC } as unknown as OperationContext;
      const forget = await operationsByName.forget.handler(ctx, { id: String(ids.get(CLAIMS[0])), request_id: randomUUID(), wait_ms: 30_000 }) as Record<string, unknown>;
      // The struck claim leaves the page's chunks once the post-commit projection rebuild installs the new body.
      const chunks = (await engine.getChunks(SLUG, { sourceId: SRC })).map(c => c.chunk_text);
      return { state: forget.state, ...await pageState(engine), chunks };
    });

  // On a segmented page the forget's withdrawal rewrites the live fence through rewriteLiveSegmentedFences
  // (page-body/segment-rewrite.ts, called from facts/withdrawal.ts) and the post-commit projection rebuilds the page's
  // chunks; both run on typed members the Rust store serves, so the write commits on every arm.
  parityTest('the forget operation on a segmented page commits and expires the claim',
    { methods: ['createSegmentedPageShell', 'flipBodyGeneration', 'listFactsForPage'], timeout: 180_000 }, async (engine) => {
      opened.push(engine);
      configureGateway({ embedding_identity_unverified: true, env: { ...process.env } });
      await publishSegmentedPage(engine, SEGMENTED, [segmentText(`# Bob\n\n## Facts\n\n${fence(CLAIMS.slice(0, 2))}\n`),
        segmentText('## Notes\n\nNotes on the budget review.\n')]);
      await engine.transaction(async (tx) => {
        await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'],
          ['operator_curated', 'operator_curated', JSON.stringify({ channel: 'operator_curated' })]);
        await tx.insertFacts(CLAIMS.slice(0, 2).map((fact, i) => ({ fact, entity_slug: SEGMENTED, source_markdown_slug: SEGMENTED, row_num: i + 1,
          kind: 'preference', visibility: 'world', source: 'chat', valid_from: new Date(Date.UTC(2026, 0, 1)) })) as never, { source_id: SRC });
      });
      const facts = async () => (await engine.listFactsForPage(SRC, SEGMENTED)).map(f => ({ fact: f.fact, expired: f.expired_at !== null }));
      const [target] = (await engine.listFactsForPage(SRC, SEGMENTED)).filter(f => f.fact === CLAIMS[0]);
      const ctx = { engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote: false, sourceId: SRC } as unknown as OperationContext;
      const { state } = await operationsByName.forget.handler(ctx, { id: String(target!.id), request_id: randomUUID(), wait_ms: 30_000 }) as Record<string, unknown>;
      return { state, facts: await facts() };
    });

  // forget.ts's file-mirror stamp (expireFactAtDate) binds today's 'YYYY-MM-DD' text, as master did; the server casts it
  // (UTC on every arm here: PGLite's default zone, the test database's zone and the Rust store's). A supersession's
  // end (expireFactSuperseded) is an ISO time, kept as given; an already-expired row is left as it was.
  parityTest('expireFactAtDate takes a day text as that midnight and expireFactSuperseded an ISO time as that instant',
    { methods: ['expireFactAtDate', 'expireFactSuperseded', 'listFactsForPage'], timeout: 180_000 },
    async (engine) => {
      const ids = await seed(engine, CLAIMS.slice(0, 3));
      await engine.expireFactAtDate(ids.get(CLAIMS[0])!, '2026-06-01');
      await engine.expireFactSuperseded(ids.get(CLAIMS[1])!, '2026-03-04T05:06:07.000Z');
      await engine.expireFactAtDate(ids.get(CLAIMS[0])!, '2026-07-01');
      await engine.expireFactSuperseded(ids.get(CLAIMS[1])!, null);
      const ends = (await engine.listFactsForPage(SRC, SLUG)).map(f => ({ fact: f.fact, end: iso(f.valid_until ?? null), expired: f.expired_at !== null }))
        .filter(f => f.fact !== CLAIMS[2]);
      expect(ends.map(e => e.end)).toEqual(['2026-06-01T00:00:00.000Z', '2026-03-04T05:06:07.000Z']);
      return { ends };
    });
});
