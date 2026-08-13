/**
 * Regression: extract_atoms wrote atoms with `engine.putPage`, a bare
 * `INSERT INTO pages ... ON CONFLICT` that never chunks or embeds. Atom pages
 * therefore never reached `content_chunks` and were invisible to search — the
 * same defect #2163 fixed for concept pages in synthesize-concepts.ts, which
 * was never applied one layer down.
 *
 * The fix routes atoms through `serializeMarkdown` -> `importFromContent`,
 * which means atom content now makes a round-trip through YAML frontmatter
 * that the raw row-write bypassed. These tests lock the invariants that trip
 * on: page type, the grounding frontmatter propose_takes depends on, and
 * LLM-authored text that is hostile to YAML/frontmatter parsing.
 *
 * Mostly pure functions; the final describe block is a PGLite round-trip
 * that pins the actual defect (atoms produce content_chunks rows). No model
 * calls anywhere — the chat gateway is stubbed.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { serializeMarkdown, parseMarkdown } from '../src/core/markdown.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import type { ChatResult, ChatOpts } from '../src/core/ai/gateway.ts';

/** Mirrors the write site in extract-atoms.ts. */
function roundTrip(atom: {
  title: string;
  body: string;
  atom_type?: string;
  source_quote?: string;
  lesson?: string;
  concepts?: string[];
  source_slug?: string;
}) {
  const md = serializeMarkdown(
    {
      atom_type: atom.atom_type ?? "insight",
      ...(atom.source_slug && { source_slug: atom.source_slug }),
      source_hash: 'abc123def4567890',
      ...(atom.source_quote && { source_quote: atom.source_quote }),
      ...(atom.lesson && { lesson: atom.lesson }),
      ...(atom.concepts && atom.concepts.length > 0 && { concepts: atom.concepts }),
      extracted_at: '2026-08-02T00:00:00.000Z',
      extracted_by: 'extract_atoms-v0.41.2.1',
    },
    atom.body,
    '',
    { type: 'atom', title: atom.title, tags: [] },
  );
  // filePath is deliberately omitted: the atom slug is not a real file, so
  // nothing but the explicit frontmatter `type:` can carry the page type.
  return { md, parsed: parseMarkdown(md) };
}

describe('atom markdown round-trip — page type', () => {
  test("explicit frontmatter type: atom survives with no filePath to infer from", () => {
    const { parsed } = roundTrip({ title: 'Pilots de-risk procurement', body: 'A short claim.' });
    expect(parsed.type).toBe('atom');
  });

  test('explicit type wins over a filePath that would infer something else', () => {
    const { md } = roundTrip({ title: 'Pilots de-risk procurement', body: 'A short claim.' });
    // meetings/ is a seeded path prefix; the frontmatter must still win, or
    // re-importing an atom would silently retype it and break `type='atom'`.
    expect(parseMarkdown(md, 'meetings/2026-08-02-standup.md').type).toBe('atom');
  });
});

describe('atom markdown round-trip — grounding frontmatter', () => {
  test('source_quote, lesson, concepts and source_slug all survive', () => {
    const { parsed } = roundTrip({
      title: 'Benchmarks decide agent selection',
      body: 'The buyer picked on measured latency, not brand.',
      atom_type: 'insight',
      source_quote: 'We ran both and took the faster one.',
      lesson: 'Measured evidence beats vendor claims.',
      concepts: ['agent-evaluation', 'procurement'],
      source_slug: '2026-06-02-polaris-stefan',
    });
    expect(parsed.frontmatter.source_quote).toBe('We ran both and took the faster one.');
    expect(parsed.frontmatter.lesson).toBe('Measured evidence beats vendor claims.');
    expect(parsed.frontmatter.concepts).toEqual(['agent-evaluation', 'procurement']);
    expect(parsed.frontmatter.source_slug).toBe('2026-06-02-polaris-stefan');
    expect(parsed.frontmatter.atom_type).toBe('insight');
  });

  test('body is preserved as compiled_truth', () => {
    const body = 'Procurement stalls when the pilot has no exit criteria.';
    expect(roundTrip({ title: 'Exit criteria', body }).parsed.compiled_truth.trim()).toBe(body);
  });
});

describe('atom markdown round-trip — LLM text hostile to YAML', () => {
  // Atom titles/quotes are model-authored free text. The raw row-write never
  // serialized them; the import path does, so these must be quoted correctly.
  test('a title containing a colon does not corrupt the frontmatter', () => {
    const { parsed } = roundTrip({
      title: 'Discovery: the part buyers actually pay for',
      body: 'A claim.',
    });
    expect(parsed.type).toBe('atom');
    expect(parsed.title).toBe('Discovery: the part buyers actually pay for');
  });

  test('a quote containing quotes and a hash survives', () => {
    const q = 'He said "no", then asked about #pricing.';
    expect(roundTrip({ title: 'Objection', body: 'A claim.', source_quote: q })
      .parsed.frontmatter.source_quote).toBe(q);
  });

  test('a body containing a --- rule does not truncate the atom or leak frontmatter', () => {
    const body = 'First point.\n\n---\n\nSecond point.';
    const { parsed } = roundTrip({ title: 'Two points', body });
    expect(parsed.type).toBe('atom');
    expect(parsed.compiled_truth).toContain('First point.');
    expect(parsed.frontmatter.extracted_by).toBe('extract_atoms-v0.41.2.1');
  });

  test('a title that is purely numeric stays a string', () => {
    expect(roundTrip({ title: '2026', body: 'A claim.' }).parsed.title).toBe('2026');
  });
});

describe("atom frontmatter must not contain undefined", () => {
  // js-yaml throws on undefined, so every OPTIONAL atom field at the write
  // site has to use a conditional spread rather than a bare assignment. The
  // old engine.putPage row-write silently tolerated undefined; the import
  // path does not. atom_type is safe to assign unconditionally only because
  // parseAtomsResponse drops any atom missing it — see the !atomType guard.
  test("serializeMarkdown throws if an optional field is passed as undefined", () => {
    expect(() =>
      serializeMarkdown({ lesson: undefined }, "body", "", {
        type: "atom",
        title: "t",
        tags: [],
      }),
    ).toThrow();
  });

  test("a conditional spread omits the key instead, which is safe", () => {
    const lesson: string | undefined = undefined;
    const md = serializeMarkdown({ ...(lesson ? { lesson } : {}) }, "body", "", {
      type: "atom",
      title: "t",
      tags: [],
    });
    expect(parseMarkdown(md).frontmatter.lesson).toBeUndefined();
    expect(parseMarkdown(md).type).toBe("atom");
  });
});

describe('extracted atoms reach content_chunks (PGLite round-trip)', () => {
  // Wave rider for #3762: the whole point of the fix is that atoms become
  // searchable. Pre-fix, extract_atoms wrote atom pages via engine.putPage
  // (a bare row upsert), so this chunk-count assertion FAILS without the
  // src/core/cycle/extract-atoms.ts change — verified by reverting only the
  // src file and re-running.
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => {
    await engine.disconnect();
  });
  test('runPhaseExtractAtoms writes content_chunks rows for atom pages', async () => {
    {
      const chat = async (_o: ChatOpts): Promise<ChatResult> => ({
        text: `[{"title":"Chunked atom","atom_type":"insight","body":"Enterprise buyers want tangible prototypes, not renders."}]`,
        blocks: [{ type: 'text', text: '' }],
        stopReason: 'end',
        usage: { input_tokens: 500, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5',
        providerId: 'anthropic',
      });
      const result = await runPhaseExtractAtoms(engine, {
        _transcripts: [{ filePath: '/fake/meeting.txt', content: 'transcript content', contentHash: 'abc123def4567890' }],
        _pages: [],
        _chat: chat,
      });
      expect(result.status).toBe('ok');
      expect(result.details?.atoms_extracted).toBe(1);
      const rows = await engine.executeRaw<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM content_chunks cc
           JOIN pages p ON p.id = cc.page_id
          WHERE p.type = 'atom'`,
      );
      expect(rows[0].count).toBeGreaterThan(0);
    }
  }, 60000);
});
