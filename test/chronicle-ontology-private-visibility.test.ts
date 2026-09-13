/**
 * Ontology reads under the page-visibility gate (#4352 class).
 *
 * The chronicle timeline reads already hide `visibility: private` pages from
 * untrusted callers (readPolicyOpts). The ontology reads (ontology_get /
 * ontology_conflicts / volunteer_chronicle's ontologies) join the same pages
 * through the fact's provenance slug (`facts.source_markdown_slug`) but only
 * redacted the diary prefix, so a remote caller who could not read a private
 * page still received every value extracted from it plus that page's slug as
 * `source`. These tests pin:
 *
 *  1. Pre-resolution: a private provenance page drops out BEFORE the
 *     per-dimension DISTINCT ON, so the untrusted caller resolves the newest
 *     value they may see (the older world-sourced one), never a private value
 *     and never a hole where one was. A trusted local caller still sees all.
 *  2. Conflicts: a disagreement that only exists because of a hidden
 *     provenance is not reported remotely.
 *  3. The operator opt-out (`search.remote_private_pages=visible`) restores
 *     the pre-gate behavior, same as the sibling reads.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import {
  REMOTE_PRIVATE_PAGES_KEY,
  __resetPrivateVisibilityCacheForTests,
} from '../src/core/search/private-visibility.ts';

let engine: PGLiteEngine;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    dryRun: false,
    remote: true,
    transport: 'stdio',
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
}
const local = () => ctxOf({ remote: false });
const remote = () => ctxOf({ remote: true });
// remote UNDEFINED is the fail-closed `ctx.remote !== false` shape.
const remoteUndef = () => ctxOf({ remote: undefined as unknown as boolean });

// Every token below lives ONLY on the private page or on rows derived from it.
const PRIVATE_TOKENS = ['meetings/secret-sync', 'secretvalue'];
function privateToken(payload: unknown): string | null {
  const text = JSON.stringify(payload) ?? '';
  for (const t of PRIVATE_TOKENS) if (text.includes(t)) return t;
  return null;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  __resetPrivateVisibilityCacheForTests();

  // Provenance pages: one world, one private.
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, frontmatter)
     VALUES ('default', 'meetings/open-sync', 'meeting', 'open sync', '{}'::jsonb),
            ('default', 'meetings/secret-sync', 'meeting', 'secret sync', '{"visibility":"private"}'::jsonb)`,
  );

  // A newer private-sourced value and an older world-sourced value that stay
  // open side by side (the backdated-conflict shape: the second write is
  // older, so it is inserted without closing the first). Resolution picks the
  // newer valid_from, so local resolves the private value; an untrusted caller
  // must resolve the older world value, not a hole. The same pair is a
  // two-provenance conflict that only exists with the private side present.
  await engine.mergeOntologyFact({
    entitySlug: 'people/open-person', dimension: 'role', value: 'secretvalue',
    source: 'meetings/secret-sync', validFrom: '2026-05-01',
  });
  await engine.mergeOntologyFact({
    entitySlug: 'people/open-person', dimension: 'role', value: 'openvalue',
    source: 'meetings/open-sync', validFrom: '2026-01-01',
  });
  await engine.mergeOntologyFact({
    entitySlug: 'people/conf-person', dimension: 'role', value: 'secretvalue',
    source: 'meetings/secret-sync', validFrom: '2026-05-01',
  });
  await engine.mergeOntologyFact({
    entitySlug: 'people/conf-person', dimension: 'role', value: 'yes',
    source: 'meetings/open-sync', validFrom: '2026-01-01',
  });
}, 60_000);

type Val = { dimension: string; value: string; source: string };
type Conflict = { entity_slug: string; values: { value: string; source: string }[] };

describe('ontology provenance rows follow the page-visibility policy', () => {
  test('ontology_get: a private provenance page drops before resolution, so remote resolves the older world value', async () => {
    const seen = await operationsByName.ontology_get.handler(local(), { entity: 'people/open-person' }) as Val[];
    expect(seen.find((v) => v.dimension === 'role')?.value).toBe('secretvalue'); // anti-vacuity

    for (const c of [remote(), remoteUndef()]) {
      const rows = await operationsByName.ontology_get.handler(c, { entity: 'people/open-person' }) as Val[];
      expect(privateToken(rows)).toBeNull();
      expect(rows.find((v) => v.dimension === 'role')?.value).toBe('openvalue');
    }
  });

  test('ontology_conflicts: a disagreement that needs a private provenance is not reported remotely', async () => {
    const seen = await operationsByName.ontology_conflicts.handler(local(), {}) as Conflict[];
    expect(seen.some((c) => c.entity_slug === 'people/conf-person')).toBe(true);
    for (const c of [remote(), remoteUndef()]) {
      const rows = await operationsByName.ontology_conflicts.handler(c, {}) as Conflict[];
      expect(rows.some((r) => r.entity_slug === 'people/conf-person')).toBe(false);
      expect(privateToken(rows)).toBeNull();
    }
  });

  test('volunteer_chronicle: ontologies carry no private value or provenance slug', async () => {
    type Vol = { ontologies: Record<string, { value: string }[]> };
    const args = { days: 3650, limit: 50, entities: 'people/open-person' };
    const seen = await operationsByName.volunteer_chronicle.handler(local(), args) as Vol;
    expect(seen.ontologies['people/open-person'].map((v) => v.value)).toContain('secretvalue');

    for (const c of [remote(), remoteUndef()]) {
      const vol = await operationsByName.volunteer_chronicle.handler(c, args) as Vol;
      expect(privateToken(vol)).toBeNull();
      expect(vol.ontologies['people/open-person'].map((v) => v.value)).toEqual(['openvalue']);
    }
  });
});

describe('operator opt-out matches the sibling reads', () => {
  test(`${REMOTE_PRIVATE_PAGES_KEY}=visible restores private-provenance values for remote callers`, async () => {
    await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, 'visible');
    __resetPrivateVisibilityCacheForTests();
    try {
      const rows = await operationsByName.ontology_get.handler(remote(), { entity: 'people/open-person' }) as Val[];
      expect(rows.find((v) => v.dimension === 'role')?.value).toBe('secretvalue');
    } finally {
      await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, '');
      __resetPrivateVisibilityCacheForTests();
    }
  });
});
