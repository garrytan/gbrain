/**
 * #8510: `gbrain dream --help --json` runs under the CLI's --json document guard (dream declares
 * `json: 'document'`), which sends console.log to stderr. The help went out through console.log, so fd 1
 * carried nothing, the run exited 0 and recorded a json_document_missing agent-contract event that doctor
 * counts. The real CLI, spawned with an empty GBRAIN_HOME, for the command and both subverbs.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

async function runCli(home: string, argv: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home };
  delete env.GBRAIN_DATABASE_URL;
  delete env.DATABASE_URL;
  const proc = Bun.spawn(['bun', '--no-env-file', 'run', 'src/cli.ts', ...argv], { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe('#8510 dream --help --json', () => {
  for (const [command, argv, usage] of [
    ['dream', ['dream'], 'Usage: gbrain dream [options]'],
    ['dream retriage', ['dream', 'retriage'], 'gbrain dream retriage'],
    ['dream reset-key', ['dream', 'reset-key'], 'gbrain dream reset-key'],
  ] as const) {
    test(`${command} --help --json prints one help document; plain --help keeps its text`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-8510-'));
      try {
        const json = await runCli(home, [...argv, '--help', '--json']);
        expect(json.code).toBe(0);
        expect(json.stdout).not.toBe('');
        const doc = JSON.parse(json.stdout);
        expect(doc).toEqual({ command, help: expect.any(String), contract_version: 1 });
        expect(doc.help).toContain(usage);
        const events = join(home, '.gbrain', 'agent-contract', 'events.jsonl');
        expect(existsSync(events) ? readFileSync(events, 'utf8') : '').not.toContain('json_document_missing');
        const human = await runCli(home, [...argv, '--help']);
        expect(human.code).toBe(0);
        expect(human.stdout).toBe(`${doc.help}\n`);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }, 60_000);
  }
});
