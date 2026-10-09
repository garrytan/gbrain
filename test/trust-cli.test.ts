/**
 * `gbrain trust` CLI surface (#5575: DX-7, DX-16).
 *
 * Protects: the help text of the trust noun (every owner subcommand, the
 * typed refs, "--yes never confirms") answers without a brain and is pinned
 * as a golden; an unknown subcommand prints usage and exits 2; `quarantine
 * --help` lists the release|drop aliases. Fails when a subcommand or ref
 * disappears from help or help starts needing a database.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-trust-cli-'));
const golden = join(import.meta.dir, 'fixtures/goldens/trust/help.txt');

describe('gbrain trust help (DX-7)', () => {
  test('help answers without a brain and matches the golden', async () => {
    const r = await runCli(['trust', '--help'], { home });
    expect(r.exitCode).toBe(0);
    if (process.env.GBRAIN_TEST_UPDATE_GOLDENS === '1') { mkdirSync(dirname(golden), { recursive: true }); writeFileSync(golden, r.stdout); }
    expect(r.stdout).toBe(readFileSync(golden, 'utf8'));
    for (const sub of ['review', 'confirm', 'release', 'drop', 'revert', 'explain', 'allow', 'disable']) expect(r.stdout).toContain(`  ${sub} `);
    expect(r.stdout).toContain('gbrain trust backfill');
    expect(r.stdout).toContain('--yes never confirms');
  }, 60_000);

  test('an unknown subcommand prints usage and exits 2 before touching the engine', async () => {
    const { run } = await import('../src/cli/commands/trust.ts');
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try { await run(null as never, ['promote', 'f1'], {} as never); }
    finally { console.log = log; }
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
    expect(lines.join('\n')).toContain('Usage: gbrain trust <review|confirm');
  });

  test('quarantine help lists the trust aliases', async () => {
    const r = await runCli(['quarantine', '--help'], { home });
    expect(r.stdout).toContain('release <h<id>> | drop <h<id>>');
    expect(r.stdout).toContain('Aliases of gbrain trust release|drop');
  }, 60_000);
});
