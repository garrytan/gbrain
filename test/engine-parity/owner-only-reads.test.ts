/**
 * BrainEngine parity — owner-only sources under `excludePrivate` (src/core/access/owner-only.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a page read or fact read under `excludePrivate` is a non-owner read, so it drops what the owner-only
 *    conjunct of the page and fact policies (`ownerOnlyAllowedSql`, `ownerOnlyFactSql`) hides, before it limits, on
 *    every engine arm. Outside an engine scope the policy renders the fail-closed form: while the brain holds an
 *    owner-only source, every row is hidden. In an engine scope that recorded schema v320 or later it renders the
 *    lineage form: a page or fact in an owner-only source, and a concept or question with an input page there. The
 *    scoped case records the current schema version on every arm, as the CLI's connect gate (hasPendingMigrations) does
 *    on a current brain; the harness's reset brains do not keep the `version` config row.
 *  - Regression: the Rust page policy (`page_hidden`) and fact policy had no owner-only rule, so a Rust read served
 *    under `excludePrivate` showed other people's messages from an owner-only source to a non-owner caller.
 *  - Why existing coverage misses it: test/imessage-owner-only.test.ts runs the SQL engines only, and the parity
 *    privacy cases (private-page-reads, facts) create no owner-only source.
 *  - Seam: none. Real engines, typed methods only; the owner-only source is a harness fixture.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const OWN = 'own-texts';
const at = (iso: string) => new Date(iso);

/**
 * Pages in `default` and in the owner-only source `own-texts`, named so that by slug the owner-only page and the concept
 * synthesized from it sort first: a read that limits before it filters returns them.
 */
async function fixture(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
  await createSource(engine, backend, OWN, { owner_only: true });
  const put = (slug: string, type: string, sourceId = 'default', frontmatter: Record<string, unknown> = {}) =>
    engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `About ${slug}.`, timeline: '', frontmatter }, { sourceId });
  await put('a/thread', 'note', OWN);
  await put('a/thread', 'note');
  await put('b/from-texts', 'concept');
  await put('b/question-from-texts', 'question', 'default', { visibility: 'world' });
  await put('c/open', 'note');
  await put('d/plain-concept', 'concept');
  await engine.addLink('b/from-texts', 'a/thread', '', 'synthesized_from', 'concept-provenance', undefined, undefined, { toSourceId: OWN });
  await engine.addLink('b/question-from-texts', 'a/thread', '', 'synthesized_from', 'concept-provenance', undefined, undefined, { toSourceId: OWN });
  await engine.insertFact({ fact: 'From the texts', entity_slug: null, source: 'mcp:remember', valid_from: at('2026-01-02T00:00:00Z') }, { source_id: OWN });
  await engine.insertFact({ fact: 'From the notes', entity_slug: null, source: 'mcp:remember', valid_from: at('2026-01-02T00:00:00Z') }, { source_id: 'default' });
}

const ids = (rows: Array<{ source_id: string; slug: string }>) => rows.map((r) => `${r.source_id}:${r.slug}`);

async function reads(engine: BrainEngine) {
  const since = at('2020-01-01T00:00:00Z');
  const facts = async (sourceId: string, excludePrivate: boolean) =>
    sorted((await engine.listFactsSince(sourceId, since, { limit: 50, excludePrivate })).map((f) => f.fact));
  return {
    open: ids(await engine.listPages({ sort: 'slug', sourceIds: ['default', OWN] })),
    hidden: ids(await engine.listPages({ sort: 'slug', sourceIds: ['default', OWN], excludePrivate: true })),
    limited: ids(await engine.listPages({ sort: 'slug', sourceIds: ['default', OWN], excludePrivate: true, limit: 2 })),
    ownFacts: await facts(OWN, true),
    defaultFacts: await facts('default', true),
    ownFactsOpen: await facts(OWN, false),
  };
}

describe('engine parity: owner-only sources under excludePrivate', () => {
  parityTest(
    'outside an engine scope a non-owner page or fact read hides every row while the brain holds an owner-only source',
    { methods: ['putPage', 'addLink', 'insertFact', 'listPages', 'listFactsSince'] },
    async (engine, backend) => {
      await fixture(engine, backend);
      const got = await reads(engine);
      expect(got.open).toEqual([
        'default:a/thread', `${OWN}:a/thread`, 'default:b/from-texts', 'default:b/question-from-texts', 'default:c/open', 'default:d/plain-concept',
      ]);
      expect(got.hidden).toEqual([]);
      expect(got.limited).toEqual([]);
      expect(got.ownFacts).toEqual([]);
      expect(got.defaultFacts).toEqual([]);
      expect(got.ownFactsOpen).toEqual(['From the texts']);
      return got;
    },
  );

  parityTest(
    'a page or fact read with no owner-only source in the brain keeps every row the rest of the policy keeps',
    { methods: ['putPage', 'insertFact', 'listPages', 'listFactsSince'] },
    async (engine) => {
      await engine.putPage('c/open', { type: 'note', title: 'c/open', compiled_truth: 'About c/open.', timeline: '' });
      await engine.insertFact({ fact: 'From the notes', entity_slug: null, source: 'mcp:remember', valid_from: at('2026-01-02T00:00:00Z') }, { source_id: 'default' });
      const hidden = ids(await engine.listPages({ sort: 'slug', excludePrivate: true }));
      const kept = (await engine.listFactsSince('default', at('2020-01-01T00:00:00Z'), { limit: 50, excludePrivate: true })).map((f) => f.fact);
      expect(hidden).toEqual(['default:c/open']);
      expect(kept).toEqual(['From the notes']);
      return { hidden, kept };
    },
  );

  parityTest(
    'in an engine scope a non-owner read hides the owner-only source\'s rows and concepts or questions synthesized from them, before the limit',
    { methods: ['putPage', 'addLink', 'insertFact', 'listPages', 'listFactsSince'] },
    async (engine, backend) => {
      await fixture(engine, backend);
      noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
      const got = await withEngineScope(engine, () => reads(engine));
      expect(got.hidden).toEqual(['default:a/thread', 'default:c/open', 'default:d/plain-concept']);
      expect(got.limited).toEqual(['default:a/thread', 'default:c/open']);
      expect(got.ownFacts).toEqual([]);
      expect(got.defaultFacts).toEqual(['From the notes']);
      return got;
    },
  );
});
