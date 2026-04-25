import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations, OperationError } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const provenanceErrorMessage = 'put_page content must include at least one non-empty [Source: ...] attribution.';

function pageMarkdown(body: string): string {
  return [
    '---',
    'type: concept',
    'title: Put Page Provenance',
    '---',
    '# Put Page Provenance',
    body,
  ].join('\n');
}

async function withPutPageEngine(
  run: (args: {
    engine: SQLiteEngine;
    putPage: NonNullable<ReturnType<typeof operations.find>>;
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-put-page-provenance-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const putPage = operations.find((operation) => operation.name === 'put_page');

  if (!putPage) {
    throw new Error('put_page operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await run({ engine, putPage });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('put_page rejects durable writes without Source attribution and does not create the page', async () => {
  await withPutPageEngine(async ({ engine, putPage }) => {
    await expect(putPage.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      slug: 'concepts/put-page-without-source',
      content: pageMarkdown('A durable fact without provenance.'),
    })).rejects.toMatchObject({
      name: 'OperationError',
      code: 'invalid_params',
      message: provenanceErrorMessage,
      suggestion: 'Add a provenance citation such as [Source: User, direct message, 2026-04-26 09:00 AM KST] to the compiled truth or timeline before writing durable memory.',
      docs: 'docs/guides/source-attribution.md',
    } satisfies Partial<OperationError>);

    expect(await engine.getPage('concepts/put-page-without-source')).toBeNull();
  });
});

test('put_page rejects blank [Source:    ] attribution and does not create the page', async () => {
  await withPutPageEngine(async ({ engine, putPage }) => {
    await expect(putPage.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      slug: 'concepts/put-page-blank-source',
      content: pageMarkdown('A durable fact with blank provenance. [Source:    ]'),
    })).rejects.toMatchObject({
      name: 'OperationError',
      code: 'invalid_params',
      message: provenanceErrorMessage,
      suggestion: 'Add a provenance citation such as [Source: User, direct message, 2026-04-26 09:00 AM KST] to the compiled truth or timeline before writing durable memory.',
      docs: 'docs/guides/source-attribution.md',
    } satisfies Partial<OperationError>);

    expect(await engine.getPage('concepts/put-page-blank-source')).toBeNull();
  });
});

test('put_page ignores Source attribution in frontmatter when page body has no cited facts', async () => {
  await withPutPageEngine(async ({ engine, putPage }) => {
    await expect(putPage.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      slug: 'concepts/put-page-frontmatter-only-source',
      content: [
        '---',
        'type: concept',
        'title: Put Page Frontmatter Only Source',
        'provenance: "[Source: User, direct message, 2026-04-26 09:00 AM KST]"',
        '---',
        '# Put Page Frontmatter Only Source',
        'A durable fact whose body has no provenance.',
      ].join('\n'),
    })).rejects.toMatchObject({
      name: 'OperationError',
      code: 'invalid_params',
      message: provenanceErrorMessage,
    } satisfies Partial<OperationError>);

    expect(await engine.getPage('concepts/put-page-frontmatter-only-source')).toBeNull();
  });
});

test('put_page accepts a page with a non-empty Source citation', async () => {
  await withPutPageEngine(async ({ engine, putPage }) => {
    const result = await putPage.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      slug: 'concepts/put-page-with-source',
      content: pageMarkdown('A durable fact with provenance. [Source: User, direct message, 2026-04-26 09:00 AM KST]'),
    });

    expect(result).toMatchObject({
      slug: 'concepts/put-page-with-source',
      status: 'created_or_updated',
    });
    expect(await engine.getPage('concepts/put-page-with-source')).not.toBeNull();
  });
});

test('put_page dry-run does not require Source attribution or create the page', async () => {
  await withPutPageEngine(async ({ engine, putPage }) => {
    const result = await putPage.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: true,
    }, {
      slug: 'concepts/put-page-dry-run-without-source',
      content: pageMarkdown('A dry-run preview without durable provenance.'),
    });

    expect(result).toEqual({
      dry_run: true,
      action: 'put_page',
      slug: 'concepts/put-page-dry-run-without-source',
    });
    expect(await engine.getPage('concepts/put-page-dry-run-without-source')).toBeNull();
  });
});
