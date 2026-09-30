import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import type { MembershipSnapshot } from '../../src/core/shared-skills/membership-types.ts';
import type { SharedSkillList } from '../../src/core/shared-skills/model.ts';
import { distribution, sharedReadGateSample } from './lifecycle-metrics.ts';
import { overlapPercent } from '../persistence/read-metrics.ts';
import { createLifecycleFixture, identity, LIVE_NAME, PACK_ID, liveFixture, type BenchmarkPeer } from './lifecycle-fixture.ts';

export interface LifecycleWorkerOptions {
  root: string; size: number; members: number; queries: number; maxWrites: number; assetBytes: number;
  warmChecks: number; engine: 'pglite' | 'postgres'; databaseUrl?: string;
}
interface Receipt { request_id: string; state: string; revision?: string; outcome?: { revision?: string }; }

export async function runLifecycleWorker(options: LifecycleWorkerOptions) {
  assert.equal(process.env.GBRAIN_HOME, join(options.root, 'home'), 'Worker must use its isolated home');
  assert.equal(readFileSync(join(options.root, '.lifecycle-owned'), 'utf8'), process.env.GBRAIN_TEST_LIFECYCLE_OWNERSHIP, 'Worker must own its synthetic fixture directory');
  const result: Record<string, any> = { version: 1, corpus: options.size, engine: options.engine, runtime: Bun.version,
    machine: { architecture: process.arch, platform: process.platform, logical_cpus: availableParallelism(), cpu: cpus()[0]?.model,
      memory_bytes: totalmem(), load_average_start: loadavg() },
    transport: 'real loopback HTTP MCP SDK clients with distinct authenticated legacy principals and current explicit operation grants',
    native_harness_verified: false, notifications: 'No change-notification subscription is installed; all convergence is detected by polling.',
    thresholds: { median_loaded_p99_ratio_max: 1.5, public_mutation_overlap_min_pct: 90, independent_runs_required: 3 },
    interval_definition: 'Union of observed public put_skill invocation-to-terminal-receipt intervals; durable admission and actual commit are separately observed.',
    visibility_definition: 'First polling response received after the publisher receipt; observed client convergence latency, not the minimum server-side visibility delay.',
    read_sample: 'get_skill current head, then every non-prose asset at that exact revision, with byte/hash/metadata assertions',
    payload_bytes: 'UTF-8 JSON tool arguments/results and decoded asset bytes; excludes HTTP/TLS framing', correctness_pass: false };
  let fixture: Awaited<ReturnType<typeof createLifecycleFixture>> | undefined;
  let monitorRunning = false;
  let monitor: Promise<void> | undefined;
  let stage = 'fixture';
  let acknowledgmentCount = 0;
  const acknowledgmentIntervals: [number, number][] = [];
  const checkpoint = (phase: string) => { stage = phase; if (fixture) fixture.meter.phase = phase; };
  try {
    fixture = await createLifecycleFixture(options);
    const f = fixture;
    result.seed = f.seed;
    result.client_connections_ms = { publisher: f.publisher.connection_ms, members: f.members.map(member => member.connection_ms) };
    result.bounds = { members: options.members, queries_per_phase: options.queries, max_writes: options.maxWrites,
      asset_bytes: options.assetBytes, fetch_concurrency_per_member: 2, sample_period_ms: 25, per_tool_timeout_ms: 60_000 };
    const sample = { observations: 0, engine_api_calls: 0, period_ms: 25, outstanding_peak: 0, intent_bytes_peak: 0,
      recovery_bytes_sampled_peak: 0, queue_age_ms_peak: 0, rss_peak: process.memoryUsage().rss, errors: 0 };
    monitorRunning = true;
    monitor = (async () => {
      while (monitorRunning) {
        try {
          sample.engine_api_calls++;
          const [row] = await f.raw.executeRaw<Record<string, number | string>>(`SELECT
            COALESCE((SELECT outstanding_count FROM persistence_counters WHERE key='brain'),0) AS outstanding,
            COALESCE((SELECT intent_bytes FROM persistence_counters WHERE key='brain'),0) AS intent_bytes,
            COALESCE((SELECT recovery_bytes FROM persistence_counters WHERE key='brain'),0) AS recovery_bytes,
            COALESCE((SELECT MAX(EXTRACT(EPOCH FROM clock_timestamp()-created_at))*1000 FROM persistence_requests
              WHERE state IN ('queued','running','recovering')),0) AS queue_age_ms`);
          sample.observations++;
          sample.outstanding_peak = Math.max(sample.outstanding_peak, Number(row.outstanding));
          sample.intent_bytes_peak = Math.max(sample.intent_bytes_peak, Number(row.intent_bytes));
          sample.recovery_bytes_sampled_peak = Math.max(sample.recovery_bytes_sampled_peak, Number(row.recovery_bytes));
          sample.queue_age_ms_peak = Math.max(sample.queue_age_ms_peak, Number(row.queue_age_ms));
          sample.rss_peak = Math.max(sample.rss_peak, process.memoryUsage().rss);
        } catch { sample.errors++; }
        if (monitorRunning) await Bun.sleep(25);
      }
    })();
    result.rss_after_fixture = process.memoryUsage().rss;

    async function sync(member: BenchmarkPeer, acknowledgment?: Record<string, unknown>) {
      assert(member.joined, 'Member must be enrolled before sync');
      const snapshot = await f.call<MembershipSnapshot>(member, 'sync_brain_skills', {
        installation_id: member.joined.installation_id, enrollment_epoch: member.joined.enrollment_epoch,
        ...(acknowledgment ? { acknowledgment } : {}),
      });
      assert(snapshot.complete); assert.equal(snapshot.skills.length, options.size); assert.equal(snapshot.blocked_skills.length, 0);
      member.joined = snapshot;
      return snapshot;
    }
    async function fetchAndAcknowledge(member: BenchmarkPeer, snapshot: MembershipSnapshot) {
      const missing = snapshot.skills.filter(skill => member.cache.get(skill.name) !== skill.revision);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(2, missing.length) }, async () => {
        while (next < missing.length) { const skill = missing[next++]; await f.verifyAndFetch(member, skill); }
      }));
      assert(snapshot.skills.every(skill => member.cache.get(skill.name) === skill.revision), 'Every acknowledged revision must have been fetched and verified by this member');
      const started = performance.now();
      const acknowledged = await sync(member, { batch_token: snapshot.batch_token, view_token: snapshot.view_token,
        evidence: { stage: 'fetched', revisions: snapshot.skills.map(identity) } });
      assert(['recorded', 'replayed'].includes(acknowledged.acknowledgment ?? ''), 'A quiescent verified batch acknowledgment must be recorded');
      acknowledgmentCount++; acknowledgmentIntervals.push([started, performance.now()]);
      return acknowledged;
    }
    checkpoint('cold_join');
    const joinStart = performance.now();
    const joins = await Promise.all(f.members.map(async member => {
      const start = performance.now();
      const snapshot = await f.call<MembershipSnapshot>(member, 'join_brain', { adapter: 'generic', follow_policy: { approved: true } });
      assert.equal(snapshot.status, 'catalog_visible'); assert(snapshot.complete); assert.equal(snapshot.skills.length, options.size);
      assert.equal(snapshot.delivery.native, 'unverified'); member.joined = snapshot;
      return performance.now() - start;
    }));
    result.cold_join = { ...distribution(joins), concurrent_wall_ms: performance.now() - joinStart };
    checkpoint('cold_fetch_and_ack');
    const fetchStart = performance.now();
    await Promise.all(f.members.map(member => fetchAndAcknowledge(member, member.joined!)));
    result.cold_fetch_and_ack = { wall_ms: performance.now() - fetchStart, verified_members: f.members.length,
      verified_skill_revisions: options.size * f.members.length, evidence: 'fetched bytes only; not installed or native use' };

    checkpoint('warm_view_checks');
    const warm: number[] = [];
    const initialViews = await Promise.all(f.members.map(member => f.call<SharedSkillList>(member, 'list_skills', { schema_version: 2, limit: 100 })));
    for (let round = 0; round < options.warmChecks; round++) await Promise.all(f.members.map(async (member, index) => {
      const started = performance.now();
      const catalog = await f.call<SharedSkillList>(member, 'list_skills', { schema_version: 2, limit: 100 });
      assert.equal(catalog.view_token, initialViews[index].view_token);
      const prior = member.joined!;
      const snapshot = await sync(member);
      assert.equal(snapshot.view_token, prior.view_token); assert.equal(snapshot.sequence, prior.sequence);
      warm.push(performance.now() - started);
    }));
    result.warm_view_checks = { ...distribution(warm), calls_per_sample: 'one compact list and one complete member sync' };

    let generation = 0;
    let live = f.members[0].joined!.skills.find(skill => skill.name === LIVE_NAME)!;
    const publications: Array<{ request_id: string; revision: string; generation: number; requested_at: number; committed_at: number; receipt_at: number }> = [];
    async function publish(): Promise<(typeof publications)[number]> {
      const requestId = randomUUID(); const requestedAt = performance.now(); const next = ++generation;
      f.meter.startWrite(requestId);
      let receipt = await f.call<Receipt>(f.publisher, 'put_skill', { request_id: requestId, expected_revision: live.revision,
        source_id: 'default', source_incarnation: f.incarnation, pack_id: PACK_ID, name: LIVE_NAME, files: liveFixture(next, options.assetBytes).files });
      const deadline = performance.now() + 60_000;
      while (['queued', 'running', 'recovering'].includes(receipt.state) && performance.now() < deadline) {
        await Bun.sleep(25); receipt = await f.call<Receipt>(f.publisher, 'get_write_request', { request_id: requestId });
      }
      assert.equal(receipt.state, 'committed', 'Every measured public mutation must obtain its original durable committed receipt');
      const revision = receipt.revision ?? receipt.outcome?.revision;
      assert.equal(typeof revision, 'string');
      const committedAt = f.meter.durableCommits.get(requestId);
      assert(committedAt !== undefined, 'The real coordinator transaction commit must be observed, not inferred from polling');
      f.meter.finishWrite(requestId);
      live = { ...live, revision: revision! };
      const publication = { request_id: requestId, revision: revision!, generation: next, requested_at: requestedAt, committed_at: committedAt, receipt_at: performance.now() };
      publications.push(publication); return publication;
    }
    async function pollChanged(publication: Awaited<ReturnType<typeof publish>>) {
      return Promise.all(f.members.map(async member => {
        const before = member.joined!.view_token; let polls = 0;
        const deadline = performance.now() + 30_000;
        let snapshot: MembershipSnapshot;
        for (;;) {
          snapshot = await sync(member); polls++;
          if (snapshot.skills.some(skill => skill.name === LIVE_NAME && skill.revision === publication.revision)) break;
          assert(performance.now() < deadline, 'A committed revision must become visible through bounded polling');
          await Bun.sleep(25);
        }
        assert.notEqual(snapshot.view_token, before, 'Changed metadata must change the authorized member view');
        const visibleAt = performance.now();
        const observed = snapshot.skills.find(skill => skill.name === LIVE_NAME)!;
        const expected = liveFixture(publication.generation, options.assetBytes);
        assert.equal(observed.description, expected.description); assert.deepEqual(observed.triggers, expected.triggers);
        await fetchAndAcknowledge(member, snapshot);
        return { polls, commit_to_metadata_visible_ms: visibleAt - publication.committed_at,
          request_to_metadata_visible_ms: visibleAt - publication.requested_at, commit_to_verified_ack_ms: performance.now() - publication.committed_at };
      }));
    }
    checkpoint('changed_metadata_missed_notification');
    const changed = await publish();
    result.changed_metadata_polling = await pollChanged(changed);
    result.initial_canonical_publication = { request_to_commit_ms: changed.committed_at - changed.requested_at,
      request_to_receipt_ms: changed.receipt_at - changed.requested_at };

    async function readPhase(): Promise<number[]> {
      const latencies: number[] = [];
      await Promise.all(f.members.map(async (member, memberIndex) => {
        for (let index = memberIndex; index < options.queries; index += f.members.length) {
          const started = performance.now(); await f.verifyAndFetch(member, live, true); latencies.push(performance.now() - started);
        }
      }));
      assert.equal(latencies.length, options.queries); return latencies;
    }
    checkpoint('idle_reads');
    const idle = await readPhase();
    f.meter.resetWrites();
    const pressureFirstPublication = publications.length;
    checkpoint('loaded_reads');
    let readsFinished = false; let writesFailed = 0; let writerError: unknown;
    const started = performance.now();
    const writer = (async () => {
      try {
        while (!readsFinished && publications.length - pressureFirstPublication < options.maxWrites) await publish();
      } catch (error) { writesFailed++; writerError = error; }
    })();
    let loaded: number[];
    let ended = started;
    try { loaded = await readPhase(); ended = performance.now(); } finally { readsFinished = true; await writer; }
    if (writerError) throw writerError;
    assert(publications.length > pressureFirstPublication, 'Pressure phase requires real canonical publications');
    result.gate_sample = sharedReadGateSample({ idle, loaded, started, ended, writes: f.meter.timings,
      durableCommits: [...f.meter.durableCommits.values()], failures: writesFailed, correctness: true });
    const pressureRecovery = f.meter.recovery.filter(record => f.meter.durableCommits.has(record.request_id));
    assert.equal(new Set(pressureRecovery.map(record => record.request_id)).size, publications.length - pressureFirstPublication,
      'Every pressure publication must reserve an observed durable file-set recovery record');
    result.publication = { count: publications.length - pressureFirstPublication, cap_reached: publications.length - pressureFirstPublication === options.maxWrites,
      admission: distribution(f.meter.timings.admissionMs), receipt: distribution(f.meter.timings.completionMs),
      commit: distribution(publications.slice(pressureFirstPublication).map(write => write.committed_at - write.requested_at)),
      journal_intent_bytes: { samples: f.meter.admissionIntentBytes.length, total: f.meter.admissionIntentBytes.reduce((sum, bytes) => sum + bytes, 0), peak: Math.max(0, ...f.meter.admissionIntentBytes) },
      recovery_reserved_bytes: { observations: pressureRecovery.length, total: pressureRecovery.reduce((sum, record) => sum + record.bytes, 0), peak: Math.max(0, ...pressureRecovery.map(record => record.bytes)) } };
    checkpoint('final_poll_and_ack');
    result.final_polling = await pollChanged(publications.at(-1)!);
    const ackStart = Math.min(...acknowledgmentIntervals.map(([start]) => start));
    const ackEnd = Math.max(...acknowledgmentIntervals.map(([, end]) => end));
    const activeAckMs = overlapPercent(ackStart, ackEnd, acknowledgmentIntervals) * (ackEnd - ackStart) / 100;
    result.acknowledgments = { complete_verified_batches: acknowledgmentCount,
      latency: distribution(acknowledgmentIntervals.map(([start, end]) => end - start)), active_wall_ms: activeAckMs,
      batches_per_active_wall_second: acknowledgmentCount * 1000 / activeAckMs,
      batches_per_measured_lifecycle_second: acknowledgmentCount * 1000 / (performance.now() - joinStart),
      native_claim: 'none; all evidence is verified fetch self-report' };
    checkpoint('cleanup_verification');
    const drainStart = performance.now();
    let queue: { outstanding: number; recovery_bytes: string };
    for (;;) {
      [queue] = await f.raw.executeRaw<typeof queue>(`SELECT outstanding_count::int AS outstanding,recovery_bytes::text FROM persistence_counters WHERE key='brain'`);
      const [unsettled] = await f.raw.executeRaw<{ count: number }>(`SELECT COUNT(*)::int AS count FROM persistence_requests WHERE state<>'committed' OR recovery IS NOT NULL`);
      if (Number(queue.outstanding) === 0 && Number(queue.recovery_bytes) === 0 && unsettled.count === 0) break;
      assert(performance.now() - drainStart < 30_000, 'All benchmark requests and recovery records must settle');
      await Bun.sleep(25);
    }
    monitorRunning = false; await monitor;
    assert.equal(sample.errors, 0, 'Sampler errors invalidate the workload');
    result.queue_and_memory = { ...sample, drain_ms: performance.now() - drainStart, rss_end: process.memoryUsage().rss, outstanding_end: queue.outstanding, recovery_bytes_end: Number(queue.recovery_bytes) };
    result.phases = f.meter.phases;
    assert(Object.values(f.meter.phases).every(phase => phase.errors === 0), 'No read, write, or membership error can count as a successful measurement');
    result.correctness_pass = true;
  } catch (error) {
    const value = error as { name?: string; code?: string; operation?: string; message?: string };
    result.failure = { phase: stage, name: value.name ?? 'Error', code: value.code ?? 'assertion_or_runtime_failure', operation: value.operation,
      message: value.name === 'AssertionError' ? value.message?.split('\n')[0] : undefined };
  } finally {
    monitorRunning = false;
    await monitor;
    if (fixture) {
      result.phases = fixture.meter.phases;
      try { await fixture.close(); } catch { result.correctness_pass = false; result.cleanup_failed = true; }
    }
  }
  return result;
}
