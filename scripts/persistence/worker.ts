import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { admitWrite, claimNextWrite, getWriteRequest, getWriteRequestById, receiptFor } from '../../src/core/persistence/journal.ts';
import { publishMutation, recoverPublication } from '../../src/core/persistence/coordinator.ts';
import { PersistenceConsumer } from '../../src/core/persistence/consumer.ts';
import { admission, assertCommittedSnapshot, assertConservation, distribution, fixtures, initializeFixtures,
  openEngine, prepared, type HarnessConfig } from './harness.ts';
import { runSchedules } from './schedules.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { boundedDiagnostic, diagnosticError, ownerDatabaseDiagnostic, soakFailureDiagnostic, type ActiveSoakRequest } from './failure-diagnostics.ts';

const [mode, configPath, argument, extra] = process.argv.slice(2);
const config: HarnessConfig = JSON.parse(readFileSync(configPath, 'utf8'));
const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);
const hold = () => { setInterval(() => {}, 1000); return new Promise<never>(() => {}); };
function synchronousCrashBoundary(event: Record<string, unknown>): never {
  const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(1, bytes, offset, bytes.length - offset);
    assert(written > 0); offset += written;
  }
  // No Promise/microtask return: the atomic utility cannot advance to rename.
  const blocked = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(blocked, 0, 0);
}

async function main() {
if (mode === 'initialize') {
  const engine = await openEngine(config, true); await initializeFixtures(engine, config); await engine.disconnect(); emit({ event: 'done' });
} else if (mode === 'schedules') {
  emit({ event: 'done', result: await runSchedules(config) });
} else if (mode === 'runtime-matrix') {
  const { runtimeCase } = await import('./matrix-cases.ts');
  emit({ event: 'done', result: await runtimeCase(config as import('./matrix-cases.ts').RuntimeCase) });
} else if (mode === 'ownership-matrix') {
  const { ownershipCases } = await import('./matrix-cases.ts');
  emit({ event: 'done', result: await ownershipCases(config) });
} else if (mode === 'crash') {
  const engine = await openEngine(config, true); await initializeFixtures(engine, config);
  const sources = await fixtures(engine, config); const source = sources[0];
  writeFileSync(join(source.root, 'crash.md'), 'original');
  const input = admission(config, source, 'crash', 'replacement', 0, { requestId: extra });
  const row = await admitWrite(engine, input);
  const stop = async () => { emit({ event: 'boundary', boundary: argument, rowId: row.id, requestId: row.request_id }); await hold(); };
  if (argument === 'admitted') await stop();
  const claimed = await claimNextWrite(engine, config.hostId); assert(claimed);
  const committed = await publishMutation(engine, claimed, prepared(claimed, sources, null, true), config.hostId,
    { boundary: async boundary => { if (boundary === argument) await stop(); },
      stagingFlushed: () => {
        if (argument === 'staging_flushed') synchronousCrashBoundary({ event: 'boundary', boundary: argument, rowId: row.id, requestId: row.request_id });
      } });
  if (argument === 'after_response') {
    assert.equal(committed.state, 'committed');
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return Response.json(receiptFor(committed)); } });
    emit({ event: 'response_ready', boundary: argument, requestId: row.request_id, url: server.url.toString() });
    await hold(); // The parent reads and validates the actual HTTP body before SIGKILL.
  }
  throw new Error(`Boundary ${argument} was not reached`);
} else if (mode === 'recover') {
  const engine = await openEngine(config); const sources = await fixtures(engine, config);
  try {
    const principal = { kind: 'local_cli' as const, id: config.principalIds[0] };
    let row = await getWriteRequest(engine, principal, extra); assert(row, 'RPO=0: acknowledged request must survive SIGKILL');
    const initialState = row.state; const path = join(sources[0].root, 'crash.md');
    const initialFile = readFileSync(path, 'utf8');
    await assertConservation(engine);
    const committedBoundary = argument === 'after_commit' || argument === 'after_response';
    const staged = row.recovery?.staging?.publication;
    if (argument === 'staging_flushed') {
      assert(staged, 'flushed file must be named in the durable recovery record');
      assert.equal(readFileSync(staged.path, 'utf8'), 'replacement');
      assert.equal(initialFile, 'original', 'synchronous flush boundary must precede rename');
      const reserved = Number(row.recovery_bytes);
      // A third-party edit after the actual SIGKILL must never be mistaken
      // for owned staging, even when it has exactly the attempted byte size.
      writeFileSync(staged.path, 'unexpected!');
      row = await recoverPublication(engine, row.id, config.hostId);
      assert.equal(row.state, 'recovering'); assert.equal(row.blocked_reason, 'unexpected_staging_bytes');
      assert.equal(readFileSync(staged.path, 'utf8'), 'unexpected!');
      assert.equal(Number(row.recovery_bytes), reserved); assert(reserved > 0);
      assert.equal(readFileSync(path, 'utf8'), 'original'); await assertConservation(engine);
      writeFileSync(staged.path, 'replacement'); // Explicit fixture repair; production never guesses these bytes.
    }
    if (committedBoundary) { await assertCommittedSnapshot(engine, row); assert.equal(initialFile, 'replacement'); }
    else assert.equal(await engine.readPageSnapshot('crash', { sourceId: sources[0].id }), null, 'uncommitted canonical changes must roll back');
    if (row.recovery) row = await recoverPublication(engine, row.id, config.hostId);
    if (staged) assert.equal(existsSync(staged.path), false, 'recovery must remove the recorded stage before releasing quota');
    if (!committedBoundary) {
      assert.equal(row.state, 'queued'); assert.equal(readFileSync(path, 'utf8'), 'original');
      const retry = await claimNextWrite(engine, config.hostId); assert(retry); assert.equal(retry.id, row.id);
      row = await publishMutation(engine, retry, prepared(retry, sources, null, true), config.hostId);
    }
    await assertCommittedSnapshot(engine, row); assert.equal(readFileSync(path, 'utf8'), 'replacement');
    const replay = await admitWrite(engine, admission(config, sources[0], 'crash', 'replacement', 0, { requestId: extra }));
    assert.equal(replay.id, row.id); assert.deepEqual(replay.outcome, row.outcome);
    assert.equal((await getWriteRequestById(engine, row.id))!.recovery, null); await assertConservation(engine);
    assert.deepEqual(readdirSync(sources[0].root).filter(name => name.includes('.tmp.')), [], 'no unaccounted temporary siblings remain');
    emit({ event: 'done', result: { boundary: argument, initial_state: initialState, initial_file: initialFile,
      retained_request: true, terminal_state: row.state, replay_preserved: true, counters_conserved: true,
      staging_cleanup_verified: true, ...(argument === 'staging_flushed' ? {
        flushed_before_rename_verified: true, unexpected_staging_preserved: true } : {}) } });
  } finally { await engine.disconnect(); }
} else if (mode === 'owner') {
  const engine = await openEngine(config); const sources = await fixtures(engine, config);
  const errors: string[] = []; const errorCodes: string[] = []; let peakRss = process.memoryUsage().rss;
  const readMs: number[] = []; let reading: Promise<void> | undefined;
  const readTimer = setInterval(() => {
    if (reading) return;
    reading = (async () => {
      const [row] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE state='committed' ORDER BY sequence DESC LIMIT 1");
      if (row) { const at = performance.now(); await assertCommittedSnapshot(engine, row); readMs.push(performance.now() - at); }
    })().catch(error => { errors.push(`concurrent canonical read: ${error}`); errorCodes.push(diagnosticError(error)); }).finally(() => { reading = undefined; });
  }, 1000);
  const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
  const consumer = new PersistenceConsumer(engine, { engine: config.kind }, async (_engine, row) => prepared(row, sources, null, true),
    { hostId: config.hostId, concurrency: config.kind === 'postgres' ? 2 : 1, pollMs: 250,
      onError: error => { errors.push(String(error)); errorCodes.push(diagnosticError(error)); process.stderr.write(`[persistence owner] ${error}\n`); } });
  const unregister = engine.registerBeforeDisconnect(() => consumer.stop());
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/submit' && request.method === 'POST') {
      const input = await request.json() as { index: number; principal: number; requestId: string };
      const a = admission(config, sources[input.principal % sources.length], `soak-${input.index}`, `body-${input.index}`, input.principal, { requestId: input.requestId });
      return Response.json(await admitWrite(engine, a));
    }
    if (url.pathname === '/receipt') {
      const row = await getWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[Number(url.searchParams.get('principal'))] }, url.searchParams.get('id')!);
      return Response.json(row);
    }
    if (url.pathname === '/diagnostics') {
      return Response.json({ at: new Date().toISOString(), pid: process.pid, consumer: consumer.status(),
        error_count: errors.length, recent_error_codes: errorCodes.slice(-8), canonical_read_in_flight: reading !== undefined,
        peak_rss_bytes: peakRss, database: await boundedDiagnostic(() => ownerDatabaseDiagnostic(engine), 1_000) });
    }
    if (url.pathname === '/stop' && request.method === 'POST') {
      clearInterval(readTimer); await reading;
      await consumer.stop(); unregister(); clearInterval(sample); await engine.disconnect();
      setTimeout(() => server.stop(true), 25);
      return Response.json({ errors, peak_rss_bytes: peakRss, concurrent_read_ms: readMs });
    }
    return new Response('fixture endpoint only', { status: 404 });
  } });
  consumer.start(); emit({ event: 'ready', url: server.url.toString() });
} else if (mode === 'producer') {
  const principal = Number(argument); const ownerUrl = extra;
  const engine = config.kind === 'postgres' ? await openEngine(config) : undefined;
  const sources = engine ? await fixtures(engine, config) : undefined;
  const admissionMs: number[] = []; const completionMs: number[] = []; let replays = 0;
  async function submit(index: number, requestId: string): Promise<WriteRequest> {
    if (engine) return admitWrite(engine, admission(config, sources![principal % sources!.length], `soak-${index}`, `body-${index}`, principal, { requestId }));
    const response = await fetch(new URL('submit', ownerUrl), { method: 'POST', body: JSON.stringify({ index, principal, requestId }) });
    assert(response.ok, `resident fixture admission failed: ${response.status}`); return response.json() as Promise<WriteRequest>;
  }
  const read = async (requestId: string): Promise<WriteRequest | null> => engine
    ? getWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[principal] }, requestId)
    : fetch(new URL(`receipt?principal=${principal}&id=${requestId}`, ownerUrl)).then(r => r.json()) as Promise<WriteRequest | null>;
  let completed = 0;
  const active = new Map<string, ActiveSoakRequest>();
  try {
    // Four independent producers each keep four logical writes in flight.
    const indexes = Array.from({ length: config.operations }, (_, i) => i).filter(i => i % config.principalIds.length === principal);
    let cursor = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (;;) {
        const offset = cursor++; if (offset >= indexes.length) return;
        const index = indexes[offset]; const requestId = randomUUID(); const at = performance.now();
        const observation: ActiveSoakRequest = { requestId, index, startedAt: at, receipt: null }; active.set(requestId, observation);
        const row = await submit(index, requestId); admissionMs.push(performance.now() - at);
        observation.receipt = row;
        if (index % 17 === 0) { assert.equal((await submit(index, requestId)).id, row.id); replays++; }
        const deadline = performance.now() + 120_000;
        for (;;) {
          const current = await read(requestId); observation.receipt = current; assert(current, 'accepted request disappeared');
          if (current.state === 'committed') { assert(current.outcome?.revision); break; }
          assert(['queued', 'running', 'recovering'].includes(current.state),
            `soak request ${current.request_id} terminated ${current.state}: ${current.error_code}: ${current.error_message}`);
          assert(performance.now() < deadline, 'soak receipt did not commit within 120 seconds');
          await Bun.sleep(100);
        }
        completionMs.push(performance.now() - at); completed++;
        active.delete(requestId);
        if (completed % 250 === 0) process.stderr.write(`[persistence] ${config.kind}: producer ${principal} verified ${completed} committed writes\n`);
      }
    }));
    emit({ event: 'done', result: { principal, completed, replays, admission_ms: admissionMs, completion_ms: completionMs } });
  } catch (error) {
    // Publish cached state before disconnect: a stuck connection must not hide
    // the original failure while the driver collects bounded owner diagnostics.
    try { emit({ event: 'failure', message: String(error), diagnostics: soakFailureDiagnostic(principal, completed, active.values()) }); }
    catch { /* Preserve the original error even if its diagnostic cannot be emitted. */ }
    throw error;
  } finally { await engine?.disconnect(); }
} else if (mode === 'verify-soak') {
  const engine = await openEngine(config); const sources = await fixtures(engine, config);
  try {
    const rows = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests ORDER BY sequence');
    assert.equal(rows.length, config.operations); assert.equal(new Set(rows.map(row => row.request_id)).size, config.operations);
    for (const row of rows) {
      await assertCommittedSnapshot(engine, row); assert.equal(row.recovery, null);
      const source = sources.find(s => s.id === row.source_id)!;
      assert.equal(readFileSync(join(source.root, `${row.slug}.md`), 'utf8'), row.intent!.content);
    }
    await assertConservation(engine);
    emit({ event: 'done', result: { verified: rows.length, committed: rows.length, file_checks: rows.length,
      snapshot_checks: rows.length, counters_conserved: true, pending: 0, unresolved_recovery: 0,
      accepted_to_commit: distribution(rows.map(row => new Date(row.completed_at!).getTime() - new Date(row.created_at).getTime())) } });
  } finally { await engine.disconnect(); }
} else throw new Error(`Unknown persistence worker role: ${mode}`);
}
try { await main(); }
catch (error) { emit({ event: 'failure', message: String(error) }); throw error; }
