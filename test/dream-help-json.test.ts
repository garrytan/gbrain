import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

describe('dream help under the document JSON guard', () => {
  for (const args of [
    ['--help', '--json'],
    ['--json', '--help'],
    ['-h', '--json', '--source', 'missing-source'],
  ]) {
    test(`dream ${args.join(' ')} writes one document without an E11 event`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-dream-help-json-'));
      try {
        const result = await runCli(['dream', ...args], { home, cwd: home });
        expect(result.exitCode).toBe(0);
        // Parsing the entire stream also rejects multiple documents or human noise.
        const document = JSON.parse(result.stdout);
        expect(document).toMatchObject({ command: 'dream', contract_version: 1 });
        expect(document.help).toContain('Usage: gbrain dream [options]');
        const eventsPath = join(home, '.gbrain', 'agent-contract', 'events.jsonl');
        const events = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : '';
        expect(events).not.toContain('json_document_missing');
        // Help must stay engine-free even for a source that does not exist.
        expect(existsSync(join(home, '.gbrain', 'config.json'))).toBe(false);
        expect(result.stderr).not.toContain('could not connect to DB');

        const human = await runCli(['dream', '--help'], { home, cwd: home });
        expect(human.exitCode).toBe(0);
        expect(document.help + '\n').toBe(human.stdout);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }, 120_000);
  }
});
