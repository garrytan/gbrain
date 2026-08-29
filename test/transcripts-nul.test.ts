/**
 * gbrain#4392 — an escaped \u0000 in transcript content must never abort the
 * whole ingest run. Agent transcripts capture raw tool output (grep on a
 * binary, truncated buffers), so NUL is legitimate input; Postgres text/jsonb
 * simply cannot store U+0000 and rejects the write with
 * 'invalid byte sequence for encoding "UTF8": 0x00'. Two guarantees pinned:
 *   1. the redact/render boundary strips U+0000 from every persisted string,
 *      so a NUL-bearing session imports (with the NUL gone) instead of dying
 *      at the database boundary;
 *   2. an encoding-shaped import error that still reaches the write is a
 *      per-SESSION error (counted, run continues) — never a run abort that
 *      starves every file queued behind the bad one.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { buildTranscriptSlug } from '../src/core/transcripts/types.ts';

const NUL = String.fromCharCode(0);

let engine: PGLiteEngine;
let tmp: string;

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
  tmp = mkdtempSync(join(tmpdir(), 'gb-nul-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const NO_PATTERNS = { userPatternsPath: '/nonexistent-patterns.txt' };

/** Minimal codex-rollout JSONL: session_meta + one user turn + one reply. */
function writeCodexSession(
  name: string,
  sessionId: string,
  startIso: string,
  userText: string,
  cwd = '/tmp',
): string {
  const lines = [
    JSON.stringify({
      timestamp: startIso,
      type: 'session_meta',
      payload: { id: name, session_id: sessionId, timestamp: startIso, cwd },
    }),
    JSON.stringify({
      timestamp: startIso,
      type: 'event_msg',
      payload: { type: 'user_message', message: userText },
    }),
    JSON.stringify({
      timestamp: startIso,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        id: 'ri-1',
        content: [{ type: 'output_text', text: 'acknowledged, noted the tool spew' }],
      },
    }),
  ];
  const p = join(tmp, `${name}.jsonl`);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('transcripts ingest with U+0000 in content (#4392)', () => {
  test('a NUL-bearing session imports with the NUL stripped and never aborts the run', async () => {
    const badStart = '2026-08-10T08:00:00.000Z';
    const cleanStart = '2026-08-11T09:00:00.000Z';
    // JSON.stringify renders the NUL as the escaped \u0000 — exactly the
    // 6-ASCII-char shape codex rollouts carry (raw 0x00 never hits the file).
    // NUL rides BOTH persisted surfaces: message content (pages/chunks text
    // columns) and session metadata (raw_data ::jsonb, which rejects the
    // NUL escape with 'unsupported Unicode escape sequence').
    const bad = writeCodexSession(
      'bad-rollout',
      'nul-session-1',
      badStart,
      `before${NUL}after grep binary spew`,
      `/tmp/work${NUL}dir`,
    );
    const clean = writeCodexSession('clean-rollout', 'clean-session-1', cleanStart, 'a perfectly normal question');

    // Red at base: throws 'transcripts-ingest run abort: putRawData failed
    // for conversations/sessions/…: unsupported Unicode escape sequence'.
    const r = await runTranscriptsIngest(engine, {
      paths: [bad, clean],
      format: 'codex',
      sourceId: 'default',
      ...NO_PATTERNS,
    });

    expect(r.sessionsImported).toBe(2);
    expect(r.sessionsErrored).toBe(0);
    expect(r.erroredFiles).toBe(0);

    const badSlug = buildTranscriptSlug('codex', badStart, { sessionId: 'nul-session-1' });
    const badPage = await engine.getPage(badSlug, { sourceId: 'default' });
    expect(badPage).not.toBeNull();
    expect(badPage!.compiled_truth).toContain('beforeafter grep binary spew');
    expect(badPage!.compiled_truth.includes(NUL)).toBe(false);

    const rawRows = await engine.getRawData(badSlug, 'transcript:codex', { sourceId: 'default' });
    expect(rawRows.length).toBe(1);
    expect((rawRows[0].data as { cwd?: string }).cwd).toBe('/tmp/workdir');

    const cleanSlug = buildTranscriptSlug('codex', cleanStart, { sessionId: 'clean-session-1' });
    expect(await engine.getPage(cleanSlug, { sourceId: 'default' })).not.toBeNull();
  });

  test('an encoding-shaped write error is a per-session error, not a run abort', async () => {
    const poison = writeCodexSession('poison-rollout', 'poison-session-1', '2026-08-10T08:00:00.000Z', 'first queued session');
    const healthy = writeCodexSession('healthy-rollout', 'healthy-session-1', '2026-08-11T09:00:00.000Z', 'second queued session');

    // Simulate a NUL that slips past the strip on some other persisted
    // surface: the FIRST page-write transaction (the poison session, files
    // run in order) throws the exact Postgres encoding error; everything
    // else delegates to the real engine.
    let failedOnce = false;
    const failingEngine = new Proxy(engine, {
      get(t, k) {
        if (k === 'transaction' && !failedOnce) {
          return () => {
            failedOnce = true;
            throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
          };
        }
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === 'function' && k !== 'constructor'
          ? (v as (...a: unknown[]) => unknown).bind(t)
          : v;
      },
    });

    // Red at base: the error escalates to RUN_ABORT_MARKER and this throws.
    const r = await runTranscriptsIngest(failingEngine, {
      paths: [poison, healthy],
      format: 'codex',
      sourceId: 'default',
      ...NO_PATTERNS,
    });

    expect(r.sessionsErrored).toBe(1);
    expect(r.files[0].sessions[0].error).toContain('invalid byte sequence');
    expect(r.cleanScan).toBe(false);
    // The queue continued: the healthy session behind the poison one landed.
    expect(r.sessionsImported).toBe(1);
    const healthySlug = buildTranscriptSlug('codex', '2026-08-11T09:00:00.000Z', {
      sessionId: 'healthy-session-1',
    });
    expect(await engine.getPage(healthySlug, { sourceId: 'default' })).not.toBeNull();
  });
});
