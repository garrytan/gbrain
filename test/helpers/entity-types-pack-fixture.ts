/**
 * #4772 fixtures: the health counters' entity predicate follows the active
 * schema pack(s) instead of a hardcoded type list.
 *
 * Scenarios, shared by the PGLite suite (`test/health-entity-types-pack.test.ts`)
 * and the Postgres twin (`test/e2e/health-entity-types-pack.test.ts`):
 *
 *  - a global custom pack whose entity-primitive types are not legacy names;
 *  - a custom pack that declares a legacy name under another primitive;
 *  - two sources whose packs disagree about the same type name (per-source
 *    resolution, never a union of names);
 *  - a pack that cannot load (missing, corrupt): a degraded reading, never
 *    the legacy names.
 *
 * Packs are written under `<home>/.gbrain/schema-packs/<name>/pack.yaml`;
 * callers run the assertions under `withEnv({ GBRAIN_HOME: home,
 * GBRAIN_SCHEMA_PACK: undefined })` so the default locator finds them.
 */
import { expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MIN_ENTITY_PAGES_FOR_COVERAGE } from '../../src/core/types.ts';

export const SRC_X = 'entsrcx';
export const SRC_Y = 'entsrcy';

export const PACKS = {
  research: 'research-4772',
  reclassify: 'reclassify-4772',
  widgetEntity: 'widget-entity-4772',
  widgetConcept: 'widget-concept-4772',
  missing: 'missing-4772',
  corrupt: 'corrupt-4772',
} as const;

function manifest(name: string, pageTypes: Array<{ name: string; primitive: string; aliases?: string[] }>): string {
  const types = pageTypes.flatMap((t) => [
    `  - name: ${t.name}`,
    `    primitive: ${t.primitive}`,
    `    path_prefixes: ["${t.name}s/"]`,
    `    aliases: [${(t.aliases ?? []).join(', ')}]`,
  ]);
  return [
    'api_version: gbrain-schema-pack-v1', `name: ${name}`, 'version: 1.0.0', 'description: ""',
    'gbrain_min_version: 0.38.0', 'extends: null', 'borrow_from: []',
    'page_types:', ...types,
    'link_types: []', 'frontmatter_links: []', 'takes_kinds:', '  - fact', 'enrichable_types: []', 'filing_rules: []', '',
  ].join('\n');
}

/** Write every fixture pack under the given GBRAIN_HOME. The `missing` pack is never written. */
export function writeEntityTypePacks(home: string): void {
  const write = (name: string, body: string) => {
    const dir = join(home, '.gbrain', 'schema-packs', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pack.yaml'), body, 'utf-8');
  };
  write(PACKS.research, manifest(PACKS.research, [
    { name: 'researcher', primitive: 'entity' },
    { name: 'lab', primitive: 'entity' },
    { name: 'paper', primitive: 'media' },
  ]));
  write(PACKS.reclassify, manifest(PACKS.reclassify, [
    { name: 'researcher', primitive: 'entity' },
    { name: 'company', primitive: 'concept' },
  ]));
  write(PACKS.widgetEntity, manifest(PACKS.widgetEntity, [
    { name: 'widget', primitive: 'entity' },
    { name: 'gadget', primitive: 'concept' },
  ]));
  write(PACKS.widgetConcept, manifest(PACKS.widgetConcept, [
    { name: 'widget', primitive: 'concept' },
    { name: 'gadget', primitive: 'entity' },
  ]));
  write(PACKS.corrupt, 'api_version: gbrain-schema-pack-v1\nname: [not\n  a: valid\npage_types: "nope"\n');
}

export async function ensureSources(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('${SRC_X}', '${SRC_X}'), ('${SRC_Y}', '${SRC_Y}') ON CONFLICT (id) DO NOTHING`,
  );
}

export async function putTyped(engine: BrainEngine, slug: string, type: string, sourceId = 'default'): Promise<void> {
  await engine.putPage(slug, { title: slug, type: type as never, compiled_truth: `# ${slug}\n\nbody\n` }, { sourceId });
}

/** Three custom entity pages (no legacy names) and a note under a global custom pack. */
export async function seedCustomEntityPages(engine: BrainEngine): Promise<void> {
  await engine.setConfig('schema_pack', PACKS.research);
  await putTyped(engine, 'researchers/ada-example', 'researcher');
  await putTyped(engine, 'researchers/bob-example', 'researcher');
  await putTyped(engine, 'labs/lab-example', 'lab');
  await putTyped(engine, 'papers/paper-example', 'paper');
  await putTyped(engine, 'notes/plain', 'note');
}

export async function expectCustomPackCounted(engine: BrainEngine): Promise<void> {
  const health = await engine.getHealth();
  expect(health.entity_page_count, 'researcher + lab pages are the entities').toBe(3);
  expect(health.entity_types_status, 'the pack resolved').toBe('resolved');
  expect(health.most_connected.map((m) => m.slug).sort()).toEqual([
    'labs/lab-example', 'researchers/ada-example', 'researchers/bob-example',
  ]);
}

/** A pack that declares `company` under `concept`: the pack wins over the legacy list. */
export async function seedReclassifiedLegacyName(engine: BrainEngine): Promise<void> {
  await engine.setConfig('schema_pack', PACKS.reclassify);
  await putTyped(engine, 'researchers/ada-example', 'researcher');
  await putTyped(engine, 'researchers/bob-example', 'researcher');
  await putTyped(engine, 'companies/acme-example', 'company');
  await putTyped(engine, 'people/carol-example', 'person');
}

export async function expectReclassifiedLegacyNameExcluded(engine: BrainEngine): Promise<void> {
  const health = await engine.getHealth();
  // researcher x2 (pack entity) + person (legacy name the pack leaves undeclared); company is a concept here.
  expect(health.entity_page_count).toBe(3);
  expect(health.entity_types_status).toBe('resolved');
  expect(health.most_connected.map((m) => m.slug)).not.toContain('companies/acme-example');
}

/**
 * Two sources, two packs: `widget` is an entity in SRC_X and a concept in
 * SRC_Y; `gadget` the other way round. Each source has two widgets and one
 * gadget, so a per-source reading counts 2 (X) and 1 (Y); a union of the two
 * packs' names would count 6.
 */
export async function seedPerSourcePacks(engine: BrainEngine): Promise<void> {
  await ensureSources(engine);
  await engine.setConfig(`schema_pack.source.${SRC_X}`, PACKS.widgetEntity);
  await engine.setConfig(`schema_pack.source.${SRC_Y}`, PACKS.widgetConcept);
  for (const src of [SRC_X, SRC_Y]) {
    await putTyped(engine, 'widgets/one', 'widget', src);
    await putTyped(engine, 'widgets/two', 'widget', src);
    await putTyped(engine, 'gadgets/one', 'gadget', src);
  }
}

export async function expectPerSourceResolution(engine: BrainEngine): Promise<void> {
  const both = await engine.getHealth({ sourceIds: [SRC_X, SRC_Y] });
  expect(both.entity_page_count, 'X widgets (2) + Y gadget (1), not a union (6)').toBe(3);
  expect(both.entity_types_status).toBe('resolved');
  expect((await engine.getHealth({ sourceId: SRC_X })).entity_page_count, 'X alone').toBe(2);
  expect((await engine.getHealth({ sourceId: SRC_Y })).entity_page_count, 'Y alone').toBe(1);
  const brainWide = await engine.getHealth();
  expect(brainWide.entity_page_count, 'brain-wide honors each source override').toBe(3);
  expect(brainWide.entity_types_status).toBe('resolved');
}

/** Enough legacy-typed entity pages to clear the small-N floor, under a pack that cannot load. */
export async function seedUnavailablePack(engine: BrainEngine, pack: string): Promise<void> {
  await engine.setConfig('schema_pack', pack);
  for (let i = 0; i < MIN_ENTITY_PAGES_FOR_COVERAGE + 1; i++) {
    await putTyped(engine, `people/person-${i}-example`, 'person');
  }
}

export async function expectDegradedNotLegacy(engine: BrainEngine): Promise<void> {
  const health = await engine.getHealth();
  expect(health.entity_page_count, 'empty filter, never the legacy person/company list').toBe(0);
  expect(health.entity_types_status, 'a pack that does not load is reported, not papered over').toBe('pack_unavailable');
  expect(health.link_coverage).toBeNull();
  expect(health.timeline_coverage).toBeNull();
  expect(health.most_connected).toEqual([]);
  expect(health.page_count, 'the other counters still count').toBe(MIN_ENTITY_PAGES_FOR_COVERAGE + 1);
}

/** One source's override cannot load while the brain's own pack does: only readings that include that source degrade. */
export async function seedOneSourceUnavailable(engine: BrainEngine): Promise<void> {
  await ensureSources(engine);
  await engine.setConfig(`schema_pack.source.${SRC_X}`, PACKS.missing);
  await putTyped(engine, 'people/x-example', 'person', SRC_X);
  await putTyped(engine, 'people/y-example', 'person', SRC_Y);
}

export async function expectOneSourceUnavailable(engine: BrainEngine): Promise<void> {
  const x = await engine.getHealth({ sourceId: SRC_X });
  expect(x.entity_page_count, 'the broken override empties the filter').toBe(0);
  expect(x.entity_types_status).toBe('pack_unavailable');
  const y = await engine.getHealth({ sourceId: SRC_Y });
  expect(y.entity_page_count).toBe(1);
  expect(y.entity_types_status).toBe('resolved');
  const both = await engine.getHealth({ sourceIds: [SRC_X, SRC_Y] });
  expect(both.entity_page_count, 'a scope that includes the broken source degrades as a whole').toBe(0);
  expect(both.entity_types_status).toBe('pack_unavailable');
  const brainWide = await engine.getHealth();
  expect(brainWide.entity_page_count, 'brain-wide includes every source').toBe(0);
  expect(brainWide.entity_types_status).toBe('pack_unavailable');
}
