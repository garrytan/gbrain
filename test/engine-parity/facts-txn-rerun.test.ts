/**
 * Engine parity: the facts file writers (forget, fact-fence writes, the unfenced-facts adoption) when a transaction runs
 * its callback again.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a transaction callback may run more than once (the multi-user Rust engine runs it again from a fresh snapshot
 *    after a commit lost on write_conflict, design interface I-1), and only the run that commits counts. So a forget whose
 *    transaction runs twice still strikes the fact's row with the caller's reason in the file and the stored body (a
 *    segmented page's segment included); a fence write whose transaction runs twice still lands its fact rows in the file
 *    and the database once; an adoption of legacy rows whose transaction runs twice still reports them adopted, never held
 *    as file/database drift. Every arm answers the same.
 *  - Regression: forgetFactInFence strikes a segmented page from a closure flag (`first`) that the run that lost its commit
 *    had already set, so the rerun struck nothing: a forget that silently did not forget. The three writers that rename the
 *    file into place inside the transaction (forget's inline mirror, writeFactsToFence, the unfenced-facts adoption) left the
 *    file published after the lost commit while the database rolled back, so the rerun's own check (the file still holds what
 *    the run read) failed: the forget answered `legacy_db` with a drift warning, the fence write and the adoption reported
 *    the page held `during`, and the database kept the old body.
 *  - Why existing coverage misses it: forget-fence-path.test.ts, fence-write.test.ts and fact-fence-adoption-exits.test.ts
 *    run each writer once; the multi-user lanes meet a rerun only under contention, by chance.
 *  - Seam: none in production. force-rerun.ts wraps engine.transaction. The segmented forget forces each run that reads the
 *    page's segmented rewrite row (`readSegmentedRewritePage`); the three file writers force the run that published the
 *    file (`after`: the file no longer holds what it held before the call, limit 1). On a multi-user Rust brain the
 *    forced run ends with a write_conflict error, so the engine's real optimistic retry runs the callback again; every
 *    other arm runs it once in a transaction it rolls back and once for real.
 *  - Not forced on the served Rust arm (GBRAIN_TEST_RUST_SERVED=1): there the owner behind the served client runs the
 *    transactions on its own engine, out of the case's reach. The cases still run there and check the same end state.
 */
import { afterAll, describe, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { forgetFactInFence } from '../../src/core/facts/forget.ts';
import { writeFactsToFence, type FenceInputFact } from '../../src/core/facts/fence-write.ts';
import { fenceUnfencedFacts, planUnfencedFacts } from '../../src/core/facts/unfenced-facts.ts';
import { materializeSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { rustMuArmRequested, rustServedRequested } from './rust-arm.ts';
import { forceRerunOnHit, type ForcedRerun } from './force-rerun.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { withEnv } from '../helpers/with-env.ts';

const { parityTest } = parityArms(testBackends());
const SRC = 'fenced';
const REASON = 'asked to drop it on the call';
const home = mkdtempSync(join(tmpdir(), 'gbrain-facts-txn-rerun-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const fence = (claim: string) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${claim} | preference | 1.0 | world | medium | 2026-01-01 |  | chat | said at lunch |
| 2 | Walks to work | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->`;
const filler = (sections: number) => Array.from({ length: sections }, (_, i) => `## Part ${i}\n\n${'Notes on hiring and the budget review. '.repeat(30)}\n\n`).join('');
const rowsOf = (text: string) => text.split('\n').filter(line => /^\| \d+ \|/.test(line));

/** Whether this arm forces anything: the served arm's owner runs the transactions where the case cannot reach them (header). */
const forcing = () => !rustServedRequested();

/** On the multi-user arm the engine must take the optimistic path, or the case proves nothing about it; a forced case forced at least one run. */
function assertArm(engine: BrainEngine, backend: ParityBackend, rerun: ForcedRerun | null): void {
  if (rerun) expect(rerun.seen.forced).toBeGreaterThanOrEqual(1);
  if (backend === 'rust' && rustMuArmRequested() && !rustServedRequested()) {
    expect((engine as { multiuser?: boolean }).multiuser).toBe(true);
    expect(rerun?.seen.multiuser).toBe(true);
  }
}

/** Runs `body` with a forced-rerun wrapper from `opts` when this arm forces; the wrapper is restored after. */
async function forced<T>(engine: BrainEngine, opts: Parameters<typeof forceRerunOnHit>[1], body: (rerun: ForcedRerun | null) => Promise<T>): Promise<T> {
  if (!forcing()) return body(null);
  const rerun = forceRerunOnHit(engine, opts);
  try { return await body(rerun); } finally { rerun.restore(); }
}

/** A fresh checkout of `SRC` holding `slug` as a file-backed page with `content`, imported with no embeddings. */
async function filePage(engine: BrainEngine, backend: ParityBackend, tag: string, slug: string, content: string, storage: 'inline' | 'segmented' = 'inline') {
  const root = mkdtempSync(join(home, `${backend}-${tag}-`));
  mkdirSync(join(root, 'notes'));
  await createSource(engine, backend, SRC, {}, root);
  await registerLocalWriter(engine, 'cli');
  if (storage === 'segmented') await engine.setConfig('pages.segmented_storage', 'on');
  const file = join(root, `${slug}.md`);
  writeFileSync(file, content);
  await importFromContent(engine, slug, content, { noEmbed: true, sourceId: SRC });
  return { root, file };
}

/** The stored compiled truth of `slug`, read through the segments when the page is segmented. */
async function storedBody(engine: BrainEngine, slug: string) {
  const page = await engine.getPage(slug, { sourceId: SRC });
  return { storage: page ? page.body_storage ?? 'inline' : undefined,
    body: page?.body_storage === 'segmented' ? (await materializeSegmentedBody(engine, page.id, SRC)).compiled_truth : page?.compiled_truth ?? '' };
}

/** Inserts one legacy-or-fenced fact row on `slug`; `rowNum` set makes it the row of a fence. */
const insertFact = (engine: BrainEngine, slug: string, claim: string, rowNum?: number) => engine.transaction(tx => withCoordinatedWrite(tx, [SRC], async () => {
  const out = await tx.insertFacts([{ fact: claim, entity_slug: slug, ...(rowNum === undefined ? {} : { source_markdown_slug: slug, row_num: rowNum }), kind: 'fact',
    visibility: 'world', source: 'test' }] as never, { source_id: SRC });
  return Number(out.ids[0]);
}, TEST_WRITE_ATTRIBUTION));

/** Forgets row 1 of a page filed with a two-row fence; `opts` forces the transaction runs (none: no rerun). */
async function forgetOnFence(engine: BrainEngine, backend: ParityBackend, storage: 'inline' | 'segmented', opts: Parameters<typeof forceRerunOnHit>[1] | null) {
  const slug = `notes/rerun-${storage}`, claim = `Prefers the ${storage} window seat`;
  const content = `---\ntitle: Reason\ntype: note\n---\n\n# Reason\n\n## Facts\n\n${fence(claim)}\n\n${filler(storage === 'segmented' ? 1500 : 2)}`;
  const { file } = await filePage(engine, backend, `forget-${storage}`, slug, content, storage);
  const id = await insertFact(engine, slug, claim, 1);
  try {
    const { result, rerun } = await forced(engine, opts ? { ...opts, ...(storage === 'inline' ? { after: () => readFileSync(file, 'utf8') !== content } : {}) } : {}, async rerun => ({
      result: await withCoordinatedWrite(engine, [SRC], () => forgetFactInFence(engine, id, { reason: REASON }), TEST_WRITE_ATTRIBUTION), rerun }));
    assertArm(engine, backend, opts ? rerun : null);
    const stored = await storedBody(engine, slug);
    const row = (text: string) => rowsOf(text).find(line => line.startsWith('| 1 |'));
    return { result: { ok: result.ok, path: result.path, warning: result.warning }, storage: stored.storage, stored: row(stored.body), filed: row(readFileSync(file, 'utf8')) };
  } finally {
    await disposePersistenceConsumer(engine).catch(() => undefined);
  }
}

describe('engine parity: the facts file writers when a transaction runs again', () => {
  parityTest('a forget on a segmented page whose segment rewrite runs twice strikes the row with the caller\'s reason in the file and the stored segment', {
    methods: ['insertFacts', 'getPage', 'readSourceState', 'readPageFileOrigin', 'readSegmentedRewritePage'],
    timeout: 600_000,
  }, async (engine, backend) => withEnv({ GBRAIN_HOME: home }, async () => {
    // Every run of a segment rewrite is forced, so the last rewrite (the file's row, with the caller's reason) is a rerun too.
    const out = await forgetOnFence(engine, backend, 'segmented', { members: ['readSegmentedRewritePage'] });
    expect(out.result).toEqual({ ok: true, path: 'fence', warning: undefined });
    expect(out.storage).toBe('segmented');
    expect(out.stored).toContain(`forgotten: ${REASON} \\| said at lunch`);
    expect(out.stored).toBe(out.filed);
    return out;
  }));

  parityTest('a forget on an inline page whose mirror transaction publishes the file and runs twice still strikes the row in the file and the stored body, never held', {
    methods: ['insertFacts', 'getPage', 'readSourceState', 'readPageFileOrigin'],
    timeout: 300_000,
  }, async (engine, backend) => withEnv({ GBRAIN_HOME: home }, async () => {
    const out = await forgetOnFence(engine, backend, 'inline', { limit: 1 });
    expect(out.result).toEqual({ ok: true, path: 'fence', warning: undefined });
    expect(out.storage).toBe('inline');
    expect(out.stored).toContain(`forgotten: ${REASON} \\| said at lunch`);
    expect(out.stored).toBe(out.filed);
    return out;
  }));

  parityTest('a fact-fence write whose transaction publishes the file and runs twice lands its rows in the file and the database once', {
    methods: ['insertFacts', 'getPage', 'readSourceState', 'readPageFileOrigin', 'listFenceRowClaims'],
    timeout: 300_000,
  }, async (engine, backend) => withEnv({ GBRAIN_HOME: home }, async () => {
    const slug = 'notes/alice-example';
    const content = '---\ntitle: Alice Example\ntype: note\n---\n\n# Alice Example\n\nWorks at acme-example.\n';
    const { root, file } = await filePage(engine, backend, 'fence-write', slug, content);
    const input = (fact: string): FenceInputFact => ({ fact, kind: 'fact', notability: 'medium', source: 'test', visibility: 'world', confidence: 1,
      validFrom: new Date(Date.UTC(2026, 0, 1)), embedding: null, sessionId: null });
    try {
      const { result, rerun } = await forced(engine, { limit: 1, after: () => readFileSync(file, 'utf8') !== content }, async rerun => ({
        result: await withCoordinatedWrite(engine, [SRC], () => writeFactsToFence(engine, { sourceId: SRC, localPath: root, slug, resolutionSource: 'exact_page' },
          [input('Prefers the aisle seat'), input('Walks to work')]), TEST_WRITE_ATTRIBUTION), rerun }));
      assertArm(engine, backend, rerun);
      const filed = rowsOf(readFileSync(file, 'utf8')), stored = rowsOf((await storedBody(engine, slug)).body);
      const facts = (await engine.listFenceRowClaims(SRC, slug)).map(f => `${Number(f.row_num)}:${f.fact}`).sort();
      const out = { inserted: result.inserted, fenceWriteFailed: result.fenceWriteFailed ?? null, legacyFallback: result.legacyFallback ?? null, warning: result.warning ?? null, filed: filed.length, stored_matches_file: JSON.stringify(stored) === JSON.stringify(filed), facts };
      expect(out.inserted).toBe(2);
      expect(out.fenceWriteFailed).toBeNull();
      expect(out.legacyFallback).toBeNull();
      expect(out.warning).toBeNull();
      expect(out.facts).toEqual(['1:Prefers the aisle seat', '2:Walks to work']);
      expect(out.stored_matches_file).toBe(true);
      expect(out.filed).toBe(2);
      return out;
    } finally {
      await disposePersistenceConsumer(engine).catch(() => undefined);
    }
  }));

  parityTest('an adoption of legacy fact rows whose transaction publishes the file and runs twice reports them adopted, in the file and the database, never held', {
    methods: ['insertFacts', 'getPage', 'readPageFileOrigin', 'listFenceRowClaims', 'countUnfencedFactGroups', 'listUnfencedFactRows', 'adoptFactIntoFence'],
    timeout: 300_000,
  }, async (engine, backend) => withEnv({ GBRAIN_HOME: home }, async () => {
    const slug = 'notes/alice-example', claim = 'Prefers the aisle seat';
    const content = '---\ntitle: Alice Example\ntype: note\n---\n\n# Alice Example\n\nWorks at acme-example.\n';
    const { file } = await filePage(engine, backend, 'unfenced', slug, content);
    await insertFact(engine, slug, claim);
    try {
      const plan = await planUnfencedFacts(engine, { sourceId: SRC });
      const { outcome, rerun } = await forced(engine, { limit: 1, after: () => readFileSync(file, 'utf8') !== content }, async rerun => ({
        outcome: await fenceUnfencedFacts(engine, plan), rerun }));
      assertArm(engine, backend, rerun);
      const filed = rowsOf(readFileSync(file, 'utf8')), stored = rowsOf((await storedBody(engine, slug)).body);
      const facts = (await engine.listFenceRowClaims(SRC, slug)).map(f => `${Number(f.row_num)}:${f.fact}`);
      const out = { scanned: outcome.scanned, fenced: outcome.fenced, pages_touched: outcome.pages_touched, fenced_slugs: outcome.fenced_slugs, failed_pages: outcome.failed_pages,
        write_errors: outcome.write_errors, filed: filed.length, stored_matches_file: JSON.stringify(stored) === JSON.stringify(filed), facts };
      expect(out).toMatchObject({ scanned: 1, fenced: 1, pages_touched: 1, fenced_slugs: [slug], failed_pages: [], write_errors: 0, filed: 1, stored_matches_file: true, facts: [`1:${claim}`] });
      expect(filed[0]).toContain(claim);
      return out;
    } finally {
      await disposePersistenceConsumer(engine).catch(() => undefined);
    }
  }));
});
