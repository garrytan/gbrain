import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runFactsRelink } from '../src/core/facts/relink.ts';
import { withWriteTrust } from '../src/core/persistence/context.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';

const SLUG = 'people/alice-example';
const config = { engine: 'pglite', embedding_disabled: true } as unknown as GBrainConfig;

for (const backend of testBackends()) {
  describe(`relink provenance #9260 (${backend})`, () => {
    let engine: BrainEngine;
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
      await importFromContent(engine, SLUG, '---\ntitle: Alice Example\ntype: person\n---\n\n# Alice Example\n\nSynthetic fixture.\n', { noEmbed: true });
    }, 120_000);
    afterEach(async () => { await disposePersistenceConsumer(engine); await close?.(); close = undefined; }, 120_000);

    async function seed(suffix: string, from: string, until: string | null = null) {
      return engine.transaction(tx => withWriteTrust(tx, {
        tier: 'external_untrusted', origin: { channel: 'derive:facts_backstop' },
      }, async () => {
        const [row] = await tx.executeRaw<{ id: number }>(`INSERT INTO facts
          (source_id, fact, kind, visibility, source, valid_from, valid_until)
          VALUES ('default', $1, 'event', 'private', 'mcp:put_page', $2::text::timestamptz, $3::text::timestamptz) RETURNING id`,
        [`Alice Example will verify the ${suffix} fixtures on Tuesday.`, from, until]);
        return Number(row!.id);
      }));
    }
    async function stored(id: number) {
      const [row] = await engine.executeRaw<{ value: Record<string, unknown> }>(`SELECT jsonb_build_object(
        'id',id,'fact',fact,'source',source,'visibility',visibility,'trust_tier',trust_tier,'write_origin',write_origin,
        'valid_from',valid_from,'valid_until',valid_until,'entity_slug',entity_slug,'row_num',row_num) AS value FROM facts WHERE id=$1`, [id]);
      return row!.value;
    }
    for (const [name, from, until] of [
      ['whole-second', '2026-01-01T12:08:23Z', null],
      ['milliseconds', '2026-01-01T12:08:23.885Z', '2099-01-01T12:08:23.129Z'],
      ['midnight', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00.001Z'],
    ] as const) {
      test(`preserves origin and exact ${name} validity through real relink and replay`, async () => {
        const id = await seed(name, from, until);
        const before = await stored(id);
        expect(before).toMatchObject({ trust_tier: 'external_untrusted', write_origin: { channel: 'derive:facts_backstop' } });
        const report = await runFactsRelink(engine, { sourceId: 'default', config, llm: false });
        expect(report.linked).toBe(1);
        const after = await stored(id);
        expect(after).toMatchObject({ ...before, entity_slug: SLUG, row_num: 1 });
        const page = (await engine.getPage(SLUG, { sourceId: 'default' }))!;
        const [cell] = parseFactsFence(page.compiled_truth).facts;
        expect(new Date(cell!.validFrom!).toISOString()).toBe(new Date(from).toISOString());
        expect(cell!.validUntil ? new Date(cell!.validUntil).toISOString() : null).toBe(until ? new Date(until).toISOString() : null);
        expect((await runFactsRelink(engine, { sourceId: 'default', config, llm: false })).linked).toBe(0);
        expect(await stored(id)).toEqual(after);
        const receipts = await engine.executeRaw<{ state: string }>("SELECT state FROM persistence_requests WHERE operation='relink_facts'");
        expect(receipts).toEqual([{ state: 'committed' }]);
        const [audit] = await engine.executeRaw<{ last_write_request_id: string | null }>('SELECT last_write_request_id FROM facts WHERE id=$1', [id]);
        expect(audit!.last_write_request_id).not.toBeNull();
      }, 120_000);
    }

    for (const field of ['valid_from', 'valid_until'] as const) {
      test(`refuses unrepresentable ${field} without changing the row while a healthy sibling links`, async () => {
        const id = await seed('microseconds', field === 'valid_from' ? '2026-01-01T12:08:23.885123Z' : '2026-01-01T12:08:23Z',
          field === 'valid_until' ? '2099-01-01T12:08:23.129456Z' : null);
        const healthy = await seed('healthy', '2026-01-01T12:08:23.001Z');
        const before = await stored(id);
        const healthyBefore = await stored(healthy);
        await runFactsRelink(engine, { sourceId: 'default', config, llm: false, dryRun: true });
        expect(await stored(id)).toEqual(before);
        expect(await stored(healthy)).toEqual(healthyBefore);
        const report = await runFactsRelink(engine, { sourceId: 'default', config, llm: false });
        expect(report.linked).toBe(1);
        expect(report.skipped.claim_unfenceable).toBe(1);
        expect(await stored(id)).toEqual(before);
        expect(await stored(healthy)).toMatchObject({ entity_slug: SLUG, write_origin: { channel: 'derive:facts_backstop' } });
      }, 120_000);
    }

    test('duplicate retirement preserves the original provenance as well as the linked winner', async () => {
      const first = await seed('duplicate', '2026-01-01T12:08:23.885Z');
      const second = await seed('duplicate', '2026-01-01T12:08:23.885Z');
      const originals = await Promise.all([stored(first), stored(second)]);
      const report = await runFactsRelink(engine, { sourceId: 'default', config, llm: false });
      expect(report).toMatchObject({ linked: 1, deduped: 1 });
      for (const [index, id] of [first, second].entries()) {
        expect(await stored(id)).toMatchObject({ ...originals[index], entity_slug: SLUG, row_num: index === 0 ? 1 : null });
      }
      const [retired] = await engine.executeRaw<{ expired: boolean }>('SELECT expired_at IS NOT NULL AS expired FROM facts WHERE id=$1', [second]);
      expect(retired!.expired).toBe(true);
    }, 120_000);
  });
}
