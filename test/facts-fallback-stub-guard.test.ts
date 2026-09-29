/**
 * #4108 — fallback-resolved entity refs must not materialize canonical stub
 * pages.
 *
 * End-to-end zero-LLM matrix through writeSingleFact (the pipeline's
 * post-extraction stages: resolve → dedup → fence-first write) against a real
 * PGLiteEngine with sources.local_path set, so the fence path is reachable:
 *
 *   1. nonexistent PREFIXED entity  → fallback_slugify → DB-only, no stub page
 *   2. nonexistent BARE entity      → fallback_slugify → DB-only, no root stub
 *   3. existing page, exact slug    → exact_page       → fence written
 *   4. existing page, fuzzy title   → fuzzy_match      → fence written
 *   5. existing page, curated alias → alias_exact      → fence written
 *
 * Cases 1-2 pin the issue's expected behavior: the fact is RETAINED
 * (entity_slug intact, legacy DB insert) but never mints a canonical page for
 * a slug the resolver invented. Cases 3-5 pin that every provenance that
 * verified a live page still fences.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { CROSS_SOURCE_PROVENANCE_PREFIX, writeSingleFact } from '../src/core/facts/write-single.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';
import { readRecentStubGuardEvents } from '../src/core/facts/stub-guard-audit.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Live pages for the resolvable arms of the matrix (no on-disk files —
  // the fence write stub-creates them, exercising DB→file drift repair).
  await engine.putPage('companies/acme-example', {
    type: 'company',
    title: 'Acme Example',
    compiled_truth: '# Acme Example',
    frontmatter: {},
  }, { sourceId: 'default' });
  await engine.putPage('people/felicia-example', {
    type: 'person',
    title: 'Felicia Example',
    compiled_truth: '# Felicia Example',
    frontmatter: {},
  }, { sourceId: 'default' });
  await engine.putPage('people/star-example', {
    type: 'person',
    title: 'Star Example',
    compiled_truth: '# Star Example',
    frontmatter: {},
  }, { sourceId: 'default' });
  await engine.setPageAliases('people/star-example', 'default', ['starshine']);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // Fresh tree per test so file-existence assertions are hermetic.
  brainDir = mkdtempSync(join(tmpdir(), 'facts-fallback-stub-guard-'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(
    `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
    [brainDir],
  );
});

afterAll(() => {
  try {
    if (brainDir) rmSync(brainDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

async function factRow(id: number): Promise<{ entity_slug: string | null; source_markdown_slug: string | null }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await (engine as any).db.query(
    'SELECT entity_slug, source_markdown_slug FROM facts WHERE id = $1',
    [id],
  );
  return rows.rows[0];
}

describe('writeSingleFact × resolution provenance (#4108 matrix)', () => {
  test('1. nonexistent prefixed entity: fact retained DB-only, no canonical stub page', async () => {
    const r = await writeSingleFact(engine, 'default', {
      fact: 'Ships invisible widgets',
      provenance: 'test:matrix',
      entity: 'companies/zeta-widgets-nonexistent',
    });

    expect(r.status).toBe('inserted');
    expect(r.entity_slug).toBe('companies/zeta-widgets-nonexistent');

    // The pre-#4108 bug: this exact write minted
    // companies/zeta-widgets-nonexistent.md as a canonical stub page that a
    // later sync imported, turning the invented slug into an exact_page hit.
    expect(existsSync(join(brainDir, 'companies/zeta-widgets-nonexistent.md'))).toBe(false);

    const row = await factRow(r.id);
    expect(row.entity_slug).toBe('companies/zeta-widgets-nonexistent');
    // DB-only insert — no fence file backs the row.
    expect(row.source_markdown_slug).toBeNull();
  });

  test('2. nonexistent bare entity: fact retained DB-only, no root stub', async () => {
    const r = await writeSingleFact(engine, 'default', {
      fact: 'Mentioned once in passing',
      provenance: 'test:matrix',
      entity: 'zetaperson',
    });

    expect(r.status).toBe('inserted');
    expect(r.entity_slug).toBe('zetaperson');
    expect(existsSync(join(brainDir, 'zetaperson.md'))).toBe(false);

    const row = await factRow(r.id);
    expect(row.source_markdown_slug).toBeNull();
  });

  test('3. exact existing page: fence written', async () => {
    const r = await writeSingleFact(engine, 'default', {
      fact: 'Raised a seed round in 2017',
      provenance: 'test:matrix',
      entity: 'companies/acme-example',
    });

    expect(r.status).toBe('inserted');
    expect(r.entity_slug).toBe('companies/acme-example');

    const filePath = join(brainDir, 'companies/acme-example.md');
    expect(existsSync(filePath)).toBe(true);
    const body = readFileSync(filePath, 'utf-8');
    expect(body).toContain('## Facts');
    expect(body).toContain('Raised a seed round in 2017');

    const row = await factRow(r.id);
    expect(row.source_markdown_slug).toBe('companies/acme-example');
  });

  test('4. fuzzy-resolvable display name: fence written onto the existing page', async () => {
    const r = await writeSingleFact(engine, 'default', {
      fact: 'Joined the platform team',
      provenance: 'test:matrix',
      entity: 'Felicia Example',
    });

    expect(r.status).toBe('inserted');
    expect(r.entity_slug).toBe('people/felicia-example');

    const filePath = join(brainDir, 'people/felicia-example.md');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toContain('Joined the platform team');

    const row = await factRow(r.id);
    expect(row.source_markdown_slug).toBe('people/felicia-example');
  });

  test('5. curated alias: alias_exact provenance fences (not blocked by the fallback guard)', async () => {
    const r = await writeSingleFact(engine, 'default', {
      fact: 'Prefers the starshine handle',
      provenance: 'test:matrix',
      entity: 'starshine',
    });

    expect(r.status).toBe('inserted');
    expect(r.entity_slug).toBe('people/star-example');

    const filePath = join(brainDir, 'people/star-example.md');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toContain('Prefers the starshine handle');

    const row = await factRow(r.id);
    expect(row.source_markdown_slug).toBe('people/star-example');
  });
});

/**
 * #5504: connector writes (`crossSourceResolution`) whose entity page lives in
 * another federated source. The connector source `g-conn` (federated: true,
 * the writer rule) has its own local_path; `default` (federated: true) holds
 * the person pages above.
 */
describe('writeSingleFact × cross-source resolution (#5504)', () => {
  let connDir: string;
  let auditDir: string;

  beforeAll(async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('g-conn', 'g-conn', '{"federated": true}'::jsonb) ON CONFLICT (id) DO NOTHING`,
    );
    await engine.putPage('people/gina-example', {
      type: 'person',
      title: 'Gina Example',
      compiled_truth: '# Gina Example',
      frontmatter: {},
    }, { sourceId: 'g-conn' });
  });

  beforeEach(async () => {
    connDir = mkdtempSync(join(tmpdir(), 'facts-cross-source-conn-'));
    auditDir = mkdtempSync(join(tmpdir(), 'facts-cross-source-audit-'));
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'g-conn'`, [connDir]);
  });

  afterEach(async () => {
    await engine.executeRaw(`DELETE FROM fact_withdrawals WHERE source_id = 'g-conn'`);
    await engine.executeRaw(`DELETE FROM sources WHERE id = 'c-fed'`);
    await engine.executeRaw(`DELETE FROM pages WHERE source_id = 'g-conn' AND slug = 'people/felicia-example'`);
    rmSync(connDir, { recursive: true, force: true });
    rmSync(auditDir, { recursive: true, force: true });
  });

  async function connectorWrite(entity: string) {
    return withEnv({ GBRAIN_AUDIT_DIR: auditDir }, () =>
      writeSingleFact(engine, 'g-conn', {
        fact: 'Promised the widget-co deck',
        provenance: 'test:cross-source',
        kind: 'commitment',
        entity,
        crossSourceResolution: true,
      }),
    );
  }

  async function auditEvents() {
    return withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => readRecentStubGuardEvents({ sinceMs: 60_000 }));
  }

  async function crossSourceRows() {
    return engine.executeRaw<{ id: number | string; source: string; row_num: number | null; expired_at: Date | null; source_markdown_slug: string | null }>(
      `SELECT id, source, row_num, expired_at, source_markdown_slug FROM facts
        WHERE source_id = 'g-conn' AND fact = 'Promised the widget-co deck' ORDER BY id`,
    );
  }

  async function factSource(id: number): Promise<string> {
    const rows = await engine.executeRaw<{ source_id: string }>('SELECT source_id FROM facts WHERE id = $1', [id]);
    return rows[0].source_id;
  }

  test('entity page in another federated source: DB-only in the connector source, no page file, no audit row', async () => {
    const r = await connectorWrite('Felicia Example');

    expect(r.status).toBe('inserted');
    expect(r.entity_slug).toBe('people/felicia-example');
    expect(await factSource(r.id)).toBe('g-conn');
    const row = await factRow(r.id);
    expect(row.entity_slug).toBe('people/felicia-example');
    expect(row.source_markdown_slug).toBeNull();

    expect(existsSync(join(connDir, 'people/felicia-example.md'))).toBe(false);
    expect(existsSync(join(brainDir, 'people/felicia-example.md'))).toBe(false);
    expect(await auditEvents()).toHaveLength(0);
    expect((await crossSourceRows())[0]?.source).toBe(`${CROSS_SOURCE_PROVENANCE_PREFIX}test:cross-source`);
  });

  test('matches in two other federated sources: today\'s fallback slug, refused and audited by the stub guard', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('c-fed', 'c-fed', '{"federated": true}'::jsonb)`,
    );
    await engine.putPage('people/felicia-example', {
      type: 'person',
      title: 'Felicia Example',
      compiled_truth: '# Felicia Example',
      frontmatter: {},
    }, { sourceId: 'c-fed' });

    const r = await connectorWrite('Felicia Example');

    expect(r.entity_slug).toBe('felicia-example');
    expect((await factRow(r.id)).source_markdown_slug).toBeNull();
    expect(existsSync(join(connDir, 'felicia-example.md'))).toBe(false);
    const events = await auditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ slug: 'felicia-example', source_id: 'g-conn', reason: 'unprefixed' });
  });

  // Withdrawals are subject-scoped on the resolved slug. For a cross-source
  // row that slug names a page in another source, so forget and the
  // re-extract check must both key on it, or the forgotten commitment
  // comes back on the next extraction.
  test('forget withdraws the cross-source fact for its subject only: off the card, re-extract refused, another subject still inserts', async () => {
    const commitmentsOnCard = async () => {
      const res = await buildEntityCard(engine, 'default', 'people/felicia-example', { remote: false });
      expect(res.found).toBe(true);
      return res.card!.open_threads.map((t) => t.text).filter((t) => t === 'Promised the widget-co deck');
    };
    const written = await connectorWrite('Felicia Example');
    expect(await commitmentsOnCard()).toEqual(['Promised the widget-co deck']);

    const forgotten = await forgetFactInFence(engine, written.id, { sourceId: 'g-conn' });

    expect(forgotten).toMatchObject({ ok: true, path: 'legacy_db' });
    expect(await engine.executeRaw(`SELECT source_id, subject FROM fact_withdrawals`))
      .toEqual([{ source_id: 'g-conn', subject: 'people/felicia-example' }]);
    expect(await commitmentsOnCard()).toEqual([]);
    await expect(connectorWrite('Felicia Example')).rejects.toThrow('fact_withdrawn');
    const other = await connectorWrite('Acme Example');
    expect(other).toMatchObject({ status: 'inserted', entity_slug: 'companies/acme-example' });
  });

  test('entity page in the connector source itself: fence written as today', async () => {
    const r = await connectorWrite('Gina Example');

    expect(r.entity_slug).toBe('people/gina-example');
    const filePath = join(connDir, 'people/gina-example.md');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toContain('Promised the widget-co deck');
    expect((await factRow(r.id)).source_markdown_slug).toBe('people/gina-example');
    expect(await auditEvents()).toHaveLength(0);
  });

  // The connector source later gains a page with the same slug (a contact
  // page). The DB-only cross-source row must neither halt extract_facts for
  // that source nor be lost or duplicated by its reconcile pass, while a
  // genuine legacy row on the same page still trips the guard.
  const connectorFence = `# Felicia Example

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Met at the widget-co offsite | fact | 1.0 | private | medium | 2026-01-01 |  | contact |  |
<!--- gbrain:facts:end -->
`;

  for (const { name, legacy } of [
    { name: 'the cross-source row alone does not trip the extract_facts guard, and survives the run', legacy: false },
    { name: 'a genuine legacy row beside it still trips the guard, and counts alone', legacy: true },
  ]) test(name, async () => {
    const written = await connectorWrite('Felicia Example');
    await engine.putPage('people/felicia-example', {
      type: 'person',
      title: 'Felicia Example',
      compiled_truth: connectorFence,
      frontmatter: {},
    }, { sourceId: 'g-conn' });
    if (legacy) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
         VALUES ('g-conn', 'people/felicia-example', 'genuine legacy claim', 'fact', 'private', 'medium', now(), 'mcp:put_page', 1.0)`,
      );
    }

    const r = await runExtractFacts(engine, { sourceId: 'g-conn', slugs: ['people/felicia-example'] });

    expect(r.guardTriggered).toBe(legacy);
    expect(r.legacyRowsPending).toBe(legacy ? 1 : 0);
    expect(r.factsInserted).toBe(legacy ? 0 : 1);
    expect((await crossSourceRows()).map((row) => ({ ...row, id: Number(row.id) }))).toEqual([{
      id: written.id,
      source: `${CROSS_SOURCE_PROVENANCE_PREFIX}test:cross-source`,
      row_num: null,
      expired_at: null,
      source_markdown_slug: null,
    }]);
  });
});
