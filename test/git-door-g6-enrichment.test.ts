/**
 * G6 (git-canonical memory): extract_entities (enrichment-service.ts enrichEntity) on a strict source. Its managed
 * branch writes a stub page through put_page and the mention's timeline bullet through add_timeline_entry, both page
 * mutations through the door. Target for a batch of three entities: every page at HEAD with the content its row
 * holds, a clean tree, no git-gap census gap, and at most one commit per publication group (test/helpers/strict-door-audit.ts).
 * Runs on PGLite, and on Postgres through test/e2e/git-door-g6-enrichment-postgres.test.ts. Synthetic content only.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operations } from '../src/core/operations.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { auditDoor, expectDoorTarget, headCommit, strictSource, summarizeAudit } from './helpers/strict-door-audit.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SOURCE = 'meetings/source-a';
const TEXT = 'lunch with Alice Example, then a call with Carol Example and a visit to Acme Example Labs.';
const ENTITIES = ['people/alice-example', 'people/carol-example', 'companies/acme-example-labs'];
const op = operations.find(o => o.name === 'extract_entities')!;
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const put = (ctx: OperationContext, slug: string, content: string) => submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content } });
type Entities = { entities: Array<{ slug: string; action: string; timelineAdded: boolean; backlinkCreated: boolean }> };
/** G5 semantics held by the batch: each entity has its mention's timeline row and the bullet's backlink to the source page. */
async function expectMentions(engine: BrainEngine, result: Entities): Promise<void> {
  expect(result.entities.map(e => [e.slug, e.backlinkCreated]).sort()).toEqual(ENTITIES.map(slug => [slug, true]).sort());
  const rows = await engine.executeRaw<{ slug: string }>(`SELECT p.slug FROM timeline_entries te JOIN pages p ON p.id=te.page_id
    WHERE p.source_id='default' AND te.source=$1 ORDER BY p.slug`, [SOURCE]);
  expect(rows.map(row => row.slug)).toEqual([...ENTITIES].sort());
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`[${backend}] G6: extract_entities on a strict source writes only through the door`, () => {
    test('three new entity stubs and their timeline bullets: at HEAD, clean, no census gap, one commit per group', () => managedBrain(async ({ engine, ctx, root }) => {
      await strictSource(engine);
      await put(ctx, SOURCE, '---\ntype: meeting\ntitle: Source A\n---\n\nMet people.\n');
      await settleManagedGitEffects(engine);
      const since = await headCommit(root);
      const result = await op.handler(ctx, { text: TEXT, source_slug: SOURCE }) as Entities;
      expect(result.entities.map(e => [e.slug, e.action, e.timelineAdded]).sort()).toEqual(ENTITIES.map(slug => [slug, 'created', true]).sort());
      await expectMentions(engine, result);
      await settleManagedGitEffects(engine);
      const audit = await auditDoor(engine, root, { since, slugs: ENTITIES });
      console.log(summarizeAudit(`enrichment stubs ${backend}`, audit));
      expectDoorTarget(audit, engine.kind);
    }, { databaseUrl, setup }), 180_000);

    test('three existing entity pages get their timeline bullets: at HEAD, clean, no census gap, one commit per group', () => managedBrain(async ({ engine, ctx, root }) => {
      await strictSource(engine);
      await put(ctx, SOURCE, '---\ntype: meeting\ntitle: Source A\n---\n\nMet people.\n');
      await put(ctx, ENTITIES[0]!, '---\ntype: person\ntitle: Alice Example\n---\n\nA person.\n');
      await put(ctx, ENTITIES[1]!, '---\ntype: person\ntitle: Carol Example\n---\n\nA person.\n');
      await put(ctx, ENTITIES[2]!, '---\ntype: company\ntitle: Acme Example Labs\n---\n\nA company.\n');
      await settleManagedGitEffects(engine);
      const since = await headCommit(root);
      const result = await op.handler(ctx, { text: TEXT, source_slug: SOURCE }) as Entities;
      expect(result.entities.map(e => [e.slug, e.action, e.timelineAdded]).sort()).toEqual(ENTITIES.map(slug => [slug, 'updated', true]).sort());
      await expectMentions(engine, result);
      await settleManagedGitEffects(engine);
      const audit = await auditDoor(engine, root, { since, slugs: ENTITIES });
      console.log(summarizeAudit(`enrichment timeline ${backend}`, audit));
      expectDoorTarget(audit, engine.kind);
    }, { databaseUrl, setup }), 180_000);
  });
}
