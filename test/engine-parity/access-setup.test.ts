/**
 * BrainEngine parity — the access setup and policy-store members outside access/policy.ts (engine-sql/access-setup.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the member-key setup reads (unbound tokens and clients, the live key by name, keys that read a source),
 *    the source and page counts `gbrain access` setup and serves read, the policy-store sources and the policy-store
 *    migration journal answer the same on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1). A brain with no access tokens has nothing unbound, no live key and no key reading a
 *    source, and a token write on it changes none of that. With minted tokens and registered clients, the unbound
 *    names and ids sort in byte order (names that differ only by '-', '.', '_' and a letter), the live key by name
 *    carries its hash and grant, the setup read list lands in its permissions beside the other fields, and a revoke
 *    by id takes the key out of every read.
 *  - Regression: a member that differs changes what `gbrain access setup` offers to bind, counts the wrong company or
 *    people pages, misses a source with access state on export, or resumes the wrong policy-store migration (or none),
 *    so a half-done store switch is left half done.
 *  - Why existing coverage misses it: the callers ran every statement through `executeRaw`, which the Rust engine
 *    refuses and the parity cases cannot call (D18), so no case compared these reads.
 *  - Seam: none. Generated values (migration timestamps) are not read.
 */
import { describe, expect } from 'bun:test';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { hashToken } from '../../src/core/utils.ts';

const { parityTest } = parityArms(testBackends());

const page = (engine: BrainEngine, slug: string, sourceId: string) =>
  engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}`, timeline: '' }, { sourceId });

describe('access setup members (engine-sql/access-setup.ts)', () => {
  parityTest('a brain with no access tokens has no unbound key or client, no live key and no key reading a source', { methods: ['listUnboundTokenNames', 'listUnboundClientIds', 'readLiveAccessToken', 'listKeysReadingSource', 'recordTokenSetupReads', 'revokeAccessTokenById'] }, async (engine) => {
    const read = async () => ({
      tokens: await engine.listUnboundTokenNames(), clients: await engine.listUnboundClientIds(),
      live: await engine.readLiveAccessToken('alice-key'), reading: await engine.listKeysReadingSource('default'),
    });
    const before = await read();
    await engine.recordTokenSetupReads('alice-key', ['default']);
    await engine.revokeAccessTokenById('00000000-0000-0000-0000-000000000000');
    const after = await read();
    const none = { tokens: [], clients: [], live: null, reading: [] };
    expect(before).toEqual(none);
    expect(after).toEqual(none);
    return { before, after };
  });

  parityTest('minted keys and registered clients: unbound names in byte order, the live key by name, its setup reads and a revoke by id', { methods: ['insertAccessToken', 'insertOauthClient', 'listUnboundTokenNames', 'listUnboundClientIds', 'readLiveAccessToken', 'listKeysReadingSource', 'recordTokenSetupReads', 'revokeAccessTokenById', 'revokeAccessTokensNamed'] }, async (engine) => {
    const grant = { source_grant: 'federated', source_id: 'default', federated_read: ['default', 'b-c'], allowed_operations: null, takes_holders: ['world'] };
    const mint = (name: string, extra: Record<string, unknown> = {}) =>
      engine.insertAccessToken({ name, token_hash: hashToken(`h-${name}`), scopes: ['read', 'write'], permissions: { keep: 1 }, ...grant, ...extra });
    for (const name of ['ab', 'a_b', 'a-z']) await mint(name);
    const dotted = await mint('a.b');
    await mint('gone');
    await engine.revokeAccessTokensNamed('gone');
    await mint('elsewhere', { source_id: 'b-c', federated_read: ['default'] });
    for (const id of ['ab', 'a_b', 'a.b', 'a-z']) await engine.insertOauthClient({ client_id: id, client_name: `Client ${id}` });
    await engine.insertOauthClient({ client_id: 'a-deleted', client_name: 'Deleted', deleted_at: new Date('2026-01-01T00:00:00.000Z') });
    await engine.insertOauthClient({ client_id: 'a-bound', client_name: 'Bound', member_id: 'alice-example' });
    const live = async (name: string) => {
      const row = await engine.readLiveAccessToken(name);
      return row && { ...row, federated_read: Array.isArray(row.federated_read) ? row.federated_read : String(row.federated_read) };
    };
    const before = {
      tokens: await engine.listUnboundTokenNames(), clients: await engine.listUnboundClientIds(),
      key: await live('a-z'), gone: await live('gone'), reading: await engine.listKeysReadingSource('b-c'),
    };
    expect(before.tokens).toEqual(['a-z', 'a.b', 'a_b', 'ab', 'elsewhere']);
    expect(before.clients).toEqual(['a-z', 'a.b', 'a_b', 'ab']);
    expect(before.key).toEqual({ member_id: null, token_hash: hashToken('h-a-z'), source_grant: 'federated', source_id: 'default', federated_read: ['default', 'b-c'], permissions: { keep: 1 } });
    expect(before.gone).toBeNull();
    expect(before.reading).toEqual([]);
    await engine.recordTokenSetupReads('a-z', ['default', 'b-c']);
    await engine.recordTokenSetupReads('gone', ['default']);
    await engine.revokeAccessTokenById(dotted.id);
    const after = { tokens: await engine.listUnboundTokenNames(), key: await live('a-z'), dotted: await live('a.b'), gone: await live('gone') };
    expect(after.tokens).toEqual(['a-z', 'a_b', 'ab', 'elsewhere']);
    expect(after.key?.permissions).toEqual({ keep: 1, setup_reads: ['default', 'b-c'] });
    expect(after.dotted).toBeNull();
    expect(after.gone).toBeNull();
    return { before, after };
  });

  parityTest('the unarchived ids are the asked sources that exist and are not archived', { methods: ['filterUnarchivedSourceIds'] }, async (engine, backend) => {
    for (const id of ['alpha', 'beta', 'gamma']) await createSource(engine, backend, id);
    await archiveSource(engine, backend, 'beta');
    const ids = (await engine.filterUnarchivedSourceIds(['alpha', 'beta', 'missing', 'default'])).sort();
    const none = await engine.filterUnarchivedSourceIds([]);
    expect(ids).toEqual(['alpha', 'default']);
    expect(none).toEqual([]);
    return { ids, none };
  });

  parityTest('the company counts are the live pages of the source and those under company/calls/', { methods: ['countCompanyPages'] }, async (engine, backend) => {
    await createSource(engine, backend, 'company');
    await createSource(engine, backend, 'other');
    for (const slug of ['company/acme-example', 'company/calls/2026-04-03', 'company/calls/2026-04-10', 'company/callsheet', 'people/alice-example']) await page(engine, slug, 'company');
    await engine.softDeletePage('company/calls/2026-04-10', { sourceId: 'company' });
    await page(engine, 'company/calls/elsewhere', 'other');
    const counts = { company: await engine.countCompanyPages('company'), other: await engine.countCompanyPages('other'), empty: await engine.countCompanyPages('missing') };
    expect(counts).toEqual({ company: { pages: 4, calls: 1 }, other: { pages: 1, calls: 1 }, empty: { pages: 0, calls: 0 } });
    return counts;
  });

  parityTest('the people folders are the live pages of each people/<folder>/ across every source', { methods: ['countPeopleFolderPages'] }, async (engine, backend) => {
    await createSource(engine, backend, 'team');
    await page(engine, 'people/alice-example', 'default');
    await page(engine, 'people/family/charlie-example', 'default');
    await page(engine, 'people/family/a-founder', 'default');
    await page(engine, 'people/work/deep/alice-example', 'default');
    await page(engine, 'people/work/widget-co', 'team');
    await page(engine, 'people/work/gone', 'team');
    await engine.softDeletePage('people/work/gone', { sourceId: 'team' });
    await page(engine, 'notes/people/x/y', 'team');
    // Mixed ids sort by byte ('-' before letters), as PGLite and the store do; an en_US collation puts 'ab' first.
    await createSource(engine, backend, 'a-z');
    await createSource(engine, backend, 'ab');
    for (const [slug, sourceId] of [['people/ab/x', 'a-z'], ['people/a-z/x', 'a-z'], ['people/ab/y', 'ab']]) await page(engine, slug, sourceId);
    const folders = await engine.countPeopleFolderPages();
    expect(folders).toEqual([
      { source_id: 'a-z', folder: 'a-z', pages: 1 },
      { source_id: 'a-z', folder: 'ab', pages: 1 },
      { source_id: 'ab', folder: 'ab', pages: 1 },
      { source_id: 'default', folder: 'family', pages: 2 },
      { source_id: 'default', folder: 'work', pages: 1 },
      { source_id: 'team', folder: 'work', pages: 1 },
    ]);
    return folders;
  });

  parityTest('the policy-store sources are the sources with access state, by id', { methods: ['listAccessPolicySources'] }, async (engine, backend) => {
    const before = await engine.listAccessPolicySources();
    for (const id of ['work', 'home', 'open', 'ab', 'a-z']) await createSource(engine, backend, id);
    for (const id of ['work', 'ab', 'home', 'a-z']) await engine.ensureAccessPolicyState(id);
    const after = await engine.listAccessPolicySources();
    expect(before).toEqual([]);
    // By byte: 'a-z' before 'ab' on every arm, whatever the Postgres collation.
    expect(after).toEqual(['a-z', 'ab', 'home', 'work']);
    return { before, after };
  });

  parityTest('a policy-store migration is unfinished from its start until it switches', { methods: ['readUnfinishedAccessMigration', 'insertAccessMigration', 'recordAccessMigrationPhase', 'switchAccessMigration'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await engine.ensureAccessPolicyState('work');
    const none = await engine.readUnfinishedAccessMigration('work');
    await engine.insertAccessMigration('mig-1', 'work', 'to_git');
    const started = await engine.readUnfinishedAccessMigration('work');
    await engine.recordAccessMigrationPhase('mig-1', 'exported', { exported: 2, desired_hash: 'abc' });
    const exported = await engine.readUnfinishedAccessMigration('work');
    const other = await engine.readUnfinishedAccessMigration('default');
    await engine.switchAccessMigration('mig-1', { exported: 2, desired_hash: 'abc', switched: true });
    const switched = await engine.readUnfinishedAccessMigration('work');
    const refused = await engine.insertAccessMigration('mig-2', 'default', 'to_git').then(() => 'inserted', () => 'refused');
    expect(none).toBeNull();
    expect(started).toEqual({ id: 'mig-1', phase: 'started', direction: 'to_git', receipts: {} });
    expect(exported).toEqual({ id: 'mig-1', phase: 'exported', direction: 'to_git', receipts: { exported: 2, desired_hash: 'abc' } });
    expect(other).toBeNull();
    expect(switched).toBeNull();
    expect(refused).toBe('refused');
    return { none, started, exported, other, switched, refused };
  });
});
