/**
 * #9260: `gbrain facts relink` attaches an unlinked fact to its entity page. That is placement, not authorship, so the
 * fact keeps the write origin and trust tier it was written with, and its validity instants exactly as stored. Before
 * the fix the relink's own channel replaced the origin, and the fence cell it wrote rounded valid_from / valid_until
 * down to whole seconds, which the page projection then wrote back to the row.
 *
 * PGLite always; Postgres too when DATABASE_URL is set (test/e2e wrapper).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withWriteTrust } from '../src/core/persistence/context.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runFactsRelink } from '../src/core/facts/relink.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';

const SLUG = 'people/alice-example';
const config = { engine: 'pglite', embedding_disabled: true } as unknown as GBrainConfig;
let engine: BrainEngine;

async function seed(fact: string, validFrom: string, validUntil: string | null): Promise<number> {
  return engine.transaction(tx => withWriteTrust(tx, { tier: 'external_untrusted', origin: { channel: 'derive:facts_backstop' } }, async () => {
    const [row] = await tx.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, fact, kind, visibility, source, valid_from, valid_until)
      VALUES ('default', $1, 'event', 'private', 'mcp:put_page', $2::text::timestamptz, $3::text::timestamptz) RETURNING id`, [fact, validFrom, validUntil]);
    return Number(row!.id);
  }));
}
const stored = async (id: number) => (await engine.executeRaw<{ entity_slug: string | null; source: string; trust_tier: string; channel: string | null; valid_from: string; valid_until: string | null }>(
  `SELECT entity_slug, source, trust_tier, write_origin->>'channel' AS channel,
     to_char(valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS valid_from,
     to_char(valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS valid_until FROM facts WHERE id=$1`, [id]))[0]!;

for (const backend of testBackends()) describe(`[${backend}] #9260: facts relink keeps a fact's origin and validity`, () => {
  let pglite: PGLiteEngine | undefined;
  let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'postgres') template = await persistencePostgresTemplate(requirePostgresTestDatabase());
    else { pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); }
  }, 120_000);
  afterAll(async () => { await template?.dispose(); await pglite?.disconnect(); }, 120_000);
  beforeEach(async () => {
    if (pglite) { engine = pglite; await resetPgliteState(pglite); }
    else { const c = await template!.clone(); engine = c.engine; close = c.close; }
    await engine.setConfig('decide.slots.conflict.mode', 'off');
    await importFromContent(engine, SLUG, '---\ntitle: Alice Example\ntype: person\n---\n\n# Alice Example\n\nA synthetic person.\n', { noEmbed: true });
  }, 120_000);
  afterEach(async () => { await disposePersistenceConsumer(engine); await close?.(); close = undefined; }, 120_000);

  test('the linked row keeps its write origin, trust tier and millisecond validity, and the fence cell carries the same instants', async () => {
    const id = await seed('Alice Example will verify the test fixtures on Tuesday.', '2026-01-01T12:08:23.885Z', '2099-01-01T12:08:23.129Z');
    const before = await stored(id);
    expect(before).toMatchObject({ trust_tier: 'external_untrusted', channel: 'derive:facts_backstop', valid_from: '2026-01-01T12:08:23.885Z', valid_until: '2099-01-01T12:08:23.129Z' });
    expect((await runFactsRelink(engine, { sourceId: 'default', config, llm: false })).linked).toBe(1);
    expect(await stored(id)).toEqual({ ...before, entity_slug: SLUG });
    const [cell] = parseFactsFence((await engine.getPage(SLUG, { sourceId: 'default' }))!.compiled_truth).facts;
    expect([new Date(cell!.validFrom!).toISOString(), new Date(cell!.validUntil!).toISOString()]).toEqual(['2026-01-01T12:08:23.885Z', '2099-01-01T12:08:23.129Z']);
    expect((await runFactsRelink(engine, { sourceId: 'default', config, llm: false })).linked).toBe(0);
    expect(await stored(id)).toEqual({ ...before, entity_slug: SLUG });
  }, 120_000);

  test('a whole-second fact keeps its write origin and its fence cell keeps the whole-second shape', async () => {
    const id = await seed('Alice Example will review the test plan on Friday.', '2026-01-01T12:08:23Z', null);
    const before = await stored(id);
    expect((await runFactsRelink(engine, { sourceId: 'default', config, llm: false })).linked).toBe(1);
    expect(await stored(id)).toEqual({ ...before, entity_slug: SLUG });
    expect((await engine.getPage(SLUG, { sourceId: 'default' }))!.compiled_truth).toContain('2026-01-01T12:08:23Z');
  }, 120_000);

  test('a fact stored finer than a millisecond is left unlinked and unchanged while a sibling links', async () => {
    const fine = await seed('Alice Example will sign the test contract on Monday.', '2026-01-01T12:08:23.885123Z', null);
    const sibling = await seed('Alice Example will file the test report on Wednesday.', '2026-01-01T12:08:23.001Z', null);
    const before = await engine.executeRaw('SELECT * FROM facts WHERE id=$1', [fine]);
    const report = await runFactsRelink(engine, { sourceId: 'default', config, llm: false });
    expect(report.linked).toBe(1);
    expect(report.skipped.claim_unfenceable).toBe(1);
    expect(await engine.executeRaw('SELECT * FROM facts WHERE id=$1', [fine])).toEqual(before);
    expect(await stored(sibling)).toMatchObject({ entity_slug: SLUG, channel: 'derive:facts_backstop', valid_from: '2026-01-01T12:08:23.001Z' });
  }, 120_000);
});
