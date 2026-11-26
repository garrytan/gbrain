/**
 * The two read commands of the access read log let an engine capability refusal through.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `gbrain access log` and `gbrain access who-read` (the command functions and `runAccess`) stop on an
 *    engine's `engine_capability_missing` from any of their members (readAccessReadLog, listAccessReadPageRefs,
 *    readAccessReadsOfPages, tallyAccessReadsOfPages) and on any other failure; neither prints "No logged member reads"
 *    for an engine that could not read the log. The writer stays best-effort: a refused insert drops its batch with one
 *    warning and never throws to the read path.
 *  - Regression: a reader that wrapped its member in a catch (the shape the refusal-swallow triage removes) answered an
 *    empty list for a Rust brain that refused the read, which told an auditor nobody had read anything.
 *  - Why existing coverage misses it: test/access-read-log.test.ts and the parity file run engines that answer.
 *  - Seam: stub engines whose one member throws; the writer test replaces the insert on a real PGLite brain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { runAccess } from '../src/commands/access.ts';
import { readAccessLog, whoRead } from '../src/commands/access-read-log.ts';
import { __resetAccessReadLogForTests, flushAccessReadLog, recordAccessRead } from '../src/core/access/read-log.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';

const refused = () => capabilityMissing('telemetry', 'readAccessReadLog');
const plain = () => new Error('connection reset');

/** An engine that answers an empty log and one page for `who-read`, except for `member`, which throws. */
function engineThrowing(member: string, error: () => unknown): BrainEngine {
  const answers: Record<string, unknown> = {
    readAccessReadLog: [], listAccessReadPageRefs: [{ id: 7, source_id: 'default', slug: 'notes/a' }],
    readAccessReadsOfPages: [], tallyAccessReadsOfPages: [],
  };
  return new Proxy({}, {
    get(_t, key) {
      if (typeof key !== 'string') return undefined;
      return async () => { if (key === member) throw error(); return answers[key]; };
    },
  }) as unknown as BrainEngine;
}

/** Runs a CLI entry with `process.exit` and the console captured: the exit code it asked for, and what it printed. */
async function cli(run: () => Promise<unknown>): Promise<{ exit: number | null; out: string; err: string }> {
  const out: string[] = []; const err: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  const error = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
  const write = spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { err.push(String(chunk)); return true; }) as never);
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as never);
  let exited: number | null = null;
  try { await run(); } catch (e) { const m = /^exit:(\d+)$/.exec((e as Error).message); if (!m) throw e; exited = Number(m[1]); }
  finally { log.mockRestore(); error.mockRestore(); write.mockRestore(); exit.mockRestore(); }
  return { exit: exited, out: out.join('\n'), err: err.join('\n') };
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try { await run(); return 'answered'; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; }
}

describe('the read commands of the access read log', () => {
  for (const [name, error, want] of [['a capability refusal', refused, 'engine_capability_missing'], ['another failure', plain, 'connection reset']] as const) {
    test(`${name} from any member stops the command, never an empty list`, async () => {
      const got = {
        log: await outcome(() => readAccessLog(engineThrowing('readAccessReadLog', error), { since: '1d' })),
        who_pages: await outcome(() => whoRead(engineThrowing('listAccessReadPageRefs', error), 'notes/a', { since: '1d' })),
        who_reads: await outcome(() => whoRead(engineThrowing('readAccessReadsOfPages', error), 'notes/a', { since: '1d' })),
        who_tally: await outcome(() => whoRead(engineThrowing('tallyAccessReadsOfPages', error), 'notes/a', { since: '1d' })),
      };
      expect(got).toEqual({ log: want, who_pages: want, who_reads: want, who_tally: want });
      // The CLI exits non-zero with the error on stderr and prints no list, so the command never reports "no reads".
      for (const [member, args] of [['readAccessReadLog', ['log', '--since', '1d']], ['tallyAccessReadsOfPages', ['who-read', 'notes/a']]] as const) {
        const ran = await cli(() => runAccess(engineThrowing(member, error), [...args]));
        expect({ exit: ran.exit !== 0 && ran.exit !== null, listed: ran.out.includes('No logged member reads'), named: ran.err.includes(want === 'connection reset' ? want : 'does not support') })
          .toEqual({ exit: true, listed: false, named: true });
      }
    });
  }

  test('an engine that answers an empty log still prints the empty-window line', async () => {
    const ran = await cli(() => runAccess(engineThrowing('none', plain), ['log', '--since', '1d']));
    expect(ran).toMatchObject({ exit: null });
    expect(ran.out).toContain('No logged member reads in this window');
  });
});

describe('the writer stays best-effort', () => {
  let pglite: PGLiteEngine;
  beforeAll(async () => { pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); }, 60_000);
  afterAll(async () => { await pglite.disconnect(); });
  beforeEach(() => __resetAccessReadLogForTests());

  test('a refused insert drops its batch with one warning and never throws', async () => {
    const insert = spyOn(pglite, 'insertAccessReadLogRows').mockRejectedValue(refused());
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 2; i++) {
        recordAccessRead(pglite, { member: 'ada-example', audience: null, operation: 'get_page', transport: 'cli', result_code: 'ok', page_ids: [] });
        await flushAccessReadLog();
      }
      expect(insert).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); insert.mockRestore(); }
  });
});
