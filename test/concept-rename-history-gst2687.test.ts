/**
 * GST-2687: a synthesized concept whose input atom is stamped `world` and whose atom's origin is private, after the
 * origin was renamed and a later rename onto the old slug dropped the origin's rename alias.
 *
 * 1. Protects: the concept stays hidden from a non-owner remote caller on get_page, search, query and list_pages, as the
 *    atom does since #9325 (#8920, atomMovedOriginPrivateSql on the atom branch of derivedOriginPrivateSql); the owner
 *    and a granted_sources credential still read both; doctor's derived_visibility counts the concept in looser_concepts
 *    and the atom in looser_atoms. On a brain whose schema predates v311 (gbrain_concept_inputs_private missing) remote
 *    reads keep working and still hide the concept.
 * 2. Fails when: the concept-input branch of privatePagesFilterFragment (or looser_concepts, or looser_atoms) follows
 *    only the slug_aliases rename alias and not slug_rename_history, so the dropped alias makes the concept readable.
 * 3. Existing coverage: rename-atom-lineage-7462 (#8920 case: the atom alone, raw SQL fragment).
 * 4. Real seams: tokens minted by the token service and verified by the OAuth provider, dispatched through MCP dispatch
 *    (remote: true); the sync rename primitive; a repo-less source; PGLite, and Postgres with DATABASE_URL; embeddings stubbed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { parseRescopeTokenArgs, rescopeLegacyToken } from '../src/core/grants/legacy-token.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests, CONCEPT_INPUTS_PRIVATE_SINCE, privatePagesFilterFragment, withCallerAccess, type CallerAccess } from '../src/core/search/private-visibility.ts';
import * as scopeRead from '../src/core/access/scope-read.ts';
import { attestedCallerAccess } from '../src/core/access/actor.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import { renamePageOntoSlug } from '../src/commands/sync/rename-collision.ts';
import { derivedVisibilityCheck } from '../src/commands/doctor/checks/derived-visibility.ts';
import { runMigrations } from '../src/core/migrate.ts';
import { hasPendingMigrations } from '../src/core/migrate-pending.ts';
import { withEngineScope } from '../src/core/engine-scope.ts';
import { v311 } from '../src/core/schema-migrations/v311-concept-inputs-private.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const DIMS = 1536;
function vectorFor(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

const SRC = 'source-a';
const OWNER = 'owner-example';
const MEMBER = 'alice-example';
const ORIGIN = 'notes/secret';
const MOVED = 'archive/secret';
const OTHER = 'notes/other';
const ATOM = 'atoms/secret-claim';
const CONCEPT = 'concepts/secret-concept';
const canary = (name: string) => `canarygst${name}x`;
const doc = (title: string, name: string, fm: string[], type: string) =>
  ['---', `type: ${type}`, `title: ${title}`, ...fm, '---', `# ${title}`, '', `Harbor ledger planning notes ${canary(name)} here.`].join('\n');

for (const kind of testBackends()) {
  describe(`GST-2687: concept of a world atom whose private origin's rename alias was dropped (${kind})`, () => {
    let engine: BrainEngine;
    let closeEngine: () => Promise<void>;
    const tokens: Record<string, string> = {};

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close: closeEngine } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const e = new PGLiteEngine(); await e.connect({ engine: 'pglite' } as never); await e.initSchema(); engine = e; closeEngine = () => e.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      for (const id of [OWNER, MEMBER]) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);

      await importFromContent(engine, ORIGIN, doc('Secret origin', 'origin', ['visibility: private'], 'note'), { sourceId: SRC });
      await importFromContent(engine, ATOM, doc('Secret claim', 'atom', ['visibility: world', `source_slug: ${ORIGIN}`], 'atom'), { sourceId: SRC });
      await importFromContent(engine, OTHER, doc('Other note', 'other', ['visibility: world'], 'note'), { sourceId: SRC });
      expect(await renamePageOntoSlug(engine, { sourceId: SRC, oldSlug: ORIGIN, newSlug: MOVED, to: `${MOVED}.md` })).toBe('renamed');
      expect(await renamePageOntoSlug(engine, { sourceId: SRC, oldSlug: OTHER, newSlug: ORIGIN, to: `${ORIGIN}.md` })).toBe('renamed');
      await importFromContent(engine, CONCEPT, doc('Secret concept', 'concept', ['visibility: world', 'synthesized_by: fixture'], 'concept'), { sourceId: SRC });
      await engine.addLink(CONCEPT, ATOM, 'input', 'synthesized_from', 'concept-provenance', undefined, undefined, { fromSourceId: SRC, toSourceId: SRC });

      for (const [name, member] of [['owner', OWNER], ['alice', MEMBER]] as const) {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = minted.token;
        await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
      }
      const granted = await mintLegacyToken(engine, { name: 'granted', scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
      tokens.granted = granted.token;
      await rescopeLegacyToken(engine, parseRescopeTokenArgs(['granted', '--private-pages', 'granted-sources']));
      await readsUnscopedOnPurpose(engine, granted.id);
      await setOwner(engine, OWNER);
    }, 240_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await closeEngine?.();
    }, 60_000);

    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    async function call(who: string, op: string, params: Record<string, unknown>): Promise<string> {
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const out = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
      });
      return out.content.map(x => x.text).join('\n');
    }
    /** For each read path, whether `who` sees the page `slug` (by its canary, or by its slug on list_pages). */
    async function reads(who: string, slug: string, name: string): Promise<Record<string, boolean>> {
      __resetPrivateVisibilityCacheForTests();
      return {
        get_page: (await call(who, 'get_page', { slug })).includes(canary(name)),
        search: (await call(who, 'search', { query: 'harbor ledger planning notes', match: 'keyword', autocut: false, fields: 'full', limit: 100 })).includes(canary(name)),
        query: (await call(who, 'query', { query: 'harbor ledger planning notes', expand: false, autocut: false, fields: 'full', limit: 100 })).includes(canary(name)),
        list_pages: (await call(who, 'list_pages', { limit: 100 })).includes(`"${slug}"`),
      };
    }
    const none = { get_page: false, search: false, query: false, list_pages: false };
    const all = { get_page: true, search: true, query: true, list_pages: true };

    test('fixture: the old slug now holds a world page and its rename alias is gone; the history row remains', async () => {
      expect(await engine.executeRaw(`SELECT 1 FROM slug_aliases WHERE source_id=$1 AND alias_slug=$2 AND notes='rename'`, [SRC, ORIGIN])).toEqual([]);
      expect(await engine.executeRaw<{ new_slug: string }>(`SELECT new_slug FROM slug_rename_history WHERE source_id=$1 AND old_slug=$2`, [SRC, ORIGIN]))
        .toEqual([{ new_slug: MOVED }]);
      expect((await engine.getPage(ORIGIN, { sourceId: SRC }))?.frontmatter).toMatchObject({ visibility: 'world' });
    });

    test('(a) control: the world-stamped atom is hidden from a non-owner remote caller', async () => {
      expect(await reads('alice', ATOM, 'atom')).toEqual(none);
    }, 60_000);

    test('(b) the concept whose input is that atom is hidden from the same caller', async () => {
      expect(await reads('alice', CONCEPT, 'concept')).toEqual(none);
    }, 60_000);

    test('(c) the owner still reads the atom and the concept', async () => {
      expect({ atom: await reads('owner', ATOM, 'atom'), concept: await reads('owner', CONCEPT, 'concept') }).toEqual({ atom: all, concept: all });
    }, 60_000);

    test('(d) doctor derived_visibility counts the concept in looser_concepts', async () => {
      const details = (await derivedVisibilityCheck(engine, SRC)).details as { looser_concepts: number };
      expect(details.looser_concepts).toBe(1);
    }, 60_000);

    test('(e) doctor derived_visibility counts the atom in looser_atoms', async () => {
      const details = (await derivedVisibilityCheck(engine, SRC)).details as { looser_atoms: number };
      expect(details.looser_atoms).toBe(1);
    }, 60_000);

    test('(f) a granted_sources credential on the source still reads the atom and the concept', async () => {
      expect({ atom: await reads('granted', ATOM, 'atom'), concept: await reads('granted', CONCEPT, 'concept') }).toEqual({ atom: all, concept: all });
    }, 60_000);

    test('the read rule gates on the migration that creates the function', () => {
      expect(CONCEPT_INPUTS_PRIVATE_SINCE).toBe(v311.version);
    });

    test('(g) on a brain whose schema predates v311 remote reads keep working and still hide the concept', async () => {
      await engine.executeRaw('DROP FUNCTION gbrain_concept_inputs_private(integer)');
      await engine.setConfig('version', String(v311.version - 1));
      try {
        expect({ alice: await reads('alice', CONCEPT, 'concept'), owner: await reads('owner', CONCEPT, 'concept'), granted: await reads('granted', CONCEPT, 'concept') })
          .toEqual({ alice: none, owner: all, granted: all });
      } finally {
        await runMigrations(engine);
      }
      expect(await engine.executeRaw<{ ok: boolean }>(`SELECT to_regprocedure('gbrain_concept_inputs_private(integer)') IS NOT NULL AS ok`)).toEqual([{ ok: true }]);
    }, 60_000);

    test('(h) on a brain whose schema predates v311 a scope read, whose record carries no schema version, keeps working and hides the concept', async () => {
      await engine.executeRaw('DROP FUNCTION gbrain_concept_inputs_private(integer)');
      await engine.setConfig('version', String(v311.version - 1));
      try {
        __resetPrivateVisibilityCacheForTests();
        const visible = await withCallerAccess(scopeRead.SCOPE_READ_ACCESS, async () => (await engine.executeRaw<{ slug: string }>(
          `SELECT p.slug FROM pages p WHERE p.source_id = $1 AND ${privatePagesFilterFragment('p')}`, [SRC])).map(row => row.slug));
        expect({ concept: visible.includes(CONCEPT), atom: visible.includes(ATOM) }).toEqual({ concept: false, atom: false });
      } finally {
        await runMigrations(engine);
      }
    }, 60_000);

    test('(i) on a brain whose schema predates v311 a local read with no caller record keeps working inside a transaction and hides the concept', async () => {
      await engine.executeRaw('DROP FUNCTION gbrain_concept_inputs_private(integer)');
      await engine.setConfig('version', String(v311.version - 1));
      try {
        __resetPrivateVisibilityCacheForTests();
        expect(await hasPendingMigrations(engine)).toBe(true); // the connect gate's read records the version, as for a CLI call
        const visible = await withEngineScope(engine, () => engine.transaction(async tx => {
          expect(privatePagesFilterFragment('p')).not.toContain('gbrain_concept_inputs_private(');
          const rows = await tx.executeRaw<{ slug: string }>(`SELECT p.slug FROM pages p WHERE p.source_id = $1 AND ${privatePagesFilterFragment('p')}`, [SRC]);
          expect(await tx.executeRaw<{ ok: number }>('SELECT 1 AS ok')).toEqual([{ ok: 1 }]);
          return rows.map(row => row.slug);
        }));
        expect({ concept: visible.includes(CONCEPT), atom: visible.includes(ATOM) }).toEqual({ concept: false, atom: false });
      } finally {
        await runMigrations(engine);
      }
    }, 60_000);

    test('(j) on a v311 brain a scope read and an attested read take the function form and hide the concept', async () => {
      __resetPrivateVisibilityCacheForTests();
      const attested = await attestedCallerAccess(engine, { system: 'qm', external_id: 'ext-example', member: MEMBER }, [`member:${MEMBER}`]);
      const scope = await scopeRead.scopeReadAccess(engine);
      const usesFunction = (access: Partial<CallerAccess>) => withCallerAccess(access, () => privatePagesFilterFragment('p')).includes('gbrain_concept_inputs_private(');
      expect({ scope: usesFunction(scope), attested: usesFunction(attested) }).toEqual({ scope: true, attested: true });
      const visible = await withCallerAccess(scope, async () => (await engine.executeRaw<{ slug: string }>(
        `SELECT p.slug FROM pages p WHERE p.source_id = $1 AND ${privatePagesFilterFragment('p')}`, [SRC])).map(row => row.slug));
      expect(visible.includes(CONCEPT)).toBe(false);
    }, 60_000);

    test('(k) on a v311 brain a local read with no caller record takes the function form in its engine scope and hides the concept', async () => {
      __resetPrivateVisibilityCacheForTests();
      expect(await hasPendingMigrations(engine)).toBe(false);
      const usesFunction = (scope: object) => withEngineScope(scope, () => privatePagesFilterFragment('p')).includes('gbrain_concept_inputs_private(');
      expect({ engine: usesFunction(engine), unrecorded: usesFunction({}) }).toEqual({ engine: true, unrecorded: false });
      expect(privatePagesFilterFragment('p')).not.toContain('gbrain_concept_inputs_private(');
      const visible = await withEngineScope(engine, () => engine.transaction(async tx => (await tx.executeRaw<{ slug: string }>(
        `SELECT p.slug FROM pages p WHERE p.source_id = $1 AND ${privatePagesFilterFragment('p')}`, [SRC])).map(row => row.slug)));
      expect({ concept: visible.includes(CONCEPT), atom: visible.includes(ATOM) }).toEqual({ concept: false, atom: false });
    }, 60_000);
  });
}
