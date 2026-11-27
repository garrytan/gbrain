/**
 * The statements of src/core/engine-sql/doctor-facts-trust.ts keep the exact text the doctor readers built inline.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each statement equals the text its reader ran through executeRaw before the move (parameters in the same
 *    order), no member lists a name the engine lacks, and no member is listed twice.
 *  - Regression: a drifted statement changes which pages, deferrals or rows doctor reports on PGLite and Postgres.
 *  - Why existing coverage misses it: the parity cases compare engines on seeded rows, not the text against the old builder.
 *  - Seam: a recording raw reader (no engine).
 */
import { describe, expect, test } from 'bun:test';
import {
  DOCTOR_FACTS_TRUST_MEMBERS, countClaimLiftedRows, countConversationPipelinePages, countLegacyUnknownBySource,
  countRowTrustTiers, listPersistentWriterContention, listTrustClaimTargets, listTrustColumns,
} from '../src/core/engine-sql/doctor-facts-trust.ts';
import { claimedSourceSql, legacyRowSql, notConnectorSourceSql } from '../src/core/trust/claim-state.ts';
import { RUST_ENGINE_MEMBERS } from '../src/core/rust-engine/members.ts';

const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

function recorder(rows: unknown[] = []) {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const raw = (async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return rows; }) as never;
  return { raw, calls };
}

describe('doctor facts, fence and trust SQL text', () => {
  test('conversation-pipeline page count: the statement conversationPipelineNote ran', async () => {
    const { raw, calls } = recorder([{ n: 3 }]);
    expect(await countConversationPipelinePages(raw, ['chat'], ['meetings/%'])).toBe(3);
    expect(calls).toEqual([{ sql: `SELECT count(*)::int AS n FROM pages
      WHERE deleted_at IS NULL AND type = ANY($1::text[]) AND NOT (slug LIKE ANY($2::text[]))`, params: [['chat'], ['meetings/%']] }]);
  });

  test('persistent writer contention: the statement persistentWriterContention ran', async () => {
    const { raw, calls } = recorder();
    await listPersistentWriterContention(raw, 'write_deferred_unadmitted');
    expect(calls).toEqual([{ sql: `SELECT l.source_id, COUNT(*)::int AS n, MIN(l.created_at) AS oldest
         FROM ingest_log l
        WHERE l.source_type = 'facts:absorb'
          AND l.created_at >= now() - INTERVAL '24 hours'
          AND split_part(l.summary, ':', 1) = $1
          AND NOT EXISTS (
            SELECT 1 FROM minion_jobs j
             WHERE j.name = 'facts-absorb' AND j.status = 'completed' AND j.finished_at >= l.created_at
               AND j.data->>'slug' = l.source_ref AND COALESCE(j.data->>'sourceId', 'default') = l.source_id)
        GROUP BY l.source_id
       HAVING COUNT(*) > 10 OR MIN(l.created_at) < now() - INTERVAL '1 hour'
        ORDER BY l.source_id COLLATE "C"`, params: ['write_deferred_unadmitted'] }]);
  });

  test('row trust tiers: the per-table tier count readTrustTierCounts ran', async () => {
    for (const table of ['facts', 'takes', 'timeline_entries'] as const) {
      const { raw, calls } = recorder([{ tier: 'unknown', n: '4' }, { tier: null, n: 1 }]);
      expect(await countRowTrustTiers(raw, table)).toEqual([{ tier: 'unknown', n: 4 }, { tier: null, n: 1 }]);
      expect(calls).toEqual([{ sql: `SELECT trust_tier AS tier, count(*) AS n FROM ${table} GROUP BY trust_tier`, params: undefined }]);
    }
  });

  test('claim-lifted rows: the channel probe of the relower dry run', async () => {
    const { raw, calls } = recorder([{ n: '2' }]);
    expect(await countClaimLiftedRows(raw, 'takes')).toBe(2);
    // #10178: a row the owner decided since the claim (owner_decision) is settled, so the relower does not count it.
    expect(calls).toEqual([{ sql: "SELECT count(*) AS n FROM takes WHERE write_origin->>'channel' = 'trust_claim' AND write_origin->'owner_decision' IS NULL", params: undefined }]);
  });

  test('legacy unknown rows per source: the legacyUnknownBySource union, ceilings and scope bound', async () => {
    const { raw, calls } = recorder([{ source_id: 'default', n: '5' }]);
    const ceilings = { pages: 10, facts: 20, takes: 30, timeline_entries: 40 };
    expect(await countLegacyUnknownBySource(raw, ceilings, ['default'])).toEqual([{ source_id: 'default', n: 5 }]);
    expect(calls[0]!.params).toEqual([10, 20, 30, 40, ['default']]);
    // The statement is the old union; the ceilings and the scope are bound where it spliced them.
    const old = `SELECT source_id, sum(n)::bigint AS n FROM (
       SELECT p.source_id, count(*) AS n FROM pages p WHERE p.trust_tier = 'unknown' AND p.deleted_at IS NULL AND ${legacyRowSql('pages', 'p', ceilings)} AND p.source_id = ANY($1::text[]) GROUP BY 1
       UNION ALL SELECT f.source_id, count(*) FROM facts f WHERE f.trust_tier = 'unknown' AND ${legacyRowSql('facts', 'f', ceilings)} AND f.source_id = ANY($1::text[]) GROUP BY 1
       UNION ALL SELECT p.source_id, count(*) FROM takes t JOIN pages p ON p.id = t.page_id WHERE t.trust_tier = 'unknown' AND ${legacyRowSql('takes', 't', ceilings)} AND p.source_id = ANY($1::text[]) GROUP BY 1
       UNION ALL SELECT p.source_id, count(*) FROM timeline_entries te JOIN pages p ON p.id = te.page_id WHERE te.trust_tier = 'unknown' AND ${legacyRowSql('timeline_entries', 'te', ceilings)} AND p.source_id = ANY($1::text[]) GROUP BY 1
     ) u GROUP BY source_id`;
    const bound = squash(calls[0]!.sql).replace(/\$([1-4])::bigint/g, (_, n: string) => String(Object.values(ceilings)[Number(n) - 1]))
      .replace(/\(\$5::text\[\] IS NULL OR ([a-z]+\.source_id) = ANY\(\$5::text\[\]\)\)/g, (_, column: string) => `${column} = ANY($1::text[])`);
    expect(bound).toBe(squash(old));
    // No ceilings: every id passes, and no scope is a null array.
    const none = recorder();
    await countLegacyUnknownBySource(none.raw, null);
    expect(none.calls[0]!.params).toEqual([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, null]);
  });

  test('trust columns: the information_schema read readColumns ran', async () => {
    const { raw, calls } = recorder([{ table_name: 'pages', column_name: 'trust_tier' }]);
    expect(await listTrustColumns(raw)).toEqual([{ table_name: 'pages', column_name: 'trust_tier' }]);
    expect(calls).toEqual([{ sql: `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`, params: [['pages', 'facts', 'takes', 'timeline_entries', 'sources', 'persistence_requests']] }]);
  });

  test('trust claim targets: the three source reads of trust_sources_unclaimed and relowerClaimedRows', async () => {
    const owned = recorder();
    await listTrustClaimTargets(owned.raw, 'owned');
    expect(owned.calls).toEqual([{ sql: `SELECT s.id, ${claimedSourceSql('s')} AS claimed FROM sources s WHERE ${notConnectorSourceSql('s')}`, params: undefined }]);
    const named = recorder();
    await listTrustClaimTargets(named.raw, 'named', ['a', 'b']);
    expect(named.calls.map((c) => squash(c.sql))).toEqual([squash(`SELECT s.id, ${claimedSourceSql('s')} AS claimed FROM sources s
        WHERE s.id = ANY($1::text[]) AND ${notConnectorSourceSql('s')} ORDER BY s.id COLLATE "C"`)]);
    expect(named.calls[0]!.params).toEqual([['a', 'b']]);
    const claimed = recorder();
    await listTrustClaimTargets(claimed.raw, 'claimed');
    expect(claimed.calls).toEqual([{ sql: `SELECT s.id, true AS claimed FROM sources s WHERE ${claimedSourceSql('s')} ORDER BY s.id COLLATE "C"`, params: undefined }]);
  });

  test('every listed member is a classified engine member, once', () => {
    expect(new Set(DOCTOR_FACTS_TRUST_MEMBERS).size).toBe(DOCTOR_FACTS_TRUST_MEMBERS.length);
    for (const member of DOCTOR_FACTS_TRUST_MEMBERS) expect(Object.keys(RUST_ENGINE_MEMBERS)).toContain(member);
  });
});
