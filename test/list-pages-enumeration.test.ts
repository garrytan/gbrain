import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PAGE_SORT_SQL, type PageInput } from '../src/core/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** Builds a minimal page fixture with caller-provided frontmatter. */
function pageInput(frontmatter: Record<string, unknown> = {}): PageInput {
  return {
    type: 'note',
    title: 'Example page',
    compiled_truth: 'Generic fixture content.',
    frontmatter,
  };
}

/** Stores a fixture in the requested source. */
async function putFixture(
  slug: string,
  frontmatter: Record<string, unknown>,
  sourceId = 'default',
): Promise<void> {
  await engine.putPage(
    slug,
    pageInput(frontmatter),
    sourceId === 'default' ? undefined : { sourceId },
  );
}

describe('PGLite listPages exact enumeration', () => {
  test('treats an explicit empty sourceId as a real filter that matches no rows', async () => {
    await putFixture('pages/visible', {});

    expect(await engine.listPages({ sourceId: '', sort: 'slug' })).toEqual([]);
  });

  test('slug pagination has deterministic tie-breakers across sources and rows', async () => {
    expect(PAGE_SORT_SQL.slug).toBe('p.slug ASC, p.source_id ASC, p.id ASC');

    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $2, $3::text::jsonb)`,
      ['team-alpha', 'Team Alpha', JSON.stringify({ federated: false })],
    );
    await putFixture('messages/shared', {}, 'team-alpha');
    await putFixture('messages/shared', {}, 'default');

    const pages = await Promise.all([0, 1].map(async (offset) => {
      const [page] = await engine.listPages({
        sourceIds: ['default', 'team-alpha'],
        sort: 'slug',
        limit: 1,
        offset,
      });
      return `${page.source_id}:${page.slug}`;
    }));

    expect(pages).toEqual([
      'default:messages/shared',
      'team-alpha:messages/shared',
    ]);
  });

  test('paginates all pages without duplicates or gaps', async () => {
    for (let index = 0; index < 125; index += 1) {
      const slug = `pages/page-${index.toString().padStart(3, '0')}`;
      await engine.putPage(slug, pageInput());
    }

    const batches = await Promise.all(
      [0, 40, 80, 120].map((offset) =>
        engine.listPages({
          slugPrefix: 'pages/page-',
          limit: 40,
          offset,
          sort: 'slug',
        }),
      ),
    );
    const slugs = batches.flat().map((page) => page.slug);

    expect(slugs).toHaveLength(125);
    expect(new Set(slugs).size).toBe(125);
    expect(slugs).toEqual([...slugs].sort());
  });

  test('ANDs clauses and ORs contains_any_ci needles while rejecting non-string fields', async () => {
    await putFixture('messages/matching-pending', {
      from_address: 'sender@example.com',
      subject: 'Space Pending review',
    });
    await putFixture('messages/matching-rolling', {
      from_address: 'Sender@Example.Com',
      subject: 'Rolling schedule update',
    });
    await putFixture('messages/wrong-address', {
      from_address: 'other@example.com',
      subject: 'Space Pending review',
    });
    await putFixture('messages/wrong-subject', {
      from_address: 'sender@example.com',
      subject: 'Final schedule',
    });
    await putFixture('messages/missing-value', {
      from_address: 'sender@example.com',
    });
    await putFixture('messages/null-value', {
      from_address: 'sender@example.com',
      subject: null,
    });
    await putFixture('messages/object-value', {
      from_address: 'sender@example.com',
      subject: { text: 'Space Pending' },
    });
    await putFixture('messages/array-value', {
      from_address: 'sender@example.com',
      subject: ['Space Pending'],
    });
    await putFixture('messages/boolean-value', {
      from_address: 'sender@example.com',
      subject: true,
    });
    await putFixture('messages/numeric-value', {
      from_address: 'sender@example.com',
      subject: 123,
    });

    const rows = await engine.listPages({
      sort: 'slug',
      limit: 100,
      frontmatterFilters: [
        { field: 'from_address', operator: 'eq_ci', value: 'SENDER@EXAMPLE.COM' },
        {
          field: 'subject',
          operator: 'contains_any_ci',
          values: ['space pending', 'rolling'],
        },
      ],
    });

    expect(rows.map((row) => row.slug)).toEqual([
      'messages/matching-pending',
      'messages/matching-rolling',
    ]);
  });

  test('treats quotes, percent, underscore, backslashes, and Unicode literally', async () => {
    const subjects = [
      ['special/backslash', String.raw`Path C:\Temp\file`],
      ['special/backslash-near', 'Path C:/Temp/file'],
      ['special/percent', 'Progress 100% complete'],
      ['special/percent-near', 'Progress 1000 complete'],
      ['special/quote', `Status 'ready' \"now\"`],
      ['special/quote-near', 'Status ready now'],
      ['special/underscore', 'under_score'],
      ['special/underscore-near', 'underXscore'],
      ['special/unicode', 'Launch in 東京'],
      ['special/unicode-near', 'Launch in 京東'],
    ] as const;

    for (const [slug, subject] of subjects) {
      await putFixture(slug, { subject });
    }
    await putFixture('special/exact', {
      from_address: String.raw`sender+100%_test\東京@example.com`,
    });
    await putFixture('special/exact-near', {
      from_address: String.raw`sender+100X_test\東京@example.com`,
    });

    const exactRows = await engine.listPages({
      sort: 'slug',
      limit: 100,
      frontmatterFilters: [
        {
          field: 'from_address',
          operator: 'eq_ci',
          value: String.raw`SENDER+100%_TEST\東京@EXAMPLE.COM`,
        },
      ],
    });
    expect(exactRows.map((row) => row.slug)).toEqual(['special/exact']);

    const cases = [
      [String.raw`C:\Temp`, 'special/backslash'],
      ['100%', 'special/percent'],
      [`'ready' \"now\"`, 'special/quote'],
      ['under_score', 'special/underscore'],
      ['東京', 'special/unicode'],
    ] as const;

    for (const [needle, expectedSlug] of cases) {
      const rows = await engine.listPages({
        sort: 'slug',
        limit: 100,
        frontmatterFilters: [
          { field: 'subject', operator: 'contains_any_ci', values: [needle] },
        ],
      });
      expect(rows.map((row) => row.slug)).toEqual([expectedSlug]);
    }
  });

  test('composes source and slug prefix with frontmatter clauses', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $2, $3::text::jsonb)`,
      ['team-alpha', 'Team Alpha', JSON.stringify({ federated: false })],
    );

    const matching = { from_address: 'sender@example.com' };
    await putFixture('messages/default-match', matching);
    await putFixture('messages/team-match', matching, 'team-alpha');
    await putFixture('archive/team-match', matching, 'team-alpha');
    await putFixture(
      'messages/team-wrong-frontmatter',
      { from_address: 'other@example.com' },
      'team-alpha',
    );

    const rows = await engine.listPages({
      sourceId: 'team-alpha',
      slugPrefix: 'messages/',
      sort: 'slug',
      limit: 100,
      frontmatterFilters: [
        { field: 'from_address', operator: 'eq_ci', value: 'SENDER@EXAMPLE.COM' },
      ],
    });

    expect(rows.map((row) => row.slug)).toEqual(['messages/team-match']);
  });
});
