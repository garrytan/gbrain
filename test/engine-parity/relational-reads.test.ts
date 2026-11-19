/**
 * BrainEngine parity — the relational recall arm's page reads (engine-sql/relational-reads.ts): which resolved seed
 * pages the caller's read policy admits.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readAdmittedPageRefs returns the same (source_id, slug) set on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts): only live, unquarantined pages
 *    of an unarchived source that pass the policy's source scope, private-page filter and trust floor.
 *  - Regression: an engine that admits a seed the policy hides lets a "who works at" query walk the links of a
 *    private, deleted, quarantined, archived, out-of-scope or below-floor page and name what it links to (a leak).
 *    The Rust engine has no SQL, so the statement has to exist as a typed member.
 *  - Why existing coverage misses it: the statement ran through `executeRaw` inside search/relational-recall.ts,
 *    which the parity cases cannot call (D18).
 *  - Seam: none. Typed members only (no executeRaw: D18). Rows are compared sorted, since the SQL sets no order.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageReadPolicy } from '../../src/core/types.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { archiveSource, createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const NOTE = { type: 'company' as const, title: 'Acme example', compiled_truth: 'A company.', timeline: '' };

/** Run `fn` in a transaction whose write trust settings declare `tier`. */
function declared<T>(engine: BrainEngine, tier: string, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], [tier, JSON.stringify({ channel: tier })]);
    return fn(tx);
  });
}

const key = (r: { source_id: string; slug: string }) => `${r.source_id}:${r.slug}`;

describe('engine parity: relational recall page reads', () => {
  parityTest('readAdmittedPageRefs admits only the seeds the read policy lets the caller read', {
    methods: ['putPage', 'softDeletePage', 'transaction', 'applyTransactionSettings', 'readAdmittedPageRefs'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await createSource(engine, backend, 'old');
    await engine.putPage('companies/open', NOTE);
    await engine.putPage('companies/private', { ...NOTE, frontmatter: { visibility: 'private' } });
    await engine.putPage('companies/alice', { ...NOTE, frontmatter: { readable_by: ['member:alice-example'] } });
    await engine.putPage('companies/held', { ...NOTE, frontmatter: { quarantine: { reason: 'test' } } });
    await engine.putPage('companies/gone', NOTE);
    await engine.softDeletePage('companies/gone');
    await declared(engine, 'external_untrusted', tx => tx.putPage('companies/outside', NOTE));
    await engine.putPage('companies/open', NOTE, { sourceId: 'other' });
    await engine.putPage('companies/archived', NOTE, { sourceId: 'old' });
    await archiveSource(engine, backend, 'old');
    const refs = [
      ...['open', 'private', 'alice', 'held', 'gone', 'outside', 'missing', 'open'].map(s => ({ source_id: 'default', slug: `companies/${s}` })),
      { source_id: 'other', slug: 'companies/open' },
      { source_id: 'old', slug: 'companies/archived' },
    ];
    const read = async (policy: PageReadPolicy) => sorted((await engine.readAdmittedPageRefs(refs, policy)).map(key)).filter((k, i, all) => all.indexOf(k) === i);
    const answers = {
      scoped: await read({ sourceId: 'default' }),
      federated: await read({ sourceIds: ['other'] }),
      hidden: await read({ excludePrivate: true }),
      member: await withCallerAccess({ identity: ['member:alice-example'], hidePrivate: true }, () => read({ excludePrivate: true })),
      floor: await read({ minTrust: 'unknown' }),
      holders: await read({ takesHoldersAllowList: [], requireSafeChunks: true }),
      none: await engine.readAdmittedPageRefs([], { sourceId: 'default' }),
    };
    const live = ['default:companies/alice', 'default:companies/open', 'default:companies/outside', 'default:companies/private', 'other:companies/open'];
    expect(answers).toEqual({
      scoped: ['default:companies/alice', 'default:companies/open', 'default:companies/outside', 'default:companies/private'],
      federated: ['other:companies/open'],
      hidden: ['default:companies/open', 'default:companies/outside', 'other:companies/open'],
      member: ['default:companies/alice', 'default:companies/open', 'default:companies/outside', 'other:companies/open'],
      floor: ['default:companies/alice', 'default:companies/open', 'default:companies/private', 'other:companies/open'],
      holders: live,
      none: [],
    });
    return answers;
  });
});
