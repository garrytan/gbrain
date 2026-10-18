/**
 * #6543 C2: serve writes the pending behavior-change disclosure to its own log once per process and not again on a
 * restart of the same release, without consuming the CLI's or the MCP channels' delivery and without recording the
 * brain's baseline. `runServe` calls it at startup.
 *
 * Regression that fails it: serve never logging the rows, logging them on every start, or claiming the CLI/stdio
 * marker (the next CLI command would then miss its notice).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __resetBehaviorNoticeForTests, BEHAVIOR_NOTICE_CODE, takeLocalBehaviorNotice } from '../src/core/behavior-change-notice.ts';
import { __resetServeBehaviorNoticeForTests, logServeBehaviorNotice } from '../src/core/serve-behavior-notice.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // A brain that existed well before this release: the rows since its (derived) baseline are pending.
  await engine.executeRaw("UPDATE sources SET created_at = now() - interval '30 days'");
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-serve-notice-'));
  __resetServeBehaviorNoticeForTests();
  __resetBehaviorNoticeForTests();
});

const cfg = { engine: 'pglite' as const, database_path: '/tmp/serve-notice-test-brain' };

test('serve logs pending behavior changes once per process and not on the next start of the same release', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  try {
    const lines: string[] = [];
    expect(await logServeBehaviorNotice(engine, cfg, { write: line => lines.push(line) })).toBe(true);
    expect(await logServeBehaviorNotice(engine, cfg, { write: line => lines.push(line) })).toBe(false);
    expect(lines.length).toBe(1);
    expect(lines[0]).toStartWith(`[gbrain serve] notice=${BEHAVIOR_NOTICE_CODE}: `);
    expect(lines[0]).toContain('gbrain doctor --only behavior_changes');
    __resetServeBehaviorNoticeForTests();
    expect(await logServeBehaviorNotice(engine, cfg, { write: line => lines.push(line) })).toBe(false);
    expect(lines.length).toBe(1);
  } finally { rmSync(home, { recursive: true, force: true }); }
}), 30_000);

test('serve logging leaves the CLI notice, the stdio marker and the baseline untouched', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  try {
    await logServeBehaviorNotice(engine, cfg, { write: () => undefined });
    const dir = join(home, '.gbrain', 'notices', 'behavior-changes');
    const names = existsSync(dir) ? readdirSync(dir) : [];
    expect(names.filter(name => name.endsWith('.cli.shown') || name.endsWith('.stdio.shown') || name.endsWith('.baseline'))).toEqual([]);
    expect(names.filter(name => name.endsWith('.serve_log.shown')).length).toBe(1);
    const cliNotice = await takeLocalBehaviorNotice(engine, 'cli', { cfg });
    expect(cliNotice?.code).toBe(BEHAVIOR_NOTICE_CODE);
  } finally { rmSync(home, { recursive: true, force: true }); }
}), 30_000);

test('runServe logs the notice at startup', () => {
  // test-reads-source-ok[structural]: runServe needs a live engine, transports and signal handlers; this pins only that startup calls the notice logger tested above
  const source = readFileSync(join(import.meta.dir, '../src/commands/serve.ts'), 'utf8');
  expect(source).toMatch(/logServeBehaviorNotice\(engine, /);
});
