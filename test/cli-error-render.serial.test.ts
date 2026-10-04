/**
 * Agent contract v1 D1: every top-level catch, usage error and the fatal seam
 * render through renderCliError. Human: `Error [code]: …` / `Fix: …` on
 * stderr; `--json`: exactly one envelope on stdout (code + suggestion +
 * contract_version), exit code from the registry (2 for usage errors).
 * Real CLI subprocesses against an empty GBRAIN_HOME (no brain is opened).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-cli-error-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const cli = (args: string[]) => runCli(args, { home, cwd: home });

describe('D1 CLI error rendering', () => {
  test('unknown command: human lines on stderr, exit 2', async () => {
    const r = await cli(['definitely-not-a-command']);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Error [unknown_command]: Unknown command: definitely-not-a-command');
    expect(r.stderr).toContain('Fix: Run `gbrain --help`');
  });

  test('unknown command --json: one envelope on stdout', async () => {
    const r = await cli(['definitely-not-a-command', '--json']);
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({
      error: 'unknown_command', code: 'unknown_command', class: 'caller', retryable: false, contract_version: 1,
      docs_cmd: ['gbrain', 'errors', 'unknown_command'],
    });
  });

  test('unknown flag keeps the legacy one-line keys and gains the envelope + did-you-mean', async () => {
    const r = await cli(['search', 'needle', '--limitt', '3', '--json']);
    expect(r.exitCode).toBe(2);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ status: 'error', reason: 'invalid_flag', error: 'unknown_flag', code: 'unknown_flag', contract_version: 1 });
    expect(doc.suggestion).toContain('--limit');
    expect(doc.fix).toMatchObject({ argv: ['gbrain', 'search', '--help', '--brain', 'host'], next: 'run' });
    expect(r.stderr).toContain("unknown flag --limitt for 'gbrain search'");
  });

  test('missing required param names the param, exit 2', async () => {
    const r = await cli(['get', '--json']);
    expect(r.exitCode).toBe(2);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ code: 'invalid_params' });
    expect(doc.message).toContain("'slug'");
    expect(doc.suggestion).toContain('Usage: gbrain get <slug>');
  });

  test('fatal seam: a parser OperationError thrown out of main() renders the envelope', async () => {
    const r = await cli(['put', 'example-slug', '--content', '--json']);
    expect(r.exitCode).toBe(2);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ error: 'invalid_params', code: 'invalid_params', contract_version: 1 });
    expect(doc.message).toContain('--content requires a value');
  });

  test('no brain configured: no_brain with an init fix (human and --json)', async () => {
    const human = await cli(['stats']);
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toContain('Error [no_brain]: No brain configured');
    expect(human.stderr).toContain('Fix: gbrain init --pglite --no-embedding');
    const json = await cli(['stats', '--json']);
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({
      code: 'no_brain', fix: { argv: ['gbrain', 'init', '--pglite', '--no-embedding'], actor: 'agent', next: 'run' },
    });
  });
});
