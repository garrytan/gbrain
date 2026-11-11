/**
 * GST-2314: a migration that adds an `access_tokens` column under a running server must not fail the next
 * legacy-token write. Inside a transaction, a prepared `SELECT *` whose plan was cached before the column
 * existed fails with 0A000 ("cached plan must not change result type"): the driver's stale-plan retry lands
 * in the already-aborted transaction. The publication authority read and the shared-skills membership read
 * name their columns, so a new column leaves their result type unchanged.
 * 1. Protects: the publication authority read (FOR SHARE) and the membership authority read, run on every
 *    pooled connection before and after `ALTER TABLE access_tokens ADD COLUMN`, succeed; so does a
 *    legacy-token put_page after the column is added.
 * 2. Fails when: either read selects every column of access_tokens inside its transaction, or the membership read
 *    (which no schema admission guards) or the publication read (which admission runs before it replays an accepted
 *    request or refuses a schema behind this build) names a column that schema does not have.
 * 3. Real seams: the token service, the serve --http token verifier, MCP dispatch and the durable write path.
 *    Each read runs in POOL concurrent transactions held open together, so every pooled connection prepares it
 *    first and every one reuses its cached plan after the column is added.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { authorizeWrite } from '../src/core/persistence/authority.ts';
import type { WriteAuthority } from '../src/core/persistence/model.ts';
import { memberAuthority } from '../src/core/shared-skills/membership-authority.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const note = (title: string) => ['---', 'type: note', 'title: ' + title, '---', '# ' + title, '', 'Body of ' + title + '.'].join('\n');

for (const kind of testBackends()) {
  describe('legacy-token reads after a migration adds an access_tokens column (' + kind + ')', () => {
    const POOL = kind === 'postgres' ? 3 : 1;
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let column = 0;
    const addColumn = () => engine.executeRaw('ALTER TABLE access_tokens ADD COLUMN probe_added_' + (column++) + ' TEXT');
    /** Runs fn in POOL transactions that all stay open until each has started, so each gets its own pooled connection. */
    async function onEveryConnection<T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T[]> {
      let started = 0;
      let release!: () => void;
      const all = new Promise<void>(resolve => { release = resolve; });
      return Promise.all(Array.from({ length: POOL }, () => engine.transaction(async tx => {
        if (++started === POOL) release();
        await all;
        return fn(tx);
      })));
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', POOL));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
    }, 240_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test('the publication authority read succeeds on every connection after the column is added', async () => {
      const minted = await mintLegacyToken(engine, { name: 'publisher', scopes: ['read', 'write'], takesHolders: ['world'] });
      const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
      const authority: WriteAuthority = { version: 1, principal: { kind: 'legacy_token', id: minted.id }, remote: true, sourceId: 'default',
        sourceIncarnation: source.incarnation, scopes: ['read', 'write'], operations: null, slugPrefixes: null, takesHolders: ['world'] };
      const authorize = () => onEveryConnection(tx => authorizeWrite(tx, authority, 'put_page', 'notes/publication-read', true));
      await authorize();
      await addColumn();
      await authorize();
    }, 240_000);

    test('the membership authority read succeeds on every connection after the column is added', async () => {
      const minted = await mintLegacyToken(engine, { name: 'member', scopes: ['read', 'skills_member_self'], takesHolders: ['world'], allowedOperations: ['join_brain'] });
      const read = () => onEveryConnection(async tx => (await memberAuthority({ engine: tx, remote: true, sourceId: 'default',
        auth: { principal: { kind: 'legacy_token', id: minted.id }, scopes: ['read', 'skills_member_self'], allowedOperations: ['join_brain'] } } as unknown as OperationContext, 'join_brain')).principal);
      const principal = { kind: 'legacy_token', id: minted.id };
      expect(await read()).toEqual(Array(POOL).fill(principal));
      await addColumn();
      expect(await read()).toEqual(Array(POOL).fill(principal));
    }, 240_000);

    test('the membership authority read works on a schema that predates an access_tokens column it names', async () => {
      const minted = await mintLegacyToken(engine, { name: 'behind', scopes: ['read', 'skills_member_self'], takesHolders: ['world'], allowedOperations: ['join_brain'] });
      const rollback = new Error('roll back the simulated older schema');
      const principal = await engine.transaction(async tx => {
        await tx.executeRaw('ALTER TABLE access_tokens DROP COLUMN private_pages');
        const result = (await memberAuthority({ engine: tx, remote: true, sourceId: 'default',
          auth: { principal: { kind: 'legacy_token', id: minted.id }, scopes: ['read', 'skills_member_self'], allowedOperations: ['join_brain'] } } as unknown as OperationContext, 'join_brain')).principal;
        throw Object.assign(rollback, { result });
      }).catch(error => { if (error !== rollback) throw error; return (error as { result: unknown }).result; });
      expect(principal).toEqual({ kind: 'legacy_token', id: minted.id });
    }, 240_000);

    test('the publication authority read works on a schema that predates an access_tokens column it names', async () => {
      const minted = await mintLegacyToken(engine, { name: 'behind-writer', scopes: ['read', 'write'], takesHolders: ['world'] });
      const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
      const authority: WriteAuthority = { version: 1, principal: { kind: 'legacy_token', id: minted.id }, remote: true, sourceId: 'default',
        sourceIncarnation: source.incarnation, scopes: ['read', 'write'], operations: null, slugPrefixes: null, takesHolders: ['world'] };
      const rollback = new Error('roll back the simulated older schema');
      await engine.transaction(async tx => {
        await tx.executeRaw('ALTER TABLE access_tokens DROP COLUMN private_pages');
        await authorizeWrite(tx, authority, 'put_page', 'notes/behind-schema', true);
        throw rollback;
      }).catch(error => { if (error !== rollback) throw error; });
    }, 240_000);

    test('on a schema behind the build, an accepted legacy-token write replays and a new one is refused migrations_pending', async () => {
      const minted = await mintLegacyToken(engine, { name: 'replayer', scopes: ['read', 'write'], takesHolders: ['world'] });
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
      const put = async (slug: string, requestId: string) => {
        const auth = await provider.verifyAccessToken(minted.token) as unknown as AuthInfo;
        const out = await dispatchToolCall(engine, 'put_page', { slug, content: note(slug), request_id: requestId },
          { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] });
        const text = out.content.map(c => c.text).join('\n');
        return out.isError === true ? String(JSON.parse(text).code) : String(JSON.parse(text).state ?? 'ok');
      };
      const accepted = randomUUID();
      expect(await put('notes/replayed', accepted)).not.toMatch(/error|denied|pending_/);
      const [version] = await engine.executeRaw<{ value: string }>("SELECT value FROM config WHERE key='version'");
      await engine.executeRaw('ALTER TABLE access_tokens DROP COLUMN private_pages');
      await engine.executeRaw("UPDATE config SET value='279' WHERE key='version'");
      try {
        expect(await put('notes/replayed', accepted)).toBe('committed');
        expect(await put('notes/not-admitted', randomUUID())).toBe('migrations_pending');
      } finally {
        await engine.executeRaw("ALTER TABLE access_tokens ADD COLUMN private_pages TEXT NOT NULL DEFAULT 'none' CHECK (private_pages IN ('none', 'granted_sources'))");
        await engine.executeRaw("UPDATE config SET value=$1 WHERE key='version'", [version.value]);
      }
    }, 240_000);

    test('a legacy-token put_page after the column is added publishes', async () => {
      const minted = await mintLegacyToken(engine, { name: 'writer', scopes: ['read', 'write'], takesHolders: ['world'] });
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
      const put = async (slug: string) => {
        const auth = await provider.verifyAccessToken(minted.token) as unknown as AuthInfo;
        const out = await dispatchToolCall(engine, 'put_page', { slug, content: note(slug), request_id: randomUUID() },
          { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] });
        return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
      };
      expect(await put('notes/before-column')).toMatchObject({ isError: false });
      await addColumn();
      expect(await put('notes/after-column')).toMatchObject({ isError: false });
    }, 240_000);
  });
}
