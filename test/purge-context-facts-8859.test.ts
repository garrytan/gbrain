/**
 * #8859: facts the backstop extracted from a page and filed on none (no `source_markdown_slug`, the page slug as the
 * head of `context`; atom pages wrote thousands before #5831) outlived that page's purge, by both purge paths (a direct
 * `delete_page purge: true` and the retention expiry of a soft-deleted page), and stayed active and recallable. Both
 * paths now take them; a fact whose context only names the page as free text (not a page-extraction source) stays.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const ATOM = 'atoms/2026-09-30/example-claim';
const MEETING = 'meetings/example-meeting';

async function put(ctx: OperationContext, slug: string, type: string) {
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, source_id: 'default', request_id: randomUUID(),
    content: `---\ntype: ${type}\ntitle: Example\n---\nA synthetic page.\n` } });
}
async function pageId(engine: BrainEngine, slug: string) {
  const [row] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [slug]);
  return Number(row!.id);
}
/** Rows as an earlier version left them: written under replica role, so no current writer guard applies. */
const legacyRow = <T>(engine: BrainEngine, sql: string, params: unknown[]) => engine.transaction(async tx => {
  await tx.executeRaw('SET LOCAL session_replication_role = replica');
  return tx.executeRaw<T>(sql, params);
});
async function fact(engine: BrainEngine, text: string, entity: string | null, context: string, opts: { input?: number; source?: string } = {}) {
  const [row] = await legacyRow<{ id: number }>(engine, `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, context, valid_from)
    VALUES ('default', $1, $2, 'fact', 'private', 'high', $4, $3, now()) RETURNING id`, [entity, text, context, opts.source ?? 'mcp:put_page']);
  if (opts.input) await legacyRow(engine, "INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id) VALUES ('facts',$1,'pages',$2,'default')", [String(row!.id), String(opts.input)]);
  return Number(row!.id);
}
const active = async (engine: BrainEngine, ids: number[]) => (await engine.executeRaw<{ id: number }>(
  'SELECT id FROM facts WHERE id = ANY($1::bigint[]) AND expired_at IS NULL ORDER BY id', [ids])).map(r => Number(r.id));

async function scenario(engine: BrainEngine, ctx: OperationContext, mode: 'direct' | 'expiry') {
  for (const [s, t] of [[ATOM, 'note'], [MEETING, 'meeting'], ['people/alice-example', 'person'], ['notes/kept-example', 'note']] as const) await put(ctx, s, t);
  const meetingId = await pageId(engine, MEETING);
  const legacy = await fact(engine, 'Example claim one from the atom', null, ATOM);
  const noted = await fact(engine, 'Example claim two from the atom', null, `${ATOM} — entity inferred from text`);
  const derived = await fact(engine, 'Alice Example joined a new team', 'people/alice-example', MEETING, { input: meetingId });
  const kept = await fact(engine, 'Kept example claim', null, 'notes/kept-example');
  const remembered = await fact(engine, 'A remembered example claim', null, ATOM, { source: 'mcp:remember' });
  for (const slug of [ATOM, MEETING]) {
    const live = await engine.readPageSnapshot(slug, { sourceId: 'default' });
    await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, source_id: 'default', request_id: randomUUID(), expected_revision: live!.revision } });
    if (mode === 'direct') {
      const snap = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
      await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, source_id: 'default', purge: true, request_id: randomUUID(), expected_revision: snap!.revision } });
    }
  }
  if (mode === 'expiry') await purgeDeletedPagesCoordinated(engine, 0);
  expect(await engine.readPageSnapshot(ATOM, { sourceId: 'default', includeDeleted: true })).toBeNull();
  expect(await engine.readPageSnapshot(MEETING, { sourceId: 'default', includeDeleted: true })).toBeNull();
  return { activeFacts: await active(engine, [legacy, noted, derived, kept, remembered]), ids: { legacy, noted, derived, kept, remembered } };
}

for (const backend of testBackends()) {
  describe(`#8859 purge takes context-linked facts (${backend})`, () => {
    const opts = backend === 'postgres' ? { databaseUrl: process.env.DATABASE_URL } : {};
    for (const mode of ['direct', 'expiry'] as const) {
      test(`${mode} purge`, () => managedBrain(async ({ engine, ctx }) => {
        const r = await scenario(engine, ctx, mode);
        expect(r.activeFacts).toEqual([r.ids.kept, r.ids.remembered]);
      }, opts), 180_000);
    }
  });
}
