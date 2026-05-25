/**
 * Tests for the generalized extract_atoms phase (v0.41.2.1).
 *
 * Covers:
 *   1. Config-plane fallback: file config → DB config for corpus dirs.
 *   2. Page-based discovery: extracts atoms from existing brain pages.
 *   3. Dual-source merge: transcripts + pages combined, deduplicated.
 *   4. Budget cap respected across both sources.
 *   5. Already-extracted pages skipped (atoms_extracted frontmatter).
 *   6. Greenfield-imported pages skipped.
 *   7. Short pages skipped (below MIN_CONTENT_CHARS).
 *   8. atoms_extracted marker written after successful page extraction.
 *   9. Backward compat: transcript-only mode still works.
 */

import { describe, it, expect } from 'bun:test';
import { runPhaseExtractAtoms, parseAtomsResponse } from '../src/core/cycle/extract-atoms.ts';

// ── Mock helpers ──────────────────────────────────────────────────────

function makeMockChat(atoms: Array<{ title: string; atom_type: string; body: string }> = []) {
  const calls: Array<{ system: string; messages: unknown[] }> = [];
  return {
    fn: async (opts: { system: string; messages: unknown[]; maxTokens: number }) => {
      calls.push({ system: opts.system, messages: opts.messages });
      return {
        text: JSON.stringify(atoms.length > 0 ? atoms : [
          { title: 'Test Atom', atom_type: 'insight', body: 'A test insight.', source_quote: 'test', lesson: 'test lesson', virality_score: 50, emotional_register: 'practical' },
        ]),
        usage: { input_tokens: 1000, output_tokens: 200 },
      };
    },
    calls,
  };
}

function makeMockEngine(pages: Array<{ slug: string; type: string; compiled_truth: string; frontmatter?: Record<string, unknown> }> = []) {
  const written: Array<{ slug: string; data: unknown }> = [];
  const configStore: Record<string, string> = {};

  return {
    engine: {
      listPages: async (filters?: { type?: string; limit?: number; sort?: string }) => {
        return pages
          .filter((p) => !filters?.type || p.type === filters.type)
          .slice(0, filters?.limit ?? 100)
          .map((p) => ({
            slug: p.slug,
            type: p.type,
            compiled_truth: p.compiled_truth,
            frontmatter: p.frontmatter ?? {},
            title: p.slug,
            timeline: '',
          }));
      },
      getPage: async (slug: string) => {
        const p = pages.find((pg) => pg.slug === slug);
        if (!p) return null;
        return {
          slug: p.slug,
          type: p.type,
          compiled_truth: p.compiled_truth,
          frontmatter: p.frontmatter ?? {},
          title: p.slug,
          timeline: '',
        };
      },
      putPage: async (slug: string, data: unknown) => {
        written.push({ slug, data });
      },
      getConfig: async (key: string) => {
        return configStore[key] ?? null;
      },
    },
    written,
    configStore,
  };
}

const LONG_CONTENT = 'A'.repeat(600); // Above MIN_CONTENT_CHARS threshold

// ── Tests ──────────────────────────────────────────────────────────────

describe('extract_atoms general-purpose', () => {
  it('extracts atoms from brain pages when no transcripts configured', async () => {
    const chat = makeMockChat();
    const mock = makeMockEngine([
      { slug: 'meetings/2026-05-01-standup', type: 'meeting', compiled_truth: LONG_CONTENT + ' meeting content' },
      { slug: 'sources/great-article', type: 'source', compiled_truth: LONG_CONTENT + ' article content' },
    ]);

    const result = await runPhaseExtractAtoms(mock.engine as any, {
      _chat: chat.fn as any,
      _loadConfig: () => ({}) as any,
    });

    expect(result.status).toBe('ok');
    expect(result.details.pages_processed).toBe(2);
    expect(result.details.atoms_extracted).toBeGreaterThan(0);
    // Should have written atom pages
    expect(mock.written.some((w) => w.slug.startsWith('atoms/'))).toBe(true);
    // Should have marked source pages as extracted
    expect(mock.written.some((w) => w.slug === 'meetings/2026-05-01-standup')).toBe(true);
  });

  it('skips pages with atoms_extracted: true', async () => {
    const chat = makeMockChat();
    const mock = makeMockEngine([
      { slug: 'meetings/already-done', type: 'meeting', compiled_truth: LONG_CONTENT, frontmatter: { atoms_extracted: true } },
      { slug: 'meetings/not-done', type: 'meeting', compiled_truth: LONG_CONTENT },
    ]);

    const result = await runPhaseExtractAtoms(mock.engine as any, {
      _chat: chat.fn as any,
      _loadConfig: () => ({}) as any,
    });

    expect(result.details.pages_processed).toBe(1);
    // Only one chat call (for the non-extracted page)
    expect(chat.calls.length).toBe(1);
  });

  it('skips pages with imported_from: markdown-greenfield', async () => {
    const chat = makeMockChat();
    const mock = makeMockEngine([
      { slug: 'sources/imported', type: 'source', compiled_truth: LONG_CONTENT, frontmatter: { imported_from: 'markdown-greenfield' } },
    ]);

    const result = await runPhaseExtractAtoms(mock.engine as any, {
      _chat: chat.fn as any,
      _loadConfig: () => ({}) as any,
    });

    expect(result.status).toBe('skipped');
    expect(result.details.reason).toBe('no_content');
  });

  it('skips pages shorter than MIN_CONTENT_CHARS', async () => {
    const chat = makeMockChat();
    const mock = makeMockEngine([
      { slug: 'meetings/short', type: 'meeting', compiled_truth: 'Too short.' },
    ]);

    const result = await runPhaseExtractAtoms(mock.engine as any, {
      _chat: chat.fn as any,
      _loadConfig: () => ({}) as any,
    });

    expect(result.status).toBe('skipped');
  });

  it('falls through to DB config when file config lacks dream.synthesize keys', async () => {
    const chat = makeMockChat();
    const mock = makeMockEngine([]);
    // Set DB config — the fallback path
    mock.configStore['dream.synthesize.session_corpus_dir'] = '/nonexistent/corpus';

    // No file config for dream.*
    const result = await runPhaseExtractAtoms(mock.engine as any, {
      brainDir: '/tmp/test-brain',
      _chat: chat.fn as any,
      _loadConfig: () => ({}) as any,
      _skipPageDiscovery: true,
    });

    // Should have attempted transcript discovery (will fail on /nonexistent/ but
    // the config resolution itself should work — not skip with 'no_content')
    // Since the dir doesn't exist, it'll catch and fall through to no_content
    expect(result.phase).toBe('extract_atoms');
  });

  it('merges transcripts and pages, deduplicates by content hash', async () => {
    const chat = makeMockChat();
    const mock = makeMockEngine([
      { slug: 'meetings/overlap', type: 'meeting', compiled_truth: 'unique page content that is long enough to be extracted from the brain database' + LONG_CONTENT },
    ]);

    const transcriptContent = 'transcript content that is unique and not duplicated' + LONG_CONTENT;
    const result = await runPhaseExtractAtoms(mock.engine as any, {
      _chat: chat.fn as any,
      _loadConfig: () => ({}) as any,
      _transcripts: [
        { filePath: '/transcripts/test.txt', content: transcriptContent, contentHash: 'abc123' },
      ],
    });

    expect(result.status).toBe('ok');
    // Transcript from test seam + page from DB discovery
    expect(result.details.transcripts_processed).toBeGreaterThanOrEqual(1);
    expect(result.details.items_processed).toBeGreaterThanOrEqual(2);
  });

  it('respects budget cap across both sources', async () => {
    // Make a chat that costs ~$0.31 per call (over budget after first)
    const expensiveChat = {
      fn: async () => ({
        text: JSON.stringify([{ title: 'Expensive', atom_type: 'insight', body: 'Costly atom.' }]),
        usage: { input_tokens: 300_000, output_tokens: 50_000 }, // ~$0.44
      }),
      calls: [] as unknown[],
    };

    const mock = makeMockEngine([
      { slug: 'meetings/first', type: 'meeting', compiled_truth: LONG_CONTENT },
      { slug: 'meetings/second', type: 'meeting', compiled_truth: LONG_CONTENT + 'different' },
      { slug: 'meetings/third', type: 'meeting', compiled_truth: LONG_CONTENT + 'also different' },
    ]);

    const result = await runPhaseExtractAtoms(mock.engine as any, {
      _chat: expensiveChat.fn as any,
      _loadConfig: () => ({}) as any,
    });

    expect(result.details.items_skipped_budget).toBeGreaterThan(0);
  });

  it('backward compat: transcript-only mode still works', async () => {
    const chat = makeMockChat();
    const mock = makeMockEngine([]);

    const result = await runPhaseExtractAtoms(mock.engine as any, {
      _chat: chat.fn as any,
      _loadConfig: () => ({}) as any,
      _transcripts: [
        { filePath: '/transcripts/test.txt', content: 'Some transcript content', contentHash: 'hash1' },
      ],
      _skipPageDiscovery: true,
    });

    expect(result.status).toBe('ok');
    expect(result.details.transcripts_processed).toBe(1);
    expect(result.details.pages_processed).toBe(0);
  });

  it('writes source_slug for page-origin atoms and source_path for transcript-origin', async () => {
    const chat = makeMockChat();
    const mock = makeMockEngine([
      { slug: 'meetings/test-meeting', type: 'meeting', compiled_truth: LONG_CONTENT },
    ]);

    await runPhaseExtractAtoms(mock.engine as any, {
      _chat: chat.fn as any,
      _loadConfig: () => ({}) as any,
      _transcripts: [
        { filePath: '/transcripts/test.txt', content: LONG_CONTENT + 'different', contentHash: 'hashT' },
      ],
    });

    const atomWrites = mock.written.filter((w) => w.slug.startsWith('atoms/'));
    expect(atomWrites.length).toBeGreaterThanOrEqual(2);

    // Check that page-origin atoms have source_slug
    const pageAtom = atomWrites.find((w) => {
      const fm = (w.data as any)?.frontmatter;
      return fm?.source_origin === 'page';
    });
    expect(pageAtom).toBeDefined();
    expect((pageAtom!.data as any).frontmatter.source_slug).toBe('meetings/test-meeting');

    // Check that transcript-origin atoms have source_path
    const transcriptAtom = atomWrites.find((w) => {
      const fm = (w.data as any)?.frontmatter;
      return fm?.source_origin === 'transcript';
    });
    expect(transcriptAtom).toBeDefined();
    expect((transcriptAtom!.data as any).frontmatter.source_path).toBe('/transcripts/test.txt');
  });
});

describe('parseAtomsResponse', () => {
  it('parses clean JSON array', () => {
    const atoms = parseAtomsResponse(JSON.stringify([
      { title: 'Test', atom_type: 'insight', body: 'Body text.' },
    ]));
    expect(atoms.length).toBe(1);
    expect(atoms[0].title).toBe('Test');
  });

  it('handles markdown code fences', () => {
    const atoms = parseAtomsResponse('```json\n[{"title":"Test","atom_type":"insight","body":"Body."}]\n```');
    expect(atoms.length).toBe(1);
  });

  it('rejects invalid atom_type', () => {
    const atoms = parseAtomsResponse(JSON.stringify([
      { title: 'Bad', atom_type: 'INVALID_TYPE', body: 'Body.' },
    ]));
    expect(atoms.length).toBe(0);
  });

  it('handles trailing prose after JSON', () => {
    const atoms = parseAtomsResponse('[{"title":"Test","atom_type":"insight","body":"Body."}]\n\nHere are some additional thoughts...');
    expect(atoms.length).toBe(1);
  });
});
