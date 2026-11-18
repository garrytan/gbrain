/**
 * `gbrain forget 1 2 3` must not forget only the first id and report success:
 * more than one distinct id is refused with a nonzero exit.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runForget } from '../src/commands/recall.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-forget-multi-'));
let engine: PGLiteEngine;

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
}), 60_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

async function run(args: string[]): Promise<{ exitCode: number | null; err: string; out: string }> {
  const out: string[] = [], err: string[] = [];
  const o = process.stdout.write.bind(process.stdout), e = process.stderr.write.bind(process.stderr);
  const ol = console.log, oe = console.error, exit = process.exit;
  let exitCode: number | null = null;
  process.stdout.write = ((c: string) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error('exit'); }) as typeof process.exit;
  try {
    await withEnv({ GBRAIN_HOME: home }, () => runForget(engine, args));
  } catch { /* exit sentinel or op error: outcome captured below */ } finally {
    process.stdout.write = o; process.stderr.write = e; console.log = ol; console.error = oe; process.exit = exit;
  }
  return { exitCode, err: err.join(''), out: out.join('') };
}

describe('gbrain forget with several ids', () => {
  test('refuses more than one distinct id instead of acting on the first', async () => {
    const r = await run(['101', '102', '103']);
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain('one fact id per run');
    expect(r.out).not.toContain('Forgot');
  });
});
