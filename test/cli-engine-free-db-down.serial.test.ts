/**
 * Refactor wave 1 W0 (EO5 / T-G6): engine-free commands with the database down.
 *
 * Protects: the DB-down contract. `engine status`, `db-repair`,
 * `pglite-repair`, `bootstrap`, `hook`, `backup` help and
 * `config set database_url` must answer without connecting (they are how a
 * user or agent repairs a dead database), and engine-bound commands (`status`,
 * `backup status`, `config get`) must fail with master's exit code and first
 * line (the GBRAIN_DB_ACCESS marker).
 * Fails when: W4's command table gives an engine-free command a post-connect
 * phase (it would connect first and die), or changes an exit code or the
 * first output line.
 * Why new: db-repair.serial.test.ts and engine-status.test.ts drive the
 * handlers in-process; nothing pins the dispatcher's phase for these commands
 * end to end. Seam: none.
 *
 * Every row gets its own fresh temp home (db-repair appends receipts, hook
 * writes a heartbeat), so rows never see each other's side effects. The
 * database is `postgresql://nobody@127.0.0.1:1/none` (connection refused,
 * nothing leaves the machine), set either in config.json or via DATABASE_URL.
 * Serial lane: spawns CLIs with a DATABASE_URL override (docs/TESTING.md).
 *
 * Normalizer `cli-db-down-v1`: exit code, first non-empty stdout/stderr line
 * (the EO5 contract) and the full output lines, scrubbed of the temp home,
 * ANSI, timestamps, durations, UUIDs and the release version. Proven stable by capturing
 * twice. Regenerate: GBRAIN_TEST_UPDATE_GOLDENS=1.
 */
import { afterAll, describe, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCli, type CliResult } from './helpers/cli-spawn.ts';
import { defineNormalizer, expectGolden, expectNormalizerStable } from './helpers/golden.ts';
import { firstLine, normalizeCliResult } from './helpers/cli-golden-normalize.ts';

const DEAD_URL = 'postgresql://nobody@127.0.0.1:1/none';

interface Row {
  argv: string[];
  /** Where the dead URL comes from. */
  url: 'config' | 'env';
}

const ROWS: Row[] = [
  { argv: ['engine', 'status'], url: 'config' },
  { argv: ['engine', 'status', '--json'], url: 'config' },
  { argv: ['engine', 'status', '--probe'], url: 'config' },
  { argv: ['engine', 'status', '--probe', '--json'], url: 'config' },
  { argv: ['engine', 'status'], url: 'env' },
  { argv: ['db-repair'], url: 'config' },
  { argv: ['db-repair', '--json'], url: 'config' },
  { argv: ['db-repair'], url: 'env' },
  { argv: ['pglite-repair'], url: 'config' },
  { argv: ['bootstrap'], url: 'config' },
  { argv: ['hook'], url: 'config' },
  { argv: ['hook', 'session-start'], url: 'config' },
  { argv: ['backup'], url: 'config' },
  { argv: ['config', 'set', 'database_url', 'postgresql://nobody@127.0.0.1:2/none'], url: 'config' },
  { argv: ['status'], url: 'config' },
  { argv: ['backup', 'status'], url: 'config' },
  { argv: ['config', 'get', 'database_url'], url: 'config' },
];

const homes: string[] = [];

afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

interface Captured { row: Row; home: string; result: CliResult }

async function runRow(row: Row): Promise<Captured> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-db-down-'));
  homes.push(home);
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify(row.url === 'config' ? { engine: 'postgres', database_url: DEAD_URL } : { engine: 'postgres' }, null, 2),
  );
  const env = row.url === 'env' ? { DATABASE_URL: DEAD_URL } : {};
  const result = await runCli(row.argv, { home, env: { ...env, GBRAIN_REMOTE_CLIENT_SECRET: undefined }, timeoutMs: 60_000 });
  return { row, home, result };
}

/** Width-2 pool with one fresh home per row. */
async function capture(): Promise<Captured[]> {
  const out: Captured[] = new Array(ROWS.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < ROWS.length; i = next++) out[i] = await runRow(ROWS[i]!);
  };
  await Promise.all([worker(), worker()]);
  return out;
}

const normalizer = defineNormalizer('cli-db-down-v1', (captured: Captured[]) =>
  captured.map(({ row, home, result }) => {
    const full = normalizeCliResult(result, home, { durations: true });
    return {
      argv: row.argv.join(' '),
      url: row.url,
      exitCode: result.exitCode,
      stdoutFirstLine: firstLine(full.stdout.join('\n')),
      stderrFirstLine: firstLine(full.stderr.join('\n')),
      stdout: full.stdout,
      stderr: full.stderr,
    };
  }),
);

describe('EO5 engine-free commands with an unreachable database', () => {
  test('exit codes and first output lines match master', async () => {
    const captured = await expectNormalizerStable(capture, normalizer);
    expectGolden('cli/engine-free-db-down', captured, normalizer);
  }, 240_000);
});
