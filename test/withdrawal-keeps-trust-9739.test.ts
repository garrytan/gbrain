/**
 * #9739: two withdrawal writes author nothing, so they keep the trust tier of the rows they rewrite. The withdrawal
 * mirror's materialization strikes the withdrawn row in the page body (a gbrain-managed fence edit), and a local
 * `forget_fact` with a reason appends `forgotten: <reason>` to the fact's context; both used to lower the row to unknown.
 *
 * PGLite, and Postgres when DATABASE_URL is set. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { maintenanceTransaction } from '../src/core/persistence/attribution.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { materializePageSnapshot } from '../src/core/page-state/materialize.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const HEADER = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n';
const page = (claim: string) => '---\ntitle: Acme Example\ntype: company\n---\n# Acme Example\n\nA company.\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n\n' + HEADER
  + `| 1 | ${claim} | fact | 1.0 | world | medium | 2026-10-01T00:00:00Z |  | test |  |\n` + '<!--- gbrain:facts:end -->\n';

for (const kind of testBackends()) {
  describe(`#9739 withdrawal writes keep the trust tier (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
    }, 120_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); resetGateway(); await close(); });

    const call = async (name: string, params: Record<string, unknown>) => {
      const res = await dispatchToolCall(engine, name, params, { remote: false });
      return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text!) as Record<string, any> };
    };
    const tier = async (table: 'pages' | 'facts', where: string, param: unknown) =>
      (await engine.executeRaw<{ t: string }>(`SELECT trust_tier AS t FROM ${table} WHERE ${where}`, [param]))[0]!.t;

    test('materializing a withdrawal strike keeps the page tier', async () => {
      const slug = 'companies/acme-example';
      const claim = 'Acme Example ships widgets.';
      expect((await call('put_page', { slug, content: page(claim) })).isError).toBe(false);
      expect(await tier('pages', 'slug = $1', slug)).toBe('agent_written');
      const [fact] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_markdown_slug = $1 AND row_num = 1', [slug]);
      // A withdrawal recorded the way forget did before it published through the coordinator (#8481), its mirror effect still queued.
      await maintenanceTransaction(engine, tx => recordFactWithdrawal(tx, Number(fact!.id), 'default'));
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      expect(snapshot.withdrawals).toHaveLength(1);
      await materializePageSnapshot(engine, snapshot);
      const [stored] = await engine.executeRaw<{ compiled_truth: string; t: string }>('SELECT compiled_truth, trust_tier AS t FROM pages WHERE slug = $1', [slug]);
      expect(stored!.compiled_truth).toContain(`~~${claim}~~`);
      expect(stored!.t).toBe('agent_written');
    }, 120_000);

    test('a local forget_fact with a reason keeps the fact tier', async () => {
      const saved = await call('remember', { fact: 'Acme Example opened an office in Lisbon.', provenance: 'test', entity: 'companies/acme-example' });
      expect(saved.isError).toBe(false);
      const id = Number(saved.body.id);
      expect(await tier('facts', 'id = $1', id)).toBe('agent_written');
      const forgotten = await call('forget_fact', { id, reason: 'user asked' });
      expect(forgotten.isError).toBe(false);
      const [row] = await engine.executeRaw<{ context: string; t: string; expired: boolean }>(
        'SELECT context, trust_tier AS t, expired_at IS NOT NULL AS expired FROM facts WHERE id = $1', [id]);
      expect(row).toEqual({ context: expect.stringContaining('forgotten: user asked'), t: 'agent_written', expired: true });
    }, 120_000);
  });
}
