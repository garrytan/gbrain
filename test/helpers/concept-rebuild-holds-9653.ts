import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { __setChatTransportForTests } from '../../src/core/ai/gateway.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { managedBrain } from './managed-brain.ts';
import { CONCEPT, NEW, raw, purge, synthesize, state, heldConcept, stillHeld } from './concept-rebuild-9653.ts';

/** The per-kind holds, one test file per mode so each runs in about a minute on CI's Postgres arm. */
export function registerConceptHoldTests(unmanaged: boolean, backend: string, databaseUrl: string | undefined): void {
  afterEach(() => { installFaultHook(undefined); __setChatTransportForTests(null); });
  describe(`a concept hidden by an input purge is rebuilt as a fresh page: what keeps it hidden (${backend})`, () => {
    const mode = unmanaged ? 'unmanaged' : 'managed';
    test(`${mode}: a curated ## Facets section on the hidden concept keeps it hidden and held${unmanaged ? ' (no git repository)' : ''}`, async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        const id = await heldConcept(engine, ctx, root);
        await raw(engine, "UPDATE pages SET compiled_truth = compiled_truth || E'\\n\\n## Facets\\n\\n- storage-alt-example: merged here.\\n' WHERE source_id='default' AND slug=$1", [CONCEPT]);
        if (unmanaged) {
          rmSync(join(root, '.git'), { recursive: true, force: true });
          await raw(engine, "UPDATE sources SET local_path=NULL WHERE id='default'");
        }
        const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged, settle: !unmanaged });
        expect(details.rebuilt).toEqual([]);
        expect(details.rebuild_kept).toEqual([{ source_id: 'default', slug: CONCEPT, reason: 'stated', kinds: ['curated_sections'] }]);
        await stillHeld(engine, id);
        expect((await state(engine)).body).toContain('storage-alt-example: merged here.');
      }, { databaseUrl });
    }, 300_000);

    test(`${mode}: anything on the page synthesis did not write keeps it hidden and held${unmanaged ? ' (no git repository)' : ''}`, async () => {
      const authored: Array<[string, string, unknown[]]> = [
        ['title', "UPDATE pages SET title = 'Storage, renamed by hand' WHERE source_id='default' AND slug=$1", [CONCEPT]],
        ['frontmatter', "UPDATE pages SET frontmatter = frontmatter || '{\"aliases\":[\"storage-alt-example\"]}'::jsonb WHERE source_id='default' AND slug=$1", [CONCEPT]],
        ['timeline', "UPDATE pages SET timeline = '- 2026-01-01: a curated event' WHERE source_id='default' AND slug=$1", [CONCEPT]],
        ['source_path', "UPDATE pages SET source_path = 'concepts/storage-renamed.md' WHERE source_id='default' AND slug=$1", [CONCEPT]],
      ];
      for (const [kind, sql, params] of authored) await managedBrain(async ({ engine, ctx, root }) => {
        const id = await heldConcept(engine, ctx, root);
        await raw(engine, sql, params);
        if (unmanaged) {
          rmSync(join(root, '.git'), { recursive: true, force: true });
          await raw(engine, "UPDATE sources SET local_path=NULL WHERE id='default'");
        }
        const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged, settle: !unmanaged });
        expect(details.rebuilt).toEqual([]);
        expect(details.rebuild_kept).toEqual([{ source_id: 'default', slug: CONCEPT, reason: 'stated', kinds: [kind] }]);
        await stillHeld(engine, id);
      }, { databaseUrl });
    }, 1_500_000);

    test(`${mode}: what a person stated keeps it hidden and held, and the purge deletes none of it`, async () => {
      const stated: Array<[string, (engine: BrainEngine, ctx: OperationContext, id: number) => Promise<void>]> = [
        ['labels', async engine => raw(engine, 'UPDATE pages SET frontmatter = frontmatter || $2::text::jsonb WHERE source_id = $3 AND slug = $1', [CONCEPT, JSON.stringify({ readable_by: ['alice-example'] }), 'default'])],
        ['links', async (engine, _ctx, id) => raw(engine, "INSERT INTO links (from_page_id, to_page_id, link_type, link_source, context) SELECT n.id, $1, 'mentions', 'manual', 'added by hand' FROM pages n WHERE n.slug = 'notes/storage-ref'", [id])],
        ['facts', async engine => raw(engine, "INSERT INTO facts (source_id, fact, source, entity_slug) VALUES ('default', 'A stated fact about storage.', 'mcp:remember', $1)", [CONCEPT])],
        ['tags', async (engine, _ctx, id) => raw(engine, "INSERT INTO tags (page_id, tag) VALUES ($1, 'hand-tag')", [id])],
        ['timeline_entries', async (engine, _ctx, id) => raw(engine, "INSERT INTO timeline_entries (page_id, date, summary) VALUES ($1, '2026-01-01', 'a stated event')", [id])],
        ['raw_data', async (engine, _ctx, id) => raw(engine, "INSERT INTO raw_data (page_id, source, data) VALUES ($1, 'agent-example', '{\"note\": 1}'::jsonb)", [id])],
        ['link_edge_proposals', async (engine, _ctx, id) => raw(engine, "INSERT INTO link_edge_proposals (source_id, from_page_id, a_to_page_id, b_to_page_id, link_type, evidence_hash, status) SELECT 'default', n.id, $1, n.id, 'works_at', 'evidence-example', 'rejected' FROM pages n WHERE n.slug = 'notes/storage-ref'", [id])],
        ['entity_identities', async (engine, _ctx, id) => raw(engine, "INSERT INTO entity_identities (entity_id, source_id, page_id) VALUES ('entity-example', 'default', $1)", [id])],
        ['guest_marks', async (engine, _ctx, id) => raw(engine, "INSERT INTO guest_marks (page_id, source_id, slug_at_write, audience_member, group_slug, sender_label, saved_at, writer_kind, writer_id) VALUES ($1, 'default', $2, 'alice-example', 'group-example', 'Alice', now(), 'member', 'alice-example')", [id, CONCEPT])],
        ['secret_store_occurrence', async (engine, _ctx, id) => {
          await raw(engine, "INSERT INTO secret_store (id, source_id, rule, ciphertext, nonce, tag, key_id, value_mac) VALUES ('ss_0123456789ab', 'default', 'api_key', 'sealed', 'nonce', 'tag', '0123456789abcdef', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')");
          await raw(engine, "INSERT INTO secret_store_occurrence (entry_id, source_id, page_id, slug, field, origin) VALUES ('ss_0123456789ab', 'default', $1, $2, 'compiled_truth', 'repair')", [id, CONCEPT]);
        }],
        ['secret_store_occurrence', async engine => {
          await raw(engine, "INSERT INTO secret_store (id, source_id, rule, ciphertext, nonce, tag, key_id, value_mac) VALUES ('ss_0123456789ac', 'default', 'api_key', 'sealed', 'nonce', 'tag', '0123456789abcdef', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')");
          await raw(engine, "INSERT INTO secret_store_occurrence (entry_id, source_id, page_id, slug, field, origin) VALUES ('ss_0123456789ac', 'default', NULL, $1, 'compiled_truth', 'repair')", [CONCEPT]);
        }],
        ['guest_promotions', async (engine, _ctx, id) => raw(engine, "INSERT INTO guest_promotions (guest_page_id, target_source_id, target_slug, promoted_by_kind, promoted_by_id) VALUES ($1, 'default', 'notes/promoted-example', 'member', 'alice-example')", [id])],
      ];
      for (const [kind, add] of stated) await managedBrain(async ({ engine, ctx, root }) => {
        const id = await heldConcept(engine, ctx, root);
        await add(engine, ctx, id);
        const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged });
        expect(details.rebuilt).toEqual([]);
        expect(details.rebuild_kept).toEqual([{ source_id: 'default', slug: CONCEPT, reason: 'stated', kinds: [kind] }]);
        await stillHeld(engine, id, kind === 'links' ? 2 : 1);
        if (kind === 'secret_store_occurrence') expect(await engine.executeRaw("SELECT 1 FROM secret_store s JOIN secret_store_occurrence o ON o.entry_id = s.id WHERE o.slug = $1", [CONCEPT])).toHaveLength(1);
      }, { databaseUrl });
    }, 1_500_000);
  });
}
