import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..');
const CLI = join(REPO, 'src', 'cli.ts');
const scratch = mkdtempSync(join(tmpdir(), 'gbrain-hook-fastpath-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function runHook(args: string[], stdin = '') {
  return Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd: REPO,
    stdin: Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GBRAIN_HOME: scratch,
      DATABASE_URL: undefined,
      GBRAIN_DATABASE_URL: undefined,
    },
  });
}

describe('gbrain hook executable fast path', () => {
  test('entrypoint has no static edge to the legacy CLI or heavy command graph', () => {
    const source = readFileSync(CLI, 'utf8');
    const staticImports = [...source.matchAll(/^import\s+(?!type\b)[^;]+from\s+['"]([^'"]+)['"];?/gm)]
      .map((match) => match[1]);

    expect(staticImports).toEqual(['./core/cli-options.ts']);
    expect(source).toContain("await import('./commands/hook.ts')");
    expect(source).toContain("await import('./cli-main.ts')");
    expect(source).not.toMatch(/^import\s+[^;]*cli-main/m);
    expect(source).not.toMatch(/^export\s+[^;]*from\s+['"]\.\/cli-main/m);
    expect(readFileSync(join(REPO, 'package.json'), 'utf8')).toContain('"gbrain": "src/cli.ts"');
  });

  test('global flags preserve hook help and fail-open user-prompt behavior', () => {
    const help = runHook(['--quiet', 'hook', '--help']);
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain('Usage: gbrain hook <event>');
    expect(help.stdout.toString()).toContain('user-prompt');

    const prompt = runHook(
      ['--quiet', 'hook', 'user-prompt', '--harness', 'traecli'],
      JSON.stringify({ prompt: 'fast path probe', session_id: 'fast-path-test' }),
    );
    expect(prompt.exitCode).toBe(0);
    expect(prompt.stdout.toString()).toBe('');
    const heartbeat = readFileSync(
      join(scratch, '.gbrain', 'integrations', 'hooks', 'heartbeat.jsonl'),
      'utf8',
    );
    expect(heartbeat).toContain('"event":"user-prompt"');
  });

  test('cold subprocess UserPromptSubmit P95 stays below the robust 1.5s regression ceiling', () => {
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      const result = runHook(
        ['hook', 'user-prompt', '--harness', 'traecli'],
        JSON.stringify({ prompt: `latency probe ${i}`, session_id: 'fast-path-latency' }),
      );
      samples.push(performance.now() - started);
      expect(result.exitCode).toBe(0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
    console.log(`HOOK_FASTPATH_P95_MS=${p95.toFixed(1)} samples=${samples.length}`);
    // The local product target is <1s. The test ceiling leaves 50% headroom
    // for shared CI hosts while still failing the former 2.2–2.8s eager graph.
    expect(p95).toBeLessThan(1_500);
  });
});
