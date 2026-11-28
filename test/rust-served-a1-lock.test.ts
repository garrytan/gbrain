/**
 * The A1 lock (multi-user lane L3, slice S4; coordinator ruling EMBER-L3-S4-plan, 2026-11-28): S4 serves retrieval reads
 * to a remote caller at in-process parity (ruling Q1-B). For the rows of
 * test/fixtures/served-member-lists/a1-arg-guards.tsv the scope comes from arguments the client chose and no server guard
 * checks them, which is safe only while every principal the brain server admits has the owner's floor. S4 makes no
 * per-user security claim; per-user access must not lift while a1-arg-guards.tsv has rows.
 *
 * 1. Protects: while the file has any row, the code that admits a principal admits only the owner:
 *    - the protocol v3 network admission (served/auth.ts authenticateToken) refuses every principal that is not a listed
 *      owner token with read, write and admin and no narrowing, and the principal it returns has the owner floor (never
 *      a remote floor, never a store-built record);
 *    - no served module builds a principal with a remote floor, and the principal kinds are the two owner kinds;
 *    - a multi-user HTTP session opens only for the owner's own key (principal-session.ts gives the owner-only refusal,
 *      and the store's owner gate in rust/crates/gbrain-store/src/scope.rs refuses any member but the owner member;
 *      test/rust-principal-session.serial.test.ts runs that refusal on a real store).
 *    Every row is a served remote read with no page-id guard, names its hazard in one line, and the rows are sorted and
 *    unique.
 * 2. Fails on: a change that admits a non-owner principal (an OAuth client, a narrowed or unlisted token, a remote floor,
 *    a store-built record, a session for another member) while the file has rows; a row for a member that is not served
 *    or that a page-id guard already checks; a row with no hazard.
 * 3. Seam: the bearer check and the owner list are injected into authenticateToken (no brain is opened); the other
 *    checks read the source files as they are.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { authenticateToken } from '../src/core/rust-engine/served/auth.ts';
import { OWNER_IPC_REMOTE_READS } from '../src/core/rust-engine/owner-ipc/routes.ts';

const ROOT = join(import.meta.dir, '..');
const PIN_FILE = 'test/fixtures/served-member-lists/a1-arg-guards.tsv';
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const lines = read(PIN_FILE).split('\n').filter(line => line !== '' && !line.startsWith('#'));
const [header, ...body] = lines;
const rows = body.map(line => { const [member = '', hazard = '', ...rest] = line.split('\t'); return { member, hazard: hazard.trim(), extra: rest.length }; });
const locked = rows.length > 0;

/** The members the page-id guard table of served/remote-member-policy.ts checks (read from its source). */
function pageIdGuarded(): Set<string> {
  const src = read('src/core/rust-engine/served/remote-member-policy.ts');
  const start = src.indexOf('const PAGE_ID_GUARDS');
  const end = src.indexOf('\n};', start);
  if (start < 0 || end < 0) throw new Error('the PAGE_ID_GUARDS table was not found in served/remote-member-policy.ts');
  return new Set([...src.slice(start, end).matchAll(/^\s+(\w+):/gm)].map(m => m[1]!));
}

describe('the A1 pin file', () => {
  test('has the header, and each row is a served remote read with no page-id guard and a one-line hazard', () => {
    expect(header).toBe('member\thazard');
    const guarded = pageIdGuarded();
    const bad = rows.flatMap(r => [
      ...(OWNER_IPC_REMOTE_READS.has(r.member) ? [] : [`${r.member}: not a served remote read`]),
      ...(guarded.has(r.member) ? [`${r.member}: a page-id guard already checks it`] : []),
      ...(r.hazard === '' ? [`${r.member}: no hazard`] : []),
      ...(r.extra > 0 ? [`${r.member}: more than two columns`] : []),
    ]);
    expect(bad).toEqual([]);
    const names = rows.map(r => r.member);
    expect(names).toEqual([...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
});

describe('while the A1 pin file has rows, only the owner is admitted', () => {
  const OWNER = 'owner-token-id';
  const ownerInfo = { principal: { kind: 'legacy_token', id: OWNER }, scopes: ['read', 'write', 'admin'], sourceId: 'default', hasSourceGrant: false };
  const admit = (info: Record<string, unknown>) => authenticateToken({} as never, 'presented-token', {
    verify: async () => info, ownerIds: async () => new Set([OWNER]),
  });
  const codeOf = (p: Promise<unknown>) => p.then(() => 'admitted', (e: unknown) => String((e as { reason?: string; code?: string }).reason ?? (e as { code?: string }).code));

  test('the v3 network admission refuses every principal that is not a listed, unnarrowed owner token', async () => {
    if (!locked) return; // the lock holds only while the file has rows
    const refusals: Record<string, Record<string, unknown>> = {
      oauth_client: { ...ownerInfo, principal: { kind: 'oauth_client', id: OWNER } },
      unlisted_token: { ...ownerInfo, principal: { kind: 'legacy_token', id: 'someone-else' } },
      read_only: { ...ownerInfo, scopes: ['read'] },
      no_admin: { ...ownerInfo, scopes: ['read', 'write'] },
      source_grant: { ...ownerInfo, hasSourceGrant: true },
      other_source: { ...ownerInfo, sourceId: 'team' },
      allowed_sources: { ...ownerInfo, allowedSources: ['default'] },
      member_bound: { ...ownerInfo, member: { id: 'alice-example', groups: [] } },
      slug_fence: { ...ownerInfo, boundSlugPrefixes: ['notes/'] },
      takes_holders: { ...ownerInfo, takesHoldersAllowList: ['world'] },
      min_trust: { ...ownerInfo, minTrust: 'high' },
      allowed_operations: { ...ownerInfo, allowedOperations: ['search'] },
    };
    const got: Record<string, string> = {};
    for (const [name, info] of Object.entries(refusals)) got[name] = await codeOf(admit(info));
    expect(got).toEqual(Object.fromEntries(Object.keys(refusals).map(name => [name, 'token_not_owner'])));
    const owner = await admit(ownerInfo);
    expect({ kind: owner.kind, floorRemote: owner.floorRemote, record: owner.record }).toEqual({ kind: 'owner_token', floorRemote: false, record: undefined });
  });

  test('the principal kinds are the two owner kinds, and no served module builds a remote floor or a store-built record', () => {
    if (!locked) return; // the lock holds only while the file has rows
    expect(read('src/core/rust-engine/served/auth.ts')).toContain("kind: 'local_owner' | 'owner_token';");
    const dir = 'src/core/rust-engine/served';
    const hits = readdirSync(join(ROOT, dir)).filter(f => f.endsWith('.ts'))
      .filter(f => /floorRemote:\s*true|\brecord:\s*(?!CallerAccess)\w/.test(read(`${dir}/${f}`).replace(/^\s*(\*|\/\/).*$/gm, '')));
    expect(hits).toEqual([]);
  });

  test('a multi-user HTTP session opens only for the owner\'s own key', () => {
    if (!locked) return; // the lock holds only while the file has rows
    expect(read('src/core/rust-engine/principal-session.ts')).toContain("only the brain owner\\'s own key is admitted for now");
    const scope = read('rust/crates/gbrain-store/src/scope.rs');
    expect(scope).toContain('let owner = store.live_owner_member()?.ok_or_else(refused)?;');
    expect(scope).toContain('if principal.member_id.as_deref() != Some(owner.as_str()) {');
  });
});
