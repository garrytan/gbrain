/**
 * B-7 (#6948 sweep, #6925): facts landed on an entity slug that has no page
 * while the page they mean exists under an organization directory variant.
 *
 * #6898's alias arm only accepts a separator-folded alias hit in the
 * reference's own directory, so an extractor's `companies/acme-example` missed
 * `orgs/acme-example` even though that page lists `acme example` as an
 * alias, and no page exists at `companies/acme-example` at all. The resolver
 * fell back to a slugify: the facts backstop then stored the fact with no
 * entity (the raw name dropped), and managed writes kept the invented slug as
 * attribution, minting a page-less `entity_slug`. `companies/`, `orgs/` and
 * `organizations/` hold the same organization pages, so a reference in one
 * now reaches the page (or alias) in another; `projects/` and `people/` keep
 * their own directory.
 *
 * Read side: `gbrain repair facts-rehome` re-homes database-only facts from a
 * page-less entity slug to the page the strict resolver reaches by identity
 * evidence. Preview-first: the preview lists every page-less slug with its
 * class, an apply moves only with the preview's hash, and ambiguous or
 * unresolved slugs are listed and never moved.
 *
 * Real PGLite, plus the Postgres arm when DATABASE_URL is set
 * (test/postgres-unit-arms.txt). Placeholder names only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { resolveEntitySlugWithSource, resolveStrictEntityReference } from '../../src/core/entities/resolve.ts';
import { runFactsBackstop } from '../../src/core/facts/backstop.ts';
import { writeSingleFact } from '../../src/core/facts/write-single.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../../src/core/facts/queue.ts';
import { resolveRepairScope, runRepair, type RepairHandler } from '../../src/core/repair/core.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { pathologicalArms } from './harness.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';

const md = (title: string, type: string, aliases: string[] = []) =>
  `---\ntitle: ${title}\ntype: ${type}\n${aliases.length ? `aliases:\n${aliases.map(a => `  - ${JSON.stringify(a)}`).join('\n')}\n` : ''}---\n\n# ${title}\n`;

async function seedPages(engine: BrainEngine): Promise<void> {
  const pages: Array<[string, string, string, string[]]> = [
    ['orgs/acme-example', 'Acme Example', 'organization', ['acme example', 'Acme Example Holdings']],
    ['orgs/delta-example', 'Delta Example', 'organization', []],
    ['orgs/omega-one-example', 'Omega One Example', 'organization', ['omega example']],
    ['companies/omega-two-example', 'Omega Two Example', 'company', ['omega example']],
    ['people/jane-doe-example', 'Jane Doe Example', 'person', []],
  ];
  for (const [slug, title, type, aliases] of pages) await importFromContent(engine, slug, md(title, type, aliases), { noEmbed: true });
}

const stubExtractor = (entity: string) => __setChatTransportForTests(async (): Promise<ChatResult> => ({
  text: JSON.stringify({ facts: [{ fact: 'Acme Example closed a seed round led by fund-a', kind: 'event', entity, confidence: 1, notability: 'high' }] }),
  blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test',
}));

const factSlugs = (engine: BrainEngine) => engine.executeRaw<{ fact: string; entity_slug: string | null }>(
  `SELECT fact, entity_slug FROM facts WHERE source_id = 'default' ORDER BY id`);

async function rehomeHandler(): Promise<RepairHandler> {
  const path = '../../src/core/repair/facts-rehome.ts';
  return (await import(path)).factsRehomeRepair as RepairHandler;
}

const ctxFor = (engine: BrainEngine): OperationContext => ({ engine, config: { engine: engine.kind, embedding_disabled: true } as never, sourceId: 'default',
  remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } });

const seedFact = (engine: BrainEngine, entity_slug: string, fact: string) =>
  engine.insertFact({ fact, entity_slug, kind: 'fact', visibility: 'world', source: 'mcp:extract_facts' }, { source_id: 'default' });

for (const arm of pathologicalArms()) {
  describe(`B-7 facts reach the organization page an extractor names under another directory (${arm.backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => { ({ engine, close } = await isolatedSharedSkillsEngine(arm.databaseUrl)); await seedPages(engine); }, 120_000);
    afterAll(async () => { await close(); });
    beforeEach(async () => {
      __setChatTransportForTests(null); resetGateway(); __resetFactsQueueForTests();
      await engine.executeRaw(`DELETE FROM facts WHERE source_id = 'default'`);
    });

    test('companies/acme-example resolves to orgs/acme-example through its alias; a prefix variant with no alias resolves too', async () => {
      expect((await resolveEntitySlugWithSource(engine, 'default', 'companies/acme-example'))?.slug).toBe('orgs/acme-example');
      expect((await resolveEntitySlugWithSource(engine, 'default', 'companies/acme-example-holdings'))?.slug).toBe('orgs/acme-example');
      expect((await resolveEntitySlugWithSource(engine, 'default', 'companies/delta-example'))?.slug).toBe('orgs/delta-example');
      expect(await resolveStrictEntityReference(engine, 'default', 'companies/acme-example')).toMatchObject({ slug: 'orgs/acme-example' });
      expect(await resolveStrictEntityReference(engine, 'default', 'organizations/delta-example')).toMatchObject({ slug: 'orgs/delta-example' });
    });

    test('directories outside the organization set keep their own: projects/ and people/ never land on an org page', async () => {
      expect((await resolveEntitySlugWithSource(engine, 'default', 'projects/acme-example'))?.source).toBe('fallback_slugify');
      expect((await resolveEntitySlugWithSource(engine, 'default', 'people/delta-example'))?.source).toBe('fallback_slugify');
      expect(await resolveStrictEntityReference(engine, 'default', 'projects/delta-example')).toEqual({ slug: null, miss: 'no_page' });
    });

    test('the facts backstop lands an extractor fact for companies/acme-example on orgs/acme-example', async () => {
      stubExtractor('companies/acme-example');
      const page = { slug: 'mail/thread-acme-example', type: 'note' as const, compiled_truth: 'a mail thread about Acme Example raising money. '.repeat(3), frontmatter: {} };
      const r = await runFactsBackstop(page, { engine, sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'inline' });
      expect(r.mode).toBe('inline');
      expect((await factSlugs(engine)).map(f => f.entity_slug)).toEqual(['orgs/acme-example']);
    });

    test('repair facts-rehome previews every page-less slug with its class and moves nothing on a dry run', async () => {
      await seedFact(engine, 'companies/acme-example', 'Acme Example hired a head of sales');
      await seedFact(engine, 'companies/acme-example', 'Acme Example opened a second office');
      await seedFact(engine, 'companies/acme-example-holdings', 'Acme Example Holdings filed its annual report');
      await seedFact(engine, 'companies/omega-example', 'Omega Example shipped a beta');
      await seedFact(engine, 'people/zed-nobody-example', 'Zed Nobody Example likes chess');
      await seedFact(engine, 'orgs/acme-example', 'Acme Example is based in a placeholder city');
      const before = await factSlugs(engine);
      const preview = await runRepair(ctxFor(engine), await rehomeHandler(), await resolveRepairScope(engine), { apply: false, explicit: true });
      expect(preview.preview_hash).toMatch(/^[0-9a-f]{12,}$/);
      expect(preview.listing!.map(l => [l.item, l.class])).toEqual([
        ['default:companies/acme-example', 'rehome'],
        ['default:companies/acme-example-holdings', 'rehome'],
        ['default:companies/omega-example', 'ambiguous'],
        ['default:people/zed-nobody-example', 'unresolved'],
      ]);
      expect(preview.listing![0].detail).toContain('orgs/acme-example');
      expect(preview.affected).toBe(2);
      expect(await factSlugs(engine)).toEqual(before);
    });

    test('an apply with the preview hash moves exactly the previewed facts; ambiguous and unresolved stay where they are', async () => {
      await seedFact(engine, 'companies/acme-example', 'Acme Example hired a head of sales');
      await seedFact(engine, 'companies/acme-example-holdings', 'Acme Example Holdings filed its annual report');
      await seedFact(engine, 'companies/omega-example', 'Omega Example shipped a beta');
      await seedFact(engine, 'people/zed-nobody-example', 'Zed Nobody Example likes chess');
      const handler = await rehomeHandler();
      const scope = await resolveRepairScope(engine);
      await expect(runRepair(ctxFor(engine), handler, scope, { apply: true, explicit: true })).rejects.toThrow(/preview/i);
      const preview = await runRepair(ctxFor(engine), handler, scope, { apply: false, explicit: true });
      const applied = await runRepair(ctxFor(engine), handler, scope, { apply: true, explicit: true, expect: preview.preview_hash });
      expect(applied.applied).toBe(2);
      expect((await factSlugs(engine)).map(f => f.entity_slug)).toEqual(['orgs/acme-example', 'orgs/acme-example', 'companies/omega-example', 'people/zed-nobody-example']);
    });

    test('a stale preview refuses: an unknown hash is refused, and a slug whose facts changed since the preview is kept', async () => {
      await seedFact(engine, 'companies/acme-example', 'Acme Example hired a head of sales');
      const handler = await rehomeHandler();
      const scope = await resolveRepairScope(engine);
      await expect(runRepair(ctxFor(engine), handler, scope, { apply: true, explicit: true, expect: 'f'.repeat(64) })).rejects.toThrow(/preview/i);
      const preview = await runRepair(ctxFor(engine), handler, scope, { apply: false, explicit: true });
      await seedFact(engine, 'companies/acme-example', 'Acme Example opened a second office');
      const applied = await runRepair(ctxFor(engine), handler, scope, { apply: true, explicit: true, expect: preview.preview_hash });
      expect(applied.applied).toBe(0);
      expect(applied.outcomes).toMatchObject({ changed_since_preview: 1 });
      expect((await factSlugs(engine)).map(f => f.entity_slug)).toEqual(['companies/acme-example', 'companies/acme-example']);
    });
  });

  describe(`B-7 a managed write does not mint a page-less organization slug (${arm.backend})`, () => {
    test('remember-style single fact for companies/acme-example lands on orgs/acme-example', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await operationsByName.put_page.handler(ctx, { slug: 'orgs/acme-example', content: md('Acme Example', 'organization', ['acme example']) });
        await writeSingleFact(engine, 'default', { fact: 'Acme Example signed a lease', provenance: 'test:b-7', entity: 'companies/acme-example', visibility: 'world', remote: false });
        expect((await factSlugs(engine)).map(f => f.entity_slug)).toEqual(['orgs/acme-example']);
      }, { databaseUrl: arm.databaseUrl });
    }, 120_000);

    test('repair facts-rehome applies as a coordinated write on a managed brain', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await writeSingleFact(engine, 'default', { fact: 'Acme Example hired a head of sales', provenance: 'test:b-7', entity: 'companies/acme-example', visibility: 'world', remote: false });
        expect((await factSlugs(engine)).map(f => f.entity_slug)).toEqual(['companies/acme-example']);
        await operationsByName.put_page.handler(ctx, { slug: 'orgs/acme-example', content: md('Acme Example', 'organization', ['acme example']) });
        const handler = await rehomeHandler();
        const scope = await resolveRepairScope(engine);
        const preview = await runRepair(ctx, handler, scope, { apply: false, explicit: true });
        const applied = await runRepair(ctx, handler, scope, { apply: true, explicit: true, expect: preview.preview_hash });
        expect(applied.applied).toBe(1);
        expect((await factSlugs(engine)).map(f => f.entity_slug)).toEqual(['orgs/acme-example']);
      }, { databaseUrl: arm.databaseUrl });
    }, 120_000);
  });
}
