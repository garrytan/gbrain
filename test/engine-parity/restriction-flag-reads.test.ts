/**
 * BrainEngine parity — `excludePrivate` reads for a remote caller whose record follows the brain's member-access flag.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a remote request builds its caller record with `restricted` equal to the brain's sticky flag
 *    (`accessRestrictionsPresent`, config access.restrictions_present). On a brain that never held a `readable_by`
 *    page the flag is unset, the record is `restricted: false`, and the reads render the short member-access form. On
 *    a brain that once held one the flag is '1' (on the Rust arm too: its page write sets the flag), the record is
 *    `restricted: true`, and the reads render the full form. On both brains, on every engine arm, a plain caller reads
 *    the open page and not the private one; on the second brain it also reads the page that dropped its readers and
 *    not the page that still names them.
 *    A caller record built under `restricted: false` on a brain that holds a `readable_by` page (a stale flag read)
 *    renders the short form, which hides every page that names readers, the caller's own included; the Rust store
 *    reads its own flag, finds it set and hides the same pages.
 *  - Regression: the Rust member compared the short form with the full form and refused a `restricted: false` caller,
 *    so the never-held brain stopped on a typed refusal on the Rust arm (an earlier fix read such a caller as
 *    `restricted: true`, which ignored the store's own flag). The member now sends the short form as `open`, and the
 *    store's flag decides what it adds.
 *  - Why existing coverage misses it: unrestricted-caller-reads.test.ts sets `restricted` by hand and writes no
 *    `readable_by` page; access-flag.test.ts reads the flag and no page through it.
 *  - Seam: none. Real engines, typed methods only; the caller record takes its `restricted` value from the flag read.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { accessRestrictionsPresent, withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

const OPEN = 'notes/open';
const PRIVATE = 'notes/private';
const DROPPED = 'notes/dropped-readers';
const READERS = 'notes/named-readers';
const NOTE = { type: 'note' as const, timeline: '' };

async function page(engine: BrainEngine, slug: string, frontmatter: Record<string, unknown>) {
  await engine.putPage(slug, { ...NOTE, title: slug, compiled_truth: `About ${slug}.`, frontmatter });
  await engine.addTimelineEntry(slug, { date: '2026-06-18', summary: `${slug} row` });
}

async function facts(engine: BrainEngine, slugs: string[]) {
  await engine.insertFacts(slugs.map((slug, i) => ({
    fact: `from ${slug}`, entity_slug: null, source_markdown_slug: slug, row_num: i + 1, kind: 'fact', visibility: 'world', source: 'fence',
  })) as never, { source_id: 'default' });
}

/** The reads under the record a remote request builds: `restricted` follows the flag, no identity, private hidden. */
async function readAsRemote(engine: BrainEngine) {
  const restricted = await accessRestrictionsPresent(engine);
  const reads = await withCallerAccess({ restricted, hidePrivate: true }, async () => ({
    salience: sorted((await engine.getRecentSalience({ days: 7, limit: 100, excludePrivate: true })).map((r) => r.slug)),
    orphans: sorted((await engine.findOrphanPages({ excludePrivate: true })).map((r) => r.slug)),
    since: sorted((await engine.getSince('2026-06-18', { excludePrivate: true })).map((r) => r.page_slug)),
    facts: sorted((await engine.listUnattributedFacts({ sourceIds: ['default'], worldOnly: false, excludePrivateProvenance: true, limit: 10, offset: 0 }))
      .map((r) => r.fact)),
  }));
  return { restricted, ...reads };
}

describe('engine parity: excludePrivate reads for a remote caller whose record follows the member-access flag', () => {
  parityTest('a brain that never held a readable_by page reads under the short form and hides the private page', { methods: ['putPage', 'addTimelineEntry', 'insertFacts', 'getConfig', 'getRecentSalience', 'findOrphanPages', 'getSince', 'listUnattributedFacts'] }, async (engine) => {
    await page(engine, OPEN, {});
    await page(engine, PRIVATE, { visibility: 'private' });
    await facts(engine, [OPEN, PRIVATE]);
    const kept = await readAsRemote(engine);
    expect(kept.restricted).toBe(false);
    expect(kept.salience).toEqual([OPEN]);
    expect(kept.orphans).toEqual([OPEN]);
    expect(kept.since).toEqual([OPEN]);
    expect(kept.facts).toEqual([`from ${OPEN}`]);
    return kept;
  });

  parityTest('a brain that once held a readable_by page reads under the full form and still applies the named readers', { methods: ['putPage', 'addTimelineEntry', 'insertFacts', 'getConfig', 'getRecentSalience', 'findOrphanPages', 'getSince', 'listUnattributedFacts'] }, async (engine) => {
    await page(engine, OPEN, {});
    await page(engine, PRIVATE, { visibility: 'private' });
    await engine.putPage(DROPPED, { ...NOTE, title: DROPPED, compiled_truth: 'Named readers once.', frontmatter: { readable_by: ['alice-example'] } });
    await page(engine, DROPPED, {});
    await page(engine, READERS, { readable_by: ['alice-example'] });
    await facts(engine, [OPEN, PRIVATE, DROPPED, READERS]);
    const kept = await readAsRemote(engine);
    expect(kept.restricted).toBe(true);
    const visible = sorted([OPEN, DROPPED]);
    expect(kept.salience).toEqual(visible);
    expect(kept.orphans).toEqual(visible);
    expect(kept.since).toEqual(visible);
    expect(JSON.stringify(kept)).not.toContain(PRIVATE);
    expect(JSON.stringify(kept)).not.toContain(READERS);
    return kept;
  });

  // A caller record built while the flag read unset (a stale read, or a brain whose flag an operator cleared) on a
  // brain that holds a readable_by page: PGLite and Postgres render the short form, which hides every page that names
  // readers, even one that names the caller. The Rust store reads its own flag, finds it set and hides the same pages.
  parityTest('a caller read under the short form on a brain that holds readable_by pages sees none of them', { methods: ['putPage', 'addTimelineEntry', 'insertFacts', 'getRecentSalience', 'findOrphanPages', 'getSince', 'listUnattributedFacts'] }, async (engine) => {
    await page(engine, OPEN, {});
    await page(engine, PRIVATE, { visibility: 'private' });
    await page(engine, READERS, { readable_by: ['member:alice-example'] });
    await facts(engine, [OPEN, PRIVATE, READERS]);
    const reads = async () => ({
      salience: sorted((await engine.getRecentSalience({ days: 7, limit: 100, excludePrivate: true })).map((r) => r.slug)),
      orphans: sorted((await engine.findOrphanPages({ excludePrivate: true })).map((r) => r.slug)),
      since: sorted((await engine.getSince('2026-06-18', { excludePrivate: true })).map((r) => r.page_slug)),
      facts: sorted((await engine.listUnattributedFacts({ sourceIds: ['default'], worldOnly: false, excludePrivateProvenance: true, limit: 10, offset: 0 }))
        .map((r) => r.fact)),
    });
    const plain = await withCallerAccess({ restricted: false, hidePrivate: true }, reads);
    const named = await withCallerAccess({ restricted: false, hidePrivate: true, identity: ['member:alice-example'] }, reads);
    for (const kept of [plain, named]) {
      expect(kept.salience).toEqual([OPEN]);
      expect(kept.orphans).toEqual([OPEN]);
      expect(kept.since).toEqual([OPEN]);
      expect(kept.facts).toEqual([`from ${OPEN}`]);
    }
    return { plain, named };
  });
});
