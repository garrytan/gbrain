/**
 * #6188 PR2: Tier 1 on the foreground write paths. put_page stores a fence it
 * can fix losslessly in its normalized form and reports it (`fences_normalized`
 * plus one `fence_normalized` coaching notice); a residual fence refuses typed
 * `invalid_fence` with `fence_issues`. Normalization runs before the remote
 * hidden-row merge (E7), so a remote write with a fixable fence keeps every
 * private row. Append verbs normalize their target fence in the same write
 * (D20); edit_page and the other takes writes refuse typed (D19). The export
 * roundtrip refuses typed instead of normalizing (E16); synthesize verify
 * normalizes before it compiles. `fences.normalize=false` restores refusing.
 * Synthetic content only; no claim, holder or kind value leaves the page.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { FACTS_FENCE_BEGIN as FB, FACTS_FENCE_END as FE, parseFactsFence } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN as TB, TAKES_FENCE_END as TE, parseTakesFence } from '../src/core/takes-fence.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { assertExportProjectionRoundtrip } from '../src/core/shared-skills/migration-projection.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { verifyAndRepairDreamPages } from '../src/core/cycle/synthesize-verify.ts';
import { FENCE_TREND_OP } from '../src/core/fence-repair/census-store.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const TH = '| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|';
const fact = (n: number, claim: string, o: { kind?: string; vis?: string } = {}) => `| ${n} | ${claim} | ${o.kind ?? 'fact'} | 1.0 | ${o.vis ?? 'world'} | medium | 2026-01-01 |  | chat |  |`;
const take = (n: number, claim: string, o: { kind?: string; who?: string } = {}) => `| ${n} | ${claim} | ${o.kind ?? 'take'} | ${o.who ?? 'brain'} | 0.7 | 2026-01 | chat |`;
const factsFence = (...rows: string[]) => `${FB}\n${FH}\n${rows.join('\n')}\n${FE}`;
const takesFence = (...rows: string[]) => `${TB}\n${TH}\n${rows.join('\n')}\n${TE}`;
const page = (title: string, body: string) => `---\ntitle: ${title}\n---\n# ${title}\n\nSynthetic prose.\n\n${body}\n`;
// Unique strings that must never appear in a refusal, notice, receipt or result.
const SECRET_CLAIM = 'Sentinelverbzq9 signed with an example vendor', SECRET_KIND = 'sentinelkindzq9';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-fence-verbs-'));
const env = { GBRAIN_HOME: home };
const op = (name: string) => operations.find(o => o.name === name)!;

function ctx(opts: { remote?: boolean; notices?: Notice[] } = {}): OperationContext {
  return { engine, config: { engine: 'pglite' as const }, logger: { info: () => {}, warn: () => {}, error: () => {} }, dryRun: false,
    remote: opts.remote ?? false, sourceId: 'default', deferEmbeds: true, ...(opts.notices ? { emitNotice: (n: Notice) => opts.notices!.push(n) } : {}) } as OperationContext;
}
async function put(slug: string, content: string, opts: { remote?: boolean; notices?: Notice[] } = {}) {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
  return op('put_page').handler(ctx(opts), { slug, content, ...(snapshot ? { expected_revision: snapshot.revision } : {}) }) as Promise<Record<string, any>>;
}
async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}
/** A stored body an older writer left malformed (put_page itself normalizes or refuses it). */
async function storeMalformed(slug: string, body: string) {
  await put(slug, page('Seed', 'Seed fence pending.'));
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
    'UPDATE pages SET compiled_truth=$3 WHERE source_id=$1 AND slug=$2', ['default', slug, `# Seed\n\nSynthetic prose.\n\n${body}\n`]), TEST_WRITE_ATTRIBUTION));
}
const stored = async (slug: string) => (await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth;
const expectNoSecrets = (value: unknown) => { const text = JSON.stringify(value); for (const s of [SECRET_CLAIM, SECRET_KIND, 'Sentinelverbzq9']) expect(text).not.toContain(s); };

beforeAll(async () => withEnv(env, async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}), 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });
beforeEach(async () => { await engine.unsetConfig('fences.normalize'); });

describe('put_page', () => {
  test('a fixable fence is stored normalized, reported once with a coaching notice naming rows and classes, and a clean write has neither', () => withEnv(env, async () => {
    const notices: Notice[] = [];
    const result = await put('people/fixable-put', page('Fixable', factsFence(fact(1, SECRET_CLAIM, { kind: SECRET_KIND }), fact(1, 'Second claim'))), { notices });
    expect(result.fences_normalized).toMatchObject({ count: 1, by_class: { kind_map: 1, renumber: 1 }, writers: [{ writer: 'local_cli', count: 1 }] });
    expect(result.fences_normalized.fix.argv).toEqual(['gbrain', 'get', '--source', 'default', '--', 'people/fixable-put']);
    const facts = parseFactsFence(await stored('people/fixable-put')).facts;
    expect(facts.map(f => [f.rowNum, f.claim, f.kind])).toEqual([[1, SECRET_CLAIM, 'fact'], [2, 'Second claim', 'fact']]);
    expect(facts[0]!.context).toBe(`original kind: ${SECRET_KIND}`);
    expect(notices.map(n => [n.code, n.kind])).toEqual([['fence_normalized', 'coaching']]);
    expect(notices[0]!.why).toContain('kind_map row 1 column kind (facts, body)');
    expect(notices[0]!.why).toContain('renumber row 2 column # (facts, body)');
    expect(notices[0]!.why).toContain('Re-read it with get_page before editing');
    expect(notices[0]!.why).toContain('`remember`');
    expect(notices[0]!.why).toContain('`takes_add`');
    expectNoSecrets({ fences: result.fences_normalized, notices });
    const clean: Notice[] = [];
    const again = await put('people/clean-put', page('Clean', factsFence(fact(1, 'Plain claim'))), { notices: clean });
    expect(again.fences_normalized).toBeUndefined();
    expect(clean).toEqual([]);
  }));

  test('a residual fence refuses typed invalid_fence with fence_issues naming rows, columns and the allowed vocabulary', () => withEnv(env, async () => {
    const error = await refusal(() => put('people/residual-put', page('Residual', factsFence(fact(1, SECRET_CLAIM, { vis: 'blorp' }), fact(2, 'Other', { vis: 'qwerty' })))));
    const wire = error.toJSON() as Record<string, any>;
    expect({ error: wire.error, code: error.canonicalCode, reason: error.reason }).toEqual({ error: 'invalid_params', code: 'invalid_fence', reason: 'enum_unmapped' });
    expect(error.message).toMatch(/^Fence enum_unmapped: in the facts fence \(body\), rows 1, 2, column visibility, at line \d+\./);
    expect(wire.fence).toMatchObject({ reason: 'enum_unmapped', fence: 'facts', section: 'body', rows: [1, 2], columns: ['visibility'] });
    expect(wire.fence_issues).toEqual([
      expect.objectContaining({ fence: 'facts', section: 'body', row: 1, column: 'visibility', class: 'enum_unmapped', allowed: ['private', 'world'] }),
      expect.objectContaining({ fence: 'facts', section: 'body', row: 2, column: 'visibility', class: 'enum_unmapped' }),
    ]);
    expectNoSecrets(wire);
    expect(await engine.getPage('people/residual-put', { sourceId: 'default' })).toBeNull();
  }));

  test('fences.normalize=false: a fixable fence refuses typed, located as the projection would refuse it, and nothing is written', () => withEnv(env, async () => {
    await engine.setConfig('fences.normalize', 'false');
    const error = await refusal(() => put('people/switch-off', page('Off', factsFence(fact(1, SECRET_CLAIM, { kind: SECRET_KIND })))));
    expect({ code: error.canonicalCode, reason: error.reason }).toEqual({ code: 'invalid_fence', reason: 'enum_unmapped' });
    expect((error.toJSON() as Record<string, any>).fence_issues).toEqual([expect.objectContaining({ row: 1, column: 'kind', class: 'kind_map' })]);
    expectNoSecrets(error.toJSON());
    expect(await engine.getPage('people/switch-off', { sourceId: 'default' })).toBeNull();
  }));

  test('E7: a remote write-back with a fixable fence keeps every hidden private row', () => withEnv(env, async () => {
    const slug = 'people/e7-hidden';
    await put(slug, page('E7', factsFence(fact(1, 'Public claim'), fact(2, 'PRIVATE_E7_FACT', { vis: 'private' }))));
    const view = await op('get_page').handler(ctx({ remote: true }), { slug, include_content: true }) as { content: string };
    expect(view.content).not.toContain('PRIVATE_E7_FACT');
    // The remote caller appends a row with an invented kind and leaves the end marker off: both are fixable.
    const edited = view.content.replace(fact(1, 'Public claim'), `${fact(1, 'Public claim')}\n${fact(3, 'Remote claim', { kind: 'partnership' })}`).replace(`\n${FE}`, '\n');
    expect(parseFactsFence(edited).warnings.length).toBeGreaterThan(0);
    const notices: Notice[] = [];
    const result = await put(slug, edited, { remote: true, notices });
    expect(result.fences_normalized).toBeDefined();
    const facts = parseFactsFence(await stored(slug)).facts;
    expect(facts.map(f => [f.rowNum, f.claim, f.visibility, f.kind])).toEqual([
      [1, 'Public claim', 'world', 'fact'], [2, 'PRIVATE_E7_FACT', 'private', 'fact'], [3, 'Remote claim', 'world', 'fact']]);
    // The remote caller is told only about its own rows.
    expect(JSON.stringify([result.fences_normalized, notices])).not.toContain('row 2');
    expect(JSON.stringify([result, notices])).not.toContain('PRIVATE_E7_FACT');
  }));
});

test('put_pages reports one batch-level fences_normalized and one notice for the pages Tier 1 rewrote', () => withEnv(env, async () => {
  const notices: Notice[] = [];
  const result = await op('put_pages').handler(ctx({ notices }), { request_id: crypto.randomUUID(), pages: [
    { slug: 'people/batch-fixable', content: page('Batch fixable', factsFence(fact(0, 'Zero row claim'))) },
    { slug: 'people/batch-clean', content: page('Batch clean', factsFence(fact(1, 'Clean claim'))) },
  ] }) as Record<string, any>;
  expect(result.state).toBe('committed');
  expect(result.fences_normalized).toMatchObject({ count: 1, by_class: { renumber: 1 } });
  expect(result.pages.map((p: Record<string, unknown>) => !!p.fences_normalized)).toEqual([true, false]);
  expect(notices.filter(n => n.code === 'fence_normalized')).toHaveLength(1);
  expect(parseFactsFence(await stored('people/batch-fixable')).facts.map(f => f.rowNum)).toEqual([1]);
}));

describe('normalization trend (E33)', () => {
  test('each normalized write adds one trend row with its classes and writer; clean writes and refused writes add none', () => withEnv(env, async () => {
    const rows = () => engine.executeRaw<{ fingerprint: string; record: Record<string, unknown> }>(
      `SELECT fingerprint, completed_keys->0 AS record FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'source_id'='default'`, [FENCE_TREND_OP]);
    const before = new Set((await rows()).map(r => r.fingerprint));
    await put('people/trend-fixable', page('Trend', factsFence(fact(1, 'Trend claim'), fact(1, 'Second trend claim'))));
    await put('people/trend-clean', page('Clean', factsFence(fact(1, 'Plain trend claim'))));
    await refusal(() => put('people/trend-residual', page('Residual', factsFence(fact(1, 'Bad trend claim', { vis: 'blorp' })))));
    const slug = 'people/trend-remember';
    await storeMalformed(slug, `${FB}\n${FH}\n${fact(1, 'Existing trend claim')}`);
    await op('remember').handler(ctx(), { fact: 'A remembered trend fact', provenance: 'chat', entity: slug });
    const added = (await rows()).filter(r => !before.has(r.fingerprint)).map(r => r.record);
    expect(added).toHaveLength(2);
    expect(added.map(r => ({ count: r.count, writers: r.writers }))).toEqual([{ count: 1, writers: { local_cli: 1 } }, { count: 1, writers: { local_cli: 1 } }]);
    expect(added.map(r => r.by_class).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([{ close_fence: 1 }, { renumber: 1 }]);
    expectNoSecrets(added);
  }));
});

describe('append verbs normalize their target fence in the same write (D20)', () => {
  test('remember on a page whose facts fence lost its end marker saves the fact and reports close_fence', () => withEnv(env, async () => {
    const slug = 'people/remember-target';
    await storeMalformed(slug, `${FB}\n${FH}\n${fact(1, 'Existing claim')}`);
    const notices: Notice[] = [];
    const saved = await op('remember').handler(ctx({ notices }), { fact: 'A remembered synthetic fact', provenance: 'chat', entity: slug }) as Record<string, any>;
    expect(saved.status).toBe('inserted');
    expect(saved.fences_normalized).toMatchObject({ count: 1, by_class: { close_fence: 1 } });
    const parsed = parseFactsFence(await stored(slug));
    expect(parsed.warnings).toEqual([]);
    expect(parsed.facts.map(f => f.claim)).toEqual(['Existing claim', 'A remembered synthetic fact']);
    expect(notices.filter(n => n.code.startsWith('fence')).map(n => n.code)).toEqual(['fence_normalized']);
  }));

  test('remember on a page whose facts fence stays residual refuses typed target_fence_malformed and saves nothing', () => withEnv(env, async () => {
    const slug = 'people/remember-residual';
    await storeMalformed(slug, factsFence(fact(1, SECRET_CLAIM, { vis: 'blorp' })));
    const error = await refusal(() => op('remember').handler(ctx(), { fact: 'Should not be saved', provenance: 'chat', entity: slug }));
    // MEMORY_VERBS v1 freezes the verb's code; the typed fence refusal rides in detail, reason, fence and fence_issues.
    const wire = error.toJSON() as Record<string, any>;
    expect({ code: error.code, detail: error.detail, reason: error.reason }).toEqual({ code: 'invalid_params', detail: 'invalid_fence', reason: 'target_fence_malformed' });
    expect(error.message).toMatch(/^Fence target_fence_malformed: in the facts fence \(body\), row 1, column visibility/);
    expect(wire.fence_issues).toEqual([expect.objectContaining({ row: 1, column: 'visibility', class: 'enum_unmapped' })]);
    expect(error.suggestion).toContain('Read the page with get_page');
    expectNoSecrets(error.toJSON());
    expect(await engine.executeRaw("SELECT 1 FROM facts WHERE fact='Should not be saved'")).toEqual([]);
  }));

  test('takes_add normalizes the stored takes fence (an invented kind) and re-indexes the rewritten row with the new one', () => withEnv(env, async () => {
    const slug = 'people/takes-target';
    await storeMalformed(slug, takesFence(take(1, 'Existing take', { kind: 'assessment' })));
    const added = await op('takes_add').handler(ctx(), { slug, claim: 'New synthetic take', kind: 'take', holder: 'brain', weight: 0.6, since: '2026-02' }) as Record<string, any>;
    expect(added.fences_normalized).toMatchObject({ by_class: { kind_map: 1 } });
    expect(parseTakesFence(await stored(slug)).takes.map(t => [t.rowNum, t.claim, t.kind])).toEqual([[1, 'Existing take', 'take'], [2, 'New synthetic take', 'take']]);
    expect(await engine.executeRaw('SELECT row_num,kind FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.slug=$1 ORDER BY row_num', [slug]))
      .toEqual([{ row_num: 1, kind: 'take' }, { row_num: 2, kind: 'take' }]);
  }));
});

describe('refuse-only writers (D19)', () => {
  test('edit_page on a page with a fixable stored fence refuses typed and changes nothing', () => withEnv(env, async () => {
    const slug = 'people/edit-target';
    await storeMalformed(slug, factsFence(fact(1, SECRET_CLAIM, { kind: SECRET_KIND })));
    const before = await engine.readPageSnapshot(slug, { sourceId: 'default' });
    const error = await refusal(() => op('edit_page').handler(ctx(), { slug, expected_revision: before!.revision, edits: [{ old_text: 'Synthetic prose.', new_text: 'Edited prose.' }] }));
    expect({ code: error.canonicalCode, reason: error.reason }).toEqual({ code: 'invalid_fence', reason: 'target_fence_malformed' });
    expect(error.message).not.toMatch(/doctor names/);
    expectNoSecrets(error.toJSON());
    expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision).toBe(before!.revision);
  }));

  test('takes_supersede on a malformed takes fence refuses typed with the location, never the parser warning text', () => withEnv(env, async () => {
    const slug = 'people/supersede-target';
    await storeMalformed(slug, takesFence(take(1, SECRET_CLAIM, { kind: SECRET_KIND })));
    const error = await refusal(() => op('takes_supersede').handler(ctx(), { slug, row_num: 1, claim: 'Replacement take' }));
    expect({ code: error.canonicalCode, reason: error.reason }).toEqual({ code: 'invalid_fence', reason: 'target_fence_malformed' });
    expectNoSecrets(error.toJSON());
  }));

  test('the export roundtrip refuses a malformed fence typed instead of normalizing it (E16)', () => withEnv(env, async () => {
    const parsed = parseMarkdown(page('Export', factsFence(fact(1, SECRET_CLAIM, { kind: SECRET_KIND }))), 'people/export.md');
    const error = await refusal(() => assertExportProjectionRoundtrip(engine, parsed, 1, 'default'));
    expect({ code: error.canonicalCode, reason: error.reason }).toEqual({ code: 'invalid_fence', reason: 'enum_unmapped' });
    expect(error.fix?.argv).toEqual(['gbrain', 'repair', 'fences', '--source', 'default', '--slug', 'people/export']);
    expect(error.suggestion).toContain('gbrain repair fences --source default --slug people/export');
    expectNoSecrets(error.toJSON());
  }));
});

test('synthesize verify normalizes a fixable fence before it compiles and writes the verified body', () => withEnv(env, async () => {
  const slug = 'wiki/personal/reflections/verify-fence-aaaaaa';
  await storeMalformed(slug, `Invented: "our destiny is to reinvent human memory for all mankind forever."\n\n${factsFence(fact(1, 'Verify claim', { kind: 'partnership' }))}`);
  // The fence row's numbers are in the source, so the verifier keeps the row and quarantines only the invented quote.
  const transcripts = new Map([['/t/session.md', { content: 'user: Row 1 holds at confidence 1.0 from 2026-01-01, as we agreed.' }]]);
  const stats = await verifyAndRepairDreamPages(engine, [{ slug, source_id: 'default', raw_source: '/t/session.md' }], transcripts, { since: new Date(0) });
  expect({ errors: stats.errors, repaired: stats.pages_repaired }).toEqual({ errors: 0, repaired: 1 });
  const body = await stored(slug);
  expect(body).not.toContain('our destiny');
  expect(parseFactsFence(body).facts.map(f => [f.claim, f.kind])).toEqual([['Verify claim', 'fact']]);
}));
