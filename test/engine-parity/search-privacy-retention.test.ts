/**
 * BrainEngine parity: a concept derived from an owner-only page stays hidden after its input goes (GST-3032, migration v322).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: searchKeyword with `excludePrivate` hides a world-labelled concept whose concept-provenance input page lives in an
 *    owner-only source, and keeps it hidden after that input page is hard-deleted (deletePage) and after the source stops being
 *    owner-only: PGLite records the concept in `owner_only_marks` before the page goes. Removing only the provenance link records
 *    nothing on PGLite (no trigger watches `links`), and turning the source's flag off with no deletion releases the concept; the
 *    Rust arm must answer each of these the same.
 *  - Regression: the Rust store read the lineage from the live provenance link alone, so deleting the input page dropped the link and
 *    searchKeyword(excludePrivate) returned the concept it had hidden.
 *  - Why existing coverage misses it: search-privacy.test.ts reads a brain nothing was deleted from.
 *  - Seam: none (typed methods only).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { createSource, parityArms, sorted, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const { parityTest, arms } = parityArms(testBackends());

const Q = 'quillwort';

/** The page of an owner-only source, a concept synthesized from it, and the same pair over an open page. */
async function seedBrain(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, 'vault', { owner_only: true });
  const page = (title: string, extra: Partial<PageInput> = {}): PageInput =>
    ({ type: 'note', title, compiled_truth: `${Q} ledger of ${title}`, timeline: '', ...extra }) as PageInput;
  const concept = (title: string): PageInput =>
    page(title, { type: 'concept', frontmatter: { synthesized_by: 'dream', visibility: 'world' } });
  const seed = (slug: string, input: PageInput, sourceId: string) =>
    seedPage(engine, { slug, input, chunks: [chunk(0, `${Q} ledger of ${slug}`)] }, { sourceId });
  await seed('notes/vault', page('Quillwort Vault'), 'vault');
  await seed('notes/open', page('Quillwort Open'), 'default');
  await seed('concepts/from-vault', concept('Quillwort Concept Vault'), 'default');
  await seed('concepts/from-open', concept('Quillwort Concept Open'), 'default');
  await engine.addLink('concepts/from-vault', 'notes/vault', '', 'synthesized_from', 'concept-provenance', undefined, undefined, { fromSourceId: 'default', toSourceId: 'vault' });
  await engine.addLink('concepts/from-open', 'notes/open', '', 'synthesized_from', 'concept-provenance', undefined, undefined, { fromSourceId: 'default', toSourceId: 'default' });
}

/** The read as a served brain makes it (the schema version the connect gate records), as search-privacy.test.ts does. */
async function served(backend: string, engine: BrainEngine): Promise<string[]> {
  const own = arms().find((arm) => arm.backend === backend)!.engine;
  noteSchemaVersion(own, LATEST_SCHEMA_VERSION);
  return withEngineScope(own, async () => {
    const rows = await engine.searchKeyword(Q, { limit: 50, excludePrivate: true });
    return sorted([...new Set(rows.map((r) => `${r.source_id}:${r.slug}`))]);
  });
}

const OPEN_ONLY = ['default:concepts/from-open', 'default:notes/open'];
const WITH_VAULT_CONCEPT = [...OPEN_ONLY, 'default:concepts/from-vault'].sort();

describe('a concept derived from an owner-only page after the page, the link or the flag changes', () => {
  parityTest(
    'searchKeyword: the concept stays hidden after deletePage removes its owner-only input page',
    { methods: ['searchKeyword', 'deletePage'] },
    async (engine, backend) => {
      await seedBrain(engine, backend);
      const before = await served(backend, engine);
      expect(before).toEqual(OPEN_ONLY);
      await engine.deletePage('notes/vault', { sourceId: 'vault' });
      const after = await served(backend, engine);
      expect(after).toEqual(OPEN_ONLY);
      return { before, after };
    },
  );

  parityTest(
    'searchKeyword: the concept stays hidden after deletePage when the source is also no longer owner-only',
    { methods: ['searchKeyword', 'deletePage', 'updateSourceConfig'] },
    async (engine, backend) => {
      await seedBrain(engine, backend);
      await engine.deletePage('notes/vault', { sourceId: 'vault' });
      await engine.updateSourceConfig('vault', { owner_only: false });
      const after = await served(backend, engine);
      expect(after).toEqual(OPEN_ONLY);
      return after;
    },
  );

  parityTest(
    'searchKeyword: deleting an open input page leaves its concept as visible as before',
    { methods: ['searchKeyword', 'deletePage'] },
    async (engine, backend) => {
      await seedBrain(engine, backend);
      await engine.deletePage('notes/open', { sourceId: 'default' });
      const after = await served(backend, engine);
      expect(after).toEqual(['default:concepts/from-open']);
      return after;
    },
  );

  parityTest(
    'searchKeyword: removing only the provenance link releases the concept (nothing was marked), on PGLite and on the Rust arm',
    { methods: ['searchKeyword', 'removeLink'] },
    async (engine, backend) => {
      await seedBrain(engine, backend);
      await engine.removeLink('concepts/from-vault', 'notes/vault', 'synthesized_from', 'concept-provenance', { fromSourceId: 'default', toSourceId: 'vault' });
      const afterLink = await served(backend, engine);
      expect(afterLink).toEqual(WITH_VAULT_CONCEPT);
      return afterLink;
    },
  );

  parityTest(
    'searchKeyword: turning the owner-only flag off releases a concept whose input page is still there',
    { methods: ['searchKeyword', 'updateSourceConfig'] },
    async (engine, backend) => {
      await seedBrain(engine, backend);
      await engine.updateSourceConfig('vault', { owner_only: false });
      const afterFlag = await served(backend, engine);
      expect(afterFlag).toEqual([...WITH_VAULT_CONCEPT, 'vault:notes/vault']);
      return afterFlag;
    },
  );
});
