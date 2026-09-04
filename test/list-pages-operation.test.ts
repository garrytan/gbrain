import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  OperationError,
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import type { Page, PageFilters } from '../src/core/types.ts';

/** Builds one complete page returned by the engine stub. */
function fixturePage(overrides: Partial<Page> = {}): Page {
  return {
    id: 1,
    slug: 'mail/example',
    type: 'note',
    title: 'Example message',
    compiled_truth: 'Fixture body',
    timeline: '',
    frontmatter: {
      email_id: 'message-1',
      subject: 'Rolling update',
      hidden: 'not projected',
    },
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-02T00:00:00.000Z'),
    source_id: 'default',
    ...overrides,
  };
}

/** Creates an operation context that records every listPages filter. */
function contextWith(
  pages: Page[],
  calls: Array<PageFilters | undefined>,
  warnings: string[] = [],
  overrides: Partial<OperationContext> = {},
): OperationContext {
  const engine = {
    listPages: async (filters?: PageFilters) => {
      calls.push(filters);
      return pages;
    },
  } as unknown as BrainEngine;
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: {
      info: () => {},
      warn: (message: string) => warnings.push(message),
      error: () => {},
    },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

describe('list_pages exact enumeration operation', () => {
  test('threads exact filters while preserving trusted-local limits and the truncation probe', async () => {
    const calls: Array<PageFilters | undefined> = [];
    const ctx = contextWith([fixturePage({ source_id: 'email' })], calls, [], {
      localFederatedSourceIds: ['default', 'email'],
    });

    await operationsByName.list_pages.handler(ctx, {
      source_id: 'email',
      offset: 100,
      slug_prefix: 'mail/',
      frontmatter_filters: [
        { field: 'from_address', operator: 'eq_ci', value: 'sender@example.com' },
      ],
      sort: 'slug',
      limit: 1000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sourceId: 'email',
      offset: 100,
      slugPrefix: 'mail/',
      frontmatterFilters: [
        { field: 'from_address', operator: 'eq_ci', value: 'sender@example.com' },
      ],
      sort: 'slug',
      limit: 1001,
    });
    expect(calls[0]?.sourceIds).toBeUndefined();
  });

  test('keeps unqualified local listing on the federated visibility set', async () => {
    const calls: Array<PageFilters | undefined> = [];
    await operationsByName.list_pages.handler(
      contextWith([], calls, [], { localFederatedSourceIds: ['default', 'email'] }),
      {},
    );

    expect(calls[0]).toMatchObject({ sourceIds: ['default', 'email'], limit: 51 });
    expect(calls[0]?.sourceId).toBeUndefined();
  });

  test('retains source_id and projects only requested frontmatter fields', async () => {
    const calls: Array<PageFilters | undefined> = [];
    const result = await operationsByName.list_pages.handler(
      contextWith([fixturePage({ source_id: 'email' })], calls),
      { frontmatter_fields: ['email_id', 'subject'] },
    );

    expect(result).toEqual([{
      slug: 'mail/example',
      source_id: 'email',
      type: 'note',
      title: 'Example message',
      updated_at: new Date('2026-01-02T00:00:00.000Z'),
      frontmatter: {
        email_id: 'message-1',
        subject: 'Rolling update',
      },
    }]);
  });

  test('rejects malformed enumeration input before calling the engine', async () => {
    for (const params of [
      { offset: -1 },
      { source_id: '' },
      { source_id: '   ' },
      { source_id: 42 },
      { slug_prefix: 42 },
      { frontmatter_fields: ['nested.field'] },
    ]) {
      const calls: Array<PageFilters | undefined> = [];
      await expect(
        operationsByName.list_pages.handler(contextWith([], calls), params),
      ).rejects.toMatchObject({ code: 'invalid_params' } satisfies Partial<OperationError>);
      expect(calls).toHaveLength(0);
    }
  });

  test('rejects a remote explicit source outside a federated grant', async () => {
    const calls: Array<PageFilters | undefined> = [];
    await expect(
      operationsByName.list_pages.handler(
        contextWith([], calls, [], {
          remote: true,
          sourceId: 'allowed-source',
          auth: { allowedSources: ['allowed-source'] } as OperationContext['auth'],
        }),
        { source_id: 'other-source' },
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' } satisfies Partial<OperationError>);
    expect(calls).toHaveLength(0);
  });

  test('preserves the remote 100-row cap and one-row truncation probe', async () => {
    const calls: Array<PageFilters | undefined> = [];
    const warnings: string[] = [];
    await operationsByName.list_pages.handler(
      contextWith([], calls, warnings, { remote: true }),
      { limit: 1000 },
    );

    expect(calls[0]?.limit).toBe(101);
    expect(warnings).toEqual([
      '[gbrain] Warning: list limit clamped from 1000 to 100; use offset to paginate',
    ]);
  });
});
