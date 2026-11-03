/**
 * reconcile-links honours the selected source and does not swallow write errors.
 *
 * Authoring gate (docs/TESTING.md):
 *  1. Protects: `gbrain reconcile-links [--source <id>]` reconciles exactly one
 *     source (scan, page reads and both edge directions), refuses `__all__`
 *     before touching the brain, and fails instead of reporting `ok` when an
 *     edge write fails for a reason other than a missing target.
 *  2. Regressions that fail it: the CLI dropping `--source`, the markdown scan
 *     losing its `source_id` filter, `__all__` being accepted, the catch block
 *     going back to `console.warn` and continuing.
 *  3. Not already covered: test/reconcile-links.test.ts runs a single-source
 *     (default) brain only, so none of this is observable there.
 *  4. No production seam: every case calls the exported entry points; failures
 *     are injected by wrapping `engine.addLink` on the test's own instance.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PageMissingError } from '../src/core/engine-errors.ts';
import { runReconcileLinks, runReconcileLinksCli } from '../src/commands/reconcile-links.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

const GUIDE = 'guides/sync-guide';
const CODE = 'src-core-sync-ts';

async function putGuide(slug: string, text: string, sourceId: string) {
  await engine.putPage(slug, { type: 'guide', title: slug, compiled_truth: text, timeline: '' }, { sourceId });
}
async function putCode(slug: string, sourceId: string) {
  await engine.putPage(slug, { type: 'code', page_kind: 'code', title: slug, compiled_truth: 'module', timeline: '' }, { sourceId });
}

/** Every stored edge as `from-source:from-slug -type-> to-source:to-slug`, sorted by JS string order. */
async function edges(): Promise<string[]> {
  const rows = await engine.executeRaw<{ edge: string }>(
    `SELECT f.source_id || ':' || f.slug || ' -' || l.link_type || '-> ' || t.source_id || ':' || t.slug AS edge
       FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
      `,
  );
  return rows.map(r => r.edge).sort();
}

/** Run the CLI entry with `--json` and return the parsed result. */
async function cliJson(args: string[]) {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try {
    await runReconcileLinksCli(engine, [...args, '--json']);
  } finally {
    console.log = realLog;
  }
  return JSON.parse(lines.join('\n')) as Awaited<ReturnType<typeof runReconcileLinks>>;
}

/** Wrap engine.addLink for one test; the wrapper is removed even if the test throws. */
async function withAddLink(wrapper: (call: number, real: () => Promise<unknown>) => Promise<unknown>, fn: () => Promise<void>) {
  const original = engine.addLink.bind(engine);
  let call = 0;
  (engine as unknown as { addLink: unknown }).addLink = (...a: Parameters<typeof original>) => wrapper(++call, () => original(...a));
  try {
    await fn();
  } finally {
    delete (engine as unknown as { addLink?: unknown }).addLink;
  }
}

describe('reconcile-links source scope', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    for (const id of ['work', 'other']) {
      await engine.executeRaw(`INSERT INTO sources(id, name, config) VALUES ($1, $1, '{}')`, [id]);
    }

    // work: one guide + the code it cites.
    await putGuide(GUIDE, 'The sync path lives at src/core/sync.ts:10.', 'work');
    await putCode(CODE, 'work');
    // other: the SAME guide slug, a second guide, and code only this source has.
    await putGuide(GUIDE, 'The sync path lives at src/core/sync.ts:10.', 'other');
    await putGuide('guides/other-only', 'See src/other-only.ts for the details.', 'other');
    await putCode(CODE, 'other');
    await putCode('src-other-only-ts', 'other');
    // default: its own guide + code.
    await putGuide('guides/default-guide', 'Also see src/core/sync.ts.', 'default');
    await putCode(CODE, 'default');
  });

  afterAll(async () => {
    await engine.disconnect();
  }, 30_000);

  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM links');
  });

  test('a named source writes its edges, and only its own', async () => {
    const result = await runReconcileLinks(engine, { sourceId: 'work' });
    expect(result).toMatchObject({ status: 'ok', markdownPagesScanned: 1, codeRefsFound: 1, edgesAttempted: 1, edgesTargetsMissing: 0 });
    expect(await edges()).toEqual([
      `work:${GUIDE} -documents-> work:${CODE}`,
      `work:${CODE} -documented_by-> work:${GUIDE}`,
    ]);
  });

  test('another source is neither scanned nor linked', async () => {
    // other has two guides and default has one; none may be counted for work.
    const dry = await runReconcileLinks(engine, { sourceId: 'work', dryRun: true });
    expect(dry.markdownPagesScanned).toBe(1);

    const other = await runReconcileLinks(engine, { sourceId: 'other' });
    expect(other.markdownPagesScanned).toBe(2);
    const stored = await edges();
    expect(stored).toHaveLength(4);
    expect(stored.every(e => e.includes('other:') && !e.includes('work:') && !e.includes('default:'))).toBe(true);
  });

  test('CLI --source <id> reconciles that source', async () => {
    const result = await cliJson(['--source', 'work']);
    expect(result).toMatchObject({ status: 'ok', markdownPagesScanned: 1, edgesAttempted: 1, edgesTargetsMissing: 0 });
    expect(await edges()).toEqual([
      `work:${GUIDE} -documents-> work:${CODE}`,
      `work:${CODE} -documented_by-> work:${GUIDE}`,
    ]);
  });

  test('CLI without --source resolves through the ambient source chain', async () => {
    await withEnv({ GBRAIN_SOURCE: 'other' }, async () => {
      const result = await cliJson([]);
      expect(result.markdownPagesScanned).toBe(2);
    });
    expect((await edges()).every(e => e.startsWith('other:') && e.includes('-> other:'))).toBe(true);
    expect(await edges()).toHaveLength(4);

    await engine.executeRaw('DELETE FROM links');
    // Nothing selects a source: the default source, which has its own guide.
    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const result = await cliJson([]);
      expect(result.markdownPagesScanned).toBe(1);
    });
    expect(await edges()).toEqual([
      `default:guides/default-guide -documents-> default:${CODE}`,
      `default:${CODE} -documented_by-> default:guides/default-guide`,
    ]);
  });

  test('CLI --source for a source that does not exist fails and writes nothing', async () => {
    await expect(runReconcileLinksCli(engine, ['--source', 'no-such-source'])).rejects.toThrow(/no-such-source/);
    expect(await edges()).toEqual([]);
  });

  test('CLI --source without a value is refused', async () => {
    await expect(runReconcileLinksCli(engine, ['--source'])).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(runReconcileLinksCli(engine, ['--source', '--json'])).rejects.toMatchObject({ code: 'invalid_params' });
    expect(await edges()).toEqual([]);
  });

  describe('__all__ is not a target', () => {
    const touched = ['getConfig', 'executeRaw', 'getPage', 'addLink'] as const;

    /** Run fn with every engine entry reconcile-links could use recording its calls. */
    async function recordingEngineCalls(fn: () => Promise<void>): Promise<string[]> {
      const calls: string[] = [];
      const own = engine as unknown as Record<string, unknown>;
      for (const name of touched) {
        const real = own[name] as (...a: unknown[]) => unknown;
        own[name] = (...a: unknown[]) => { calls.push(name); return real.apply(engine, a); };
      }
      try {
        await fn();
      } finally {
        for (const name of touched) delete own[name];
      }
      return calls;
    }

    test('the library entry refuses it before any read or write', async () => {
      const calls = await recordingEngineCalls(async () => {
        await expect(runReconcileLinks(engine, { sourceId: '__all__' })).rejects.toMatchObject({ code: 'invalid_params' });
      });
      expect(calls).toEqual([]);
      expect(await edges()).toEqual([]);
    });

    test('--source __all__ is refused with a message that names the fix', async () => {
      const calls = await recordingEngineCalls(async () => {
        const err = await runReconcileLinksCli(engine, ['--source', '__all__']).then(() => null, (e: unknown) => e as Error & { code?: string; suggestion?: string });
        expect(err?.code).toBe('invalid_params');
        expect(err?.message).toContain('__all__');
        expect(err?.suggestion).toContain('--source <id>');
      });
      expect(calls).toEqual([]);
      expect(await edges()).toEqual([]);
    });

    test('GBRAIN_SOURCE=__all__ is refused too', async () => {
      await withEnv({ GBRAIN_SOURCE: '__all__' }, async () => {
        await expect(runReconcileLinksCli(engine, [])).rejects.toMatchObject({ code: 'invalid_params' });
      });
      expect(await edges()).toEqual([]);
    });
  });

  describe('write errors', () => {
    test('an unexpected error from the forward edge fails the command', async () => {
      await withAddLink(
        async () => { throw new Error('simulated write failure'); },
        async () => {
          await expect(runReconcileLinks(engine, { sourceId: 'work' })).rejects.toThrow('simulated write failure');
        },
      );
    });

    test('an unexpected error from the reverse edge fails the command', async () => {
      await withAddLink(
        async (call, real) => { if (call === 2) throw new Error('simulated reverse failure'); return real(); },
        async () => {
          await expect(runReconcileLinks(engine, { sourceId: 'work' })).rejects.toThrow('simulated reverse failure');
        },
      );
    });

    test('the CLI surfaces the error instead of printing an ok summary', async () => {
      await withAddLink(
        async () => { throw new Error('simulated write failure'); },
        async () => {
          await expect(runReconcileLinksCli(engine, ['--source', 'work', '--json'])).rejects.toThrow('simulated write failure');
        },
      );
    });

    test('a missing target is still counted, not thrown', async () => {
      await withAddLink(
        async () => { throw new PageMissingError('addLink', 'to', CODE, 'work'); },
        async () => {
          const result = await runReconcileLinks(engine, { sourceId: 'work' });
          expect(result).toMatchObject({ status: 'ok', edgesAttempted: 1, edgesTargetsMissing: 1 });
        },
      );
    });

    test('a target that exists only in another source counts as missing and is never linked', async () => {
      // other has src-other-only-ts; work does not. work's own guide cites it.
      await putGuide('guides/cites-other', 'Look at src/other-only.ts.', 'work');
      try {
        const result = await runReconcileLinks(engine, { sourceId: 'work' });
        expect(result).toMatchObject({ status: 'ok', markdownPagesScanned: 2, codeRefsFound: 2, edgesAttempted: 2, edgesTargetsMissing: 1 });
        expect((await edges()).some(e => e.includes('src-other-only-ts'))).toBe(false);
      } finally {
        await engine.executeRaw(`DELETE FROM pages WHERE source_id = 'work' AND slug = 'guides/cites-other'`);
      }
    });
  });
});
