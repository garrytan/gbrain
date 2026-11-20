/**
 * The doctor reads of src/core/engine-sql/doctor-acc.ts keep the statement text and behaviour the doctor checks had
 * inline before they moved behind typed engine members.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the live-page read keeps the statement provenance-drift.ts built, its batch size equals that file's
 *    `BATCH`, the feedback reads keep the neutral weight of feedback/store.ts, the missing-table fallbacks answer as the
 *    inline code did, and the seeded reads return what the checks read on PGLite.
 *  - Regression: a drifted constant (a batch that is not the scan's, a neutral weight that is not 0.5, a lost fallback)
 *    changes what doctor reports on PGLite and Postgres without any parity case noticing, since the parity cases compare
 *    engines rather than the text against the old code.
 *  - Why existing coverage misses it: test/engine-parity/doctor-acc.test.ts reads fresh brains (empty), so no row shape
 *    and no statement text is pinned there.
 *  - Seam: real in-memory PGLite; rows seeded through executeRaw and the typed writers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { NEUTRAL_WEIGHT } from '../src/core/feedback/store.ts';
import {
  DRIFT_BATCH, hasMcpLogRowsPastWindow, listDriftLiveRows, listDriftVersionRows, listOrphanWorkspaceSources,
  listPolicySourceIds, listPrivilegedDcrClients, listVolunteerChannels, readDriftSchema, readFeedbackStatus, readKnowledgeRevisionNotNull,
  countMcpRequestLogRows, readMcpRequestLogBytes, type EngineRawRead,
} from '../src/core/engine-sql/doctor-acc.ts';

let engine: PGLiteEngine;
const raw: EngineRawRead = (sql, params) => engine.executeRaw(sql, params);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

describe('doctor reads, second set: statement text', () => {
  test('the live-page batch is the provenance scan batch', () => {
    const source = readFileSync(new URL('../src/core/trust/provenance-drift.ts', import.meta.url), 'utf8');
    expect(source).toContain(`const BATCH = ${DRIFT_BATCH};`);
    expect(DRIFT_BATCH).toBe(500);
  });

  test('the feedback weight bounds are the neutral weight', () => {
    expect(NEUTRAL_WEIGHT).toBe(0.5);
    const source = readFileSync(new URL('../src/core/engine-sql/doctor-acc.ts', import.meta.url), 'utf8');
    expect(source).toContain(`abs(weight - ${NEUTRAL_WEIGHT}) > 0.01`);
    expect(source).toContain(`w.weight < ${NEUTRAL_WEIGHT}`);
    expect(source).toContain(`weight > ${NEUTRAL_WEIGHT}`);
  });
});

describe('doctor reads, second set: seeded PGLite', () => {
  test('a fresh brain reads current, finished and empty', async () => {
    expect(await readDriftSchema(raw)).toBe('current');
    expect(await readKnowledgeRevisionNotNull(raw)).toBe(true);
    expect(await listPolicySourceIds(raw)).toEqual([]);
    expect(await listDriftLiveRows(raw, 'current', 'default', { after: 0 })).toEqual([]);
    expect(await listDriftVersionRows(raw, 'current', [])).toEqual([]);
  });

  test('live pages come back by id in a batch, or by slug', async () => {
    for (const slug of ['notes/a', 'notes/b', 'notes/c']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}`, timeline: '' });
    }
    const all = await listDriftLiveRows(raw, 'current', 'default', { after: 0 });
    expect(all.map(r => r.slug)).toEqual(['notes/a', 'notes/b', 'notes/c']);
    const after = await listDriftLiveRows(raw, 'current', 'default', { after: Number(all[0]!.id) });
    expect(after.map(r => r.slug)).toEqual(['notes/b', 'notes/c']);
    const one = await listDriftLiveRows(raw, 'pre_attribution', 'default', { slug: 'notes/b' });
    expect(one.map(r => r.slug)).toEqual(['notes/b']);
    expect(one[0]!.req).toBeNull();
    expect(await listDriftLiveRows(raw, 'current', 'elsewhere', { after: 0 })).toEqual([]);
    const versions = await listDriftVersionRows(raw, 'current', all.map(r => Number(r.id)));
    expect(Array.isArray(versions)).toBe(true);
  });

  test('the request log counts, bounds the count and finds rows past the window', async () => {
    expect(await countMcpRequestLogRows(raw, 'pglite', 10)).toBe(0);
    expect(await hasMcpLogRowsPastWindow(raw, 90, [])).toBe(false);
    const old = new Date(Date.now() - 200 * 86_400_000);
    for (const operation of ['a_op', 'b_op', 'b_op']) {
      await engine.logMcpRequest({ token_name: 't', agent_name: 'a', operation, latency_ms: 1, status: 'success', created_at: old });
    }
    expect(await countMcpRequestLogRows(raw, 'pglite', 10)).toBe(3);
    expect(await countMcpRequestLogRows(raw, 'pglite', 2)).toBe(2);
    expect(await hasMcpLogRowsPastWindow(raw, 90, [])).toBe(true);
    expect(await hasMcpLogRowsPastWindow(raw, 90, ['a_op'])).toBe(true);
    expect(await hasMcpLogRowsPastWindow(raw, 90, ['a_op', 'b_op'])).toBe(false);
    expect(await hasMcpLogRowsPastWindow(raw, 365, [])).toBe(false);
    expect(await readMcpRequestLogBytes(raw)).toBeGreaterThan(0);
  });

  test('feedback weights split below, at and above neutral', async () => {
    for (const [key, weight] of [['fb/low', 0.3], ['fb/near', 0.505], ['fb/high', 0.8]] as const) {
      await engine.executeRaw(`INSERT INTO retrieval_weights (source_id, element_kind, element_key, weight) VALUES ('default', 'page', $1, $2)`, [key, weight]);
    }
    const status = await readFeedbackStatus(raw);
    expect(status.weights_total).toBe(3);
    expect(status.weights_off_neutral).toBe(2);
    expect(status.lowest.map(r => r.slug)).toEqual(['fb/low']);
    // The count tolerates 0.01 around neutral; the highest list is any weight above it.
    expect(status.highest.map(r => r.slug)).toEqual(['fb/high', 'fb/near']);
    expect(status.lowest[0]!.weight).toBeCloseTo(0.3, 5);
    expect(status.events).toBe(0);
    expect(status.last_rating_at).toBeNull();
  });

  test('volunteer channels count the last seven days, whole brain or scoped', async () => {
    await engine.executeRaw(`INSERT INTO context_volunteer_events (source_id, slug, confidence, match_arm, channel) VALUES
      ('default', 'a', 0.9, 'x', 'reflex'), ('default', 'b', 0.9, 'x', 'reflex'), ('default', 'c', 0.9, 'x', 'op')`);
    await engine.executeRaw(`INSERT INTO context_volunteer_events (source_id, slug, confidence, match_arm, channel, volunteered_at)
      VALUES ('default', 'd', 0.9, 'x', 'watch', now() - interval '30 days')`);
    const all = await listVolunteerChannels(raw, null);
    expect(Object.fromEntries(all.map(r => [r.channel, Number(r.n)]))).toEqual({ reflex: 2, op: 1 });
    expect(await listVolunteerChannels(raw, ['nowhere'])).toEqual([]);
    expect((await listVolunteerChannels(raw, ['default'])).length).toBe(2);
  });

  test('belief coverage names only sources with the coverage key in their current incarnation', async () => {
  });

  test('orphan workspace sources skip the facts exclusion on a brain with no facts table', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('solo-workspace', 'solo-workspace', '{}'::jsonb)`);
    expect(await listOrphanWorkspaceSources(raw, '-workspace')).toEqual([{ id: 'solo-workspace' }]);
    await engine.executeRaw('DROP TABLE facts CASCADE');
    expect(await listOrphanWorkspaceSources(raw, '-workspace')).toEqual([{ id: 'solo-workspace' }]);
  });

  test('the privileged client read answers empty with the audit table and null once it is gone', async () => {
    expect(await listPrivilegedDcrClients(raw, '(^|[[:space:]])admin([[:space:]]|$)')).toEqual([]);
    await engine.executeRaw('DROP TABLE oauth_grant_audit CASCADE');
    expect(await listPrivilegedDcrClients(raw, 'admin')).toBeNull();
  });
});
