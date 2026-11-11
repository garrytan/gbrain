/**
 * A keyless PGLite init ends with "More: bulk-load notes \`gbrain import <dir>\`".
 * On a brain initialized with --no-embedding that printed command must work as
 * written instead of refusing with embedding_disabled.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

let initOut = '';
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-init-keyless-hint-'));
  const init = await cli(['init', '--pglite', '--no-embedding']);
  expect(init.code, init.stderr).toBe(0);
  initOut = init.stdout;
}, 120_000);
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

describe('keyless init bulk-load hint', () => {
  test('the printed import command succeeds on the keyless brain', async () => {
    const hint = initOut.match(/bulk-load notes \`([^\`]+)\`/);
    expect(hint, initOut).not.toBeNull();
    const notes = join(home, 'notes');
    mkdirSync(notes);
    writeFileSync(join(notes, 'alice.md'), '---\ntitle: Alice\ntype: person\n---\nAlice is an engineer.\n');
    const argv = hint![1].split(/\s+/).map(a => (a === '<dir>' ? notes : a));
    expect(argv[0]).toBe('gbrain');
    const run = await cli(argv.slice(1));
    expect(run.code, run.stdout + run.stderr).toBe(0);
  }, 120_000);
});
