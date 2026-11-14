/**
 * GBRA-438 PR 1, done item 9: free upkeep on a fresh keyless, repo-less
 * PGLite brain, black-box through the real CLI. Import leaves links
 * unextracted (link_count 0); one \`gbrain maintain --unattended\` extracts
 * them, writes maintenance.last_run, and doctor's unattended_maintenance
 * shows the ok line. A second run is not due. \`maintain --status\` on a home
 * with no brain refuses no_brain with exit 1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../helpers/cli-spawn.ts';

const KEYLESS = { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, VOYAGE_API_KEY: undefined, GEMINI_API_KEY: undefined, JEV_TYPESAFE_API_KEY: undefined };
const TIMEOUT_MS = 120_000;

describe('maintain --unattended on a fresh keyless repo-less PGLite brain', () => {
  let home: string;
  const gbrain = (args: string[], h = home) => runCli(args, { home: h, env: KEYLESS, timeoutMs: TIMEOUT_MS });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-upkeep-e2e-'));
    const init = await gbrain(['init', '--pglite', '--no-embedding', '--non-interactive']);
    expect(init.exitCode).toBe(0);
    const notes = join(home, 'notes');
    mkdirSync(notes);
    writeFileSync(join(notes, 'alpha.md'), '---\ntitle: Alpha\ntype: concept\n---\n# Alpha\n\nAlpha relies on [[beta]].\n');
    writeFileSync(join(notes, 'beta.md'), '---\ntitle: Beta\ntype: concept\n---\n# Beta\n\nBeta.\n');
    expect((await gbrain(['import', notes, '--no-embed'])).exitCode).toBe(0);
  }, TIMEOUT_MS);

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  test('extracts links, records the run, and doctor shows the ok line', async () => {
    expect(JSON.parse((await gbrain(['stats', '--json'])).stdout).link_count).toBe(0);
    const run = await gbrain(['maintain', '--unattended', '--json']);
    expect(run.exitCode).toBe(0);
    const outcome = JSON.parse(run.stdout);
    expect(outcome).toMatchObject({ status: 'ran', exit: 0, record: { runner: 'cli', status: 'ok', cursor: null } });
    expect(outcome.record.steps.map((s: { name: string }) => s.name)).not.toContain('purge');
    const links = JSON.parse((await gbrain(['backlinks', 'beta', '--json'])).stdout);
    expect(links.map((l: { from_slug: string }) => l.from_slug)).toEqual(['alpha']);
    const doctor = JSON.parse((await gbrain(['doctor', '--only', 'unattended_maintenance', '--json'])).stdout);
    const check = doctor.checks.find((c: { name: string }) => c.name === 'unattended_maintenance');
    expect(check).toMatchObject({ status: 'ok', details: { state: 'ok', runner: 'cli' } });
    expect(check.message).toMatch(/^Free upkeep ran \d+m ago \(cli, \d+ steps ok\)\. Next due in \d+h\. Nothing deletes on its own\./);
    const again = JSON.parse((await gbrain(['maintain', '--unattended', '--json'])).stdout);
    expect(again).toMatchObject({ status: 'not_due', exit: 0 });
  }, TIMEOUT_MS);

  test('--status on a home with no brain refuses no_brain with exit 1', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'gbrain-upkeep-empty-'));
    try {
      const out = await gbrain(['maintain', '--status', '--json'], empty);
      expect(out.exitCode).toBe(1);
      expect(out.stdout + out.stderr).toContain('no_brain');
    } finally { rmSync(empty, { recursive: true, force: true }); }
  }, TIMEOUT_MS);
});
