/**
 * #4772 — getHealth's entity counters read the active schema pack's
 * `primitive: entity` types (unioned with the legacy literals) instead of a
 * hardcoded `type IN ('entity','person','company')`.
 *
 * Pre-fix: a brain whose entity pages carry a pack-declared type the literal
 * did not name (gbrain-base's `yc`, or a custom pack's own types) reported
 * entity_page_count=0, link_coverage=null and most_connected=[] — the
 * dashboard read "no entities" over a brain full of them.
 *
 * Runs against PGLite; the parameterized SQL shape is identical in both
 * engines (parity case in test/e2e/health-parity-postgres.test.ts).
 * GBRAIN_SCHEMA_PACK (tier 2) pins the pack so the assertion is not
 * host-config dependent.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIN_ENTITY_PAGES_FOR_COVERAGE } from '../src/core/types.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  for (const t of ['links', 'content_chunks', 'timeline_entries', 'tags', 'page_versions', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
});

async function seed(slug: string, type: string): Promise<void> {
  await engine.putPage(slug, { type, title: slug, compiled_truth: `about ${slug}`, frontmatter: {} });
}

async function link(fromSlug: string, toSlug: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO links (from_page_id, to_page_id, link_type)
     SELECT f.id, t.id, 'mentions' FROM pages f, pages t WHERE f.slug = $1 AND t.slug = $2`,
    [fromSlug, toSlug],
  );
}

describe('#4772 — getHealth entity counters follow the active pack', () => {
  test('gbrain-base: pack-declared entity types (yc) count; temporal types (deal) do not', async () => {
    const n = MIN_ENTITY_PAGES_FOR_COVERAGE + 1;
    await seed('hub', 'note');
    for (let i = 0; i < n; i++) await seed(`yc/batch-${i}`, 'yc');
    for (let i = 0; i < n / 2; i++) await link('hub', `yc/batch-${i}`);
    await seed('deals/acme-seed', 'deal');

    const health = await withEnv({ GBRAIN_SCHEMA_PACK: 'gbrain-base' }, () => engine.getHealth());

    // Pre-fix: 0 (the literal named only entity/person/company).
    expect(health.entity_page_count).toBe(n);
    expect(health.link_coverage).toBe(0.5);
    expect(health.most_connected.map(r => r.slug)).toContain('yc/batch-0');
    expect(health.most_connected.map(r => r.slug)).not.toContain('deals/acme-seed');
  });

  test('legacy union: organization pages still count under a pack that does not declare them', async () => {
    const n = MIN_ENTITY_PAGES_FOR_COVERAGE;
    for (let i = 0; i < n; i++) await seed(`orgs/org-${i}`, 'organization');

    // gbrain-base-v2 declares only person + company as entity primitives.
    const health = await withEnv({ GBRAIN_SCHEMA_PACK: 'gbrain-base-v2' }, () => engine.getHealth());
    // Pre-fix: 0 — the engine literal never named 'organization' (doctor's did).
    expect(health.entity_page_count).toBe(n);
  });
});
