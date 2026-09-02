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
});
