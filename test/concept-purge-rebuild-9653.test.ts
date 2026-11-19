import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext, AuthInfo } from '../src/core/ops/contract.ts';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { purgeDeletedPagesCoordinated, rebuildNote, selectPurgeCandidates } from '../src/core/persistence/purge-deleted.ts';
import { disposePersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { REBUILD_LINK_COLUMNS, REBUILD_STORES, __setManagedConceptRebuildForTests } from '../src/core/persistence/concept-rebuild.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { __setMaintenanceWriteWaitForTests } from '../src/core/persistence/maintenance-wait.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import { runPages } from '../src/commands/pages.ts';
import { runMaintain } from '../src/commands/maintain.ts';
import { runCycle } from '../src/core/cycle.ts';
import { enableBeliefLedger } from '../src/core/belief/coverage.ts';
import { readEvents } from './helpers/belief-ledger.ts';
import * as originCarry from '../src/core/repair/origin-carry.ts';
import { parkDerivedOrigin, readDerivedOriginParks } from '../src/core/persistence/derived-origin-hold.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

// #9653: a concept hidden by an input purge is rebuilt by purging its tombstone and writing a fresh page at the slug from
// its current members. Synthetic data only.
const MODEL = 'anthropic:claude-sonnet-4-6';
const CONCEPT = 'concepts/storage-example';
const OLD = 'A narrative built from atoms';
const NEW = 'Rebuilt narrative canaryrebuilt.';
const atom = (i: number) => `atoms/storage-${i}`;
const members = (ids: number[]) => ids.map(i => ({ slug: atom(i), concept_refs: [CONCEPT], body: `Atom ${i} about storage.`, title: `storage atom ${i}`, visibility: 'world' as const }));
const reply = (text: string): ChatResult => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: MODEL, providerId: 'anthropic' });

afterEach(() => { installFaultHook(undefined); __setChatTransportForTests(null); });

async function put(ctx: OperationContext, slug: string, body: string, type = 'atom'): Promise<void> {
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: `---\ntitle: ${slug}\ntype: ${type}\nvisibility: world\n---\n${body}` } });
}
async function deletePage(engine: BrainEngine, ctx: OperationContext, slug: string): Promise<Record<string, unknown>> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
  return await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, expected_revision: snapshot!.revision, request_id: randomUUID() } }) as Record<string, unknown>;
}
async function unmanagedWhile<T>(engine: BrainEngine, on: boolean, fn: () => Promise<T>): Promise<T> {
  await disposePersistenceConsumer(engine);
  if (on) await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { return await fn(); } finally {
    if (on) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await disposePersistenceConsumer(engine);
  }
}
/** Moves a tombstone (and its rederive mark, which time moves with it) `hours` into the past. */
async function age(engine: BrainEngine, slug: string, hours = 100): Promise<void> {
  await unmanagedWhile(engine, true, async () => {
    await engine.executeRaw(`UPDATE needs_rederive n SET marked_at = n.marked_at - ($2 || ' hours')::interval FROM pages p
      WHERE n.derived_table='pages' AND n.derived_id=p.id::text AND p.source_id='default' AND p.slug=$1`, [slug, String(hours)]);
    await engine.executeRaw(`UPDATE pages SET deleted_at=deleted_at - ($2 || ' hours')::interval WHERE source_id='default' AND slug=$1`, [slug, String(hours)]);
  });
}
async function raw(engine: BrainEngine, sql: string, params: unknown[] = []): Promise<void> {
  await unmanagedWhile(engine, true, async () => { await engine.executeRaw(sql, params); });
}
/** What a member who is neither the owner nor a reader gets from get_page over the remote path. */
async function remoteRead(engine: BrainEngine): Promise<string> {
  const minted = await unmanagedWhile(engine, true, async () => {
    await engine.executeRaw("INSERT INTO access_members (id) VALUES ('bob-example') ON CONFLICT DO NOTHING");
    await engine.executeRaw("INSERT INTO access_members (id) VALUES ('owner-example') ON CONFLICT DO NOTHING");
    await setOwner(engine, 'owner-example');
    const token = await mintLegacyToken(engine, { name: `bob-${randomUUID().slice(0, 8)}`, scopes: ['read'], takesHolders: ['world'], sourceGrant: ['default'] });
    await bindCredential(engine, { kind: 'token', id: token.id }, { member: 'bob-example' });
    await engine.executeRaw(`UPDATE access_tokens SET private_pages = 'granted_sources' WHERE id = $1`, [token.id]);
    return token.token;
  });
  __resetPrivateVisibilityCacheForTests();
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const auth = await provider.verifyAccessToken(minted) as unknown as AuthInfo;
  const out = await dispatchToolCall(engine, 'get_page', { slug: CONCEPT }, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] });
  return out.content.map(c => c.text).join('\n');
}
async function printedJson(run: () => Promise<unknown>): Promise<Record<string, any>> {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { lines.push(parts.join(' ')); });
  try { await run(); } finally { log.mockRestore(); }
  return JSON.parse(lines.join('\n'));
}
async function purge(engine: BrainEngine, automatic: boolean): Promise<string[]> {
  return unmanagedWhile(engine, false, async () => (await purgeDeletedPagesCoordinated(engine, 72, { automatic })).slugs);
}
async function synthesize(engine: BrainEngine, root: string, ids: number[], opts: { text?: string; unmanaged?: boolean; during?: () => Promise<void>;
  read?: Record<string, string>; requests?: ChatOpts[]; settle?: boolean } = {}) {
  const chat = async (request: ChatOpts): Promise<ChatResult> => { opts.requests?.push(request); await opts.during?.(); return reply(opts.text ?? `${OLD} ${ids.join(', ')}.`); };
  const result = await unmanagedWhile(engine, !!opts.unmanaged, () => runPhaseSynthesizeConcepts(engine, { sourceId: 'default', brainDir: root,
    _atoms: members(ids).map(m => ({ ...m, revision: opts.read?.[m.slug] })), _chat: chat as never }));
  if (opts.settle !== false) await settleManagedGitEffects(engine);
  return result.details as Record<string, any>;
}
async function state(engine: BrainEngine) {
  const [row] = await engine.executeRaw<{ id: number | null; live: boolean | null; links_in: number; marks: number; versions: number; old_versions: number; old_chunks: number; old_journal: number; body: string | null }>(`SELECT
    (SELECT id FROM pages WHERE source_id='default' AND slug=$1) AS id,
    (SELECT deleted_at IS NULL FROM pages WHERE source_id='default' AND slug=$1) AS live,
    (SELECT compiled_truth FROM pages WHERE source_id='default' AND slug=$1) AS body,
    (SELECT count(*)::int FROM links l JOIN pages n ON n.id=l.from_page_id JOIN pages c ON c.id=l.to_page_id WHERE c.slug=$1 AND n.slug='notes/storage-ref') AS links_in,
    (SELECT count(*)::int FROM needs_rederive n JOIN pages c ON n.derived_id=c.id::text WHERE n.derived_table='pages' AND c.slug=$1) AS marks,
    (SELECT count(*)::int FROM page_versions v JOIN pages c ON c.id=v.page_id WHERE c.slug=$1) AS versions,
    (SELECT count(*)::int FROM page_versions WHERE compiled_truth LIKE '%' || $2 || '%') AS old_versions,
    (SELECT count(*)::int FROM content_chunks WHERE chunk_text LIKE '%' || $2 || '%') AS old_chunks,
    (SELECT count(*)::int FROM persistence_requests WHERE intent::text LIKE '%' || $2 || '%') AS old_journal`, [CONCEPT, OLD]);
  return row!;
}
/** A concept built from atoms 0 to 4 and rebuilt from 1 to 5; a note links to it; atom 0's purge hides it. */
async function heldConcept(engine: BrainEngine, ctx: OperationContext, root: string, live?: () => Promise<void>): Promise<number> {
  await engine.setConfig('models.dream.synthesize', MODEL);
  for (const i of [0, 1, 2, 3, 4, 5]) await put(ctx, atom(i), `Atom ${i} about storage.`);
  await synthesize(engine, root, [0, 1, 2, 3, 4]);
  await put(ctx, 'notes/storage-ref', 'See [[concepts/storage-example]] for the overview.', 'note');
  await deletePage(engine, ctx, atom(0));
  await age(engine, atom(0));
  await synthesize(engine, root, [1, 2, 3, 4, 5]);
  await live?.();
  expect(await purge(engine, true)).toEqual([atom(0)]);
  const held = await state(engine);
  expect(held).toMatchObject({ live: false, marks: 1, links_in: 1 });
  expect(held.versions).toBeGreaterThan(0);
  return Number(held.id);
}
const stillHeld = async (engine: BrainEngine, id: number, links = 1) => {
  const now = await state(engine);
  expect(now).toMatchObject({ id, live: false, marks: 1, links_in: links });
  expect(now.versions).toBeGreaterThan(0);
};

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`a concept hidden by an input purge is rebuilt as a fresh page (${backend})`, () => {
    beforeAll(() => __setManagedConceptRebuildForTests(true));
    afterAll(() => __setManagedConceptRebuildForTests(false));
    test('managed, without the write owner re-check: synthesis leaves the hidden concept exactly as it was and says why', async () => {
      __setManagedConceptRebuildForTests(false);
      try {
        await managedBrain(async ({ engine, ctx, root }) => {
          const id = await heldConcept(engine, ctx, root);
          const before = (await engine.readPageSnapshot(CONCEPT, { sourceId: 'default', includeDeleted: true }))!.revision;
          const requests: ChatOpts[] = [];
          const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, requests });
          expect(details.rebuilt).toEqual([]);
          expect(details.rebuild_kept).toEqual([{ source_id: 'default', slug: CONCEPT, reason: 'managed' }]);
          expect(requests).toHaveLength(0);
          await stillHeld(engine, id);
          expect((await engine.readPageSnapshot(CONCEPT, { sourceId: 'default', includeDeleted: true }))!.revision).toBe(before);
          const preview = (await selectPurgeCandidates(engine, 72, { automatic: true, model: true })).rebuild;
          expect(preview.kept).toEqual([{ source_id: 'default', slug: CONCEPT, reason: 'managed' }]);
          expect(rebuildNote(preview)).toContain(`default/${CONCEPT}: stays hidden, its rebuild on a managed brain waits for a later release`);
        }, { databaseUrl });
      } finally { __setManagedConceptRebuildForTests(true); }
    }, 300_000);

    for (const unmanaged of [false, true]) {
      const mode = unmanaged ? 'unmanaged' : 'managed';
      test(`${mode}: the tombstone is purged and a fresh page written; nothing of the old body reaches the model or stays`, async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          const id = await heldConcept(engine, ctx, root);
          const requests: ChatOpts[] = [];
          const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged, requests });
          expect(details.rebuilt).toEqual([CONCEPT]);
          expect(requests).toHaveLength(1);
          expect(JSON.stringify(requests[0]!.messages)).not.toContain(OLD);
          expect(JSON.stringify(requests[0]!.messages)).toContain('Atom 5 about storage.');
          const rebuilt = await state(engine);
          expect(rebuilt).toMatchObject({ live: true, marks: 0, old_versions: 0, old_chunks: 0 });
          expect(rebuilt.id).not.toBe(id);
          expect(rebuilt.body).toContain('canaryrebuilt');
          if (!unmanaged) expect(rebuilt.old_journal).toBe(0);
          expect(await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1 AND deleted_at IS NOT NULL', [CONCEPT])).toHaveLength(0);
          expect(await engine.executeRaw('SELECT 1 FROM page_purges WHERE slug=$1', [CONCEPT])).toHaveLength(0);
          // the incoming link: unmanaged in the rebuild's transaction; managed at the extract phase of the same cycle
          expect(rebuilt.links_in).toBe(unmanaged ? 1 : 0);
          if (!unmanaged) {
            await runCycle(engine, { brainDir: root, phases: ['extract'], sourceId: 'default' });
            expect((await state(engine)).links_in).toBe(1);
          }
        }, { databaseUrl });
      }, 300_000);

      if (unmanaged) test('unmanaged, belief ledger on: the rebuild ends the old page as page.expired and the fresh page starts its own lifetime', async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          await heldConcept(engine, ctx, root);
          await enableBeliefLedger(engine, 'default');
          const after = Math.max(0, ...(await readEvents(engine, 'default')).map(e => e.id));
          expect((await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged: true })).rebuilt).toEqual([CONCEPT]);
          const events = (await readEvents(engine, 'default', after)).filter(e => e.slug === CONCEPT && e.subject_kind === 'page');
          const expired = events.find(e => e.event_type === 'page.expired');
          expect(expired?.purged).toBe(false);
          expect(events.filter(e => e.page_lifetime !== expired!.page_lifetime).length).toBeGreaterThan(0);
        }, { databaseUrl });
      }, 300_000);

      if (unmanaged) test('unmanaged, belief ledger on: a member that left gets its provenance edge retracted, never carried to the fresh page', async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          await heldConcept(engine, ctx, root);
          await enableBeliefLedger(engine, 'default');
          const after = Math.max(0, ...(await readEvents(engine, 'default')).map(e => e.id));
          expect((await synthesize(engine, root, [1, 2, 3, 4], { text: NEW, unmanaged: true })).rebuilt).toEqual([CONCEPT]);
          const left = (await readEvents(engine, 'default', after)).filter(e => e.slug === atom(5) && e.subject_kind === 'link');
          expect(await engine.executeRaw(`SELECT 1 FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
            WHERE f.slug = $1 AND t.slug = $2 AND l.link_source = 'concept-provenance'`, [atom(5), CONCEPT])).toHaveLength(0);
          expect(left.map(e => e.event_type)).toEqual(['link.retracted']);
        }, { databaseUrl });
      }, 300_000);

      if (unmanaged) test('unmanaged: a park the rebuild writes for a dependent survives its refusal', async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          const id = await heldConcept(engine, ctx, root);
          const spy = spyOn(originCarry, 'parkUncarriedInPurge').mockImplementation(async (tx, ids) => {
            const park = { source_id: 'default', slug: CONCEPT, page_id: Number(ids[0]), blocking_slug: 'notes/storage-ref', code: 'dependent_written_mid_purge', reason: 'notes/storage-ref depends on it.' };
            await parkDerivedOrigin(tx, park);
            return [{ ...park, parked_at: new Date().toISOString() }];
          });
          try {
            expect((await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged: true })).rebuilt).toEqual([]);
          } finally { spy.mockRestore(); }
          await stillHeld(engine, id);
          expect((await readDerivedOriginParks(engine)).map(p => p.page_id)).toEqual([id]);
        }, { databaseUrl });
      }, 300_000);

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

      if (unmanaged) test('unmanaged: an incoming link keeps every column it had, pointed at the fresh page', async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          const id = await heldConcept(engine, ctx, root);
          const pick = "SELECT l.link_type, l.context, l.link_source, l.link_kind, l.origin_field, l.resolution_type, l.assertion_tense, l.created_at::text AS created_at, o.slug AS origin FROM links l JOIN pages n ON n.id = l.from_page_id JOIN pages c ON c.id = l.to_page_id LEFT JOIN pages o ON o.id = l.origin_page_id WHERE n.slug = 'notes/storage-ref' AND c.slug = $1";
          await raw(engine, "UPDATE links SET link_kind = 'typed_ner', resolution_type = 'qualified', assertion_tense = 'past' WHERE to_page_id = $1", [id]);
          const before = await engine.executeRaw(pick, [CONCEPT]);
          expect(before).toHaveLength(1);
          expect((await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged: true })).rebuilt).toEqual([CONCEPT]);
          expect(await engine.executeRaw(pick, [CONCEPT])).toEqual(before);
        }, { databaseUrl });
      }, 300_000);

      test(`${mode}: a failed synthesis leaves it hidden and held`, async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          const id = await heldConcept(engine, ctx, root);
          const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: '', unmanaged });
          expect(details.rebuild_deferred.map((d: { concept: string }) => d.concept)).toEqual([CONCEPT]);
          await stillHeld(engine, id);
        }, { databaseUrl });
      }, 300_000);

      test(`${mode}: during the model call, a person's delete, a released hold or a second input purge writes nothing`, async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          await heldConcept(engine, ctx, root);
          const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged, during: async () => { await deletePage(engine, ctx, CONCEPT); } });
          expect(details.rebuilt).toEqual([]);
          expect(await state(engine)).toMatchObject({ live: false });
          expect(await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1 AND compiled_truth LIKE $2', [CONCEPT, '%canaryrebuilt%'])).toHaveLength(0);
        }, { databaseUrl });
        await managedBrain(async ({ engine, ctx, root }) => {
          await heldConcept(engine, ctx, root);
          await age(engine, CONCEPT);
          await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged, during: async () => { expect(await purge(engine, false)).toEqual([CONCEPT]); } });
          expect(await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1 AND compiled_truth LIKE $2', [CONCEPT, '%canaryrebuilt%'])).toHaveLength(0);
        }, { databaseUrl });
        await managedBrain(async ({ engine, ctx, root }) => {
          const id = await heldConcept(engine, ctx, root);
          const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged, during: async () => {
            await deletePage(engine, ctx, atom(1));
            await age(engine, atom(1));
            expect(await purge(engine, true)).toEqual([atom(1)]);
          } });
          expect(details.rebuilt).toEqual([]);
          expect(await state(engine)).toMatchObject({ id, live: false, marks: 1 });
          expect((await synthesize(engine, root, [2, 3, 4, 5], { text: NEW, unmanaged })).rebuilt).toEqual([CONCEPT]);
        }, { databaseUrl });
      }, 900_000);

      test(`${mode}: a folder rule still covers the fresh page and a remote non-owner reads nothing`, async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          await heldConcept(engine, ctx, root, () => unmanagedWhile(engine, true, async () => {
            const rule = await proposeRevision(engine, 'default', [{ id: 'concepts', prefix: 'concepts/', readable_by: ['member:alice-example'] }], { origin: 'cli', store: 'database' });
            expect(rule.state).toBe('applied');
          }));
          const [before] = await engine.executeRaw<{ rules: string[] | null }>('SELECT folder_rule_ids AS rules FROM pages WHERE slug=$1', [CONCEPT]);
          expect(before!.rules).not.toBeNull();
          expect((await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged })).rebuilt).toEqual([CONCEPT]);
          const [after] = await engine.executeRaw<{ rules: string[] | null }>('SELECT folder_rule_ids AS rules FROM pages WHERE slug=$1', [CONCEPT]);
          expect(after!.rules).toEqual(before!.rules);
          expect(await remoteRead(engine)).not.toContain('canaryrebuilt');
        }, { databaseUrl });
      }, 600_000);

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
    }

    test('access: a hidden concept no caller could read stays hidden when its current members are all world-readable', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        const id = await heldConcept(engine, ctx, root);
        await raw(engine, "UPDATE pages SET frontmatter = frontmatter || '{\"visibility\":\"private\"}'::jsonb WHERE id = $1", [id]);
        const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW });
        expect(details.rebuild_kept).toMatchObject([{ slug: CONCEPT, reason: 'access' }]);
        await stillHeld(engine, id);
      }, { databaseUrl });
    }, 300_000);

    test('managed: the publish waits on the purge receipt; a pending purge writes nothing more this cycle and the next one recovers', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await heldConcept(engine, ctx, root);
        let release!: () => void;
        const stalled = new Promise<void>(resolve => { release = resolve; });
        installFaultHook(async (point, detail) => { if (point === 'consumer:prepared' && (detail as { operation?: string }).operation === 'delete_page') await stalled; });
        const restore = __setMaintenanceWriteWaitForTests(300);
        try {
          const details = (await runPhaseSynthesizeConcepts(engine, { sourceId: 'default', brainDir: root, _atoms: members([1, 2, 3, 4, 5]), _chat: (async () => reply(NEW)) as never })).details as Record<string, any>;
          expect(details.rebuilt).toEqual([]);
          expect(details.rebuild_deferred).toMatchObject([{ concept: CONCEPT }]);
          expect(details.rebuild_deferred[0].reason).toContain('still pending');
          expect(await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1 AND deleted_at IS NULL', [CONCEPT])).toHaveLength(0);
        } finally { release(); restore(); installFaultHook(undefined); }
        const open = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id='default' AND state NOT IN ('committed','failed','cancelled')");
        for (const row of open) await waitForWrite(engine, row, { engine: engine.kind }, 20_000);
        await settleManagedGitEffects(engine);
        await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW });
        const recovered = await state(engine);
        expect(recovered).toMatchObject({ live: true, old_versions: 0, old_chunks: 0 });
        expect(recovered.body).toContain('canaryrebuilt');
      }, { databaseUrl });
    }, 600_000);

    test('managed: a person who restores, edits or deletes the tombstone before the purge is submitted refuses it', async () => {
      const moves: Array<(engine: BrainEngine, ctx: OperationContext) => Promise<void>> = [
        async (_engine, ctx) => { await submitPageMutation(ctx, { operation: 'restore_page', params: { slug: CONCEPT, request_id: randomUUID() } }); },
        async (engine, ctx) => {
          const at = await engine.readPageSnapshot(CONCEPT, { sourceId: 'default', includeDeleted: true });
          await submitPageMutation(ctx, { operation: 'put_page', params: { slug: CONCEPT, request_id: randomUUID(), expected_revision: at!.revision,
            content: '---\ntitle: storage example\ntype: concept\n---\nWritten by a person.' } });
        },
        async (engine, ctx) => { await deletePage(engine, ctx, CONCEPT); },
      ];
      for (const move of moves) await managedBrain(async ({ engine, ctx, root }) => {
        await heldConcept(engine, ctx, root);
        const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, during: () => move(engine, ctx) });
        expect(details.rebuilt).toEqual([]);
        expect(await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1 AND compiled_truth LIKE $2', [CONCEPT, '%canaryrebuilt%'])).toHaveLength(0);
        expect(await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1', [CONCEPT])).toHaveLength(1);
      }, { databaseUrl });
    }, 900_000);

    test('the single-page purge deletes exactly what the cutoff purge deletes', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        const slugs = ['notes/purge-a', 'notes/purge-b'];
        for (const slug of slugs) {
          await put(ctx, slug, `Body of ${slug} with [[notes/purge-other]].`, 'note');
          const at = await engine.readPageSnapshot(slug, { sourceId: 'default' });
          await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), expected_revision: at!.revision,
            content: `---\ntitle: ${slug}\ntype: note\nvisibility: world\n---\nSecond body of ${slug} with [[notes/purge-other]].` } });
        }
        await put(ctx, 'notes/purge-other', 'Links to [[notes/purge-a]] and [[notes/purge-b]].', 'note');
        await unmanagedWhile(engine, true, async () => {
          for (const slug of slugs) {
            const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [slug]);
            await engine.executeRaw("INSERT INTO tags (page_id, tag) VALUES ($1, 't')", [page!.id]);
            await engine.executeRaw("INSERT INTO timeline_entries (page_id, date, summary) VALUES ($1, '2026-01-01', 'e')", [page!.id]);
            await engine.executeRaw("INSERT INTO facts (source_id, fact, source, source_markdown_slug) VALUES ('default', $2, 'test', $1)", [slug, `A fact on ${slug}.`]);
            await engine.executeRaw("INSERT INTO page_aliases (source_id, slug, alias_norm) VALUES ('default', $1, $2)", [slug, `alias ${slug}`]);
            await engine.executeRaw("INSERT INTO open_loops (source_id, page_slug, kind, summary) VALUES ('default', $1, 'promise', 'x')", [slug]).catch(() => undefined);
          }
        });
        await raw(engine, "UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE source_id = 'default' AND slug = ANY($1::text[])", [slugs]);
        const counts = async (slug: string) => (await engine.executeRaw<Record<string, number>>(`SELECT
          (SELECT count(*)::int FROM pages WHERE slug=$1) AS pages,
          (SELECT count(*)::int FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.slug=$1) AS chunks,
          (SELECT count(*)::int FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.slug=$1) AS versions,
          (SELECT count(*)::int FROM links l JOIN pages p ON p.id IN (l.from_page_id, l.to_page_id) WHERE p.slug=$1) AS links,
          (SELECT count(*)::int FROM facts WHERE source_markdown_slug=$1 AND expired_at IS NULL) AS live_facts,
          (SELECT count(*)::int FROM page_aliases WHERE slug=$1) AS aliases,
          (SELECT count(*)::int FROM open_loops WHERE page_slug=$1) AS loops`, [slug]))[0]!;
        const before = [await counts(slugs[0]!), await counts(slugs[1]!)];
        expect(before[0]).toEqual(before[1]!);
        expect(before[0]!.versions).toBeGreaterThan(0);
        await unmanagedWhile(engine, true, async () => {
          const [a] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug=$1", [slugs[0]]);
          expect((await engine.purgeDeletedPages(0, { onlyIds: [Number(a!.id)] })).slugs).toEqual([slugs[0]!]);
          expect(await counts(slugs[1]!)).toEqual(before[1]!);
          expect((await engine.purgeDeletedPages(72)).slugs).toEqual([slugs[1]!]);
        });
        expect(await counts(slugs[0]!)).toEqual(await counts(slugs[1]!));
        expect((await counts(slugs[0]!)).pages).toBe(0);
      }, { databaseUrl });
    }, 300_000);

    test('every column of links and of the rewritten page, and every table keyed to a page, is carried, regenerated or held on by the rebuild', async () => {
      const PAGE_COLUMNS: Record<string, 'held' | 'regenerated'> = Object.fromEntries([
        ...['title', 'compiled_truth', 'timeline', 'frontmatter', 'source_path', 'source_uri', 'withheld_source_path', 'page_readers', 'folder_rule_ids',
          'body_storage', 'truth_lead', 'timeline_lead'].map(c => [c, 'held'] as const),
        ...['id', 'source_id', 'slug', 'type', 'page_kind', 'content_hash', 'emotional_weight', 'created_at', 'updated_at', 'deleted_at', 'effective_date',
          'effective_date_source', 'import_filename', 'salience_touched_at', 'last_retrieved_at', 'links_extracted_at', 'database_only_reason',
          'contextual_retrieval_mode', 'corpus_generation', 'generation', 'search_vector', 'knowledge_revision', 'text_projection_revision',
          'emotional_weight_recomputed_at', 'chunker_version', 'ingested_via', 'ingested_at', 'source_kind', 'embedding_signature',
          'links_attendance_blocked_revision', 'links_attendance_blocked_at', 'revision_write_request_id', 'revision_principal_kind',
          'revision_principal_id', 'trust_tier', 'write_origin', 'body_bytes', 'truth_bytes', 'body_lines', 'body_generation', 'segment_count',
          'segmenter_version', 'body_flags', 'links_extract_failure', 'version_history_gap_at'].map(c => [c, 'regenerated'] as const),
      ]);
      const PAGE_TABLES: Record<string, 'held' | 'regenerated'> = Object.fromEntries([
        ...['files', 'link_edge_proposals', 'link_transitions', 'links', 'page_label_guards', 'raw_data', 'tags', 'takes', 'timeline_entries',
          'entity_identities', 'guest_marks', 'guest_promotions'].map(t => [t, 'held'] as const),
        ...['chronicle_page_state', 'content_chunks', 'extract_atoms_page_state', 'link_relationships', 'page_body_manifest', 'page_body_stagings',
          'page_derivation_spend', 'page_embedding_budget', 'page_extraction_state', 'page_facts_reconcile', 'page_mention_state',
          'page_segment_derivations', 'page_versions', 'page_view_digests', 'secret_store_occurrence', 'synthesis_evidence', 'wanted_links'].map(t => [t, 'regenerated'] as const),
      ]);
      await managedBrain(async ({ engine }) => {
        const columns = async (table: string) => (await engine.executeRaw<{ c: string }>("SELECT column_name AS c FROM information_schema.columns WHERE table_name = $1 AND table_schema = current_schema()", [table])).map(r => r.c).sort();
        expect(await columns('links')).toEqual(Object.keys(REBUILD_LINK_COLUMNS).sort());
        expect(await columns('pages')).toEqual(Object.keys(PAGE_COLUMNS).sort());
        const tables = (await engine.executeRaw<{ t: string }>("SELECT DISTINCT conrelid::regclass::text AS t FROM pg_constraint WHERE confrelid = 'pages'::regclass AND contype = 'f'")).map(r => r.t).sort();
        expect(tables).toEqual(Object.keys(PAGE_TABLES).sort());
      }, { databaseUrl });
    }, 120_000);

    test('every store a page purge removes rows from is classified stated or derived', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await heldConcept(engine, ctx, root);
        const snapshot = await engine.readPageSnapshot(CONCEPT, { sourceId: 'default', includeDeleted: true });
        const receipt = await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: CONCEPT, purge: true, expected_revision: snapshot!.revision, request_id: randomUUID() } }) as { purge: { removed: Record<string, number> } };
        for (const store of Object.keys(receipt.purge.removed)) expect([store, REBUILD_STORES[store]]).toEqual([store, expect.stringMatching(/^(stated|derived)$/)]);
      }, { databaseUrl });
    }, 300_000);

    test('a concept a person deleted stays deleted, also after an input purge marks it', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await engine.setConfig('models.dream.synthesize', MODEL);
        for (const i of [0, 1, 2, 3, 4]) await put(ctx, atom(i), `Atom ${i} about storage.`);
        await synthesize(engine, root, [0, 1, 2, 3, 4]);
        await deletePage(engine, ctx, CONCEPT);
        await deletePage(engine, ctx, atom(0));
        await age(engine, atom(0));
        expect(await purge(engine, true)).toEqual([atom(0)]);
        const details = await synthesize(engine, root, [1, 2, 3, 4], { text: NEW });
        expect(details.skipped_deleted).toEqual([CONCEPT]);
        expect(await state(engine)).toMatchObject({ live: false });
      }, { databaseUrl });
    }, 300_000);

    test('a held concept a person then deletes stays deleted', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await heldConcept(engine, ctx, root);
        await deletePage(engine, ctx, CONCEPT);
        const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW });
        expect(details.skipped_deleted).toEqual([CONCEPT]);
        expect(await state(engine)).toMatchObject({ live: false });
      }, { databaseUrl });
    }, 300_000);

    test('the purge previews name each held concept and, for one kept hidden, why', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        const id = await heldConcept(engine, ctx, root);
        const held = [{ source_id: 'default', slug: CONCEPT }];
        expect((await selectPurgeCandidates(engine, 72, { automatic: true, model: false })).rebuild).toEqual({ held, kept: [{ ...held[0]!, reason: 'no_model' }] });
        __setChatTransportForTests(async () => reply(NEW));
        for (const automatic of [true, false]) expect((await selectPurgeCandidates(engine, 72, { automatic, model: true })).rebuild).toEqual({ held, kept: [] });
        const note = rebuildNote({ held, kept: [] });
        expect(note).toContain(`1 of them are rebuilt by the next concept synthesis that still finds at least two members for them (one with fewer stays hidden until an explicit purge): default/${CONCEPT}`);
        const explicit = await printedJson(() => runPages(engine, ['purge-deleted', '--dry-run', '--json']));
        expect(explicit).toMatchObject({ rebuild: { held } });
        expect(explicit.rebuild_note).toEndWith('This purge removes any of them listed above instead.');
        const automatic = await printedJson(() => runMaintain(engine, ['--purge', '--json']));
        expect(automatic).toMatchObject({ mode: 'preview', rebuild: { held }, rebuild_note: note });
        await raw(engine, "INSERT INTO tags (page_id, tag) VALUES ($1, 'hand-tag')", [id]);
        const kept = (await selectPurgeCandidates(engine, 72, { automatic: true, model: true })).rebuild;
        expect(kept.kept).toEqual([{ ...held[0]!, reason: 'stated', kinds: ['tags'] }]);
        expect(rebuildNote(kept)).toContain(`default/${CONCEPT}: stays hidden, it carries what a person or an agent stated (tags)`);
        const phase = (await runCycle(engine, { brainDir: root, phases: ['purge'], sourceId: 'default' })).phases.find(p => p.phase === 'purge')!;
        expect(phase.details).toMatchObject({ purged_pages_kept_for_rebuild: held, kept_hidden: kept.kept });
        expect(phase.summary).toContain('1 concept(s) hidden by an input purge kept for the next concept synthesis (1 of them stay hidden');
        expect(await state(engine)).toMatchObject({ live: false, marks: 1 });
      }, { databaseUrl });
    }, 300_000);

    for (const aged of [100, 10]) test(`deleting a held concept aged ${aged}h: the receipt states the true expiry and the tombstone keeps its date`, async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await heldConcept(engine, ctx, root);
        await age(engine, CONCEPT, aged);
        const [before] = await engine.executeRaw<{ at: string; until: string }>(`SELECT deleted_at::text AS at,
          to_char((deleted_at + interval '72 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS until FROM pages WHERE slug=$1`, [CONCEPT]);
        const receipt = await deletePage(engine, ctx, CONCEPT);
        const [after] = await engine.executeRaw<{ at: string }>('SELECT deleted_at::text AS at FROM pages WHERE slug=$1', [CONCEPT]);
        expect(after!.at).toBe(before!.at);
        expect(String(receipt.recoverable_until)).toStartWith(aged > 72 ? `the next purge (its 72h window ended ${before!.until})` : `${before!.until} via restore_page`);
        expect(await purge(engine, true)).toEqual(aged > 72 ? [CONCEPT] : []);
      }, { databaseUrl });
    }, 300_000);
  });
}
