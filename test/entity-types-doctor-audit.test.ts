/**
 * #4772 — doctor's graph_coverage + orphan_ratio counters read the active
 * schema pack (audit follow-up for the doctor surface).
 *
 * Both checks are wrapped in try/catch that degrades a thrown query to a
 * bland 'Could not check …' warn, so a broken positional bind (orphan_ratio
 * moved source_id from $1 to $2 behind the new $1::text[] types array) would
 * never fail loudly. These tests drive the REAL buildChecks against PGLite:
 *
 *   - orphan_ratio with an explicit --source pins the `[entityTypes, srcId]`
 *     / `$2` shape: the low-scale caveat names the per-source entity count,
 *     which is only right when BOTH params bind to the right slot AND the
 *     pack-declared type counts.
 *   - graph_coverage under gbrain-base counts a pack-declared entity type
 *     (yc) that the pre-fix literal never named; under gbrain-base-v2 (no
 *     yc) the same brain takes the "No entity pages" short-circuit.
 *
 * GBRAIN_SCHEMA_PACK (tier 2) pins the pack so nothing is host-config dependent.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { setCliOptions } from '../src/core/cli-options.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null, brain: null });
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seed(slug: string, type: string, sourceId = 'default'): Promise<void> {
  await engine.putPage(slug, { type, title: slug, compiled_truth: `about ${slug}`, frontmatter: {} }, { sourceId });
}

async function link(fromSlug: string, toSlug: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO links (from_page_id, to_page_id, link_type)
     SELECT f.id, t.id, 'mentions' FROM pages f, pages t WHERE f.slug = $1 AND t.slug = $2`,
    [fromSlug, toSlug],
  );
}

describe('#4772 — doctor counters follow the active pack (PGLite, real buildChecks)', () => {
  test('orphan_ratio --source binds [entityTypes, srcId] ($2 shift) and counts a pack type', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('dept-x', 'Dept X', '{}'::jsonb) ON CONFLICT DO NOTHING`,
    );
    // Default source: 3 persons that must NOT leak into the dept-x count.
    for (let i = 0; i < 3; i++) await seed(`people/default-${i}`, 'person');
    // dept-x: 4 persons + 1 pack-declared `yc` (gbrain-base) = 5 entities.
    for (let i = 0; i < 4; i++) await seed(`people/dx-${i}`, 'person', 'dept-x');
    await seed('yc/dx-batch', 'yc', 'dept-x');
    await seed('hub', 'note', 'dept-x');
    await link('hub', 'people/dx-0');

    const checks = await withEnv({ GBRAIN_SCHEMA_PACK: 'gbrain-base' }, () =>
      buildChecks(engine, ['--source', 'dept-x', '--scope=brain'], null));
    const check = checks.find(c => c.name === 'orphan_ratio');
    expect(check, 'orphan_ratio check must be present').toBeDefined();
    // A mis-bound $1/$2 throws inside the try → this bland warn. Fail loudly.
    expect(check!.message).not.toContain('Could not check orphan ratio');
    expect(check!.message).toContain("in source 'dept-x'");
    // 4 person + 1 yc in dept-x; the 3 default-source persons excluded.
    // Pre-fix: 4 (literal never named yc). Wrong slot: throw → caveat absent.
    expect(check!.message).toContain('(5 entity pages <100)');
  });

  test('graph_coverage counts a pack-declared entity type; same brain is "No entity pages" without it', async () => {
    await seed('yc/batch-0', 'yc');
    await seed('yc/batch-1', 'yc');
    await seed('notes/plain', 'note');

    // Sequential on purpose: withEnv is not concurrent-safe on one key.
    const graphUnder = async (pack: string) =>
      (await withEnv({ GBRAIN_SCHEMA_PACK: pack }, () => buildChecks(engine, ['--scope=brain'], null)))
        .find(c => c.name === 'graph_coverage');
    const withYc = await graphUnder('gbrain-base');
    // gbrain-base-v2 declares only person + company as entity primitives.
    const withoutYc = await graphUnder('gbrain-base-v2');

    expect(withYc?.message).not.toContain('Could not check graph coverage');
    // Both graph_coverage queries (entityCount + eligibleStats) bind the pack
    // set: 2 unlinked yc pages → a real (0%) coverage report over 2 entities.
    expect(withYc?.status).toBe('warn');
    expect(withYc?.message).toContain('(2 entity pages)');

    expect(withoutYc?.status).toBe('ok');
    expect(withoutYc?.message).toContain('No entity pages');
  });
});
