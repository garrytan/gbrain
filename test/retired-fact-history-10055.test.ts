/**
 * #10055: a fact that stays retired keeps its history when the page around it is written again. A replaced fact's fence
 * row renders its retirement to the second and its context as the generated `superseded by #N` marker, so an edit of an
 * unrelated active row used to restamp the retired row's expired_at and valid_until, replace its original context with
 * the marker and record the edit as the archived row's last write; the background extract_facts reconcile replaced the
 * context the same way. An explicit note in the retired row's context cell still updates it.
 *
 * PGLite, and Postgres when DATABASE_URL is set. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SLUG = 'people/alice-example';
const HEADER = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n';
const PAGE = '---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n\nA person.\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n\n' + HEADER
  + '| 1 | Alice Example works at acme-example. | fact | 1.0 | world | medium | 2026-10-01T00:00:00Z |  | test | met at a call |\n'
  + '| 2 | Alice Example likes tea. | preference | 1.0 | world | medium | 2026-10-01T00:00:00Z |  | test |  |\n'
  + '<!--- gbrain:facts:end -->\n';

for (const kind of testBackends()) {
  describe(`#10055 a retired fact keeps its history across unrelated page writes (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
    }, 120_000);
    afterAll(async () => { setSystemTime(); await disposePersistenceConsumer(engine); resetGateway(); await close(); });

    const call = async (name: string, params: Record<string, unknown>) => {
      const res = await dispatchToolCall(engine, name, params, { remote: false });
      return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text!) as Record<string, any> };
    };
    const retired = async (id: number) => (await engine.executeRaw<Record<string, unknown>>(
      `SELECT context, expired_at::text AS expired_at, valid_until::text AS valid_until, superseded_by::int AS superseded_by, trust_tier, last_write_request_id
         FROM facts WHERE id = $1`, [id]))[0]!;
    const content = async () => String((await call('get_page', { slug: SLUG, include_content: true })).body.content);
    const put = async (text: string) => {
      const revision = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.revision;
      const res = await call('put_page', { slug: SLUG, content: text, expected_revision: revision });
      expect(res.isError).toBe(false);
    };

    test('an unrelated active edit and the extract_facts reconcile leave the retired row as the replacement wrote it', async () => {
      expect((await call('put_page', { slug: SLUG, content: PAGE })).isError).toBe(false);
      const [old] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_markdown_slug = $1 AND row_num = 1', [SLUG]);
      const replaced = await call('remember', { fact: 'Alice Example left acme-example.', provenance: 'test', entity: SLUG, replaces: String(old!.id) });
      expect(replaced.body.status).toBe('superseded');
      const history = await retired(Number(old!.id));
      expect(history).toMatchObject({ context: 'met at a call', superseded_by: Number(replaced.body.id) });
      const body = await content();
      expect(body).toContain('superseded by #');

      setSystemTime(new Date(Date.now() + 3 * 86_400_000));
      const edited = body.replace('| 2 | Alice Example likes tea. | preference | 1.0 | world | medium | 2026-10-01T00:00:00Z |',
        '| 2 | Alice Example likes tea. | preference | 1.0 | world | medium | 2026-10-02T00:00:00Z |');
      expect(edited).not.toBe(body);
      await put(edited);
      expect((await engine.executeRaw<{ v: string }>(`SELECT valid_from::date::text AS v FROM facts WHERE source_markdown_slug = $1 AND row_num = 2`, [SLUG]))[0]!.v).toBe('2026-10-02');
      expect(await retired(Number(old!.id))).toEqual(history);

      await runExtractFacts(engine, { slugs: [SLUG] });
      expect(await retired(Number(old!.id))).toEqual(history);
    }, 120_000);

    test('an explicit note in the retired row\'s context cell still updates it, keeping its retirement', async () => {
      const [old] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_markdown_slug = $1 AND superseded_by IS NOT NULL', [SLUG]);
      const before = await retired(Number(old!.id));
      const body = await content();
      const noted = body.replace(/\| superseded by #(\d+) \|/, '| superseded by #$1, she moved on |');
      expect(noted).not.toBe(body);
      await put(noted);
      const after = await retired(Number(old!.id));
      expect(after.context).toMatch(/^superseded by #\d+, she moved on$/);
      expect(after).toMatchObject({ expired_at: before.expired_at, valid_until: before.valid_until, superseded_by: before.superseded_by });
    }, 120_000);

    test('a remembered fact keeps its sub-second valid_from, retired or active, across an unrelated edit and the reconcile', async () => {
      const row = async (id: number) => (await engine.executeRaw<Record<string, unknown>>(
        `SELECT valid_from::text AS valid_from, expired_at::text AS expired_at, context, last_write_request_id FROM facts WHERE id = $1`, [id]))[0]!;
      setSystemTime(new Date('2026-11-20T10:00:00.123Z'));
      const first = await call('remember', { fact: 'Alice Example plays chess.', provenance: 'test', entity: SLUG });
      setSystemTime(new Date('2026-11-21T10:00:00.456Z'));
      const second = await call('remember', { fact: 'Alice Example plays go.', provenance: 'test', entity: SLUG, replaces: String(first.body.id) });
      expect(second.body.status).toBe('superseded');
      const retiredBefore = await row(Number(first.body.id));
      const activeBefore = await row(Number(second.body.id));
      expect(String(retiredBefore.valid_from)).toContain('.123');
      expect(String(activeBefore.valid_from)).toContain('.456');

      setSystemTime(new Date('2026-11-24T10:00:00.000Z'));
      const body = await content();
      const edited = body.replace('| Alice Example likes tea. | preference | 1.0 | world | medium | 2026-10-02T00:00:00Z |',
        '| Alice Example likes tea. | preference | 1.0 | world | medium | 2026-10-03T00:00:00Z |');
      expect(edited).not.toBe(body);
      await put(edited);
      expect(await row(Number(first.body.id))).toEqual(retiredBefore);
      expect(await row(Number(second.body.id))).toEqual(activeBefore);

      await runExtractFacts(engine, { slugs: [SLUG] });
      expect(await row(Number(first.body.id))).toEqual(retiredBefore);
      expect(await row(Number(second.body.id))).toEqual(activeBefore);
    }, 120_000);
  });
}
