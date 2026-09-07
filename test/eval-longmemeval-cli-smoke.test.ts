/**
 * Subprocess smoke: the documented `gbrain eval longmemeval` invocation runs
 * end-to-end through the real CLI (pre-dispatch flag validator included).
 *
 * Invariant: `gbrain eval longmemeval <fixture> --retrieval-only --by-type
 * --no-trajectory --keyword-only --output <tmp>` exits 0 and writes a
 * `by_type_summary` line. Pre-fix the flag registry attributed longmemeval's
 * flags to the `dream` row, so this exact command exited 1 with
 * "unknown flag --retrieval-only for 'gbrain eval'" before any eval code ran.
 *
 * Hermetic: --keyword-only imports with noEmbed and searches keyword-only, so
 * no embedding provider / API key is touched; the eval brings its own
 * in-memory PGLite; GBRAIN_HOME points at an empty tmp dir so no user brain or
 * config is read.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO = process.cwd();
const CLI = join(REPO, 'src', 'cli.ts');
const FIXTURE = join(REPO, 'test', 'fixtures', 'longmemeval-mini.jsonl');

let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'gbrain-lme-cli-smoke-')); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

function run(args: string[]) {
  return spawnSync('bun', [CLI, ...args], {
    cwd: REPO,
    encoding: 'utf-8',
    timeout: 180_000,
    env: {
      ...process.env,
      GBRAIN_HOME: join(tmp, 'home'),
      GBRAIN_SKIP_STARTUP_HOOKS: '1',
      GBRAIN_QUIET: '1',
    },
  });
}

describe('gbrain eval longmemeval — documented invocation end-to-end', () => {
  test('--retrieval-only --by-type --no-trajectory --keyword-only exits 0 and emits by_type_summary', () => {
    const out = join(tmp, 'out.jsonl');
    const r = run([
      'eval', 'longmemeval', FIXTURE,
      '--retrieval-only', '--by-type', '--no-trajectory', '--keyword-only',
      '--output', out,
    ]);
    const diag = `status=${r.status}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`;
    expect(r.stderr, diag).not.toContain('unknown flag');
    expect(r.status, diag).toBe(0);
    expect(existsSync(out), diag).toBe(true);
    const lines = readFileSync(out, 'utf-8').split('\n').filter(l => l.trim());
    const summaryLines = lines.filter(l => {
      try { return JSON.parse(l).kind === 'by_type_summary'; } catch { return false; }
    });
    expect(summaryLines.length, diag).toBe(1);
    // Emitted as the FINAL line (emitByTypeSummary contract).
    expect(JSON.parse(lines[lines.length - 1]).kind).toBe('by_type_summary');
    const summary = JSON.parse(summaryLines[0]);
    expect(summary.schema_version).toBe(2);
    expect(Object.keys(summary.recall_by_type).length).toBeGreaterThan(0);
    // 5 fixture questions → 5 per-question rows + 1 summary.
    expect(lines.length).toBe(6);
  }, 180_000);

  test('a typo is still refused by the validator before any eval code runs', () => {
    const r = run(['eval', 'longmemeval', FIXTURE, '--retrieval-only', '--frobnicate']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown flag --frobnicate for 'gbrain eval'");
    expect(r.stderr).not.toContain('[longmemeval]');
  }, 60_000);
});
