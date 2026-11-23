/**
 * BrainEngine parity: the client lifecycle writes of `mutateClientLifecycle` (src/core/grants/lifecycle.ts), through the
 * members `deleteOauthClientRow`, `setOauthClientRevision` and `insertOauthGrantAudit` of engine-sql/oauth-revocation.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the same lifecycle calls leave the same client row, tokens and grant audit on every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts). A preview writes nothing.
 *    `invalidate-tokens` deletes the client's tokens, keeps it live and bumps its revision; `revoke` also stamps
 *    `deleted_at` (once: a second revoke keeps the first time); `delete` removes the row and keeps an audit tombstone. Each
 *    applied action appends one audit row with the revision and the before and after documents. A stale reviewed
 *    revision is refused as a conflict and an unknown client as not found, before anything is written.
 *  - Regression: an applied lifecycle action that leaves a token usable, skips or double-writes the audit row, loses the
 *    tombstone of a deleted client, or answers differently on one engine.
 *  - Why existing coverage misses it: test/mcp-client-lifecycle.test.ts runs the lifecycle on PGLite only and
 *    test/e2e/oauth-grant-transactions.test.ts races it on Postgres; neither compares an arm with another.
 *  - Seam: none. Real engines and the real `mutateClientLifecycle`; the tables are read through typed members only.
 */
import { describe } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { mutateClientLifecycle, type ClientLifecycleAction } from '../../src/core/grants/lifecycle.ts';
import { hashToken } from '../../src/core/utils.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

async function refusal<T>(run: () => Promise<T>): Promise<T | { name: string; message: string }> {
  try {
    return await run();
  } catch (error) {
    const e = error as { name?: string; message?: string; code?: unknown };
    if (e.code === 'engine_capability_missing') throw error;
    return { name: String(e.name), message: String(e.message) };
  }
}

async function seed(engine: BrainEngine, id: string): Promise<void> {
  await engine.insertOauthClient({ client_id: id, client_name: id, scope: 'read' });
  for (const [raw, type] of [[`${id}-a`, 'access'], [`${id}-r`, 'refresh']] as const) {
    await engine.insertOauthToken({ token_hash: hashToken(raw), token_type: type, client_id: id, scopes: ['read'], expires_at: 4_000_000_000, resource: null, created_at: 1_800_000_000 });
  }
}

/** Which of the client's tokens are stored: a second insert of the same hash is 23505 only for one that is there. */
async function stored(engine: BrainEngine, id: string): Promise<boolean[]> {
  const out: boolean[] = [];
  for (const [raw, type] of [[`${id}-a`, 'access'], [`${id}-r`, 'refresh']] as const) {
    try {
      await engine.insertOauthToken({ token_hash: hashToken(raw), token_type: type, client_id: id, scopes: ['read'], expires_at: 4_000_000_000, resource: null, created_at: 1_800_000_000 });
      out.push(false);
    } catch (error) {
      if ((error as { code?: unknown }).code !== '23505') throw error;
      out.push(true);
    }
  }
  return out;
}

async function audit(engine: BrainEngine, id: string) {
  return (await engine.listOauthGrantAudit(id)).map(r => ({
    actor: r.actor, action: r.action, revision: r.revision,
    before: typeof r.before_grant === 'string' ? JSON.parse(r.before_grant) : r.before_grant,
    after: typeof r.after_grant === 'string' ? JSON.parse(r.after_grant) : r.after_grant,
  }));
}

async function apply(engine: BrainEngine, id: string, action: ClientLifecycleAction) {
  const preview = await mutateClientLifecycle(engine, id, action, { actor: 'admin' });
  const done = await mutateClientLifecycle(engine, id, action, { actor: 'admin', dryRun: false, yes: true, expectedRevision: preview.before.revision });
  return { preview: preview.dry_run, revision: done.grant?.revision ?? null, revoked: done.grant?.revoked ?? null };
}

describe('engine parity: OAuth client lifecycle', () => {
  parityTest('a preview writes nothing, and a stale revision or an unknown client is refused before any write',
    { methods: ['insertOauthClient', 'insertOauthToken', 'oauthClientLive', 'readOauthClientForUpdate', 'listOauthGrantAudit'] }, async engine => {
      await seed(engine, 'c1');
      const preview = await mutateClientLifecycle(engine, 'c1', 'delete', { actor: 'admin' });
      const stale = await refusal(() => mutateClientLifecycle(engine, 'c1', 'revoke', { actor: 'admin', dryRun: false, yes: true, expectedRevision: 9 }));
      const unknown = await refusal(() => mutateClientLifecycle(engine, 'nobody', 'revoke', { actor: 'admin' }));
      const unconfirmed = await refusal(() => mutateClientLifecycle(engine, 'c1', 'revoke', { actor: 'admin', dryRun: false }));
      return {
        preview: { dry_run: preview.dry_run, revision: preview.before.revision, grant: preview.grant }, stale, unknown, unconfirmed,
        live: await engine.oauthClientLive('c1'), tokens: await stored(engine, 'c1'), audit: await audit(engine, 'c1'),
      };
    });

  parityTest('invalidate-tokens deletes the client\'s tokens, keeps it live, bumps the revision and audits once',
    { methods: ['insertOauthClient', 'insertOauthToken', 'oauthClientLive', 'readOauthClientForUpdate', 'listOauthGrantAudit', 'readOauthClient', 'deleteOauthClientTokens', 'deleteOauthClientCodes', 'insertOauthGrantAudit', 'setOauthClientRevision'] }, async engine => {
      await seed(engine, 'c1');
      await seed(engine, 'c2');
      const result = await apply(engine, 'c1', 'invalidate-tokens');
      const row = await engine.readOauthClient('c1');
      return {
        result, live: await engine.oauthClientLive('c1'), revision: row?.grant_revision, deleted: row?.deleted_at == null,
        tokens: { c1: await stored(engine, 'c1'), c2: await stored(engine, 'c2') }, audit: await audit(engine, 'c1'), other: await audit(engine, 'c2'),
      };
    });

  parityTest('revoke stamps deleted_at once, deletes the tokens, bumps the revision and audits each apply',
    { methods: ['insertOauthClient', 'insertOauthToken', 'oauthClientLive', 'readOauthClientForUpdate', 'listOauthGrantAudit', 'readOauthClient', 'deleteOauthClientTokens', 'deleteOauthClientCodes', 'insertOauthGrantAudit', 'setOauthClientRevision'] }, async engine => {
      await seed(engine, 'c1');
      await seed(engine, 'c2');
      const first = await apply(engine, 'c1', 'revoke');
      const stamped = (await engine.readOauthClient('c1'))?.deleted_at;
      const second = await apply(engine, 'c1', 'revoke');
      const row = await engine.readOauthClient('c1');
      return {
        first, second, kept: row?.client_id, revision: row?.grant_revision, sameStamp: stamped instanceof Date && row?.deleted_at instanceof Date && stamped.getTime() === row.deleted_at.getTime(),
        live: { c1: await engine.oauthClientLive('c1'), c2: await engine.oauthClientLive('c2') },
        tokens: { c1: await stored(engine, 'c1'), c2: await stored(engine, 'c2') }, audit: await audit(engine, 'c1'),
      };
    });

  parityTest('delete removes the client and its tokens and keeps an audit tombstone',
    { methods: ['insertOauthClient', 'insertOauthToken', 'oauthClientLive', 'readOauthClientForUpdate', 'listOauthGrantAudit', 'readOauthClient', 'deleteOauthClientTokens', 'deleteOauthClientCodes', 'insertOauthGrantAudit', 'deleteOauthClientRow'] }, async engine => {
      await seed(engine, 'c1');
      await seed(engine, 'c2');
      const done = await apply(engine, 'c1', 'delete');
      const after = await refusal(() => mutateClientLifecycle(engine, 'c1', 'delete', { actor: 'admin' }));
      return {
        done, row: await engine.readOauthClient('c1'), after, c2: await engine.oauthClientLive('c2'), tokens: await stored(engine, 'c2'),
        audit: await audit(engine, 'c1'),
      };
    });
});
