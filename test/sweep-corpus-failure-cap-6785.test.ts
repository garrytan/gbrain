/**
 * #6785 — a corpus window that fails after its model call is not paid for
 * forever.
 *
 * A claimed but not activated canonical worktree refused every fence write
 * with writer_coordinator_required AFTER extraction. The window was never
 * committed, the claim was released, and the serve drain paid for the same
 * windows every 10 minutes for hours while discarding the report.
 *
 * Protects: the sweep and the compact harvest run the facts-absorb
 * owner-readiness preflight (#5362) before any model call and name
 * `gbrain sources writer status <id>`; a window that keeps failing after its
 * model call is retried on the next sweep, then after 10, 20 and 40 minutes,
 * then stopped at 5 attempts, whatever the error label and however the file
 * grows; one extraction-config change re-arms it once; the operator retry
 * (`gbrain sweep --retry-failed --apply`, named as doctor's paid fix)
 * extracts it and its facts land; the HTTP drain logs skip reasons and
 * thrown errors instead of discarding them. Stopped files never starve a
 * healthy one; a thrown window counts against the sweep total; a paid
 * window that cannot commit counts as a failure and a refused call does not;
 * the writeback harvest honours the cap; the drain and the doctor backlog
 * classify files like the sweep and ignore a stale record; a chat call
 * followed by a refused one still counts, an unpaid replay never does.
 *
 * The preflight, drain and cost assertions import only modules that predate
 * #6785 and fail on the old tree. Hermetic in-memory PGLite + transport stubs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { armCorpusDrain, CORPUS_INGESTED_SUFFIX, runMaintenanceSweep, type SweepReport } from '../src/core/sweep.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { toCorpusText } from '../src/core/transcripts/claude-code-jsonl.ts';
import { appendSegmentLedger, ensureCorpusSpoolDir, segmentFileName, sessionCorpusFileName, wbFileName, writeSegment } from '../src/core/context/corpus-segments.ts';
import { __drainCheckpointHarvestForTests, __resetCheckpointHarvestForTests, HARVEST_RECEIPT_SUFFIX, scheduleCheckpointHarvest } from '../src/core/context/checkpoint-harvest.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withAIInvocationGuard } from '../src/core/ai/invocation-guard.ts';
import { parseCorpusTurns } from '../src/core/context/corpus-turns.ts';
import { withEnv } from './helpers/with-env.ts';

const KEYED: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: true, provider: 'anthropic' },
  search: 'keyword-only',
  mode: 'keyed',
};
const MIN = 60_000;
const usage = { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 };
const tmpDirs: string[] = [];

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
const turnsText = (count: number, from = 0): string =>
  toCorpusText(Array.from({ length: count }, (_, i) => ({
    role: (from + i) % 2 === 0 ? 'user' as const : 'assistant' as const,
    text: `T${String(from + i).padStart(2, '0')} Alice Example prefers written status updates over meetings for the weekly review.`,
  })));
const skipped = (r: SweepReport, reason: string): number => r.skipped.find((s) => s.reason === reason)?.count ?? 0;
const fact = (entity: string | null) => JSON.stringify({ facts: [{ fact: 'Prefers written status updates over meetings.', kind: 'preference', entity, confidence: 1, notability: 'high' }] });

describe('#6785: a claimed, not activated worktree is held before any model call', () => {
  let engine: PGLiteEngine;
  let home: string;
  let chatCalls = 0;
  let onCall: (() => Promise<void>) | null = null;
  const logs: string[] = [];

  /** A source whose checkout holds one entity page the extracted fact is fenced onto. */
  async function addCheckout(sourceId: string): Promise<string> {
    const root = join(tmp(`gbrain-6785-${sourceId}-`), 'brain');
    mkdirSync(join(root, 'people'), { recursive: true });
    writeFileSync(join(root, 'people/alice-example.md'), '---\ntitle: Alice Example\ntype: person\n---\nAlice Example.\n');
    if (sourceId === 'default') await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [root]);
    else await engine.executeRaw('INSERT INTO sources(id, name, local_path) VALUES($1, $1, $2)', [sourceId, root]);
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example.' }, { sourceId });
    return root;
  }

  /** A fresh corpus dir holding one session file stamped for `sourceId`. */
  async function sessionFile(sourceId: string, session: string): Promise<string> {
    const dir = tmp('gbrain-6785-corpus-');
    await engine.setConfig('dream.synthesize.session_corpus_dir', dir);
    const file = join(ensureCorpusSpoolDir(dir), sessionCorpusFileName(session, sourceId));
    writeFileSync(file, turnsText(2));
    return file;
  }

  let defaultRoot: string;

  beforeAll(async () => {
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' } });
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      chatCalls++;
      if (onCall) await onCall();
      return { text: fact('people/alice-example'), blocks: [], stopReason: 'end', usage, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' };
    });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array(1536).fill(0.01)) })) as never);
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    home = tmp('gbrain-6785-home-');
    await engine.setConfig('sync.write_through', 'true');
    defaultRoot = await addCheckout('default');
    // Claimed and never activated, before any test runs.
    await claimWorktree(engine, 'claimed-example', await addCheckout('claimed-example'));
  }, 120_000);

  afterAll(async () => {
    __setChatTransportForTests(null);
    __setEmbedTransportForTests(null);
    resetGateway();
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
  });

  const sweep = (sourceId: string): Promise<SweepReport> => withEnv({ GBRAIN_HOME: home }, () =>
    runMaintenanceSweep(engine, { sourceId, capabilities: KEYED, budgetMs: 120_000, log: (m) => logs.push(m) }));

  test('the claim lands mid-call: that one call is lost, and every later sweep holds the file without paying', async () => {
    const file = await sessionFile('default', 'sess-mid-call');
    // The writer is claimed while the first extraction is in flight, so the
    // fence write after it is refused (the real failure path of #6785).
    onCall = async () => {
      onCall = null;
      await claimWorktree(engine, 'default', defaultRoot);
    };
    const first = await sweep('default');
    expect(chatCalls).toBeGreaterThan(0);
    expect(skipped(first, 'corpus_file_error')).toBe(1);
    const paid = chatCalls;

    for (let i = 0; i < 3; i++) {
      const r = await sweep('default');
      expect(chatCalls).toBe(paid);
      expect(skipped(r, 'writer_coordinator_required')).toBe(1);
    }
    expect(existsSync(file + CORPUS_INGESTED_SUFFIX)).toBe(false);
    expect(logs.join('\n')).toContain('(writer_coordinator_required)');
    expect(logs.join('\n')).toContain('gbrain sources writer status default');
  });

  test('the compact harvest holds a segment of a claimed source without paying', async () => {
    const dir = tmp('gbrain-6785-harvest-');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const w = writeSegment(dir, 'sess-claimed', turnsText(2, 10));
      appendSegmentLedger(dir, 'sess-claimed', w.hash);
      const name = segmentFileName('sess-claimed', w.hash);
      __resetCheckpointHarvestForTests();
      const before = chatCalls;
      expect(scheduleCheckpointHarvest({ engine, sourceId: 'claimed-example', sessionId: 'sess-claimed', corpusDir: dir, file: name, capabilities: KEYED }).status).toBe('scheduled');
      await __drainCheckpointHarvestForTests();
      expect(chatCalls).toBe(before);
      expect(existsSync(join(dir, name) + HARVEST_RECEIPT_SUFFIX)).toBe(false);
      expect(existsSync(join(dir, name) + CORPUS_INGESTED_SUFFIX)).toBe(false);
    });
  });

  test('the HTTP drain logs the skip reasons and the writer hint once, and a thrown tick says why', async () => {
    await sessionFile('claimed-example', 'sess-drain');
    const lines: string[] = [];
    const drain = armCorpusDrain(engine, { sourceId: 'claimed-example', env: {}, setIntervalFn: () => 0, clearIntervalFn: () => {}, log: (m: string) => lines.push(m) } as never)!;
    const before = chatCalls;
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await drain.tick();
      await drain.tick();
    });
    drain.cancel();
    expect(chatCalls).toBe(before);
    const text = lines.join('\n');
    expect(text).toContain('writer_coordinator_required');
    expect(text).toContain('gbrain sources writer status claimed-example');
    expect(lines.filter((l) => l.includes('gbrain sources writer status claimed-example')).length).toBe(1);

    const failing: string[] = [];
    const broken = armCorpusDrain(engine, { env: {}, setIntervalFn: () => 0, clearIntervalFn: () => {},
      sweep: async () => { throw new Error('drain fixture failure'); }, log: (m: string) => failing.push(m) } as never)!;
    await withEnv({ GBRAIN_HOME: home }, () => broken.tick());
    broken.cancel();
    expect(failing.join('\n')).toContain('drain fixture failure');
  });
});

describe('#6785: a window that keeps failing after its model call is capped', () => {
  let engine: PGLiteEngine;
  let dir: string;
  let home: string;
  let chatCalls = 0;
  let failing = true;
  const logs: string[] = [];

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    home = tmp('gbrain-6785-cap-home-');
  }, 120_000);

  beforeEach(async () => {
    dir = tmp('gbrain-6785-cap-');
    await engine.setConfig('dream.synthesize.session_corpus_dir', dir);
    failing = true;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      chatCalls++;
      if (failing) throw new Error('fixture failure after the model call');
      return { text: fact(null), blocks: [], stopReason: 'end', usage, model: 'anthropic:test-stub', providerId: 'anthropic' };
    });
  });

  afterEach(() => {
    __setChatTransportForTests(null);
  });

  afterAll(async () => {
    resetGateway();
    await engine.disconnect();
  });

  const at = async (nowMs: number, extra: { batchLimit?: number; env?: Record<string, string> } = {}): Promise<{ paid: boolean; calls: number; report: SweepReport }> => {
    const before = chatCalls;
    const report = await withEnv({ GBRAIN_HOME: home, ...extra.env }, () =>
      runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED, budgetMs: 120_000, now: () => nowMs, log: (m) => logs.push(m),
        ...(extra.batchLimit ? { batchLimit: extra.batchLimit } : {}) }));
    return { paid: chatCalls > before, calls: chatCalls - before, report };
  };
  /** A failure record that stops the file's window (count at the cap, no fingerprint to re-arm on). */
  const stopped = (file: string, key = 'k@0', incarnation: string | null = null): void => writeFileSync(file + '.failures.json', JSON.stringify({
    version: 1, key, source_incarnation: incarnation, count: 5, first_at: 0, last_at: 0, last_code: 'provider_error', fingerprint: null, rearmed: false,
  }) + '\n');

  /** Five failed attempts on the schedule: now, the next sweep, +10, +20, +40 minutes. */
  async function capped(file: string, t0: number): Promise<void> {
    writeFileSync(file, turnsText(2));
    const attempts = [];
    for (const m of [0, 0, 11, 32, 73]) attempts.push((await at(t0 + m * MIN)).paid);
    expect(attempts).toEqual([true, true, true, true, true]);
    expect(JSON.parse(readFileSync(file + '.failures.json', 'utf8')).count).toBe(5);
  }

  test('retried on the next sweep, then after 10, 20 and 40 minutes, then stopped; tail growth does not reset it', async () => {
    const file = join(dir, 'failing-session.txt');
    writeFileSync(file, turnsText(2));
    const t0 = Date.UTC(2026, 9, 15, 12);
    const attempts: boolean[] = [];
    attempts.push((await at(t0)).paid);              // 1
    attempts.push((await at(t0)).paid);              // 2: the next sweep retries at once
    const waiting = await at(t0 + 1 * MIN);          // backoff
    attempts.push(waiting.paid);
    expect(skipped(waiting.report, 'corpus_window_backoff')).toBe(1);
    appendFileSync(file, `\n\n${turnsText(1, 2)}`);  // the session grew
    attempts.push((await at(t0 + 11 * MIN)).paid);   // 3
    attempts.push((await at(t0 + 12 * MIN)).paid);   // backoff (20 minutes)
    attempts.push((await at(t0 + 32 * MIN)).paid);   // 4
    attempts.push((await at(t0 + 73 * MIN)).paid);   // 5
    expect(attempts).toEqual([true, true, false, true, false, true, true]);

    for (const later of [t0 + 200 * MIN, t0 + 2 * 1440 * MIN]) {
      const r = await at(later);
      expect(r.paid).toBe(false);
      expect(skipped(r.report, 'corpus_window_dead_lettered')).toBe(1);
    }
    expect(existsSync(file + CORPUS_INGESTED_SUFFIX)).toBe(false);
    expect(logs.join('\n')).toContain('gbrain sweep --retry-failed');
    const record = JSON.parse(readFileSync(file + '.failures.json', 'utf8'));
    expect(record.count).toBe(5);
    expect(record.last_code).toBe('provider_error');
    expect(JSON.stringify(record)).not.toContain('fixture failure after the model call');
  });

  test('one extraction-config change re-arms the capped window once; a second change does not', async () => {
    const file = join(dir, 'failing-session.txt');
    await capped(file, Date.UTC(2026, 9, 15, 12));
    expect((await at(Date.UTC(2026, 9, 16, 12))).paid).toBe(false);
    const t1 = Date.UTC(2026, 9, 20, 12);
    await engine.setConfig('facts.extraction_model', 'anthropic:claude-haiku-4-5');
    try {
      const rearmed = [(await at(t1)).paid, (await at(t1)).paid, (await at(t1 + 11 * MIN)).paid, (await at(t1 + 32 * MIN)).paid, (await at(t1 + 73 * MIN)).paid];
      expect(rearmed).toEqual([true, true, true, true, true]);
      expect((await at(t1 + 300 * MIN)).paid).toBe(false);
      await engine.setConfig('facts.extraction_model', 'anthropic:claude-sonnet-4-6');
      const second = await at(t1 + 400 * MIN);
      expect(second.paid).toBe(false);
      expect(skipped(second.report, 'corpus_window_dead_lettered')).toBe(1);
      expect(JSON.parse(readFileSync(file + '.failures.json', 'utf8')).rearmed).toBe(true);
    } finally {
      await engine.unsetConfig('facts.extraction_model');
    }
  });

  test('doctor names the paid retry; the operator retry previews, then extracts the window and its facts land', async () => {
    const file = join(dir, 'failing-session.txt');
    await capped(file, Date.UTC(2026, 9, 15, 12));
    const { buildMemoryWritebackCheck } = await import('../src/commands/doctor/checks/memory-writeback.ts');
    const check = await withEnv({ GBRAIN_HOME: home }, () => buildMemoryWritebackCheck(engine));
    expect(check.status).toBe('warn');
    expect(check.message).toContain('gbrain sweep --retry-failed --apply');
    const fix = (check as { fix?: { argv: string[]; consent: string[] } }).fix;
    expect(fix?.argv).toEqual(['gbrain', 'sweep', '--retry-failed', '--apply']);
    expect(fix?.consent).toEqual(['paid']);

    const { runSweep } = await import('../src/commands/sweep.ts');
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
    try {
      await runSweep(engine, ['--retry-failed', '--json']);
      expect(existsSync(file + '.failures.json')).toBe(true);
      await runSweep(engine, ['--retry-failed', '--apply', '--json']);
    } finally {
      console.log = log;
    }
    const preview = JSON.parse(out[0]);
    expect(preview.applied).toBe(false);
    expect(preview.files).toEqual([expect.objectContaining({ file: 'failing-session.txt', attempts: 5, stopped: true })]);
    expect(JSON.parse(out[1]).applied).toBe(true);
    expect(existsSync(file + '.failures.json')).toBe(false);

    failing = false;
    const r = await at(Date.UTC(2026, 9, 25, 12));
    expect(r.paid).toBe(true);
    expect(r.report.corpusIngested).toBe(1);
    expect(existsSync(file + CORPUS_INGESTED_SUFFIX)).toBe(true);
    const facts = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts WHERE source = 'sweep:corpus'`);
    expect(facts[0].n).toBeGreaterThan(0);
  });

  test('the cap is keyed to the window and the source incarnation, never to the error label', async () => {
    const { corpusFailureGate, recordCorpusFailure } = await import('../src/core/context/corpus-windows.ts');
    const full = join(dir, 'labels.txt');
    let rec = await recordCorpusFailure(full, null, 'k@0', 'inc-a', 'f1', 1, Object.assign(new Error('a'), { code: 'writer_coordinator_required' }));
    rec = await recordCorpusFailure(full, rec, 'k@0', 'inc-a', 'f1', 2, Object.assign(new Error('b'), { reason: 'provider_error' }));
    rec = await recordCorpusFailure(full, rec, 'k@0', 'inc-a', 'f1', 3, new TypeError('c'));
    expect([rec.count, rec.last_code]).toEqual([3, 'TypeError']);
    expect((await recordCorpusFailure(full, rec, 'k@9', 'inc-a', 'f1', 4, new Error('d'))).count).toBe(1);
    const record = { version: 1 as const, key: 'abc@0', source_incarnation: 'inc-a', count: 5, first_at: 0, last_at: 0, last_code: 'x', fingerprint: 'f1', rearmed: false };
    expect(corpusFailureGate(record, 'abc@0', 'inc-a', 'f1', 1e12)).toBe('dead_lettered');
    expect(corpusFailureGate(record, 'abc@0', 'inc-b', 'f1', 1e12)).toBe('run');
    expect(corpusFailureGate(record, 'def@0', 'inc-a', 'f1', 1e12)).toBe('run');
    expect(corpusFailureGate(record, 'abc@0', 'inc-a', 'f2', 1e12)).toBe('run');
    expect(corpusFailureGate({ ...record, rearmed: true }, 'abc@0', 'inc-a', 'f2', 1e12)).toBe('dead_lettered');
    expect(corpusFailureGate({ ...record, fingerprint: null }, 'abc@0', 'inc-a', 'f2', 1e12)).toBe('dead_lettered');
  });
  test('stopped files never take every batch slot: a healthy file behind them is still extracted', async () => {
    failing = false;
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>(`SELECT incarnation::text AS incarnation FROM sources WHERE id = 'default'`);
    for (const n of ['a-stopped-1.txt', 'a-stopped-2.txt', 'a-stopped-3.txt']) {
      writeFileSync(join(dir, n), turnsText(2));
      stopped(join(dir, n), `${parseCorpusTurns(turnsText(2))[0].sha256}@0`, incarnation);
    }
    const healthy = join(dir, 'z-healthy.txt');
    writeFileSync(healthy, turnsText(2));
    const r = await at(Date.UTC(2026, 9, 15, 12), { batchLimit: 2 });
    expect(r.report.corpusIngested).toBe(1);
    expect(r.calls).toBe(1);
    expect(skipped(r.report, 'corpus_window_dead_lettered')).toBe(1);
    expect(existsSync(healthy + CORPUS_INGESTED_SUFFIX)).toBe(true);
    expect(existsSync(join(dir, 'a-stopped-1.txt') + CORPUS_INGESTED_SUFFIX)).toBe(false);
  });

  test('a thrown window counts against the sweep total: GBRAIN_CORPUS_WINDOWS_PER_SWEEP=1 pays once', async () => {
    for (const n of ['fail-1.txt', 'fail-2.txt']) writeFileSync(join(dir, n), turnsText(2));
    const spool = ensureCorpusSpoolDir(dir);
    await engine.setConfig('memory.auto_writeback', 'salient');
    try {
      for (const h of ['c', 'd']) writeFileSync(join(spool, wbFileName(`sess-${h}`, h.repeat(24), 'default')), '[user]\nWB I keep a written log of every decision I make.\n');
      const r = await at(Date.UTC(2026, 9, 15, 12), { env: { GBRAIN_CORPUS_WINDOWS_PER_SWEEP: '1' } });
      expect(r.calls).toBe(1);
      expect(skipped(r.report, 'corpus_window_cap')).toBeGreaterThan(0);
    } finally {
      await engine.unsetConfig('memory.auto_writeback');
    }
  });

  test('a paid window whose progress cannot commit counts as a failure', async () => {
    failing = false;
    const file = join(dir, 'lock-held.txt');
    writeFileSync(file, turnsText(1));
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      chatCalls++;
      writeFileSync(file + '.progress.lock', `${process.pid}\n`);
      return { text: fact(null), blocks: [], stopReason: 'end', usage, model: 'anthropic:test-stub', providerId: 'anthropic' };
    });
    const r = await at(Date.UTC(2026, 9, 15, 12));
    rmSync(file + '.progress.lock', { force: true });
    expect(r.paid).toBe(true);
    expect(existsSync(file + CORPUS_INGESTED_SUFFIX)).toBe(false);
    const record = JSON.parse(readFileSync(file + '.failures.json', 'utf8'));
    expect([record.count, record.last_code]).toEqual([1, 'corpus_progress_contended']);
  });

  test('a call the spend guard refuses before the provider is not counted', async () => {
    const file = join(dir, 'refused.txt');
    writeFileSync(file, turnsText(2));
    const r = await withAIInvocationGuard(async () => { throw Object.assign(new Error('spend cap reached'), { code: 'budget_exceeded' }); },
      () => at(Date.UTC(2026, 9, 15, 12)));
    expect(r.calls).toBe(0);
    expect(existsSync(file + '.failures.json')).toBe(false);
    expect(existsSync(file + CORPUS_INGESTED_SUFFIX)).toBe(false);
  });

  test('the writeback harvest honours the cap: a stopped turn file is not paid for', async () => {
    failing = false;
    const spool = ensureCorpusSpoolDir(dir);
    const name = wbFileName('sess-wb-stopped', 'e'.repeat(24), 'default');
    const wb = join(spool, name);
    writeFileSync(wb, '[user]\nWB I keep a written log of every decision I make.\n');
    stopped(wb, 'turn');
    await engine.setConfig('memory.auto_writeback', 'salient');
    const before = chatCalls;
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        for (let i = 0; i < 3; i++) {
          expect(scheduleCheckpointHarvest({ engine, sourceId: 'default', sessionId: 'sess-wb-stopped', corpusDir: spool, file: name, lane: 'writeback', capabilities: KEYED }).status).toBe('scheduled');
          await __drainCheckpointHarvestForTests();
        }
      });
    } finally {
      await engine.unsetConfig('memory.auto_writeback');
    }
    expect(chatCalls).toBe(before);
    expect(existsSync(wb + CORPUS_INGESTED_SUFFIX)).toBe(false);
    expect(JSON.parse(readFileSync(wb + '.failures.json', 'utf8')).count).toBe(5);
  });

  test('the drain and the doctor backlog use the completion classifier: a rewritten finished file is pending, a stopped one does not wake the drain', async () => {
    failing = false;
    const file = join(dir, 'rewritten.txt');
    writeFileSync(file, turnsText(2));
    expect((await at(Date.UTC(2026, 9, 15, 12))).report.corpusIngested).toBe(1);
    const { corpusBacklog } = await import('../src/core/context/corpus-segments.ts');
    expect(corpusBacklog(dir, 30 * 1440 * MIN).pending).toBe(0);
    let drained = 0;
    const drain = () => armCorpusDrain(engine, { env: {}, setIntervalFn: () => 0, clearIntervalFn: () => {},
      sweep: async () => { drained++; return { skipped: [] }; }, log: () => {} } as never)!;
    const d1 = drain();
    await withEnv({ GBRAIN_HOME: home }, () => d1.tick());
    d1.cancel();
    expect(drained).toBe(0);

    writeFileSync(file, turnsText(3));
    expect(corpusBacklog(dir, 30 * 1440 * MIN).pending).toBe(1);
    const d2 = drain();
    await withEnv({ GBRAIN_HOME: home }, () => d2.tick());
    d2.cancel();
    expect(drained).toBe(1);

    rmSync(file + CORPUS_INGESTED_SUFFIX);
    const { corpusFrontierKey } = await import('../src/core/context/corpus-windows.ts');
    stopped(file, (await corpusFrontierKey(file, 'rewritten.txt'))!);
    const d3 = drain();
    await withEnv({ GBRAIN_HOME: home }, () => d3.tick());
    d3.cancel();
    expect(drained).toBe(1);

    // The session is rewritten past the stopped window: that record no longer applies.
    writeFileSync(file, turnsText(2, 10));
    const d4 = drain();
    await withEnv({ GBRAIN_HOME: home }, () => d4.tick());
    d4.cancel();
    expect(drained).toBe(2);
  });

  test('a failure after an admitted chat call counts even when a later call is refused; a result with no chat call does not', async () => {
    const { extractUnderFailureCount } = await import('../src/core/context/corpus-windows.ts');
    const { invokeAI } = await import('../src/core/ai/invocation-guard.ts');
    const full = join(dir, 'chat-then-refused.txt');
    const failure = { full, record: null, key: 'k@0', incarnation: null, fingerprint: null, nowMs: () => 1 };
    const refuseEmbeddings = async (call: { kind: string }) => {
      if (call.kind === 'embedding') throw Object.assign(new Error('embedding budget refused'), { code: 'budget_exceeded' });
      return { settle: async () => {} };
    };
    const chatThenEmbed = async () => {
      await invokeAI({ operation: 'extract', model: 'anthropic:test', kind: 'chat' }, async () => 'facts', () => null);
      try {
        await invokeAI({ operation: 'embed', model: 'openai:test', kind: 'embedding' }, async () => [0], () => null);
      } catch (e) {
        throw Object.assign(new Error('[facts-extract] wrapped'), { cause: e });
      }
    };
    await expect(withAIInvocationGuard(refuseEmbeddings, () => extractUnderFailureCount(failure, chatThenEmbed))).rejects.toThrow('wrapped');
    expect(JSON.parse(readFileSync(full + '.failures.json', 'utf8')).count).toBe(1);

    const replay = join(dir, 'replayed.txt');
    const unpaid = await extractUnderFailureCount({ ...failure, full: replay }, async () => 'cached receipt');
    expect(unpaid).toEqual({ value: 'cached receipt', paid: false });
  });

  test('a replayed window (no model call) whose progress cannot commit is not counted', async () => {
    const { corpusFileStat, runCorpusWindows } = await import('../src/core/context/corpus-windows.ts');
    const { statSync } = await import('node:fs');
    const file = join(dir, 'replay-contended.txt');
    writeFileSync(file, turnsText(1));
    const run = await runCorpusWindows({
      full: file, raw: readFileSync(file, 'utf8'), fileStat: corpusFileStat(statSync(file)), maxWindows: 8,
      overBudget: () => false, signal: new AbortController().signal,
      extract: async () => {
        writeFileSync(file + '.progress.lock', `${process.pid}\n`);
        return { inserted: 0, duplicate: 1, superseded: 0, fact_ids: [], entity_slugs: [] };
      },
    });
    rmSync(file + '.progress.lock', { force: true });
    expect(run.status).toBe('contended');
    expect(existsSync(file + '.failures.json')).toBe(false);
  });
  test('rewriting an earlier, consumed turn keeps the cap of an unchanged stopped window after it', async () => {
    const { corpusFileStat, recordCorpusFailure, runCorpusWindows } = await import('../src/core/context/corpus-windows.ts');
    const { statSync } = await import('node:fs');
    const file = join(dir, 'earlier-rewrite.txt');
    const turn = (marker: string) => `${marker} ${marker.toLowerCase().repeat(5000)}`;
    const b = `[assistant]\n${turn('B')}`;
    writeFileSync(file, `[user]\n${turn('A')}\n\n${b}`);
    const empty = () => ({ inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], entity_slugs: [] });
    const opts = () => ({ full: file, raw: readFileSync(file, 'utf8'), fileStat: corpusFileStat(statSync(file)), signal: new AbortController().signal,
      overBudget: () => false, source: { id: 'default', incarnation: 'inc-a' }, failures: { fingerprint: 'f1' } });
    await runCorpusWindows({ ...opts(), maxWindows: 1, extract: async () => empty() });
    const key = `${parseCorpusTurns(b)[0].sha256}@0`;
    let record = null;
    for (let i = 0; i < 5; i++) record = await recordCorpusFailure(file, record, key, 'inc-a', 'f1', 0, new Error('B fails'));

    writeFileSync(file, `[user]\n${turn('C')}\n\n${b}`);
    const seen: string[] = [];
    const run = await runCorpusWindows({ ...opts(), maxWindows: 3, extract: async (text) => { seen.push(text.includes('\nB ') || text.startsWith('B ') ? 'B' : 'C'); return empty(); } });
    expect(seen).toEqual(['C']);
    expect(run.status).toBe('dead_lettered');
    expect(JSON.parse(readFileSync(file + '.failures.json', 'utf8')).count).toBe(5);
  });
});
