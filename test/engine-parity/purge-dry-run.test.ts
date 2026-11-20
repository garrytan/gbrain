/**
 * BrainEngine parity — the dry run of a fact purge (`verifyFactPurge` with `dryRun`), end to end.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a fact purge's dry-run receipt (its stores and residuals) is the same on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1). The dry run probes every reported store for
 *    the claim through `countPurgeProbe` and names the carrying rows of a named store through `listPurgeProbeItems`.
 *  - Regression: the Rust arm refused the dry run at the first reported store it kept but did not probe
 *    (calibration_profiles), so `gbrain forget <id> --purge` printed no receipt on a Rust brain. A store that answers
 *    the probe differently shows the user a different list of rows that still carry the claim.
 *  - Why existing coverage misses it: test/engine-parity/purge-plan.test.ts compares each probe member with the stores
 *    the Rust arm already probed; no case ran the whole dry run, which reaches every reported store.
 *  - Seam: rows are seeded through the typed writers of each store (insertFact, insertCalibrationProfile,
 *    insertDecideReceipts, putDreamVerdict, logEvalCandidate, putContradictionCacheEntry, writeContradictionsRun,
 *    upsertFactRelinkAttempt, logIngest, logMcpRequest, admitJob, postInboxMessage, insertJobAttachment,
 *    insertTopologyChange, insertSubagentMessage, recordSubagentToolExecutions). Generated ids are replaced by labels.
 *    A caught typed refusal is returned as a value, so an arm that refuses the dry run fails the comparison.
 */
import { createHash } from 'node:crypto';
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AdmitJobPolicy, JobInsertValues } from '../../src/core/engine-sql/jobs.ts';
import { APPLICATION_AUTHORITY, coalesceDecision, parseSubmissionAuthority } from '../../src/core/minions/submission-authority.ts';
import { planFactPurge } from '../../src/core/facts/purge.ts';
import { verifyFactPurge } from '../../src/core/facts/purge-verify.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const CLAIM = 'Acme "raised" a Seed';
const WRITER = 'd0000000-0000-4000-8000-0000000000d1';
const REQUEST = 'e0000000-0000-4000-8000-0000000000e1';

const policy: AdmitJobPolicy = {
  decide: async (_tx, row) => coalesceDecision(row, APPLICATION_AUTHORITY),
  parentAuthorityKind: raw => parseSubmissionAuthority(raw)?.kind ?? null,
};

function job(name: string, extra: Partial<JobInsertValues> = {}): JobInsertValues {
  return {
    name, queue: 'default', status: 'waiting', priority: 0, data: {}, max_attempts: 3, backoff_type: 'exponential',
    backoff_delay: 1000, backoff_jitter: 0.2, delay_until: null, parent_job_id: null, on_child_fail: 'fail_parent',
    max_children: null, timeout_ms: null, lock_duration_ms: null, remove_on_complete: false, remove_on_fail: false,
    idempotency_key: null, quiet_hours: null, stagger_key: null, private_queue_owner_job_id: null,
    private_queue_owner_token: null, private_queue_lease_until: null, submission_authority: APPLICATION_AUTHORITY,
    spend_authorization: null, max_stalled: null, ...extra,
  };
}

async function addJob(engine: BrainEngine, name: string, extra: Partial<JobInsertValues> = {}): Promise<number> {
  const out = await engine.admitJob({ maxSpawnDepth: 5, insert: job(name, extra) }, policy);
  expect(out.coalesced).toBe(false);
  return Number(out.row.id);
}

/** The fact the purge targets, and its plan. */
async function target(engine: BrainEngine) {
  const r = await engine.insertFact({ fact: CLAIM, entity_slug: null, source: 'chat' }, { source_id: SRC });
  expect(r.status).toBe('inserted');
  const t = await engine.loadPurgeTarget(r.id, SRC);
  expect(t).not.toBeNull();
  return { id: r.id, target: t!, plan: await planFactPurge(engine, t!, false) };
}

/** The dry-run receipt as the arms must agree on it (the fact id replaced), or the typed refusal that stopped it. */
async function dryRun(engine: BrainEngine) {
  const { id, target: t, plan } = await target(engine);
  try {
    const receipt = await verifyFactPurge(engine, { target: t, plan, dryRun: true });
    expect(receipt.fact_id).toBe(id);
    // The physical-copy residual names the engine's own vacuum advice; every other line is engine-independent.
    const residuals = receipt.residuals.map(r => r.store === 'database_physical' ? { ...r, detail: '<engine vacuum advice>' } : r);
    return { ...receipt, fact_id: '<fact>', residuals };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'engine_capability_missing') return { refused: code, message: (error as Error).message };
    throw error;
  }
}

const reported = (receipt: Awaited<ReturnType<typeof dryRun>>, stores: readonly string[]): unknown =>
  'stores' in receipt ? Object.fromEntries(receipt.stores.filter(s => stores.includes(s.store)).map(s => [s.store, [s.status, s.remaining ?? 0]])) : receipt;

const SEEDED = [
  'calibration_profiles', 'decision_receipts', 'dream_verdicts', 'eval_candidates', 'eval_contradictions_cache',
  'eval_contradictions_runs', 'fact_relink_attempts', 'ingest_log', 'mcp_request_log', 'minion_attachments', 'minion_inbox',
  'minion_jobs', 'persistence_topology_changes', 'subagent_messages', 'subagent_tool_executions',
] as const;

describe('engine parity: fact purge dry run', () => {
  parityTest('a dry run of a fact no other store mentions reports every store the same way on every engine', {
    methods: ['insertFact', 'loadPurgeTarget', 'countPurgeProbe', 'countLegacyDerivedPages', 'countFactFingerprintLeftovers'],
  }, async (engine) => {
    const receipt = await dryRun(engine);
    expect(reported(receipt, SEEDED)).toEqual(Object.fromEntries(SEEDED.map(s => [s, ['not_present', 0]])));
    return receipt;
  });

  parityTest('a dry run reports each store that still mentions the claim, scoped to the source where the store has one', {
    methods: ['insertFact', 'loadPurgeTarget', 'countPurgeProbe', 'countLegacyDerivedPages', 'countFactFingerprintLeftovers', 'insertCalibrationProfile', 'insertDecideReceipts', 'putDreamVerdict', 'logEvalCandidate',
      'putContradictionCacheEntry', 'writeContradictionsRun', 'upsertFactRelinkAttempt', 'logIngest', 'logMcpRequest', 'admitJob',
      'postInboxMessage', 'insertJobAttachment', 'readLedgerSource', 'insertTopologyChange', 'insertSubagentMessage',
      'recordSubagentToolExecutions'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'elsewhere');
    const upper = CLAIM.toUpperCase();
    const profile = (sourceId: string, patternStatements: string[], domainScorecards: Record<string, unknown>) => engine.insertCalibrationProfile({
      sourceId, holder: 'self', totalResolved: 1, brier: 0.3, accuracy: 0.7, partialRate: 0.1, gradeCompletion: 0.9, domainScorecards,
      patternStatements, voiceGatePassed: true, voiceGateAttempts: 1, activeBiasTags: [CLAIM], modelId: 'model-a' });
    await profile(SRC, ['plain', `They said ${CLAIM}`], {});
    await profile(SRC, ['plain'], { people: { note: upper } });
    await profile(SRC, ['nothing here'], { people: { n: 1 } });
    await profile('elsewhere', [CLAIM], {});
    const receipt = (id: string, sourceId: string | undefined, runMeta: string | null) => ({ decision_id: id, slot: 'conflict', mode: 'live',
      provider: 'typesafe:openai', outcome: 'kept', call_site: 'sweep', lane: 'sweep', ...(sourceId ? { source_id: sourceId } : {}), run_meta: runMeta });
    await engine.insertDecideReceipts([receipt('d1', SRC, `meta: ${CLAIM}`), receipt('d2', SRC, 'clean'), receipt('d3', SRC, null),
      receipt('d4', 'elsewhere', CLAIM)] as never);
    const verdict = (over: Record<string, unknown>) => ({ worth_processing: true, reasons: [], score: 0.5, content_type: null, segments: [],
      entities: [], model: 'triage-m1', triage_version: 1, ...over });
    await engine.putDreamVerdict('t/a.md', 'h1', verdict({ segments: [{ quote: CLAIM }] }) as never);
    await engine.putDreamVerdict('t/b.md', 'h1', verdict({ reasons: [upper] }) as never);
    await engine.putDreamVerdict('t/c.md', 'h1', verdict({ entities: ['companies/acme'] }) as never);
    const candidate = (query: string) => engine.logEvalCandidate({ tool_name: 'query', query, retrieved_slugs: [], retrieved_chunk_ids: [],
      source_ids: [SRC], expand_enabled: false, detail: null, detail_resolved: null, vector_enabled: false, expansion_applied: false,
      latency_ms: 1, remote: false, job_id: null, subagent_id: null } as never);
    await candidate(`did ${CLAIM}?`);
    await candidate('who runs acme');
    const key = { chunk_a_hash: 'a', chunk_b_hash: 'b', model_id: 'judge', prompt_version: 'v1', truncation_policy: 'head' };
    await engine.putContradictionCacheEntry({ ...key, verdict: { axes: [CLAIM] } });
    await engine.putContradictionCacheEntry({ ...key, chunk_a_hash: 'z', verdict: { contradicts: false } });
    const run = (id: string, report: Record<string, unknown>) => engine.writeContradictionsRun({ run_id: id, judge_model: 'j', prompt_version: 'v1',
      queries_evaluated: 1, queries_with_contradiction: 0, total_contradictions_flagged: 0, wilson_ci_lower: 0, wilson_ci_upper: 0,
      judge_errors_total: 0, cost_usd_total: 0, duration_ms: 1, source_tier_breakdown: {}, report_json: report } as never);
    await run('run-a', { notes: [upper] });
    await run('run-b', { notes: ['clean'] });
    const attempt = (sourceId: string, factId: number, reason: string | null) =>
      engine.upsertFactRelinkAttempt(sourceId, { factId, outcome: 'deduped', reason, tier: null, model: null, targetSlug: null, runId: null });
    await attempt(SRC, 9001, `dup of ${CLAIM}`);
    await attempt(SRC, 9002, null);
    await attempt('elsewhere', 9003, CLAIM);
    await engine.logIngest({ source_type: 'markdown', source_ref: 'a.md', pages_updated: [], summary: `ingested ${CLAIM}` });
    await engine.logIngest({ source_type: 'markdown', source_ref: 'b.md', pages_updated: [CLAIM] as never, summary: 'two' });
    await engine.logIngest({ source_type: 'markdown', source_ref: 'c.md', pages_updated: ['clean'], summary: 'three' });
    const request = (params: unknown, error: string | null) => engine.logMcpRequest({ token_name: 't', agent_name: 'agent-fork', operation: 'query',
      latency_ms: 1, status: error ? 'error' : 'success', error_message: error, params });
    await request({ q: CLAIM }, null);
    await request({ q: 'clean' }, `failed on ${upper}`);
    await request(null, null);
    const carrying = await addJob(engine, 'carrying', { data: { text: CLAIM } });
    const clean = await addJob(engine, 'clean');
    await engine.postInboxMessage(clean, 'cli', { note: upper });
    await engine.postInboxMessage(clean, 'cli', { note: 'hello' });
    const bytes = (name: string, text: string) => {
      const buf = new TextEncoder().encode(text);
      return { filename: name, content_type: 'text/plain', bytes: buf, size_bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
    };
    // A bytea store matches the claim's bytes exactly: the upper-cased copy is not a match.
    await engine.insertJobAttachment(carrying, bytes('a.txt', `says ${CLAIM}`));
    await engine.insertJobAttachment(carrying, bytes('b.txt', `says ${upper}`));
    const source = await engine.readLedgerSource(SRC);
    await engine.insertTopologyChange({ principalId: WRITER, requestId: REQUEST, digest: 'e'.repeat(64), operation: 'remove', sourceId: SRC,
      sourceIncarnation: source!.incarnation, worktreeIds: [], state: 'recovering', recovery: { note: CLAIM }, recoveryBytes: 1, intentBytes: 1,
      terminalBytes: 4096, outcome: null } as never);
    const blocks = (text: string) => JSON.stringify([{ type: 'text', text }]);
    await engine.insertSubagentMessage(clean, { message_idx: 0, role: 'user', content_blocks: blocks(CLAIM), tokens_in: null, tokens_out: null,
      tokens_cache_read: null, tokens_cache_create: null, model: null });
    await engine.insertSubagentMessage(clean, { message_idx: 1, role: 'assistant', content_blocks: blocks('clean'), tokens_in: null,
      tokens_out: null, tokens_cache_read: null, tokens_cache_create: null, model: null });
    await engine.recordSubagentToolExecutions(clean, [
      { message_idx: 1, ordinal: 0, tool_use_id: 'toolu_01', tool_name: 'brain_search', input: JSON.stringify({ q: upper }), status: 'pending' },
      { message_idx: 1, ordinal: 1, tool_use_id: 'toolu_02', tool_name: 'brain_search', input: JSON.stringify({ q: 'clean' }), status: 'pending' },
    ]);
    const out = await dryRun(engine);
    expect(reported(out, SEEDED)).toEqual({
      calibration_profiles: ['out_of_scope', 2], decision_receipts: ['out_of_scope', 1], dream_verdicts: ['out_of_scope', 2],
      eval_candidates: ['out_of_scope', 1], eval_contradictions_cache: ['out_of_scope', 1], eval_contradictions_runs: ['out_of_scope', 1],
      fact_relink_attempts: ['out_of_scope', 1], ingest_log: ['out_of_scope', 2], mcp_request_log: ['out_of_scope', 2],
      minion_attachments: ['out_of_scope', 1], minion_inbox: ['out_of_scope', 1], minion_jobs: ['out_of_scope', 1],
      persistence_topology_changes: ['out_of_scope', 1], subagent_messages: ['out_of_scope', 1], subagent_tool_executions: ['out_of_scope', 1],
    });
    return out;
  });
});
