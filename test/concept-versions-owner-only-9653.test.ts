/**
 * #9653 with owner-only lineage (R94): a concept rebuilt without an atom derived from an owner-only source loses that
 * lineage on its live page, which is right, but its archived narrative was built from the atom. The dropped input moves
 * onto the archived versions, so a member who is not the owner never reads that narrative through get_versions, while
 * the owner reads every version a purge did not hide. PGLite, and Postgres with DATABASE_URL. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
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
import { replaceConceptInputs } from '../src/core/cycle/concept-publication.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const OPEN = 'own-src';
const OWNER = 'owner-example';
const CONCEPT = 'concepts/harbor-example';
const text = (title: string, body: string, type = 'note') => ['---', `type: ${type}`, `title: ${title}`, '---', `# ${title}`, '', body].join('\n');
for (const kind of testBackends()) describe(`#9653 owner-only lineage of archived concept versions (${kind})`, () => {
  let engine: BrainEngine;
    let close: () => Promise<void>;
  const tokens: Record<string, string> = {};
  const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  async function read(who: string, op: string, params: Record<string, unknown>): Promise<string> {
    const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
    const sourceId = auth.sourceId ?? OPEN;
    const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
    const out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: ['world'], ...(localFederated ? { localFederatedSourceIds: localFederated } : {}) });
    return out.content.map(c => c.text).join('\n');
  }
  const id = async (slug: string, src: string) => String((await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug=$1 AND source_id=$2', [slug, src]))[0]!.id);
  const lineage = async () => (await engine.executeRaw<{ v: boolean }>('SELECT gbrain_owner_only_lineage(\'pages\', $1::bigint) AS v', [await id(CONCEPT, OPEN)]))[0]!.v;

  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    __resetPrivateVisibilityCacheForTests();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [OPEN]);
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('messages-a', 'messages-a', '{"kind":"imessage","federated":true}'::jsonb)`);
    await importFromContent(engine, 'imessage/chat/2026-06-14', text('Chat', 'private chat canarychat'), { sourceId: 'messages-a', noEmbed: true });
    for (const i of [0, 1, 2]) await importFromContent(engine, `atoms/harbor-${i}`, text(`atom ${i}`, `Atom ${i} about harbors.`, 'atom'), { sourceId: OPEN, noEmbed: true });
    // atom 0 was extracted from the owner-only chat
    await engine.executeRaw(`INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id) VALUES ('pages', $1, 'pages', $2, $3)`, [await id('atoms/harbor-0', OPEN), await id('imessage/chat/2026-06-14', 'messages-a'), OPEN]);
    for (const member of [OWNER, 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [member]);
    for (const [name, member, scopes] of [['owner', OWNER, ['read']], ['bob', 'bob-example', ['read']], ['owner-writer', OWNER, ['read', 'write']], ['bob-writer', 'bob-example', ['read', 'write']]] as const) {
      const minted = await mintLegacyToken(engine, { name, scopes: [...scopes], takesHolders: ['world'], sourceGrant: [OPEN, 'messages-a'] });
      tokens[name] = minted.token;
      await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
    }
    await engine.executeRaw(`UPDATE access_tokens SET private_pages = 'granted_sources', private_facts = 'granted_sources'`);
    await setOwner(engine, OWNER);
  }, 240_000);
  afterAll(async () => { await close?.(); }, 60_000);

  test('a member who is not the owner never reads the archived narrative; the owner reads every version', async () => {
    await importFromContent(engine, CONCEPT, text('Harbor', 'Narrative v1 canaryv1 from atoms zero to two.', 'concept'), { sourceId: OPEN, noEmbed: true });
    await replaceConceptInputs(engine, OPEN, CONCEPT, ['atoms/harbor-0', 'atoms/harbor-1', 'atoms/harbor-2']);
    expect(await lineage()).toBe(true);
    expect((await read('bob', 'get_page', { slug: CONCEPT })).includes('canaryv1')).toBe(false);
    await importFromContent(engine, CONCEPT, text('Harbor', 'Narrative v2 canaryv2 from atoms one to two.', 'concept'), { sourceId: OPEN, noEmbed: true });
    await replaceConceptInputs(engine, OPEN, CONCEPT, ['atoms/harbor-1', 'atoms/harbor-2']);
    expect(await lineage()).toBe(false);
    expect((await read('bob', 'get_page', { slug: CONCEPT })).includes('canaryv2')).toBe(true);
    expect((await read('bob', 'get_versions', { slug: CONCEPT, include_body: true })).includes('canaryv1')).toBe(false);
    expect((await read('owner', 'get_versions', { slug: CONCEPT, include_body: true })).includes('canaryv1')).toBe(true);
  }, 240_000);

  test('a member who is not the owner cannot revert to the owner-only version; the owner can', async () => {
    const v1 = (await engine.getVersions(CONCEPT, { sourceId: OPEN })).find(v => String(v.compiled_truth).includes('canaryv1'))!;
    expect(v1).toBeDefined();
    expect(await read('bob-writer', 'revert_version', { slug: CONCEPT, version_id: Number(v1.id), dry_run: true })).toMatch(/not_found|not in the history/);
    expect(await read('owner-writer', 'revert_version', { slug: CONCEPT, version_id: Number(v1.id), dry_run: true })).toMatch(/dry_run/);
  }, 240_000);

  test('a revert carries the version\'s inputs back, so the restored narrative stays owner-only', async () => {
    const v1 = (await engine.getVersions(CONCEPT, { sourceId: OPEN })).find(v => String(v.compiled_truth).includes('canaryv1'))!;
    const revision = (await engine.readPageSnapshot(CONCEPT, { sourceId: OPEN }))!.revision;
    await read('owner-writer', 'revert_version', { slug: CONCEPT, version_id: Number(v1.id), expected_revision: revision });
    expect((await engine.getPage(CONCEPT, { sourceId: OPEN }))?.compiled_truth).toContain('canaryv1');
    expect(await lineage()).toBe(true);
    expect((await read('bob', 'get_page', { slug: CONCEPT })).includes('canaryv1')).toBe(false);
    await importFromContent(engine, CONCEPT, text('Harbor', 'Narrative v3 canaryv3 from atoms one to two.', 'concept'), { sourceId: OPEN, noEmbed: true });
    await replaceConceptInputs(engine, OPEN, CONCEPT, ['atoms/harbor-1', 'atoms/harbor-2']);
    expect(await lineage()).toBe(false);
    await engine.revertToVersion(CONCEPT, Number(v1.id), { sourceId: OPEN });
    expect(await lineage()).toBe(true);
  }, 240_000);
});
