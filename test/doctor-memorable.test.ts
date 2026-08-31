/**
 * memorable_relay_health — the doctor rung ladder, exercised end-to-end
 * against real files under a temp GBRAIN_HOME (the check is engine-free by
 * design; nothing here boots an engine).
 *
 * The two states this surface EXISTS to catch:
 *   - enabled-without-disclosure (the `memorable enable` out-of-band write)
 *     must be a FAIL naming the exact fix, and
 *   - receipts-but-no-relay-report (spawned, never worked) must be a warn —
 *     that silence used to read as healthy indefinitely.
 */
import { describe, test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { buildMemorableRelayCheck } from '../src/commands/doctor/checks/integrations-memorable.ts';
import {
  appendSessionReceipt,
  relayResultsPath,
  writeMemorableConsent,
} from '../src/core/context/hook-heartbeat.ts';

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'gb-doc-mem-'));
}

/** Write the file-plane config the check reads via loadConfig(). */
function seedGbrainConfig(parent: string, enabled: boolean | null): void {
  const dir = join(parent, '.gbrain');
  mkdirSync(dir, { recursive: true });
  const cfg: Record<string, unknown> = { engine: 'pglite' };
  if (enabled !== null) cfg.integrations = { memorable: { enabled } };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
}

function seedEvidence(parent: string, body: Record<string, unknown>): string {
  const dir = join(parent, 'memorable-cli');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(body));
  return dir;
}

function stubBinDir(parent: string): string {
  const dir = join(parent, 'bin');
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'memorable');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);
  return dir;
}

const RECEIPT = {
  session_id: 'doc-sess',
  harness: 'claude-code' as const,
  corpus_path: '/tmp/doc-sess.txt',
  content_hash: 'doc-hash',
  turn_count: 1,
  workspace_root: '/repo',
  tool_calls_json: '[]',
  secret_scan_ok: true,
};

describe('memorable_relay_health rung ladder', () => {
  test('gate off (default): quiet ok, out-of-band settable named in details', async () => {
    const home = tempHome();
    try {
      seedGbrainConfig(home, null);
      await withEnv({ GBRAIN_HOME: home, GBRAIN_MEMORABLE: undefined }, async () => {
        const c = await buildMemorableRelayCheck();
        expect(c.status).toBe('ok');
        expect(c.message).toContain('off');
        expect(c.details?.out_of_band_settable).toBe(true);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('kill switch: ok, named as the kill switch (not "default")', async () => {
    const home = tempHome();
    try {
      seedGbrainConfig(home, true);
      await withEnv({ GBRAIN_HOME: home, GBRAIN_MEMORABLE: '0' }, async () => {
        const c = await buildMemorableRelayCheck();
        expect(c.status).toBe('ok');
        expect(c.message).toContain('kill switch');
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('enabled without the disclosure stamp: FAIL with the exact fix command', async () => {
    const home = tempHome();
    try {
      seedGbrainConfig(home, true);
      await withEnv({ GBRAIN_HOME: home, GBRAIN_MEMORABLE: undefined }, async () => {
        const c = await buildMemorableRelayCheck();
        expect(c.status).toBe('fail');
        expect(c.message).toContain('gbrain config set integrations.memorable.enabled true');
        expect(c.details?.reason).toBe('disclosure_missing');
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('stamped but Memorable itself not opted in: warn naming the evidence reason', async () => {
    const home = tempHome();
    try {
      seedGbrainConfig(home, true);
      await withEnv({ GBRAIN_HOME: home, GBRAIN_MEMORABLE: undefined, GBRAIN_MEMORABLE_CONFIG: join(home, 'absent') }, async () => {
        await writeMemorableConsent();
        const c = await buildMemorableRelayCheck();
        expect(c.status).toBe('warn');
        expect(c.details?.reason).toBe('memorable_not_initialized');
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('stamped + consented but no runnable binary: FAIL memorable_cli_missing', async () => {
    const home = tempHome();
    try {
      seedGbrainConfig(home, true);
      const ev = seedEvidence(home, { backend: 'local', consent: 'read-write' });
      await withEnv({ GBRAIN_HOME: home, GBRAIN_MEMORABLE: undefined, GBRAIN_MEMORABLE_CONFIG: ev, PATH: home, MEMORABLE_BIN: '' }, async () => {
        await writeMemorableConsent();
        const c = await buildMemorableRelayCheck();
        expect(c.status).toBe('fail');
        expect(c.details?.reason).toBe('memorable_cli_missing');
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('receipts written but the child never reported: warn (the silent-failure shape)', async () => {
    const home = tempHome();
    try {
      seedGbrainConfig(home, true);
      const ev = seedEvidence(home, { backend: 'gbrain' });
      await withEnv({ GBRAIN_HOME: home, GBRAIN_MEMORABLE: undefined, GBRAIN_MEMORABLE_CONFIG: ev, PATH: stubBinDir(home), MEMORABLE_BIN: '' }, async () => {
        await writeMemorableConsent();
        await appendSessionReceipt(RECEIPT);
        const c = await buildMemorableRelayCheck();
        expect(c.status).toBe('warn');
        expect(c.details?.reason).toBe('relay_never_reported');
        expect(c.details?.receipts_recent).toBe(1);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('last relay run failed: warn naming the clamped cause; garbage cause clamps to failed', async () => {
    const home = tempHome();
    try {
      seedGbrainConfig(home, true);
      const ev = seedEvidence(home, { backend: 'local', consent: 'read-write' });
      await withEnv({ GBRAIN_HOME: home, GBRAIN_MEMORABLE: undefined, GBRAIN_MEMORABLE_CONFIG: ev, PATH: stubBinDir(home), MEMORABLE_BIN: '' }, async () => {
        await writeMemorableConsent();
        const p = await relayResultsPath();
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify({ ts: 't1', session_id: 's', ok: false, reason: 'consent' }) + '\n');
        let c = await buildMemorableRelayCheck();
        expect(c.status).toBe('warn');
        expect(c.message).toContain('(consent)');
        // Adversarial/buggy child text never lands in a doctor message verbatim.
        writeFileSync(p, JSON.stringify({ ts: 't2', session_id: 's', ok: false, reason: 'rm -rf / && echo pwned this is way too long to be a reason code' }) + '\n');
        c = await buildMemorableRelayCheck();
        expect(c.status).toBe('warn');
        expect(c.message).toContain('(failed)');
        expect(c.message).not.toContain('pwned');
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('no_decisive_steps is the DOCUMENTED openclaw rejection: visible but ok, never a standing warn', async () => {
    const home = tempHome();
    try {
      seedGbrainConfig(home, true);
      const ev = seedEvidence(home, { backend: 'local', consent: 'read-write' });
      await withEnv({ GBRAIN_HOME: home, GBRAIN_MEMORABLE: undefined, GBRAIN_MEMORABLE_CONFIG: ev, PATH: stubBinDir(home), MEMORABLE_BIN: '' }, async () => {
        await writeMemorableConsent();
        const p = await relayResultsPath();
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify({ ts: 't1', session_id: 's', ok: false, reason: 'no_decisive_steps' }) + '\n');
        const c = await buildMemorableRelayCheck();
        // A rung that is known-red for the whole openclaw cohort (name-only
        // capture) would train operators to ignore the ladder.
        expect(c.status).toBe('ok');
        expect(c.message).toContain('no_decisive_steps');
        expect(c.details?.reason).toBe('expected_openclaw_rejection');
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('all green: ok with the structured details doctor --json consumers read', async () => {
    const home = tempHome();
    try {
      seedGbrainConfig(home, true);
      const ev = seedEvidence(home, { backend: 'local', consent: 'read-write' });
      await withEnv({ GBRAIN_HOME: home, GBRAIN_MEMORABLE: undefined, GBRAIN_MEMORABLE_CONFIG: ev, PATH: stubBinDir(home), MEMORABLE_BIN: '' }, async () => {
        await writeMemorableConsent();
        await appendSessionReceipt(RECEIPT);
        const p = await relayResultsPath();
        writeFileSync(p, JSON.stringify({ ts: 't1', session_id: 'doc-sess', ok: true }) + '\n');
        const c = await buildMemorableRelayCheck();
        expect(c.status).toBe('ok');
        expect(c.details?.last_relay_ok).toBe(true);
        expect(c.details?.receipts_recent).toBe(1);
        expect(typeof c.details?.bin).toBe('string');
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('codex hooks wired but never fired [OV8c]', () => {
  test('wired + zero codex receipts → warn naming the silent trust-gate failure; a codex receipt clears it', async () => {
    const home = tempHome();
    try {
      seedGbrainConfig(home, true);
      const ev = seedEvidence(home, { backend: 'local', consent: 'read-write' });
      const codexHome = join(home, 'codex-home');
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify({
        hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'x gbrain hook session-end --harness codex y', timeout: 3 }] }] },
      }));
      await withEnv({ GBRAIN_HOME: home, GBRAIN_MEMORABLE: undefined, GBRAIN_MEMORABLE_CONFIG: ev, PATH: stubBinDir(home), MEMORABLE_BIN: '', CODEX_HOME: codexHome }, async () => {
        await writeMemorableConsent();
        // A claude receipt + a healthy relay report: everything green EXCEPT codex never fired.
        await appendSessionReceipt(RECEIPT);
        const p = await relayResultsPath();
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify({ ts: 't', session_id: 'doc-sess', ok: true }) + '\n');
        let c = await buildMemorableRelayCheck();
        expect(c.status).toBe('warn');
        expect(c.details?.reason).toBe('codex_hooks_never_fired');
        // One codex-harness receipt clears the rung.
        await appendSessionReceipt({ ...RECEIPT, session_id: 'cdx-1', harness: 'codex', content_hash: 'cdx-h' });
        c = await buildMemorableRelayCheck();
        expect(c.status).toBe('ok');
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('mixed host: the expected openclaw rejection never masks a dead codex trust entry', async () => {
    const home = tempHome();
    try {
      seedGbrainConfig(home, true);
      const ev = seedEvidence(home, { backend: 'local', consent: 'read-write' });
      const codexHome = join(home, 'codex-home');
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify({
        hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'x gbrain hook session-end --harness codex y', timeout: 3 }] }] },
      }));
      await withEnv({ GBRAIN_HOME: home, GBRAIN_MEMORABLE: undefined, GBRAIN_MEMORABLE_CONFIG: ev, PATH: stubBinDir(home), MEMORABLE_BIN: '', CODEX_HOME: codexHome }, async () => {
        await writeMemorableConsent();
        // Openclaw relays per compaction, each refused as no_decisive_steps —
        // the PERSISTENT last-relay state on an openclaw+codex host. Codex is
        // wired but has never produced a receipt (stale trust entry).
        await appendSessionReceipt({ ...RECEIPT, harness: 'openclaw' });
        const p = await relayResultsPath();
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify({ ts: 't', session_id: 'oc-1', ok: false, reason: 'no_decisive_steps' }) + '\n');
        let c = await buildMemorableRelayCheck();
        expect(c.status).toBe('warn'); // NOT green — the codex rung must still fire
        expect(c.details?.reason).toBe('codex_hooks_never_fired');
        // Once a codex receipt lands, the expected-rejection note surfaces.
        await appendSessionReceipt({ ...RECEIPT, session_id: 'cdx-2', harness: 'codex', content_hash: 'cdx-h2' });
        c = await buildMemorableRelayCheck();
        expect(c.status).toBe('ok');
        expect(c.details?.reason).toBe('expected_openclaw_rejection');
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
