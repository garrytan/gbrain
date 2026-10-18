/**
 * After a purge, no read operation returns the purged value: not from a
 * retained page version, and not from a row derived from the purged one.
 *
 * Protects: get_versions (bodies, newest first) after `purge_fact` on a page
 * with more retained versions than one redaction batch; the purge receipt's
 * page_versions store naming every retained version whose prose, title or
 * frontmatter still states the claim (text outside a fence is out of scope
 * for redaction, so it must be reported); recall (with and
 * without include_expired) after a page purge whose fact had a derived fact
 * on another page; takes_list (active: false), recall (include_expired),
 * get_page (include_deleted) and get_versions after `purge_fact` hides derived
 * rows (needs_rederive read eligibility).
 * Fails when: version redaction stops at a fixed row cap, a version carrying
 * the claim only in its title or frontmatter goes unreported, page purge does not
 * walk derivation_inputs, or a hidden derived row (a soft-deleted derived page
 * included) stays readable.
 * Seams: none; PGLite always, Postgres too when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { operations } from '../src/core/operations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { recordDerivationInputs } from '../src/core/facts/derivation-inputs.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const CLAIM = 'Vault combination is 8812';
const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-surfaces-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

const fence = `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${CLAIM} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
| 2 | Likes green tea | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->`;
const pageBody = (title: string) => `---\ntitle: ${title}\ntype: person\n---\n# ${title}\n\nProse about ${title}.\n\n## Facts\n\n${fence}\n`;
const ctx = (engine: BrainEngine): OperationContext => ({ engine, sourceId: 'default', remote: false, dryRun: false,
  config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} } } as OperationContext);
const op = (name: string) => operations.find(o => o.name === name)!;
const call = (engine: BrainEngine, name: string, params: Record<string, unknown>) => op(name).handler(ctx(engine), params) as Promise<any>;
const carries = (value: unknown) => JSON.stringify(value).toLowerCase().includes(CLAIM.toLowerCase());

async function seedPage(engine: BrainEngine, slug: string): Promise<{ factId: number; pageId: number }> {
  await importFromContent(engine, slug, pageBody(slug.split('/')[1]!), { noEmbed: true, sourceId: 'default' });
  await runExtractFacts(engine, { slugs: [slug] });
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact=$1 AND entity_slug=$2', [CLAIM, slug]);
  const [page] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE source_id='default' AND slug=$1`, [slug]);
  return { factId: Number(row.id), pageId: Number(page.id) };
}

async function purgeFact(engine: BrainEngine, id: number) {
  const dry = await call(engine, 'purge_fact', { id, dry_run: true });
  const done = await call(engine, 'purge_fact', { id, confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() });
  expect(done.state).toBe('committed');
  return done;
}

const coordinated = <T>(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<T>) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => fn(tx), TEST_WRITE_ATTRIBUTION));

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) await registerLocalWriter(engine, 'cli');
}), 120_000);
afterAll(async () => { await engines[0]?.disconnect(); await closePostgres?.(); rmSync(home, { recursive: true, force: true }); });

describe('purged values on read surfaces', () => {
  test('get_versions: no retained version past one redaction batch returns the purged fence row', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const seen: unknown[] = [];
    for (const engine of engines) {
      const slug = 'people/vault-versions-example';
      const { factId, pageId } = await seedPage(engine, slug);
      await engine.executeRaw(`INSERT INTO page_versions (page_id, compiled_truth, frontmatter, timeline)
        SELECT p.id, p.compiled_truth, p.frontmatter, p.timeline FROM pages p, generate_series(1, 5010) WHERE p.id=$1`, [pageId]);
      await purgeFact(engine, factId);
      const newest = await call(engine, 'get_versions', { slug, include_body: true, limit: 20 });
      const [left] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_versions WHERE page_id=$1 AND strpos(lower(compiled_truth), lower($2)) > 0`, [pageId, CLAIM]);
      seen.push({ engine: engine.kind, returned: newest.length, get_versions: carries(newest), versions_carrying: left.n });
    }
    expect(seen).toEqual(engines.map(engine => ({ engine: engine.kind, returned: 20, get_versions: false, versions_carrying: 0 })));
  }), 300_000);

  test('purge_fact: retained versions stating the claim in prose, title or frontmatter are reported', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const seen: unknown[] = [];
    for (const engine of engines) {
      const slug = 'people/vault-metadata-example';
      const { factId, pageId } = await seedPage(engine, slug);
      const ids = (await engine.executeRaw<{ id: number }>(`INSERT INTO page_versions (page_id, compiled_truth, frontmatter, timeline, title)
        VALUES ($1, $2, '{}'::jsonb, '', 'Plain'), ($1, 'Plain body.', '{}'::jsonb, '', $3), ($1, 'Plain body.', $4::jsonb, '', 'Plain') RETURNING id`,
        [pageId, `Old prose: ${CLAIM}.`, `Title: ${CLAIM}`, JSON.stringify({ note: CLAIM })])).map(r => Number(r.id));
      const done = await purgeFact(engine, factId);
      const versions = done.stores.find((s: { store: string }) => s.store === 'page_versions');
      const reported = new Set((versions?.items ?? []).map((i: { version_id: number }) => i.version_id));
      seen.push({ engine: engine.kind, status: versions?.status, reason: versions?.reason,
        prose: reported.has(ids[0]), title: reported.has(ids[1]), frontmatter: reported.has(ids[2]),
        still_readable: carries(await call(engine, 'get_versions', { slug, limit: 20 })) });
    }
    expect(seen).toEqual(engines.map(engine => ({ engine: engine.kind, status: 'out_of_scope', reason: 'source_prose',
      prose: true, title: true, frontmatter: true, still_readable: true })));
  }), 300_000);

  test('purge_fact: hidden derived take, fact and page stay unreadable', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const seen: unknown[] = [];
    for (const engine of engines) {
      const slug = 'people/vault-derived-example';
      const { factId, pageId } = await seedPage(engine, slug);
      const derivedSlug = 'notes/vault-synthesis-example';
      for (const line of [`Synthesis: ${CLAIM}.`, `Synthesis, revised: ${CLAIM}.`])
        await importFromContent(engine, derivedSlug, `---\ntitle: Vault synthesis\ntype: note\n---\n${line}\n`, { noEmbed: true, sourceId: 'default' });
      const [derivedPage] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE source_id='default' AND slug=$1`, [derivedSlug]);
      expect(carries(await call(engine, 'get_versions', { slug: derivedSlug, include_body: true }))).toBe(true);
      await coordinated(engine, async tx => {
        const [take] = await tx.executeRaw<{ id: number }>(`INSERT INTO takes(page_id,row_num,claim,kind,holder) VALUES ($1,90,$2,'take','brain') RETURNING id`, [pageId, `Synthesized: ${CLAIM}`]);
        const [fact] = await tx.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,entity_slug,visibility,source) VALUES ('default',$1,$2,'world','consolidate') RETURNING id`, [`Derived: ${CLAIM}`, slug]);
        for (const row of [{ table: 'takes', id: take.id }, { table: 'facts', id: fact.id }, { table: 'pages', id: derivedPage.id }])
          await recordDerivationInputs(tx, { ...row, sourceId: 'default' }, [{ table: 'facts', id: factId }]);
      });
      await purgeFact(engine, factId);
      const surfaces = {
        engine: engine.kind,
        takes_list: carries(await call(engine, 'takes_list', { page_slug: slug, active: false })),
        recall: carries(await call(engine, 'recall', { entity: slug, include_expired: true })),
        get_page: carries(await call(engine, 'get_page', { slug: derivedSlug, include_deleted: true }).catch(() => null)),
        get_versions: carries(await call(engine, 'get_versions', { slug: derivedSlug, include_body: true })),
      };
      seen.push(surfaces);
    }
    expect(seen).toEqual(engines.map(engine => ({ engine: engine.kind, takes_list: false, recall: false, get_page: false, get_versions: false })));
  }), 300_000);

  test('page purge: a fact derived from the purged page on another page leaves no purged text', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const seen: unknown[] = [];
    for (const engine of engines) {
      const slug = 'people/vault-page-purge-example';
      const { factId } = await seedPage(engine, slug);
      const other = 'people/vault-other-example';
      await importFromContent(engine, other, `---\ntitle: Other\ntype: person\n---\nOther page.\n`, { noEmbed: true, sourceId: 'default' });
      await coordinated(engine, async tx => {
        const [fact] = await tx.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,entity_slug,visibility,source) VALUES ('default',$1,$2,'world','consolidate') RETURNING id`, [`Derived: ${CLAIM}`, other]);
        await recordDerivationInputs(tx, { table: 'facts', id: fact.id, sourceId: 'default' }, [{ table: 'facts', id: factId }]);
      });
      const [page] = await engine.executeRaw<{ revision: string }>(`SELECT knowledge_revision::text AS revision FROM pages WHERE source_id='default' AND slug=$1`, [slug]);
      const done = await call(engine, 'delete_page', { slug, purge: true, expected_revision: page.revision, request_id: randomUUID() });
      expect(done.state).toBe('committed');
      seen.push({ engine: engine.kind, recall: carries(await call(engine, 'recall', { entity: other })),
        recall_expired: carries(await call(engine, 'recall', { entity: other, include_expired: true })) });
    }
    expect(seen).toEqual(engines.map(engine => ({ engine: engine.kind, recall: false, recall_expired: false })));
  }), 300_000);
});
