/**
 * #7086: `foresights sources mirror-readonly <id> --dry-run` and `mirror-writable <id> --dry-run` preview the change and write
 * nothing, as `sources remove --dry-run` does. Up to v0.60.316.0 both ignored --dry-run and set or cleared
 * `sources.config.mirror_read_only`. Asserts the source row (config and updated state) is byte-identical after each dry
 * run and that the real command still writes. PGLite always, Postgres when DATABASE_URL is set
 * (twin: test/e2e/s-7086-mirror-dry-run-postgres.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runSources } from '../../src/commands/sources.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

const SOURCE = 'acme-example';

async function cli(engine: BrainEngine, args: string[]): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try { await runSources(engine, args); } finally { console.log = original; }
  return lines.join('\n');
}
const row = async (engine: BrainEngine) =>
  (await engine.executeRaw<{ config: string }>('SELECT config::text AS config FROM sources WHERE id = $1', [SOURCE]))[0]!.config;

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`sources mirror-readonly / mirror-writable --dry-run (#7086) [${backend}]`, () => {
    test('--dry-run previews with a (dry-run) banner and leaves the source row unchanged; without it the flag is written', async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-mirror-dry-run-'));
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{\"federated\":true}')", [SOURCE]);
          const before = await row(engine);
          const preview = await cli(engine, ['mirror-readonly', SOURCE, '--dry-run']);
          expect(preview).toContain('(dry-run; no side effects)');
          expect(preview).toContain('would become a read-only mirror');
          expect(await row(engine)).toBe(before);

          await cli(engine, ['mirror-readonly', SOURCE]);
          const readOnly = await row(engine);
          expect(JSON.parse(readOnly).mirror_read_only).toBe(true);

          const undo = await cli(engine, ['mirror-writable', SOURCE, '--dry-run']);
          expect(undo).toContain('(dry-run; no side effects)');
          expect(undo).toContain('would become writable');
          expect(await row(engine)).toBe(readOnly);

          await cli(engine, ['mirror-writable', SOURCE]);
          expect(JSON.parse(await row(engine)).mirror_read_only).toBeUndefined();
        } finally {
          await close();
          rmSync(home, { recursive: true, force: true });
        }
      });
    }, 120_000);
  });
}
