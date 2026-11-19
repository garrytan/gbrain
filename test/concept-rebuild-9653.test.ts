import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { purgeDeletedPagesCoordinated, rebuildNote, selectPurgeCandidates } from '../src/core/persistence/purge-deleted.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { beginConceptRevive, heldConceptRevive } from '../src/core/persistence/concept-revive.ts';
import { publishClassicConcept } from '../src/core/cycle/concept-publication.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { runPages } from '../src/commands/pages.ts';
import { runMaintain } from '../src/commands/maintain.ts';
import { runCycle } from '../src/core/cycle.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

// #9653 (PR 2): a concept the input purge hid is rebuilt from its current members by the next synthesis, as a first
// publication over the same row. Synthetic data only.
const MODEL = 'anthropic:claude-sonnet-4-6';
const CONCEPT = 'concepts/storage-example';
const OLD = 'A narrative built from atoms';
const NEW = 'Rebuilt narrative canaryrebuilt.';
const atom = (i: number) => `atoms/storage-${i}`;
const members = (ids: number[]) => ids.map(i => ({ slug: atom(i), concept_refs: [CONCEPT], body: `Atom ${i} about storage.`, title: `storage atom ${i}` }));
const reply = (text: string): ChatResult => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: MODEL, providerId: 'anthropic' });

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
async function printedJson(run: () => Promise<unknown>): Promise<Record<string, any>> {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { lines.push(parts.join(' ')); });
  try { await run(); } finally { log.mockRestore(); }
  return JSON.parse(lines.join('\n'));
}
async function purge(engine: BrainEngine, automatic: boolean): Promise<string[]> {
  return unmanagedWhile(engine, false, async () => (await purgeDeletedPagesCoordinated(engine, 72, { automatic })).slugs);
}
async function synthesize(engine: BrainEngine, root: string, ids: number[], opts: { text?: string; unmanaged?: boolean; during?: () => Promise<void>; read?: Record<string, string> } = {}) {
  const chat = async (): Promise<ChatResult> => { await opts.during?.(); return reply(opts.text ?? `${OLD} ${ids.join(', ')}.`); };
  const result = await unmanagedWhile(engine, !!opts.unmanaged, () => runPhaseSynthesizeConcepts(engine, { sourceId: 'default', brainDir: root,
    _atoms: members(ids).map(m => ({ ...m, revision: opts.read?.[m.slug] })), _chat: chat }));
  await settleManagedGitEffects(engine);
  return result.details as Record<string, unknown>;
}
async function state(engine: BrainEngine) {
  const [row] = await engine.executeRaw<{ id: number; live: boolean; links_in: number; marks: number; versions: number; old_versions: number; old_chunks: number; body: string }>(`SELECT p.id, p.deleted_at IS NULL AS live, p.compiled_truth AS body,
    (SELECT count(*)::int FROM links l JOIN pages n ON n.id=l.from_page_id WHERE l.to_page_id=p.id AND n.slug='notes/storage-ref') AS links_in,
    (SELECT count(*)::int FROM needs_rederive WHERE derived_table='pages' AND derived_id=p.id::text) AS marks,
    (SELECT count(*)::int FROM page_versions WHERE page_id=p.id) AS versions,
    (SELECT count(*)::int FROM page_versions WHERE page_id=p.id AND compiled_truth LIKE '%' || $2 || '%') AS old_versions,
    (SELECT count(*)::int FROM content_chunks WHERE page_id=p.id AND chunk_text LIKE '%' || $2 || '%') AS old_chunks
    FROM pages p WHERE p.source_id='default' AND p.slug=$1`, [CONCEPT, OLD]);
  return row!;
}
/** A concept built from atoms 0 to 4 and rebuilt from 1 to 5; a note links to it; atom 0's purge hides it. */
async function heldConcept(engine: BrainEngine, ctx: OperationContext, root: string): Promise<number> {
  await engine.setConfig('models.dream.synthesize', MODEL);
  for (const i of [0, 1, 2, 3, 4, 5]) await put(ctx, atom(i), `Atom ${i} about storage.`);
  await synthesize(engine, root, [0, 1, 2, 3, 4]);
  await put(ctx, 'notes/storage-ref', 'See [[concepts/storage-example]] for the overview.', 'note');
  await deletePage(engine, ctx, atom(0));
  await age(engine, atom(0));
  await synthesize(engine, root, [1, 2, 3, 4, 5]);
  expect(await purge(engine, true)).toEqual([atom(0)]);
  const held = await state(engine);
  expect(held).toMatchObject({ live: false, marks: 1, links_in: 1 });
  expect(held.versions).toBeGreaterThan(0);
  return held.id;
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`a concept hidden by an input purge is rebuilt (${backend})`, () => {
    for (const unmanaged of [false, true]) {
      const mode = unmanaged ? 'unmanaged' : 'managed';
      test(`${mode}: same id, slug and incoming links; no old version or chunk; the mark clears`, async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          const id = await heldConcept(engine, ctx, root);
          const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged });
          expect(details.rebuilt).toEqual([CONCEPT]);
          const rebuilt = await state(engine);
          expect(rebuilt).toMatchObject({ id, live: true, links_in: 1, marks: 0, old_versions: 0, old_chunks: 0 });
          expect(rebuilt.body).toContain('canaryrebuilt');
          expect(rebuilt.body).not.toContain(OLD);
          const [journal] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE slug=$1 AND intent::text LIKE '%' || $2 || '%'", [CONCEPT, OLD]);
          if (!unmanaged) expect(journal!.n).toBe(0);
          const tombstoneUs = await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1 AND deleted_at IS NOT NULL', [CONCEPT]);
          expect(tombstoneUs.length).toBe(0);
        }, { databaseUrl });
      }, 300_000);

      test(`${mode}: a failed synthesis leaves it hidden and held`, async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          await heldConcept(engine, ctx, root);
          const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: '', unmanaged });
          expect(details.rebuild_deferred).toEqual([CONCEPT]);
          expect(await state(engine)).toMatchObject({ live: false, marks: 1 });
        }, { databaseUrl });
      }, 300_000);

      test(`${mode}: re-checked at commit: an explicit purge, a released hold or a second input purge during the call writes nothing`, async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          await heldConcept(engine, ctx, root);
          // a person deletes the held concept while the model runs: the hold ends, nothing is written
          await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged, during: async () => { await deletePage(engine, ctx, CONCEPT); } });
          expect(await state(engine)).toMatchObject({ live: false });
          expect((await state(engine)).body).not.toContain('canaryrebuilt');
          const [again] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE slug=$1", [CONCEPT]);
          expect(again!.n).toBe(1);
        }, { databaseUrl });
        await managedBrain(async ({ engine, ctx, root }) => {
          await heldConcept(engine, ctx, root);
          await age(engine, CONCEPT);
          await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged, during: async () => { expect(await purge(engine, false)).toEqual([CONCEPT]); } });
          const [row] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE slug=$1 AND compiled_truth LIKE $2', [CONCEPT, '%canaryrebuilt%']);
          expect(row!.n).toBe(0);
        }, { databaseUrl });
        await managedBrain(async ({ engine, ctx, root }) => {
          await heldConcept(engine, ctx, root);
          await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged, during: async () => {
            await deletePage(engine, ctx, atom(1));
            await age(engine, atom(1));
            expect(await purge(engine, true)).toEqual([atom(1)]);
          } });
          expect(await state(engine)).toMatchObject({ live: false, marks: 1 });
          expect((await state(engine)).body).not.toContain('canaryrebuilt');
          // the next cycle builds it from the members it has now
          const details = await synthesize(engine, root, [2, 3, 4, 5], { text: NEW, unmanaged });
          expect(details.rebuilt).toEqual([CONCEPT]);
        }, { databaseUrl });
      }, 900_000);

      test(`${mode}: a member rewritten after its body was read for the narrative writes nothing`, async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          await heldConcept(engine, ctx, root);
          const read = Object.fromEntries((await engine.executeRaw<{ slug: string; revision: string }>(
            "SELECT slug, knowledge_revision::text AS revision FROM pages WHERE source_id='default' AND slug LIKE 'atoms/%' AND deleted_at IS NULL")).map(r => [r.slug, r.revision]));
          const at = await engine.readPageSnapshot(atom(2), { sourceId: 'default' });
          await submitPageMutation(ctx, { operation: 'put_page', params: { slug: atom(2), request_id: randomUUID(), expected_revision: at!.revision,
            content: `---\ntitle: ${atom(2)}\ntype: atom\nvisibility: world\n---\nAtom 2, rewritten.` } });
          const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged, read });
          expect(details.rebuilt ?? []).toEqual([]);
          expect(await state(engine)).toMatchObject({ live: false, marks: 1 });
          expect((await state(engine)).versions).toBeGreaterThan(0);
          expect((await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged })).rebuilt).toEqual([CONCEPT]);
        }, { databaseUrl });
      }, 600_000);
    }

    test('unmanaged: an import that refuses the rebuilt page without throwing rolls the rebuild back and keeps the hold', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await heldConcept(engine, ctx, root);
        await unmanagedWhile(engine, true, async () => {
          const snapshot = await engine.readPageSnapshot(CONCEPT, { sourceId: 'default', includeDeleted: true });
          const revive = await heldConceptRevive(engine, 'default', snapshot!, [1, 2, 3, 4, 5].map(atom));
          expect(revive).not.toBeNull();
          const publication = publishClassicConcept(engine, CONCEPT, 'default', { type: 'concept', synthesized_by: 'synthesize_concepts' }, NEW, '',
            { writeThrough: false, revive: revive!, importPage: async () => ({ slug: CONCEPT, status: 'error', chunks: 0 }) });
          await expect(publication).rejects.toMatchObject({ code: 'revision_conflict' });
        });
        const held = await state(engine);
        expect(held).toMatchObject({ live: false, marks: 1, links_in: 1 });
        expect(held.versions).toBeGreaterThan(0);
        expect(await purge(engine, true)).toEqual([]);
      }, { databaseUrl });
    }, 300_000);

    test('the publication re-checks the hold and the members under the lock: each race refuses and clears nothing', async () => {
      const races: Array<(engine: BrainEngine, ctx: OperationContext) => Promise<void>> = [
        async (engine, ctx) => { await deletePage(engine, ctx, CONCEPT); },
        async (engine, ctx) => {
          const at = await engine.readPageSnapshot(atom(2), { sourceId: 'default' });
          await submitPageMutation(ctx, { operation: 'put_page', params: { slug: atom(2), request_id: randomUUID(), expected_revision: at!.revision,
            content: `---\ntitle: ${atom(2)}\ntype: atom\nvisibility: world\n---\nAtom 2, rewritten.` } });
        },
        async (engine, ctx) => { await deletePage(engine, ctx, atom(1)); await age(engine, atom(1)); expect(await purge(engine, true)).toEqual([atom(1)]); },
      ];
      for (const race of races) await managedBrain(async ({ engine, ctx, root }) => {
        await heldConcept(engine, ctx, root);
        const snapshot = await engine.readPageSnapshot(CONCEPT, { sourceId: 'default', includeDeleted: true });
        const revive = await heldConceptRevive(engine, 'default', snapshot!, [1, 2, 3, 4, 5].map(atom));
        expect(revive).not.toBeNull();
        await race(engine, ctx);
        const refused = await engine.transaction(tx => beginConceptRevive(tx, 'default', CONCEPT, revive!, { journal: false }));
        expect(refused).toBeString();
        expect((await state(engine)).versions).toBeGreaterThan(0);
      }, { databaseUrl });
    }, 600_000);

    test('owner-only lineage holds after the rebuild and the input\'s hard purge: a member who is not the owner reads nothing', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        const tokens: Record<string, string> = {};
        await unmanagedWhile(engine, true, async () => {
          __resetPrivateVisibilityCacheForTests();
          await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('messages-a', 'messages-a', '{"kind":"imessage","federated":true}'::jsonb)`);
          await importFromContent(engine, 'imessage/chat/2026-06-14', '---\ntype: note\ntitle: Chat\n---\nprivate chat canarychat', { sourceId: 'messages-a', noEmbed: true });
          for (const member of ['owner-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [member]);
          for (const [name, member] of [['owner', 'owner-example'], ['bob', 'bob-example']] as const) {
            const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: ['default', 'messages-a'] });
            tokens[name] = minted.token;
            await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
          }
          await engine.executeRaw(`UPDATE access_tokens SET private_pages = 'granted_sources', private_facts = 'granted_sources'`);
          await setOwner(engine, 'owner-example');
        });
        const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
        const read = async (who: string, op: string, params: Record<string, unknown>): Promise<string> => {
          const auth = await provider.verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
          const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, 'default');
          const out = await dispatchToolCall(engine, op, params, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'], ...(localFederated ? { localFederatedSourceIds: localFederated } : {}) });
          return out.content.map(c => c.text).join('\n');
        };
        await engine.setConfig('models.dream.synthesize', MODEL);
        for (const i of [0, 1, 2, 3, 4, 5]) await put(ctx, atom(i), `Atom ${i} about storage.`);
        const [chat] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='messages-a'");
        const [atom0] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [atom(0)]);
        await engine.executeRaw(`INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id) VALUES ('pages', $1, 'pages', $2, 'default')`, [String(atom0!.id), String(chat!.id)]);
        await synthesize(engine, root, [0, 1, 2, 3, 4]);
        await put(ctx, 'notes/storage-ref', 'See [[concepts/storage-example]] for the overview.', 'note');
        await deletePage(engine, ctx, atom(0));
        await age(engine, atom(0));
        expect(await purge(engine, true)).toEqual([atom(0)]);
        expect((await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW })).rebuilt).toEqual([CONCEPT]);
        const { id } = await state(engine);
        const [lineage] = await engine.executeRaw<{ v: boolean }>("SELECT gbrain_owner_only_lineage('pages', $1::bigint) AS v", [id]);
        expect(lineage!.v).toBe(true);
        expect(await read('owner', 'get_page', { slug: CONCEPT })).toContain('canaryrebuilt');
        expect(await read('owner', 'search', { query: 'Rebuilt narrative' })).toContain(CONCEPT);
        for (const [op, params] of [['get_page', { slug: CONCEPT }], ['search', { query: 'Rebuilt narrative' }], ['recall', { query: 'Rebuilt narrative' }],
          ['get_versions', { slug: CONCEPT, include_body: true }]] as const) {
          const seen = await read('bob', op, { ...params });
          expect(seen).not.toContain('canaryrebuilt');
          if (op === 'search' || op === 'recall') expect(seen).not.toContain(CONCEPT);
        }
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

    test('the purge previews name the concepts the next synthesis rebuilds', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await heldConcept(engine, ctx, root);
        for (const automatic of [true, false]) {
          const selection = await selectPurgeCandidates(engine, 72, { automatic });
          expect(selection.rebuild).toEqual([{ source_id: 'default', slug: CONCEPT }]);
        }
        const note = rebuildNote([{ source_id: 'default', slug: CONCEPT }]);
        expect(note).toContain(`default/${CONCEPT}`);
        expect(note).toContain('no model key they stay hidden');
        expect(note).not.toContain('This purge removes');
        const explicit = await printedJson(() => runPages(engine, ['purge-deleted', '--dry-run', '--json']));
        expect(explicit).toMatchObject({ rebuild: [{ source_id: 'default', slug: CONCEPT }] });
        expect(explicit.rebuild_note).toEndWith('This purge removes any of them listed above instead.');
        const automatic = await printedJson(() => runMaintain(engine, ['--purge', '--json']));
        expect(automatic).toMatchObject({ mode: 'preview', rebuild: [{ source_id: 'default', slug: CONCEPT }], rebuild_note: note });
        const phase = (await runCycle(engine, { brainDir: root, phases: ['purge'], sourceId: 'default' })).phases.find(p => p.phase === 'purge')!;
        expect(phase.details).toMatchObject({ purged_pages_kept_for_rebuild: [{ source_id: 'default', slug: CONCEPT }] });
        expect(phase.summary).toContain('1 concept(s) hidden by an input purge kept for the next concept synthesis to rebuild');
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
