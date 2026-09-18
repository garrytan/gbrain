// Regression test for the #5177 CLI-renderer layer: runPersistenceAdminCli
// stringifies the administration op result itself, so an int8 value anywhere
// in a result payload crashes the renderer with "JSON.stringify cannot
// serialize BigInt." — the shape a raw (uncast) int8 payload has on
// postgres.js always and on PGlite for values past Number.MAX_SAFE_INTEGER.
// The SQL casts in the persistence layer are the primary fix; this pins the
// bigintToStringReplacer backstop so any future leak degrades to string
// instead of crashing (defense-in-depth, the #2450 pattern).
//
// The op boundary is stubbed to the pre-cast payload shape, so this pins the
// RENDERER only (mock.module is file-scoped; keeping it in its own file keeps
// the PGLite contract tests unmocked).
//
// Discrimination: reverting src/commands/persistence-admin.ts empties stdout
// in the two CLI tests below (the third pins the replacer itself and passes
// either way — the official discrimination run reports 1 pass / 2 fail).
//
// .serial quarantine: this file uses top-level mock.module, which leaks
// across files in a shared shard process (the R2 isolation rule) — the
// parallel runner loads *.serial.test.ts in their own process.

import { afterAll, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { bigintToStringReplacer } from '../src/core/utils.ts';

const written: string[] = [];
const verdicts: number[] = [];

// Pure stubs — do NOT import the real module inside the factory (the mock
// factory importing its own target deadlocks). Only the three symbols the
// admin/lifecycle CLI paths and persistence-delegate use are needed here.
mock.module('../src/core/cli-force-exit.ts', () => ({
  writeStdoutFinal: async (payload: string) => { written.push(payload); },
  finishCliTeardown: async () => {},
  setCliExitVerdict: (code: number) => { verdicts.push(code); },
}));
mock.module('../src/core/persistence/administration.ts', () => ({
  runPersistenceAdministration: async () => ({
    sampled_at: '2026-09-17T00:00:00.000Z',
    worktrees: [{ id: 'wt-1', owner_epoch: 9007199254740993n, topology_generation: 1n, state: 'active' }],
    counters: [{ key: 'brain', outstanding_count: 0n }],
  }),
}));

const home = mkdtempSync(join(tmpdir(), 'gbrain-admin-render-home-'));
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

/** The renderer resolves the brain from config before dispatching the op. */
function writeConfig(): void {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'postgres', database_url: 'postgres://user:***@127.0.0.1:5432/gbrain_test_config_only',
  }));
}

describe('persistence admin CLI renderer backstop (#5177)', () => {
  const loadCli = async (): Promise<typeof import('../src/commands/persistence-admin.ts').runPersistenceAdminCli> =>
    (await import('../src/commands/persistence-admin.ts')).runPersistenceAdminCli;

  test('writer status with a raw Postgres-shaped BigInt payload renders as JSON with string epochs', () => withEnv({
    GBRAIN_HOME: home, HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
  }, async () => {
    written.length = 0; verdicts.length = 0;
    writeConfig();
    const cli = await loadCli();
    await cli('writer', ['status', '--json'], { kind: 'postgres' } as never);
    expect(written.length).toBe(1);
    const parsed = JSON.parse(written[0]) as { worktrees: Array<{ owner_epoch: string; topology_generation: string }> };
    expect(parsed.worktrees[0].owner_epoch).toBe('9007199254740993');
    expect(parsed.worktrees[0].topology_generation).toBe('1');
    expect(verdicts.length).toBe(0);
  }));

  test('non-json mode renders through the same replacer', () => withEnv({
    GBRAIN_HOME: home, HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
  }, async () => {
    written.length = 0; verdicts.length = 0;
    writeConfig();
    const cli = await loadCli();
    await cli('writer', ['status'], { kind: 'postgres' } as never);
    expect(written.length).toBe(1);
    const parsed = JSON.parse(written[0]) as { worktrees: Array<{ owner_epoch: string }> };
    expect(parsed.worktrees[0].owner_epoch).toBe('9007199254740993');
    expect(verdicts.length).toBe(0);
  }));

  test('bigintToStringReplacer degrades a nested BigInt payload instead of throwing', () => {
    const raw = { worktrees: [{ owner_epoch: 4n }], nested: { seq: 112n }, plain: 5 };
    expect(() => JSON.stringify(raw)).toThrow();
    const out = JSON.parse(JSON.stringify(raw, bigintToStringReplacer)) as Record<string, unknown>;
    expect((out.worktrees as Array<{ owner_epoch: string }>)[0].owner_epoch).toBe('4');
    expect((out.nested as { seq: string }).seq).toBe('112');
    expect(out.plain).toBe(5);
  });
});
