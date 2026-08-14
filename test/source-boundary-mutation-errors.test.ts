import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

type StoredPage = { slug: string; source_id: string; deleted?: boolean };

function fakeEngine(
  pages: StoredPage[],
  behavior: {
    addLink?: () => void;
    addTimelineEntry?: () => void;
  } = {},
) {
  let addLinkCalls = 0;
  let addTimelineCalls = 0;
  const engine = {
    async getPage(
      slug: string,
      opts: { sourceId?: string; sourceIds?: string[]; includeDeleted?: boolean } = {},
    ) {
      const sources = opts.sourceIds ?? (opts.sourceId ? [opts.sourceId] : []);
      const page = pages.find(
        (candidate) =>
          candidate.slug === slug &&
          sources.includes(candidate.source_id) &&
          (opts.includeDeleted === true || candidate.deleted !== true),
      );
      return page ? ({ ...page } as any) : null;
    },
    async addLink() {
      addLinkCalls += 1;
      behavior.addLink?.();
    },
    async addTimelineEntry() {
      addTimelineCalls += 1;
      behavior.addTimelineEntry?.();
      return 1;
    },
  } as unknown as BrainEngine;
  return {
    engine,
    get addLinkCalls() {
      return addLinkCalls;
    },
    get addTimelineCalls() {
      return addTimelineCalls;
    },
  };
}

function auth(allowedSources: string[]) {
  return {
    token: 'test-token',
    clientId: 'test-client',
    scopes: [],
    allowedSources,
  } as any;
}

function payload(result: Awaited<ReturnType<typeof dispatchToolCall>>) {
  return JSON.parse(result.content[0]!.text);
}

describe('same-source mutation diagnostics', () => {
  test('add_link identifies a visible foreign to endpoint', async () => {
    const state = fakeEngine([
      { slug: 'meetings/example-call', source_id: 'shared' },
      { slug: 'companies/example-com', source_id: 'internal' },
    ]);

    const result = await dispatchToolCall(
      state.engine,
      'add_link',
      {
        from: 'meetings/example-call',
        to: 'companies/example-com',
        link_type: 'meeting_with',
        link_source: 'manual',
      },
      {
        remote: true,
        sourceId: 'shared',
        auth: auth(['shared', 'internal']),
      },
    );

    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      error: 'permission_denied',
      message:
        'add_link to page "companies/example-com" is readable from source "internal" but this client writes to source "shared".',
    });
    expect(state.addLinkCalls).toBe(0);
  });

  test('add_link identifies a visible foreign from endpoint', async () => {
    const state = fakeEngine([
      { slug: 'meetings/example-call', source_id: 'internal' },
      { slug: 'companies/example-com', source_id: 'shared' },
    ]);

    const result = await dispatchToolCall(
      state.engine,
      'add_link',
      {
        from: 'meetings/example-call',
        to: 'companies/example-com',
        link_type: 'meeting_with',
        link_source: 'manual',
      },
      {
        remote: true,
        sourceId: 'shared',
        auth: auth(['shared', 'internal']),
      },
    );

    expect(result.isError).toBe(true);
    expect(payload(result).message).toContain('add_link from page "meetings/example-call"');
    expect(state.addLinkCalls).toBe(0);
  });

  test('add_link does not disclose a foreign page outside the read grant', async () => {
    const state = fakeEngine([
      { slug: 'meetings/example-call', source_id: 'shared' },
      { slug: 'companies/example-com', source_id: 'internal' },
    ]);

    const result = await dispatchToolCall(
      state.engine,
      'add_link',
      {
        from: 'meetings/example-call',
        to: 'companies/example-com',
        link_type: 'meeting_with',
        link_source: 'manual',
      },
      {
        remote: true,
        sourceId: 'shared',
        auth: auth(['shared']),
      },
    );

    expect(result.isError).toBe(true);
    expect(payload(result)).toEqual({
      error: 'page_not_found',
      message:
        'add_link to page "companies/example-com" was not found in writable source "shared".',
    });
    expect(result.content[0]!.text).not.toContain('internal');
    expect(state.addLinkCalls).toBe(0);
  });

  test('add_timeline_entry reports a visible source boundary', async () => {
    const state = fakeEngine([
      { slug: 'companies/example-com', source_id: 'internal' },
    ]);

    const result = await dispatchToolCall(
      state.engine,
      'add_timeline_entry',
      {
        slug: 'companies/example-com',
        date: '2026-08-14',
        summary: 'Reviewed next steps.',
      },
      {
        remote: true,
        sourceId: 'shared',
        auth: auth(['shared', 'internal']),
      },
    );

    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      error: 'permission_denied',
      message:
        'add_timeline_entry page "companies/example-com" is readable from source "internal" but this client writes to source "shared".',
    });
    expect(state.addTimelineCalls).toBe(0);
  });

  test('same-source mutations still reach the engine', async () => {
    const state = fakeEngine([
      { slug: 'meetings/example-call', source_id: 'shared' },
      { slug: 'companies/example-com', source_id: 'shared' },
    ]);

    const linkResult = await dispatchToolCall(
      state.engine,
      'add_link',
      {
        from: 'meetings/example-call',
        to: 'companies/example-com',
        link_type: 'meeting_with',
        link_source: 'manual',
      },
      { remote: true, sourceId: 'shared', auth: auth(['shared', 'internal']) },
    );
    const timelineResult = await dispatchToolCall(
      state.engine,
      'add_timeline_entry',
      {
        slug: 'companies/example-com',
        date: '2026-08-14',
        summary: 'Reviewed next steps.',
      },
      { remote: true, sourceId: 'shared', auth: auth(['shared', 'internal']) },
    );

    expect(linkResult.isError).toBeUndefined();
    expect(timelineResult.isError).toBeUndefined();
    expect(state.addLinkCalls).toBe(1);
    expect(state.addTimelineCalls).toBe(1);
  });

  test('soft-deleted pages in the write source preserve existing graph mutation behavior', async () => {
    const state = fakeEngine([
      { slug: 'meetings/example-call', source_id: 'shared', deleted: true },
      { slug: 'companies/example-com', source_id: 'shared', deleted: true },
    ]);

    const result = await dispatchToolCall(
      state.engine,
      'add_link',
      {
        from: 'meetings/example-call',
        to: 'companies/example-com',
        link_type: 'meeting_with',
        link_source: 'manual',
      },
      { remote: true, sourceId: 'shared', auth: auth(['shared', 'internal']) },
    );

    expect(result.isError).toBeUndefined();
    expect(state.addLinkCalls).toBe(1);
  });

  test('a deleted foreign page is not disclosed as a visible source boundary', async () => {
    const state = fakeEngine([
      { slug: 'meetings/example-call', source_id: 'shared' },
      { slug: 'companies/example-com', source_id: 'internal', deleted: true },
    ]);

    const result = await dispatchToolCall(
      state.engine,
      'add_link',
      {
        from: 'meetings/example-call',
        to: 'companies/example-com',
        link_type: 'meeting_with',
        link_source: 'manual',
      },
      {
        remote: true,
        sourceId: 'shared',
        auth: auth(['shared', 'internal']),
      },
    );

    expect(payload(result)).toMatchObject({ error: 'page_not_found' });
    expect(result.content[0]!.text).not.toContain('internal');
    expect(state.addLinkCalls).toBe(0);
  });

  test('add_link reclassifies an endpoint deleted after preflight', async () => {
    const pages: StoredPage[] = [
      { slug: 'meetings/example-call', source_id: 'shared' },
      { slug: 'companies/example-com', source_id: 'shared' },
    ];
    const state = fakeEngine(pages, {
      addLink: () => {
        pages.splice(
          pages.findIndex((page) => page.slug === 'companies/example-com'),
          1,
        );
        throw new Error(
          'addLink failed: to page "companies/example-com" (source=shared) not found',
        );
      },
    });

    const result = await dispatchToolCall(
      state.engine,
      'add_link',
      {
        from: 'meetings/example-call',
        to: 'companies/example-com',
        link_type: 'meeting_with',
        link_source: 'manual',
      },
      { remote: true, sourceId: 'shared', auth: auth(['shared']) },
    );

    expect(payload(result)).toEqual({
      error: 'page_not_found',
      message:
        'add_link to page "companies/example-com" was not found in writable source "shared".',
    });
    expect(state.addLinkCalls).toBe(1);
  });

  test('add_timeline_entry reclassifies a page deleted after preflight', async () => {
    const pages: StoredPage[] = [
      { slug: 'companies/example-com', source_id: 'shared' },
    ];
    const state = fakeEngine(pages, {
      addTimelineEntry: () => {
        pages.length = 0;
        throw new Error(
          'addTimelineEntry failed: page "companies/example-com" (source=shared) not found',
        );
      },
    });

    const result = await dispatchToolCall(
      state.engine,
      'add_timeline_entry',
      {
        slug: 'companies/example-com',
        date: '2026-08-14',
        summary: 'Reviewed next steps.',
      },
      { remote: true, sourceId: 'shared', auth: auth(['shared']) },
    );

    expect(payload(result)).toEqual({
      error: 'page_not_found',
      message:
        'add_timeline_entry page "companies/example-com" was not found in writable source "shared".',
    });
    expect(state.addTimelineCalls).toBe(1);
  });
});
