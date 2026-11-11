/**
 * revision_required / revision_conflict: the envelope's fix command says it
 * "reads the current page and its revision". Running that exact command must
 * print the revision, so the caller can resubmit with --expected-revision.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '../src/cli.ts');
let home: string;

async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, '--no-env-file', CLI, ...args], {
    cwd: home, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    env: { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, GBRAIN_DISABLE_UPDATE_CHECK: '1', GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0' },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-revision-fix-'));
  const init = await cli(['init', '--pglite', '--no-embedding']);
  expect(init.code, init.stderr).toBe(0);
}, 120_000);
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

describe('revision_required fix command', () => {
  test('the fix command prints the revision a retry needs, and the retry succeeds', async () => {
    writeFileSync(join(home, 'v1.md'), '---\ntitle: Bob\n---\nBob v1\n');
    writeFileSync(join(home, 'v2.md'), '---\ntitle: Bob\n---\nBob v2\n');
    expect((await cli(['put', 'notes/bob', '--file', join(home, 'v1.md')])).code).toBe(0);

    const refused = await cli(['put', 'notes/bob', '--file', join(home, 'v2.md'), '--json']);
    expect(refused.code).not.toBe(0);
    const envelope = JSON.parse(refused.stdout);
    expect(envelope.code).toBe('revision_required');
    const argv: string[] = envelope.fix.argv;
    expect(argv[0]).toBe('gbrain');

    const read = await cli(['get', 'notes/bob', '--json']);
    const revision: string = JSON.parse(read.stdout).revision;
    expect(typeof revision).toBe('string');

    const fix = await cli(argv.slice(1));
    expect(fix.code, fix.stderr).toBe(0);
    expect(fix.stdout + fix.stderr).toContain(revision);

    const retry = await cli(['put', 'notes/bob', '--file', join(home, 'v2.md'), '--expected-revision', revision]);
    expect(retry.code, retry.stderr).toBe(0);
  }, 120_000);
});
