/**
 * BrainEngine parity: `gbrain access member handover` preview and --status (src/core/access/handover.ts) through the
 * typed reads of engine-sql/handover-reads.ts, and the refusal of --yes on an engine that cannot write a handover.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the preview lists the same items, counts and impact on PGLite, Postgres and Rust for the same writes;
 *    --status of an unknown id is not_found on every engine; --yes refuses on Rust before it writes anything.
 *  - Regression: the preview read access_group_members, sources, pages and access_handovers through executeRaw, so a
 *    Rust brain refused the whole command; its private-fact count joined on a column the facts table lacks and read 0.
 *  - Why existing coverage misses it: test/access-member-handover.test.ts runs on PGLite and Postgres only.
 *  - Seam: the real handover functions on each arm's engine; members, pages, facts and tokens through typed writes.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { applyHandover, DEFAULT_CHOICES, handoverStatus, previewHandover } from '../../src/core/access/handover.ts';

const { parityTest } = parityArms(testBackends());

const member = (id: string, groups: string[] = []) => ({ id, displayName: id, email: null, kind: 'person' as const, groups, bindTokenId: null });
const page = (title: string, frontmatter: Record<string, unknown> = {}) =>
  ({ type: 'note' as const, title, compiled_truth: `body of ${title}`, timeline: '', frontmatter });

/** A brain with an owner, a disabled leaver in a group, pages it reads alone or with others, a memory page and a key. */
async function seed(engine: BrainEngine): Promise<void> {
  await engine.insertAccessMember(member('owner-example'));
  await engine.insertAccessMember(member('bob-example', ['team-a']));
  await engine.insertAccessMember(member('carol-example', ['team-a']));
  await engine.setConfig('access.owner_member', 'owner-example');
  await engine.putPage('notes/bob-only', page('bob only', { readable_by: ['bob-example'] }));
  await engine.putPage('notes/shared', page('shared', { readable_by: ['bob-example', 'carol-example'] }));
  await engine.putPage('notes/team', page('team', { readable_by: ['group:team-a'] }));
  await engine.putPage('notes/open', page('open'));
  await engine.putPage('memory/members/bob-example', page('bob memory', { readable_by: ['bob-example'] }));
  await engine.insertFacts([1, 2].map(row_num => ({ fact: `bob fact ${row_num}`, kind: 'fact', visibility: 'private', notability: 'medium', source: 'test',
    entity_slug: 'people/bob-example', row_num, source_markdown_slug: 'memory/members/bob-example' })) as never, { source_id: 'default' });
  await engine.insertAccessToken({ name: 'bob-key', token_hash: 'hash-bob', scopes: ['read'], permissions: {}, source_grant: 'default', source_id: null,
    federated_read: null, allowed_operations: null, takes_holders: null, member_id: 'bob-example' });
  await engine.setAccessMemberDisabled('bob-example', true);
}

/** The preview without page ids (each engine numbers its own pages). */
function view(p: Awaited<ReturnType<typeof previewHandover>>) {
  return {
    groups: p.groups, gains: p.gains, losses: p.losses, owner_gains: p.owner_gains, opens: p.opens_to_source_readers,
    creds: p.bound_credentials, leaver_groups: p.leaver_groups, warnings: p.warnings,
    items: p.items.map(i => ({ ...i, ...('page_id' in i ? { page_id: 0 } : {}) })),
  };
}

describe('member handover on every engine', () => {
  parityTest('the preview lists the same pages, counts and impact, and --status of an unknown id is not_found', {
    methods: ['listAccessGroupMemberships', 'listActiveSourceIds', 'listHandoverReaderPages', 'countMemberPage', 'countMemberPageFacts',
      'countMemberBoundCredentials', 'readLastUndoneHandoverId', 'listMemberSourceRows', 'readHandoverRow'],
  }, async (engine) => {
    await seed(engine);
    const preview = view(await previewHandover(engine, 'bob-example', DEFAULT_CHOICES));
    const status = await handoverStatus(engine, 'no-such-handover').then(() => 'found', (e: { code?: string }) => e.code ?? String(e));
    expect(preview.creds).toBe(1);
    expect(preview.groups.find(g => g.group === 'memory')!.note).toBe('2 private fact(s); never opened. The owner reads them on the brain host.');
    expect(status).toBe('not_found');
    return { preview, status };
  });

  parityTest('a folder rule that names only the leaver moves to the owner, and the pages under it count in the impact', {
    methods: ['listHandoverPrefixPages'],
  }, async (engine, backend) => {
    await seed(engine);
    const { restrictFolder } = await import('./harness.ts');
    await restrictFolder(engine, backend, 'default', 'notes/', 'rule', { ruleId: 'bob-notes', readers: ['member:bob-example'] });
    const p = view(await previewHandover(engine, 'bob-example', DEFAULT_CHOICES));
    expect(p.items.some(i => i.kind === 'rule')).toBe(true);
    return p;
  });

  // An apply writes the handover record, bindings, rules and page readers. On an engine without raw SQL it refuses
  // before any of them, so a Rust brain never holds a half-written handover.
  parityTest('--yes writes the handover on the SQL engines and refuses on Rust before writing anything', {
    methods: ['readHandoverRow'], requires: 'raw_sql',
  }, async (engine) => {
    await seed(engine);
    const p = await previewHandover(engine, 'bob-example', DEFAULT_CHOICES);
    const ctx = { engine, config: {}, logger: { info: () => {}, warn: () => {}, error: () => {} }, dryRun: false, remote: false } as unknown as OperationContext;
    const command = 'gbrain access member handover bob-example';
    const record = await applyHandover(engine, 'bob-example', { ctx, expect: p.plan_hash, previewCommand: command });
    expect((await engine.readHandoverRow('id', record.id))?.plan_hash).toBe(p.plan_hash);
    return { state: record.state, items: record.items.length };
  });
});
