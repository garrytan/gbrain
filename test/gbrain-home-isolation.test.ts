/**
 * Hermeticity test: every site that writes under `~/.gbrain` must honor
 * `GBRAIN_HOME=<tmp>` and write under `<tmp>/.gbrain` instead of the developer's
 * real home.
 *
 * Why this exists: `src/core/config.ts::configDir()` already supports
 * `GBRAIN_HOME` as a parent-dir override (returns `<override>/.gbrain`), but
 * historically many call sites built paths from `os.homedir()` directly,
 * bypassing the override. The hermeticity migration migrated every write-side
 * caller to `gbrainPath(...)`. This test is the regression gate.
 *
 * Scope: write-isolation only. Read-side host detection in
 * `src/commands/init.ts` (reading `~/.claude`, `~/.openclaw`, etc. for module
 * fingerprinting) is the documented v1 caveat and is NOT asserted here.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, existsSync, readdirSync, statSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Save original env so we don't leak between tests.
const ORIG_GBRAIN_HOME = process.env.GBRAIN_HOME;

function fresh(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-home-isolation-'));
}

describe('GBRAIN_HOME write-side isolation', () => {
  test('configDir() returns <GBRAIN_HOME>/.gbrain when override is set', async () => {
    const tmp = fresh();
    process.env.GBRAIN_HOME = tmp;
    try {
      const { configDir, gbrainPath } = await import('../src/core/config.ts');
      expect(configDir()).toBe(join(tmp, '.gbrain'));
      expect(gbrainPath('foo', 'bar.json')).toBe(join(tmp, '.gbrain', 'foo', 'bar.json'));
    } finally {
      process.env.GBRAIN_HOME = ORIG_GBRAIN_HOME;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('configDir() falls back to homedir when GBRAIN_HOME unset', async () => {
    delete process.env.GBRAIN_HOME;
    try {
      const { configDir } = await import('../src/core/config.ts');
      const result = configDir();
      // Should NOT contain the test tmpdir; should resolve to a real homedir path.
      expect(result.endsWith('.gbrain')).toBe(true);
      expect(result.startsWith('/tmp/')).toBe(false);
    } finally {
      if (ORIG_GBRAIN_HOME !== undefined) process.env.GBRAIN_HOME = ORIG_GBRAIN_HOME;
    }
  });

  test('rejects relative GBRAIN_HOME', async () => {
    process.env.GBRAIN_HOME = 'relative/path';
    try {
      const { configDir } = await import('../src/core/config.ts');
      expect(() => configDir()).toThrow(/absolute path/);
    } finally {
      process.env.GBRAIN_HOME = ORIG_GBRAIN_HOME;
    }
  });

  test("rejects GBRAIN_HOME containing '..' segments", async () => {
    process.env.GBRAIN_HOME = '/tmp/foo/../bar';
    try {
      const { configDir } = await import('../src/core/config.ts');
      expect(() => configDir()).toThrow(/'\.\.' segments/);
    } finally {
      process.env.GBRAIN_HOME = ORIG_GBRAIN_HOME;
    }
  });

  test('saveConfig/loadConfig honor GBRAIN_HOME', async () => {
    const tmp = fresh();
    process.env.GBRAIN_HOME = tmp;
    try {
      const { saveConfig, loadConfig } = await import('../src/core/config.ts');
      const cfg = { engine: 'pglite' as const, database_path: join(tmp, '.gbrain', 'brain.pglite') };
      saveConfig(cfg);
      // Config file should exist under the override, NOT under real ~/.gbrain.
      expect(existsSync(join(tmp, '.gbrain', 'config.json'))).toBe(true);

      // Round-trip: loadConfig() finds it back via the override.
      const loaded = loadConfig();
      expect(loaded?.engine).toBe('pglite');
      expect(loaded?.database_path).toBe(cfg.database_path);
    } finally {
      process.env.GBRAIN_HOME = ORIG_GBRAIN_HOME;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('integrity, sync-failures, integrations heartbeat resolve under GBRAIN_HOME', async () => {
    const tmp = fresh();
    process.env.GBRAIN_HOME = tmp;
    try {
      const { gbrainPath } = await import('../src/core/config.ts');
      // Spot-check a representative set of paths used across the migrated sites.
      const paths = [
        gbrainPath('integrity-review.md'),                       // src/commands/integrity.ts
        gbrainPath('sync-failures.jsonl'),                       // src/core/sync.ts
        gbrainPath('integrations', 'recipe-x'),                  // src/commands/integrations.ts
        gbrainPath('migrate-manifest.json'),                     // src/commands/migrate-engine.ts
        gbrainPath('import-checkpoint.json'),                    // src/commands/import.ts
        gbrainPath('migrations', 'v0_13_1-rollback.jsonl'),      // src/commands/migrations/v0_13_1.ts
        gbrainPath('migrations', 'pending-host-work.jsonl'),     // src/commands/migrations/v0_14_0.ts
        gbrainPath('audit'),                                     // shell-audit / backpressure-audit
        gbrainPath('cycle.lock'),                                // src/core/cycle.ts
        gbrainPath('fail-improve'),                              // src/core/fail-improve.ts
        gbrainPath('validator-lint.jsonl'),                      // src/core/output/post-write.ts
        gbrainPath('brain.pglite'),                              // init pglite default
      ];
      for (const p of paths) {
        expect(p.startsWith(join(tmp, '.gbrain'))).toBe(true);
      }
    } finally {
      process.env.GBRAIN_HOME = ORIG_GBRAIN_HOME;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('GBRAIN_AUDIT_DIR override still wins over GBRAIN_HOME', async () => {
    const tmp = fresh();
    const auditTmp = fresh();
    process.env.GBRAIN_HOME = tmp;
    process.env.GBRAIN_AUDIT_DIR = auditTmp;
    try {
      const { resolveAuditDir } = await import('../src/core/minions/handlers/shell-audit.ts');
      // Per the docstring: GBRAIN_AUDIT_DIR is the explicit override and wins.
      expect(resolveAuditDir()).toBe(auditTmp);
    } finally {
      process.env.GBRAIN_HOME = ORIG_GBRAIN_HOME;
      delete process.env.GBRAIN_AUDIT_DIR;
      rmSync(tmp, { recursive: true, force: true });
      rmSync(auditTmp, { recursive: true, force: true });
    }
  });
});
