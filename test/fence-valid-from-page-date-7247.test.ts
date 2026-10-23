/**
 * #7247: a facts-fence row without a valid_from cell takes the page's event date (frontmatter date, event_date,
 * published, or a dated filename), never the time the page was imported. Both fence readers agree: the managed
 * canonical projection (put_page, sync, import) and the extract_facts cycle phase.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

let engine: BrainEngine;

async function call(name: string, params: Record<string, unknown>) {
  const res = await dispatchToolCall(engine, name, params, { remote: false });
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text!) as Record<string, any> };
}
const fence = (validFrom: string) => [
  '## Facts', '', '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  `| 1 | Acme Example ARR was 100 units | fact | 1.0 | private | medium | ${validFrom} |  | test |  |`,
  '<!--- gbrain:facts:end -->', ''].join('\n');
async function validFromOf(slug: string): Promise<string> {
  const [r] = await engine.executeRaw<{ valid_from: Date | string }>('SELECT valid_from FROM facts WHERE source_markdown_slug = $1', [slug]);
  return new Date(r!.valid_from).toISOString().slice(0, 10);
}

for (const backend of testBackends()) {
  describe(backend, () => {
    let pglite: PGLiteEngine | undefined;
    let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (backend === 'postgres') template = await persistencePostgresTemplate(requirePostgresTestDatabase());
      else { pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); }
    }, 120_000);
    afterAll(async () => { resetGateway(); await template?.dispose(); await pglite?.disconnect(); });
    beforeEach(async () => {
      if (pglite) { engine = pglite; await disposePersistenceConsumer(engine); await resetPgliteState(pglite); }
      else { const c = await template!.clone(); engine = c.engine; close = c.close; }
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
    }, 60_000);
    afterEach(async () => { if (close) { await disposePersistenceConsumer(engine); await close(); close = undefined; } });

    describe('#7247 fence valid_from fallback', () => {
      test('a blank cell takes the page date, not the import time', async () => {
        const put = await call('put_page', { slug: 'companies/acme-example', content: `---\ntitle: Acme Example\ntype: company\ndate: 2025-05-01\n---\n# Acme Example\n\n${fence('')}` });
        expect(put.isError).toBe(false);
        expect(await validFromOf('companies/acme-example')).toBe('2025-05-01');
      });
      test('an explicit cell wins over the page date', async () => {
        await call('put_page', { slug: 'companies/acme-example', content: `---\ntitle: Acme Example\ntype: company\ndate: 2025-05-01\n---\n# Acme Example\n\n${fence('2025-02-01')}` });
        expect(await validFromOf('companies/acme-example')).toBe('2025-02-01');
      });
    });

    describe('#7247 a creation date is not an event date', () => {
      test('a page dated only by created: leaves blank cells at the recorded time (projection and extract_facts)', async () => {
        const today = new Date().toISOString().slice(0, 10);
        await call('put_page', { slug: 'companies/acme-example', content: `---\ntitle: Acme Example\ntype: company\ncreated: 2024-01-01\n---\n# Acme Example\n\n${fence('')}` });
        expect(await validFromOf('companies/acme-example')).toBe(today);
        await engine.executeRaw('DELETE FROM facts WHERE source_markdown_slug = $1', ['companies/acme-example']);
        const { runExtractFacts } = await import('../src/core/cycle/extract-facts.ts');
        await runExtractFacts(engine, { sourceId: 'default', slugs: ['companies/acme-example'] });
        expect(await validFromOf('companies/acme-example')).toBe(today);
      });
      test('extract_facts uses a stated page date for blank cells', async () => {
        await call('put_page', { slug: 'companies/acme-example', content: `---\ntitle: Acme Example\ntype: company\ndate: 2025-05-01\n---\n# Acme Example\n\n${fence('')}` });
        await engine.executeRaw('DELETE FROM facts WHERE source_markdown_slug = $1', ['companies/acme-example']);
        const { runExtractFacts } = await import('../src/core/cycle/extract-facts.ts');
        await runExtractFacts(engine, { sourceId: 'default', slugs: ['companies/acme-example'] });
        expect(await validFromOf('companies/acme-example')).toBe('2025-05-01');
      });
    });
  });
}
