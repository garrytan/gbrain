/**
 * E3 (test-gap wave 5): the interactive prompt helpers in src/core/cli-util.ts.
 *
 * Serial lane: these tests drive stdin. In-process manipulation of
 * `process.stdin` under the bun test runner is unreliable (the runner owns the
 * real stdin; the helpers reference `process.stdin` directly, so pushing
 * synthetic data/end events leaks listeners across cases), so every case runs
 * the helper in a CHILD `bun -e` process with fully controlled piped stdin.
 *
 * Reality pinned here (per the current source, do not "fix" without a decision):
 *
 *   - `promptLineStderr` resolves `null` on stdin EOF and on timeout — never
 *     the empty string. The footgun this guards: `''` is falsy, so a call site
 *     that checks truthiness instead of `=== null` conflates "user pressed
 *     Enter" (empty string) with "stdin closed / timed out" (null). Both sides
 *     of that boundary are pinned below.
 *   - `promptLine` (the stdout variant) has NO EOF handling: on a closed stdin
 *     it never resolves. Callers must TTY-gate before using it; the EOF-safe
 *     contract belongs to `promptLineStderr` alone.
 *   - Neither helper checks `isTTY` — piped (non-TTY) stdin is read normally.
 *     The TTY gate lives at call sites, not in the util.
 *   - `promptLineStderr` writes its prompt to stderr (stdout stays clean for
 *     machine output); `promptLine` writes its prompt to stdout.
 */
import { describe, test, expect } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');
const UTIL_PATH = join(REPO_ROOT, 'src', 'core', 'cli-util.ts');

function runChild(script: string, input: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('bun', ['-e', script], {
    input,
    encoding: 'utf-8',
    timeout: 15_000,
    cwd: REPO_ROOT,
  });
  if (r.error) throw r.error;
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function parseResult(stdout: string): Record<string, unknown> {
  const m = stdout.match(/__RESULT__(\{.*\})/);
  if (!m) throw new Error(`no __RESULT__ marker in child stdout: ${JSON.stringify(stdout)}`);
  return JSON.parse(m[1]);
}

function stderrPromptScript(timeoutMs: number): string {
  return `
const { promptLineStderr } = await import(${JSON.stringify(UTIL_PATH)});
const answer = await promptLineStderr('CONFIRM? ', { timeoutMs: ${timeoutMs} });
console.log('__RESULT__' + JSON.stringify({
  answer,
  isNull: answer === null,
  isEmptyString: answer === '',
  tty: process.stdin.isTTY === true,
}));
process.exit(0);
`;
}

describe('promptLineStderr', () => {
  test('EOF (stdin closes with no input) resolves null — NOT the empty string', () => {
    const r = runChild(stderrPromptScript(10_000), '');
    expect(r.status).toBe(0);
    const res = parseResult(r.stdout);
    expect(res.isNull).toBe(true);
    expect(res.isEmptyString).toBe(false);
    expect(res.answer).toBe(null);
    // The prompt goes to stderr; stdout stays clean for machine output.
    expect(r.stderr).toContain('CONFIRM? ');
    expect(r.stdout).not.toContain('CONFIRM? ');
  }, 15_000);

  test('a normal line resolves the trimmed answer, on non-TTY piped stdin (no TTY gate in the util)', () => {
    const r = runChild(stderrPromptScript(10_000), '  yes please  \n');
    expect(r.status).toBe(0);
    const res = parseResult(r.stdout);
    expect(res.answer).toBe('yes please');
    // Piped stdin is non-TTY; the helper reads it anyway — TTY gating is the
    // call sites' job, not the util's.
    expect(res.tty).toBe(false);
  }, 15_000);

  test('bare Enter resolves the empty string — distinct from EOF null (the truthiness footgun boundary)', () => {
    const r = runChild(stderrPromptScript(10_000), '\n');
    expect(r.status).toBe(0);
    const res = parseResult(r.stdout);
    expect(res.answer).toBe('');
    expect(res.isEmptyString).toBe(true);
    expect(res.isNull).toBe(false);
  }, 15_000);

  test('timeoutMs elapsing with stdin held open resolves null (the non-EOF null arm)', async () => {
    const child = spawn('bun', ['-e', stderrPromptScript(250)], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Deliberately never write to or close child.stdin: no data, no EOF —
    // only the timer can settle the promise.
    let stdout = '';
    child.stdout!.setEncoding('utf-8');
    child.stdout!.on('data', (c: string) => { stdout += c; });
    try {
      const status = await new Promise<number | null>((resolve, reject) => {
        const kill = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`child did not exit — timeout arm broken? stdout=${JSON.stringify(stdout)}`));
        }, 10_000);
        child.on('close', (code) => { clearTimeout(kill); resolve(code); });
        child.on('error', (e) => { clearTimeout(kill); reject(e); });
      });
      expect(status).toBe(0);
      const res = parseResult(stdout);
      expect(res.isNull).toBe(true);
      expect(res.answer).toBe(null);
    } finally {
      child.stdin!.end();
    }
  }, 15_000);
});

describe('promptLine', () => {
  test('a normal line resolves the trimmed answer; the prompt goes to stdout', () => {
    const script = `
const { promptLine } = await import(${JSON.stringify(UTIL_PATH)});
const answer = await promptLine('NAME> ');
console.log('__RESULT__' + JSON.stringify({ answer }));
process.exit(0);
`;
    const r = runChild(script, '  Ada Lovelace  \n');
    expect(r.status).toBe(0);
    const res = parseResult(r.stdout);
    expect(res.answer).toBe('Ada Lovelace');
    expect(r.stdout).toContain('NAME> ');
  }, 15_000);

  test('EOF reality pin: promptLine NEVER resolves on closed stdin (no end handler — callers must TTY-gate)', () => {
    // Race promptLine against a 1.5s timer on an immediately-EOF stdin. The
    // timer winning pins that promptLine has no EOF path: it would hang a
    // non-interactive caller forever. If this test ever flips to 'resolved',
    // promptLine grew EOF handling — update the contract docs and call sites.
    const script = `
const { promptLine } = await import(${JSON.stringify(UTIL_PATH)});
const winner = await Promise.race([
  promptLine('Q> ').then((v) => ({ kind: 'resolved', v })),
  new Promise((r) => setTimeout(() => r({ kind: 'hang' }), 1500)),
]);
console.log('__RESULT__' + JSON.stringify(winner));
process.exit(0);
`;
    const r = runChild(script, '');
    expect(r.status).toBe(0);
    const res = parseResult(r.stdout);
    expect(res.kind).toBe('hang');
  }, 15_000);
});
