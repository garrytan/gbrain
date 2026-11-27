/**
 * BrainEngine parity: the slugs facts about a page are read under (mentions/siblings.ts factEntitySlugs) for a caller
 * that may not read private pages.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: for a caller with `excludePrivate`, a private page at the asked slug reads as no page. Its title subject
 *    and its bare basename are not added to the fact keys, so recall, the slot history and the entity's saved facts
 *    give the same answer as when no page sits at the slug. A caller that reads private pages (the local CLI) still
 *    gets the title subject and basename keys of that page.
 *  - Regression: the title read was `getPage(slug, { sourceId })` with no private-page filter. A world-only remote
 *    `recall` of a private page's slug then returned the world facts saved under the page's title subject, with that
 *    subject as their `entity_slug`. That showed the caller that the page exists and what its title names. A missing
 *    page returned nothing. Every engine did this: the read is shared TypeScript.
 *  - Why existing coverage misses it: test/recall-entity-keying-4828.test.ts and test/facts-slot-history-gbra574.test.ts
 *    read world pages, or read as the local caller; no case asks for a private page's slug as a remote caller.
 *  - Seam: none. Real engines, typed methods only; the recall op runs with a world-only remote context.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operations } from '../../src/core/operations.ts';
import { factEntitySlugs } from '../../src/core/mentions/siblings.ts';
import { entityKeys } from '../../src/core/search/slot-history.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SLUG = 'companies/secret-co';

function ctxFor(engine: BrainEngine, remote: boolean): OperationContext {
  return { engine, config: { engine: engine.kind }, remote, dryRun: false, sourceId: 'default',
    ...(remote ? { transport: 'stdio', takesHoldersAllowList: ['world'] } : {}),
    logger: { info() {}, warn() {}, error() {} }, emitNotice() {} } as unknown as OperationContext;
}

/** World facts saved under the page's title subject (`hidden-name`) and its bare basename (`secret-co`). */
async function seedFacts(engine: BrainEngine): Promise<void> {
  await engine.insertFacts([
    { fact: 'Saved under the title subject.', kind: 'fact', entity_slug: 'hidden-name', source: 'test', visibility: 'world' },
    { fact: 'Saved under the basename.', kind: 'fact', entity_slug: 'secret-co', source: 'test', visibility: 'world' },
  ] as never, { source_id: 'default' });
}

const privatePage: PageInput = { type: 'company', title: 'Hidden Name', compiled_truth: 'A private company.', timeline: '', frontmatter: { visibility: 'private' } };

/** What a world-only remote caller reads for SLUG: the fact keys, the slot-history keys and the recall op's facts. */
async function remoteView(engine: BrainEngine) {
  const recall = operations.find(o => o.name === 'recall')!;
  const r = await recall.handler(ctxFor(engine, true), { entity: SLUG }) as { facts: Array<{ entity_slug: string | null }> };
  return {
    keys: await factEntitySlugs(engine, 'default', SLUG, { excludePrivate: true }),
    slotKeys: (await entityKeys(engine, 'default', SLUG, { excludePrivate: true })).slugs,
    recall: r.facts.map(f => f.entity_slug),
  };
}

describe('engine parity: fact keys of a page the caller may not read', () => {
  parityTest('a world-only remote caller reads the fact keys of a private page exactly as those of a missing page', {
    methods: ['insertFacts', 'putPage', 'getPage'],
  }, async (engine) => {
    await seedFacts(engine);
    const missing = await remoteView(engine);
    await engine.putPage(SLUG, privatePage);
    const hidden = await remoteView(engine);
    expect(missing).toEqual({ keys: [SLUG], slotKeys: [SLUG], recall: [] });
    expect(hidden).toEqual(missing);
    expect(JSON.stringify(hidden)).not.toContain('hidden-name');
    return { missing, hidden };
  });

  parityTest('the local caller still reads the private page\'s title subject and basename keys', {
    methods: ['insertFacts', 'putPage', 'getPage'],
  }, async (engine) => {
    await seedFacts(engine);
    await engine.putPage(SLUG, privatePage);
    const keys = await factEntitySlugs(engine, 'default', SLUG, { excludePrivate: false });
    expect(keys).toEqual([SLUG, 'hidden-name', 'secret-co']);
    const recall = operations.find(o => o.name === 'recall')!;
    const r = await recall.handler(ctxFor(engine, false), { entity: SLUG }) as { facts: Array<{ entity_slug: string | null }> };
    const slugs = r.facts.map(f => f.entity_slug).sort();
    expect(slugs).toEqual(['hidden-name', 'secret-co']);
    return { keys, slugs };
  });

  parityTest('a world page keeps its title subject and basename keys for a remote caller', {
    methods: ['insertFacts', 'putPage', 'getPage'],
  }, async (engine) => {
    await seedFacts(engine);
    await engine.putPage(SLUG, { ...privatePage, frontmatter: {} });
    const view = await remoteView(engine);
    expect(view.keys).toEqual([SLUG, 'hidden-name', 'secret-co']);
    expect(view.recall.sort()).toEqual(['hidden-name', 'secret-co']);
    return view;
  });
});
