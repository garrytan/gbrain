/**
 * Doctor retrieval_reflex_health check (#1981, T8).
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRetrievalReflexCheck } from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';

describe('buildRetrievalReflexCheck', () => {
  test('disabled via env → ok intentional-off, names the right check', async () => {
    await withEnv({ GBRAIN_RETRIEVAL_REFLEX: 'false' }, async () => {
      const c = buildRetrievalReflexCheck(null);
      expect(c.name).toBe('retrieval_reflex_health');
      expect(c.status).toBe('ok');
      expect(c.message).toContain('intentionally disabled');
      expect((c.details as any)?.enabled).toBe(false);
    });
  });

  test('enabled → reports policy-skill install state in details', async () => {
    await withEnv({ GBRAIN_RETRIEVAL_REFLEX: 'true' }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'rr-doctor-'));
      mkdirSync(join(dir, 'retrieval-reflex'), { recursive: true });
      writeFileSync(join(dir, 'retrieval-reflex', 'SKILL.md'), '# stub\n');
      const c = buildRetrievalReflexCheck(dir);
      expect(c.name).toBe('retrieval_reflex_health');
      expect((c.details as any)?.enabled).toBe(true);
      expect((c.details as any)?.policy_skill_installed).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  test('enabled, policy skill absent → message includes the install hint', async () => {
    await withEnv({ GBRAIN_RETRIEVAL_REFLEX: 'true' }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'rr-doctor-2-'));
      const c = buildRetrievalReflexCheck(dir);
      expect((c.details as any)?.policy_skill_installed).toBe(false);
      expect(c.message).toContain('gbrain integrations install retrieval-reflex');
      rmSync(dir, { recursive: true, force: true });
    });
  });
  // The Rust engine keeps one local data dir and binds the same resolve socket as PGLite, so with no socket it is
  // the same informational "no serve" note, not a warning.
  for (const engine of ['pglite', 'rust'] as const) {
    test(`${engine} brain with no serve socket → ok info, path names the engine`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'rr-doctor-home-'));
      try {
        mkdirSync(join(home, '.gbrain'), { recursive: true });
        writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine, database_path: join(home, 'brain') }));
        await withEnv({ GBRAIN_RETRIEVAL_REFLEX: 'true', GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
          const c = buildRetrievalReflexCheck(null);
          expect(c.status).toBe('ok');
          expect(c.severity).toBe('info');
          expect(c.readiness_state).toBe('not_applicable');
          expect((c.details as any)?.engine).toBe(engine);
          expect((c.details as any)?.path).toBe(`${engine} \u2014 serve IPC socket not present`);
          expect(c.message).not.toContain('engine rust');
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});
