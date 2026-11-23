/**
 * BrainEngine parity: the second set of doctor reads (engine-sql/doctor-acc.ts), which the access, token, OAuth,
 * request-log, decide, chronicle, feedback, belief and volunteer checks used to run through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts), so a doctor check reads the same finding on each. Members whose
 *    state no engine call can create on a fresh brain (access members, tokens, decide receipts, ...) are read empty on
 *    every arm; the request log and the derived-workspace sources are seeded through their typed writers.
 *  - Regression: an engine that refuses a read (the Rust engine's typed raw_sql refusal) or answers it differently makes
 *    its doctor check warn where PGLite reports ok.
 *  - Why existing coverage misses it: the doctor check tests run these reads on PGLite only and never compare arms.
 *  - Seam: none. Typed methods only (no executeRaw). Byte sizes are not compared: each engine measures its own storage.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withWriteAttribution } from '../../src/core/persistence/context.ts';

const { parityTest } = parityArms(testBackends());

const NOTE = { type: 'note' as const, title: 'note', compiled_truth: 'body', timeline: '' };

const DRIFT_KEYS = ['principal:local_cli:drift-writer', 'brain'];
/** A queued write request of the drift writer whose authority says whether it came over a remote transport. */
async function driftRequest(engine: BrainEngine, requestId: string, slug: string, remote: boolean): Promise<string> {
  const source = await engine.readSourceMembership('default');
  await engine.lockPersistenceCounters(DRIFT_KEYS);
  const row = await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId: 'drift-writer', requestId, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: source!.incarnation, pageId: null, slug, worktreeId: null, topologyGeneration: null,
    digest: 'd'.repeat(64), intent: {}, authority: { remote }, intentBytes: 10, terminalReservation: 4096, targetKind: 'page',
    protocolVersion: 1, admitterVersion: 'v-test', admitterHostId: null, counterKeys: DRIFT_KEYS, clientRequestId: null,
    state: 'queued', deferredRefreshId: null,
  });
  return row.id;
}
/** Runs `fn` in one transaction attributed to request `id` of the drift writer. */
const asRequest = <T,>(engine: BrainEngine, id: string, fn: (tx: BrainEngine) => Promise<T>) =>
  engine.transaction(tx => withWriteAttribution(tx, { requestId: id, principal: { kind: 'local_cli', id: 'drift-writer' } }, () => fn(tx)));

describe('doctor reads, second set', () => {
  parityTest(
    'the access, token, OAuth, decide, chronicle, feedback, belief and volunteer reads answer empty on a fresh brain',
    { methods: [
      'listAccessPolicySourceIds', 'isAccessStateUnreadable', 'listRawOnlyRules', 'listAudienceMemberIds', 'listLabelledOnlyMemberIds',
      'listAccessMemberRows', 'listAttestCredentialRows', 'listActiveAccessTokenRows', 'listActiveOauthClientRows',
      'listOauthClientAuthShapes', 'listDanglingFederatedReads', 'listPrivilegedDcrClients', 'listCoveredSources',
      'listVolunteerChannels', 'listDecideCalibrations', 'listDecideResolvedModels', 'listDecideMixedModelDecisions',
      'decideSlotUsage', 'dailyDecideSpend', 'listDecideReceiptStats',
      'readChronicleLedgerStats', 'readChronicleDuplicateEvents', 'readFeedbackStatus',
    ] },
    async (engine) => {
      const answers = {
        policySources: await engine.listAccessPolicySourceIds(),
        unreadable: await engine.isAccessStateUnreadable(),
        rawOnly: await engine.listRawOnlyRules(),
        audience: await engine.listAudienceMemberIds(),
        labelledOnly: await engine.listLabelledOnlyMemberIds(),
        members: await engine.listAccessMemberRows(true),
        liveMembers: await engine.listAccessMemberRows(false),
        attest: await engine.listAttestCredentialRows(),
        tokens: await engine.listActiveAccessTokenRows(),
        clients: await engine.listActiveOauthClientRows(),
        authShapes: await engine.listOauthClientAuthShapes(),
        dangling: await engine.listDanglingFederatedReads(),
        privileged: await engine.listPrivilegedDcrClients('(^|[[:space:]])(admin)([[:space:]]|$)'),
        covered: await engine.listCoveredSources('coverage'),
        volunteerAll: await engine.listVolunteerChannels(null),
        volunteerScoped: await engine.listVolunteerChannels(['default']),
        calibrations: await engine.listDecideCalibrations({ includeRetired: true }),
        calibrationsForSlot: await engine.listDecideCalibrations({ slot: 'conflict', includeRetired: false }),
        models: await engine.listDecideResolvedModels(24),
        mixed: await engine.listDecideMixedModelDecisions(24),
        usage: await engine.decideSlotUsage(24),
        spend: await engine.dailyDecideSpend(new Date('2026-01-01T00:00:00Z')),
        receipts: await engine.listDecideReceiptStats({ sinceHours: 24 }),
        chronicle: await engine.readChronicleLedgerStats(),
        duplicates: await engine.readChronicleDuplicateEvents(),
        feedback: await engine.readFeedbackStatus(),
      };
      expect(answers.policySources).toEqual([]);
      expect(answers.unreadable).toBe(false);
      expect(answers.spend).toEqual({ total: 0, remote: 0 });
      expect(answers.chronicle.available).toBe(true);
      expect(answers.feedback.events).toBe(0);
      return answers;
    },
  );

  parityTest(
    'the schema reads answer the current shape, with the origin index and a finished revision backfill',
    { methods: ['readKnowledgeRevisionNotNull', 'readDriftSchema', 'originIndexPresent', 'listDriftLiveRows', 'listDriftVersionRows'] },
    async (engine) => {
      const schema = await engine.readDriftSchema();
      const answers = {
        notNull: await engine.readKnowledgeRevisionNotNull(),
        schema,
        origin: await engine.originIndexPresent('pages_live_origin_key'),
        missingIndex: await engine.originIndexPresent('no_such_index_here'),
        live: await engine.listDriftLiveRows(schema, 'default', { after: 0 }),
        liveBySlug: await engine.listDriftLiveRows(schema, 'default', { slug: 'nobody' }),
        versions: await engine.listDriftVersionRows(schema, []),
      };
      expect(answers).toEqual({ notNull: true, schema: 'current', origin: true, missingIndex: false, live: [], liveBySlug: [], versions: [] });
      return answers;
    },
  );

  parityTest(
    'the drift reads list the live pages of a source and the versions of those pages',
    { methods: ['putPage', 'softDeletePage', 'createVersion', 'readDriftSchema', 'listDriftLiveRows', 'listDriftVersionRows'] },
    async (engine) => {
      const page = (title: string, frontmatter: Record<string, unknown>) => ({ ...NOTE, title, frontmatter });
      await engine.putPage('notes/a', page('A', { tag: 'one' }));
      await engine.createVersion('notes/a');
      await engine.putPage('notes/a', page('A', { tag: 'two' }));
      await engine.putPage('notes/b', page('B', {}));
      await engine.putPage('notes/gone', page('Gone', {}));
      expect(await engine.softDeletePage('notes/gone')).toBeTruthy();
      const schema = await engine.readDriftSchema();
      const live = await engine.listDriftLiveRows(schema, 'default', { after: 0 });
      const ids = live.map(r => Number(r.id));
      const later = await engine.listDriftLiveRows(schema, 'default', { after: ids[0]! });
      const bySlug = await engine.listDriftLiveRows(schema, 'default', { slug: 'notes/b' });
      const deleted = await engine.listDriftLiveRows(schema, 'default', { slug: 'notes/gone' });
      const elsewhere = await engine.listDriftLiveRows(schema, 'no-such-source', { after: 0 });
      const versions = await engine.listDriftVersionRows(schema, ids);
      // These writes run under no principal, so `req`, `kind` and `remote` are null on every arm; the attributed case
      // below compares them. The comparison masks the revision uuid to its presence.
      const view = (rows: typeof live) => rows.map(({ id: _id, ingested_at, revision, ...r }) => ({ ...r, stamped: ingested_at !== null, revised: typeof revision === 'string' }));
      const versionView = versions.map(({ page_id, ...v }) => ({ ...v, first_page: Number(page_id) === ids[0] }));
      expect(live.map(r => r.slug)).toEqual(['notes/a', 'notes/b']);
      expect(later.map(r => r.slug)).toEqual(['notes/b']);
      expect(bySlug.map(r => r.slug)).toEqual(['notes/b']);
      expect(deleted).toEqual([]);
      expect(elsewhere).toEqual([]);
      expect(versionView.length).toBe(1);
      return { live: view(live), later: view(later), bySlug: view(bySlug), versions: versionView };
    },
  );

  parityTest(
    'the drift reads carry the request, principal kind and remote flag of an attributed write',
    { methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'applyTransactionSettings', 'putPage', 'createVersion', 'readDriftSchema', 'listDriftLiveRows', 'listDriftVersionRows'] },
    async (engine) => {
      const source = await engine.readSourceMembership('default');
      const admit = async (n: number, remote: unknown) => {
        const keys = ['principal:local_cli:w', 'brain'];
        await engine.lockPersistenceCounters(keys);
        const row = await engine.insertWriteRequest({
          principalKind: 'local_cli', principalId: 'w', requestId: `c0000000-0000-4000-8000-00000000000${n}`, operation: 'put_page',
          sourceId: 'default', sourceIncarnation: source!.incarnation, pageId: null, slug: 'notes/a', worktreeId: null,
          topologyGeneration: null, digest: String(n).repeat(64), intent: { kind: 'put_page', slug: 'notes/a' },
          authority: { scopes: ['write'], remote }, intentBytes: 100, terminalReservation: 4096, targetKind: 'page',
          protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: keys, clientRequestId: null,
          state: 'queued', deferredRefreshId: null,
        });
        return row.id;
      };
      const wrote = await admit(1, true);
      const archived = await admit(2, false);
      const settings = ['gbrain.write_request', 'gbrain.write_principal_kind', 'gbrain.write_principal_id'];
      await engine.transaction(async (tx) => {
        await tx.applyTransactionSettings(settings, [wrote, 'local_cli', 'w']);
        await tx.putPage('notes/a', { ...NOTE, title: 'A' });
      });
      await engine.transaction(async (tx) => {
        await tx.applyTransactionSettings(settings, [archived, 'local_cli', 'w']);
        await tx.createVersion('notes/a');
      });
      const schema = await engine.readDriftSchema();
      const live = await engine.listDriftLiveRows(schema, 'default', { after: 0 });
      const versions = await engine.listDriftVersionRows(schema, live.map(r => Number(r.id)));
      // Request ids are uuids minted per arm, so each reads as the role it plays.
      const role = (req: string | null) => (req === null ? null : req === wrote ? 'wrote' : req === archived ? 'archived' : 'other');
      const pick = (r: { req: string | null; kind: string | null; remote: string | null }) => ({ req: role(r.req), kind: r.kind, remote: r.remote });
      const answers = { live: live.map(pick), versions: versions.map(pick) };
      expect(answers).toEqual({
        live: [{ req: 'wrote', kind: 'local_cli', remote: 'true' }],
        versions: [{ req: 'archived', kind: 'local_cli', remote: 'false' }],
      });
      return answers;
    },
  );

  parityTest(
    'the drift reads name the request, principal kind and transport of the write behind a revision and a version',
    { methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'transaction', 'applyTransactionSettings',
      'readTransactionSettings', 'putPage', 'createVersion', 'readDriftSchema', 'listDriftLiveRows', 'listDriftVersionRows'] },
    async (engine) => {
      const local = await driftRequest(engine, 'd0000000-0000-4000-8000-0000000000d1', 'notes/a', false);
      const remote = await driftRequest(engine, 'd0000000-0000-4000-8000-0000000000d2', 'notes/a', true);
      const page = (title: string, frontmatter: Record<string, unknown>) => ({ ...NOTE, title, frontmatter });
      await asRequest(engine, local, tx => tx.putPage('notes/a', page('A', { tag: 'one' })));
      // The archiving write runs for the remote request; the snapshot keeps the revision the local request wrote.
      await asRequest(engine, remote, async tx => { await tx.createVersion('notes/a'); await tx.putPage('notes/a', page('A', { tag: 'two' })); });
      await asRequest(engine, local, tx => tx.putPage('notes/kept', page('Kept', {})));
      // A write with no principal that moves the revision clears its writer; one that keeps the revision keeps it.
      await engine.putPage('notes/kept', page('Kept', { moved: true }));
      await asRequest(engine, remote, tx => tx.putPage('notes/same', page('Same', {})));
      await engine.createVersion('notes/same');
      await engine.putPage('notes/plain', page('Plain', {}));
      const schema = await engine.readDriftSchema();
      const live = await engine.listDriftLiveRows(schema, 'default', { after: 0 });
      const byId = new Map(live.map(r => [Number(r.id), r.slug]));
      const versions = await engine.listDriftVersionRows(schema, live.map(r => Number(r.id)));
      const who = (req: string | null) => req === null ? null : req === local ? 'local' : req === remote ? 'remote' : 'other';
      const writers = Object.fromEntries(live.map(r => [r.slug, { req: who(r.req), kind: r.kind, remote: r.remote }]));
      const archived = versions.map(v => ({ slug: byId.get(Number(v.page_id)), req: who(v.req), kind: v.kind, remote: v.remote }));
      expect(writers).toEqual({
        'notes/a': { req: 'remote', kind: 'local_cli', remote: 'true' },
        'notes/kept': { req: null, kind: null, remote: null },
        'notes/same': { req: 'remote', kind: 'local_cli', remote: 'true' },
        'notes/plain': { req: null, kind: null, remote: null },
      });
      expect(archived).toEqual([
        { slug: 'notes/a', req: 'remote', kind: 'local_cli', remote: 'true' },
        { slug: 'notes/same', req: null, kind: null, remote: null },
      ]);
      return { writers, archived };
    },
  );

  parityTest(
    'the request log reads count rows, bound the count and find a row past the retention window',
    { methods: ['logMcpRequest', 'readMcpRequestLogBytes', 'countMcpRequestLogRows', 'hasMcpLogRowsPastWindow'] },
    async (engine) => {
      const empty = { rows: await engine.countMcpRequestLogRows(100), waiting: await engine.hasMcpLogRowsPastWindow(90, []) };
      const old = new Date(Date.now() - 200 * 86_400_000);
      const recent = new Date(Date.now() - 86_400_000);
      for (const [operation, created_at] of [['get_page', recent], ['audit_op', old]] as const) {
        await engine.logMcpRequest({ token_name: 't', agent_name: 'a', operation, latency_ms: 5, status: 'success', created_at });
      }
      const bytes = await engine.readMcpRequestLogBytes();
      const seeded = {
        // Postgres reports the planner's estimate, which lags a write; the other engines count (bounded by the limit).
        rowsWithinLimit: (await engine.countMcpRequestLogRows(100)) <= 2,
        boundedToOne: (await engine.countMcpRequestLogRows(1)) <= 1,
        waiting: await engine.hasMcpLogRowsPastWindow(90, []),
        waitingWithKept: await engine.hasMcpLogRowsPastWindow(90, ['audit_op']),
        waitingNothingOld: await engine.hasMcpLogRowsPastWindow(365, []),
        bytesRead: Number.isFinite(bytes) && bytes >= 0,
      };
      expect({ empty, seeded }).toEqual({
        empty: { rows: 0, waiting: false },
        seeded: { rowsWithinLimit: true, boundedToOne: true, waiting: true, waitingWithKept: false, waitingNothingOld: false, bytesRead: true },
      });
      return { empty, seeded };
    },
  );

  parityTest(
    'listOrphanWorkspaceSources names a derived-workspace source with no path, pages or archive, and no other',
    { methods: ['insertSource', 'putPage', 'listOrphanWorkspaceSources'] },
    async (engine) => {
      const none = await engine.listOrphanWorkspaceSources('-workspace');
      await engine.insertSource({ id: 'alpha-workspace', name: 'alpha-workspace', local_path: null, config: {} });
      await engine.insertSource({ id: 'beta-workspace', name: 'beta-workspace', local_path: '/srv/beta', config: {} });
      await engine.insertSource({ id: 'gamma-workspace', name: 'gamma-workspace', local_path: null, config: {} });
      await engine.insertSource({ id: 'plain', name: 'plain', local_path: null, config: {} });
      await engine.putPage('people/gamma-example', NOTE, { sourceId: 'gamma-workspace' });
      const found = await engine.listOrphanWorkspaceSources('-workspace');
      const other = await engine.listOrphanWorkspaceSources('plain');
      expect({ none, found, other }).toEqual({ none: [], found: [{ id: 'alpha-workspace' }], other: [{ id: 'plain' }] });
      return { none, found, other };
    },
  );

  // The store keeps access rules and members, so on a brain that holds them these doctor reads list them on every arm
  // (they once answered none on Rust).
  parityTest('listRawOnlyRules lists the raw-only rules by source and id, and listAccessMemberRows lists members with their groups', {
    methods: ['ensureAccessPolicyState', 'lockAccessPolicy', 'applyAccessRuleChanges', 'insertAccessMember', 'setAccessMemberDisabled', 'tombstoneAccessMember',
      'listRawOnlyRules', 'listAccessMemberRows'],
  }, async (engine, backend) => {
    for (const id of ['work', 'alpha']) {
      await createSource(engine, backend, id);
      await engine.ensureAccessPolicyState(id);
      await engine.transaction(async tx => {
        await tx.lockAccessPolicy(id);
        await tx.applyAccessRuleChanges(id, { remove: [], pending: [], revision: 1, actor: 'parity', insert: [
          { rule_id: 'raw-b', prefix: 'raw-b/', readable_by: ['member:bob-example'], covers_derived: false },
          { rule_id: 'kept', prefix: 'kept/', readable_by: ['member:bob-example'], covers_derived: true },
          { rule_id: 'raw-a', prefix: 'raw-a/', readable_by: ['group:team-a'], covers_derived: false },
        ] });
      });
    }
    const member = (id: string, groups: string[]) => ({ id, displayName: `${id} name`, email: null, kind: 'person' as const, groups, bindTokenId: null });
    await engine.insertAccessMember(member('carol-example', ['team-b', 'team-a']));
    await engine.insertAccessMember(member('bob-example', []));
    await engine.insertAccessMember(member('dave-example', ['team-a']));
    await engine.setAccessMemberDisabled('bob-example', true);
    await engine.tombstoneAccessMember('dave-example');
    const view = (rows: Array<Record<string, unknown>>) => rows.map(({ created_at, disabled_at, tombstoned_at, ...r }) =>
      ({ ...r, created: created_at instanceof Date, disabled: disabled_at instanceof Date, removed: tombstoned_at instanceof Date }));
    const out = {
      rawOnly: await engine.listRawOnlyRules(),
      members: view(await engine.listAccessMemberRows(true) as Array<Record<string, unknown>>),
      live: view(await engine.listAccessMemberRows(false) as Array<Record<string, unknown>>),
    };
    expect(out.rawOnly.map(r => `${r.source_id}:${r.rule_id}`)).toEqual(['alpha:raw-a', 'alpha:raw-b', 'work:raw-a', 'work:raw-b']);
    expect(out.live.map(r => (r as { id?: unknown }).id)).toEqual(['bob-example', 'carol-example']);
    return out;
  });

  // The store keeps tokens and OAuth clients, so the three credential reads the grant, legacy-token and attest-read doctor
  // checks run list them on every arm (they once answered none on Rust). The rows are whole: a token row carries its
  // hash as `SELECT *` does, a client's attest row leaves its secret hash out, and the attest rows' times are to_jsonb text.
  parityTest('listActiveAccessTokenRows, listActiveOauthClientRows and listAttestCredentialRows list the stored credentials', {
    methods: ['insertAccessToken', 'insertOauthClient', 'writeCredentialBinding', 'listActiveAccessTokenRows', 'listActiveOauthClientRows', 'listAttestCredentialRows'],
  }, async (engine) => {
    const token = (name: string, created: string, extra: Record<string, unknown> = {}) => engine.insertAccessToken({
      name, token_hash: `hash-${name}`, scopes: ['read'], permissions: { source_id: 'default' }, source_grant: 'scalar', source_id: 'default',
      federated_read: null, allowed_operations: ['query'], takes_holders: ['world'], member_id: null, created_at: new Date(created), ...extra });
    const alpha = await token('alpha-key', '2026-01-03T00:00:00.215Z');
    const beta = await token('beta-key', '2026-01-02T08:30:00Z', { scopes: null });
    const gone = await token('gone-key', '2026-01-01T00:00:00Z', { revoked_at: new Date('2026-01-04T00:00:00Z') });
    const attest = { member: null, mayActFor: null, attestActor: 'slack', attestOps: ['query'], attestSources: ['default'], attestRead: 'person' as const };
    await engine.writeCredentialBinding({ kind: 'token', id: alpha.id }, attest);
    await engine.writeCredentialBinding({ kind: 'token', id: gone.id }, attest);
    const created_at = new Date('2026-02-01T10:00:00.5Z');
    await engine.insertOauthClient({ client_id: 'zed-app', client_name: 'Zed', client_secret_hash: 'secret-zed', grant_types: ['client_credentials'],
      scope: 'read write', budget_usd_per_day: 2.5, client_id_issued_at: 1700000000, created_at, attest_actor: 'slack', attest_ops: ['query'],
      attest_sources: ['default'], attest_read: 'scope', reads_unscoped: new Date('2026-02-02T00:00:00.125Z') });
    await engine.insertOauthClient({ client_id: 'amy-app', client_name: 'Amy', created_at });
    await engine.insertOauthClient({ client_id: 'old-app', client_name: 'Old', created_at, deleted_at: new Date('2026-02-03T00:00:00Z'), attest_actor: 'slack' });
    // Token ids are generated; name them so the arms compare. A bigint column (client_id_issued_at) is a BigInt on
    // Postgres and a number on PGLite from the same SELECT *; no doctor check reads it.
    const ids = new Map([[alpha.id, 'id:alpha-key'], [beta.id, 'id:beta-key'], [gone.id, 'id:gone-key']]);
    const plain = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => [k, v instanceof Date ? `Date:${v.toISOString()}` : typeof v === 'bigint' ? Number(v)
        : typeof v === 'string' && ids.has(v) ? ids.get(v) : v]));
    const out = {
      tokens: (await engine.listActiveAccessTokenRows()).map(plain),
      clients: (await engine.listActiveOauthClientRows()).map(plain),
      attest: (await engine.listAttestCredentialRows()).map(r => ({ kind: r.kind, id: ids.get(r.id) ?? r.id, name: r.name,
        row: plain(typeof r.row === 'string' ? JSON.parse(r.row) : r.row) })),
    };
    expect(out.tokens.map(t => t.name)).toEqual(['beta-key', 'alpha-key']);
    expect(out.clients.map(c => c.client_id)).toEqual(['amy-app', 'zed-app']);
    expect(out.attest.map(a => `${a.kind}:${a.name}`)).toEqual(['client:Zed', 'token:alpha-key']);
    expect(out.attest[0]!.row.client_secret_hash).toBeUndefined();
    expect(out.attest[1]!.row.created_at).toBe('2026-01-03T00:00:00.215+00:00');
    return out;
  });
});
