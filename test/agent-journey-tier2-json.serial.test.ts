/**
 * Lane H1b (Tier 2), row 1: every `--json` stdout parses, for every read op the
 * CLI exposes (mutating:false, no required params), the doctor family and the
 * journey's commands, each as a real CLI subprocess against a keyless PGLite
 * brain in a temp home. Split from test/agent-journey-tier2.serial.test.ts
 * (rows 2–4) to keep each serial file well under the pool's per-file wall
 * clock; the brain is seeded the same way.
 *
 * Serial: real subprocesses, PGLite locks.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operations } from '../src/core/operations.ts';
import { gb } from './helpers/agent-journey.ts';
import { MARKER, expectJsonContract, seedTimelineFinding, writeNotes } from './helpers/agent-journey-tier2.ts';

describe('H1b: --json parses, every WARN has an executable fix, every plan command runs', () => {
  let home = '';
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-tier2-json-'));
    expect((await gb(home, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    expect((await gb(home, ['import', writeNotes(join(home, 'notes'), 3), '--no-embed', '--json'])).exitCode).toBe(0);
    await seedTimelineFinding(home, 'tier2-note-1');
  }, 300_000);
  afterAll(() => { rmSync(home, { recursive: true, force: true }); });

  test('every read op on the CLI and the doctor family: --json stdout is one document', async () => {
    const readOps = operations
      .filter(op => op.mutating === false && op.cliHints?.name && !Object.values(op.params).some(p => p.required))
      .map(op => [op.cliHints!.name!]);
    expect(readOps.length).toBeGreaterThan(20);
    const commands = [
      ...readOps,
      ['doctor'], ['doctor', '--fast'], ['doctor', '--only', 'embeddings'], ['doctor', '--remediation-plan'],
      ['search', MARKER], ['query', MARKER], ['get', 'tier2-note-1'], ['recall', MARKER], ['sources', 'list'],
      ['jobs', 'list'], ['jobs', 'stats'], ['errors', 'invalid_params'], ['features'], ['status'], ['models'],
      ['embed', '--stale'], ['import', join(home, 'notes')], ['transcripts'], ['whoknows'],
    ];
    const bad: string[] = [];
    for (const args of commands) {
      const r = await gb(home, [...args, '--json'], { timeoutMs: 90_000 });
      try { expectJsonContract(r, `gbrain ${args.join(' ')} --json`); } catch (e) { bad.push(`${args.join(' ')} (exit ${r.exitCode}): ${String(e).slice(0, 300)}`); }
    }
    expect(bad).toEqual([]);
  }, 900_000);
});
