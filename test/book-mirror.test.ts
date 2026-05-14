/**
 * Tests for src/commands/book-mirror.ts — flagship v0.25.1 CLI.
 *
 * Pure surface tests. The full subagent-fan-out integration path
 * needs a live queue engine + ANTHROPIC_API_KEY and is exercised by
 * the opt-in smoke test (test/e2e/skill-smoke-openclaw.test.ts when
 * EVALS=1 EVALS_TIER=skills is set).
 *
 * Constraint: src/cli.ts dispatches connectEngine() BEFORE any
 * CLI_ONLY command's own arg parsing, including --help. This is a
 * pre-existing architectural choice (every CLI_ONLY command —
 * agent, sync, jobs, book-mirror — behaves the same). So we can't
 * exercise help-text or arg-validation paths from a clean tempdir
 * without DATABASE_URL.
 *
 * What we DO test:
 *   - The book-mirror command is registered (CLI dispatches it
 *     instead of "Unknown command").
 *   - Without DB, the command fails fast and never reaches the
 *     queue-submission path.
 *   - The command source file is parseable + exports the runner.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

async function runCli(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exit: number;
}> {
  // v0.34.0 (#876): set GBRAIN_HOME to a fresh tempdir so the test isn't
  // sensitive to the developer's local ~/.gbrain/config.json. Pre-fix this
  // test would silently inherit the user's database_url and try to connect
  // to a real Postgres + run migrations, which both extends runtime past
  // the default test timeout and produces different exit semantics
  // depending on the local DB state. With GBRAIN_HOME pointing at an
  // empty dir, the CLI hits "No brain configured" and exits 1 immediately
  // — which is what this test was originally written to cover.
  const tmpHome = await import('os').then(os =>
    import('fs').then(fs => fs.mkdtempSync(`${os.tmpdir()}/gbrain-test-`)),
  );
  try {
    const proc = Bun.spawn(
      ['bun', 'run', 'src/cli.ts', 'book-mirror', ...args],
      {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, DATABASE_URL: '', GBRAIN_HOME: tmpHome },
      },
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    return { stdout, stderr, exit };
  } finally {
    const fs = await import('fs');
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

describe('gbrain book-mirror — CLI registration', () => {
  // v0.34.0 (#876): migrations v55-v60 added oauth_clients.source_id +
  // federated_read FK plumbing. The cold-spawned subprocess's initSchema
  // chain now takes ~1s longer end-to-end; bump these tests' timeout to
  // 30s so the test-harness budget covers Bun cold-start + PGLite init +
  // migration apply + Postgres-retry exhaustion. The CLI itself still
  // exits in 7-10s on a misconfigured DB.
  it('book-mirror is in CLI_ONLY (does not get "Unknown command")', async () => {
    const { stderr } = await runCli([]);
    // Without DB, the command will fail — but on the connect path,
    // not as "Unknown command". This proves dispatch reached
    // handleCliOnly's switch statement.
    expect(stderr).not.toContain('Unknown command');
  }, 30000);

  it('without DB, never reaches queue submission', async () => {
    const { stderr, exit } = await runCli(['--slug', 'noop']);
    expect(exit).not.toBe(0);
    expect(stderr).not.toContain('submitted:');
  }, 30000);
});

describe('gbrain book-mirror — source file invariants', () => {
  const source = readFileSync(
    join(REPO_ROOT, 'src/commands/book-mirror.ts'),
    'utf-8',
  );

  it('exports runBookMirrorCmd', () => {
    expect(source).toContain('export async function runBookMirrorCmd');
  });

  it('documents the trust contract (codex HIGH-1 fix is in the file)', () => {
    // codex HIGH-1 fix: the trust contract narrowing must not silently
    // regress in a refactor.
    expect(source).toContain('media/books/');
    expect(source).toContain('codex HIGH-1');
  });

  it('uses read-only allowed_tools for subagent fan-out (codex HIGH-1)', () => {
    // The trust narrowing actually happens at the tool-allowlist layer:
    // subagents get ['get_page', 'search'] — read-only — so they CANNOT
    // call put_page regardless of slug-prefix scope.
    expect(source).toContain("allowed_tools: ['get_page', 'search']");
  });

  it('writes via operator-trust put_page (handler takes the operator-context shape)', () => {
    // The CLI is the trusted writer; subagents never call put_page.
    // The contextual marker is "remote: false" — operator-trust path.
    expect(source).toContain('putPageOp.handler');
    expect(source).toContain('remote: false');
    // And the file documents the intentional omission of viaSubagent
    // / allowedSlugPrefixes via inline comments — those phrases are
    // a regression-detector for someone trying to "fix" the trust
    // contract by adding the wrong fields.
    expect(source).toContain('viaSubagent intentionally omitted');
  });

  it('prints a cost-estimate confirmation before launching (P1)', () => {
    expect(source).toContain('estimateCost');
    expect(source).toContain('confirmInteractive');
  });

  it('uses idempotency keys for child jobs (retry-friendly)', () => {
    // Re-running the CLI on the same input should dedupe completed
    // chapters at the queue layer.
    expect(source).toContain('idempotency_key');
    expect(source).toContain('book-mirror:');
  });

  it('handles partial-failure (continues + flags failed chapters)', () => {
    // The plan said: assemble with completed chapters + a failed-list
    // section. Don't abort the whole run on one chapter failure.
    expect(source).toContain('Failed chapters');
    expect(source).toContain('chapters_failed');
  });
});
