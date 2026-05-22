import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { importFile } from '../src/core/import-file.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const TMP = join(import.meta.dir, '.tmp-force-flag-test');

// Minimal mock engine (same pattern as import-file.test.ts)
function mockEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
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
      if (prop === 'getChunks') return overrides.getChunks || (() => Promise.resolve([]));
      if (prop === 'transaction') return async (fn: (tx: BrainEngine) => Promise<any>) => fn(engine);
      return track(prop);
    },
  });
  return engine;
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('importFile --force / forceRechunk', () => {
  const CONTENT = `---
type: concept
title: Force Test Page
tags: [alpha]
---

Content that will be hashed.
`;
  const REL_PATH = 'concepts/force-test-page.md';

  // Compute the content_hash the same way importFromContent does
  // (same JSON shape as the "skips when content hash matches" test)
  function computeHash(content: string, relPath: string): string {
    const parsed = parseMarkdown(content, relPath);
    return createHash('sha256')
      .update(
        JSON.stringify({
          title: parsed.title,
          type: parsed.type,
          compiled_truth: parsed.compiled_truth,
          timeline: parsed.timeline,
          frontmatter: parsed.frontmatter,
          tags: parsed.tags.sort(),
        }),
      )
      .digest('hex');
  }

  test('skips when content_hash matches (baseline)', async () => {
    const filePath = join(TMP, 'force-test-page.md');
    writeFileSync(filePath, CONTENT);

    const hash = computeHash(CONTENT, REL_PATH);
    const engine = mockEngine({
      getPage: () => Promise.resolve({ content_hash: hash }),
    });

    const result = await importFile(engine, filePath, REL_PATH, { noEmbed: true });
    expect(result.status).toBe('skipped');

    // putPage must NOT have been called
    const calls = (engine as any)._calls;
    const putCall = calls.find((c: any) => c.method === 'putPage');
    expect(putCall).toBeUndefined();
  });

  test('re-imports when forceRechunk: true even if content_hash matches', async () => {
    const filePath = join(TMP, 'force-test-page-b.md');
    writeFileSync(filePath, CONTENT);

    const hash = computeHash(CONTENT, REL_PATH);
    const engine = mockEngine({
      // Same hash — would normally skip
      getPage: () => Promise.resolve({ content_hash: hash }),
    });

    const result = await importFile(engine, filePath, REL_PATH, {
      noEmbed: true,
      forceRechunk: true,
    });

    // With forceRechunk, the hash-match short-circuit is bypassed
    expect(result.status).toBe('imported');
    expect(result.chunks).toBeGreaterThan(0);

    // putPage MUST have been called
    const calls = (engine as any)._calls;
    const putCall = calls.find((c: any) => c.method === 'putPage');
    expect(putCall).toBeTruthy();
  });
});
