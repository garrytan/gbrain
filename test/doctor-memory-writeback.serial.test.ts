/**
 * memory_writeback doctor check (WP6): quiet-ok when off (opt-in convention),
 * full resolution report when on (mode/TTL/both visibilities/audience),
 * receipt-vs-probe-vs-drift for the harness instruction blocks (OV-A3),
 * override-file detection (OV-A4), and honest counter labels (OV-A11).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildMemoryWritebackCheck } from '../src/commands/doctor/checks/memory-writeback.ts';
import {
  installAmbientWritebackBlockAt,
  renderAmbientInstructionBlock,
} from '../src/core/bootstrap/instructions-block.ts';
import { withEnv } from './helpers/with-env.ts';
import { writeHeartbeat, type HookHeartbeatEntry } from '../src/core/context/hook-heartbeat.ts';

let engine: PGLiteEngine;
let tmp: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-docwb-'));
  await engine.unsetConfig('memory.auto_writeback');
  await engine.unsetConfig('memory.auto_writeback_transient_ttl');
  await engine.unsetConfig('facts.default_visibility');
  await engine.unsetConfig('brain.audience');
});

/** The realistic post-CLI state: `gbrain config set memory.*` dual-writes
 * DB + file mirror. Tests that set the DB plane directly must mirror it, or
 * the check's plane-drift compare (correctly) warns. */
function writeFileMirror(home: string, memory: Record<string, string>): void {
  const dir = join(home, '.gbrain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ engine: 'pglite', memory }) + '\n');
}

function writeReceipt(home: string, targetPath: string, url = 'http://127.0.0.1:19999'): void {
  const dir = join(home, '.gbrain', 'bootstrap');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'harness.json'), JSON.stringify({
    harness_receipt_version: 1,
    created_at: new Date().toISOString(),
    created_by: 'test',
    url,
    source_id: 'default',
    token: { name: 'test-token', minted: false },
    targets: [
      { host: 'codex', kind: 'instructions', state: 'confirmed', scope: 'user', path: targetPath, mechanism: 'managed-block' },
    ],
  }) + '\n');
}

describe('memory_writeback doctor check', () => {
  test('off (default) → quiet ok naming the enable command; audience and postures still reported', async () => {
    await withEnv({ GBRAIN_HOME: tmp }, async () => {
      const c = await buildMemoryWritebackCheck(engine);
      expect(c.status).toBe('ok');
      expect(c.message).toContain('off (default)');
      expect(c.message).toContain('gbrain config set memory.auto_writeback salient');
      expect(c.details).toMatchObject({
        mode: 'off', mode_valid: true, instruction_visibility: 'world', backstop_visibility: 'private',
      });
    });
  });

  test('unrecognized mode → warn with the fix; garbage never enables', async () => {
    await engine.setConfig('memory.auto_writeback', 'always');
    await withEnv({ GBRAIN_HOME: tmp }, async () => {
      const c = await buildMemoryWritebackCheck(engine);
      expect(c.status).toBe('warn');
      expect(c.message).toContain("'always' is unrecognized");
    });
  });

  test('enabled → ok with resolved bundle + BOTH visibility postures + audience reasons + counter honesty note', async () => {
    await engine.setConfig('memory.auto_writeback', 'salient');
    await engine.setConfig('memory.auto_writeback_transient_ttl', '12h');
    await engine.setConfig('facts.default_visibility', 'private');
    writeFileMirror(tmp, { auto_writeback: 'salient', auto_writeback_transient_ttl: '12h' });
    await withEnv({ GBRAIN_HOME: tmp }, async () => {
      const c = await buildMemoryWritebackCheck(engine);
      expect(c.status).toBe('ok');
      expect(c.details).toMatchObject({
        mode: 'salient',
        transient_ttl: '12h',
        instruction_visibility: 'private',
        backstop_visibility: 'private',
        audience: 'personal',
      });
      expect(String(c.details?.counters_note)).toContain('never a source of truth');
      expect(Array.isArray(c.details?.audience_reasons)).toBe(true);
    });
  });

  test('#5671 explicit private default + HTTP harness receipt → warn naming the remote read-back consequence (on and off)', async () => {
    await engine.setConfig('facts.default_visibility', 'private');
    const agents = join(tmp, 'codex-home', 'AGENTS.md');
    writeReceipt(tmp, agents);
    await withEnv({ GBRAIN_HOME: tmp, CODEX_HOME: join(tmp, 'codex-home') }, async () => {
      const off = await buildMemoryWritebackCheck(engine);
      expect(off.status).toBe('warn');
      expect(off.message).toContain('facts.default_visibility is private but this brain is read remotely');
      expect(off.message).toContain('bootstrap harness (HTTP MCP at http://127.0.0.1:19999)');
      expect(off.message).toContain('gbrain config set facts.default_visibility world');
      expect(off.details?.private_default_remote_readers).toEqual(['bootstrap harness (HTTP MCP at http://127.0.0.1:19999)']);

      await engine.setConfig('memory.auto_writeback', 'salient');
      writeFileMirror(tmp, { auto_writeback: 'salient', visibility_posture: 'private' });
      const on = await buildMemoryWritebackCheck(engine);
      expect(on.status).toBe('warn');
      expect(on.message).toContain('facts.default_visibility is private but this brain is read remotely');
    });
  });

  test('#5671 a declared shared brain keeps private-for-remote quietly (intended posture); world never warns', async () => {
    await engine.setConfig('facts.default_visibility', 'private');
    await engine.setConfig('brain.audience', 'shared');
    writeReceipt(tmp, join(tmp, 'codex-home', 'AGENTS.md'));
    await withEnv({ GBRAIN_HOME: tmp, CODEX_HOME: join(tmp, 'codex-home') }, async () => {
      const shared = await buildMemoryWritebackCheck(engine);
      expect(shared.status).toBe('ok');
      await engine.unsetConfig('brain.audience');
      await engine.setConfig('facts.default_visibility', 'world');
      const world = await buildMemoryWritebackCheck(engine);
      expect(world.status).toBe('ok');
      expect(world.message).not.toContain('read remotely');
    });
  });

  test('instruction block: current → ok probe; config change → drift warn naming the re-run (OV-A3)', async () => {
    await engine.setConfig('memory.auto_writeback', 'salient');
    writeFileMirror(tmp, { auto_writeback: 'salient' });
    const agents = join(tmp, 'codex-home', 'AGENTS.md');
    mkdirSync(join(tmp, 'codex-home'), { recursive: true });
    const url = 'http://127.0.0.1:19999';
    writeReceipt(tmp, agents, url);
    installAmbientWritebackBlockAt(agents, renderAmbientInstructionBlock({
      mode: 'salient', transientTtl: '3d', visibility: 'world', serveUrl: url,
    }));
    await withEnv({ GBRAIN_HOME: tmp, CODEX_HOME: join(tmp, 'codex-home') }, async () => {
      const current = await buildMemoryWritebackCheck(engine);
      expect(current.status).toBe('ok');
      const blocks = current.details?.instruction_blocks as Array<{ probe: string }>;
      expect(blocks?.[0]?.probe).toBe('current');

      // Flip the TTL → the installed block is stale → drift warn.
      await engine.setConfig('memory.auto_writeback_transient_ttl', '12h');
      const drifted = await buildMemoryWritebackCheck(engine);
      expect(drifted.status).toBe('warn');
      expect(drifted.message).toContain('stale');
      expect(drifted.message).toContain('bootstrap harness');
    });
  });

  test('AGENTS.override.md present → warn: the codex block is dead (OV-A4)', async () => {
    await engine.setConfig('memory.auto_writeback', 'salient');
    const codexHome = join(tmp, 'codex-home');
    mkdirSync(codexHome, { recursive: true });
    const agents = join(codexHome, 'AGENTS.md');
    const url = 'http://127.0.0.1:19999';
    writeReceipt(tmp, agents, url);
    installAmbientWritebackBlockAt(agents, renderAmbientInstructionBlock({
      mode: 'salient', transientTtl: '3d', visibility: 'world', serveUrl: url,
    }));
    writeFileSync(join(codexHome, 'AGENTS.override.md'), '# my override\n');
    await withEnv({ GBRAIN_HOME: tmp, CODEX_HOME: codexHome }, async () => {
      const c = await buildMemoryWritebackCheck(engine);
      expect(c.status).toBe('warn');
      expect(c.message).toContain('AGENTS.override.md');
    });
  });

  test('engine-free run (null engine) → honest file-mirror report, never a throw', async () => {
    await withEnv({ GBRAIN_HOME: tmp }, async () => {
      const c = await buildMemoryWritebackCheck(null);
      expect(c.status).toBe('ok');
      expect(c.details?.plane).toBe('file-mirror-only');
    });
  });

  test('plane drift (DB on, file mirror silent) → warn naming the re-sync — the Stop hook reads the wrong truth', async () => {
    await engine.setConfig('memory.auto_writeback', 'salient');
    // No file mirror written: the state a failed dual-write (or a `config
    // set` on ANOTHER machine of a shared Postgres brain) leaves behind.
    await withEnv({ GBRAIN_HOME: tmp }, async () => {
      const c = await buildMemoryWritebackCheck(engine);
      expect(c.status).toBe('warn');
      expect(c.message).toContain('file mirror');
      expect(c.message).toContain('gbrain config set memory.auto_writeback salient');
      expect(c.details?.file_mirror_mode).toBe('(unset)');
    });
  });

  test('a FAILED receipt target warns even when the live probe looks current — the smoke-rollback strip-failure survivor (codex re-review)', async () => {
    await engine.setConfig('memory.auto_writeback', 'salient');
    writeFileMirror(tmp, { auto_writeback: 'salient' });
    const codexHome = join(tmp, 'codex-home');
    mkdirSync(codexHome, { recursive: true });
    const agents = join(codexHome, 'AGENTS.md');
    const url = 'http://127.0.0.1:19999';
    // Receipt records the target FAILED (strip threw during smoke rollback)
    // while the block itself still sits on disk looking perfectly current.
    const dir = join(tmp, '.gbrain', 'bootstrap');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'harness.json'), JSON.stringify({
      harness_receipt_version: 1,
      created_at: new Date().toISOString(),
      created_by: 'test',
      url,
      source_id: 'default',
      token: { name: 'test-token', minted: false },
      targets: [
        { host: 'codex', kind: 'instructions', state: 'failed', scope: 'user', path: agents, mechanism: 'managed-block', error: 'smoke failed and the instruction block could not be removed — run `gbrain bootstrap harness --remove` to converge' },
      ],
    }) + '\n');
    installAmbientWritebackBlockAt(agents, renderAmbientInstructionBlock({
      mode: 'salient', transientTtl: '3d', visibility: 'world', serveUrl: url,
    }));
    await withEnv({ GBRAIN_HOME: tmp, CODEX_HOME: codexHome }, async () => {
      const c = await buildMemoryWritebackCheck(engine);
      expect(c.status).toBe('warn');
      expect(c.message).toContain('previously FAILED');
      expect(c.message).toContain('bootstrap harness');
    });
  });

  test('off but an instruction block is still installed → warn naming the converge command (red-team review)', async () => {
    // memory.auto_writeback unset everywhere = off. The lingering block means
    // every NEW session is still instructed to save via remember — the off
    // switch is incomplete until converged, and doctor must say so instead of
    // early-returning a healthy "off (default)".
    const codexHome = join(tmp, 'codex-home');
    mkdirSync(codexHome, { recursive: true });
    const agents = join(codexHome, 'AGENTS.md');
    const url = 'http://127.0.0.1:19999';
    writeReceipt(tmp, agents, url);
    installAmbientWritebackBlockAt(agents, renderAmbientInstructionBlock({
      mode: 'salient', transientTtl: '3d', visibility: 'world', serveUrl: url,
    }));
    await withEnv({ GBRAIN_HOME: tmp, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: join(tmp, 'claude-cfg') }, async () => {
      const c = await buildMemoryWritebackCheck(engine);
      expect(c.status).toBe('warn');
      expect(c.message).toContain('still installed');
      expect(c.message).toContain('bootstrap harness --yes');
      expect(Array.isArray(c.details?.lingering_instruction_blocks)).toBe(true);
    });
  });

  // #5557: a share of failed serve-side harvests is visible, not a silent counter.
  const harvestCases: Array<{ name: string; ok: number; errors: string[]; requeued: number; warn: string | null }> = [
    {
      name: 'mostly failed harvests warn with the top error reason',
      ok: 8,
      errors: [...Array(10).fill('operationerror:writer_lock_unavailable'), 'aitransienterror', 'aitransienterror'],
      requeued: 3,
      warn: '12/20 writeback harvests failed in 7d (top: operationerror:writer_lock_unavailable x10)',
    },
    { name: 'a small failure share stays ok', ok: 18, errors: ['operationerror:writer_lock_unavailable', 'aborterror'], requeued: 5, warn: null },
    { name: 'exactly 20% failed stays ok', ok: 8, errors: ['operationerror:writer_lock_unavailable', 'aborterror'], requeued: 0, warn: null },
    {
      name: 'exactly 10 finished harvests is enough to judge',
      ok: 7,
      errors: ['operationerror:writer_lock_unavailable', 'operationerror:writer_lock_unavailable', 'aborterror'],
      requeued: 0,
      warn: '3/10 writeback harvests failed in 7d (top: operationerror:writer_lock_unavailable x2)',
    },
    { name: 'too few harvests to judge stays ok', ok: 1, errors: ['operationerror:writer_lock_unavailable', 'aborterror'], requeued: 0, warn: null },
  ];
  for (const c of harvestCases) {
    test(`#5557 harvest failures: ${c.name}`, async () => {
      await engine.setConfig('memory.auto_writeback', 'salient');
      writeFileMirror(tmp, { auto_writeback: 'salient' });
      await withEnv({ GBRAIN_HOME: tmp }, async () => {
        const ts = new Date().toISOString();
        const entries: HookHeartbeatEntry[] = [
          ...Array.from({ length: c.ok }, (): HookHeartbeatEntry => ({ ts, event: 'writeback', outcome: 'ok', duration_ms: 5000, inserted: 1 })),
          ...c.errors.map((reason): HookHeartbeatEntry => ({ ts, event: 'writeback', outcome: 'error', reason, duration_ms: 1000 })),
          ...Array.from({ length: c.requeued }, (): HookHeartbeatEntry => ({ ts, event: 'writeback', outcome: 'degraded', reason: 'writer_busy_requeued', duration_ms: 1000 })),
        ];
        for (const entry of entries) await writeHeartbeat(entry, { trim: false });
        const check = await buildMemoryWritebackCheck(engine);
        expect(check.details?.backstop_7d).toMatchObject({ failed: c.errors.length });
        if (c.warn) {
          expect(check.status).toBe('warn');
          expect(check.message).toContain(c.warn);
          expect(check.message).toContain('gbrain sweep --once');
        } else {
          expect(check.status).toBe('ok');
        }
      });
    });
  }
});
