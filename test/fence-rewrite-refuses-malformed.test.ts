/**
 * #6385 R12: a fence rewrite never deletes the rows its parser could not
 * read. Every rewriter re-renders the parsed rows, so each one refuses when
 * the fence it starts from parses with warnings, and keeps the bytes, the
 * stored facts and the row numbers: the primitives (`upsertFactRow`,
 * `upsertTakeRow`, `supersedeRow`, `mergePhantomFenceRows`, `strikeFenceRow`),
 * the classic file writers (fence append, remember, forget, phantom redirect)
 * and the coordinated ones (remember, managed fact publication), which refuse
 * typed `invalid_fence` / `target_fence_malformed`. Synthetic content only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { FACTS_FENCE_BEGIN as FB, FACTS_FENCE_END as FE, parseFactsFence, upsertFactRow } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN as TB, TAKES_FENCE_END as TE, supersedeRow, upsertTakeRow } from '../src/core/takes-fence.ts';
import { strikeFenceRow, forgetFactInFence } from '../src/core/facts/forget.ts';
import { withdrawnFact } from '../src/core/facts/withdrawal-overlay.ts';
import { mergePhantomFenceRows, phantomHasResidue, tryRedirectPhantom } from '../src/core/cycle/phantom-redirect.ts';
import { redirectManagedPhantom } from '../src/core/cycle/phantom-redirect-managed.ts';
import { writeFactsToFence, type FenceInputFact } from '../src/core/facts/fence-write.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { operations } from '../src/core/operations.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const GOOD = '| 1 | Alice works at Acme | fact | 1.0 | world | medium | 2026-01-01 |  | manual |  |';
// Eight cells: the strict parser skips it with a warning; it is the row a rewrite would delete.
const BAD = '| 2 | Sentinelrowzq9 likes tea | fact | 1.0 | world | medium | 2026-01-02 |';
const EVENT_HEADER = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | claim_metric | claim_value | claim_unit | claim_period | event_type |\n'
  + '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
const EVENT_ROW = '| 1 | Sentinelrowzq9 launch | event | 1.0 | world | high | 2026-01-01 |  | fixture |  |  |  |  |  | user |';
const facts = (...rows: string[]) => `${FB}\n${FH}\n${rows.join('\n')}\n${FE}`;
const page = (title: string, fence: string) => `---\ntitle: ${title}\ntype: person\n---\n# ${title}\n\nSynthetic prose.\n\n## Facts\n\n${fence}\n`;
const MALFORMED = page('Alice', facts(GOOD, BAD));
const EVENT_TYPED = page('Alice', `${FB}\n${EVENT_HEADER}\n${EVENT_ROW}\n${FE}`);
const NEW_ROW = { claim: 'Alice lives in Paris', kind: 'fact' as const, confidence: 1, visibility: 'world' as const, notability: 'medium' as const, validFrom: '2026-02-01', source: 'manual' };
const refusedRewrite = /fence does not parse cleanly, so it was not rewritten/;

describe('the primitives refuse a fence that does not parse cleanly', () => {
  test('the probe: upsertFactRow on a fence with one malformed row refuses instead of deleting it', () => {
    expect(parseFactsFence(MALFORMED).warnings).toHaveLength(1);
    expect(() => upsertFactRow(MALFORMED, NEW_ROW)).toThrow(refusedRewrite);
    expect(() => upsertFactRow(EVENT_TYPED, NEW_ROW)).toThrow(refusedRewrite);
    // A clean fence still appends.
    expect(parseFactsFence(upsertFactRow(page('Alice', facts(GOOD)), NEW_ROW).body).facts.map(f => f.rowNum)).toEqual([1, 2]);
  });

  test('mergePhantomFenceRows refuses a canonical fence that does not parse', () => {
    const phantom = parseFactsFence(facts('| 1 | Phantom claim | fact | 1.0 | world | medium | 2026-01-03 |  | chat |  |')).facts;
    expect(() => mergePhantomFenceRows(MALFORMED, phantom, 0)).toThrow(refusedRewrite);
  });

  test('strikeFenceRow returns null (callers fall back to a DB-only expire) instead of re-rendering without the malformed row', () => {
    expect(strikeFenceRow(MALFORMED, 1, f => withdrawnFact(f, '2026-03-01', 'forgotten'))).toBeNull();
    expect(strikeFenceRow(page('Alice', facts(GOOD)), 1, f => withdrawnFact(f, '2026-03-01', 'forgotten'))).toContain('~~Alice works at Acme~~');
  });

  test('upsertTakeRow and supersedeRow refuse a takes fence with a malformed row', () => {
    const takes = `${TB}\n| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|\n`
      + '| 1 | Acme ships in Q3 | bet | brain | 0.6 | 2026-01 | notes |\n| 2 | Sentinelrowzq9 take | take | brain | heavy | 2026-01 | notes |\n' + TE;
    expect(() => upsertTakeRow(takes, { claim: 'New take', kind: 'take', holder: 'brain', weight: 0.5, active: true })).toThrow(refusedRewrite);
    expect(() => supersedeRow(takes, 1, { claim: 'Acme ships in Q4', kind: 'bet', holder: 'brain', weight: 0.5 }, 3)).toThrow(refusedRewrite);
  });

  test('refuseUnparsedRewrite turns the refusal into typed target_fence_malformed, located, with no row text', async () => {
    const { refuseUnparsedRewrite } = await import('../src/core/fence-repair/refusal.ts');
    const body = `# Alice\n\n${facts(GOOD, BAD)}\n`;
    let error: unknown;
    try { refuseUnparsedRewrite({ compiled_truth: body, timeline: '' }, 'people/alice-example', 'default', () => upsertFactRow(body, NEW_ROW)); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(OperationError);
    const op = error as OperationError;
    expect({ code: op.canonicalCode, reason: op.reason }).toEqual({ code: 'invalid_fence', reason: 'target_fence_malformed' });
    expect(op.message).toMatch(/^Fence target_fence_malformed: in the facts fence \(body\)/);
    expect(JSON.stringify(op.toJSON())).not.toContain('Sentinelrowzq9');
  });
});

describe('classic file writers keep the bytes, the stored facts and the row numbers', () => {
  let engine: PGLiteEngine;
  let brainDir: string;
  const file = (slug: string) => join(brainDir, `${slug}.md`);
  const writeMd = (slug: string, body: string) => { mkdirSync(dirname(file(slug)), { recursive: true }); writeFileSync(file(slug), body); };
  const input = (fact: string): FenceInputFact => ({ fact, kind: 'fact', notability: 'medium', source: 'manual', visibility: 'world', confidence: 1,
    validFrom: new Date(Date.UTC(2026, 1, 1)), embedding: null, sessionId: null });
  const target = (slug: string) => ({ sourceId: 'default', localPath: brainDir, slug, resolutionSource: 'exact_page' as const });
  const factRows = async (slug: string) => engine.executeRaw<{ fact: string; row_num: number; expired_at: unknown }>(
    "SELECT fact,row_num,expired_at FROM facts WHERE source_id='default' AND source_markdown_slug=$1 ORDER BY row_num", [slug]);

  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    await resetPgliteState(engine);
    brainDir = mkdtempSync(join(tmpdir(), 'fence-rewrite-refuses-'));
    _resetWriteThroughCacheForTest();
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [brainDir]);
  });

  test('a fence append refuses typed, writes no .tmp, inserts nothing and leaves the file as it was', () => withEnv({ GBRAIN_HOME: brainDir }, async () => {
    const slug = 'people/alice-example';
    writeMd(slug, MALFORMED);
    const result = await writeFactsToFence(engine, target(slug), [input('Alice lives in Paris')]);
    expect(result.fenceWriteFailed).toBe(true);
    expect(result.inserted).toBe(0);
    expect({ code: result.fenceRefusal?.canonicalCode, reason: result.fenceRefusal?.reason }).toEqual({ code: 'invalid_fence', reason: 'target_fence_malformed' });
    expect(JSON.stringify(result.fenceRefusal?.toJSON())).not.toContain('Sentinelrowzq9');
    expect(readFileSync(file(slug), 'utf8')).toBe(MALFORMED);
    expect(existsSync(`${file(slug)}.tmp`)).toBe(false);
    expect(await factRows(slug)).toEqual([]);
  }));

  test('an unsupported header column refuses the append instead of rewriting the header without its cells', () => withEnv({ GBRAIN_HOME: brainDir }, async () => {
    const slug = 'people/alice-example';
    writeMd(slug, EVENT_TYPED);
    const result = await writeFactsToFence(engine, target(slug), [input('Alice lives in Paris')]);
    expect(result.fenceRefusal?.canonicalCode).toBe('invalid_fence');
    expect(readFileSync(file(slug), 'utf8')).toBe(EVENT_TYPED);
  }));

  test('remember (writeSingleFact) fails instead of deleting the malformed row', () => withEnv({ GBRAIN_HOME: brainDir }, async () => {
    const slug = 'people/alice-example';
    await engine.putPage(slug, { type: 'person', title: 'Alice', compiled_truth: '# Alice', timeline: '', frontmatter: {} });
    writeMd(slug, MALFORMED);
    await expect(writeSingleFact(engine, 'default', { fact: 'Alice lives in Paris', entity: slug, provenance: 'manual', visibility: 'world' }))
      .rejects.toThrow(/facts fence write failed for people\/alice-example/);
    expect(readFileSync(file(slug), 'utf8')).toBe(MALFORMED);
    expect(await factRows(slug)).toEqual([]);
  }));

  test('forget expires the fact in the database and leaves a fence it cannot re-render as it was', () => withEnv({ GBRAIN_HOME: brainDir }, async () => {
    const slug = 'people/alice-example';
    writeMd(slug, page('Alice', facts(GOOD)));
    const first = await writeFactsToFence(engine, target(slug), [input('Alice lives in Paris')]);
    expect(first.inserted).toBe(1);
    const written = readFileSync(file(slug), 'utf8');
    const corrupted = written.replace(FE, `${BAD}\n${FE}`);
    writeFileSync(file(slug), corrupted);
    const forgot = await forgetFactInFence(engine, first.ids[0]!);
    expect({ ok: forgot.ok, path: forgot.path }).toEqual({ ok: true, path: 'legacy_db' });
    expect(readFileSync(file(slug), 'utf8')).toBe(corrupted);
    expect((await factRows(slug)).map(r => [r.row_num, r.expired_at !== null])).toEqual([[2, true]]);
  }));

  test('phantom redirect: a canonical fence that does not parse moves nothing', () => withEnv({ GBRAIN_HOME: brainDir, GBRAIN_AUDIT_DIR: join(brainDir, 'audit') }, async () => {
    await engine.putPage('people/alice-example', { type: 'person', title: 'alice-example', compiled_truth: '# alice-example', timeline: '', frontmatter: {} });
    writeMd('people/alice-example', MALFORMED);
    const phantomBody = `# alice\n\n## Facts\n\n${facts('| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |')}\n`;
    await engine.putPage('alice', { type: 'person', title: 'alice', compiled_truth: phantomBody, timeline: '', frontmatter: {} });
    writeMd('alice', phantomBody);
    const phantom = (await engine.getPage('alice', { sourceId: 'default' }))!;
    await expect(tryRedirectPhantom(engine, phantom, 'default', brainDir, false)).rejects.toThrow(refusedRewrite);
    expect(readFileSync(file('people/alice-example'), 'utf8')).toBe(MALFORMED);
    expect(existsSync(file('alice'))).toBe(true);
    expect(await engine.getPage('alice', { sourceId: 'default' })).not.toBeNull();
  }));

  test('phantom redirect: a phantom whose own fence does not parse is drift, not deleted', () => withEnv({ GBRAIN_HOME: brainDir, GBRAIN_AUDIT_DIR: join(brainDir, 'audit') }, async () => {
    await engine.putPage('people/alice-example', { type: 'person', title: 'alice-example', compiled_truth: '# alice-example', timeline: '', frontmatter: {} });
    writeMd('people/alice-example', '# alice-example\n');
    const phantomBody = `# alice\n\n## Facts\n\n${facts(GOOD, BAD)}\n`;
    await engine.putPage('alice', { type: 'person', title: 'alice', compiled_truth: phantomBody, timeline: '', frontmatter: {} });
    writeMd('alice', phantomBody);
    const phantom = (await engine.getPage('alice', { sourceId: 'default' }))!;
    expect((await tryRedirectPhantom(engine, phantom, 'default', brainDir, false)).outcome).toBe('drift');
    expect(readFileSync(file('alice'), 'utf8')).toBe(phantomBody);
    expect(await engine.getPage('alice', { sourceId: 'default' })).not.toBeNull();
  }));
});

describe('coordinated writers refuse typed and keep the stored page', () => {
  let engine: PGLiteEngine;
  const home = mkdtempSync(join(tmpdir(), 'fence-rewrite-coordinated-'));
  const op = (name: string) => operations.find(o => o.name === name)!;
  const ctx = () => ({ engine, config: { engine: 'pglite' as const }, logger: { info() {}, warn() {}, error() {} }, dryRun: false,
    remote: false, sourceId: 'default', deferEmbeds: true }) as unknown as OperationContext;
  /** A stored body an older writer left (put_page itself normalizes or refuses it). */
  async function store(slug: string, body: string) {
    await op('put_page').handler(ctx(), { slug, content: page('Seed', 'Seed fence pending.') });
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
      'UPDATE pages SET compiled_truth=$3 WHERE source_id=$1 AND slug=$2', ['default', slug, body]), TEST_WRITE_ATTRIBUTION));
  }
  async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
    try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
    throw new Error('expected a refusal');
  }
  const stored = async (slug: string) => (await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth;

  beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }), 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

  test('remember on an entity whose fence has an unsupported column refuses typed and changes nothing', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const slug = 'people/remember-event-type';
    const body = `# Seed\n\nSynthetic prose.\n\n${FB}\n${EVENT_HEADER}\n${EVENT_ROW}\n${FE}\n`;
    await store(slug, body);
    const error = await refusal(() => op('remember').handler(ctx(), { fact: 'Should not be saved', provenance: 'chat', entity: slug }));
    expect({ detail: error.detail, reason: error.reason }).toEqual({ detail: 'invalid_fence', reason: 'target_fence_malformed' });
    expect(JSON.stringify(error.toJSON())).not.toContain('Sentinelrowzq9');
    expect(await stored(slug)).toBe(body);
    expect(await engine.executeRaw("SELECT 1 FROM facts WHERE fact='Should not be saved'")).toEqual([]);
  }));

  test('remember on an entity whose fence has a malformed row refuses typed and keeps the row', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const slug = 'people/remember-malformed';
    const body = `# Seed\n\nSynthetic prose.\n\n${facts(GOOD, BAD)}\n`;
    await store(slug, body);
    const error = await refusal(() => op('remember').handler(ctx(), { fact: 'Should not be saved either', provenance: 'chat', entity: slug }));
    expect(error.detail).toBe('invalid_fence');
    expect(await stored(slug)).toBe(body);
  }));

  test('managed phantom redirect: a fence that does not parse on either side is drift and both pages stay as they were', () => withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: join(home, 'audit') }, async () => {
    const cleanCanonical = `# Seed\n\nSynthetic prose.\n\n${facts(GOOD)}\n`;
    const brokenCanonical = `# Seed\n\nSynthetic prose.\n\n${facts(GOOD, BAD)}\n`;
    for (const [phantomSlug, canonicalBody, phantomBody] of [
      ['managed-canonical-broken', brokenCanonical, facts(GOOD)],
      ['managed-phantom-broken', cleanCanonical, facts(GOOD, BAD)],
    ] as const) {
      const canonical = `people/${phantomSlug}`;
      await store(canonical, canonicalBody);
      await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.putPage(phantomSlug,
        { type: 'person', title: phantomSlug, compiled_truth: phantomBody, timeline: '', frontmatter: {} }), TEST_WRITE_ATTRIBUTION));
      const phantom = (await engine.getPage(phantomSlug, { sourceId: 'default' }))!;
      expect(await phantomHasResidue(engine, phantom)).toBe(false);
      expect(await redirectManagedPhantom(engine, phantom, canonical, 'default')).toEqual({ outcome: 'drift', canonical });
      expect(await stored(canonical)).toBe(canonicalBody);
      expect(await stored(phantomSlug)).toBe(phantomBody);
    }
  }));

  test('managed fact publication (writeFactsToFence on a managed brain) refuses typed and keeps the stored page', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const slug = 'people/managed-event-type';
    const body = `# Seed\n\nSynthetic prose.\n\n${FB}\n${EVENT_HEADER}\n${EVENT_ROW}\n${FE}\n`;
    await store(slug, body);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try {
      const error = await refusal(() => writeFactsToFence(engine, { sourceId: 'default', localPath: null, slug, resolutionSource: 'exact_page' }, [
        { fact: 'Prefers weekly status reports.', kind: 'preference', source: 'fixture', visibility: 'private', notability: 'medium', embedding: null, sessionId: null }]));
      expect({ code: error.canonicalCode, reason: error.reason }).toEqual({ code: 'invalid_fence', reason: 'target_fence_malformed' });
      expect(JSON.stringify(error.toJSON())).not.toContain('Sentinelrowzq9');
      expect(await stored(slug)).toBe(body);
      expect(await engine.executeRaw("SELECT 1 FROM facts WHERE fact='Prefers weekly status reports.'")).toEqual([]);
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }
  }), 120_000);
});
