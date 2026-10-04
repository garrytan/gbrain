/**
 * A3/D4 closeout: invocations that used to `throw new Error('Usage: …')` (and
 * `sources harden` with no id, which surfaced as internal_error) are
 * invalid_params caller mistakes: exit 2, the usage and an example in the
 * suggestion, legacy JSON keys kept where the command had a JSON shape.
 *
 * Serial: real CLI subprocesses against one temp PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gb } from './helpers/agent-journey.ts';

function lastJson(stdout: string): Record<string, any> {
  const t = stdout.trim();
  try { return JSON.parse(t); } catch { return JSON.parse(t.split('\n').filter(Boolean).at(-1)!); }
}

describe('usage mistakes exit 2 with the usage and an example', () => {
  let home = '';
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-usage-errors-'));
    expect((await gb(home, ['init', '--pglite', '--no-embedding', '--json'], { timeoutMs: 120_000 })).exitCode).toBe(0);
  }, 150_000);
  afterAll(() => { rmSync(home, { recursive: true, force: true }); });

  const rows: Array<{ args: string[]; legacy?: Record<string, unknown> }> = [
    { args: ['sources', 'harden', '--json'] },
    { args: ['migrate', '--json'] },
    { args: ['mcp', 'grant'], legacy: { status: 'error', reason: 'invalid_params' } },
    { args: ['backup', 'create', '--json'], legacy: { ok: false, reason: 'invalid_params' } },
    { args: ['backup', 'restore', '--json'], legacy: { ok: false, reason: 'invalid_params' } },
  ];

  for (const row of rows) {
    test(`gbrain ${row.args.join(' ')}`, async () => {
      const r = await gb(home, row.args);
      expect(r.exitCode, r.stderr.slice(-1500)).toBe(2);
      const doc = lastJson(r.stdout);
      expect(doc).toMatchObject({ error: 'invalid_params', code: 'invalid_params', class: 'caller', contract_version: 1, ...(row.legacy ?? {}) });
      expect(doc.suggestion).toContain('Usage: gbrain ');
      expect(doc.suggestion).toContain('Example: gbrain ');
      expect(r.stderr).toContain('Error [invalid_params]');
      expect(r.stderr).not.toContain('internal_error');
    }, 60_000);
  }

  test('human sources harden prints the usage on the Fix line', async () => {
    const r = await gb(home, ['sources', 'harden']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Fix: Usage: gbrain sources harden <id|--all>');
  }, 60_000);
});
