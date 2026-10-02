import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test.each(['--help', '-h'])('actual export %s explains safe scope and recovery without a configured brain', help => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'export-help-')));
  const env: Record<string, string> = { HOME: home, GBRAIN_HOME: home };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  try {
    const child = Bun.spawnSync([process.execPath, '--no-env-file', resolve('src/cli.ts'), 'export', help], {
      cwd: home, env, stdout: 'pipe', stderr: 'pipe',
    });
    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString()).toBe('');
    const output = child.stdout.toString();
    for (const text of ['--dir', '--source', '--type', '--slug-prefix', '--restore-only', '--repo',
      'all sources', 'occupied', 'Colliding', 'nothing is overwritten', '.gbrain-export-status', 'COMPLETE',
      'fresh directory', 'not a database backup', 'docs/storage-tiering.md#safe-export']) expect(output).toContain(text);
    expect(readdirSync(home)).not.toContain('export');
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30000);
