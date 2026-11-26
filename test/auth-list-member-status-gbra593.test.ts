/**
 * GBRA-582 item 9d (leaver handover, PR 1): `gbrain auth list` shows a token bound to a disabled member as refused.
 *
 * 1. Protects: `auth list --json` keeps `status` (active or revoked, from revoked_at alone) and adds `member_status`
 *    (the bound member's enabled, disabled or removed, `missing` for a binding to no member row, null when unbound);
 *    the text table prints `refused` for an active token whose member cannot read.
 * 2. Fails when: a disabled member's token lists as plain `active` with nothing beside it, or `status` changes meaning.
 * 3. Existing coverage: auth-private-pages-output pins the field set; access-binding pins the refusal at verification.
 * 4. Real seams: the auth CLI handler on PGLite under a sandboxed GBRAIN_HOME, real members and bindings (console.log captured).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../src/core/engine-factory.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runAuth } from '../src/commands/auth.ts';
import { addMember, disableMember, removeMember } from '../src/core/access/members.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { tokenMemberStatuses } from '../src/core/access/token-member-status.ts';
import type { SqlQuery } from '../src/core/sql-query.ts';
import { withEnv } from './helpers/with-env.ts';

let root: string, home: string, db: string;

async function withBrain<T>(run: (engine: BrainEngine) => Promise<T>): Promise<T> {
  const config = { engine: 'pglite' as const, database_path: db };
  const engine = await createEngine(config);
  await engine.connect(config);
  try { return await run(engine); } finally { await engine.disconnect(); }
}

async function auth(args: string[]): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.join(' ')); };
  try { await withEnv({ GBRAIN_HOME: home, HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined }, () => runAuth(args)); }
  finally { console.log = original; }
  return lines.join('\n');
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gb-auth-member-status-'));
  home = join(root, 'home');
  db = join(root, 'db');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: db }));
  await withBrain(async engine => {
    await engine.initSchema();
    for (const id of ['owner-example', 'alice-example', 'bob-example', 'carol-example']) await addMember(engine, id);
    const bind = async (name: string, member: string | null) => {
      const t = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'] });
      if (member) await engine.executeRaw('UPDATE access_tokens SET member_id = $1 WHERE id = $2::uuid', [member, t.id]);
      return t;
    };
    await bind('owner-key', 'owner-example');
    await bind('alice-key', 'alice-example');
    await bind('bob-key', 'bob-example');
    await bind('carol-key', 'carol-example');
    await bind('unbound-key', null);
    const old = await bind('bob-old-key', 'bob-example');
    await engine.executeRaw('UPDATE access_tokens SET revoked_at = now() WHERE id = $1::uuid', [old.id]);
    await disableMember(engine, 'bob-example');
    await removeMember(engine, 'carol-example');
  });
}, 120_000);

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('auth list member status (GBRA-582 item 9d)', () => {
  test('--json keeps status and adds member_status; the owner and enabled members read as before', async () => {
    const tokens = JSON.parse(await auth(['list', '--json'])) as Array<Record<string, unknown>>;
    const byName = Object.fromEntries(tokens.map(t => [t.name as string, [t.status, t.member_status]]));
    expect(byName).toEqual({
      'owner-key': ['active', 'enabled'], 'alice-key': ['active', 'enabled'], 'bob-key': ['active', 'disabled'],
      'carol-key': ['active', 'removed'], 'unbound-key': ['active', null], 'bob-old-key': ['revoked', 'disabled'],
    });
  });

  test('the text table prints refused for an active token whose member cannot read', async () => {
    const rows = (await auth(['list'])).split('\n');
    const at = rows.find(r => r.startsWith('ID '))!.indexOf('Status');
    const status = (name: string) => rows.find(r => r.includes(` ${name} `))!.slice(at, at + 7).trim();
    expect(status('owner-key')).toBe('active');
    expect(status('alice-key')).toBe('active');
    expect(status('unbound-key')).toBe('active');
    expect(status('bob-key')).toBe('refused');
    expect(status('carol-key')).toBe('refused');
    expect(status('bob-old-key')).toBe('REVOKED');
  });

  test('tokenMemberStatuses skips the member read when no row is bound and names a dangling binding missing', async () => {
    let reads = 0;
    const sql = ((..._args: unknown[]) => { reads++; return Promise.resolve([{ id: 'alice-example', disabled_at: null, tombstoned_at: null }]); }) as unknown as SqlQuery;
    const unbound = await tokenMemberStatuses(sql, [{ member_id: null }]);
    expect(unbound({ member_id: null })).toBeNull();
    expect(reads).toBe(0);
    const bound = await tokenMemberStatuses(sql, [{ member_id: 'alice-example' }, { member_id: 'ghost-example' }]);
    expect(reads).toBe(1);
    expect(bound({ member_id: 'alice-example' })).toBe('enabled');
    expect(bound({ member_id: 'ghost-example' })).toBe('missing');
  });
});
