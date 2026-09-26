import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';

requirePostgresTestDatabase();

test('shared skill persistence parity and independent crash recovery on Postgres', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-bundle-parity-e2e-'));
  const child = Bun.spawn([process.execPath, 'test', 'test/persistence-skill-bundles.serial.test.ts', 'test/persistence-skill-crash.slow.test.ts'], {
    cwd: join(import.meta.dir, '../..'), env: { ...process.env, GBRAIN_HOME: home, GBRAIN_TEST_ALLOW_DATABASE_URL: '1', GBRAIN_TEST_BACKEND: 'postgres' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 360_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    process.stdout.write(stdout); process.stderr.write(stderr);
    expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
    expect(stderr).toContain('12 pass'); expect(stderr).toContain('0 fail');
    expect(stderr).toContain('embedding claim renewal and cursor advancement retain protocol-2 fencing');
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
    rmSync(home, { recursive: true, force: true });
  }
}, 380_000);
