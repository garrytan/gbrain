import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('3,600-page CLI reindex commits, survives interruption, and resumes without partial projections', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'gbrain-reindex-regression-'));
  const checkout = resolve(import.meta.dir, '..');
  const proc = Bun.spawn([
    process.execPath, '--no-env-file', join(checkout, 'scripts/bench-reindex-markdown.ts'), checkout, '3600', '1',
  ], {
    cwd: scratch,
    env: { PATH: process.env.PATH ?? '', HOME: scratch, TMPDIR: scratch },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  console.log(stdout);
  if (exitCode !== 0) console.error(stderr);
  expect(exitCode).toBe(0);
  const summaries = stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(summaries.find(row => row.name === 'sweep')?.pageTransactions).toBe(3600);
  expect(summaries.find(row => row.name === 'resume')?.pageTransactions).toBe(3500);
  rmSync(scratch, { recursive: true, force: true });
}, 660_000);
