/**
 * An adapter reports a file's diagnostics (truncated read, drift, skipped
 * lines) only when its generator RETURNS, after every session was yielded.
 * Ingest must hold the file's sessions until that verdict: a truncated or
 * drifting file is refused before ANY engine write, instead of importing its
 * sessions and only then freezing the watermark.
 *
 * The engine here is a trap: any property access is recorded, so "no engine
 * write" is asserted as "the engine was never touched".
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import type { FileDiagnostics, ParsedSession, TranscriptAdapter } from '../src/core/transcripts/types.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TS = '2026-01-02T03:04:05.000Z';
const touched: string[] = [];
const trapEngine = new Proxy({}, {
  get(_t, key) {
    if (key === 'then' || typeof key === 'symbol') return undefined;
    touched.push(String(key));
    throw new Error(`engine touched: ${String(key)}`);
  },
});

function session(id: string): ParsedSession {
  return {
    meta: { harness: 'codex', sessionId: id, startedAt: TS, raw: { synthetic: true } },
    messages: [
      { role: 'user', timestamp: TS, text: `synthetic question ${id}` },
      { role: 'assistant', timestamp: TS, text: `synthetic answer ${id}` },
    ],
  };
}

function diag(extra: Partial<FileDiagnostics> = {}): FileDiagnostics {
  return { bytesRead: 100, skippedLines: 0, truncated: false, sessions: 2, ...extra };
}

function adapter(parse: () => AsyncGenerator<ParsedSession, FileDiagnostics>): TranscriptAdapter {
  return { format: 'codex', specTarget: 'codex' as never, detect: () => true, parse };
}

const scratch: string[] = [];
afterEach(() => {
  touched.length = 0;
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function run(a: TranscriptAdapter, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gb-admit-'));
  scratch.push(dir);
  const f = join(dir, 'rollout.jsonl');
  writeFileSync(f, '{"x":1}\n');
  return runTranscriptsIngest(trapEngine as never, { paths: [f], sourceId: 'default', adapters: [a], ...extra });
}

describe('terminal diagnostics are admitted before any write', () => {
  for (const [label, d] of [
    ['truncated read', diag({ truncated: true })],
    ['assistant-only drift', diag({ userTurnsMissing: true })],
  ] as const) {
    test(`${label} after two yielded sessions → file refused, engine untouched`, async () => {
      const r = await run(adapter(async function* () { yield session('a'); yield session('b'); return d; }));
      expect(touched).toEqual([]);
      expect(r.files[0].error).toMatch(/refused/);
      expect(r.sessionsImported).toBe(0);
      expect(r.erroredFiles).toBe(1);
      expect(r.cleanScan).toBe(false);
    });
  }

  test('truncation keeps its per-file outcome and count when refused', async () => {
    const r = await run(adapter(async function* () { yield session('a'); return diag({ truncated: true }); }));
    expect(r.files[0].truncated).toBe(true);
    expect(r.truncatedFiles).toBe(1);
  });

  test('missing terminal diagnostics fail closed', async () => {
    const r = await run(adapter(async function* () { yield session('a'); return undefined as never; }));
    expect(touched).toEqual([]);
    expect(r.files[0].error).toMatch(/missing terminal diagnostics/);
    expect(r.cleanScan).toBe(false);
  });

  test('a parse failure after a yield imports nothing and closes the producer', async () => {
    let closed = false;
    const r = await run(adapter(async function* () {
      try { yield session('a'); throw new Error('synthetic parse failure'); } finally { closed = true; }
    }));
    expect(touched).toEqual([]);
    expect(closed).toBe(true);
    expect(r.erroredFiles).toBe(1);
  });

  test('dry run plans nothing for a refused file', async () => {
    const r = await run(adapter(async function* () { yield session('a'); return diag({ truncated: true }); }), { dryRun: true });
    expect(r.pages.planned).toBe(0);
    expect(r.files[0].error).toMatch(/refused/);
  });

  test('a clean file reaches its verdict before its first session is processed', async () => {
    let finished = false;
    const seenAfterVerdict: boolean[] = [];
    const r = await run(
      adapter(async function* () { yield session('a'); yield session('b'); finished = true; return diag(); }),
      { dryRun: true, onSession: () => seenAfterVerdict.push(finished) },
    );
    expect(seenAfterVerdict).toEqual([true, true]);
    expect(r.pages.planned).toBe(2);
    expect(r.files[0].error).toBeUndefined();
  });

  test('a sub-agent rollout is not drift and is admitted', async () => {
    const r = await run(
      adapter(async function* () { yield session('a'); return diag({ sessions: 1, subagentRollout: true }); }),
      { dryRun: true },
    );
    expect(r.pages.planned).toBe(1);
    expect(r.driftFiles).toBe(0);
  });
});

describe('maxStagedBytes bounds the admission buffer', () => {
  test('over the cap → file refused, producer closed, engine untouched', async () => {
    let closed = false;
    const r = await run(
      adapter(async function* () { try { yield session('a'); yield session('b'); return diag(); } finally { closed = true; } }),
      { maxStagedBytes: 1 },
    );
    expect(touched).toEqual([]);
    expect(closed).toBe(true);
    expect(r.files[0].error).toMatch(/maxStagedBytes/);
    expect(r.cleanScan).toBe(false);
  });

  test('the cap counts serialized UTF-8 bytes, inclusively', async () => {
    const s = session('unicode');
    s.messages[0].text = '文'.repeat(20);
    const bytes = Buffer.byteLength(JSON.stringify(s), 'utf8');
    const a = adapter(async function* () { yield s; return diag({ sessions: 1 }); });
    expect((await run(a, { dryRun: true, maxStagedBytes: bytes - 1 })).files[0].error).toMatch(/maxStagedBytes/);
    expect((await run(a, { dryRun: true, maxStagedBytes: bytes })).pages.planned).toBe(1);
  });

  for (const cap of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`invalid cap ${cap} is rejected before any file is read`, async () => {
      let started = false;
      const a = adapter(async function* () { started = true; yield session('a'); return diag(); });
      await expect(run(a, { maxStagedBytes: cap })).rejects.toThrow(/maxStagedBytes/);
      expect(started).toBe(false);
      expect(touched).toEqual([]);
    });
  }
});
