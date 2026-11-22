/**
 * BrainEngine parity — the access reports: the open-page count (countOpenPages) and the reads around it in
 * access/open-pages.ts (readAccessStateUnreadable, listSourceIds), gbrain access serves (servesStatus), doctor
 * open_shared_pages, and gbrain access who-can-read (listWhoCanReadPages).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the count admits only live pages that the empty-identity member-access floor admits (no readable_by
 *    page, no owner-only page, no page under an applied folder rule) in the asked sources, less each
 *    excluded prefix, grouped by source, top-level folder ('(root)' for a slug with no '/'), type and whether the
 *    privacy part admits the page (a visibility: private page counts as not visible). With no member, openPages counts
 *    every source, archived ones too, in byte order. who-can-read lists each source's row of the slug (a soft-deleted
 *    row too) and says who reads it: every source reader for an open page, the readable_by members for a labelled one,
 *    nobody but the owner for an owner-only one, and not_found for a missing slug. Every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1) gives the same answers.
 *  - Regression: these reads ran through executeRaw, so on a Rust brain gbrain access serves, gbrain access
 *    who-can-read and doctor open_shared_pages ended in engine_capability_missing. A count that admits a restricted
 *    page, ignores an excluded prefix or counts a private page as visible says members read pages they do not; each
 *    case puts such a page where the result shows it.
 *  - Why existing coverage misses it: test/open-shared-pages.test.ts and test/access-who-can-read-owner-only.test.ts
 *    run on the SQL engines only, and the reads-privacy parity case stops at its member writes on Rust.
 *  - Seam: none. Pages, sources and config are written through typed members and the harness fixtures; the folder
 *    rule case uses the harness restrictFolder fixture, which stops on the Rust arm's raw_sql refusal (no rule store).
 *  - Known loss on Rust (docs/designs/RUST_ENGINE.md, "Open before rust can be selected"): gbrain access serves
 *    several. The last describe pins its exact refusal text, so the pin fails when Rust stops refusing and its row
 *    must leave the table. Member writes are served (test/engine-parity/access-members.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import { archiveSource, createSource, parityArms, resetArm, restrictFolder, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OpenPageCount } from '../../src/core/engine-sql/access-setup.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { openPages, readOpenPages } from '../../src/core/access/open-pages.ts';
import { whoCanRead } from '../../src/commands/access.ts';
import { servesStatus } from '../../src/commands/access-serves.ts';
import { openSharedPagesEntry } from '../../src/commands/doctor/checks/open-shared-pages.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import { schemaVersionNow, withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { addMember } from '../../src/core/access/members.ts';
import { folderAccessFor } from '../../src/core/access/caller.ts';
import { proposeRevision } from '../../src/core/access/policy.ts';
import { identityFor } from '../../src/core/access/principals.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';

const { parityTest, arms } = parityArms(testBackends());

const put = (engine: BrainEngine, slug: string, sourceId: string, type = 'note', frontmatter: Record<string, unknown> = {}) =>
  engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `body of ${slug}`, timeline: '', frontmatter }, { sourceId });

/** The pages the count cases write: open ones, a labelled one, private ones, an owner-only one, an excluded one and a deleted one. */
async function seedPages(engine: BrainEngine, backend: ParityBackend, beforePages?: () => Promise<void>): Promise<void> {
  await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
  await createSource(engine, backend, 'team');
  await createSource(engine, backend, 'other');
  await createSource(engine, backend, 'imsg', { kind: 'imessage' });
  // A page write stamps the folder rules that cover it, so rules go in before the pages.
  await beforePages?.();
  await put(engine, 'root-page', 'default');
  await put(engine, 'notes/world-a', 'default');
  await put(engine, 'notes/world-b', 'default');
  await put(engine, 'chats/dm-1', 'default', 'dm');
  await put(engine, 'private/diary', 'default', 'note', { visibility: 'private' });
  await put(engine, 'notes/private-note', 'default', 'note', { visibility: 'private' });
  await put(engine, 'labelled/secret', 'default', 'note', { readable_by: ['alice-example'] });
  await put(engine, 'skip/one', 'default');
  await put(engine, 'skip-not/two', 'default');
  await put(engine, 'gone/page', 'default');
  await engine.softDeletePage('gone/page', { sourceId: 'default' });
  await put(engine, 'notes/team-a', 'team');
  await put(engine, 'emails/thread-1', 'team', 'email');
  await put(engine, 'skip/team', 'team');
  await put(engine, 'notes/other-a', 'other');
  await put(engine, 'chats/imsg-1', 'imsg', 'dm');
}

/**
 * Run `fn` as withOpenScope runs the count: in a caller record that carries only the brain's schema version (and,
 * for the remote-caller case, a member identity). Without the version the owner-only test takes its closed form, and
 * on a brain with an owner-only source every page reads as owner-only.
 */
async function inOpenScope<T>(engine: BrainEngine, fn: () => Promise<T>, caller: Record<string, unknown> = {}): Promise<T> {
  const remotePolicy = { privacyRelaxed: false, restricted: true, ...await schemaVersionNow(engine) };
  return withCallerAccess({ ...caller, remotePolicy } as never, fn);
}

const byJson = (rows: OpenPageCount[]) => [...rows].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
const row = (source: string, folder: string, type: string, visible: boolean, pages: number): OpenPageCount => ({ source, folder, type, visible, pages });
/** What the count gives for default and team after seedPages. */
const SEEDED = [
  row('default', '(root)', 'note', true, 1), row('default', 'chats', 'dm', true, 1), row('default', 'notes', 'note', false, 1),
  row('default', 'notes', 'note', true, 2), row('default', 'private', 'note', false, 1), row('default', 'skip', 'note', true, 1),
  row('default', 'skip-not', 'note', true, 1), row('team', 'emails', 'email', true, 1), row('team', 'notes', 'note', true, 1),
  row('team', 'skip', 'note', true, 1),
];

describe('the open-page count', () => {
  parityTest('the count admits only open live pages of the asked sources, less each excluded prefix, by folder, type and privacy', {
    methods: ['countOpenPages', 'putPage', 'softDeletePage'],
  }, async (engine, backend) => {
    await seedPages(engine, backend);
    const count = (sources: string[], exclude: Array<{ source: string; prefix: string }> = []) => inOpenScope(engine, () => engine.countOpenPages(sources, exclude));
    const all = byJson(await count(['default', 'team']));
    const excluded = byJson(await count(['default', 'team'], [{ source: 'default', prefix: 'skip/' }, { source: 'nowhere', prefix: 'notes/' }]));
    const ownerOnly = await count(['imsg']);
    const none = await count([]);
    const missing = await count(['nowhere']);
    // Outside any caller record the owner-only test takes its closed form: every page reads as owner-only.
    const closed = await engine.countOpenPages(['default', 'team'], []);
    expect(closed).toEqual([]);
    expect(all).toEqual(byJson(SEEDED));
    expect(excluded).toEqual(byJson(SEEDED.filter(r => !(r.source === 'default' && r.folder === 'skip'))));
    expect(ownerOnly).toEqual([]);
    expect(none).toEqual([]);
    expect(missing).toEqual([]);
    return { all, excluded, ownerOnly, none, missing, closed };
  });

  // Every arm writes the rule through the typed policy members (rust/docs/store/access_rules.md on Rust).
  parityTest('the count leaves out a page under an applied folder rule', {
    methods: ['countOpenPages', 'ensureAccessPolicyState', 'applyAccessRuleChanges'],
  }, async (engine, backend) => {
    await seedPages(engine, backend, () => restrictFolder(engine, backend, 'default', 'notes/', 'rule'));
    const all = byJson(await inOpenScope(engine, () => engine.countOpenPages(['default', 'team'], [])));
    expect(all).toEqual(byJson(SEEDED.filter(r => !(r.source === 'default' && r.folder === 'notes'))));
    return all;
  });

  parityTest('the count asked inside a member caller record answers as it does in the open-scope record', {
    methods: ['countOpenPages'],
  }, async (engine, backend) => {
    await seedPages(engine, backend);
    const outside = byJson(await inOpenScope(engine, () => engine.countOpenPages(['default'], [])));
    const inside = byJson(await inOpenScope(engine, () => engine.countOpenPages(['default'], []),
      { identity: ['member:alice-example'], owner: false, applyRemoteReadPolicy: true, hidePrivate: true }));
    expect(outside).toEqual(byJson(SEEDED.filter(r => r.source === 'default')));
    expect(inside).toEqual(outside);
    return { outside, inside };
  });

  parityTest('the access state reads as readable, and every source id lists in byte order with archived ones', {
    methods: ['readAccessStateUnreadable', 'listSourceIds'],
  }, async (engine, backend) => {
    for (const id of ['team', 'a-src', 'z-old', 'b-1']) await createSource(engine, backend, id);
    await archiveSource(engine, backend, 'z-old');
    const unreadable = await engine.readAccessStateUnreadable();
    const ids = await engine.listSourceIds();
    expect(unreadable).toBe(false);
    expect(ids).toEqual(['a-src', 'b-1', 'default', 'team', 'z-old']);
    return { unreadable, ids };
  });
});

describe('the reports built on the count, on a brain with no member', () => {
  parityTest('openPages counts every source when no member reads one, the same under a remote caller and less an excluded prefix', {
    methods: ['countOpenPages', 'readAccessMembers', 'listAccessTokens', 'listOauthClients', 'readAccessStateUnreadable', 'listSourceIds'],
  }, async (engine, backend) => {
    await seedPages(engine, backend);
    await createSource(engine, backend, 'old');
    await put(engine, 'notes/old-a', 'old');
    await archiveSource(engine, backend, 'old');
    const all = await openPages(engine);
    const remote = await withCallerAccess({ identity: ['member:alice-example'], owner: false, applyRemoteReadPolicy: true, hidePrivate: true }, () => openPages(engine));
    const excluded = await openPages(engine, { exclude: [{ source: 'default', prefix: 'notes/' }] });
    expect(all.owner).toBeNull();
    expect(all.members).toEqual({ reading: 0, counted: 0 });
    expect(all.sources).toEqual(['default', 'imsg', 'old', 'other', 'team']);
    // default 6 open (2 private kept from members), team 3, other 1, old 1; imsg's page is owner-only.
    expect({ total: all.total, private: all.private, sensitive: all.sensitive }).toEqual({ total: 11, private: 2, sensitive: 2 });
    expect(remote).toEqual(all);
    expect(excluded.total).toBe(all.total - 2);
    return { all, remote, excluded };
  });

  parityTest('gbrain access serves and doctor open_shared_pages report the open pages once the brain serves several people', {
    methods: ['countOpenPages', 'listActiveAccessMembers', 'getConfig', 'setConfig'],
  }, async (engine, backend) => {
    await seedPages(engine, backend);
    const doctor = async (remote: boolean) => (await openSharedPagesEntry.run({ engine, remote } as unknown as DoctorContext) as unknown as Array<Record<string, unknown>>)[0]!;
    const one = { status: await servesStatus(engine), doctor: await doctor(false) };
    // The SQL engines stamp access.serves_since when the brain first serves several people; a fixed value set first is kept.
    await engine.setConfig('access.serves_since', '2026-01-02T03:04:05.000000Z');
    await engine.setConfig('access.serves', 'several');
    const several = { status: await servesStatus(engine), read: await readOpenPages(engine), doctor: await doctor(false), remote: await doctor(true) };
    expect(one.status).toMatchObject({ serves: 'one', owner: null, stdio_member: null, enabled_members: [] });
    expect(one.doctor).toMatchObject({ name: 'open_shared_pages', status: 'ok', readiness_state: 'not_applicable' });
    expect(several.status).toMatchObject({ serves: 'several', from: 'config', since: '2026-01-02T03:04:05.000000Z' });
    expect((several.status as { open_pages?: { total: number } }).open_pages?.total).toBe(10);
    expect(several.read.open_pages?.total).toBe(10);
    expect(several.doctor).toMatchObject({ name: 'open_shared_pages', status: 'ok', severity: 'info' });
    expect(several.remote).toMatchObject({ details: { total: 10, sensitive: 2, members: { reading: 0, counted: 0 } } });
    return { one, several };
  });

  parityTest('who-can-read names who reads an open, a labelled, a private, an owner-only and a deleted page, and a missing slug is not_found', {
    methods: ['listWhoCanReadPages', 'putPage', 'setConfig'],
  }, async (engine, backend) => {
    await seedPages(engine, backend);
    await put(engine, 'labelled/secret', 'team', 'note', { readable_by: ['bob-example'] });
    const report = async (slug: string, source?: string) => {
      try {
        return await whoCanRead(engine, slug, source);
      } catch (error) {
        return { code: (error as { code?: string }).code, message: (error as Error).message };
      }
    };
    const open = await report('notes/world-a');
    const labelled = await report('labelled/secret');
    const labelledTeam = await report('labelled/secret', 'team');
    const priv = await report('private/diary');
    const ownerOnly = await report('chats/imsg-1', 'imsg');
    const deleted = await report('gone/page');
    const missing = await report('nowhere/page');
    const missingInSource = await report('notes/world-a', 'team');
    const who = (r: unknown) => (r as Array<{ source_id: string; members: unknown; readers: unknown; private: boolean }>).map(e => [e.source_id, e.members, e.readers, e.private]);
    expect(who(open)).toEqual([['default', 'every_source_reader', null, false]]);
    expect(who(labelled)).toEqual([['default', [], ['member:alice-example'], false], ['team', [], ['member:bob-example'], false]]);
    expect(who(labelledTeam)).toEqual([['team', [], ['member:bob-example'], false]]);
    expect(who(priv)).toEqual([['default', 'every_source_reader', null, true]]);
    expect(who(ownerOnly)).toEqual([['imsg', [], null, false]]);
    expect(who(deleted)).toEqual([['default', 'every_source_reader', null, false]]);
    expect(missing).toEqual({ code: 'not_found', message: 'No page "nowhere/page".' });
    expect(missingInSource).toEqual({ code: 'not_found', message: 'No page "notes/world-a" in source team.' });
    return { open, labelled, labelledTeam, priv, ownerOnly, deleted, missing, missingInSource };
  });
});

/**
 * readPageAdmitsCaller as whoCanRead calls it: one page row, one member's identity, in that member's caller record
 * (satisfied folder rules and coverage, owner flag, restricted). bob is the owner; the record of each member also
 * carries a pending prefix `pend/` in source `default`. Each row is [alice, bob].
 */
async function admits(engine: BrainEngine, backend: ParityBackend): Promise<Record<string, boolean[]>> {
  await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
  await addMember(engine, 'alice-example', { groups: ['team-a'] });
  await addMember(engine, 'bob-example');
  await createSource(engine, backend, 'imsg', { kind: 'imessage' });
  await proposeRevision(engine, 'default', [{ id: 'deals', prefix: 'deals/', readable_by: ['member:alice-example'] }, { id: 'ops', prefix: 'ops/', readable_by: ['member:bob-example'] }], { origin: 'cli', store: 'database' });
  const pages: Array<[string, string, Record<string, unknown>?]> = [['default', 'notes/open'], ['default', 'notes/alice-only', { readable_by: ['alice-example'] }],
    ['default', 'notes/bob-only', { readable_by: ['bob-example'] }], ['default', 'notes/team', { readable_by: ['group:team-a'] }], ['default', 'deals/q4'], ['default', 'ops/plan'],
    ['default', 'pend/x'], ['imsg', 'chats/dm'], ['default', 'gone/page']];
  for (const [source, slug, frontmatter] of pages) await put(engine, slug, source, 'note', frontmatter);
  await engine.softDeletePage('gone/page', { sourceId: 'default' });
  const remotePolicy = { privacyRelaxed: false, restricted: true, ...await schemaVersionNow(engine) };
  const out: Record<string, boolean[]> = {};
  for (const [source, slug] of [...pages.map(p => [p[0], p[1]] as const), ['default', 'nowhere/page'] as const]) {
    out[`${source}:${slug}`] = [];
    for (const [id, groups] of [['alice-example', ['team-a']], ['bob-example', []]] as const) {
      const identity = identityFor(id, groups);
      const folder = await folderAccessFor(engine, identity);
      const record = { identity, ...folder, folderCoverage: [...folder.folderCoverage, { source_id: 'default', prefix: 'pend/' }], restricted: true, owner: id === 'bob-example', remotePolicy };
      out[`${source}:${slug}`]!.push(await withCallerAccess(record as never, () => engine.readPageAdmitsCaller(source, slug, identity)));
    }
  }
  // An identity argument that is not the record's own (here a principal listed twice) gets no satisfied rule: SQL's
  // satisfiedFor compares it with the record's identity, so a folder page stays closed even in a record whose rules
  // admit it. Row: [bob's own argument doubled in bob's record on his ops/ page, alice's own argument doubled on deals/].
  const record = async (id: string, groups: readonly string[]) => {
    const identity = identityFor(id, groups);
    return { identity, ...await folderAccessFor(engine, identity), restricted: true, owner: id === 'bob-example', remotePolicy };
  };
  out['duplicate identity'] = [
    await withCallerAccess(await record('bob-example', []) as never, () => engine.readPageAdmitsCaller('default', 'ops/plan', ['member:bob-example', 'member:bob-example'])),
    await withCallerAccess(await record('alice-example', ['team-a']) as never, () => engine.readPageAdmitsCaller('default', 'deals/q4', ['member:alice-example', 'member:alice-example', 'group:team-a'])),
  ];
  return out;
}

const ADMITS = {
  'default:notes/open': [true, true], 'default:notes/alice-only': [true, false], 'default:notes/bob-only': [false, true], 'default:notes/team': [true, false],
  'default:deals/q4': [true, false], 'default:ops/plan': [false, true], 'default:pend/x': [false, false], 'imsg:chats/dm': [false, true],
  'default:gone/page': [true, true], 'default:nowhere/page': [false, false], 'duplicate identity': [false, false],
};

describe('one page row against one member\'s member-access floor', () => {
  parityTest('readPageAdmitsCaller admits an open, a named, a group, a satisfied-rule and an owner-only page for those who meet it, and no one for a pending prefix or a missing page', {
    methods: ['readPageAdmitsCaller', 'putPage', 'softDeletePage', 'applyAccessRuleChanges'],
  }, async (engine, backend) => {
    const result = await admits(engine, backend);
    expect(result).toEqual(ADMITS);
    return result;
  });

  // A parity case counts a typed refusal as a pass, so this reads the Rust arm's own engine: red while the member refuses.
  test('the Rust arm answers readPageAdmitsCaller as PGLite does, and refuses a caller whose floor it cannot match', async () => {
    const rust = arms().find(arm => arm.backend === 'rust');
    if (!rust) return;
    await resetArm(rust);
    expect(await admits(rust.engine, 'rust')).toEqual(ADMITS);
    const open = await withCallerAccess({ identity: ['member:alice-example'], restricted: false } as never, () => rust.engine.readPageAdmitsCaller('default', 'notes/open', ['member:alice-example']).catch(e => (e as { code?: string }).code));
    expect(open).toBe('engine_capability_missing');
  });
});

describe('get_page as of a date, for a member a folder rule does not name', () => {
  // Pins the public handler's live-page check for an older edition under a folder rule: dan gets no edition of deals/q4.
  parityTest('a member a folder rule does not name gets page_not_found as of any date', { methods: ['putPage', 'createVersion'] }, async (engine) => {
    await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
    for (const id of ['alice-example', 'bob-example', 'dan-example']) await addMember(engine, id);
    const edition = (title: string, valid_from: string) => ({ type: 'note' as const, title, compiled_truth: `body canary-${title}`, timeline: '', frontmatter: { valid_from } });
    await engine.putPage('deals/q4', edition('March', '2026-01-01'), { sourceId: 'default' });
    await engine.createVersion('deals/q4', { sourceId: 'default', reason: 'repriced' });
    await engine.putPage('deals/q4', edition('July', '2026-06-01'), { sourceId: 'default' });
    await proposeRevision(engine, 'default', [{ id: 'deals', prefix: 'deals/', readable_by: ['member:alice-example', 'member:bob-example'] }], { origin: 'cli', store: 'database' });
    const asOf = async (member: string, as_of: string) => {
      await engine.setConfig('mcp.stdio_member', member);
      const r = await dispatchToolCall(engine, 'get_page', { slug: 'deals/q4', as_of }, { remote: true, transport: 'stdio', sourceId: 'default' }) as { isError?: boolean; content: Array<{ text: string }> };
      const text = r.content.map(c => c.text).join('');
      return { error: r.isError === true, code: r.isError ? JSON.parse(text).error?.code ?? JSON.parse(text).code : undefined, march: text.includes('canary-March'), july: text.includes('canary-July') };
    };
    const seen = { danMarch: await asOf('dan-example', '2026-03-01'), danJuly: await asOf('dan-example', '2026-07-01'), bobMarch: await asOf('bob-example', '2026-03-01'), bobJuly: await asOf('bob-example', '2026-07-01') };
    const none = { error: true, code: 'page_not_found', march: false, july: false };
    expect(seen).toEqual({ danMarch: none, danJuly: none, bobMarch: { error: false, code: undefined, march: true, july: false }, bobJuly: { error: false, code: undefined, march: false, july: true } });
    return seen;
  });
});

describe('the Rust arm refuses what it does not serve yet (row 32j), and shows nothing', () => {
  // Another member's identity asked about in a record that holds satisfied folder rules: SQL renders no satisfied rule
  // for it (satisfiedFor) and answers by readers alone; the Rust member's reference renders the record's rules for the
  // argument, the texts differ, and it refuses (fails closed). whoCanRead always passes the record's own identity. The
  // pin fails when Rust starts to serve it, so row 32j closes on purpose.
  test('loss (32j): another member\'s identity in a record with satisfied folder rules refuses on Rust', async () => {
    const results: Record<string, unknown> = {};
    for (const arm of arms()) {
      await resetArm(arm);
      await admits(arm.engine, arm.backend);
      const remotePolicy = { privacyRelaxed: false, restricted: true, ...await schemaVersionNow(arm.engine) };
      const bob = identityFor('bob-example', []);
      const record = { identity: bob, ...await folderAccessFor(arm.engine, bob), restricted: true, owner: true, remotePolicy };
      const alice = identityFor('alice-example', ['team-a']);
      const ask = (slug: string) => withCallerAccess(record as never, () => arm.engine.readPageAdmitsCaller('default', slug, alice))
        .catch(e => (e as { code?: string }).code);
      results[arm.backend] = { named: await ask('notes/alice-only'), ruled: await ask('deals/q4') };
    }
    for (const [backend, got] of Object.entries(results)) {
      expect([backend, got]).toEqual([backend, backend === 'rust'
        ? { named: 'engine_capability_missing', ruled: 'engine_capability_missing' }
        : { named: true, ruled: false }]);
    }
  });
});
