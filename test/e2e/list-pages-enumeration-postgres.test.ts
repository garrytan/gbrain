import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PAGE_SORT_SQL, type PageInput } from '../../src/core/types.ts';
import {
  getConn,
  getEngine,
  hasDatabase,
  setupDB,
  teardownDB,
} from './helpers.ts';

const skip = !hasDatabase();
const describeIfDB = skip ? describe.skip : describe;

beforeAll(async () => {
  if (skip) return;
  await setupDB();
});

afterAll(async () => {
  if (skip) return;
  await teardownDB();
});

/** Builds a minimal Postgres page fixture with caller-provided frontmatter. */
function pageInput(frontmatter: Record<string, unknown> = {}): PageInput {
  return {
    type: 'note',
    title: 'Example page',
    compiled_truth: 'Generic fixture content.',
    frontmatter,
  };
}

/** Stores a fixture in the requested Postgres source. */
async function putFixture(
  slug: string,
  frontmatter: Record<string, unknown>,
  sourceId = 'default',
): Promise<void> {
  await getEngine().putPage(
    slug,
    pageInput(frontmatter),
    sourceId === 'default' ? undefined : { sourceId },
  );
}

describeIfDB('Postgres listPages exact enumeration', () => {
  test('treats an explicit empty sourceId as a real filter that matches no rows', async () => {
    await putFixture('pages/visible', {});

    expect(await getEngine().listPages({ sourceId: '', sort: 'slug' })).toEqual([]);
  });

  test('slug pagination has deterministic tie-breakers across sources and rows', async () => {
    expect(PAGE_SORT_SQL.slug).toBe('p.slug ASC, p.source_id ASC, p.id ASC');

    await getEngine().executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $2, $3::text::jsonb)`,
      ['team-pagination', 'Team Pagination', JSON.stringify({ federated: false })],
    );
    await putFixture('pagination-tie/shared', {}, 'team-pagination');
    await putFixture('pagination-tie/shared', {}, 'default');

    const pages = await Promise.all([0, 1].map(async (offset) => {
      const [page] = await getEngine().listPages({
        sourceIds: ['default', 'team-pagination'],
        slugPrefix: 'pagination-tie/',
        sort: 'slug',
        limit: 1,
        offset,
      });
      return `${page.source_id}:${page.slug}`;
    }));

    expect(pages).toEqual([
      'default:pagination-tie/shared',
      'team-pagination:pagination-tie/shared',
    ]);
  });

  test('paginates all pages without duplicates or gaps', async () => {
    for (let index = 0; index < 125; index += 1) {
      const slug = `pages/page-${index.toString().padStart(3, '0')}`;
      await getEngine().putPage(slug, pageInput());
    }

    const batches = await Promise.all(
      [0, 40, 80, 120].map((offset) =>
        getEngine().listPages({
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

    const rows = await getEngine().listPages({
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

    const exactRows = await getEngine().listPages({
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
      const rows = await getEngine().listPages({
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
    await getEngine().executeRaw(
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

    const rows = await getEngine().listPages({
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

  test('does not coerce a directly stored numeric field to text', async () => {
    await putFixture('mail/non-string', { subject: '12345' });
    await getConn().unsafe(`
      UPDATE pages
      SET frontmatter = jsonb_build_object('subject', 12345)
      WHERE slug = 'mail/non-string'
    `);

    const rows = await getEngine().listPages({
      frontmatterFilters: [
        { field: 'subject', operator: 'contains_any_ci', values: ['12345'] },
      ],
    });

    expect(rows.some((row) => row.slug === 'mail/non-string')).toBe(false);
  });
});
