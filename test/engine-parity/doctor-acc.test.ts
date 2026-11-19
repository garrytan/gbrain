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
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const NOTE = { type: 'note' as const, title: 'note', compiled_truth: 'body', timeline: '' };

describe('doctor reads, second set', () => {
  parityTest(
    'the access, token, OAuth, decide, chronicle, feedback, belief and volunteer reads answer empty on a fresh brain',
    { methods: [
      'listPolicySourceIds', 'isAccessStateUnreadable', 'listRawOnlyRules', 'listAudienceMemberIds', 'listLabelledOnlyMemberIds',
      'listAccessMemberRows', 'listAttestCredentialRows', 'listActiveAccessTokenRows', 'listActiveOauthClientRows',
      'listOauthClientAuthShapes', 'listDanglingFederatedReads', 'listPrivilegedDcrClients', 'listBeliefCoveredSources',
      'listVolunteerChannels', 'listDecideCalibrationRows', 'listRecentResolvedModels', 'listMixedModelDecisions',
      'listDecideSlotUsage', 'readDecideDailySpend', 'listDecideReceiptStats', 'readPendingProposalSummary',
      'readChronicleLedgerStats', 'readChronicleDuplicateEvents', 'readFeedbackStatus',
    ] },
    async (engine) => {
      const answers = {
        policySources: await engine.listPolicySourceIds(),
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
        covered: await engine.listBeliefCoveredSources('coverage'),
        volunteerAll: await engine.listVolunteerChannels(null),
        volunteerScoped: await engine.listVolunteerChannels(['default']),
        calibrations: await engine.listDecideCalibrationRows(null, true),
        calibrationsForSlot: await engine.listDecideCalibrationRows('conflict', false),
        models: await engine.listRecentResolvedModels(24),
        mixed: await engine.listMixedModelDecisions(24),
        usage: await engine.listDecideSlotUsage(24),
        spend: await engine.readDecideDailySpend('2026-01-01T00:00:00Z'),
        receipts: await engine.listDecideReceiptStats(24, null),
        proposals: await engine.readPendingProposalSummary(),
        chronicle: await engine.readChronicleLedgerStats(),
        duplicates: await engine.readChronicleDuplicateEvents(),
        feedback: await engine.readFeedbackStatus(),
      };
      expect(answers.policySources).toEqual([]);
      expect(answers.unreadable).toBe(false);
      expect(answers.spend).toEqual({ total: 0, remote: 0 });
      expect(answers.proposals).toEqual({ pending: 0, oldest_hours: null });
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
      // The write attribution (`req`, `kind`, `remote`) is the one thing the Rust store does not keep: it answers null on
      // every row (rust/docs/store/cli-reads-doctor-acc.md), so the comparison reads the other columns only (the revision uuid is masked to its presence).
      const view = (rows: typeof live) => rows.map(({ id: _id, req: _req, kind: _kind, remote: _remote, ingested_at, revision, ...r }) => ({ ...r, stamped: ingested_at !== null, revised: typeof revision === 'string' }));
      const versionView = versions.map(({ page_id, req: _req, kind: _kind, remote: _remote, ...v }) => ({ ...v, first_page: Number(page_id) === ids[0] }));
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
});
