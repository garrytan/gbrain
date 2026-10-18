/**
 * #6780: `gbrain config set` accepts each runtime knob registered in
 * src/core/config-runtime-keys.ts without --force.
 *
 * Protects the user-visible contract the registry exists for: before the
 * fix, every key below exited 1 with `Unknown config key` (the doctor's own
 * facts_extraction_health message told operators to run one of them).
 * Spawns the real CLI against a throwaway PGLite brain; asserts the exit
 * code, the confirmation line and the value `config get` reads back.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCli } from './helpers/cli-spawn.ts';

const CASES: Array<[string, string]> = [
  ['doctor.entry_budget_ms', '20000'],
  ['doctor.orphan_ratio.full_scan_max_pages', '100000'],
  ['embed.max_usd_per_page', '5'],
  ['facts.absorb_warn_threshold', '25'],
  ['think.trajectory_enabled', 'false'],
  ['embedding_image_ocr_max_images', '50'],
  ['embedding_image_ocr_max_usd', '0.5'],
  ['agent.search_snippet_chars', '500'],
  ['skillopt.allowed_skills', '["brain-ops"]'],
  ['skillopt.capture_enabled', 'true'],
  ['entity_identity.union', 'true'],
  ['writer.lint_on_put_page', 'true'],
];

let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-config-runtime-keys-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  const dbPath = join(home, '.gbrain', 'brain.pglite');
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dbPath, embedding_dimensions: 1536 }) + '\n');
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dbPath });
  await engine.initSchema();
  await engine.disconnect();
}, 240_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('#6780 config set accepts the runtime reader keys', () => {
  test.each(CASES)('config set %s %s succeeds and reads back', async (key, value) => {
    const env = { GBRAIN_BRAIN_ID: '', GBRAIN_SOURCE: '' };
    const set = await runCli(['config', 'set', key, value], { home, env, timeoutMs: 120_000 });
    expect(set.stderr).not.toContain('Unknown config key');
    expect(set.exitCode).toBe(0);
    const get = await runCli(['config', 'get', key], { home, env, timeoutMs: 120_000 });
    expect(get.exitCode).toBe(0);
    expect(get.stdout.trim()).toBe(value);
  }, 240_000);
});
