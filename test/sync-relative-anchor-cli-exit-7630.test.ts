/**
 * #7630 through the real CLI: `gbrain sync --source default` run from an unrelated folder, on a brain whose default source
 * has the relative local_path ".", exits 3 (stop and ask the user) with `sync_anchor_relative` and leaves the folder alone.
 *
 * /ship coverage audit (GBRA-207, #7630).
 * Value: protects=the CLI exit 3 contract (stop and ask the user) for sync_anchor_relative, and that the folder gets no .git;
 *   fails_when=the registry entry loses exit 3 or the CLI maps the refusal to exit 1, so an agent retries instead of asking;
 *   why_new=sync-relative-anchor-refusal-7630 catches the thrown error in-process and never reads the CLI exit; seam=none;
 *   no_claim=Postgres (PGLite only) and the --all fan-out exit (exit 1, covered in-process)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';

let home: string;
let folder: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-7630-cli-home-'));
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-7630-cli-unrelated-')));
  writeFileSync(join(folder, 'notes.md'), '---\ntype: note\ntitle: Notes\n---\n\nA note that is not part of any brain.\n');
  const init = await runCli(['init', '--pglite', '--no-embedding', '--json'], { home, cwd: home, timeoutMs: 110_000 });
  expect(init.exitCode, init.stderr).toBe(0);
  await withEnv({ HOME: home, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') });
    try {
      await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
        await tx.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      });
      await engine.unsetConfig('sync.repo_path');
    } finally {
      await engine.disconnect();
    }
  });
}, 120_000);

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('#7630 CLI: a relative stored anchor', () => {
  test('gbrain sync --source default from an unrelated folder exits 3 sync_anchor_relative and creates no .git', async () => {
    const r = await runCli(['sync', '--source', 'default', '--no-pull', '--no-embed'], { home, cwd: folder, timeoutMs: 110_000 });
    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(3);
    expect(`${r.stdout}\n${r.stderr}`).toContain('sync_anchor_relative');
    expect(existsSync(join(folder, '.git'))).toBe(false);
  }, 120_000);
});
