/**
 * BrainEngine parity: reads a fail-soft caller used to run as raw SQL on the search, put and entity paths. On a Rust
 * brain each was refused, the caller's catch took its fallback, and the answer still looked whole: a put kept no
 * ignored-label notice, a typed search found nothing, an entity question lost its saved facts or anchored pages, a long
 * page came back at snippet size, and an entity miss lost its text mentions.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    each caller below gives the answer PGLite gives, through a typed engine member.
 *  - Regression: a caller that reads through executeRaw inside a catch drops its notice, filter fallback, facts, anchor,
 *    long-page plan or mentions on Rust while every arm still answers.
 *  - Why existing coverage misses it: the census compares outputs only for the fixture's default config, and the member
 *    parity files test members, not these callers.
 *  - Seam: none. Pages are written with `putPage`; the callers run as production code.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { Notice } from '../../src/core/agent-output.ts';
import { withIgnoredPrivacyLabelNotice } from '../../src/core/search/ignored-privacy-labels.ts';
import { reconcileTypeFilter } from '../../src/core/ops/search-type-filter.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const note = (title: string, frontmatter: Record<string, unknown> = {}, body = `${title}.`) => ({
  type: 'note' as const, title, compiled_truth: body, timeline: '', frontmatter,
});

describe('engine parity: fail-soft reads on the search, put and entity paths', () => {
  parityTest('readLivePageFrontmatter answers the live page type and frontmatter, and null for a gone or missing page', {
    methods: ['putPage', 'softDeletePage', 'readLivePageFrontmatter'],
  }, async (engine) => {
    await engine.putPage('notes/labelled', note('Labelled', { access: 'maybe', tags: ['x'] }));
    await engine.putPage('notes/gone', note('Gone', { access: 'maybe' }));
    await engine.softDeletePage('notes/gone');
    const live = await engine.readLivePageFrontmatter(SRC, 'notes/labelled');
    const answer = {
      live: live && { type: live.type, access: live.frontmatter?.access },
      gone: await engine.readLivePageFrontmatter(SRC, 'notes/gone'),
      missing: await engine.readLivePageFrontmatter(SRC, 'notes/never-written'),
      otherSource: await engine.readLivePageFrontmatter('elsewhere', 'notes/labelled'),
    };
    expect(answer).toEqual({ live: { type: 'note', access: 'maybe' }, gone: null, missing: null, otherSource: null });
    return answer;
  });

  parityTest('a put that stores an access label gbrain does not recognize gets the ignored-label notice', {
    methods: ['putPage', 'readLivePageFrontmatter', 'getSource', 'getConfig'],
  }, async (engine) => {
    const content = '---\ntype: note\ntitle: Census label\naccess: maybe\n---\nCensus body.\n';
    await engine.putPage('notes/census-label', note('Census label', { access: 'maybe' }, 'Census body.'));
    const notices: Notice[] = [];
    const ctx = { engine, emitNotice: (n: Notice) => { notices.push(n); } } as unknown as Parameters<typeof withIgnoredPrivacyLabelNotice>[0];
    const result = await withIgnoredPrivacyLabelNotice(ctx, SRC, { slug: 'notes/census-label', content },
      { status: 'created_or_updated', slug: 'notes/census-label' });
    const answer = { result, codes: notices.map(n => n.code), namesValue: notices.some(n => JSON.stringify(n).includes('maybe')) };
    expect(answer).toEqual({ result: { status: 'created_or_updated', slug: 'notes/census-label' }, codes: ['privacy_label_ignored'], namesValue: true });
    return answer;
  });

  parityTest('probePageTypes reports each type set among live pages, and lists the types only when a set has none', {
    methods: ['putPage', 'softDeletePage', 'probePageTypes'],
  }, async (engine) => {
    await engine.putPage('people/probe-a', { ...note('Probe person'), type: 'person' });
    await engine.putPage('notes/probe-a', note('Probe note'));
    await engine.putPage('memos/probe-gone', { ...note('Probe memo'), type: 'memo' as 'note' });
    await engine.softDeletePage('memos/probe-gone');
    const sorted = (p: { present: boolean[]; available: string[] | null }) => ({ ...p, available: p.available && [...p.available].sort() });
    const answer = {
      hit: sorted(await engine.probePageTypes([['person'], []], { sourceId: SRC })),
      miss: sorted(await engine.probePageTypes([['person'], ['memo', 'deal']], { sourceId: SRC })),
      otherSource: sorted(await engine.probePageTypes([['person']], { sourceId: 'elsewhere' })),
    };
    expect(answer).toEqual({
      hit: { present: [true, false], available: null },
      miss: { present: [true, false], available: ['note', 'person'] },
      otherSource: { present: [false], available: [] },
    });
    return answer;
  });

  parityTest('a typed search on a type no page has drops the filter, searches every type and names the types there are', {
    methods: ['putPage', 'probePageTypes'],
  }, async (engine) => {
    await engine.putPage('people/typed-a', { ...note('Typed person'), type: 'person' });
    await engine.putPage('notes/typed-a', note('Typed note'));
    const ctx = { engine, remote: false } as unknown as OperationContext;
    const answer = {
      dropped: await reconcileTypeFilter(ctx, { sourceId: SRC }, false, ['nosuchtype']),
      narrowed: await reconcileTypeFilter(ctx, { sourceId: SRC }, false, ['person', 'nosuchtype']),
      kept: await reconcileTypeFilter(ctx, { sourceId: SRC }, false, ['note']),
    };
    expect(answer).toEqual({
      dropped: { types: undefined, notice: 'No pages have type nosuchtype, so the type filter was dropped and every page type was searched. Page types in this brain: note, person.' },
      narrowed: { types: ['person'], notice: 'No pages have type nosuchtype; filtered to person. Page types in this brain: note, person.' },
      kept: { types: ['note'] },
    });
    return answer;
  });
});
