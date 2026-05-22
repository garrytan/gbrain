import { describe, test, expect } from 'bun:test';
import { importFromContent } from '../src/core/import-file.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// Minimal mock engine that records the content_hash written to putPage.
function mockEngine(): BrainEngine & { capturedHash: string | null } {
  let capturedHash: string | null = null;

  const engine = new Proxy({ capturedHash } as any, {
    get(target, prop: string) {
      if (prop === 'capturedHash') return capturedHash;
      if (prop === 'getTags') return () => Promise.resolve([]);
      if (prop === 'getPage') return () => Promise.resolve(null);
      if (prop === 'getChunks') return () => Promise.resolve([]);
      if (prop === 'transaction') return async (fn: (tx: BrainEngine) => Promise<any>) => fn(engine);
      if (prop === 'putPage') return (_slug: string, data: any) => {
        capturedHash = data.content_hash;
        return Promise.resolve({ id: 1 });
      };
      // All other methods: no-op returning null
      return () => Promise.resolve(null);
    },
  });
  return engine;
}

// Run an import and return the content_hash that was persisted.
async function getHashForContent(content: string, slug: string): Promise<string> {
  const engine = mockEngine();
  await importFromContent(engine, slug, content, { noEmbed: true });
  const hash = (engine as any).capturedHash;
  if (!hash) throw new Error('putPage was never called — import may have been skipped or errored');
  return hash;
}

describe('hash-sentinel integration', () => {
  test('content_hash unchanged when only sentinel-wrapped region differs', async () => {
    const slug = 'concepts/page';

    const content1 = `---
type: concept
title: Page
---

Real semantic content here.

<!-- gbrain:no-hash-start -->
Generated at: 2026-05-22 14:30:11
Visitor count: 42
<!-- gbrain:no-hash-end -->

More real content.
`;

    const content2 = `---
type: concept
title: Page
---

Real semantic content here.

<!-- gbrain:no-hash-start -->
Generated at: 2026-05-22 15:45:00
Visitor count: 9999
This whole block is presentation and shouldn't matter.
<!-- gbrain:no-hash-end -->

More real content.
`;

    const hash1 = await getHashForContent(content1, slug);
    const hash2 = await getHashForContent(content2, slug);

    expect(hash1).toBeTruthy();
    // Only presentation changed — hashes must be identical.
    expect(hash2).toBe(hash1);
  });

  test('content_hash CHANGES when real (non-sentinel) content differs', async () => {
    const slug = 'concepts/real';

    const content1 = `---
type: concept
title: Real
---

Original semantic content.

<!-- gbrain:no-hash-start -->presentation 1<!-- gbrain:no-hash-end -->
`;

    const content2 = `---
type: concept
title: Real
---

Different semantic content here.

<!-- gbrain:no-hash-start -->presentation 1<!-- gbrain:no-hash-end -->
`;

    const hash1 = await getHashForContent(content1, slug);
    const hash2 = await getHashForContent(content2, slug);

    // Real content changed — hashes must differ.
    expect(hash2).not.toBe(hash1);
  });
});
