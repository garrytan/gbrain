/**
 * #4772 — onboarding coverage, the MCP onboarding counts and NER typed edges
 * read the active pack's entity types per source, like get_health.
 *
 * Protects: `checkEntityLinkCoverage` / `checkTimelineCoverage`,
 * `collectOnboardOpportunities`, the MCP timeline-coverage result predicate
 * and `extractNerLinks`' target-type map count the page types the active
 * pack(s) declare `primitive: entity`, resolved per source; a pack in scope
 * that does not load makes the checks warn `entity_types_unavailable` and the
 * counts unknown, never a read of the old hardcoded list.
 * Fails when: any of them goes back to `type IN ('person', 'company',
 * 'organization', 'entity')` (a `venue` entity counts 0 and gets no typed
 * edge; a broken pack silently grades person pages).
 * Why new: test/health-entity-types-pack.test.ts covers get_health only; the
 * onboarding and NER readers kept their own lists.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { checkEntityLinkCoverage, checkTimelineCoverage } from '../src/core/onboard/checks.ts';
import { collectOnboardOpportunities, __resetMcpOnboardingForTests, __warmOnboardingCacheForTests } from '../src/core/onboard/mcp-onboarding.ts';
import { dispatchToolCall, __resetBackupNoticeForTests, type ToolResult } from '../src/mcp/dispatch.ts';
import { STARTER_OPS } from '../src/mcp/surface.ts';
import { extractNerLinks } from '../src/core/extract-ner.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { PACKS, SRC_X, putTyped, seedPerSourcePacks, seedUnavailablePack, writeEntityTypePacks } from './helpers/entity-types-pack-fixture.ts';

const VENUE_PACK = 'venue-4772';
const VENUES = ['blue-hall', 'red-room', 'green-stage', 'gray-arena', 'gold-club', 'teal-loft'];

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-4772-onboard-'));
const env = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined, GBRAIN_NO_ONBOARD_NUDGE: undefined }, fn);

function writeVenuePack(): void {
  const dir = join(home, '.gbrain', 'schema-packs', VENUE_PACK);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.yaml'), [
    'api_version: gbrain-schema-pack-v1', `name: ${VENUE_PACK}`, 'version: 1.0.0', 'description: ""',
    'gbrain_min_version: 0.38.0', 'extends: null', 'borrow_from: []',
    'page_types:',
    '  - name: venue', '    primitive: entity', '    path_prefixes: ["venues/"]', '    aliases: []',
    '  - name: person', '    primitive: entity', '    path_prefixes: ["people/"]', '    aliases: []',
    '  - name: note', '    primitive: concept', '    path_prefixes: ["notes/"]', '    aliases: []',
    'link_types:',
    '  - name: performed_at', '    inference:', '      page_type: venue', '      regex: \\bperformed at\\b', '      ner_only: true',
    'frontmatter_links: []', 'takes_kinds:', '  - fact', 'enrichable_types: []', 'filing_rules: []', '',
  ].join('\n'), 'utf-8');
}

/** Six venue pages (a pack entity type, no legacy name), three with an inbound link and a timeline entry. */
async function seedVenues(): Promise<void> {
  await engine.setConfig('schema_pack', VENUE_PACK);
  await putTyped(engine, 'notes/plain', 'note');
  for (const [i, v] of VENUES.entries()) {
    await putTyped(engine, `venues/${v}`, 'venue');
    if (i >= 3) continue;
    await engine.addLinksBatch([{ from_slug: 'notes/plain', to_slug: `venues/${v}`, link_type: 'mentions', link_source: 'manual' }]);
    await engine.addTimelineEntry(`venues/${v}`, { date: '2026-01-02', source: 'test', summary: 'opened' });
  }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  writeEntityTypePacks(home);
  writeVenuePack();
});

afterAll(async () => {
  __resetMcpOnboardingForTests();
  __resetBackupNoticeForTests();
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetPackCacheForTests();
  __resetMcpOnboardingForTests();
  __resetBackupNoticeForTests();
});

describe('#4772 onboard coverage checks follow the active pack', () => {
  test('a pack that declares venue as an entity grades the venue pages', async () => {
    await env(async () => {
      await seedVenues();
      const link = await checkEntityLinkCoverage(engine);
      expect(link.check.status, link.check.message).toBe('warn');
      expect(link.check.message).toContain('Coverage 50%');
      const timeline = await checkTimelineCoverage(engine);
      expect(timeline.check.status, timeline.check.message).toBe('warn');
      expect(timeline.check.message).toContain('50%');
    });
  });

  test('two sources with different packs count per source, never a union of names', async () => {
    await env(async () => {
      await seedPerSourcePacks(engine);
      const link = await checkEntityLinkCoverage(engine);
      expect(link.check.message, 'X widgets (2) + Y gadget (1)').toContain('Only 3 entity pages');
    });
  });

  test('a pack that does not load warns entity_types_unavailable instead of grading the legacy list', async () => {
    await env(async () => {
      await seedUnavailablePack(engine, PACKS.missing);
      for (const check of [await checkEntityLinkCoverage(engine), await checkTimelineCoverage(engine)]) {
        expect(check.check.status).toBe('warn');
        expect(check.check.details).toMatchObject({ code: 'entity_types_unavailable', entity_types_status: 'pack_unavailable' });
        expect(check.check.fix?.argv?.slice(0, 3)).toEqual(['gbrain', 'schema', 'active']);
        expect(check.remediations).toEqual([]);
      }
    });
  });

  test("one source's override that does not load names that source", async () => {
    await env(async () => {
      await seedPerSourcePacks(engine);
      await engine.setConfig(`schema_pack.source.${SRC_X}`, PACKS.missing);
      const link = await checkEntityLinkCoverage(engine);
      expect(link.check.details).toMatchObject({ code: 'entity_types_unavailable', unresolved_sources: [SRC_X] });
      expect(link.check.fix?.argv).toEqual(['gbrain', 'schema', 'active', '--json', '--source', SRC_X]);
    });
  });
});

describe('#4772 MCP onboarding counts follow the active pack', () => {
  test('venue entities are counted', async () => {
    await env(async () => {
      await seedVenues();
      const counts = await collectOnboardOpportunities(engine, new AbortController().signal);
      expect(counts).toMatchObject({ entities: 6, linkedEntities: 3, timelineEntities: 3, entityTypesStatus: 'resolved' });
    });
  });

  test('per-source packs count per source', async () => {
    await env(async () => {
      await seedPerSourcePacks(engine);
      const counts = await collectOnboardOpportunities(engine, new AbortController().signal);
      expect(counts.entities).toBe(3);
    });
  });

  test('a pack that does not load leaves the entity counts unknown, not the legacy list', async () => {
    await env(async () => {
      await seedUnavailablePack(engine, PACKS.missing);
      const counts = await collectOnboardOpportunities(engine, new AbortController().signal);
      expect(counts).toMatchObject({ entities: null, linkedEntities: null, timelineEntities: null, entityTypesStatus: 'pack_unavailable', partial: true });
      expect(counts.pages).toBe(6);
    });
  });

  test('a venue page without a timeline gets the timeline-coverage notice', async () => {
    await env(async () => {
      await seedVenues();
      await __warmOnboardingCacheForTests(engine as never);
      const opts = { remote: true, transport: 'stdio' as const, sourceId: 'default', allowedOps: new Set(STARTER_OPS), surface: 'starter' as const };
      const result: ToolResult = await dispatchToolCall(engine as never, 'get_page', { slug: 'venues/teal-loft' }, opts);
      const codes = ((result._meta?.gbrain_notices ?? []) as Array<{ code: string }>).map(n => n.code);
      expect(codes).toContain('onboard_timeline_coverage');
    });
  });
});

describe('#4772 NER target types follow the active pack', () => {
  test('a mention of a venue entity gets the typed edge the pack infers', async () => {
    await env(async () => {
      await engine.setConfig('schema_pack', VENUE_PACK);
      await engine.putPage('venues/blue-hall-example', { title: 'Blue Hall Example', type: 'venue' as never, compiled_truth: 'A concert hall.' });
      await engine.putPage('people/ana-example', { title: 'Ana Example', type: 'person' as never, compiled_truth: 'Ana Example performed at Blue Hall Example last spring.' });
      const result = await extractNerLinks(engine);
      expect(result.pack_unavailable).toBe(false);
      const links = await engine.getLinks('people/ana-example');
      expect(links.filter(l => l.link_type === 'performed_at').map(l => l.to_slug)).toEqual(['venues/blue-hall-example']);
    });
  });

  test('a source override that does not load reports pack_unavailable and writes nothing', async () => {
    await env(async () => {
      await engine.setConfig('schema_pack', VENUE_PACK);
      await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('${SRC_X}', '${SRC_X}') ON CONFLICT (id) DO NOTHING`);
      await engine.setConfig(`schema_pack.source.${SRC_X}`, PACKS.missing);
      await engine.putPage('venues/blue-hall-example', { title: 'Blue Hall Example', type: 'venue' as never, compiled_truth: 'A concert hall.' });
      await engine.putPage('people/ana-example', { title: 'Ana Example', type: 'person' as never, compiled_truth: 'Ana Example performed at Blue Hall Example last spring.' });
      const result = await extractNerLinks(engine);
      expect(result).toEqual({ pages: 0, created: 0, pack_unavailable: true });
      expect(await engine.getLinks('people/ana-example')).toEqual([]);
    });
  });
});
