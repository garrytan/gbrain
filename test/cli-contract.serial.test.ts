/**
 * Agent contract v1 D5: the CLI contract over src/cli/command-table.ts.
 *
 * Part 1 (help): `gbrain <command> --help` for every CLI-only command, with
 * no brain configured, must exit 0, print real (non-stub) help, list only
 * curated flags when the command has a curated help module, and mention
 * `--yes` when the command parses it. Commands that do not meet the contract
 * yet are listed in a shrink-only baseline
 * (test/fixtures/cli-contract/help-baseline.json): a NEW violation fails, and
 * a baseline entry that now passes must be removed
 * (`GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/cli-contract.serial.test.ts`
 * rewrites it, refusing growth).
 *
 * Part 2 (json): every record that declares `json` has one succeeding and one
 * failing invocation here; the success prints the declared shape (one JSON
 * document, or NDJSON lines) and the failure prints a v1 envelope with `code`
 * and `suggestion` (or, exit 3, the confirmation_required payload).
 * Consent-gated exits (3) per command are pinned by
 * test/consent-table.serial.test.ts (C9).
 *
 * Serial: spawns the CLI and writes temporary GBRAIN_HOMEs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_COMMANDS } from '../src/cli/command-table.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { runCli, runCliBatch, type CliResult } from './helpers/cli-spawn.ts';

const BASELINE = join(import.meta.dir, 'fixtures', 'cli-contract', 'help-baseline.json');
const STUB = 'run gbrain --help for the full command list';

const emptyHome = mkdtempSync(join(tmpdir(), 'gbrain-cli-contract-empty-'));
const brainHome = mkdtempSync(join(tmpdir(), 'gbrain-cli-contract-brain-'));
afterAll(() => {
  rmSync(emptyHome, { recursive: true, force: true });
  rmSync(brainHome, { recursive: true, force: true });
});

/**
 * The command parses `--yes`: the generated acceptance registry lists it AND
 * the command's own module reads the literal (the registry over-approximates
 * from every module a command imports).
 */
function parsesYes(name: string): boolean {
  if (!(CLI_FLAG_REGISTRY[name] ?? []).includes('--yes')) return false;
  const src = join(import.meta.dir, '..', 'src');
  const files = [join(src, 'cli', 'commands', `${name}.ts`), join(src, 'commands', `${name}.ts`), join(src, 'commands', name, 'index.ts')];
  return files.some(f => existsSync(f) && /['"]--yes['"]/.test(readFileSync(f, 'utf8')));
}

/** The contract violations of one command's --help output. */
async function helpViolations(name: string, r: CliResult): Promise<string[]> {
  const out = `${r.stdout}\n${r.stderr}`;
  const v: string[] = [];
  if (r.exitCode !== 0) v.push('exit');
  if (out.includes(STUB) || out.split('\n').filter(l => l.trim()).length < 3) v.push('stub');
  const record = CLI_COMMANDS.find(c => c.name === name)!;
  if (record.help) {
    const curated = new Set(['--help', ...(await record.help()).help.flags.map(f => f.name)]);
    const listed = [...out.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g)].map(m => m[0]);
    if (listed.some(f => !curated.has(f))) v.push('uncurated_flag');
  }
  if (parsesYes(name) && !out.includes('--yes')) v.push('missing_yes');
  return v.map(x => `${name}:${x}`);
}

describe('D5 help contract (shrink-only baseline)', () => {
  test('every CLI-only command: --help exits 0, is not a stub, lists curated flags, shows --yes where parsed', async () => {
    const names = CLI_COMMANDS.map(c => c.name);
    const results = await runCliBatch(names.map(n => [n, '--help']), { home: emptyHome, cwd: emptyHome, width: 3, timeoutMs: 60_000 });
    const violations = (await Promise.all(names.map((n, i) => helpViolations(n, results[i])))).flat().sort();
    const baseline: string[] = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : [];
    const grown = violations.filter(v => !baseline.includes(v));
    if (process.env.GBRAIN_TEST_UPDATE_GOLDENS === '1' && (grown.length === 0 || !existsSync(BASELINE))) {
      mkdirSync(join(import.meta.dir, 'fixtures', 'cli-contract'), { recursive: true });
      writeFileSync(BASELINE, `${JSON.stringify(violations, null, 2)}\n`);
      return;
    }
    expect(grown, 'new help-contract violations (fix the help; the baseline only shrinks)').toEqual([]);
    expect(baseline.filter(b => !violations.includes(b)), 'fixed: remove these from test/fixtures/cli-contract/help-baseline.json').toEqual([]);
  }, 600_000);
});

interface JsonRow {
  ok: string[];
  fail: string[];
  /** The failing invocation runs against the keyless brain (default: an empty home). */
  failOnBrain?: boolean;
  /** The succeeding invocation runs against an empty home (default: the keyless brain). */
  okOnEmpty?: boolean;
  /** The succeeding invocation needs Postgres: the E2E file (test/e2e/…) that asserts it instead. */
  okE2E?: string;
  /** NDJSON only: zero lines is a valid success (e.g. an export of an empty table). */
  okMayBeEmpty?: true;
}

const EVAL_FIXTURES = join(import.meta.dir, 'fixtures', 'eval-baselines');
const QRELS = join(EVAL_FIXTURES, 'qrels-search.json');
const CAPTURED = join(EVAL_FIXTURES, 'captured-sample.ndjson');

/** One row per command-table record that declares `json`; a new declaration needs a row. */
const JSON_ROWS: Record<string, JsonRow> = {
  errors: { ok: ['errors', 'unknown_flag', '--json'], fail: ['errors', 'definitely_not_a_code', '--json'], okOnEmpty: true },
  init: { ok: ['init', '--pglite', '--no-embedding', '--json'], fail: ['init', '--mcp-only', '--json', '--mcp-url', 'http://127.0.0.1:1/mcp'], okOnEmpty: true },
  doctor: { ok: ['doctor', '--json', '--fast'], fail: ['doctor', '--json'] },
  sync: { ok: ['sync', '--source', 'notes', '--no-pull', '--json'], fail: ['sync', '--source', 'notes', '--json'], failOnBrain: true },
  embed: { ok: ['embed', '--stale', '--json'], fail: ['embed', '--all', '--json'], failOnBrain: true },
  'db-repair': { ok: ['db-repair', '--json'], fail: ['db-repair', '--json'], failOnBrain: true, okE2E: 'test/e2e/cli-json-commands-postgres.test.ts' },
  dream: { ok: ['dream', '--json', '--phase', 'lint'], fail: ['dream', '--json', '--phase', 'garbage'] },
  'post-upgrade': { ok: ['post-upgrade', '--json', '--no-autopilot-install'], fail: ['post-upgrade', '--bogus', '--json'], okOnEmpty: true },
  bench: { ok: ['bench', 'publish', '--from', CAPTURED, '--to', 'sample.baseline.ndjson', '--json'], fail: ['bench', 'publish', '--json'], okOnEmpty: true },
  'eval export': { ok: ['eval', 'export', '--json'], fail: ['eval', 'export', '--json', '--since', 'bogus'], failOnBrain: true, okMayBeEmpty: true },
  'eval replay': { ok: ['eval', 'replay', '--against', CAPTURED, '--json'], fail: ['eval', 'replay', '--json'], failOnBrain: true },
  'eval gate': {
    ok: ['eval', 'gate', '--qrels', QRELS, '--embedder', 'deterministic', '--threshold-recall-at-k', '0', '--threshold-first-relevant-hit', '0', '--threshold-expected-top1', '0', '--json'],
    fail: ['eval', 'gate', '--qrels', QRELS, '--embedder', 'deterministic', '--json'], failOnBrain: true,
  },
  // Lane H journey: import declares json (one document; a keyless brain's refusal is an embedding_disabled envelope).
  import: { ok: ['import', join(brainHome, 'loose'), '--no-embed', '--json'], fail: ['import', join(brainHome, 'loose'), '--json'], failOnBrain: true },
  'apply-migrations': { ok: ['apply-migrations', '--dry-run', '--json'], fail: ['apply-migrations', '--json', '--migration', '9.9.9'], failOnBrain: true },
};

function parsedShape(mode: 'document' | 'ndjson', stdout: string): unknown[] {
  if (mode === 'document') return [JSON.parse(stdout)];
  return stdout.split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l));
}

/** json-declared records, plus `<command> <sub>` for each per-subcommand declaration. */
const JSON_DECLARED: ReadonlyArray<{ name: string; mode: 'document' | 'ndjson' }> = CLI_COMMANDS.flatMap(c => c.json
  ? [{ name: c.name, mode: c.json }]
  : Object.entries(c.jsonSubcommands ?? {}).map(([sub, mode]) => ({ name: `${c.name} ${sub}`, mode })));

function assertFailureShape(name: string, mode: 'document' | 'ndjson', r: CliResult): void {
  expect(r.exitCode, `${name}: failing invocation exits non-zero`).not.toBe(0);
  const docs = parsedShape(mode, r.stdout) as Array<Record<string, unknown>>;
  const last = docs[docs.length - 1];
  if (r.exitCode === 3) {
    expect(last, `${name}: exit 3 carries the consent payload`).toMatchObject({ code: 'confirmation_required' });
    return;
  }
  expect(typeof last.code, `${name}: failure document has code`).toBe('string');
  expect(typeof last.suggestion, `${name}: failure document has suggestion`).toBe('string');
}

describe('D5 json contract: one success and one failure per json-declared command', () => {
  beforeAll(async () => {
    const init = await runCli(['init', '--pglite', '--no-embedding', '--json'], { home: brainHome, cwd: brainHome, timeoutMs: 120_000 });
    if (init.exitCode !== 0) throw new Error(`fixture init failed: ${init.stderr}`);
    const repo = join(brainHome, 'notes');
    mkdirSync(repo);
    writeFileSync(join(repo, 'example.md'), '---\ntitle: Example\n---\nHello world\n');
    const git = (args: string[]) => Bun.spawnSync(['git', '-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', ...args], { cwd: repo });
    git(['init', '-q']); git(['add', '.']); git(['commit', '-qm', 'init']);
    mkdirSync(join(brainHome, 'loose'));
    writeFileSync(join(brainHome, 'loose', 'loose-page.md'), '---\ntitle: Loose\n---\nA page outside any source repo\n');
    const add = await runCli(['sources', 'add', 'notes', '--path', repo], { home: brainHome, cwd: brainHome, timeoutMs: 60_000 });
    if (add.exitCode !== 0) throw new Error(`fixture sources add failed: ${add.stderr}`);
  }, 240_000);

  test('every json-declared record has a contract row', () => {
    const declared = JSON_DECLARED.map(c => c.name).sort();
    expect(declared).toEqual(Object.keys(JSON_ROWS).sort());
  });

  for (const record of JSON_DECLARED) {
    test(`${record.name} --json: success shape and failure envelope`, async () => {
      const row = JSON_ROWS[record.name];
      if (!row) throw new Error(`no D5 row for json-declared command ${record.name}`);
      const fresh = mkdtempSync(join(tmpdir(), 'gbrain-cli-contract-ok-'));
      try {
        const okHome = row.okOnEmpty ? fresh : brainHome;
        if (row.okE2E) {
          expect(existsSync(join(import.meta.dir, '..', row.okE2E)), `${record.name}: ${row.okE2E} covers the success shape`).toBe(true);
        } else {
          const ok = await runCli(row.ok, { home: okHome, cwd: okHome, timeoutMs: 120_000 });
          expect(ok.exitCode, `${record.name} ok: ${ok.stderr.slice(-800)}`).toBe(0);
          const lines = parsedShape(record.mode, ok.stdout).length;
          if (!row.okMayBeEmpty) expect(lines).toBeGreaterThan(0);
        }
        const failHome = row.failOnBrain ? brainHome : emptyHome;
        assertFailureShape(record.name, record.mode, await runCli(row.fail, { home: failHome, cwd: failHome, timeoutMs: 120_000 }));
      } finally {
        rmSync(fresh, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
