/**
 * `--help` must be answerable with no brain configured.
 *
 * A reader runs `--help` most often right after install, before `gbrain init`.
 * CLI_ONLY_SELF_HELP members skip the dispatcher's generic usage stub (that is
 * the point — they print their own), but they were then reached through the
 * normal dispatch, which connects the engine first. So on a machine with no
 * brain they exited 1 with "No brain configured" and their own help block was
 * unreachable code.
 *
 * The oracle here is behaviour, not a declaration: each command is actually
 * run with an empty GBRAIN_HOME.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;

/** Answer `--help` before touching the engine. */
const HELP_WITHOUT_BRAIN = [
  'models',
  'watch',
  'skillopt',
  'maintain',
  'extract-conversation-facts',
  'transcripts',
  'jobs',
  // #4152: dream answers --help (and the retriage subverb help) engine-free.
  'dream',
  // cathedral-5: runCompileContext honours help before reading the engine
  // (SELF_HELP_WITHOUT_ENGINE loader, same shape as dream/jobs).
  'compile-context',
  'sources',
  // cathedral-6: agent answers --help (incl. `register --help`) engine-free.
  'agent',
  // ZE interim cleanup: the retired ze-switch shim answers --help engine-free
  // (truthful sunset copy + the canonical migration command).
  'ze-switch',
];

/**
 * Self-help members that still need a brain for `--help`, because their handler
 * has no `--help` branch to reach. Pinned rather than omitted so the list can
 * only shrink deliberately: writing help for one of these, or dropping it from
 * CLI_ONLY_SELF_HELP so the generic stub answers, fails this test until the
 * entry moves.
 */
const STILL_NEEDS_A_BRAIN = [
  'brainstorm',
  'config',
  'embed',
  'lsd',
  'migrate',
  'pages',
  'retrieval-upgrade',
];

async function runHelp(command: string): Promise<{ code: number; out: string }> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-nobrain-'));
  // An empty GBRAIN_HOME is not enough: loadConfig also honours
  // GBRAIN_DATABASE_URL and DATABASE_URL (config.ts:550-551), so a developer
  // or CI runner that exports either would let the CLI connect anyway — the
  // positive assertions would pass on master and this guard would be inert.
  const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home };
  delete env.GBRAIN_DATABASE_URL;
  delete env.DATABASE_URL;
  // --no-env-file: bun auto-loads .env from cwd, and GBRAIN_DATABASE_URL is
  // honored unconditionally, so a developer's local .env would put back
  // exactly what the deletes above removed.
  const proc = Bun.spawn(['bun', '--no-env-file', 'run', 'src/cli.ts', command, '--help'], {
    cwd: REPO,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out: stdout + stderr };
}

describe('--help without a configured brain', () => {
  // cathedral-6: the register SUBCOMMAND help must also answer brainless —
  // the whole point of the SELF_HELP_WITHOUT_ENGINE entry is that a reader on
  // a fresh machine can discover the mint flow before they have a brain.
  test('agent register --help answers with real help', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-nobrain-'));
    const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home };
    delete env.GBRAIN_DATABASE_URL;
    delete env.DATABASE_URL;
    const proc = Bun.spawn(['bun', '--no-env-file', 'run', 'src/cli.ts', 'agent', 'register', '--help'], {
      cwd: REPO, env, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stdout + stderr).toContain('--preset daily-driver|coding-agent');
  }, 30_000);

  for (const command of HELP_WITHOUT_BRAIN) {
    test(`${command} --help answers`, async () => {
      const { code, out } = await runHelp(command);
      expect(code).toBe(0);
      expect(out).not.toContain('No brain configured');
      // Real help, not a one-line stub or an empty exit.
      expect(out.split('\n').filter(l => l.trim()).length).toBeGreaterThan(3);
      expect(out.toLowerCase()).toContain(command.split('-')[0]);
    }, 30_000);
  }

  test('the known-unfixed set is exactly what it claims', async () => {
    // Concurrently: seven sequential CLI spawns is most of this file's wall
    // clock, and each one is independent (its own temp GBRAIN_HOME).
    const results = await Promise.all(
      STILL_NEEDS_A_BRAIN.map(async command => ({ command, ...(await runHelp(command)) })),
    );
    const unexpectedlyWorking = results
      .filter(r => !r.out.includes('No brain configured'))
      .map(r => r.command);
    // Not a wish that they stay broken — a tripwire. Fixing one is good and
    // should move it to HELP_WITHOUT_BRAIN in the same change, so the coverage
    // list never drifts away from reality in either direction.
    expect(unexpectedlyWorking).toEqual([]);
  }, 90_000);
});
