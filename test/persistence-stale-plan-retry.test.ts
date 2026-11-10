/**
 * GST-2314: a migration that adds a `persistence_requests` column under a running writer must not fail accepted writes.
 * Inside a publication transaction, a prepared `SELECT *` whose plan was cached before the column existed fails with
 * 0A000 ("cached plan must not change result type"); the transaction rolls back and nothing is committed.
 * 1. Protects: after `ALTER TABLE persistence_requests ADD COLUMN`, every put_page on a pool of 3 publishes, with no
 *    request charged more stale-plan interruptions than `persistence.max_transient_retries` allows, and no caller
 *    refused at admission.
 * 2. Fails when: the stale-plan error is not a transient interruption (the write ends failed/storage_error, never
 *    claimed again) or admission does not re-run it (the caller gets internal_error).
 * 3. Real seams: the serve --http token verifier, MCP dispatch, admission, the resident consumer and publication.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const note = (title: string) => ['---', 'type: note', 'title: ' + title, '---', '# ' + title, '', 'Body of ' + title + '.'].join('\n');
const MAX_TRANSIENT_RETRIES = 5;

for (const kind of testBackends()) {
  describe('accepted writes after a migration adds a persistence_requests column (' + kind + ')', () => {
    const POOL = kind === 'postgres' ? 3 : 1;
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', POOL));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
    }, 240_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test('every put_page after the column is added publishes within the transient retry limit', async () => {
      const minted = await mintLegacyToken(engine, { name: 'writer', scopes: ['read', 'write'], takesHolders: ['world'] });
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
      let n = 0;
      const put = async () => {
        const slug = 'notes/stale-plan-' + (n++);
        const requestId = randomUUID();
        const auth = await provider.verifyAccessToken(minted.token) as unknown as AuthInfo;
        const out = await dispatchToolCall(engine, 'put_page', { slug, content: note(slug), request_id: requestId },
          { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] });
        const text = out.content.map(c => c.text).join('\n');
        return { requestId, code: out.isError === true ? String(JSON.parse(text).code) : 'ok' };
      };
      const warm = [];
      for (let i = 0; i < 4; i++) warm.push(await put());
      warm.push(...await Promise.all(Array.from({ length: POOL }, () => put())));
      expect(warm.map(w => w.code)).toEqual(warm.map(() => 'ok'));

      await engine.executeRaw('ALTER TABLE persistence_requests ADD COLUMN probe_added_column TEXT');
      const after = [];
      for (let i = 0; i < 6; i++) after.push(await put());
      after.push(...await Promise.all(Array.from({ length: POOL }, () => put())));
      expect(after.map(a => a.code).filter(code => code !== 'ok' && code !== 'write_pending')).toEqual([]);

      const ids = after.map(a => a.requestId);
      const settled = async () => engine.executeRaw<{ state: string; error_code: string | null; transient_interruptions: number }>(
        'SELECT state, error_code, transient_interruptions FROM persistence_requests WHERE request_id = ANY($1::uuid[])', [ids]);
      let rows = await settled();
      for (const until = Date.now() + 120_000; Date.now() < until && rows.some(r => r.state !== 'committed' && r.state !== 'failed'); rows = await settled()) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      expect(rows.map(r => r.state + (r.error_code ? '/' + r.error_code : ''))).toEqual(ids.map(() => 'committed'));
      expect(Math.max(...rows.map(r => r.transient_interruptions))).toBeLessThanOrEqual(MAX_TRANSIENT_RETRIES);
    }, 300_000);
  });
}
