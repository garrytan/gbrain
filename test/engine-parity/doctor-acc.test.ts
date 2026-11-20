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
      'listAttestCredentialRows', 'listActiveAccessTokenRows', 'listActiveOauthClientRows',
      'listOauthClientAuthShapes', 'listDanglingFederatedReads', 'listPrivilegedDcrClients', 'listVolunteerChannels', 'readChronicleLedgerStats', 'readChronicleDuplicateEvents', 'readFeedbackStatus',
    ] },
    async (engine) => {
      const answers = {
        policySources: await engine.listPolicySourceIds(),
        unreadable: await engine.isAccessStateUnreadable(),
        rawOnly: await engine.listRawOnlyRules(),
        audience: await engine.listAudienceMemberIds(),
        labelledOnly: await engine.listLabelledOnlyMemberIds(),
        attest: await engine.listAttestCredentialRows(),
        tokens: await engine.listActiveAccessTokenRows(),
        clients: await engine.listActiveOauthClientRows(),
        authShapes: await engine.listOauthClientAuthShapes(),
        dangling: await engine.listDanglingFederatedReads(),
        privileged: await engine.listPrivilegedDcrClients('(^|[[:space:]])(admin)([[:space:]]|$)'),
        volunteerAll: await engine.listVolunteerChannels(null),
        volunteerScoped: await engine.listVolunteerChannels(['default']),
        chronicle: await engine.readChronicleLedgerStats(),
        duplicates: await engine.readChronicleDuplicateEvents(),
        feedback: await engine.readFeedbackStatus(),
      };
      expect(answers.policySources).toEqual([]);
      expect(answers.unreadable).toBe(false);
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
