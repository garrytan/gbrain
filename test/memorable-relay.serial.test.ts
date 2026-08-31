/**
 * memorable-relay — the runHook-driven end-to-end matrix for the session-end
 * capture lanes (claude-code + codex), against a stub `memorable` binary.
 *
 * SERIAL: mutates process.env (GBRAIN_HOME / MEMORABLE_BIN / GBRAIN_MEMORABLE /
 * GBRAIN_MEMORABLE_CONFIG) around in-process runHook calls — isolation rule
 * R1 quarantine, same shape as hook-command.serial.test.ts.
 *
 * The relay child is spawned detached with stdio:'ignore', so the stub
 * reports through a MARKER FILE (claw-test-cli.test.ts's shim pattern), and
 * assertions poll it with a bounded deadline. The load-bearing cases:
 *   - default-off is a true no-op (no receipt, no spawn) on BOTH lanes;
 *   - the full opt-in chain spawns `record --session <id>` exactly once per
 *     distinct content hash (resume dedup);
 *   - the hook returns before the child finishes (fire-and-forget);
 *   - the codex lane confines to ITS root, parses rollouts, stamps
 *     harness:'codex', carries the stdin cwd as workspace_root, and falls
 *     back to bounded discovery when the payload has no transcript_path.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../src/commands/hook.ts';
import { readSessionReceiptsTail, writeMemorableConsent } from '../src/core/context/hook-heartbeat.ts';

const ENV_KEYS = ['GBRAIN_HOME', 'GBRAIN_MEMORABLE', 'GBRAIN_MEMORABLE_CONFIG', 'MEMORABLE_BIN', 'GBRAIN_HOOKS'] as const;

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-memrelay-'));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GBRAIN_HOME = tmp;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  rmSync(tmp, { recursive: true, force: true });
});

const home = () => join(tmp, '.gbrain');

function writeGate(enabled: boolean): void {
  mkdirSync(home(), { recursive: true });
  writeFileSync(join(home(), 'config.json'), JSON.stringify({ engine: 'pglite', integrations: { memorable: { enabled } } }));
}

/** Stub `memorable` that appends its argv to a marker file, slowly. */
function stubRelay(opts: { sleepSec?: number } = {}): { marker: string } {
  const marker = join(tmp, 'relay-marker.txt');
  const bin = join(tmp, 'memorable');
  const sleep = opts.sleepSec ? `sleep ${opts.sleepSec}\n` : '';
  writeFileSync(bin, `#!/bin/sh\n${sleep}echo "$@" >> ${marker}\n`);
  chmodSync(bin, 0o755);
  process.env.MEMORABLE_BIN = bin;
  return { marker };
}

function stubEvidence(): void {
  const dir = join(tmp, 'memorable-cli');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ backend: 'local', consent: 'read-write' }));
  process.env.GBRAIN_MEMORABLE_CONFIG = dir;
}

async function optInFully(): Promise<void> {
  writeGate(true);
  await writeMemorableConsent();
  stubEvidence();
}

async function pollMarker(marker: string, wantLines: number, deadlineMs = 4000): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (existsSync(marker)) {
      const body = readFileSync(marker, 'utf8');
      if (body.trim().split('\n').filter(Boolean).length >= wantLines) return body;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return existsSync(marker) ? readFileSync(marker, 'utf8') : '';
}

// ── Claude lane fixtures ─────────────────────────────────────────────────────

function claudeSetup(sessionId: string): { stdin: string; transcriptRoot: string } {
  const transcriptRoot = join(tmp, 'projects');
  mkdirSync(transcriptRoot, { recursive: true });
  const transcript = join(transcriptRoot, `${sessionId}.jsonl`);
  copyFileSync('test/fixtures/conversation-formats/claude-code.jsonl', transcript);
  return {
    transcriptRoot,
    stdin: JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: join(tmp, 'ws') }),
  };
}

const sink = () => ({ write: () => {} });

describe('claude-code lane (session-end hook)', () => {
  test('default-off: session-end runs normally with ZERO receipts and ZERO spawns', async () => {
    const { marker } = stubRelay();
    const { stdin, transcriptRoot } = claudeSetup('sess-off');
    const code = await runHook(['session-end'], { stdin, write: sink().write, transcriptRoot, spawnPush: () => {} });
    expect(code).toBe(0);
    expect(await readSessionReceiptsTail(10)).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  test('kill switch beats a fully-opted-in chain', async () => {
    await optInFully();
    const { marker } = stubRelay();
    process.env.GBRAIN_MEMORABLE = 'off';
    const { stdin, transcriptRoot } = claudeSetup('sess-kill');
    await runHook(['session-end'], { stdin, write: sink().write, transcriptRoot, spawnPush: () => {} });
    expect(await readSessionReceiptsTail(10)).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  test('opted in: receipt written, relay spawned with record --session <id>, resume dedup spawns once', async () => {
    await optInFully();
    const { marker } = stubRelay();
    const { stdin, transcriptRoot } = claudeSetup('sess-live');
    await runHook(['session-end'], { stdin, write: sink().write, transcriptRoot, spawnPush: () => {} });

    const receipts = await readSessionReceiptsTail(10);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.harness).toBe('claude-code');
    expect(receipts[0]!.session_id).toBe('sess-live');
    expect(receipts[0]!.workspace_root).toBe(join(tmp, 'ws'));
    expect(receipts[0]!.secret_scan_ok).toBe(true);

    const body = await pollMarker(marker, 1);
    expect(body).toContain('record --session sess-live');

    // Resume with IDENTICAL content: no new receipt, no second spawn.
    // Negative-spawn window: the first child's marker line is already durably
    // present (pollMarker above), so a buggy second spawn only needs its own
    // detached child to run `echo >> marker` — give that a full second under
    // loaded-runner jitter before asserting the count stayed at 1. The
    // receipt assertion is timing-free (dedup happens synchronously).
    await runHook(['session-end'], { stdin, write: sink().write, transcriptRoot, spawnPush: () => {} });
    expect(await readSessionReceiptsTail(10)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1000));
    expect(readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean)).toHaveLength(1);
  });

  test('the receipt carries real args post-redaction, the result outcome, and never the planted secret (#4743 pin)', async () => {
    await optInFully();
    stubRelay();
    const transcriptRoot = join(tmp, 'projects');
    mkdirSync(transcriptRoot, { recursive: true });
    const planted = 'sk-' + 'FAKEfakeFAKEfake1234567890';
    const transcript = join(transcriptRoot, 'sess-tools.jsonl');
    writeFileSync(transcript, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'deploy it' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: `deploy --key ${planted}` } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] },
      }),
    ].join('\n') + '\n');
    const stdin = JSON.stringify({ session_id: 'sess-tools', transcript_path: transcript, cwd: join(tmp, 'ws') });
    await runHook(['session-end'], { stdin, write: sink().write, transcriptRoot, spawnPush: () => {} });

    const [receipt] = await readSessionReceiptsTail(1);
    expect(receipt!.session_id).toBe('sess-tools');
    expect(receipt!.secret_scan_ok).toBe(true);
    const calls = JSON.parse(receipt!.tool_calls_json) as Array<{ name: string; input: { command: string }; result?: { ok: boolean } }>;
    expect(calls[0]!.name).toBe('Bash');
    // The real command, with the secret scrubbed by the SAME pass the corpus
    // goes through — not a second redaction implementation.
    expect(calls[0]!.input.command).toContain('deploy --key');
    expect(receipt!.tool_calls_json).not.toContain(planted);
    // The joined outcome survives serialization into the receipt.
    expect(calls[0]!.result).toEqual({ ok: true });
  });

  test('fire-and-forget: the hook returns while a slow child is still running', async () => {
    await optInFully();
    // 6s child vs a 4s wall-clock bound: the gap absorbs loaded-CI-runner
    // jitter (fs, module imports, mkdtemp on shared runners) while still
    // proving the hook did not wait the child out. The marker-absent check at
    // return is the mechanism proof; the elapsed bound is the backstop.
    const { marker } = stubRelay({ sleepSec: 6 });
    const { stdin, transcriptRoot } = claudeSetup('sess-slow');
    const t0 = Date.now();
    await runHook(['session-end'], { stdin, write: sink().write, transcriptRoot, spawnPush: () => {} });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(4000); // did not wait out the 6s child
    expect(existsSync(marker)).toBe(false); // child still sleeping at return
    expect((await pollMarker(marker, 1, 10_000)).length).toBeGreaterThan(0); // …but it does finish
  }, 20_000);

  test('enabled flag without the disclosure stamp (out-of-band write): no receipt, no spawn', async () => {
    writeGate(true); // the `memorable enable` b2() state — no stamp
    stubEvidence();
    const { marker } = stubRelay();
    const { stdin, transcriptRoot } = claudeSetup('sess-oob');
    await runHook(['session-end'], { stdin, write: sink().write, transcriptRoot, spawnPush: () => {} });
    expect(await readSessionReceiptsTail(10)).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });
});

// ── Codex lane fixtures ──────────────────────────────────────────────────────

const codexMeta = (sessionId: string) =>
  JSON.stringify({ timestamp: 't0', type: 'session_meta', payload: { id: 'r', session_id: sessionId, timestamp: 't0', cwd: '/repo' } });
const codexUser = (text: string) => JSON.stringify({ timestamp: 't1', type: 'event_msg', payload: { type: 'user_message', message: text } });
const codexAssistant = (text: string) =>
  JSON.stringify({ timestamp: 't2', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
const codexCall = JSON.stringify({ timestamp: 't3', type: 'response_item', payload: { type: 'custom_tool_call', id: 'ri-4', name: 'shell', input: '{"command":"bun test"}' } });

function codexStore(sessionId: string): { store: string; rollout: string } {
  const store = join(tmp, 'codex-sessions');
  const day = join(store, '2026', '08', '25');
  mkdirSync(day, { recursive: true });
  const rollout = join(day, `rollout-2026-08-25-${sessionId}.jsonl`);
  writeFileSync(rollout, [codexMeta(sessionId), codexUser('fix the tests'), codexCall, codexAssistant('done')].join('\n') + '\n');
  return { store, rollout };
}

describe('codex lane (session-end hook, --harness codex)', () => {
  test('rollout parsed, receipt stamped codex, workspace_root = stdin cwd, calls carry observed args', async () => {
    await optInFully();
    const { marker } = stubRelay();
    const { store, rollout } = codexStore('cdx-live');
    const stdin = JSON.stringify({ session_id: 'cdx-live', transcript_path: rollout, cwd: join(tmp, 'repo-a'), hook_event_name: 'SessionEnd', reason: 'other' });
    const code = await runHook(['session-end', '--harness', 'codex'], { stdin, write: sink().write, transcriptRoot: store, spawnPush: () => {} });
    expect(code).toBe(0);
    const receipts = await readSessionReceiptsTail(10);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.harness).toBe('codex');
    // Runtime source of truth is the payload cwd — never a baked env [OV2/E12].
    expect(receipts[0]!.workspace_root).toBe(join(tmp, 'repo-a'));
    expect(JSON.parse(receipts[0]!.tool_calls_json)).toEqual([{ name: 'shell', input: { command: 'bun test' } }]);
    expect((await pollMarker(marker, 1))).toContain('record --session cdx-live');
  });

  test('transcript_path:null falls back to bounded id-matched discovery (visible, not silent)', async () => {
    await optInFully();
    const { marker } = stubRelay();
    const { store } = codexStore('cdx-disc');
    const stdin = JSON.stringify({ session_id: 'cdx-disc', transcript_path: null, cwd: '/w', hook_event_name: 'SessionEnd', reason: 'other' });
    await runHook(['session-end', '--harness', 'codex'], { stdin, write: sink().write, transcriptRoot: store, spawnPush: () => {} });
    const receipts = await readSessionReceiptsTail(10);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.session_id).toBe('cdx-disc');
    expect((await pollMarker(marker, 1))).toContain('record --session cdx-disc');
  });

  test('a NEWEST-mtime discovery guess never feeds the relay (it can be a different, still-running session)', async () => {
    await optInFully();
    const { marker } = stubRelay();
    const { store } = codexStore('some-other-live-session');
    // Payload names a session with NO matching rollout filename AND no
    // transcript_path: discovery falls back to newest-mtime — a guess. The
    // local corpus is still written; the receipt + relay are skipped.
    const stdin = JSON.stringify({ session_id: 'cdx-ghost', transcript_path: null, cwd: '/w', hook_event_name: 'SessionEnd', reason: 'other' });
    await runHook(['session-end', '--harness', 'codex'], { stdin, write: sink().write, transcriptRoot: store, spawnPush: () => {} });
    expect(await readSessionReceiptsTail(10)).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 300)); // give a buggy spawn time to write
    expect(existsSync(marker)).toBe(false);
  });

  test('a rollout OUTSIDE the codex root is refused by confinement — no receipt', async () => {
    await optInFully();
    const { marker } = stubRelay();
    const { store } = codexStore('cdx-outside');
    const evil = join(tmp, 'evil.jsonl');
    writeFileSync(evil, [codexMeta('cdx-outside'), codexUser('x'), codexAssistant('y')].join('\n') + '\n');
    const stdin = JSON.stringify({ session_id: 'cdx-outside-2', transcript_path: evil, cwd: '/w' });
    await runHook(['session-end', '--harness', 'codex'], { stdin, write: sink().write, transcriptRoot: store, spawnPush: () => {} });
    expect(await readSessionReceiptsTail(10)).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  test('default-off on the codex lane too: rollout present, gate off, zero receipts/spawns', async () => {
    const { marker } = stubRelay();
    const { store, rollout } = codexStore('cdx-off');
    const stdin = JSON.stringify({ session_id: 'cdx-off', transcript_path: rollout, cwd: '/w' });
    await runHook(['session-end', '--harness', 'codex'], { stdin, write: sink().write, transcriptRoot: store, spawnPush: () => {} });
    expect(await readSessionReceiptsTail(10)).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });
});
