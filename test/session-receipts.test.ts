/**
 * Tests for the additive session-receipts JSONL (session-receipts.ts).
 * Runs under a temp GBRAIN_HOME so nothing touches ~/.gbrain.
 */

import { describe, test, expect } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { statSync } from 'node:fs';
import {
  appendSessionReceipt,
  clampRelayCause,
  clearMemorableConsent,
  maybeTrimRelayResults,
  memorableConsentEvidence,
  memorableGateAllowed,
  recordAndRelayReceipt,
  readSessionReceiptsTail,
  redactedToolCallsJson,
  priorRelayFailure,
  relayResultsPath,
  resolveMemorableBin,
  sessionReceiptsPath,
  writeMemorableConsent,
} from '../src/core/context/hook-heartbeat.ts';

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-receipts-'));
}

describe('session-receipts', () => {
  test('append then read round-trips the full entry', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        // The exact path the doctor check and the relay both hardcode — a
        // silent move breaks every consumer at once. (#4743 pin)
        expect(await sessionReceiptsPath()).toBe(
          join(home, '.gbrain', 'integrations', 'hooks', 'session-receipts.jsonl'),
        );
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
        expect(Number.isNaN(Date.parse(tail[0].ts))).toBe(false);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the file is 0600 inside a 0700 directory, the heartbeat contract (#4743 pin)', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await appendSessionReceipt({
          session_id: 'sess-mode',
          harness: 'claude-code',
          corpus_path: '/tmp/sess-mode.txt',
          content_hash: 'mode1',
          turn_count: 1,
          workspace_root: '/repo',
          tool_calls_json: '[]',
          secret_scan_ok: true,
        });
        const p = await sessionReceiptsPath();
        expect(statSync(p).mode & 0o777).toBe(0o600);
        expect(statSync(join(home, '.gbrain', 'integrations', 'hooks')).mode & 0o777).toBe(0o700);
        expect(statSync(join(home, '.gbrain', 'integrations')).mode & 0o777).toBe(0o700);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a receipt-write failure never throws into the hook it describes, and reports false (#4743 pin)', async () => {
    // GBRAIN_HOME pointed at a path that cannot become a directory.
    const home = tempHome();
    const notADir = join(home, 'file');
    writeFileSync(notADir, 'x');
    try {
      await withEnv({ GBRAIN_HOME: notADir }, async () => {
        const wrote = await appendSessionReceipt({
          session_id: 'sess-broken',
          harness: 'claude-code',
          corpus_path: '/tmp/sess-broken.txt',
          content_hash: 'broken1',
          turn_count: 1,
          workspace_root: '/repo',
          tool_calls_json: '[]',
          secret_scan_ok: true,
        });
        expect(wrote).toBe(false);
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

        // Headroom pin (#4743): the trim leaves the file at TARGET (half the
        // ceiling), so at steady state a whole-file rewrite is rare, never
        // once per append. A tmp+rename rewrite changes the inode — and the
        // rename window is the one place a concurrent O_APPEND line can be
        // dropped. Were target == ceiling, EVERY append here would rewrite.
        let rewrites = 0;
        let ino = statSync(p).ino;
        for (let i = 0; i < 4; i++) {
          await appendSessionReceipt({
            session_id: `sess-after-trim-${i}`,
            harness: 'claude-code',
            corpus_path: `/tmp/sess-after-trim-${i}.txt`,
            content_hash: `after-trim-${i}`,
            turn_count: 1,
            workspace_root: '/repo',
            tool_calls_json: fat,
            secret_scan_ok: true,
          });
          const now = statSync(p).ino;
          if (now !== ino) { rewrites++; ino = now; }
        }
        expect(rewrites).toBeLessThan(4);
        expect(statSync(p).size).toBeLessThan(32 * 1024 * 1024 + 5 * 1024 * 1024);
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

// ── A-1 refactor seams: the shared gate + relay helper ──────────────────────

describe('memorableGateAllowed — one gate vocabulary for hook, engine, doctor', () => {
  const on = { integrations: { memorable: { enabled: true } } };

  test('kill switch beats config AND stamp, in all spellings; env can never enable', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await writeMemorableConsent();
        for (const v of ['0', 'false', 'off', 'no', 'FALSE', 'Off', 'n', 'disable', 'disabled', 'none', '0 ', ' off ']) {
          await withEnv({ GBRAIN_MEMORABLE: v }, async () => {
            expect(await memorableGateAllowed(on)).toEqual({ allowed: false, reason: 'kill_switch' });
          });
        }
        // A truthy env value does NOT bypass a disabled config — env only disables.
        await withEnv({ GBRAIN_MEMORABLE: '1' }, async () => {
          expect(await memorableGateAllowed({})).toEqual({ allowed: false, reason: 'disabled' });
          expect(await memorableGateAllowed(on)).toEqual({ allowed: true });
        });
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('anything but literal true is disabled — absent, null, string, false', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_MEMORABLE: undefined }, async () => {
        expect((await memorableGateAllowed(undefined)).reason).toBe('disabled');
        expect((await memorableGateAllowed(null)).reason).toBe('disabled');
        expect((await memorableGateAllowed({})).reason).toBe('disabled');
        expect((await memorableGateAllowed({ integrations: { memorable: { enabled: false } } })).reason).toBe('disabled');
        // isConfigTruthy accepts "true"/"on"/"yes"/1 for OTHER keys; this gate
        // deliberately does not, so a hand-edited config can only fail closed.
        for (const v of ['true', 'on', 'yes', 1, 0, null, {}, []]) {
          const cfg = { integrations: { memorable: { enabled: v as unknown as boolean } } };
          expect((await memorableGateAllowed(cfg)).reason).toBe('disabled');
        }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('enabled WITHOUT the gbrain-authored stamp is off — the `memorable enable` out-of-band state', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_MEMORABLE: undefined }, async () => {
        expect(await memorableGateAllowed(on)).toEqual({ allowed: false, reason: 'disclosure_missing' });
        await writeMemorableConsent();
        expect(await memorableGateAllowed(on)).toEqual({ allowed: true });
        await clearMemorableConsent();
        expect(await memorableGateAllowed(on)).toEqual({ allowed: false, reason: 'disclosure_missing' });
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('scope-binding: a stale disclosure hash or a missing harness invalidates the stamp', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_MEMORABLE: undefined }, async () => {
        const p = await writeMemorableConsent();
        // Stale hash: the user consented to a DIFFERENT disclosure text.
        const stamp = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
        writeFileSync(p, JSON.stringify({ ...stamp, disclosure_sha256: 'deadbeef' }));
        expect((await memorableGateAllowed(on)).reason).toBe('disclosure_missing');
        // Missing harness: a new capture lane shipped after acceptance.
        writeFileSync(p, JSON.stringify({ ...stamp, harnesses: [] }));
        expect((await memorableGateAllowed(on)).reason).toBe('disclosure_missing');
        // Superset is fine — extra listed harnesses never invalidate.
        writeFileSync(p, JSON.stringify({ ...stamp, harnesses: [...(stamp.harnesses as string[]), 'future-harness'] }));
        expect(await memorableGateAllowed(on)).toEqual({ allowed: true });
        // Garbage stamp file reads as no consent, never a crash.
        writeFileSync(p, '{not json');
        expect((await memorableGateAllowed(on)).reason).toBe('disclosure_missing');
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('memorableConsentEvidence — the CLI-side opt-in, read fail-closed', () => {
  function seedCliConfig(dir: string, body: string | null): void {
    mkdirSync(dir, { recursive: true });
    if (body !== null) writeFileSync(join(dir, 'config.json'), body);
  }

  test('missing, unparseable, or unknown-backend config is not_initialized', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_MEMORABLE_CONFIG: join(home, 'nope') }, async () => {
        expect(memorableConsentEvidence()).toEqual({ ok: false, reason: 'memorable_not_initialized' });
      });
      seedCliConfig(join(home, 'm1'), '{broken');
      await withEnv({ GBRAIN_MEMORABLE_CONFIG: join(home, 'm1') }, async () => {
        expect(memorableConsentEvidence()).toEqual({ ok: false, reason: 'memorable_not_initialized' });
      });
      seedCliConfig(join(home, 'm2'), JSON.stringify({ backend: 'mystery' }));
      await withEnv({ GBRAIN_MEMORABLE_CONFIG: join(home, 'm2') }, async () => {
        expect(memorableConsentEvidence()).toEqual({ ok: false, reason: 'memorable_not_initialized' });
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('local backend requires read-write; deny/read-only/unset are consent_off', async () => {
    const home = tempHome();
    try {
      for (const consent of ['deny', 'read-only', undefined]) {
        seedCliConfig(join(home, 'mc'), JSON.stringify({ backend: 'local', ...(consent ? { consent } : {}) }));
        await withEnv({ GBRAIN_MEMORABLE_CONFIG: join(home, 'mc') }, async () => {
          expect(memorableConsentEvidence()).toEqual({ ok: false, reason: 'memorable_consent_off' });
        });
      }
      seedCliConfig(join(home, 'mc'), JSON.stringify({ backend: 'local', consent: 'read-write' }));
      await withEnv({ GBRAIN_MEMORABLE_CONFIG: join(home, 'mc') }, async () => {
        expect(memorableConsentEvidence()).toEqual({ ok: true });
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('gbrain backend is ok — the gbrain-authored stamp is the evidence there', async () => {
    const home = tempHome();
    try {
      seedCliConfig(join(home, 'mg'), JSON.stringify({ backend: 'gbrain' }));
      await withEnv({ GBRAIN_MEMORABLE_CONFIG: join(home, 'mg') }, async () => {
        expect(memorableConsentEvidence()).toEqual({ ok: true });
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('recordAndRelayReceipt — shared receipt + fire-and-forget relay', () => {
  const entry = (over: Partial<Parameters<typeof appendSessionReceipt>[0]> = {}) => ({
    session_id: 'relay-sess',
    harness: 'claude-code' as const,
    corpus_path: '/tmp/relay-sess.txt',
    content_hash: 'hash-1',
    turn_count: 2,
    workspace_root: '/repo',
    tool_calls_json: '[]',
    secret_scan_ok: true,
    ...over,
  });
  /** A fake spawn that records argv and returns an inert child. */
  function fakeSpawn() {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const fn = ((bin: string, args: string[]) => {
      calls.push({ bin, args });
      return { on: () => {}, unref: () => {} };
    }) as unknown as typeof import('node:child_process').spawn;
    return { calls, fn };
  }
  /** An executable stub so resolveMemorableBin succeeds. */
  function stubBin(home: string): string {
    const dir = join(home, 'bin');
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, 'memorable');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);
    return dir;
  }
  /** CLI-side consent evidence (local backend, opted in) via the test seam. */
  function evidenceDir(home: string, body = JSON.stringify({ backend: 'local', consent: 'read-write' })): string {
    const dir = join(home, 'memorable-cli');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), body);
    return dir;
  }

  test('records, surfaces the prior failure, and spawns record --session <id>', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home, PATH: stubBin(home), MEMORABLE_BIN: '', GBRAIN_MEMORABLE_CONFIG: evidenceDir(home) }, async () => {
        const relayFile = join(home, '.gbrain', 'integrations', 'hooks', 'memorable-relay.jsonl');
        mkdirSync(dirname(relayFile), { recursive: true });
        writeFileSync(relayFile, JSON.stringify({ ts: 'x', session_id: 'old', ok: false, reason: 'consent' }) + '\n');
        const { calls, fn } = fakeSpawn();
        const res = await recordAndRelayReceipt(entry(), { spawnFn: fn });
        expect(res.recorded).toBe(true);
        expect(res.degradeReasons).toContain('memorable_relay_consent');
        expect(calls.length).toBe(1);
        expect(calls[0]!.args).toEqual(['record', '--session', 'relay-sess']);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('an identical re-emission is deduplicated and never spawns twice', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home, PATH: stubBin(home), MEMORABLE_BIN: '', GBRAIN_MEMORABLE_CONFIG: evidenceDir(home) }, async () => {
        const { calls, fn } = fakeSpawn();
        expect((await recordAndRelayReceipt(entry(), { spawnFn: fn })).recorded).toBe(true);
        const second = await recordAndRelayReceipt(entry(), { spawnFn: fn });
        expect(second.recorded).toBe(false);
        expect(calls.length).toBe(1);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('missing binary records the receipt but degrades memorable_cli_missing, no spawn', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home, PATH: home, MEMORABLE_BIN: '', GBRAIN_MEMORABLE_CONFIG: evidenceDir(home) }, async () => {
        const { calls, fn } = fakeSpawn();
        const res = await recordAndRelayReceipt(entry({ content_hash: 'hash-2' }), { spawnFn: fn });
        expect(res.recorded).toBe(true);
        expect(res.degradeReasons).toContain('memorable_cli_missing');
        expect(calls.length).toBe(0);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('a spawn that throws synchronously never throws out of the helper', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home, PATH: stubBin(home), MEMORABLE_BIN: '', GBRAIN_MEMORABLE_CONFIG: evidenceDir(home) }, async () => {
        const boom = (() => { throw new Error('EPERM'); }) as unknown as typeof import('node:child_process').spawn;
        const res = await recordAndRelayReceipt(entry({ content_hash: 'hash-3' }), { spawnFn: boom });
        expect(res.recorded).toBe(true);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('consent-before-egress: no CLI-side evidence, no spawn (receipt still local)', () => {
  const entry2 = {
    session_id: 'evidence-sess',
    harness: 'claude-code' as const,
    corpus_path: '/tmp/evidence-sess.txt',
    content_hash: 'ev-1',
    turn_count: 1,
    workspace_root: '/repo',
    tool_calls_json: '[]',
    secret_scan_ok: true,
  };
  function spy() {
    const calls: unknown[] = [];
    const fn = ((...a: unknown[]) => { calls.push(a); return { on: () => {}, unref: () => {} }; }) as unknown as typeof import('node:child_process').spawn;
    return { calls, fn };
  }

  test('not initialized: receipt written, spawn skipped, reason surfaced', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_MEMORABLE_CONFIG: join(home, 'absent') }, async () => {
        const { calls, fn } = spy();
        const res = await recordAndRelayReceipt(entry2, { spawnFn: fn });
        expect(res.recorded).toBe(true);
        expect(res.degradeReasons).toContain('memorable_not_initialized');
        expect(calls.length).toBe(0);
        expect((await readSessionReceiptsTail(5)).some((e) => e.session_id === 'evidence-sess')).toBe(true);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('local backend with consent off: spawn skipped with memorable_consent_off', async () => {
    const home = tempHome();
    try {
      const dir = join(home, 'mcli');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ backend: 'local', consent: 'deny' }));
      await withEnv({ GBRAIN_HOME: home, GBRAIN_MEMORABLE_CONFIG: dir }, async () => {
        const { calls, fn } = spy();
        const res = await recordAndRelayReceipt({ ...entry2, content_hash: 'ev-2' }, { spawnFn: fn });
        expect(res.recorded).toBe(true);
        expect(res.degradeReasons).toContain('memorable_consent_off');
        expect(calls.length).toBe(0);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('memorable-relay.jsonl is bounded: tail reads + hook-lane trim', () => {
  const line = (i: number, ok = true) => JSON.stringify({ ts: `t${i}`, session_id: `s${i}`, ok, pad: 'x'.repeat(200) });

  test('lastRelayResult stays correct when the file exceeds the 1MB tail window', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const p = await relayResultsPath();
        mkdirSync(dirname(p), { recursive: true });
        const rows: string[] = [];
        for (let i = 0; i < 10_000; i++) rows.push(line(i, true));
        rows.push(JSON.stringify({ ts: 'last', session_id: 'newest', ok: false, reason: 'consent' }));
        writeFileSync(p, rows.join('\n') + '\n');
        expect(statSync(p).size > 1024 * 1024).toBe(true);
        expect(await priorRelayFailure()).toBe('memorable_relay_consent');
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('no trim while small or freshly-written under the force ceiling', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const p = await relayResultsPath();
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, line(1) + '\n');
        await maybeTrimRelayResults();
        expect(readFileSync(p, 'utf8')).toBe(line(1) + '\n');
        // >1MB but mtime fresh and under 8MB: left alone (a child may be mid-run).
        const rows: string[] = [];
        for (let i = 0; i < 8_000; i++) rows.push(line(i));
        writeFileSync(p, rows.join('\n') + '\n');
        const before = statSync(p).size;
        await maybeTrimRelayResults();
        expect(statSync(p).size).toBe(before);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('mtime-stale file above the threshold trims to the newest complete lines', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const p = await relayResultsPath();
        mkdirSync(dirname(p), { recursive: true });
        const rows: string[] = [];
        for (let i = 0; i < 8_000; i++) rows.push(line(i));
        writeFileSync(p, rows.join('\n') + '\n');
        const old = new Date(Date.now() - 10 * 60_000);
        utimesSync(p, old, old);
        await maybeTrimRelayResults();
        const after = readFileSync(p, 'utf8');
        expect(statSync(p).size).toBeLessThan(600 * 1024);
        const lines = after.trimEnd().split('\n');
        // Newest line survives intact; every kept line parses (line-boundary cut).
        expect(lines[lines.length - 1]).toBe(line(7_999));
        for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('force-trim fires at the hard ceiling even with a fresh mtime', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const p = await relayResultsPath();
        mkdirSync(dirname(p), { recursive: true });
        const fat = (i: number) => JSON.stringify({ ts: `t${i}`, session_id: `s${i}`, ok: true, pad: 'y'.repeat(4000) });
        const rows: string[] = [];
        for (let i = 0; i < 2_300; i++) rows.push(fat(i)); // ~9MB, mtime = now
        writeFileSync(p, rows.join('\n') + '\n');
        await maybeTrimRelayResults();
        expect(statSync(p).size).toBeLessThan(600 * 1024);
        expect(readFileSync(p, 'utf8').trimEnd().split('\n').pop()).toBe(fat(2_299));
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('degrade ordering: a stale prior-run relay failure never masks current reasons', () => {
  test('priorRelayFailure is appended LAST in degradeReasons, and its cause is clamped', async () => {
    const home = tempHome();
    try {
      // Evidence off + a seeded stale failure: current reason must come first.
      await withEnv({ GBRAIN_HOME: home, GBRAIN_MEMORABLE_CONFIG: join(home, 'absent') }, async () => {
        const p = await relayResultsPath();
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify({ ts: 't', session_id: 'old', ok: false, reason: '<script>very$bad reason that is far beyond the clamp length limit</script>' }) + '\n');
        const res = await recordAndRelayReceipt({
          session_id: 'order-sess',
          harness: 'claude-code',
          corpus_path: '/tmp/order.txt',
          content_hash: 'order-1',
          turn_count: 1,
          workspace_root: '/repo',
          tool_calls_json: '[]',
          secret_scan_ok: true,
        });
        expect(res.degradeReasons[0]).toBe('memorable_not_initialized');
        expect(res.degradeReasons[1]).toBe('memorable_relay_failed'); // clamped, and last
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('redactedToolCallsJson — the one artifact that leaves the machine', () => {
  test('a quoted secret inside a Bash command redacts (JSON escaping must not defeat the scanner)', async () => {
    // Red-team verified regression: scanning the SERIALIZED JSON let
    // `export DB_PASSWORD="…"` ship verbatim, because JSON escapes the inner
    // quotes (\") and the backslash breaks the pattern. Leaves are redacted
    // raw, before serialization.
    const out = await redactedToolCallsJson(
      [{ name: 'Bash', input: { command: 'export DB_PASSWORD="K9fjq2LmX0pQ7rTz" && ./run.sh' } }],
      [0],
      0,
    );
    expect(out).not.toContain('K9fjq2LmX0pQ7rTz');
    expect(out).toContain('REDACTED');
    expect(out).toContain('./run.sh'); // surrounding command survives
  });

  test('unquoted assignments and nested structures redact too; span filter still applies', async () => {
    const out = await redactedToolCallsJson(
      [
        { name: 'Bash', input: { command: 'echo SMTP_PASSWORD=Ab3xK9mQ2pR7sT1vW4yZ8bC5dE6f' } },
        { name: 'Edit', input: { nested: { list: ['api_key: Ab3xK9mQ2pR7sT1vW4yZ8bC5dE6f'] } } },
        { name: 'Read', input: { file_path: '/pre-span/should-not-appear' } },
      ],
      [5, 6, 2],
      4, // span starts at turn 4 — the Read call (turn 2) is filtered out
    );
    expect(out).not.toContain('Ab3xK9mQ2pR7sT1vW4yZ8bC5dE6f');
    expect((out.match(/REDACTED/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(out).not.toContain('/pre-span/should-not-appear');
  });
});

describe('per-receipt harness scope-binding (consent never stretches over an undisclosed lane)', () => {
  test('an opencode-stamped receipt is refused before the relay: no receipt, typed degrade', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const res = await recordAndRelayReceipt({
          session_id: 'oc-sess',
          harness: 'opencode',
          corpus_path: '/tmp/oc.txt',
          content_hash: 'oc-1',
          turn_count: 1,
          workspace_root: '/repo',
          tool_calls_json: '[]',
          secret_scan_ok: true,
        });
        expect(res.recorded).toBe(false);
        expect(res.degradeReasons).toEqual(['memorable_harness_undisclosed']);
        expect(await readSessionReceiptsTail(5)).toHaveLength(0);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('clampRelayCause — the composite heartbeat reason stays inside 48 chars', () => {
  test('32-char cause kept; 33-char cause clamps to failed (prefix is 16 chars)', () => {
    const c32 = 'a'.repeat(32);
    expect(clampRelayCause(c32)).toBe(c32);
    expect(`memorable_relay_${clampRelayCause(c32)}`.length).toBe(48);
    expect(clampRelayCause('a'.repeat(33))).toBe('failed');
    expect(clampRelayCause('<script>bad')).toBe('failed');
    expect(clampRelayCause(undefined)).toBe('failed');
  });
});
