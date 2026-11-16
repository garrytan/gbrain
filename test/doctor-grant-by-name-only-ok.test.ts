/**
 * `grant_new_ops_available` when the only missing operations are the membership ones the owner approves by name
 * (join_brain, sync_brain_skills, leave_brain): the check is ok and names those operations with the command that adds
 * them, because no default repair exists and a warn that clears only by granting them pushes owners to widen a grant.
 * A grant missing any other operation still warns with the default repair.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { resolveGrantProfile } from '../src/core/grants/service.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { checkGrantNewOps } from '../src/commands/doctor/checks/grant-new-ops.ts';

const cfg = { engine: 'pglite' } as any;
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

type Finding = { name: string; argv: string[] | null; by_name_operations: string[]; by_name_argv: string[] | null };

test('a grant missing only by-name operations is ok with those operations and their command; one missing others still warns', async () => {
  const profile = resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' });
  const scopes = ['read', 'write', 'skills_member_self'];
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  await provider.registerClientManual('member-example', ['client_credentials'], scopes.join(' '), [], 'default', undefined, undefined, undefined,
    { ...profile, scopes, allowedOperations: profile.allowedOperations });

  const byNameOnly = await checkGrantNewOps(engine, { cfg });
  const [finding] = (byNameOnly.details?.grants ?? []) as Finding[];
  expect(finding).toMatchObject({ name: 'member-example', argv: null });
  expect([...finding!.by_name_operations].sort()).toEqual(['join_brain', 'leave_brain', 'sync_brain_skills']);
  expect(finding!.by_name_argv).not.toBeNull();
  expect(byNameOnly.status).toBe('ok');
  expect(byNameOnly.fix).toBeUndefined();
  expect(byNameOnly.message).toContain(`member-example (`);
  expect(byNameOnly.message).toContain(finding!.by_name_operations.join(', '));
  expect(byNameOnly.message).toContain(finding!.by_name_argv!.slice(0, 3).join(' '));

  await mintLegacyToken(engine, { name: 'token-example', scopes, takesHolders: ['world'],
    allowedOperations: profile.allowedOperations!.filter(op => op !== 'put_pages') });
  const mixed = await checkGrantNewOps(engine, { cfg });
  expect(mixed.status).toBe('warn');
  expect(((mixed.details?.grants ?? []) as Finding[]).map(f => f.name).sort()).toEqual(['member-example', 'token-example']);
  expect(mixed.fix).toBeDefined();
}, 120_000);
