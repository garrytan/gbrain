/**
 * Refactor wave 1 W0 (A16b): thin-client refusal matrix for every
 * handleCliOnly switch case, plus the per-subcommand routing rows.
 *
 * Protects: what each CLI-only command does on a thin-client install (a
 * config with `remote_mcp`): refuse with its pinpoint hint, route over MCP,
 * answer engine-free, or fall through to connectEngine and fail. The routing
 * rows pin the route-then-refuse split (takes/cache/quarantine/jobs/search)
 * and the pre-connect subcommand rules (sources, capture, forget, call,
 * agent register, eval whoknows, doctor, status).
 * Fails when: W4's command table loses a refusal (a command runs locally
 * against a remote brain), routes a host-bound subcommand, changes a hint or
 * exit code, or moves a check across the connectEngine terminator.
 * Why new: test/cli-dispatch-thin-client.test.ts asserts refusal for a
 * hand-picked subset by substring; nothing pins all 62 cases or the full
 * text. Seam: none.
 *
 * Nothing leaves the machine: issuer and MCP URLs point at 127.0.0.1:1
 * (connection refused), the config has no database_url, and the home is a
 * fresh temp dir. Spawns go through runCliBatch at width 2.
 *
 * Normalizer `cli-thin-client-v1` scrubs the temp home, ANSI, timestamps,
 * request UUIDs and the release version. In-test stability proof captures
 * the volatile rows (timestamp, UUID) twice; the full matrix's two-capture
 * receipt is recorded in the W0 PR body. Regenerate: GBRAIN_TEST_UPDATE_GOLDENS=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCliBatch, type CliResult } from './helpers/cli-spawn.ts';
import { defineNormalizer, expectGolden, expectNormalizerStable } from './helpers/golden.ts';
import { normalizeCliResult } from './helpers/cli-golden-normalize.ts';
import { extractCliDispatch } from './helpers/cli-dispatch-extract.ts';

const CASES = extractCliDispatch().switchCases;

const ROUTING_ROWS: string[][] = [
  ['takes', 'list'],
  ['takes', 'extract'],
  ['takes', 'add', 'alice-example'],
  ['cache', 'stats'],
  ['cache', 'clear'],
  ['quarantine', 'list'],
  ['quarantine', 'scan'],
  ['jobs', 'list'],
  ['jobs', 'get', '1'],
  ['jobs', 'stats'],
  ['jobs', 'work'],
  ['search', 'modes'],
  ['search', 'diagnose', 'q'],
  ['sources', 'list'],
  ['sources', 'add', 'alice-example'],
  ['capture', 'hello'],
  ['forget', 'fact-1'],
  ['call', 'get_page'],
  ['agent', 'register', 'alice-example'],
  ['eval', 'whoknows'],
  ['doctor'],
  ['think', 'q'],
  ['recall', 'q'],
  ['query', 'q'],
  ['get', 'alice-example'],
];

const VOLATILE_ROWS: string[][] = [['status'], ['capture', 'hello']];

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-thin-matrix-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'postgres',
    remote_mcp: {
      issuer_url: 'http://127.0.0.1:1',
      mcp_url: 'http://127.0.0.1:1/mcp',
      oauth_client_id: 'cid',
      oauth_client_secret: 'csecret',
    },
  }, null, 2));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(rows: string[][]): Promise<CliResult[]> {
  return runCliBatch(rows, { home, env: { GBRAIN_REMOTE_CLIENT_SECRET: undefined }, timeoutMs: 60_000 });
}

function normalizerFor(rows: string[][]) {
  return defineNormalizer('cli-thin-client-v1', (results: CliResult[]) =>
    rows.map((argv, i) => ({ argv: argv.join(' '), ...normalizeCliResult(results[i]!, home) })),
  );
}

describe('A16b thin-client refusal matrix', () => {
  let cases: CliResult[];
  let routing: CliResult[];

  beforeAll(async () => {
    cases = await run(CASES.map((c) => [c]));
    routing = await run(ROUTING_ROWS);
  }, 300_000);

  test('the matrix covers all 62 handleCliOnly cases', () => {
    expect(CASES.length).toBe(62);
  });

  test('every handleCliOnly case, run bare on a thin client, matches the golden', () => {
    expectGolden('cli/thin-client-cases', cases, normalizerFor(CASES.map((c) => [c])));
  });

  test('subcommand routing rows match the golden', () => {
    expectGolden('cli/thin-client-routing', routing, normalizerFor(ROUTING_ROWS));
  });

  test('the normalizer is stable over the rows with timestamps and request ids', async () => {
    await expectNormalizerStable(() => run(VOLATILE_ROWS), normalizerFor(VOLATILE_ROWS));
  }, 120_000);

  test('no scratch store was created in the thin-client home', () => {
    expect(readdirSync(join(home, '.gbrain')).filter((f) => /pglite|brain\.db/i.test(f))).toEqual([]);
  });
});
