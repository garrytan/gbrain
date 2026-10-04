/**
 * Lane E4 (agent-first operator wave): `gbrain dream` propagates phase errors.
 * A cycle where one phase reports `fail` and another succeeds derives
 * `partial`; before this fix that exited 0 (success) unless the failure was a
 * contained throw. Any failed phase now exits 1.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runDream } from '../src/commands/dream.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;
let notGit: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-dream-fail-home-'));
  notGit = mkdtempSync(join(tmpdir(), 'gbrain-dream-fail-src-'));
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['user-notes-example', notGit]);
}, 120_000);
afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
  rmSync(notGit, { recursive: true, force: true });
});

test('a partial cycle with a failed phase exits 1', () => withEnv({ GBRAIN_HOME: home }, async () => {
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`EXIT ${code}`); }) as never);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const err = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(runDream(engine, ['--dir', notGit, '--phase', 'sync', '--phase', 'backlinks', '--json'])).rejects.toThrow('EXIT 1');
    const printed = log.mock.calls.map(c => String(c[0])).join('\n');
    const report = JSON.parse(printed.slice(printed.indexOf('{')));
    expect(report.status).toBe('partial');
    expect(report.phases.find((p: { phase: string }) => p.phase === 'sync').status).toBe('fail');
    expect(report.phases.find((p: { phase: string }) => p.phase === 'backlinks').status).toBe('ok');
    expect(exit).toHaveBeenCalledWith(1);
  } finally {
    exit.mockRestore();
    log.mockRestore();
    err.mockRestore();
  }
}), 120_000);
