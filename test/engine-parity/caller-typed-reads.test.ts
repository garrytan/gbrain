/**
 * BrainEngine parity — command and op reads that ran their own SQL through `executeRaw`, now typed engine reads:
 * `gbrain takes horizon set|clear` finds its take (readLivePageIdBySlug, findTakeId).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each caller answers byte for byte the same on every engine arm (PGLite always; Postgres with DATABASE_URL;
 *    the Rust arm through test/engine-parity/harness.ts), including its error text.
 *  - Regression: an arm that finds a take on a deleted page or in another source, or misses one at its row, edits the
 *    wrong take's horizon or tells the user the take does not exist.
 *  - Why existing coverage misses it: test/takes-horizon-cli.test.ts runs on PGLite only, and the statement ran through
 *    `executeRaw` in the command, which the Rust engine refuses (D18).
 *  - Seam: the command is called in process with `process.exit` and stderr captured; ids never compare across arms.
 */
import { describe, expect } from 'bun:test';
import { runTakes } from '../../src/commands/takes.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const body = (title: string) => ({ type: 'note' as const, title, compiled_truth: 'Body.', timeline: '' });

/** Fixture: run a command, with its stdout lines, stderr text and exit code captured. */
async function runCommand(fn: () => Promise<void>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = process.stderr.write.bind(process.stderr);
  const out: string[] = [];
  let stderr = '';
  console.log = (...args: unknown[]) => { out.push(args.join(' ')); };
  process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => { throw Object.assign(new Error('EXIT'), { exitCode: code }); }) as typeof process.exit;
  try {
    await fn();
    return { code: null, stdout: out.join('\n'), stderr };
  } catch (e) {
    if ((e as Error).message !== 'EXIT') throw e;
    return { code: (e as { exitCode?: number }).exitCode ?? null, stdout: out.join('\n'), stderr };
  } finally {
    process.exit = origExit;
    console.log = origLog;
    process.stderr.write = origErr;
  }
}

/** Fixture: a page with takes at rows 1..n in `sourceId`. */
async function pageWithTakes(engine: BrainEngine, slug: string, claims: string[], sourceId = 'default') {
  const page = await engine.putPage(slug, body(slug), { sourceId });
  await engine.addTakesBatch(claims.map((claim, i) => ({ page_id: Number(page.id), row_num: i + 1, claim, kind: 'take', holder: 'h', weight: 0.5 })));
  return Number(page.id);
}

describe('engine parity: the take lookup of gbrain takes horizon', () => {
  parityTest('takes horizon finds no take on a deleted page, in another source or at a missing row, with the same message', {
    methods: ['putPage', 'addTakesBatch', 'softDeletePage', 'readLivePageIdBySlug', 'findTakeId'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await pageWithTakes(engine, 'notes/h-live', ['one']);
    await pageWithTakes(engine, 'notes/h-other', ['one'], 'other');
    await pageWithTakes(engine, 'notes/h-gone', ['one']);
    await engine.softDeletePage('notes/h-gone');
    const clear = (slug: string, row: string, source = 'default') => runCommand(() => runTakes(engine, ['horizon', 'clear', slug, '--row', row, '--source-id', source]));
    const got = {
      missingRow: await clear('notes/h-live', '2'),
      deleted: await clear('notes/h-gone', '1'),
      otherSource: await clear('notes/h-other', '1'),
      noPage: await clear('notes/h-none', '1'),
    };
    const none = (ref: string) => ({ code: 1, stdout: '', stderr: `No take ${ref} on source default. List the page's takes with: gbrain takes ${ref.split('#')[0]}\n` });
    expect(got).toEqual({
      missingRow: none('notes/h-live#2'), deleted: none('notes/h-gone#1'), otherSource: none('notes/h-other#1'), noPage: none('notes/h-none#1'),
    });
    return got;
  });
});
