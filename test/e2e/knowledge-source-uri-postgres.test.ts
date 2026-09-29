import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';

requirePostgresTestDatabase();

test('invalid source URI diagnostics survive managed publication on Postgres', async () => {
  const child = Bun.spawn([process.execPath, 'test', 'test/shared-skills-writer-boundary.serial.test.ts',
    '--test-name-pattern', 'unresolvable stored file aliases'], {
    cwd: join(import.meta.dir, '../..'),
    env: { ...process.env, GBRAIN_TEST_ALLOW_DATABASE_URL: '1', GBRAIN_TEST_BACKEND: 'postgres' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
    expect(stderr).toContain('1 pass');
    expect(stderr).toContain('0 fail');
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
  }
}, 140_000);
