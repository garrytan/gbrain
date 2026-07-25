import { describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';

const listPages = operations.find((operation) => operation.name === 'list_pages')!;

function page(index: number) {
  return {
    slug: `page-${index}`,
    source_id: 'default',
    type: 'note',
    title: `Page ${index}`,
    updated_at: new Date('2026-07-25T00:00:00Z'),
  };
}

describe('list_pages pagination contract', () => {
  test('remote callers are capped and receive source ids', async () => {
    let received: Record<string, unknown> | undefined;
    const warnings: string[] = [];
    const ctx = {
      remote: true,
      engine: {
        listPages: async (filters: Record<string, unknown>) => {
          received = filters;
          return Array.from({ length: 101 }, (_, index) => page(index));
        },
      },
      logger: { warn: (message: string) => warnings.push(message) },
    };
    const result = await listPages.handler(ctx as never, { limit: 500, offset: 20 });

    expect(received?.limit).toBe(101);
    expect(received?.offset).toBe(20);
    expect((result as Array<Record<string, unknown>>)).toHaveLength(100);
    expect((result as Array<Record<string, unknown>>)[0]?.source_id).toBe('default');
    expect(warnings.some(message => message.includes('clamped from 500 to 100'))).toBe(true);
  });

  test('trusted local explicit limits are not silently capped at 100', async () => {
    let receivedLimit = 0;
    const ctx = {
      remote: false,
      engine: {
        listPages: async (filters: Record<string, unknown>) => {
          receivedLimit = Number(filters.limit);
          return [page(1)];
        },
      },
      logger: { warn: () => {} },
    };
    await listPages.handler(ctx as never, { limit: 250 });
    expect(receivedLimit).toBe(251);
  });
});
