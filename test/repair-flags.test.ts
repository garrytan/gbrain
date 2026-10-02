/**
 * `gbrain repair` flag handling (fix wave 3, Lane D): unknown flags are
 * refused before any scope resolution or write, `--max-usd` points at the
 * capped doctor route, every registered kind has a help line and a
 * registration, and the `--all` preview lists every kind with its estimates.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { REPAIR_KINDS } from '../src/core/repair/core.ts';
import { REPAIR_HELP, runRepairCommand } from '../src/commands/repair.ts';
import { AUTO_REPAIR_REGISTRY } from '../src/core/repair/registry.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-flags-'));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

async function refusal(args: string[]): Promise<OperationError> {
  try {
    await withEnv({ GBRAIN_HOME: home }, () => runRepairCommand(engine, args));
  } catch (error) {
    if (error instanceof OperationError) return error;
    throw error;
  }
  throw new Error(`gbrain repair ${args.join(' ')} was accepted`);
}

async function captured(args: string[]): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try { await withEnv({ GBRAIN_HOME: home }, () => runRepairCommand(engine, args)); } finally { console.log = original; }
  return lines.join('\n');
}

describe('gbrain repair flags', () => {
  test('--max-usd is refused with invalid_params naming the flag and the capped doctor route', async () => {
    const error = await refusal(['safe-chunks', '--apply', '--max-usd', '0']);
    expect(error.code).toBe('invalid_params');
    expect(error.message).toContain('--max-usd');
    expect(error.suggestion).toContain('gbrain doctor --remediate --yes --include-repairs --max-usd 0');
  });

  test('any unknown flag is refused and named, with or without a value', async () => {
    for (const args of [['timeline', '--bogus'], ['--apply', '--all', '--force'], ['visibility', '--sources=a']]) {
      const error = await refusal(args);
      expect(error.code).toBe('invalid_params');
      expect(error.message).toContain(args.find(a => a.startsWith('--') && !['--apply', '--all'].includes(a))!.split('=')[0]);
    }
  });

  test('a stray positional after the kind is refused instead of silently ignored', async () => {
    const error = await refusal(['timeline', 'extra']);
    expect(error.code).toBe('invalid_params');
    expect(error.message).toContain('extra');
  });

  test('help names every registered kind', () => {
    for (const kind of REPAIR_KINDS) expect(REPAIR_HELP).toContain(`  ${kind}`);
  });

  test('--all preview lists every kind with lifetime-id and USD estimates and names the paid kinds', async () => {
    const out = await captured(['--all', '--json']);
    const parsed = JSON.parse(out) as { mode: string; results: Array<{ kind: string; cost: Record<string, unknown>; paid: boolean }>; paid_kinds: string[] };
    expect(parsed.mode).toBe('dry_run');
    expect(parsed.results.map(r => r.kind)).toEqual(AUTO_REPAIR_REGISTRY.map(spec => spec.kind));
    for (const result of parsed.results) {
      expect(result.cost).toHaveProperty('lifetime_ids');
      expect(result.cost).toHaveProperty('embedding_usd');
      expect(typeof result.paid).toBe('boolean');
    }
    expect(parsed.paid_kinds).toContain('safe-chunks');
    const human = await captured(['--all']);
    expect(human).toContain("may queue paid embeddings: timeline, visibility, safe-chunks");
    const free = JSON.parse(await captured(["--all", "--json", "--no-embed"])) as { paid_kinds: string[] };
    expect(free.paid_kinds).toEqual(["timeline", "visibility", "connector-fences", "embedding-effects"]);
  });
});
