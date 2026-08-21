/**
 * Facts extraction outcome honesty — the silent-[] bug-class regression suite.
 *
 * Pins the D4/D6 contract:
 *   - keyless-expected chat_unavailable: NO ingest_log row, ONE calm stderr
 *     note (keyless is an expected state, not a failure)
 *   - keyed-but-failing: one ingest_log row (doctor reads it) + fix hint
 *   - transport-class failures (provider_error/truncated_output) THROW a
 *     typed FactsExtractionError; the queue-mode classifier maps it to
 *     precise absorb codes
 *   - the pre-enqueue gate consults the RESOLVED extraction model (a servable
 *     DB-plane override must never be skipped — the CX1 false-skip class)
 *   - durable facts-absorb jobs carry the slow-retry policy (max_attempts 5,
 *     60s backoff) and the handler retry-decision converts execution-time
 *     unavailability into a throw, never a silent consume
 *   - extract_facts returns reason-specific envelopes; the keyless one pins
 *     visibility: "private" (remember defaults to world)
 *   - put_page NEVER fails because its facts backstop threw (E1 invariant)
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';
import {
  runFactsBackstop,
  runFactsPipeline,
  __resetBackstopWarningsForTests,
} from '../src/core/facts/backstop.ts';
import {
  FactsExtractionError,
  _resetExtractWrapperWarningsForTests,
  extractFactsFromTurn,
} from '../src/core/facts/extract.ts';
import {
  classifyFactsAbsorbError,
  _resetFactsAbsorbDisconnectedFlagForTests,
} from '../src/core/facts/absorb-log.ts';
import { factsAbsorbShouldRetry } from '../src/commands/jobs.ts';
import { markShortLivedCliProcess, __resetShortLivedCliForTests } from '../src/core/facts/cli-process-mode.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let engine: PGLiteEngine;
const PINNED = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GBRAIN_MODEL', 'GBRAIN_HOME'] as const;
let saved: Record<string, string | undefined>;
let tmpHome: string;
let stderrCapture: string;
const origWrite = process.stderr.write.bind(process.stderr);
// backstop's warnOnce writes via console.warn (not process.stderr.write) —
// capture both channels into one buffer.
const origConsoleWarn = console.warn.bind(console);

function unwrap(r: { isError?: boolean; content: Array<{ text?: string }> }): Record<string, unknown> {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0].text ?? '{}') as Record<string, unknown>;
}

const ELIGIBLE_BODY =
  'An eligible substantive note body. ' +
  'Enough prose to clear the minimum body length gate for the backstop. '.repeat(3);

async function absorbRows(): Promise<Array<{ summary: string }>> {
  return engine.executeRaw<{ summary: string }>(
    `SELECT summary FROM ingest_log WHERE source_type = 'facts:absorb' ORDER BY created_at`,
  );
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

beforeEach(async () => {
  saved = {};
  for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; }
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-outcome-'));
  process.env.GBRAIN_HOME = tmpHome;
  resetGateway();
  __setChatTransportForTests(null);
  __resetBackstopWarningsForTests();
  __resetShortLivedCliForTests();
  _resetExtractWrapperWarningsForTests();
  _resetFactsAbsorbDisconnectedFlagForTests();
  await engine.executeRaw(`DELETE FROM ingest_log WHERE source_type = 'facts:absorb'`).catch(() => {});
  await engine.executeRaw(`DELETE FROM minion_jobs WHERE name = 'facts-absorb'`).catch(() => {});
  await engine.unsetConfig('facts.extraction_model').catch(() => {});
  stderrCapture = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrCapture += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  console.warn = ((...args: unknown[]) => { stderrCapture += args.map(String).join(' ') + '\n'; }) as typeof console.warn;
});

const restoreEnv = () => {
  process.stderr.write = origWrite;
  console.warn = origConsoleWarn;
  rmSync(tmpHome, { recursive: true, force: true });
  for (const k of PINNED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
};
afterEach(restoreEnv);

afterAll(async () => {
  __setChatTransportForTests(null);
  await engine.disconnect();
  // Shard hygiene: restore the legacy embedding pin (see
  // facts-extract-silent-no-op.test.ts for the poisoning story).
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

describe('keyless vs keyed chat_unavailable', () => {
  test('keyless: NO ingest_log row + one calm stderr note', async () => {
    configureGateway({ env: {} }); // keyless gateway
    const r = await runFactsBackstop(
      { slug: 'outcome-keyless', type: 'note', compiled_truth: ELIGIBLE_BODY, frontmatter: {} },
      { engine: engine as BrainEngine, sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'queue' },
    );
    expect(r.mode).toBe('queue');
    expect((r as { skipped?: string }).skipped).toBe('extraction_unavailable');
    expect(await absorbRows()).toHaveLength(0);
    expect(stderrCapture).toContain('keyless');
    // Calm: the note fires once per process, not per write.
    const before = stderrCapture.length;
    await runFactsBackstop(
      { slug: 'outcome-keyless-2', type: 'note', compiled_truth: ELIGIBLE_BODY, frontmatter: {} },
      { engine: engine as BrainEngine, sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'queue' },
    );
    expect(stderrCapture.length).toBe(before);
  });

  test('keyed-but-misrouted: one ingest_log row + fix hint', async () => {
    // An OpenAI key exists but the pinned extraction model is Anthropic with
    // no Anthropic key — a keyed problem the operator must see.
    process.env.OPENAI_API_KEY = 'sk-test';
    await engine.setConfig('facts.extraction_model', 'anthropic:claude-sonnet-4-6');
    configureGateway({ env: { OPENAI_API_KEY: 'sk-test' } });
    const r = await runFactsBackstop(
      { slug: 'outcome-misroute', type: 'note', compiled_truth: ELIGIBLE_BODY, frontmatter: {} },
      { engine: engine as BrainEngine, sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'queue' },
    );
    expect((r as { skipped?: string }).skipped).toBe('extraction_unavailable');
    const rows = await absorbRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toContain('chat_unavailable');
    expect(rows[0].summary).toContain('anthropic:claude-sonnet-4-6');
    expect(stderrCapture).toContain('facts.extraction_model');
  });

  test('pre-enqueue gate does NOT skip a servable DB-plane override (CX1 false-skip class)', async () => {
    // Global default would be Anthropic (unservable), but the DB-plane
    // extraction override IS servable with the OpenAI key — the engine-aware
    // gate must admit the work. Short-lived mode routes to the durable minion
    // (no LLM call executes in-test) so we can also pin the retry policy.
    process.env.OPENAI_API_KEY = 'sk-test';
    await engine.setConfig('facts.extraction_model', 'openai:gpt-4o-mini');
    configureGateway({ env: { OPENAI_API_KEY: 'sk-test' } });
    markShortLivedCliProcess();
    const r = await runFactsBackstop(
      { slug: 'outcome-servable-override', type: 'note', compiled_truth: ELIGIBLE_BODY, frontmatter: {} },
      { engine: engine as BrainEngine, sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'queue' },
    );
    expect(r.mode).toBe('queue');
    expect((r as { enqueued: boolean }).enqueued).toBe(true);
    expect((r as { skipped?: string }).skipped).toBeUndefined();
    const jobs = await engine.executeRaw<{ max_attempts: number; backoff_delay: number }>(
      `SELECT max_attempts, backoff_delay FROM minion_jobs WHERE name = 'facts-absorb'`,
    );
    expect(jobs).toHaveLength(1);
    // Slow-retry policy (R2-5): config drift is fixed on human timescales.
    expect(Number(jobs[0].max_attempts)).toBe(5);
    expect(Number(jobs[0].backoff_delay)).toBe(60_000);
  });
});

describe('transport-class failures throw typed', () => {
  test('provider_error propagates as FactsExtractionError in inline mode', async () => {
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    __setChatTransportForTests(async () => { throw new Error('simulated 500 from provider'); });
    let thrown: unknown;
    try {
      await runFactsPipeline('alice-example founded acme-example in 2010 with charlie-example.', {
        engine: engine as BrainEngine, sourceId: 'default', sessionId: null,
        source: 'mcp:extract_facts', mode: 'inline',
      });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(FactsExtractionError);
    expect((thrown as FactsExtractionError).reason).toBe('provider_error');
    expect((thrown as FactsExtractionError).model).toBeTruthy();
  });

  test('classifier maps typed reasons precisely (queue-mode absorb codes)', () => {
    expect(classifyFactsAbsorbError(new FactsExtractionError('provider_error', 'openai:gpt-5.2', new Error('401')))).toBe('gateway_error');
    expect(classifyFactsAbsorbError(new FactsExtractionError('truncated_output', 'openai:gpt-5.2'))).toBe('truncated_output');
    expect(classifyFactsAbsorbError(new FactsExtractionError('chat_unavailable'))).toBe('chat_unavailable');
  });

  test('durable-job retry decision: KEYED unavailable throws, keyless completes calm, real results return (CX9)', () => {
    const unavailable: import('../src/core/facts/backstop.ts').FactsBackstopResult =
      { mode: 'inline', inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], skipped: 'extraction_unavailable' };
    // Keyed worker + execution-time unavailability = config drift → retry.
    expect(factsAbsorbShouldRetry(unavailable, 'keyed')).toBe(true);
    expect(factsAbsorbShouldRetry({ mode: 'inline', inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], skipped_reason: 'chat_unavailable' }, 'keyed')).toBe(true);
    // Keyless worker = expected steady state → calm skip-success, never a
    // failed-retry loop on every page write.
    expect(factsAbsorbShouldRetry(unavailable, 'keyless')).toBe(false);
    expect(factsAbsorbShouldRetry({ mode: 'inline', inserted: 2, duplicate: 0, superseded: 0, fact_ids: [1, 2] }, 'keyed')).toBe(false);
    // refusal/malformed are NOT retryable drift — they logged and returned.
    expect(factsAbsorbShouldRetry({ mode: 'inline', inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], skipped_reason: 'malformed_output' }, 'keyed')).toBe(false);
    expect(factsAbsorbShouldRetry({ mode: 'queue', enqueued: true, queueDepth: 0 }, 'keyed')).toBe(false);
  });

  test('classifyUnavailable: keyed when any chat key or servable model exists; keyless otherwise', async () => {
    const { classifyUnavailable } = await import('../src/core/facts/backstop.ts');
    // Pinned env (beforeEach) + tmp GBRAIN_HOME → no keys anywhere → keyless.
    expect(await classifyUnavailable('anthropic:claude-sonnet-4-6')).toBe('keyless');
    process.env.OPENAI_API_KEY = 'sk-test';
    try {
      // A chat-capable key exists → a failure is a KEYED problem (visible).
      expect(await classifyUnavailable('anthropic:claude-sonnet-4-6')).toBe('keyed');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});

describe('extract_facts reason-specific envelopes', () => {
  test('keyless → skipped: extraction_unavailable + agent_action pinning visibility private (CX4)', async () => {
    configureGateway({ env: {} });
    const res = unwrap(await dispatchToolCall(engine, 'extract_facts', { turn_text: ELIGIBLE_BODY }, { remote: false }));
    expect(res.skipped).toBe('extraction_unavailable');
    expect(res.inserted).toBe(0);
    const action = String(res.agent_action);
    expect(action).toContain('remember');
    expect(action).toContain('visibility: "private"');
    expect(action).toContain('kind');
    expect(action).not.toContain('session id'); // remember has no session_id param (R2-8)
  });

  test('malformed extractor output → skipped: extraction_failed + reason (CX5 — never "unavailable")', async () => {
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    __setChatTransportForTests(async () => ({
      text: 'this is not json at all {{{',
      blocks: [{ type: 'text', text: 'this is not json at all {{{' }],
      stopReason: 'end' as const,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));
    const res = unwrap(await dispatchToolCall(engine, 'extract_facts', { turn_text: ELIGIBLE_BODY }, { remote: false }));
    expect(res.skipped).toBe('extraction_failed');
    expect(res.reason).toBe('malformed_output');
    expect(String(res.agent_action)).toContain('remember');
    // keyed-but-failing → visible to doctor
    const rows = await absorbRows();
    expect(rows.some((r) => r.summary.startsWith('malformed_output'))).toBe(true);
  });
});

describe('put_page never fails on extraction errors (E1 invariant)', () => {
  test('page write succeeds while the extraction transport throws', async () => {
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    __setChatTransportForTests(async () => { throw new Error('simulated provider outage'); });
    const res = await dispatchToolCall(engine, 'put_page', {
      slug: 'e1-invariant-page',
      content: `---\ntype: note\ntitle: E1 invariant\n---\n${ELIGIBLE_BODY}`,
    }, { remote: false });
    expect(res.isError).toBeFalsy();
    const page = await engine.getPage('e1-invariant-page', { sourceId: 'default' });
    expect(page).toBeTruthy();
    expect(page?.slug).toBe('e1-invariant-page');
    // Drain the in-process facts queue so the async failure lands, then
    // confirm it was absorbed as a LOG ROW, not a thrown write failure.
    const { getFactsQueue } = await import('../src/core/facts/queue.ts');
    await getFactsQueue().drainPending({ timeout: 10_000 });
    const rows = await absorbRows();
    expect(rows.some((r) => r.summary.startsWith('gateway_error'))).toBe(true);
  });
});

describe('legacy wrapper visibility (eng F3)', () => {
  test('extractFactsFromTurn warns once per reason instead of silent []', async () => {
    configureGateway({ env: {} }); // keyless → chat_unavailable
    const facts = await extractFactsFromTurn({ turnText: 'Some turn text.', source: 'test:wrapper' });
    expect(facts).toEqual([]);
    expect(stderrCapture).toContain('extraction skipped (chat_unavailable');
    const before = stderrCapture.length;
    await extractFactsFromTurn({ turnText: 'Another turn.', source: 'test:wrapper' });
    expect(stderrCapture.length).toBe(before); // once per reason per process
  });
});

describe('caller-resolved visibility pin (review-army addition)', () => {
  test('keyless envelope pins the CALLER visibility (world), not hardcoded private', async () => {
    configureGateway({ env: {} });
    const res = unwrap(await dispatchToolCall(engine, 'extract_facts', {
      turn_text: ELIGIBLE_BODY, visibility: 'world',
    }, { remote: false }));
    expect(res.skipped).toBe('extraction_unavailable');
    const action = String(res.agent_action);
    expect(action).toContain('visibility: "world"');
    expect(action).not.toContain('omitting it would widen');
  });
});

describe('coverage-gap additions (ship review)', () => {
  test('inline-lane keyless gate returns the skip envelope (the worker-consumed shape)', async () => {
    configureGateway({ env: {} });
    const r = await runFactsBackstop(
      { slug: 'outcome-inline-keyless', type: 'note', compiled_truth: ELIGIBLE_BODY, frontmatter: {} },
      { engine: engine as BrainEngine, sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'inline' },
    );
    expect(r.mode).toBe('inline');
    expect((r as { skipped?: string }).skipped).toBe('extraction_unavailable');
    expect((r as { inserted: number }).inserted).toBe(0);
  });

  test('CRITICAL placement rule: keyless SUBMITTER still enqueues the durable job (worker may be keyed)', async () => {
    configureGateway({ env: {} }); // keyless in the submitting process
    markShortLivedCliProcess();    // durable-submit lane
    const r = await runFactsBackstop(
      { slug: 'outcome-keyless-submit', type: 'note', compiled_truth: ELIGIBLE_BODY, frontmatter: {} },
      { engine: engine as BrainEngine, sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'queue' },
    );
    expect(r.mode).toBe('queue');
    expect((r as { enqueued: boolean }).enqueued).toBe(true); // NOT gated at submit time
    const jobs = await engine.executeRaw<{ name: string }>(
      `SELECT name FROM minion_jobs WHERE name = 'facts-absorb'`,
    );
    expect(jobs).toHaveLength(1);
  });

  test('FactsExtractionError redaction: JSON.stringify and spread omit the provider body', () => {
    const err = new FactsExtractionError('provider_error', 'openai:gpt-5.6-terra',
      new Error('401 Incorrect API key provided: sk-proj-****xyz'));
    expect(JSON.stringify(err)).not.toContain('sk-proj');
    expect(JSON.stringify({ ...err })).not.toContain('sk-proj');
    expect(err.message).not.toContain('sk-proj');
    // The cause stays reachable for local debugging.
    expect(String((err as { cause?: unknown }).cause)).toContain('401');
  });
});
