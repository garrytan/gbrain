/**
 * GBRA-438 PR 2, done item 2: free upkeep runs inside the agent's own
 * \`gbrain serve\` on a fresh keyless, repo-less PGLite brain, black-box
 * through the real CLI. init, import and remember; start a stdio serve with a
 * one-second GBRAIN_SWEEP_IDLE_INTERVAL_MS and leave it idle past due. While it
 * runs, a scheduled run exits 0 because the serve owns upkeep (the real
 * live-serve probe). After it stops: links are extracted, maintenance.last_run
 * names runner serve, and doctor's unattended_maintenance is ok.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../helpers/cli-spawn.ts';

const KEYLESS = { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, VOYAGE_API_KEY: undefined, GEMINI_API_KEY: undefined, JEV_TYPESAFE_API_KEY: undefined };
const TIMEOUT_MS = 180_000;
const CLI = join(import.meta.dir, '..', '..', 'src', 'cli.ts');

describe('stdio serve runs free upkeep while idle (keyless, repo-less PGLite)', () => {
  let home: string;
  const gbrain = (args: string[]) => runCli(args, { home, env: KEYLESS, timeoutMs: TIMEOUT_MS });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-serve-upkeep-e2e-'));
    expect((await gbrain(['init', '--pglite', '--no-embedding', '--non-interactive'])).exitCode).toBe(0);
    const notes = join(home, 'notes');
    mkdirSync(notes);
    writeFileSync(join(notes, 'alpha.md'), '---\ntitle: Alpha\ntype: concept\n---\n# Alpha\n\nAlpha relies on [[beta]].\n');
    writeFileSync(join(notes, 'beta.md'), '---\ntitle: Beta\ntype: concept\n---\n# Beta\n\nBeta.\n');
    expect((await gbrain(['import', notes, '--no-embed'])).exitCode).toBe(0);
    const remember = await gbrain(['remember', 'Alpha ships on Fridays.', '--entity', 'alpha', '--content-origin', 'user_said', '--provenance', 'e2e test']);
    expect(remember.exitCode).toBe(0);
  }, TIMEOUT_MS);

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  test('an idle serve runs upkeep as runner serve; the scheduled run defers to it; doctor is ok', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    for (const k of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', ...Object.keys(KEYLESS)]) delete env[k];
    Object.assign(env, { HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP_IDLE_INTERVAL_MS: '1000' });
    const serve = Bun.spawn({ cmd: [process.execPath, '--no-env-file', CLI, 'serve'], env, cwd: home, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    let log = '';
    const reader = (async () => { for await (const chunk of serve.stderr) log += new TextDecoder().decode(chunk); })();
    try {
      const deadline = Date.now() + 120_000;
      while (!/idle upkeep: finished/.test(log) && Date.now() < deadline && serve.exitCode === null) await Bun.sleep(250);
      expect(log).toMatch(/idle upkeep: started/);
      expect(log).toMatch(/idle upkeep: finished in \d+ ms \(ran\)/);
      expect(log.indexOf('idle sweep: finished')).toBeLessThan(log.indexOf('idle upkeep: started'));
      const scheduled = await gbrain(['maintain', '--unattended', '--runner', 'schedule', '--json']);
      expect(scheduled.exitCode).toBe(0);
      expect(JSON.parse(scheduled.stdout)).toMatchObject({ status: 'skipped', exit: 0, code: 'maintenance_owned_by_serve' });
    } finally {
      serve.stdin.end();
      const killer = setTimeout(() => serve.kill(9), 15_000);
      await serve.exited;
      clearTimeout(killer);
      await reader.catch(() => {});
    }
    const status = JSON.parse((await gbrain(['maintain', '--status', '--json'])).stdout);
    expect(status).toMatchObject({ state: 'ok', runner: 'serve' });
    const links = JSON.parse((await gbrain(['backlinks', 'beta', '--json'])).stdout);
    expect(links.map((l: { from_slug: string }) => l.from_slug)).toEqual(['alpha']);
    const doctor = JSON.parse((await gbrain(['doctor', '--only', 'unattended_maintenance', '--json'])).stdout);
    const check = doctor.checks.find((c: { name: string }) => c.name === 'unattended_maintenance');
    expect(check).toMatchObject({ status: 'ok', details: { state: 'ok', runner: 'serve' } });
    expect(check.message).toMatch(/^Free upkeep ran \d+m ago \(serve, \d+ steps ok\)\./);
  }, TIMEOUT_MS);
});
