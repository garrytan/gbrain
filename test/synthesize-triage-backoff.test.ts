/**
 * #6069: an unreliable significance verdict (truncated, refused, unparseable)
 * is not re-paid every cycle. runTriagePass writes a backoff marker into
 * dream_verdicts (score NULL, content_type triage_unreliable) and skips the
 * judge for that input until the backoff ends; force, a model change and a
 * content change re-judge at once. The stderr line names the stop reason,
 * response length and a digest, never the response text.
 *
 * Regression: before the fix the unreliable verdict wrote nothing, so the
 * second pass called the judge again (the reporter's ~280 paid calls).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  runTriagePass,
  isTriageCacheValid,
  TRIAGE_VERSION,
  type JudgeClient,
  type TriagePassCfg,
} from '../src/core/cycle/synthesize.ts';
import { triageBackoffMs } from '../src/core/cycle/triage-backoff.ts';
import type { DiscoveredTranscript } from '../src/core/cycle/transcript-discovery.ts';

const MODEL = 'anthropic:claude-haiku-4-5-20251001';
const SECRET = 'sk-live-transcript-secret-4242';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function transcript(name: string, content = `the user said ${SECRET} and more `.repeat(40)): DiscoveredTranscript {
  return {
    filePath: `/corpus/${name}.txt`,
    contentHash: createHash('sha256').update(content).digest('hex'),
    content,
    basename: name,
    inferredDate: null,
  };
}

function countingJudge(text: string, stopReason = 'end_turn'): JudgeClient & { calls: number } {
  const judge = {
    calls: 0,
    create: async () => {
      judge.calls++;
      return { content: [{ type: 'text', text }], stop_reason: stopReason } as never;
    },
  };
  return judge;
}

const UNPARSEABLE = `I cannot score this. The transcript mentions ${SECRET}.`;

function cfg(judge: JudgeClient, over: Partial<TriagePassCfg> = {}): TriagePassCfg {
  return { model: MODEL, maxChars: 24_000, maxTokens: 2048, threshold: 0.5, concurrency: 1, maxMs: 0, judge, ...over };
}

async function ageMarker(t: DiscoveredTranscript, hours: number): Promise<void> {
  await engine.executeRaw(
    `UPDATE dream_verdicts SET judged_at = now() - make_interval(hours => $3) WHERE file_path = $1 AND content_hash = $2`,
    [t.filePath, t.contentHash, hours],
  );
}

async function withStderr<T>(body: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => { chunks.push(String(c)); return true; };
  try {
    return { result: await body(), stderr: chunks.join('') };
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
}

describe('triage unreliable-verdict backoff (#6069)', () => {
  test('an unparseable verdict writes a marker that no reader takes as a verdict', async () => {
    const t = transcript('marker');
    const r = await runTriagePass(engine, [t], cfg(countingJudge(UNPARSEABLE)));
    expect(r.unreliable).toBe(1);
    const row = await engine.getDreamVerdict(t.filePath, t.contentHash);
    expect(row).not.toBeNull();
    expect(row!.score).toBeNull();
    expect(row!.content_type).toBe('triage_unreliable');
    expect(row!.reasons).toEqual(['unreliable:unparseable', 'attempt:1']);
    expect(row!.model).toBe(MODEL);
    expect(row!.triage_version).toBe(TRIAGE_VERSION);
    expect(row!.worth_processing).toBe(false);
    expect(isTriageCacheValid(row!, MODEL)).toBe(false);
    expect(r.byPath.has(t.filePath)).toBe(false);
  });

  test('the next pass inside the backoff makes zero judge calls and reports the file deferred', async () => {
    const t = transcript('within');
    await runTriagePass(engine, [t], cfg(countingJudge(UNPARSEABLE)));
    const judge = countingJudge('{"score": 0.9, "reasons": ["x"]}');
    const r = await runTriagePass(engine, [t], cfg(judge));
    expect(judge.calls).toBe(0);
    expect(r.judged).toBe(0);
    expect(r.backoff).toBe(1);
    expect(r.deferred).toBe(0);
    expect(r.reports[0].deferred).toBe(true);
    expect(r.reports[0].code).toBe('triage_unreliable_backoff');
    expect(r.reports[0].worth).toBe(false);
    expect(r.reports[0].reasons[0]).toContain('triage_unreliable_backoff');
  });

  test('after the backoff it re-judges, and a repeat failure doubles the backoff', async () => {
    const t = transcript('after');
    await runTriagePass(engine, [t], cfg(countingJudge(UNPARSEABLE)));
    await ageMarker(t, 25);
    const again = countingJudge(UNPARSEABLE);
    await runTriagePass(engine, [t], cfg(again));
    expect(again.calls).toBe(1);
    expect((await engine.getDreamVerdict(t.filePath, t.contentHash))!.reasons).toEqual(['unreliable:unparseable', 'attempt:2']);

    await ageMarker(t, 25);
    const third = countingJudge('{"score": 0.8, "reasons": ["x"]}');
    const held = await runTriagePass(engine, [t], cfg(third));
    expect(third.calls).toBe(0);
    expect(held.backoff).toBe(1);

    await ageMarker(t, 49);
    const r = await runTriagePass(engine, [t], cfg(third));
    expect(third.calls).toBe(1);
    expect(r.reports[0].score).toBe(0.8);
    expect((await engine.getDreamVerdict(t.filePath, t.contentHash))!.score).toBe(0.8);
  });

  test('the backoff doubles from 24h and is capped at 7 days', () => {
    expect(triageBackoffMs(1)).toBe(24 * 3_600_000);
    expect(triageBackoffMs(2)).toBe(48 * 3_600_000);
    expect(triageBackoffMs(4)).toBe(7 * 24 * 3_600_000);
    expect(triageBackoffMs(30)).toBe(7 * 24 * 3_600_000);
  });

  test('force bypasses the backoff', async () => {
    const t = transcript('force');
    await runTriagePass(engine, [t], cfg(countingJudge(UNPARSEABLE)));
    const judge = countingJudge('{"score": 0.7, "reasons": ["x"]}');
    const r = await runTriagePass(engine, [t], cfg(judge, { force: true }));
    expect(judge.calls).toBe(1);
    expect(r.backoff).toBe(0);
    expect(r.reports[0].score).toBe(0.7);
  });

  test('a model change or a content change re-judges at once', async () => {
    const t = transcript('model');
    await runTriagePass(engine, [t], cfg(countingJudge(UNPARSEABLE)));
    const other = countingJudge('{"score": 0.6, "reasons": ["x"]}');
    await runTriagePass(engine, [t], cfg(other, { model: 'openai:gpt-5.5' }));
    expect(other.calls).toBe(1);

    const u = transcript('content');
    await runTriagePass(engine, [u], cfg(countingJudge(UNPARSEABLE)));
    const edited = { ...u, content: u.content + ' edited', contentHash: createHash('sha256').update(u.content + ' edited').digest('hex') };
    const judge = countingJudge('{"score": 0.6, "reasons": ["x"]}');
    await runTriagePass(engine, [edited], cfg(judge));
    expect(judge.calls).toBe(1);
  });

  test('a failed re-judge under force keeps the existing valid verdict', async () => {
    const t = transcript('keep');
    await runTriagePass(engine, [t], cfg(countingJudge('{"score": 0.9, "reasons": ["x"]}')));
    await runTriagePass(engine, [t], cfg(countingJudge(UNPARSEABLE), { force: true }));
    const row = await engine.getDreamVerdict(t.filePath, t.contentHash);
    expect(row!.score).toBe(0.9);
    expect(isTriageCacheValid(row!, MODEL)).toBe(true);
  });

  test('the log line names stop reason, length and digest, never the response text', async () => {
    const t = transcript('log');
    const truncatedEcho = `{"score": 0.4, "reasons": ["quotes ${SECRET}"], "segments": [{"quote": "${SECRET}`;
    const { stderr } = await withStderr(() => runTriagePass(engine, [t], cfg(countingJudge(truncatedEcho, 'max_tokens'))));
    const digest = createHash('sha256').update(truncatedEcho).digest('hex').slice(0, 12);
    expect(stderr).toContain('was truncated');
    expect(stderr).toContain('stop_reason=max_tokens');
    expect(stderr).toContain(`response_chars=${truncatedEcho.length}`);
    expect(stderr).toContain(`sha256=${digest}`);
    expect(stderr).not.toContain(SECRET);

    const u = transcript('log2');
    const parsedTruncated = `{"score": 0.4, "reasons": ["echo ${SECRET}"]}`;
    const second = await withStderr(() => runTriagePass(engine, [u], cfg(countingJudge(parsedTruncated, 'max_tokens'))));
    expect(second.stderr).toContain('was truncated');
    expect(second.stderr).not.toContain(SECRET);
  });
});
