/**
 * Refactor wave 1 W0 (A16b): CLI help / tools-json / unknown-command goldens.
 *
 * Protects: the public CLI surface a script or agent parses: `gbrain --help`
 * text, `--version`, `--tools-json` bytes, the unknown-command and
 * unknown-flag exit codes and messages, and where `--help` is answered
 * (op help, alias help, the generic CLI-only stub, an unknown verb).
 * Fails when: W4's command table changes help text, drops an alias, answers
 * `--help` from a different branch, or changes an exit code.
 * Why new: no test pins these outputs byte for byte; W4 replaces the code
 * that produces all of them. Seam: none (real `src/cli.ts` subprocesses in
 * an empty temp home, so nothing reads the operator's brain).
 *
 * Normalizers: `cli-help-v1` scrubs the temp home, ANSI, timestamps, UUIDs
 * and the release version (asserted separately against package.json);
 * `cli-tools-json-v1` pins the exact stdout bytes by sha256 and keeps the
 * parsed catalog for a reviewable diff. Both are proven stable by capturing
 * twice (expectNormalizerStable). Regenerate: GBRAIN_TEST_UPDATE_GOLDENS=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCliBatch, type CliResult } from './helpers/cli-spawn.ts';
import { defineNormalizer, expectGolden, expectNormalizerStable, sha256 } from './helpers/golden.ts';
import { PACKAGE_VERSION, normalizeCliResult } from './helpers/cli-golden-normalize.ts';

const ROWS: string[][] = [
  [],
  ['--help'],
  ['-h'],
  ['--version'],
  ['version'],
  ['definitely-not-a-command'],
  ['definitely-not-a-command', '--help'],
  ['ask', '--help'],
  ['link-add', '--help'],
  ['lint', '--help'],
  ['lint', '--definitely-not-a-flag'],
  ['get'],
];
const TOOLS_JSON = ['--tools-json'];

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-cli-goldens-'));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function capture(): Promise<CliResult[]> {
  return runCliBatch([...ROWS, TOOLS_JSON], { home, env: { GBRAIN_REMOTE_CLIENT_SECRET: undefined } });
}

const helpNormalizer = defineNormalizer('cli-help-v1', (results: CliResult[]) =>
  ROWS.map((argv, i) => ({ argv: argv.join(' '), ...normalizeCliResult(results[i]!, home) })),
);

const toolsJsonNormalizer = defineNormalizer('cli-tools-json-v1', (results: CliResult[]) => {
  const r = results[ROWS.length]!;
  const tools = JSON.parse(r.stdout) as Array<{ name: string }>;
  return {
    exitCode: r.exitCode,
    stderr: r.stderr,
    stdoutBytes: Buffer.byteLength(r.stdout),
    stdoutSha256: sha256(r.stdout),
    toolNames: tools.map((t) => t.name),
    tools,
  };
});

describe('A16b CLI goldens', () => {
  let results: CliResult[];

  beforeAll(async () => {
    results = await expectNormalizerStable(capture, helpNormalizer);
    const second = await capture();
    expect(JSON.stringify(toolsJsonNormalizer.apply(second))).toBe(JSON.stringify(toolsJsonNormalizer.apply(results)));
  }, 180_000);

  test('help, version, unknown command and --help placement match the golden', () => {
    expectGolden('cli/help-and-errors', results, helpNormalizer);
  });

  test('--tools-json bytes match the golden', () => {
    expectGolden('cli/tools-json', results, toolsJsonNormalizer);
  });

  test('the scrubbed version is exactly package.json version', () => {
    const byArgv = new Map(ROWS.map((argv, i) => [argv.join(' '), results[i]!]));
    expect(byArgv.get('--version')!.stdout).toBe(`gbrain ${PACKAGE_VERSION}\n`);
    expect(byArgv.get('--help')!.stdout.startsWith(`gbrain ${PACKAGE_VERSION} -- `)).toBe(true);
  });
});
