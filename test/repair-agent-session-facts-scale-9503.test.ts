/**
 * #9503: `gbrain repair agent-session-facts` and doctor `agent_session_facts` on a brain whose facts table is large.
 *
 * Protects: owner twins are looked up only for facts of suspect sessions, each through the fingerprint index, so the
 * fingerprint work stays the same when the brain gains facts the preview never lists (on a brain with about 140k facts
 * the old per-fact table scan ran past the 5 minute statement timeout); the owner-twin classification is unchanged.
 * The test counts fingerprint evaluations with a counting copy of gbrain_fact_fingerprint that returns the same hash, and
 * prices sequential scans out so a table this small takes the index path the planner picks on a real-size brain. The
 * take lookup groups contributing facts in one pass over the table instead of scanning it once per take.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { writeSpeakerSidecar } from '../src/core/context/session-speaker.ts';
import { agentSessionTakes, classifyAgentSessionFacts } from '../src/core/repair/agent-session-facts.ts';

const ALICE = 'people/alice-example';
const UNLISTED_FACTS = 200;
const TAKES = 30;

describe('agent-session-facts classification cost follows the suspect facts (#9503)', () => {
  let engine: PGLiteEngine;
  let base: string;
  let corpus: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('CREATE SEQUENCE fingerprint_calls');
    await engine.executeRaw('SET enable_seqscan = off');
    await engine.executeRaw(`CREATE OR REPLACE FUNCTION gbrain_fact_fingerprint(claim TEXT) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT AS $fn$
      BEGIN PERFORM nextval('public.fingerprint_calls'); RETURN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(public.gbrain_fact_normalize(claim), 'UTF8')), 'hex'); END $fn$`);
    base = mkdtempSync(join(tmpdir(), 'gbrain-agent-session-scale-'));
    corpus = join(base, 'corpus');
    mkdirSync(join(corpus, 'sourced'), { recursive: true });
    writeFileSync(join(corpus, 'sess-agent.txt'), '[user]\nPlease triage the open issues for the docs lane.\n\n[assistant]\nOn it.');
    writeSpeakerSidecar(corpus, 'sess-agent', { principal: 'worker-a', source: 'env' }, 'claude');
    writeFileSync(join(corpus, 'sess-owner.txt'), '[user]\nAlice Example and I talked about the launch plan today.\n\n[assistant]\nNoted.');
  });

  afterAll(async () => {
    await engine.disconnect();
    rmSync(base, { recursive: true, force: true });
  });

  const insert = async (fact: string, session: string | null, source = 'hook:writeback') => Number((await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_session, attributed_to)
      VALUES ('default', $1, $2, 'preference', 'private', $3, $4, 'user') RETURNING id`, [ALICE, fact, source, session]))[0]!.id);

  const counted = async () => {
    await engine.executeRaw('ANALYZE facts');
    const [before] = await engine.executeRaw<{ n: string }>("SELECT nextval('fingerprint_calls')::text AS n");
    const result = await classifyAgentSessionFacts(engine, ['default'], { corpusDir: corpus });
    const [after] = await engine.executeRaw<{ n: string }>("SELECT nextval('fingerprint_calls')::text AS n");
    return { calls: Number(after!.n) - Number(before!.n) - 1, classes: Object.fromEntries(result.candidates.map(c => [c.id, c.reason])), result };
  };

  test('fingerprint work does not grow with facts the preview never lists, and owner twins still exclude', async () => {
    const agent = await insert('Prefers terse status updates', 'sess-agent');
    const said = await insert('Prefers dark roast coffee', 'sess-agent');
    await insert('Prefers dark roast coffee', null, 'cli:remember');
    const echoed = await insert('Wants a weekly digest', 'sess-agent');
    await insert('Wants a weekly digest', 'sess-owner');

    const small = await counted();
    expect(small.classes).toEqual({ [agent]: 'speaker_sidecar', [said]: 'excluded:owner_also_said', [echoed]: 'excluded:owner_also_said' });
    expect(small.result.not_suspect).toBe(1);

    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_session, attributed_to)
      SELECT 'default', $1, 'Unlisted claim ' || g, 'preference', 'private', CASE WHEN g % 2 = 0 THEN 'hook:writeback' ELSE 'cli:remember' END,
        CASE WHEN g % 2 = 0 THEN 'sess-gone-' || g ELSE NULL END, 'user'
      FROM generate_series(1, $2::int) g`, [ALICE, UNLISTED_FACTS]);

    const large = await counted();
    expect(large.classes).toEqual(small.classes);
    expect(large.result.unclassifiable).toBe(UNLISTED_FACTS / 2);
    expect(large.calls).toBe(small.calls);
  });

  test('the take lookup reads the facts table about once, not once per take', async () => {
    await engine.executeRaw("INSERT INTO pages (source_id, slug, type, title, compiled_truth) VALUES ('default', $1, 'person', 'Alice Example', '')", [ALICE]);
    const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug=$1 AND source_id='default'", [ALICE]);
    const reattributed = new Set<number>();
    for (let n = 1; n <= TAKES; n++) {
      const fact = await insert(`Agent claim ${n}`, 'sess-agent');
      reattributed.add(fact);
      const [take] = await engine.executeRaw<{ id: number }>(`INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, since_date, source, active)
        VALUES ($1, $2, $3, 'fact', 'self', 0.8, '2026-10-01', 'hook:writeback', true) RETURNING id`, [page!.id, n, `Agent claim ${n}`]);
      await engine.executeRaw("UPDATE facts SET consolidated_into=$1, consolidated_at=now() - interval '1 minute' WHERE id=$2", [take!.id, fact]);
    }
    const factsRead = async () => {
      await engine.executeRaw('SELECT pg_stat_force_next_flush()');
      const [row] = await engine.executeRaw<{ n: string }>(
        "SELECT (COALESCE(seq_tup_read, 0) + COALESCE(idx_tup_fetch, 0))::text AS n FROM pg_stat_user_tables WHERE relname='facts'");
      return Number(row!.n);
    };
    const [{ n: total }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts');
    const before = await factsRead();
    const takes = await agentSessionTakes(engine, ['default'], reattributed);
    const read = (await factsRead()) - before;
    expect(takes.map(t => t.claim)).toEqual(Array.from({ length: TAKES }, (_, i) => `Agent claim ${i + 1}`));
    expect(read).toBeLessThanOrEqual(2 * total);
  });
});
