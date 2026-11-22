import { expect, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext, AuthInfo } from '../../src/core/ops/contract.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { purgeDeletedPagesCoordinated } from '../../src/core/persistence/purge-deleted.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../../src/core/search/private-visibility.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { bindCredential } from '../../src/core/access/members.ts';
import { settleManagedGitEffects } from './managed-brain.ts';

export const MODEL = 'anthropic:claude-sonnet-4-6';
export const CONCEPT = 'concepts/storage-example';
export const OLD = 'A narrative built from atoms';
export const NEW = 'Rebuilt narrative canaryrebuilt.';
export const atom = (i: number) => `atoms/storage-${i}`;
export const members = (ids: number[]) => ids.map(i => ({ slug: atom(i), concept_refs: [CONCEPT], body: `Atom ${i} about storage.`, title: `storage atom ${i}`, visibility: 'world' as const }));
export const reply = (text: string): ChatResult => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: MODEL, providerId: 'anthropic' });


export async function put(ctx: OperationContext, slug: string, body: string, type = 'atom'): Promise<void> {
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: `---\ntitle: ${slug}\ntype: ${type}\nvisibility: world\n---\n${body}` } });
}
export async function deletePage(engine: BrainEngine, ctx: OperationContext, slug: string): Promise<Record<string, unknown>> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
  return await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, expected_revision: snapshot!.revision, request_id: randomUUID() } }) as Record<string, unknown>;
}
export async function unmanagedWhile<T>(engine: BrainEngine, on: boolean, fn: () => Promise<T>): Promise<T> {
  await disposePersistenceConsumer(engine);
  if (on) await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { return await fn(); } finally {
    if (on) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await disposePersistenceConsumer(engine);
  }
}
/** Moves a tombstone (and its rederive mark, which time moves with it) `hours` into the past. */
export async function age(engine: BrainEngine, slug: string, hours = 100): Promise<void> {
  await unmanagedWhile(engine, true, async () => {
    await engine.executeRaw(`UPDATE needs_rederive n SET marked_at = n.marked_at - ($2 || ' hours')::interval FROM pages p
      WHERE n.derived_table='pages' AND n.derived_id=p.id::text AND p.source_id='default' AND p.slug=$1`, [slug, String(hours)]);
    await engine.executeRaw(`UPDATE pages SET deleted_at=deleted_at - ($2 || ' hours')::interval WHERE source_id='default' AND slug=$1`, [slug, String(hours)]);
  });
}
export async function raw(engine: BrainEngine, sql: string, params: unknown[] = []): Promise<void> {
  await unmanagedWhile(engine, true, async () => { await engine.executeRaw(sql, params); });
}
/** What a member who is neither the owner nor a reader gets from get_page over the remote path. */
export async function remoteRead(engine: BrainEngine): Promise<string> {
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
export async function printedJson(run: () => Promise<unknown>): Promise<Record<string, any>> {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { lines.push(parts.join(' ')); });
  try { await run(); } finally { log.mockRestore(); }
  return JSON.parse(lines.join('\n'));
}
export async function purge(engine: BrainEngine, automatic: boolean): Promise<string[]> {
  return unmanagedWhile(engine, false, async () => (await purgeDeletedPagesCoordinated(engine, 72, { automatic })).slugs);
}
export async function synthesize(engine: BrainEngine, root: string, ids: number[], opts: { text?: string; unmanaged?: boolean; during?: () => Promise<void>;
  read?: Record<string, string>; requests?: ChatOpts[]; settle?: boolean } = {}) {
  const chat = async (request: ChatOpts): Promise<ChatResult> => { opts.requests?.push(request); await opts.during?.(); return reply(opts.text ?? `${OLD} ${ids.join(', ')}.`); };
  const result = await unmanagedWhile(engine, !!opts.unmanaged, () => runPhaseSynthesizeConcepts(engine, { sourceId: 'default', brainDir: root,
    _atoms: members(ids).map(m => ({ ...m, revision: opts.read?.[m.slug] })), _chat: chat as never }));
  if (opts.settle !== false) await settleManagedGitEffects(engine);
  return result.details as Record<string, any>;
}
export async function state(engine: BrainEngine) {
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
export async function heldConcept(engine: BrainEngine, ctx: OperationContext, root: string, live?: () => Promise<void>): Promise<number> {
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
export const stillHeld = async (engine: BrainEngine, id: number, links = 1) => {
  const now = await state(engine);
  expect(now).toMatchObject({ id, live: false, marks: 1, links_in: links });
  expect(now.versions).toBeGreaterThan(0);
};
