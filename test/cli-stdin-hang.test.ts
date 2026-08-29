/**
 * #3513: parseOpArgs' stdin read must never block forever.
 *
 * In a non-TTY with no piped input — a CI step, a cron job, an agent
 * harness that inherits a non-TTY stdin without writing to it — the old
 * inline `readFileSync(0)` never returned. The fix bounds the read with a
 * first-byte deadline (pipes/sockets only) and falls through to the
 * existing required-param usage error on timeout.
 *
 * The load-bearing regression test spawns the REAL CLI with a held-open,
 * never-written pipe: on pre-fix code it hangs until our observation window
 * kills it; on fixed code it exits 1 with the usage error well inside the
 * window. The stdin read + required-param check both run BEFORE engine
 * connect, so no brain/DB is touched.
 */
import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'path';

const REPO = dirname(import.meta.dir);
const CLI = join(REPO, 'src', 'cli.ts');

interface CliRun {
  exited: boolean;
  exitCode: number | null;
  stderr: string;
}

/** Narrow Bun's `number | FileSink` stdin union to the pipe sink. */
function pipeSink(proc: { stdin: unknown }): { write(d: string): unknown; end(): unknown } {
  const s = proc.stdin;
  if (!s || typeof s === 'number') throw new Error('expected a piped stdin sink');
  return s as { write(d: string): unknown; end(): unknown };
}

/**
 * Spawn the CLI with the given stdin wiring. `holdPipeOpen` keeps the write
 * end of the stdin pipe alive without ever writing — the #3513 repro. The
 * observation window kills the child if it hasn't exited (pre-fix hang).
 */
async function runCliWithStdin(
  args: string[],
  stdin: 'hold-open' | 'closed-empty' | { data: string } | { file: string },
  windowMs: number,
): Promise<CliRun> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], {
    cwd: REPO,
    env: { ...process.env, GBRAIN_STDIN_TIMEOUT_MS: '500' },
    stdin: typeof stdin === 'object' && 'file' in stdin ? Bun.file(stdin.file) : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (typeof stdin === 'object' && 'data' in stdin) {
    pipeSink(proc).write(stdin.data);
    await pipeSink(proc).end();
  } else if (stdin === 'closed-empty') {
    await pipeSink(proc).end();
  }
  // 'hold-open': never write, never close — the CI/cron/agent-harness shape.

  let exited = true;
  const killer = setTimeout(() => {
    exited = false;
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
  }, windowMs);
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(killer);
  try { pipeSink(proc).end(); } catch { /* hold-open cleanup */ }
  return { exited, exitCode: exited ? exitCode : null, stderr };
}

describe('#3513 — stdin-capable op with a non-TTY, never-written stdin', () => {
  test('exits fast with the usage error instead of blocking forever', async () => {
    // `put` declares stdin:'content' (required). No inline content, no piped
    // input → the bounded read times out at 500ms, content stays unset, and
    // the required-param check prints usage and exits 1. Pre-fix: readFileSync(0)
    // blocks until the 20s window kills the child.
    const run = await runCliWithStdin(['put', 'stdin-hang-test-slug'], 'hold-open', 20_000);
    expect(run.exited).toBe(true); // pre-#3513 this is false: the read never returns
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('Usage: gbrain put');
  }, 30_000);

  test('a genuine pipe with data is still consumed (no hang, no crash)', async () => {
    // Piped content fills `content`; the missing positional slug then fails
    // the required check — proving the stream path read stdin and moved on.
    const run = await runCliWithStdin(['put'], { data: '# hello\n' }, 20_000);
    expect(run.exited).toBe(true);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('Usage: gbrain put');
  }, 30_000);

  test('empty-but-real input (`< /dev/null`) does not hang', async () => {
    const run = await runCliWithStdin(['put'], { file: '/dev/null' }, 20_000);
    expect(run.exited).toBe(true);
    expect(run.exitCode).toBe(1);
  }, 30_000);

  test('an empty pipe that closes immediately does not hang', async () => {
    const run = await runCliWithStdin(['put'], 'closed-empty', 20_000);
    expect(run.exited).toBe(true);
    expect(run.exitCode).toBe(1);
  }, 30_000);
});

describe('#3513 — applyStdinParam content preservation (subprocess driver)', () => {
  // Drive the exported helper in a child process so we control the child's
  // real fd 0 — bun test's own stdin is not a reliable fixture.
  const DRIVER = `
    const { applyStdinParam } = await import(${JSON.stringify(CLI)});
    const op = { name: 'put', params: { content: { type: 'string', required: true } }, cliHints: { stdin: 'content' } };
    const params = {};
    await applyStdinParam(op, params);
    console.log(JSON.stringify(params));
    process.exit(0);
  `;

  async function runDriver(
    stdin: 'hold-open' | 'closed-empty' | { data: string } | { file: string },
  ): Promise<{ exited: boolean; params: Record<string, unknown> | null }> {
    const proc = Bun.spawn(['bun', '-e', DRIVER], {
      cwd: REPO,
      env: { ...process.env, GBRAIN_STDIN_TIMEOUT_MS: '500' },
      stdin: typeof stdin === 'object' && 'file' in stdin ? Bun.file(stdin.file) : 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (typeof stdin === 'object' && 'data' in stdin) {
      pipeSink(proc).write(stdin.data);
      await pipeSink(proc).end();
    } else if (stdin === 'closed-empty') {
      await pipeSink(proc).end();
    }
    let exited = true;
    const killer = setTimeout(() => {
      exited = false;
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
    }, 20_000);
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(killer);
    try { pipeSink(proc).end(); } catch { /* hold-open cleanup */ }
    const line = stdout.trim().split('\n').pop() ?? '';
    let params: Record<string, unknown> | null = null;
    try { params = JSON.parse(line); } catch { /* child killed before printing */ }
    return { exited, params };
  }

  test('piped data lands in the stdin param verbatim', async () => {
    const { exited, params } = await runDriver({ data: '---\ntitle: x\n---\nbody' });
    expect(exited).toBe(true);
    expect(params?.content).toBe('---\ntitle: x\n---\nbody');
  }, 30_000);

  // #2822: empty/whitespace stdin is NO input — the param stays unset so the
  // required-param usage error fires, instead of '' flowing into a
  // destructive empty write. (Pre-#2822 these pinned params.content === ''.)
  test('/dev/null leaves the stdin param unset (#2822)', async () => {
    const { exited, params } = await runDriver({ file: '/dev/null' });
    expect(exited).toBe(true);
    expect(params).toEqual({});
  }, 30_000);

  test('empty closed pipe leaves the stdin param unset (#2822)', async () => {
    const { exited, params } = await runDriver('closed-empty');
    expect(exited).toBe(true);
    expect(params).toEqual({});
  }, 30_000);

  test('whitespace-only piped input leaves the stdin param unset (#2822)', async () => {
    const { exited, params } = await runDriver({ data: '  \n\t\n' });
    expect(exited).toBe(true);
    expect(params).toEqual({});
  }, 30_000);

  test('held-open pipe times out and leaves the param unset', async () => {
    const { exited, params } = await runDriver('hold-open');
    expect(exited).toBe(true); // completes inside the window instead of hanging
    expect(params).toEqual({});
  }, 30_000);
});
