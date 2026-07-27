/**
 * v0.38 source-resolver silent-fallback tier tests (codex P1-F).
 *
 * The resolver has 6 tiers. Two of them — dotfile (tier 3) and
 * brain_default (tier 5) — were migrated in this wave to use
 * `isValidSourceId` instead of inline regex. The intent: an invalid
 * dotfile content or invalid brain_default config silently falls
 * through to the next tier, rather than throwing.
 *
 * This is distinct from tiers 1 (explicit --source) and 2 (env), which
 * MUST throw on invalid input because the user explicitly named them.
 * Per codex P1-F, the resolver needs BOTH validator shapes.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resolveSourceId } from '../src/core/source-resolver.ts';
import { withEnv } from './helpers/with-env.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let engine: PGLiteEngine;
let cwd: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  cwd = mkdtempSync(join(tmpdir(), 'gbrain-resolver-'));
});

describe('source-resolver silent-fallback tiers (codex P1-F)', () => {
  describe('tier 3 — .gbrain-source dotfile', () => {
    test('valid dotfile content (registered source) is honored', async () => {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ('alpha', 'alpha', '{}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
      );
      writeFileSync(join(cwd, '.gbrain-source'), 'alpha\n');
      const resolved = await resolveSourceId(engine, null, cwd);
      expect(resolved).toBe('alpha');
    });

    test('underscore in dotfile content silently falls through (strict regex rejects)', async () => {
      // The strict regex rejects underscores. Pre-PR the permissive regex
      // accepted them. After: invalid content falls through to next tier.
      writeFileSync(join(cwd, '.gbrain-source'), 'has_underscore\n');
      // No other tier signal — falls through to tier 6 'default'
      const resolved = await resolveSourceId(engine, null, cwd);
      expect(resolved).toBe('default');
    });

    test('whitespace-only dotfile content silently falls through', async () => {
      writeFileSync(join(cwd, '.gbrain-source'), '   \n');
      const resolved = await resolveSourceId(engine, null, cwd);
      expect(resolved).toBe('default');
    });

    test('uppercase in dotfile content silently falls through', async () => {
      writeFileSync(join(cwd, '.gbrain-source'), 'DEFAULT\n');
      const resolved = await resolveSourceId(engine, null, cwd);
      expect(resolved).toBe('default');
    });
  });

  describe('tier 5 — brain_default config', () => {
    test('valid brain_default (registered source) is honored', async () => {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ('beta', 'beta', '{}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
      );
      await engine.setConfig('sources.default', 'beta');
      const resolved = await resolveSourceId(engine, null, cwd);
      expect(resolved).toBe('beta');
    });

    test('underscore in brain_default config silently falls through', async () => {
      await engine.setConfig('sources.default', 'has_underscore');
      const resolved = await resolveSourceId(engine, null, cwd);
      expect(resolved).toBe('default');
    });

    test('33+ char brain_default silently falls through', async () => {
      const tooLong = 'a' + 'b'.repeat(31) + 'c'; // 33 chars
      await engine.setConfig('sources.default', tooLong);
      const resolved = await resolveSourceId(engine, null, cwd);
      expect(resolved).toBe('default');
    });
  });

  describe('tier 1 — explicit --source (throw-on-invalid contract)', () => {
    test('valid explicit source returns it', async () => {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ('gamma', 'gamma', '{}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
      );
      const resolved = await resolveSourceId(engine, 'gamma', cwd);
      expect(resolved).toBe('gamma');
    });

    test('underscore in explicit source THROWS (tier-1 contract)', async () => {
      await expect(resolveSourceId(engine, 'has_underscore', cwd)).rejects.toThrow(/Invalid --source/);
    });

    test('whitespace in explicit source THROWS', async () => {
      await expect(resolveSourceId(engine, 'has space', cwd)).rejects.toThrow(/Invalid --source/);
    });
  });

  describe('tier 2 — GBRAIN_SOURCE env (throw-on-invalid contract)', () => {
    test('valid env value is honored', async () => {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ('delta', 'delta', '{}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
      );
      await withEnv({ GBRAIN_SOURCE: 'delta' }, async () => {
        const resolved = await resolveSourceId(engine, null, cwd);
        expect(resolved).toBe('delta');
      });
    });

    test('underscore in GBRAIN_SOURCE THROWS (tier-2 contract)', async () => {
      await withEnv({ GBRAIN_SOURCE: 'has_underscore' }, async () => {
        await expect(resolveSourceId(engine, null, cwd)).rejects.toThrow(/GBRAIN_SOURCE/);
      });
    });
  });
});
