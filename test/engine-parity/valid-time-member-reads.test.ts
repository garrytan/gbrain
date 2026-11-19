/**
 * BrainEngine parity — the valid-time reads behind `get_page` with `as_of` for a member caller.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: under `excludePrivate`, listValidTimeIdentities lists the identities of a slug the caller's page policy
 *    (`privatePagesFilterForCaller`) shows, and pickValidTimeEdition marks an edition visible when the caller may read
 *    it: the current page by the page policy, a retained version by its own readers and privacy fields
 *    (`callerReadersAllowedSql(pv, 'snapshot')` and `privacyForCaller`). A member whose identity a page's readers name
 *    reads that page and its versions that name it; a private-readable grant opens the private pages and versions of
 *    its source; a stranger reads neither.
 *  - Regression: the Rust arm refused a caller with a reader identity or a grant on both reads, so `get_page` with
 *    `as_of` failed for such a caller while PGLite answered.
 *  - Why existing coverage misses it: trust-tier-reads.test.ts reads every valid-time case with no caller record.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

const note = (frontmatter: Record<string, unknown>) =>
  ({ type: 'note' as const, title: 'VT', compiled_truth: `body ${JSON.stringify(frontmatter)}`, timeline: '', frontmatter });

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

describe('engine parity: valid-time reads for a member caller', () => {
  parityTest(
    'listValidTimeIdentities under excludePrivate lists the identities the caller policy shows',
    { methods: ['putPage', 'listValidTimeIdentities'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'team');
      await createSource(engine, backend, 'vault');
      await engine.putPage('vt/who', note({}), { sourceId: 'default' });
      await engine.putPage('vt/who', note({ readable_by: ['alice-example'] }), { sourceId: 'team' });
      await engine.putPage('vt/who', note({ visibility: 'private' }), { sourceId: 'vault' });
      const out = await asEach(async () =>
        (await engine.listValidTimeIdentities({ slug: 'vt/who', sourceId: null, sourceIds: null, excludePrivate: true }))
          .map(r => `${r.source_id}:${r.world ? 'world' : 'hidden'}`));
      expect(out).toEqual({
        none: ['default:world'],
        reader: ['default:world', 'team:hidden'],
        stranger: ['default:world'],
        granted: ['default:world', 'vault:hidden'],
        readerGranted: ['default:world', 'team:hidden', 'vault:hidden'],
      });
      return out;
    },
  );

  parityTest(
    'pickValidTimeEdition marks a retained version visible when the caller may read it',
    { methods: ['putPage', 'createVersion', 'getPage', 'pickValidTimeEdition'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'team');
      await createSource(engine, backend, 'vault');
      // Each page's version from January is closed (named readers, or private); its current edition from June is open.
      await engine.putPage('vt/ed', note({ valid_from: '2026-01-01', readable_by: ['alice-example'] }), { sourceId: 'team' });
      await engine.createVersion('vt/ed', { sourceId: 'team' });
      await engine.putPage('vt/ed', note({ valid_from: '2026-06-01' }), { sourceId: 'team' });
      await engine.putPage('vt/ed', note({ valid_from: '2026-01-01', visibility: 'private' }), { sourceId: 'vault' });
      await engine.createVersion('vt/ed', { sourceId: 'vault' });
      await engine.putPage('vt/ed', note({ valid_from: '2026-06-01' }), { sourceId: 'vault' });
      const visible = async (sourceId: string) => {
        const pageId = (await engine.getPage('vt/ed', { sourceId }))!.id;
        const r = await engine.pickValidTimeEdition({ pageId, asOf: '2026-02-01', excludePrivate: true, pinOrd: null, inlineMaxBytes: 1_000_000 });
        return r ? `${r.valid_from}:${r.visible ? 'visible' : 'hidden'}` : null;
      };
      const out = await asEach(async () => ({ listed: await visible('team'), private: await visible('vault') }));
      expect(out).toEqual({
        none: { listed: '2026-01-01:hidden', private: '2026-01-01:hidden' },
        reader: { listed: '2026-01-01:visible', private: '2026-01-01:hidden' },
        stranger: { listed: '2026-01-01:hidden', private: '2026-01-01:hidden' },
        granted: { listed: '2026-01-01:hidden', private: '2026-01-01:visible' },
        readerGranted: { listed: '2026-01-01:visible', private: '2026-01-01:visible' },
      });
      return out;
    },
  );
});
