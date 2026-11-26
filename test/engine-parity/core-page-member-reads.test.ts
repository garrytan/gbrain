/**
 * BrainEngine parity — the core-memory page list behind `context_pack` for a member caller.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: under `excludePrivate`, listCorePageRows lists the live `always_load` pages the caller may read. With
 *    `forCaller` that is the caller's page policy (`privatePagesFilterForCaller`): a member whose identity a page's
 *    readers name reads that page, a private-readable grant opens the private pages of its source, a stranger reads
 *    neither. Without it the read is the remote floor (`remoteReadFloorSql`), which hides both from every caller.
 *  - Regression: the Rust arm refused a caller with a reader identity or a grant on both forms, so `context_pack`
 *    failed for such a caller while PGLite answered.
 *  - Why existing coverage misses it: trust-tier-reads.test.ts reads the core list with no caller record.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { runCore } from '../../src/commands/core.ts';

const { parityTest } = parityArms(testBackends());

const core = (frontmatter: Record<string, unknown>) =>
  ({ type: 'note' as const, title: 'Core', compiled_truth: `body ${JSON.stringify(frontmatter)}`, timeline: '', frontmatter: { always_load: true, ...frontmatter } });

/** The callers each read runs as: none, a member the readers name, a stranger, a grant on `vault`, and a member with that grant. */
const CALLERS: Array<[string, Record<string, unknown> | null]> = [
  ['none', null],
  ['reader', { identity: ['member:alice-example'], hidePrivate: true }],
  ['stranger', { identity: ['member:bob-example'], hidePrivate: true }],
  ['granted', { privateReadableSources: ['vault'], hidePrivate: true }],
  ['readerGranted', { identity: ['member:alice-example'], privateReadableSources: ['vault'], hidePrivate: true }],
];

async function asEach<T>(read: () => Promise<T>): Promise<Record<string, T>> {
  const out: Record<string, T> = {};
  for (const [name, access] of CALLERS) out[name] = access ? await withCallerAccess(access, read) : await read();
  return out;
}

describe('engine parity: core-memory page list for a member caller', () => {
  parityTest(
    'listCorePageRows under excludePrivate lists the core pages the caller policy shows, and the floor for any caller',
    { methods: ['putPage', 'listCorePageRows'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'team');
      await createSource(engine, backend, 'vault');
      await engine.putPage('core/open', core({}), { sourceId: 'default' });
      await engine.putPage('core/listed', core({ readable_by: ['alice-example'] }), { sourceId: 'team' });
      await engine.putPage('core/secret', core({ visibility: 'private' }), { sourceId: 'vault' });
      const slugs = async (forCaller: boolean) =>
        (await engine.listCorePageRows({ excludePrivate: true, forCaller, limit: 50 })).map(r => `${r.source_id}:${r.slug}`);
      const out = await asEach(async () => ({ caller: await slugs(true), floor: await slugs(false) }));
      const floor = ['default:core/open'];
      expect(out).toEqual({
        none: { caller: ['default:core/open'], floor },
        reader: { caller: ['default:core/open', 'team:core/listed'], floor },
        stranger: { caller: ['default:core/open'], floor },
        granted: { caller: ['default:core/open', 'vault:core/secret'], floor },
        readerGranted: { caller: ['default:core/open', 'team:core/listed', 'vault:core/secret'], floor },
      });
      return out;
    },
  );
});

describe('engine parity: gbrain core remove', () => {
  // `core remove` un-cores the page on every engine and prints the same line. An engine with raw SQL (PGLite, Postgres)
  // also closes the page's pending remote-edit notices; a Rust brain keeps no notices, so there is nothing to close and
  // the close is skipped. The notice rows are only read where the engine has them, so the returned value is the same on
  // every arm.
  parityTest('core remove un-cores the page and prints the same line on every engine, closing pending notices where they are kept', {
    methods: ['putPage', 'readPageSnapshot'],
  }, async (engine: BrainEngine, backend) => {
    await engine.putPage('core/about', core({}), { sourceId: 'default' });
    await engine.putPage('core/other', core({}), { sourceId: 'default' });
    const keepsNotices = backend !== 'rust';
    const notice = (slug: string) => engine.executeRaw(
      `INSERT INTO core_edit_notices (source_id, slug, page_id, revision, base_revision, base_text, actor) VALUES ('default', $1, NULL, 'rev-1', NULL, 'before', 'agent:test')`, [slug]);
    if (keepsNotices) { await notice('core/about'); await notice('core/other'); }
    const pending = async (slug: string) => (await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM core_edit_notices WHERE source_id = 'default' AND slug = $1 AND acked_at IS NULL`, [slug]))[0]?.n;
    const isCore = async () => (await engine.readPageSnapshot('core/about', { sourceId: 'default' }))?.page.frontmatter?.always_load === true;
    const errors: string[] = [];
    const printed: string[] = [];
    const error = console.error;
    const log = console.log;
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    console.log = (...a: unknown[]) => { printed.push(a.join(' ')); };
    let refused: unknown = null;
    try {
      await runCore(engine, ['remove', 'core/about']);
    } catch (e) {
      refused = e;
    } finally {
      console.error = error;
      console.log = log;
    }
    if (keepsNotices) {
      // The page's notice is closed; another page's notice stays pending.
      expect({ closed: await pending('core/about'), other: await pending('core/other') }).toEqual({ closed: 0, other: 1 });
    }
    const out = { refused, core: await isCore(), errors, printed };
    expect(out.refused).toBeNull();
    expect(out).toEqual({ refused: null, core: false, errors: [], printed: [expect.stringMatching(/^Now out of core: default:core\/about\. Core uses \d+\/\d+ chars\.$/)] });
    return out;
  });
});
