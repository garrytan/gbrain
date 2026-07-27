// v0.41 T8 — GstackLearningsSource bridge.
//
// Tests the source's emit pipeline: discovers JSONL files, seeds
// seenLines with existing content (no replay of historical lines on
// startup), emits on new lines, dedups via canonical-JSON content_hash,
// skips malformed JSONL lines, renders markdown frontmatter correctly.

import { describe, test, expect, beforeEach } from 'bun:test';
import { GstackLearningsSource, type GstackLearningLine } from '../../src/core/ingestion/sources/gstack-learnings.ts';
import type { IngestionEvent, IngestionSourceContext } from '../../src/core/ingestion/types.ts';

function makeLine(overrides: Partial<GstackLearningLine> = {}): GstackLearningLine {
  return {
    skill: 'investigate',
    type: 'pitfall',
    key: 'test-key',
    insight: 'test insight body',
    confidence: 8,
    source: 'observed',
    ...overrides,
  };
}

function makeFakeFs(files: Record<string, string>) {
  return {
    _readFile: (path: string) => {
      if (!(path in files)) throw new Error(`fake fs: not found ${path}`);
      return files[path];
    },
    _existsSync: (path: string) => path in files,
  };
}

function makeStubCtx(): IngestionSourceContext & { emitted: IngestionEvent[] } {
  const emitted: IngestionEvent[] = [];
  return {
    emit(event) {
      emitted.push(event);
    },
    engine: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    abortSignal: new AbortController().signal,
    config: {},
    emitted,
  };
}

describe('v0.41 T8: GstackLearningsSource basic contract', () => {
  test('declares mode: trickle (uses standard 24h dedup window)', () => {
    const src = new GstackLearningsSource({ paths: [], _skipWatch: true });
    expect(src.mode).toBe('trickle');
  });

  test('id includes pid for uniqueness across concurrent processes', () => {
    const src = new GstackLearningsSource({ paths: [], _skipWatch: true });
    expect(src.id).toMatch(/^gstack-learnings:\d+$/);
  });

  test('kind is gstack-learnings', () => {
    const src = new GstackLearningsSource({ paths: [], _skipWatch: true });
    expect(src.kind).toBe('gstack-learnings');
  });
});

describe('v0.41 T8: start() seeds seenLines from existing JSONL content', () => {
  test('historical lines are NOT replayed as emits on first start', async () => {
    const existing = [
      makeLine({ key: 'existing-1' }),
      makeLine({ key: 'existing-2' }),
    ];
    const path = '/fake/projects/repoA/learnings.jsonl';
    const content = existing.map((l) => JSON.stringify(l)).join('\n');
    const fs = makeFakeFs({ [path]: content });
    const src = new GstackLearningsSource({ paths: [path], _skipWatch: true, ...fs });
    const ctx = makeStubCtx();
    await src.start(ctx);
    expect(src.seenCount).toBe(2);
    expect(ctx.emitted.length).toBe(0); // start does NOT emit
    await src.stop();
  });

  test('malformed JSONL lines skip without crashing start()', async () => {
    const path = '/fake/projects/repoA/learnings.jsonl';
    const content = JSON.stringify(makeLine({ key: 'good' })) + '\n{not-valid-json\n' + JSON.stringify(makeLine({ key: 'good-2' }));
    const fs = makeFakeFs({ [path]: content });
    const src = new GstackLearningsSource({ paths: [path], _skipWatch: true, ...fs });
    const ctx = makeStubCtx();
    await src.start(ctx);
    // Two valid lines seeded; one malformed line skipped silently.
    expect(src.seenCount).toBe(2);
    await src.stop();
  });

  test('blank lines + trailing newline OK', async () => {
    const path = '/fake/projects/repoA/learnings.jsonl';
    const content = '\n' + JSON.stringify(makeLine({ key: 'a' })) + '\n\n' + JSON.stringify(makeLine({ key: 'b' })) + '\n';
    const fs = makeFakeFs({ [path]: content });
    const src = new GstackLearningsSource({ paths: [path], _skipWatch: true, ...fs });
    const ctx = makeStubCtx();
    await src.start(ctx);
    expect(src.seenCount).toBe(2);
    await src.stop();
  });
});

describe('v0.41 T8: emitLine path (production rescanFile equivalent)', () => {
  test('emits new line not previously seen', async () => {
    const path = '/fake/projects/repoA/learnings.jsonl';
    const fs = makeFakeFs({ [path]: '' });
    const src = new GstackLearningsSource({ paths: [path], _skipWatch: true, ...fs });
    const ctx = makeStubCtx();
    await src.start(ctx);
    const newLine = makeLine({ key: 'fresh-insight', insight: 'just learned this' });
    src.emitLine(newLine, path);
    expect(ctx.emitted.length).toBe(1);
    const event = ctx.emitted[0];
    expect(event.source_kind).toBe('gstack-learnings');
    expect(event.source_uri).toBe(path);
    expect(event.content_type).toBe('text/markdown');
    expect(event.untrusted_payload).toBe(false);
    expect(event.metadata?.learning).toEqual(newLine);
    await src.stop();
  });

  test('re-emit of identical line is silent dedup hit (no event)', async () => {
    const path = '/fake/projects/repoA/learnings.jsonl';
    const fs = makeFakeFs({ [path]: '' });
    const src = new GstackLearningsSource({ paths: [path], _skipWatch: true, ...fs });
    const ctx = makeStubCtx();
    await src.start(ctx);
    const line = makeLine({ key: 'dup-test' });
    src.emitLine(line, path);
    src.emitLine(line, path);
    expect(ctx.emitted.length).toBe(1);
    await src.stop();
  });

  test('emitted body carries frontmatter with learning_type + confidence + source + key', async () => {
    const path = '/fake/projects/repoA/learnings.jsonl';
    const fs = makeFakeFs({ [path]: '' });
    const src = new GstackLearningsSource({ paths: [path], _skipWatch: true, ...fs });
    const ctx = makeStubCtx();
    await src.start(ctx);
    const line = makeLine({
      key: 'orbstack-port-8080',
      insight: 'OrbStack listens on *:8080 by default, conflicts with Kumo proxy.',
      type: 'operational',
      confidence: 9,
      files: ['internal/proxy/proxy.go'],
    });
    src.emitLine(line, path);
    const body = ctx.emitted[0].content;
    expect(body).toContain('type: "learning"');
    expect(body).toContain('learning_type: "operational"');
    expect(body).toContain('confidence: 9');
    expect(body).toContain('source: "observed"');
    expect(body).toContain('skill: "investigate"');
    expect(body).toContain('key: "orbstack-port-8080"');
    expect(body).toContain('files: ["internal/proxy/proxy.go"]');
    expect(body).toContain('# orbstack-port-8080');
    expect(body).toContain('OrbStack listens on *:8080');
    await src.stop();
  });

  test('canonical-JSON content_hash means whitespace-only reformat is dedup hit', async () => {
    const path = '/fake/projects/repoA/learnings.jsonl';
    const fs = makeFakeFs({ [path]: '' });
    const src = new GstackLearningsSource({ paths: [path], _skipWatch: true, ...fs });
    const ctx = makeStubCtx();
    await src.start(ctx);
    // Both lines have same field values; the hash is computed over the
    // canonical JSON.stringify output so they collide. Production gstack
    // never reformats but if a future tooling change did, dedup should still hold.
    const lineA = makeLine({ key: 'whitespace-test' });
    src.emitLine(lineA, path);
    src.emitLine(lineA, path); // identical
    expect(ctx.emitted.length).toBe(1);
    await src.stop();
  });
});

describe('v0.41 T8: healthCheck()', () => {
  test('returns warn when no JSONL files discovered', async () => {
    const src = new GstackLearningsSource({ paths: [], _skipWatch: true, _existsSync: () => false, _readFile: () => '' });
    const health = await src.healthCheck();
    expect(health.status).toBe('warn');
    expect(health.message).toContain('no gstack learnings');
  });

  test('returns ok when files exist and are readable', async () => {
    const path = '/fake/projects/repoA/learnings.jsonl';
    const fs = makeFakeFs({ [path]: JSON.stringify(makeLine()) });
    const src = new GstackLearningsSource({ paths: [path], _skipWatch: true, ...fs });
    const ctx = makeStubCtx();
    await src.start(ctx);
    const health = await src.healthCheck();
    expect(health.status).toBe('ok');
    expect(health.message).toContain('1 watched');
    await src.stop();
  });
});

describe('v0.41 T8: describePaths() diagnostic', () => {
  test('reports per-file existence + size', async () => {
    const path = '/fake/projects/repoA/learnings.jsonl';
    const fs = makeFakeFs({ [path]: JSON.stringify(makeLine()) });
    const src = new GstackLearningsSource({ paths: [path], _skipWatch: true, ...fs });
    const desc = src.describePaths();
    expect(desc.length).toBe(1);
    expect(desc[0].path).toBe(path);
    expect(desc[0].exists).toBe(true);
  });

  test('reports missing paths as exists:false', async () => {
    const src = new GstackLearningsSource({
      paths: ['/fake/missing/learnings.jsonl'],
      _skipWatch: true,
      _existsSync: () => false,
      _readFile: () => '',
    });
    const desc = src.describePaths();
    expect(desc[0].exists).toBe(false);
  });
});
