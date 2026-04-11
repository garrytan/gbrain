import { describe, test, expect } from 'bun:test';
import { operationsByName, OperationError } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// Mock engine that tracks calls and supports transaction()
function mockEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine & { _calls: { method: string; args: any[] }[] } {
  const calls: { method: string; args: any[] }[] = [];
  const track = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    if (overrides[method]) return overrides[method](...args);
    return Promise.resolve(null);
  };

  const engine = new Proxy({} as any, {
    get(_, prop: string) {
      if (prop === '_calls') return calls;
      if (prop === 'getTags') return overrides.getTags || (() => Promise.resolve([]));
      if (prop === 'getPage') return overrides.getPage || (() => Promise.resolve(null));
      if (prop === 'transaction') return async (fn: (tx: BrainEngine) => Promise<any>) => fn(engine);
      return track(prop);
    },
  });
  return engine as any;
}

function makeCtx(engine: BrainEngine, dryRun = false): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun,
  };
}

describe('learn operation', () => {
  const learn = operationsByName['learn'];

  test('operation exists and is mutating', () => {
    expect(learn).toBeDefined();
    expect(learn.mutating).toBe(true);
  });

  test('dryRun returns without side effects', async () => {
    const engine = mockEngine();
    const result = await learn.handler(makeCtx(engine, true), { content: 'test', slug: 'test-slug' }) as any;
    expect(result.dry_run).toBe(true);
    expect(result.action).toBe('learn');
    expect(engine._calls.length).toBe(0);
  });

  test('empty content throws validation_error', async () => {
    const engine = mockEngine();
    await expect(learn.handler(makeCtx(engine), { content: '' })).rejects.toThrow('content is required');
    await expect(learn.handler(makeCtx(engine), { content: '   ' })).rejects.toThrow('content is required');
  });

  test('CREATE mode: new page when slug not found', async () => {
    const engine = mockEngine();
    const result = await learn.handler(makeCtx(engine), {
      content: 'Alice prefers staging deploys',
      slug: 'people/alice',
      title: 'Alice',
    }) as any;

    expect(result.status).toBe('created');
    expect(result.slug).toBe('people/alice');
    expect(result.chunks).toBeGreaterThan(0);

    const putCall = engine._calls.find(c => c.method === 'putPage');
    expect(putCall).toBeTruthy();
    expect(putCall!.args[0]).toBe('people/alice');
    expect(putCall!.args[1].compiled_truth).toBe('Alice prefers staging deploys');
    expect(putCall!.args[1].title).toBe('Alice');
    expect(putCall!.args[1].type).toBe('concept');

    const tagCalls = engine._calls.filter(c => c.method === 'addTag');
    expect(tagCalls.some(c => c.args[1] === 'source:conversation')).toBe(true);
  });

  test('APPEND mode: appends to existing page', async () => {
    const engine = mockEngine({
      getPage: () => Promise.resolve({
        slug: 'people/alice',
        type: 'person',
        title: 'Alice',
        compiled_truth: 'Alice is on the backend team.',
        timeline: '',
        frontmatter: {},
        content_hash: 'old-hash',
      }),
    });

    const result = await learn.handler(makeCtx(engine), {
      content: 'Alice moved to frontend.',
      slug: 'people/alice',
    }) as any;

    expect(result.status).toBe('appended');
    expect(result.slug).toBe('people/alice');

    const putCall = engine._calls.find(c => c.method === 'putPage');
    expect(putCall).toBeTruthy();
    expect(putCall!.args[1].compiled_truth).toContain('Alice is on the backend team.');
    expect(putCall!.args[1].compiled_truth).toContain('Alice moved to frontend.');

    // Version created before overwrite
    const versionCall = engine._calls.find(c => c.method === 'createVersion');
    expect(versionCall).toBeTruthy();
  });

  test('auto-slug from title when no slug provided', async () => {
    const engine = mockEngine();
    const result = await learn.handler(makeCtx(engine), {
      content: 'Some fact about deployment',
      title: 'Deployment Process',
    }) as any;

    expect(result.status).toBe('created');
    expect(result.slug).toBe('learned/deployment-process');
  });

  test('auto-slug from content when no slug or title', async () => {
    const engine = mockEngine();
    const result = await learn.handler(makeCtx(engine), {
      content: 'Alice prefers staging deploys before production',
    }) as any;

    expect(result.status).toBe('created');
    // slug derived from first 60 chars of content
    expect(result.slug).toStartWith('learned/');
    expect(result.slug.length).toBeGreaterThan('learned/'.length);
  });

  test('custom source tag overrides default', async () => {
    const engine = mockEngine();
    await learn.handler(makeCtx(engine), {
      content: 'Fact from Slack',
      slug: 'notes/slack-facts',
      source: 'slack',
    });

    const tagCalls = engine._calls.filter(c => c.method === 'addTag');
    expect(tagCalls.some(c => c.args[1] === 'source:slack')).toBe(true);
    expect(tagCalls.some(c => c.args[1] === 'source:conversation')).toBe(false);
  });

  test('custom tags are parsed and added', async () => {
    const engine = mockEngine();
    await learn.handler(makeCtx(engine), {
      content: 'Fact about deploy',
      slug: 'notes/deploy',
      tags: 'devops, infrastructure',
    });

    const tagCalls = engine._calls.filter(c => c.method === 'addTag');
    expect(tagCalls.some(c => c.args[1] === 'devops')).toBe(true);
    expect(tagCalls.some(c => c.args[1] === 'infrastructure')).toBe(true);
  });

  test('content_hash changes after append', async () => {
    const engine = mockEngine({
      getPage: () => Promise.resolve({
        slug: 'notes/test',
        type: 'concept',
        title: 'Test',
        compiled_truth: 'Original content.',
        timeline: '',
        frontmatter: {},
        content_hash: 'original-hash',
      }),
    });

    await learn.handler(makeCtx(engine), {
      content: 'New content appended.',
      slug: 'notes/test',
    });

    const putCall = engine._calls.find(c => c.method === 'putPage');
    expect(putCall!.args[1].content_hash).not.toBe('original-hash');
  });

  test('logIngest called with correct source', async () => {
    const engine = mockEngine();
    await learn.handler(makeCtx(engine), {
      content: 'A new fact',
      slug: 'notes/fact',
      source: 'meeting',
    });

    const logCall = engine._calls.find(c => c.method === 'logIngest');
    expect(logCall).toBeTruthy();
    expect(logCall!.args[0].source_type).toBe('meeting');
    expect(logCall!.args[0].source_ref).toBe('notes/fact');
  });
});
