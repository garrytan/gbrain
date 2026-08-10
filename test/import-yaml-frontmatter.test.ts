import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFile, importFromContent } from '../src/core/import-file.ts';

function mockEngine(): BrainEngine {
  const calls: { method: string; args: any[] }[] = [];
  const pages = new Map<string, { slug: string; content_hash: string; title: string; type: string; frontmatter: Record<string, unknown> }>();

  const engine = new Proxy({} as any, {
    get(_, prop: string) {
      if (prop === '_calls') return calls;
      if (prop === 'getTags') return () => Promise.resolve([]);
      if (prop === 'getPage') {
        return (slug: string) => Promise.resolve(pages.get(slug) ?? null);
      }
      if (prop === 'putPage') {
        return async (slug: string, page: { content_hash?: string; title?: string; type?: string; frontmatter?: Record<string, unknown> }) => {
          calls.push({ method: 'putPage', args: [slug, page] });
          pages.set(slug, {
            slug,
            content_hash: page.content_hash ?? '',
            title: page.title ?? '',
            type: page.type ?? '',
            frontmatter: page.frontmatter ?? {},
          });
        };
      }
      if (prop === 'transaction') return async (fn: (tx: BrainEngine) => Promise<any>) => fn(engine);
      return (...args: any[]) => {
        calls.push({ method: String(prop), args });
        return Promise.resolve(null);
      };
    },
  });

  return engine as BrainEngine;
}

describe('import YAML frontmatter validation', () => {
  test('importFromContent rejects invalid YAML frontmatter instead of importing it as body', async () => {
    const content = `---
type: note
title: Re: October booking
---

Body text.
`;

    const engine = mockEngine();
    const result = await importFromContent(engine, 'emails/reply-october-booking', content, { noEmbed: true });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Invalid YAML frontmatter');
    expect(result.error).toContain('title: Re: October booking');
    expect((engine as any)._calls).toEqual([]);
  });

  test('importFile rejects invalid YAML before frontmatter inference can wrap it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-invalid-yaml-'));
    try {
      const filePath = join(dir, 'reply.md');
      writeFileSync(filePath, `---
type: note
title: Re: October booking
---

Body text.
`);

      const engine = mockEngine();
      const result = await importFile(engine, filePath, 'emails/reply-october-booking.md', { noEmbed: true });

      expect(result.status).toBe('skipped');
      expect(result.error).toContain('Invalid YAML frontmatter');
      expect(result.error).toContain('title: Re: October booking');
      expect((engine as any)._calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('quoted frontmatter values with colon-space still import', async () => {
    const content = `---
type: note
title: "Re: October booking"
---

Body text.
`;

    const engine = mockEngine();
    const result = await importFromContent(engine, 'emails/reply-october-booking', content, { noEmbed: true });

    expect(result.status).toBe('imported');
    const putCall = (engine as any)._calls.find((call: any) => call.method === 'putPage');
    expect(putCall.args[1].title).toBe('Re: October booking');
    expect(putCall.args[1].compiled_truth).toBe('Body text.');
  });

  test('importFile preserves leading thematic-break epigraphs as body content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-thematic-epigraph-'));
    try {
      const filePath = join(dir, 'epigraph.md');
      writeFileSync(filePath, `---
> Re: quoted epigraph, not YAML frontmatter
---

# Epigraph Note

Body text.
`);

      const engine = mockEngine();
      const result = await importFile(engine, filePath, 'notes/epigraph.md', { noEmbed: true });

      expect(result.status).toBe('imported');
      expect(result.error).toBeUndefined();
      const putCall = (engine as any)._calls.find((call: any) => call.method === 'putPage');
      expect(putCall.args[1].title).toBe('Epigraph Note');
      expect(putCall.args[1].compiled_truth).toContain('> Re: quoted epigraph, not YAML frontmatter');
      expect(putCall.args[1].compiled_truth).toContain('# Epigraph Note');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
