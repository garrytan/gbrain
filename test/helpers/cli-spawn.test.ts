/**
 * Unit tests for cli-spawn.ts via the `_setSpawnTarget` seam: children are
 * `bun -e <script>` fixtures (~50ms each), never the real CLI, so the whole
 * file stays under ~5s. Pins: batch width cap, input-order results, memo
 * identity, timeout reaping, env hermeticity.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './with-env.ts';
import {
  runCli,
  runCliBatch,
  runCliMemo,
  clearCliMemo,
  _setSpawnTarget,
} from './cli-spawn.ts';

beforeEach(() => {
  // Children become `bun -e <argv[0]>` — process.execPath is bun under bun test.
  _setSpawnTarget([process.execPath, '-e']);
});

afterEach(() => {
  _setSpawnTarget(null);
  clearCliMemo();
});

describe('runCli', () => {
  test('captures stdout, stderr, and exit code', async () => {
    // exitCode (not process.exit) so pipe output can't be truncated mid-flush.
    const r = await runCli([
      `console.log('out'); console.error('err'); process.exitCode = 3;`,
    ]);
    expect(r.stdout.trim()).toBe('out');
    expect(r.stderr.trim()).toBe('err');
    expect(r.exitCode).toBe(3);
  });

  test('timeout kills the child and still resolves', async () => {
    const t0 = Date.now();
    const r = await runCli(
      [`setTimeout(() => console.log('late'), 8000);`],
      { timeoutMs: 300 },
    );
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain('late');
  });

  test('hermetic env: DATABASE_URL / GBRAIN_DATABASE_URL stripped, startup hooks skipped', async () => {
    await withEnv(
      { DATABASE_URL: 'postgres://leak', GBRAIN_DATABASE_URL: 'postgres://leak2' },
      async () => {
        const r = await runCli([
          `console.log([process.env.DATABASE_URL, process.env.GBRAIN_DATABASE_URL, process.env.GBRAIN_SKIP_STARTUP_HOOKS].map(v => v ?? 'unset').join('|'));`,
        ]);
        expect(r.exitCode).toBe(0);
        expect(r.stdout.trim()).toBe('unset|unset|1');
      },
    );
  });

  test('opts.home sets HOME and GBRAIN_HOME; opts.env undefined deletes a key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-cli-spawn-home-'));
    try {
      const r = await runCli(
        [`console.log([process.env.HOME, process.env.GBRAIN_HOME].join('|'));`],
        { home },
      );
      expect(r.stdout.trim()).toBe(`${home}|${home}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }

    await withEnv({ GBRAIN_CLI_SPAWN_TEST_VAR: 'ambient' }, async () => {
      const r = await runCli(
        [`console.log(process.env.GBRAIN_CLI_SPAWN_TEST_VAR ?? 'unset');`],
        { env: { GBRAIN_CLI_SPAWN_TEST_VAR: undefined } },
      );
      expect(r.stdout.trim()).toBe('unset');
    });
  });
});

describe('runCliBatch', () => {
  test('results preserve input order even when completion order inverts', async () => {
    const script = (idx: number, ms: number) =>
      `setTimeout(() => console.log('idx-${idx}'), ${ms});`;
    const results = await runCliBatch(
      [[script(0, 120)], [script(1, 10)], [script(2, 10)]],
      { width: 3 },
    );
    expect(results.map(r => r.stdout.trim())).toEqual(['idx-0', 'idx-1', 'idx-2']);
  });

  test('width cap: never more than `width` children in flight', async () => {
    // Each child reports its own start/end wall-clock (one clock domain);
    // peak interval overlap is the true simultaneity, immune to pool timing.
    const argvs = [0, 1, 2, 3].map(i => [
      `const s = Date.now(); setTimeout(() => console.log('${i}|' + s + '|' + Date.now()), 120);`,
    ]);
    const results = await runCliBatch(argvs, { width: 2 });
    const spans = results.map((r, i) => {
      const parts = r.stdout.trim().split('|');
      expect(parts[0]).toBe(String(i)); // order preserved too
      return { start: Number(parts[1]), end: Number(parts[2]) };
    });
    const events = spans
      .flatMap(s => [{ t: s.start, d: 1 }, { t: s.end, d: -1 }])
      .sort((a, b) => a.t - b.t || a.d - b.d); // tie: end before start
    let running = 0;
    let peak = 0;
    for (const e of events) {
      running += e.d;
      peak = Math.max(peak, running);
    }
    expect(peak).toBeGreaterThanOrEqual(1);
    expect(peak).toBeLessThanOrEqual(2);
  });

  test('empty input resolves to empty results', async () => {
    expect(await runCliBatch([])).toEqual([]);
  });

  test('spawn failure rejects the batch', async () => {
    // Relies on Bun.spawn throwing for a nonexistent executable
    // (it does in current Bun; if a future Bun returns an exited-with-error
    // subprocess instead, this becomes a resolved nonzero-exit batch and the
    // assertion needs revisiting). Reap-of-siblings is exercised implicitly:
    // both argvs share the broken target, and the catch path awaits them.
    _setSpawnTarget(['/nonexistent-gbrain-cli-spawn-fixture']);
    await expect(runCliBatch([[], []], { width: 2 })).rejects.toThrow();
  });
});

describe('runCliMemo', () => {
  test('memo hit returns the identical object without respawning', async () => {
    // Child output is unique per spawn; identical stdout proves no respawn.
    const argv = [`console.log(Date.now() + '-' + Math.random());`];
    const [a, b] = await Promise.all([runCliMemo(argv), runCliMemo(argv)]);
    expect(a).toBe(b);

    // Key is argv content + home, not array identity.
    const c = await runCliMemo([...argv]);
    expect(c).toBe(a);

    clearCliMemo();
    const d = await runCliMemo(argv);
    expect(d).not.toBe(a);
    expect(d.stdout).not.toBe(a.stdout);
  });

  test('different argv or home misses the memo', async () => {
    const argv = [`console.log('memo-fixture');`];
    const a = await runCliMemo(argv);
    const b = await runCliMemo([`console.log('memo-fixture');/*v2*/`]);
    expect(b).not.toBe(a);
    const home = mkdtempSync(join(tmpdir(), 'gbrain-cli-memo-home-'));
    try {
      const c = await runCliMemo(argv, { home });
      expect(c).not.toBe(a);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
