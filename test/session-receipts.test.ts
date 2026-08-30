/**
 * Tests for the additive session-receipts JSONL (session-receipts.ts).
 * Runs under a temp GBRAIN_HOME so nothing touches ~/.gbrain.
 */

import { describe, test, expect } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { statSync } from 'node:fs';
import {
  appendSessionReceipt,
  readSessionReceiptsTail,
  priorRelayFailure,
  relayResultsPath,
  resolveMemorableBin,
  sessionReceiptsPath,
} from '../src/core/context/hook-heartbeat.ts';

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-receipts-'));
}

describe('session-receipts', () => {
  test('append then read round-trips the full entry', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await appendSessionReceipt({
          session_id: 'sess-1',
          harness: 'claude-code',
          corpus_path: '/tmp/sess-1.txt',
          content_hash: 'abc123',
          turn_count: 4,
          workspace_root: '/repo',
          tool_calls_json: '[{"name":"bash","input":{"command":"pytest"}}]',
          secret_scan_ok: true,
        });
        const tail = await readSessionReceiptsTail(10);
        expect(tail.length).toBe(1);
        expect(tail[0].session_id).toBe('sess-1');
        expect(tail[0].harness).toBe('claude-code');
        expect(tail[0].content_hash).toBe('abc123');
        expect(tail[0].secret_scan_ok).toBe(true);
        expect(typeof tail[0].ts).toBe('string');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('multiple appends keep oldest → newest order, tail(n) takes the last n', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        for (const id of ['a', 'b', 'c']) {
          await appendSessionReceipt({
            session_id: id,
            harness: 'codex',
            corpus_path: `/tmp/${id}.txt`,
            content_hash: id,
            turn_count: 1,
            workspace_root: '/repo',
            tool_calls_json: '[{"name":"bash","input":{"command":"pytest"}}]',
            secret_scan_ok: true,
          });
        }
        const tail = await readSessionReceiptsTail(2);
        expect(tail.map((e) => e.session_id)).toEqual(['b', 'c']);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('secret_scan_ok:false is preserved (the scan_unavailable degrade signal)', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await appendSessionReceipt({
          session_id: 'sess-unscanned',
          harness: 'opencode',
          corpus_path: '/tmp/sess-unscanned.txt',
          content_hash: 'def456',
          turn_count: 2,
          workspace_root: '/repo',
          tool_calls_json: '[]',
          secret_scan_ok: false,
        });
        const tail = await readSessionReceiptsTail(1);
        expect(tail[0].secret_scan_ok).toBe(false);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('reading before any append returns an empty array, never throws', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        expect(await readSessionReceiptsTail(10)).toEqual([]);
        expect(await sessionReceiptsPath()).toContain('session-receipts.jsonl');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The relay must be able to tell "not installed" from "nothing to do" BEFORE
  // it spawns: spawn's ENOENT is async and lands after the heartbeat is written.
  test('resolveMemorableBin finds the CLI on PATH, and reports absence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-bin-'));
    try {
      await withEnv({ PATH: dir, MEMORABLE_BIN: undefined }, async () => {
        expect(resolveMemorableBin()).toBeNull();
        const bin = join(dir, 'memorable');
        writeFileSync(bin, '#!/bin/sh\nexit 0\n');
        chmodSync(bin, 0o755);
        expect(resolveMemorableBin()).toBe(bin);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('MEMORABLE_BIN wins when it exists and is refused when it does not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-bin-'));
    try {
      const explicit = join(dir, 'memorable-custom');
      writeFileSync(explicit, '#!/bin/sh\nexit 0\n');
      chmodSync(explicit, 0o755);
      await withEnv({ PATH: '', MEMORABLE_BIN: explicit }, async () => {
        expect(resolveMemorableBin()).toBe(explicit);
      });
      await withEnv({ PATH: '', MEMORABLE_BIN: join(dir, 'nope') }, async () => {
        expect(resolveMemorableBin()).toBeNull();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('receipt compaction is bounded by bytes, not only by lines', () => {
  /**
   * The line count was never the binding constraint. Real receipts carry
   * tool_calls_json and measure ~110 KB (max 353 KB), so a few thousand of
   * them are hundreds of megabytes across far fewer than 4000 lines — under
   * the old trigger, never compacted, and read whole into memory on every
   * session end.
   */
  test('a few huge receipts compact even though the line count is tiny', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const fat = 'x'.repeat(4 * 1024 * 1024); // 4 MB of tool calls per receipt
        for (let i = 0; i < 12; i++) {
          await appendSessionReceipt({
            session_id: `sess-${i}`,
            harness: 'claude-code',
            corpus_path: `/tmp/sess-${i}.txt`,
            content_hash: `hash-${i}`,
            turn_count: 1,
            workspace_root: '/repo',
            tool_calls_json: fat,
            secret_scan_ok: true,
          });
        }
        const p = await sessionReceiptsPath();
        const { size } = statSync(p);
        // 12 x 4 MB is 48 MB unbounded; the ceiling is 32 MB.
        expect(size).toBeLessThan(32 * 1024 * 1024);

        // Trimming keeps the NEWEST entries, and above all the one just
        // written — a compaction that dropped it would break the relay it
        // exists to feed.
        const tail = await readSessionReceiptsTail(50);
        expect(tail.length).toBeGreaterThan(0);
        expect(tail[tail.length - 1]!.session_id).toBe('sess-11');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('a resumed session does not re-record what it already recorded', () => {
  const base = {
    session_id: 'resumed-1',
    harness: 'claude-code' as const,
    corpus_path: '/tmp/resumed-1.txt',
    turn_count: 4,
    workspace_root: '/repo',
    tool_calls_json: '[{"name":"Bash","input":{"command":"bun test"}}]',
    secret_scan_ok: true,
  };

  /** session-end runs again on resume. The corpus file is session-id-keyed
   * and overwritten, so it dedupes by construction — the receipt did not, and
   * every append fired the relay again. A session resumed five times paid for
   * five extractions of one trace. */
  test('an identical re-emission writes nothing and reports it', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        expect(await appendSessionReceipt({ ...base, content_hash: 'hash-A' })).toBe(true);
        expect(await appendSessionReceipt({ ...base, content_hash: 'hash-A' })).toBe(false);
        expect(await appendSessionReceipt({ ...base, content_hash: 'hash-A' })).toBe(false);
        expect((await readSessionReceiptsTail(50)).length).toBe(1);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('genuinely appended work has a new hash, and is still recorded and relayed', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        expect(await appendSessionReceipt({ ...base, content_hash: 'hash-A' })).toBe(true);
        expect(await appendSessionReceipt({ ...base, content_hash: 'hash-B' })).toBe(true);
        const tail = await readSessionReceiptsTail(50);
        expect(tail.map((e) => e.content_hash)).toEqual(['hash-A', 'hash-B']);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('deduplication is per session, so a different session is never suppressed', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        expect(await appendSessionReceipt({ ...base, content_hash: 'hash-A' })).toBe(true);
        expect(await appendSessionReceipt({ ...base, session_id: 'other', content_hash: 'hash-A' })).toBe(true);
        // and the first session can still be re-checked correctly afterwards
        expect(await appendSessionReceipt({ ...base, content_hash: 'hash-A' })).toBe(false);
        expect((await readSessionReceiptsTail(50)).length).toBe(2);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('resolveMemorableBin rejects what it cannot actually run', () => {
  /** Cases E and F from the independent report. The function exists so an
   * enabled-but-broken relay is VISIBLE; a directory or a non-executable file
   * resolving "successfully" reproduced the exact silence it was added to
   * remove — the hook reported outcome: ok and nothing ever ran. */
  test('a directory named in MEMORABLE_BIN is not a binary', async () => {
    const home = tempHome();
    try {
      const dir = join(home, 'not-a-binary');
      mkdirSync(dir, { recursive: true });
      await withEnv({ MEMORABLE_BIN: dir }, async () => {
        expect(resolveMemorableBin()).toBe(null);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('a non-executable file named memorable on PATH is not a binary', async () => {
    const home = tempHome();
    try {
      const bin = join(home, 'memorable');
      writeFileSync(bin, '#!/bin/sh\necho hi\n');
      chmodSync(bin, 0o644);
      await withEnv({ PATH: home, MEMORABLE_BIN: '' }, async () => {
        expect(resolveMemorableBin()).toBe(null);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('an executable file IS resolved, so the check is not just refusing everything', async () => {
    const home = tempHome();
    try {
      const bin = join(home, 'memorable');
      writeFileSync(bin, '#!/bin/sh\necho hi\n');
      chmodSync(bin, 0o755);
      await withEnv({ PATH: home, MEMORABLE_BIN: '' }, async () => {
        expect(resolveMemorableBin()).toBe(bin);
      });
      await withEnv({ MEMORABLE_BIN: bin }, async () => {
        expect(resolveMemorableBin()).toBe(bin);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('a failed relay becomes visible instead of silent', () => {
  /** The relay is spawned detached with stdio ignored, so gbrain could only
   * ever verify the binary EXISTED. A `memorable record` that refused consent
   * or hit a dead API was indistinguishable from success, and `gbrain doctor`
   * could report a healthy relay while nothing had been recorded for weeks.
   * The child reports its own outcome; gbrain reads the PREVIOUS one, so
   * nothing is waited on and fire-and-forget is intact. */
  async function seed(home: string, lines: string[]): Promise<void> {
    const p = await relayResultsPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
  }
  const rec = (o: Record<string, unknown>) => JSON.stringify({ ts: 't', session_id: 's', ...o });

  test('silence when the relay has never reported, or last succeeded', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        expect(await priorRelayFailure()).toBe(null);
        await seed(home, [rec({ ok: true })]);
        expect(await priorRelayFailure()).toBe(null);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('a refusal surfaces as a heartbeat reason carrying its cause', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await seed(home, [rec({ ok: true }), rec({ ok: false, reason: 'consent' })]);
        expect(await priorRelayFailure()).toBe('memorable_relay_consent');
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('a failure with no cause still surfaces, and a torn line never hides one', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await seed(home, [rec({ ok: false }), '{"torn']);
        expect(await priorRelayFailure()).toBe('memorable_relay_failed');
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('a later success clears it, so the signal tracks the last run', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await seed(home, [rec({ ok: false, reason: 'consent' }), rec({ ok: true })]);
        expect(await priorRelayFailure()).toBe(null);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
