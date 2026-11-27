/**
 * BrainEngine parity — the open-page count (engine-sql/access-setup.ts countOpenPages) and the reads
 * access/open-pages.ts and access/owner.ts make around it: the counted members and their bound tokens and clients
 * (readAccessMembers, readAccessCredentials, readJobPrincipal, listOauthClients), the company source a member key reads
 * (filterUnarchivedSourceIds), the access-state read (readAccessStateUnreadable) and the owner write (setOwner).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the count admits only live pages that the empty-identity member-access floor admits (no readable_by
 *    page, no page under a folder rule or a pending prefix) in the asked sources, less each excluded prefix, grouped by
 *    source, top-level folder ('(root)' for a slug with no '/'), type and whether the privacy part admits the page
 *    (a visibility: private page is counted as not visible). openPages counts the members other than the owner that
 *    are enabled, and the sources their live bound tokens and clients read; a disabled member and a revoked token count
 *    for nothing. A
 *    remote caller record around openPages changes nothing, because the count runs outside any caller record. setOwner
 *    names an enabled member. (A labelled-only member is not compared: the Rust store has no labelled-only write, and
 *    test/open-shared-pages.test.ts covers it on the SQL engines.)
 *    Every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1) gives the
 *    same answers.
 *  - Regression: these reads ran through executeRaw, so on a Rust brain gbrain access serves several, doctor
 *    open_shared_pages and repair-propose's open-page scope ended in engine_capability_missing. A count that admits a
 *    restricted page, ignores an excluded prefix or counts a private page as visible says members read pages they do
 *    not; each case puts such a page where the result shows it.
 *  - Why existing coverage misses it: test/open-shared-pages.test.ts runs the count on the SQL engines only, and no
 *    parity case read it.
 *  - Seam: none. Pages, members and credentials are written through the typed members; folder rules and pending
 *    prefixes through the harness fixture.
 */
import { describe, expect } from 'bun:test';
import { createSource, archiveSource, parityArms, restrictFolder } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AccessMemberInsert } from '../../src/core/engine-sql/access-members.ts';
import type { OpenPageCount } from '../../src/core/engine-sql/access-setup.ts';
import { memberKeyReadSources, openPages } from '../../src/core/access/open-pages.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { disableMember } from '../../src/core/access/members.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { hashToken } from '../../src/core/utils.ts';

const { parityTest } = parityArms(testBackends());

const put = (engine: BrainEngine, slug: string, sourceId: string, type = 'note', frontmatter: Record<string, unknown> = {}) =>
  engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `body of ${slug}`, timeline: '', frontmatter }, { sourceId });

function member(id: string, extra: Partial<AccessMemberInsert> = {}): AccessMemberInsert {
  return { id, displayName: null, email: null, kind: 'person', groups: [], bindTokenId: null, ...extra };
}

/** The pages every case writes: open ones, restricted ones, a private one, an excluded one and a deleted one. */
async function seedPages(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
  await createSource(engine, backend, 'team');
  await createSource(engine, backend, 'other');
  await restrictFolder(engine, backend, 'default', 'ruled/', 'rule', { ruleId: 'ruled', readers: ['alice-example'] });
  await restrictFolder(engine, backend, 'default', 'pending/', 'pending');
  await put(engine, 'root-page', 'default');
  await put(engine, 'notes/world-a', 'default');
  await put(engine, 'notes/world-b', 'default');
  await put(engine, 'chats/dm-1', 'default', 'dm');
  await put(engine, 'private/diary', 'default', 'note', { visibility: 'private' });
  await put(engine, 'notes/private-note', 'default', 'note', { visibility: 'private' });
  await put(engine, 'labelled/secret', 'default', 'note', { readable_by: ['alice-example'] });
  await put(engine, 'ruled/plan', 'default');
  await put(engine, 'pending/draft', 'default');
  await put(engine, 'skip/one', 'default');
  await put(engine, 'skip-not/two', 'default');
  await put(engine, 'gone/page', 'default');
  await engine.softDeletePage('gone/page', { sourceId: 'default' });
  await put(engine, 'notes/team-a', 'team');
  await put(engine, 'emails/thread-1', 'team', 'email');
  await put(engine, 'skip/team', 'team');
  await put(engine, 'notes/other-a', 'other');
}

const sorted = (rows: OpenPageCount[]) => [...rows].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);

describe('open-page count and the access reads around it', () => {
  parityTest('the count admits only open live pages of the asked sources, less each excluded prefix, by folder, type and privacy', {
    methods: ['countOpenPages'],
  }, async (engine, backend) => {
    await seedPages(engine, backend);
    const all = sorted(await engine.countOpenPages(['default', 'team'], []));
    const excluded = sorted(await engine.countOpenPages(['default', 'team'], [{ source: 'default', prefix: 'skip/' }, { source: 'nowhere', prefix: 'notes/' }]));
    const none = await engine.countOpenPages([], []);
    const missing = await engine.countOpenPages(['nowhere'], []);
    const row = (source: string, folder: string, type: string, visible: boolean, pages: number) => ({ source, folder, type, visible, pages });
    const expected = [
      row('default', '(root)', 'note', true, 1), row('default', 'chats', 'dm', true, 1), row('default', 'notes', 'note', false, 1),
      row('default', 'notes', 'note', true, 2), row('default', 'private', 'note', false, 1), row('default', 'skip', 'note', true, 1),
      row('default', 'skip-not', 'note', true, 1), row('team', 'emails', 'email', true, 1), row('team', 'notes', 'note', true, 1),
      row('team', 'skip', 'note', true, 1),
    ];
    expect(all).toEqual(sorted(expected));
    expect(excluded).toEqual(sorted(expected.filter(r => !(r.source === 'default' && r.folder === 'skip'))));
    expect(none).toEqual([]);
    expect(missing).toEqual([]);
    return { all, excluded, none, missing };
  });

  parityTest('the count asked inside a remote caller record answers the same on every engine', {
    methods: ['countOpenPages'],
  }, async (engine, backend) => {
    await seedPages(engine, backend);
    const outside = sorted(await engine.countOpenPages(['default'], []));
    const inside = sorted(await withCallerAccess({ identity: ['member:alice-example'], owner: false, applyRemoteReadPolicy: true, hidePrivate: true },
      () => engine.countOpenPages(['default'], [])));
    return { outside, inside };
  });

  // Inside a caller record the floor reads the record's folder coverage and openPageSql adds the live pending prefixes:
  // a page under either is not open. The Rust arm once refused every count asked inside a record.
  parityTest('the count inside a caller record hides pages under its folder coverage and under a live pending prefix', {
    methods: ['countOpenPages'],
  }, async (engine, backend) => {
    await seedPages(engine, backend);
    const inside = sorted(await withCallerAccess({ identity: [], owner: false, applyRemoteReadPolicy: true, hidePrivate: true,
      folderCoverage: [{ source_id: 'default', prefix: 'notes/' }] }, () => engine.countOpenPages(['default'], [])));
    const folders = [...new Set(inside.map(r => r.folder))].sort();
    expect(folders).toEqual(['(root)', 'chats', 'private', 'skip', 'skip-not']);
    return inside;
  });

  parityTest('openPages counts enabled members and the sources their live keys read, the same under a remote caller', {
    methods: ['countOpenPages', 'readAccessMembers', 'readAccessCredentials', 'readJobPrincipal', 'listOauthClients', 'readAccessStateUnreadable', 'insertAccessMember', 'insertAccessToken', 'insertOauthClient', 'writeCredentialBinding', 'revokeAccessTokenById'],
  }, async (engine, backend) => {
    await seedPages(engine, backend);
    // A read key on one source: the scalar grant columns and the legacy permissions agree, so the grant has no drift.
    const token = async (name: string, sourceId: string) => (await engine.insertAccessToken({
      name, token_hash: hashToken(`h-${name}`), scopes: ['read'], permissions: { source_id: sourceId }, source_grant: 'scalar', source_id: sourceId,
      federated_read: null, allowed_operations: null, takes_holders: null,
    })).id;
    const client = (id: string, sourceId: string) => engine.insertOauthClient({
      client_id: id, client_secret_hash: null, client_name: id, redirect_uris: [], grant_types: ['authorization_code'], scope: 'read',
      token_endpoint_auth_method: 'none', client_id_issued_at: 0, source_id: sourceId,
    });
    const bindClient = (id: string, to: string) => engine.transaction(tx => tx.writeCredentialBinding({ kind: 'client', id },
      { member: to, mayActFor: null, attestActor: null, attestOps: null, attestSources: null, attestRead: null }));
    await engine.insertAccessMember(member('owner-example'));
    await engine.insertAccessMember(member('alice-example', { bindTokenId: await token('alice-key', 'default') }));
    await engine.insertAccessMember(member('bob-example'));
    await client('bob-client', 'team');
    await bindClient('bob-client', 'bob-example');
    const daveKey = await token('dave-key', 'other');
    await engine.insertAccessMember(member('dave-example', { bindTokenId: daveKey }));
    await engine.insertAccessMember(member('erin-example', { bindTokenId: await token('erin-key', 'other') }));
    await disableMember(engine, 'erin-example');
    const before = await openPages(engine);
    await engine.revokeAccessTokenById(daveKey);
    await setOwner(engine, 'owner-example');
    const after = await openPages(engine);
    const remote = await withCallerAccess({ identity: ['member:alice-example'], owner: false, applyRemoteReadPolicy: true, hidePrivate: true }, () => openPages(engine));
    const excluded = await openPages(engine, { exclude: [{ source: 'default', prefix: 'notes/' }] });
    expect(before.sources).toEqual(['default', 'other', 'team']);
    expect(after.sources).toEqual(['default', 'team']);
    expect(after.owner).toBe('owner-example');
    expect(after.members).toEqual({ reading: 2, counted: 3 });
    expect(remote).toEqual(after);
    expect(excluded.total).toBe(after.total - 2);
    return { before, after, remote, excluded };
  });

  parityTest('setOwner names an enabled member, and a member key reads the company source while it is unarchived', {
    methods: ['readAccessMembers', 'filterUnarchivedSourceIds', 'insertAccessMember'],
  }, async (engine, backend) => {
    await engine.insertAccessMember(member('alice-example'));
    const owner = (await setOwner(engine, 'alice-example')).owner;
    const without = await memberKeyReadSources(engine, 'default');
    await createSource(engine, backend, 'company');
    const withCompany = await memberKeyReadSources(engine, 'default');
    const fromCompany = await memberKeyReadSources(engine, 'company');
    await archiveSource(engine, backend, 'company');
    const archived = await memberKeyReadSources(engine, 'default');
    expect(owner).toBe('alice-example');
    expect(withCompany).toEqual([...without.slice(0, 1), 'company', ...without.slice(1).filter(s => s !== 'company')]);
    expect(archived).not.toContain('company');
    return { owner, without, withCompany, fromCompany, archived };
  });
});
