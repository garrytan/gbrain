import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { importFromContent } from '../src/core/import-file.ts';
import { readContext } from '../src/core/services/read-context-service.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

async function withEngine<T>(label: string, fn: (engine: SQLiteEngine) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-read-context-${label}-`));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    return await fn(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

function failOnFullPageRead(engine: SQLiteEngine): void {
  engine.getPage = async () => {
    throw new Error('getPage should not be called for bounded read_context projection paths');
  };
}

function failOnTimelineTableRead(engine: SQLiteEngine): void {
  engine.getTimeline = async () => {
    throw new Error('getTimeline should not be called for timeline_range page projection reads');
  };
}

describe('read context service', () => {
  test('reads compiled truth as answer-grounding canonical evidence', async () => {
    await withEngine('compiled', async (engine) => {
      await importFromContent(engine, 'concepts/retrieval', [
        '---',
        'type: concept',
        'title: Retrieval',
        '---',
        '# Compiled Truth',
        'Retrieval chunks are candidate pointers, not answer evidence.',
        '[Source: User, direct message, 2026-05-07 09:00 KST]',
        '',
        '---',
        '',
        '- **2026-05-07** | The user clarified that token budget must stay bounded.',
      ].join('\n'), { path: 'concepts/retrieval.md' });

      const result = await readContext(engine, {
        selectors: [{ kind: 'compiled_truth', slug: 'concepts/retrieval' }],
        token_budget: 400,
      });

      expect(result.answer_ready.ready).toBe(true);
      expect(result.canonical_reads).toHaveLength(1);
      expect(result.canonical_reads[0]!.authority).toBe('canonical_compiled_truth');
      expect(result.canonical_reads[0]!.text).toContain('candidate pointers');
      expect(result.canonical_reads[0]!.source_refs).toContain('User, direct message, 2026-05-07 09:00 KST');
      expect(result.unread_required).toEqual([]);
    });
  });

  test('reads a canonical section instead of the whole page for narrow selectors', async () => {
    await withEngine('section', async (engine) => {
      await importFromContent(engine, 'systems/mbrain', [
        '---',
        'type: system',
        'title: MBrain',
        '---',
        '# Overview',
        'Top-level overview.',
        '',
        '## Runtime',
        'Runtime owns exact retrieval routing.',
        '[Source: User, direct message, 2026-05-07 09:01 KST]',
        '',
        '## Storage',
        'Storage owns canonical persistence.',
      ].join('\n'), { path: 'systems/mbrain.md' });

      const sections = await engine.listNoteSectionEntries({
        scope_id: 'workspace:default',
        page_slug: 'systems/mbrain',
        limit: 10,
      });
      const runtime = sections.find((section) => section.heading_text === 'Runtime');
      if (!runtime) throw new Error('runtime section fixture missing');

      const result = await readContext(engine, {
        selectors: [{ kind: 'section', section_id: runtime.section_id }],
        token_budget: 200,
      });

      expect(result.answer_ready.ready).toBe(true);
      expect(result.canonical_reads[0]!.title).toBe('Runtime');
      expect(result.canonical_reads[0]!.text).toContain('Runtime owns exact retrieval routing.');
      expect(result.canonical_reads[0]!.text).not.toContain('Storage owns canonical persistence.');
    });
  });

  test('accepts page content_hash for section selectors', async () => {
    await withEngine('section-page-hash', async (engine) => {
      await importFromContent(engine, 'systems/section-page-hash', [
        '---',
        'type: system',
        'title: Section Page Hash',
        '---',
        '# Overview',
        'Top-level overview.',
        '',
        '## Runtime',
        'Runtime section is bound to the page snapshot.',
      ].join('\n'), { path: 'systems/section-page-hash.md' });

      const page = await engine.getPage('systems/section-page-hash');
      const sections = await engine.listNoteSectionEntries({
        scope_id: 'workspace:default',
        page_slug: 'systems/section-page-hash',
        limit: 10,
      });
      const runtime = sections.find((section) => section.heading_text === 'Runtime');
      if (!page?.content_hash || !runtime) throw new Error('section page hash fixture missing');

      const result = await readContext(engine, {
        selectors: [{
          kind: 'section',
          slug: 'systems/section-page-hash',
          section_id: runtime.section_id,
          content_hash: page.content_hash,
        }],
        token_budget: 200,
      });

      expect(result.canonical_reads).toHaveLength(1);
      expect(result.canonical_reads[0]!.text).toContain('Runtime section is bound');
      expect(result.canonical_reads[0]!.selector.content_hash).toBe(page.content_hash);
    });
  });

  test('returns continuation selectors when a canonical read exceeds budget', async () => {
    await withEngine('budget', async (engine) => {
      await importFromContent(engine, 'concepts/large-context', [
        '---',
        'type: concept',
        'title: Large Context',
        '---',
        '# Compiled Truth',
        'Alpha '.repeat(200),
        '[Source: User, direct message, 2026-05-07 09:02 KST]',
      ].join('\n'), { path: 'concepts/large-context.md' });

      const result = await readContext(engine, {
        selectors: [{ kind: 'compiled_truth', slug: 'concepts/large-context' }],
        token_budget: 40,
      });

      expect(result.canonical_reads[0]!.has_more).toBe(true);
      expect(result.continuations).toHaveLength(1);
      expect(result.continuations[0]!.kind).toBe('compiled_truth');
      expect(result.continuations[0]!.content_hash).toBe(result.canonical_reads[0]!.selector.content_hash);
      expect(result.answer_ready.ready).toBe(false);
      expect(result.answer_ready.unsupported_reasons).toContain('continuation_required');
    });
  });

  test('rejects stale compiled truth continuation selectors after page mutation', async () => {
    await withEngine('stale-continuation', async (engine) => {
      await importFromContent(engine, 'concepts/stale-context', [
        '---',
        'type: concept',
        'title: Stale Context',
        '---',
        'Alpha Bravo Charlie Delta Echo Foxtrot',
      ].join('\n'), { path: 'concepts/stale-context.md' });

      const firstRead = await readContext(engine, {
        selectors: [{ kind: 'compiled_truth', slug: 'concepts/stale-context' }],
        token_budget: 2,
      });
      const continuation = firstRead.continuations[0]!;
      expect(continuation.content_hash).toBeDefined();

      await importFromContent(engine, 'concepts/stale-context', [
        '---',
        'type: concept',
        'title: Stale Context',
        '---',
        'Updated content should not be mixed into the old continuation.',
      ].join('\n'), { path: 'concepts/stale-context.md' });

      const staleRead = await readContext(engine, {
        selectors: [continuation],
        token_budget: 20,
      });

      expect(staleRead.canonical_reads).toEqual([]);
      expect(staleRead.unread_required).toHaveLength(1);
      expect(staleRead.unread_required[0]!.freshness).toBe('stale');
      expect(staleRead.warnings.some((warning) => warning.includes('stale_continuation'))).toBe(true);
      expect(staleRead.answer_ready.ready).toBe(false);
      expect(staleRead.answer_ready.unsupported_reasons).toContain('stale_continuation');
    });
  });

  test('uses Unicode scalar offsets for compiled truth continuations', async () => {
    await withEngine('unicode-continuation', async (engine) => {
      await importFromContent(engine, 'concepts/unicode-context', [
        '---',
        'type: concept',
        'title: Unicode Context',
        '---',
        '🙂ABCDE',
      ].join('\n'), { path: 'concepts/unicode-context.md' });

      const result = await readContext(engine, {
        selectors: [{ kind: 'compiled_truth', slug: 'concepts/unicode-context' }],
        token_budget: 1,
      });

      expect(result.canonical_reads[0]!.text).toBe('🙂ABC');
      expect(result.continuations[0]!.char_start).toBe(4);

      const continuationRead = await readContext(engine, {
        selectors: [result.continuations[0]!],
        token_budget: 10,
      });
      expect(continuationRead.canonical_reads[0]!.text).toBe('DE');
    });
  });

  test('reads page with included timeline without materializing the full page', async () => {
    await withEngine('page-include-timeline-projection', async (engine) => {
      await importFromContent(engine, 'concepts/page-projection-context', [
        '---',
        'type: concept',
        'title: Page Projection Context',
        '---',
        'Compiled page evidence.',
        '',
        '---',
        '',
        '- **2026-05-12** | Timeline page evidence.',
      ].join('\n'), { path: 'concepts/page-projection-context.md' });
      failOnFullPageRead(engine);

      const result = await readContext(engine, {
        selectors: [{ kind: 'page', slug: 'concepts/page-projection-context' }],
        include_timeline: 'include',
        token_budget: 30,
      });

      expect(result.canonical_reads).toHaveLength(1);
      expect(result.canonical_reads[0]!.text).toContain('Compiled page evidence.');
      expect(result.canonical_reads[0]!.text).toContain('Timeline page evidence.');
      expect(result.canonical_reads[0]!.selector.content_hash).toBeDefined();
    });
  });

  test('page include_timeline emits a timeline continuation when budget cannot include timeline text', async () => {
    await withEngine('page-include-timeline-continuation', async (engine) => {
      await importFromContent(engine, 'concepts/page-timeline-continuation', [
        '---',
        'type: concept',
        'title: Page Timeline Continuation',
        '---',
        'ABCD',
        '',
        '---',
        '',
        'Timeline evidence that does not fit the first page read.',
      ].join('\n'), { path: 'concepts/page-timeline-continuation.md' });

      const result = await readContext(engine, {
        selectors: [{ kind: 'page', slug: 'concepts/page-timeline-continuation' }],
        include_timeline: 'include',
        token_budget: 1,
      });

      expect(result.canonical_reads).toHaveLength(1);
      expect(result.canonical_reads[0]!.text).toBe('ABCD');
      expect(result.continuations).toHaveLength(1);
      expect(result.continuations[0]!.kind).toBe('timeline_range');
      expect(result.continuations[0]!.char_start).toBe(0);
      expect(result.continuations[0]!.content_hash).toBe(result.canonical_reads[0]!.selector.content_hash);
      expect(result.answer_ready.ready).toBe(false);
      expect(result.answer_ready.unsupported_reasons).toContain('continuation_required');
    });
  });

  test('page include_timeline does not mix snapshots across field windows', async () => {
    await withEngine('page-include-timeline-single-snapshot', async (engine) => {
      await importFromContent(engine, 'concepts/page-snapshot-context', [
        '---',
        'type: concept',
        'title: Page Snapshot Context',
        '---',
        'Compiled snapshot evidence.',
        '',
        '---',
        '',
        'Old timeline evidence.',
      ].join('\n'), { path: 'concepts/page-snapshot-context.md' });

      const originalGetPageProjection = engine.getPageProjection.bind(engine);
      let projectionCalls = 0;
      engine.getPageProjection = async (slug, options) => {
        const projection = await originalGetPageProjection(slug, options);
        projectionCalls += 1;
        if (projectionCalls === 1 && options?.windows?.compiled_truth && !options.windows.timeline) {
          await importFromContent(engine, 'concepts/page-snapshot-context', [
            '---',
            'type: concept',
            'title: Page Snapshot Context',
            '---',
            'Compiled snapshot evidence.',
            '',
            '---',
            '',
            'Updated timeline evidence from a different snapshot.',
          ].join('\n'), { path: 'concepts/page-snapshot-context.md' });
        }
        return projection;
      };

      const result = await readContext(engine, {
        selectors: [{ kind: 'page', slug: 'concepts/page-snapshot-context' }],
        include_timeline: 'include',
        token_budget: 20,
      });

      expect(result.canonical_reads).toHaveLength(1);
      expect(result.canonical_reads[0]!.text).toContain('Compiled snapshot evidence.');
      expect(result.canonical_reads[0]!.text).toContain('Old timeline evidence.');
      expect(result.canonical_reads[0]!.text).not.toContain('Updated timeline evidence');
    });
  });

  test('reads line spans without materializing the full page', async () => {
    await withEngine('line-span-projection', async (engine) => {
      await importFromContent(engine, 'concepts/line-span-context', [
        '---',
        'type: concept',
        'title: Line Span Context',
        '---',
        'Line one.',
        'Line two.',
        'Line three.',
      ].join('\n'), { path: 'concepts/line-span-context.md' });
      failOnFullPageRead(engine);

      const result = await readContext(engine, {
        selectors: [{
          kind: 'line_span',
          slug: 'concepts/line-span-context',
          line_start: 2,
          line_end: 3,
        }],
        token_budget: 20,
      });

      expect(result.canonical_reads).toHaveLength(1);
      expect(result.canonical_reads[0]!.text).toBe('Line two.\nLine three.');
      expect(result.canonical_reads[0]!.selector.content_hash).toBeDefined();
    });
  });

  test('caps projected char_end windows by token budget', async () => {
    await withEngine('projection-char-end-cap', async (engine) => {
      await importFromContent(engine, 'concepts/projection-cap-context', [
        '---',
        'type: concept',
        'title: Projection Cap Context',
        '---',
        'Alpha '.repeat(100),
      ].join('\n'), { path: 'concepts/projection-cap-context.md' });

      const originalGetPageProjection = engine.getPageProjection.bind(engine);
      let requestedCharLimit: number | undefined;
      engine.getPageProjection = async (slug, options) => {
        requestedCharLimit = options?.windows?.compiled_truth?.char_limit;
        return originalGetPageProjection(slug, options);
      };

      const result = await readContext(engine, {
        selectors: [{
          kind: 'compiled_truth',
          slug: 'concepts/projection-cap-context',
          char_start: 0,
          char_end: 10_000,
        }],
        token_budget: 1,
      });

      expect(result.canonical_reads[0]!.text.length).toBeLessThanOrEqual(4);
      expect(requestedCharLimit).toBeLessThanOrEqual(4);
    });
  });

  test('blocks direct personal selectors before disclosing canonical reads', async () => {
    await withEngine('personal-scope-gate', async (engine) => {
      await engine.upsertProfileMemoryEntry({
        id: 'profile-direct-read',
        scope_id: 'personal:default',
        profile_type: 'preference',
        subject: 'Morning routine',
        content: 'Private personal detail.',
        source_refs: ['User, direct message, 2026-05-07 10:00 KST'],
        sensitivity: 'personal',
        export_status: 'private_only',
        last_confirmed_at: new Date('2026-05-07T01:00:00.000Z'),
        superseded_by: null,
      });

      const denied = await readContext(engine, {
        selectors: [{ kind: 'profile_memory', object_id: 'profile-direct-read' }],
        requested_scope: 'work',
      });

      expect(denied.scope_gate?.policy).toBe('deny');
      expect(denied.canonical_reads).toEqual([]);
      expect(denied.unread_required).toHaveLength(1);
      expect(denied.answer_ready.ready).toBe(false);
      expect(denied.answer_ready.unsupported_reasons).toContain('scope_gate_deny');

      const allowed = await readContext(engine, {
        selectors: [{ kind: 'profile_memory', object_id: 'profile-direct-read' }],
        requested_scope: 'personal',
      });

      expect(allowed.scope_gate?.policy).toBe('allow');
      expect(allowed.answer_ready.ready).toBe(true);
      expect(allowed.canonical_reads[0]!.authority).toBe('profile_memory');
      expect(allowed.evidence_claims[0]!.claim_kind).toBe('profile_memory');
      expect(allowed.canonical_reads[0]!.text).toContain('Private personal detail.');
    });
  });

  test('reads personal episodes with personal episode authority when scope allows it', async () => {
    await withEngine('personal-episode-authority', async (engine) => {
      await engine.createPersonalEpisodeEntry({
        id: 'episode-direct-read',
        scope_id: 'personal:default',
        title: 'Morning reset',
        start_time: new Date('2026-05-07T01:00:00.000Z'),
        end_time: new Date('2026-05-07T01:30:00.000Z'),
        source_kind: 'chat',
        summary: 'Private episode detail.',
        source_refs: ['User, direct message, 2026-05-07 10:15 KST'],
        candidate_ids: [],
      });

      const result = await readContext(engine, {
        selectors: [{ kind: 'personal_episode', object_id: 'episode-direct-read' }],
        requested_scope: 'personal',
      });

      expect(result.scope_gate?.policy).toBe('allow');
      expect(result.answer_ready.ready).toBe(true);
      expect(result.canonical_reads[0]!.authority).toBe('personal_episode');
      expect(result.evidence_claims[0]!.claim_kind).toBe('personal_episode');
      expect(result.canonical_reads[0]!.text).toContain('Private episode detail.');
    });
  });

  test('auto reads derive required selectors through retrieve_context before reading evidence', async () => {
    await withEngine('auto-read', async (engine) => {
      await importFromContent(engine, 'concepts/auto-context', [
        '---',
        'type: concept',
        'title: Auto Context',
        '---',
        '# Compiled Truth',
        'Auto read canonical evidence comes from read_context after retrieve_context selection.',
        '[Source: User, direct message, 2026-05-07 10:05 KST]',
      ].join('\n'), { path: 'concepts/auto-context.md' });

      const result = await readContext(engine, {
        query: 'Auto read canonical evidence',
        reads: 'auto',
        include_source_refs: true,
      });

      expect(result.answer_ready.ready).toBe(true);
      expect(result.canonical_reads).toHaveLength(1);
      expect(result.answer_ready.answer_ground).toHaveLength(1);
      expect(result.answer_ready.answer_ground[0]!.selector_id).toBe(
        result.canonical_reads[0]!.selector.selector_id,
      );
      expect(result.answer_ready.answer_ground.every((selector) => selector.kind !== 'source_ref')).toBe(true);
      expect(result.canonical_reads[0]!.text).toContain('Auto read canonical evidence');
      expect(result.warnings).toContain('Auto reads selected from retrieve_context required_reads.');
    });
  });

  test('continues inside a long clipped line without skipping unread evidence', async () => {
    await withEngine('line-continuation', async (engine) => {
      const longLine = [
        'LONG_LINE_START',
        'SEGMENT_ALPHA',
        'SEGMENT_BRAVO',
        'SEGMENT_CHARLIE',
        'SEGMENT_DELTA',
        'SEGMENT_ECHO',
        'SEGMENT_FOXTROT',
        'SEGMENT_GOLF',
        'LONG_LINE_END',
      ].join(' ');
      await importFromContent(engine, 'concepts/line-aware-context', [
        '---',
        'type: concept',
        'title: Line Aware Context',
        '---',
        '# Compiled Truth',
        'Intro.',
        '',
        '## Evidence',
        longLine,
        '[Source: User, direct message, 2026-05-07 09:03 KST]',
      ].join('\n'), { path: 'concepts/line-aware-context.md' });

      const sections = await engine.listNoteSectionEntries({
        scope_id: 'workspace:default',
        page_slug: 'concepts/line-aware-context',
        limit: 10,
      });
      const evidence = sections.find((section) => section.heading_text === 'Evidence');
      if (!evidence) throw new Error('evidence section fixture missing');

      const firstRead = await readContext(engine, {
        selectors: [{ kind: 'section', section_id: evidence.section_id }],
        token_budget: 8,
      });

      expect(firstRead.canonical_reads[0]!.has_more).toBe(true);
      expect(firstRead.canonical_reads[0]!.token_estimate).toBeLessThanOrEqual(8);
      expect(firstRead.canonical_reads[0]!.text).toContain('LONG_LINE_START');
      expect(firstRead.canonical_reads[0]!.text).not.toContain('LONG_LINE_END');
      expect(firstRead.continuations).toHaveLength(1);
      expect(firstRead.continuations[0]!.kind).toBe('section');
      expect(firstRead.continuations[0]!.char_start).toBe(firstRead.canonical_reads[0]!.text.length);
      expect(firstRead.continuations[0]!.content_hash).toBe(firstRead.canonical_reads[0]!.selector.content_hash);
      expect(firstRead.continuations[0]!.selector_id).toContain('@chars:');

      const continuationRead = await readContext(engine, {
        selectors: [firstRead.continuations[0]!],
        token_budget: 8,
      });

      expect(continuationRead.canonical_reads[0]!.token_estimate).toBeLessThanOrEqual(8);
      expect(continuationRead.canonical_reads[0]!.text).toBe(
        evidence.section_text.slice(
          firstRead.canonical_reads[0]!.text.length,
          firstRead.canonical_reads[0]!.text.length + continuationRead.canonical_reads[0]!.text.length,
        ),
      );
      expect(continuationRead.canonical_reads[0]!.text).toContain('SEGMENT');
      expect(continuationRead.canonical_reads[0]!.text).not.toContain('LONG_LINE_START');
    });
  });

  test('rejects stale section continuation selectors after section text changes', async () => {
    await withEngine('section-stale-continuation', async (engine) => {
      const sectionContent = [
        'LONG_LINE_START',
        'SEGMENT_ALPHA',
        'SEGMENT_BRAVO',
        'SEGMENT_CHARLIE',
        'LONG_LINE_END',
      ].join(' ');
      await importFromContent(engine, 'concepts/section-stale-context', [
        '---',
        'type: concept',
        'title: Section Stale Context',
        '---',
        '# Compiled Truth',
        'Intro.',
        '',
        '## Evidence',
        sectionContent,
      ].join('\n'), { path: 'concepts/section-stale-context.md' });

      const sections = await engine.listNoteSectionEntries({
        scope_id: 'workspace:default',
        page_slug: 'concepts/section-stale-context',
        limit: 10,
      });
      const evidence = sections.find((section) => section.heading_text === 'Evidence');
      if (!evidence) throw new Error('evidence section fixture missing');

      const firstRead = await readContext(engine, {
        selectors: [{ kind: 'section', section_id: evidence.section_id }],
        token_budget: 2,
      });
      const continuation = firstRead.continuations[0]!;
      expect(continuation.content_hash).toBeDefined();

      await importFromContent(engine, 'concepts/section-stale-context', [
        '---',
        'type: concept',
        'title: Section Stale Context',
        '---',
        '# Compiled Truth',
        'Intro.',
        '',
        '## Evidence',
        'Updated evidence should not be mixed into the old continuation.',
      ].join('\n'), { path: 'concepts/section-stale-context.md' });

      const staleRead = await readContext(engine, {
        selectors: [continuation],
        token_budget: 20,
      });

      expect(staleRead.canonical_reads).toEqual([]);
      expect(staleRead.unread_required[0]!.freshness).toBe('stale');
      expect(staleRead.answer_ready.unsupported_reasons).toContain('stale_continuation');
    });
  });

  test('reports stale section selectors when the section target disappears after mutation', async () => {
    await withEngine('section-stale-missing', async (engine) => {
      await importFromContent(engine, 'concepts/section-missing-context', [
        '---',
        'type: concept',
        'title: Section Missing Context',
        '---',
        '# Compiled Truth',
        'Intro.',
        '',
        '## Evidence',
        'Evidence that will be removed.',
      ].join('\n'), { path: 'concepts/section-missing-context.md' });

      const sections = await engine.listNoteSectionEntries({
        scope_id: 'workspace:default',
        page_slug: 'concepts/section-missing-context',
        limit: 10,
      });
      const evidence = sections.find((section) => section.heading_text === 'Evidence');
      if (!evidence) throw new Error('evidence section fixture missing');
      const page = await engine.getPage('concepts/section-missing-context');
      if (!page?.content_hash) throw new Error('fixture page hash missing');

      await importFromContent(engine, 'concepts/section-missing-context', [
        '---',
        'type: concept',
        'title: Section Missing Context',
        '---',
        '# Compiled Truth',
        'Intro changed and the evidence heading disappeared.',
      ].join('\n'), { path: 'concepts/section-missing-context.md' });

      const staleRead = await readContext(engine, {
        selectors: [{
          kind: 'section',
          slug: 'concepts/section-missing-context',
          section_id: evidence.section_id,
          content_hash: page.content_hash,
        }],
        token_budget: 20,
      });

      expect(staleRead.canonical_reads).toEqual([]);
      expect(staleRead.selector_warnings?.[0]?.code).toBe('stale_selector');
      expect(staleRead.answer_ready.unsupported_reasons).toContain('stale_selector');
    });
  });

  test('reports stale source_ref selectors when the source marker disappears after mutation', async () => {
    await withEngine('source-ref-stale-missing', async (engine) => {
      await importFromContent(engine, 'concepts/source-ref-stale-context', [
        '---',
        'type: concept',
        'title: Source Ref Stale Context',
        '---',
        '# Compiled Truth',
        'Claim with a source. [Source: Review, 2026-05-12]',
      ].join('\n'), { path: 'concepts/source-ref-stale-context.md' });
      const page = await engine.getPage('concepts/source-ref-stale-context');
      if (!page?.content_hash) throw new Error('fixture page hash missing');

      await importFromContent(engine, 'concepts/source-ref-stale-context', [
        '---',
        'type: concept',
        'title: Source Ref Stale Context',
        '---',
        '# Compiled Truth',
        'Claim changed and the source marker disappeared.',
      ].join('\n'), { path: 'concepts/source-ref-stale-context.md' });

      const staleRead = await readContext(engine, {
        selectors: [{
          kind: 'source_ref',
          slug: 'concepts/source-ref-stale-context',
          source_ref: 'Review, 2026-05-12',
          content_hash: page.content_hash,
        }],
        token_budget: 20,
      });

      expect(staleRead.canonical_reads).toEqual([]);
      expect(staleRead.selector_warnings?.[0]?.code).toBe('stale_selector');
      expect(staleRead.answer_ready.unsupported_reasons).toContain('stale_selector');
    });
  });

  test('reports pending note_sections freshness instead of a generic missing section', async () => {
    await withEngine('section-derived-pending', async (engine) => {
      await importFromContent(engine, 'concepts/section-derived-pending', [
        '---',
        'type: concept',
        'title: Section Derived Pending',
        '---',
        '# Compiled Truth',
        '## Stable Section',
        'Original section evidence. [Source: User, direct message, 2026-05-14 09:00 KST]',
      ].join('\n'), { path: 'concepts/section-derived-pending.md' });

      await importFromContent(engine, 'concepts/section-derived-pending', [
        '---',
        'type: concept',
        'title: Section Derived Pending',
        '---',
        '# Compiled Truth',
        '## Stable Section',
        'Updated section evidence. [Source: User, direct message, 2026-05-14 09:01 KST]',
      ].join('\n'), {
        path: 'concepts/section-derived-pending.md',
        deferDerived: true,
      });

      const result = await readContext(engine, {
        selectors: [{
          kind: 'section',
          section_id: 'concepts/section-derived-pending#compiled-truth/stable-section',
        }],
      });

      expect(result.canonical_reads).toEqual([]);
      expect(result.selector_warnings?.[0]).toMatchObject({
        code: 'derived_pending',
        slug: 'concepts/section-derived-pending',
      });
      expect(result.answer_ready.unsupported_reasons).toContain('derived_pending');
    });
  });

  test('reports pending note_sections freshness for source_ref reads', async () => {
    await withEngine('source-ref-derived-pending', async (engine) => {
      await importFromContent(engine, 'concepts/source-ref-derived-pending', [
        '---',
        'type: concept',
        'title: Source Ref Derived Pending',
        '---',
        '# Compiled Truth',
        '## Evidence',
        'Original evidence. [Source: User, direct message, 2026-05-14 09:02 KST]',
      ].join('\n'), { path: 'concepts/source-ref-derived-pending.md' });

      await importFromContent(engine, 'concepts/source-ref-derived-pending', [
        '---',
        'type: concept',
        'title: Source Ref Derived Pending',
        '---',
        '# Compiled Truth',
        '## Evidence',
        'Updated evidence. [Source: User, direct message, 2026-05-14 09:03 KST]',
      ].join('\n'), {
        path: 'concepts/source-ref-derived-pending.md',
        deferDerived: true,
      });

      const result = await readContext(engine, {
        selectors: [{
          kind: 'source_ref',
          slug: 'concepts/source-ref-derived-pending',
          source_ref: 'User, direct message, 2026-05-14 09:03 KST',
        }],
      });

      expect(result.canonical_reads).toEqual([]);
      expect(result.selector_warnings?.[0]).toMatchObject({
        code: 'derived_pending',
        slug: 'concepts/source-ref-derived-pending',
      });
      expect(result.answer_ready.unsupported_reasons).toContain('derived_pending');
    });
  });

  test('reports pending note_sections freshness for path-scoped source_ref reads', async () => {
    await withEngine('source-ref-path-derived-pending', async (engine) => {
      await importFromContent(engine, 'concepts/source-ref-path-derived-pending', [
        '---',
        'type: concept',
        'title: Source Ref Path Derived Pending',
        '---',
        '# Compiled Truth',
        '## Evidence',
        'Original path evidence. [Source: User, direct message, 2026-05-14 09:04 KST]',
      ].join('\n'), { path: 'concepts/source-ref-path-derived-pending.md' });

      await importFromContent(engine, 'concepts/source-ref-path-derived-pending', [
        '---',
        'type: concept',
        'title: Source Ref Path Derived Pending',
        '---',
        '# Compiled Truth',
        '## Evidence',
        'Updated path evidence. [Source: User, direct message, 2026-05-14 09:05 KST]',
      ].join('\n'), {
        path: 'concepts/source-ref-path-derived-pending.md',
        deferDerived: true,
      });

      const result = await readContext(engine, {
        selectors: [{
          kind: 'source_ref',
          path: 'concepts/source-ref-path-derived-pending.md',
          source_ref: 'User, direct message, 2026-05-14 09:05 KST',
        }],
      });

      expect(result.canonical_reads).toEqual([]);
      expect(result.selector_warnings?.[0]).toMatchObject({
        code: 'derived_pending',
        slug: 'concepts/source-ref-path-derived-pending',
      });
      expect(result.answer_ready.unsupported_reasons).toContain('derived_pending');
    });
  });

  test('reports pending note_sections freshness for alias-path source_ref reads', async () => {
    await withEngine('source-ref-alias-path-derived-pending', async (engine) => {
      await importFromContent(engine, 'concepts/path-alias-source', [
        '---',
        'type: concept',
        'title: Path Alias Source',
        '---',
        '# Compiled Truth',
        '## Evidence',
        'Original alias evidence. [Source: User, direct message, 2026-05-14 09:06 KST]',
      ].join('\n'), { path: 'aliases/source-note.md' });

      await importFromContent(engine, 'concepts/path-alias-source', [
        '---',
        'type: concept',
        'title: Path Alias Source',
        '---',
        '# Compiled Truth',
        '## Evidence',
        'Updated alias evidence. [Source: User, direct message, 2026-05-14 09:07 KST]',
      ].join('\n'), {
        path: 'aliases/source-note.md',
        deferDerived: true,
      });

      const result = await readContext(engine, {
        selectors: [{
          kind: 'source_ref',
          path: 'aliases/source-note.md',
          source_ref: 'User, direct message, 2026-05-14 09:07 KST',
        }],
      });

      expect(result.canonical_reads).toEqual([]);
      expect(result.selector_warnings?.[0]).toMatchObject({
        code: 'derived_pending',
        slug: 'concepts/path-alias-source',
      });
      expect(result.answer_ready.unsupported_reasons).toContain('derived_pending');
    });
  });

  test('accepts page content_hash for source_ref selectors', async () => {
    await withEngine('source-ref-page-hash', async (engine) => {
      await importFromContent(engine, 'concepts/source-ref-page-hash', [
        '---',
        'type: concept',
        'title: Source Ref Page Hash',
        '---',
        '# Compiled Truth',
        'Claim bound to page snapshot. [Source: Stable Review, 2026-05-12]',
      ].join('\n'), { path: 'concepts/source-ref-page-hash.md' });
      const page = await engine.getPage('concepts/source-ref-page-hash');
      if (!page?.content_hash) throw new Error('source ref page hash fixture missing');

      const result = await readContext(engine, {
        selectors: [{
          kind: 'source_ref',
          slug: 'concepts/source-ref-page-hash',
          source_ref: 'Stable Review, 2026-05-12',
          content_hash: page.content_hash,
        }],
        token_budget: 200,
      });

      expect(result.canonical_reads).toHaveLength(1);
      expect(result.canonical_reads[0]!.text).toContain('Claim bound to page snapshot.');
      expect(result.canonical_reads[0]!.selector.content_hash).toBe(page.content_hash);
    });
  });

  test('reports stale compiled truth selectors when the page was deleted', async () => {
    await withEngine('compiled-stale-deleted', async (engine) => {
      await importFromContent(engine, 'concepts/deleted-context', [
        '---',
        'type: concept',
        'title: Deleted Context',
        '---',
        'Deleted canonical evidence.',
      ].join('\n'), { path: 'concepts/deleted-context.md' });
      const page = await engine.getPage('concepts/deleted-context');
      if (!page?.content_hash) throw new Error('fixture page hash missing');
      await engine.deletePage('concepts/deleted-context');

      const staleRead = await readContext(engine, {
        selectors: [{
          kind: 'compiled_truth',
          slug: 'concepts/deleted-context',
          content_hash: page.content_hash,
        }],
        token_budget: 20,
      });

      expect(staleRead.canonical_reads).toEqual([]);
      expect(staleRead.selector_warnings?.[0]?.code).toBe('stale_selector');
      expect(staleRead.selector_warnings?.[0]?.current_content_hash).toBeNull();
      expect(staleRead.answer_ready.unsupported_reasons).toContain('stale_selector');
    });
  });

  test('reports selectors beyond max_selectors as unread required', async () => {
    await withEngine('max-selectors', async (engine) => {
      await importFromContent(engine, 'concepts/first-context', [
        '---',
        'type: concept',
        'title: First Context',
        '---',
        '# Compiled Truth',
        'First selector evidence.',
      ].join('\n'), { path: 'concepts/first-context.md' });
      await importFromContent(engine, 'concepts/second-context', [
        '---',
        'type: concept',
        'title: Second Context',
        '---',
        '# Compiled Truth',
        'Second selector evidence.',
      ].join('\n'), { path: 'concepts/second-context.md' });

      const result = await readContext(engine, {
        selectors: [
          { kind: 'compiled_truth', slug: 'concepts/first-context' },
          { kind: 'compiled_truth', slug: 'concepts/second-context' },
        ],
        max_selectors: 1,
      });

      expect(result.canonical_reads).toHaveLength(1);
      expect(result.canonical_reads[0]!.text).toContain('First selector evidence.');
      expect(result.unread_required).toHaveLength(1);
      expect(result.unread_required[0]!.selector_id).toBe('compiled_truth:workspace:default:concepts/second-context');
      expect(result.warnings).toContain(
        'Selector deferred by max_selectors: compiled_truth:workspace:default:concepts/second-context',
      );
      expect(result.answer_ready.ready).toBe(false);
    });
  });

  test('reads source_ref only when page disambiguation identifies one section', async () => {
    await withEngine('source-ref-disambiguation', async (engine) => {
      const sourceRef = 'User, shared source, 2026-05-07 09:10 KST';
      await importFromContent(engine, 'concepts/a', [
        '---',
        'type: concept',
        'title: Concept A',
        '---',
        '# Compiled Truth',
        'Page A content.',
        `[Source: ${sourceRef}]`,
      ].join('\n'), { path: 'concepts/a.md' });
      await importFromContent(engine, 'concepts/b', [
        '---',
        'type: concept',
        'title: Concept B',
        '---',
        '# Compiled Truth',
        'Page B content.',
        `[Source: ${sourceRef}]`,
      ].join('\n'), { path: 'concepts/b.md' });

      const disambiguated = await readContext(engine, {
        selectors: [{ kind: 'source_ref', source_ref: sourceRef, slug: 'concepts/b' }],
        token_budget: 200,
      });

      expect(disambiguated.answer_ready.ready).toBe(true);
      expect(disambiguated.canonical_reads).toHaveLength(1);
      expect(disambiguated.canonical_reads[0]!.text).toContain('Page B content.');
      expect(disambiguated.canonical_reads[0]!.text).not.toContain('Page A content.');

      const ambiguous = await readContext(engine, {
        selectors: [{ kind: 'source_ref', source_ref: sourceRef }],
        token_budget: 200,
      });

      expect(ambiguous.canonical_reads).toHaveLength(0);
      expect(ambiguous.unread_required).toHaveLength(1);
      expect(ambiguous.unread_required[0]!.kind).toBe('source_ref');
      expect(ambiguous.answer_ready.ready).toBe(false);
    });
  });

  test('blocks bare source_ref selectors that resolve to personal pages under work scope', async () => {
    await withEngine('source-ref-personal-gate', async (engine) => {
      const sourceRef = 'User, personal source, 2026-05-07 10:20 KST';
      await importFromContent(engine, 'personal/private-note', [
        '---',
        'type: concept',
        'title: Private Note',
        '---',
        '# Compiled Truth',
        'Private source-ref evidence must not leak through bare source_ref.',
        `[Source: ${sourceRef}]`,
      ].join('\n'), { path: 'personal/private-note.md' });

      const denied = await readContext(engine, {
        selectors: [{ kind: 'source_ref', source_ref: sourceRef }],
        requested_scope: 'work',
      });

      expect(denied.scope_gate?.policy).toBe('deny');
      expect(denied.answer_ready.ready).toBe(false);
      expect(denied.canonical_reads).toEqual([]);
      expect(denied.unread_required).toHaveLength(1);
      expect(denied.answer_ready.unsupported_reasons).toContain('scope_gate_deny');
    });
  });

  test('blocks timeline_entry object ids that encode personal slugs under work scope', async () => {
    await withEngine('timeline-entry-personal-gate', async (engine) => {
      await importFromContent(engine, 'personal/timeline-note', [
        '---',
        'type: concept',
        'title: Personal Timeline Note',
        '---',
        '# Compiled Truth',
        'Personal timeline fixture.',
      ].join('\n'), { path: 'personal/timeline-note.md' });
      await engine.addTimelineEntry('personal/timeline-note', {
        date: '2026-05-07',
        source: 'User, personal timeline, 2026-05-07 10:25 KST',
        summary: 'Private timeline entry must not leak through encoded object id.',
      });
      const [entry] = await engine.getTimeline('personal/timeline-note');
      if (!entry) throw new Error('timeline entry fixture missing');

      const denied = await readContext(engine, {
        selectors: [{
          kind: 'timeline_entry',
          object_id: `personal/timeline-note:${entry.id}`,
        }],
        requested_scope: 'work',
      });

      expect(denied.scope_gate?.policy).toBe('deny');
      expect(denied.answer_ready.ready).toBe(false);
      expect(denied.canonical_reads).toEqual([]);
      expect(denied.unread_required).toHaveLength(1);
    });
  });

  test('reads timeline_entry as timeline evidence when scope allows it', async () => {
    await withEngine('timeline-entry-evidence-kind', async (engine) => {
      await importFromContent(engine, 'concepts/timeline-entry-context', [
        '---',
        'type: concept',
        'title: Timeline Entry Context',
        '---',
        '# Compiled Truth',
        'Timeline entry fixture.',
      ].join('\n'), { path: 'concepts/timeline-entry-context.md' });
      await engine.addTimelineEntry('concepts/timeline-entry-context', {
        date: '2026-05-07',
        source: 'User, timeline source, 2026-05-07 10:30 KST',
        summary: 'Single timeline entry evidence.',
      });
      const [entry] = await engine.getTimeline('concepts/timeline-entry-context');
      if (!entry) throw new Error('timeline entry fixture missing');

      const result = await readContext(engine, {
        selectors: [{
          kind: 'timeline_entry',
          slug: 'concepts/timeline-entry-context',
          object_id: String(entry.id),
        }],
      });

      expect(result.answer_ready.ready).toBe(true);
      expect(result.canonical_reads[0]!.authority).toBe('source_or_timeline_evidence');
      expect(result.evidence_claims[0]!.claim_kind).toBe('timeline_evidence');
    });
  });

  test('rejects invalid direct service numeric bounds', async () => {
    await withEngine('invalid-read-bounds', async (engine) => {
      await expect(readContext(engine, {
        selectors: [{ kind: 'compiled_truth', slug: 'concepts/anything' }],
        max_selectors: 0,
      })).rejects.toThrow('max_selectors must be a positive integer');

      await expect(readContext(engine, {
        selectors: [{ kind: 'compiled_truth', slug: 'concepts/anything' }],
        token_budget: -1,
      })).rejects.toThrow('token_budget must be a positive integer');
    });
  });

  test('reports out-of-bounds char_start as unread instead of returning empty evidence', async () => {
    await withEngine('char-start-oob', async (engine) => {
      await importFromContent(engine, 'concepts/short-context', [
        '---',
        'type: concept',
        'title: Short Context',
        '---',
        '# Compiled Truth',
        'Short evidence.',
      ].join('\n'), { path: 'concepts/short-context.md' });

      const result = await readContext(engine, {
        selectors: [{ kind: 'compiled_truth', slug: 'concepts/short-context', char_start: 10_000 }],
        token_budget: 200,
      });

      expect(result.canonical_reads).toHaveLength(0);
      expect(result.unread_required).toHaveLength(1);
      expect(result.unread_required[0]!.selector_id).toBe(
        'compiled_truth:workspace:default:concepts/short-context@chars:10000:',
      );
      expect(result.warnings).toContain(
        'Selector could not be read: compiled_truth:workspace:default:concepts/short-context@chars:10000:',
      );
      expect(result.answer_ready.ready).toBe(false);
    });
  });

  test('timeline_range reads page timeline through projection without consulting timeline entries', async () => {
    await withEngine('timeline-projection', async (engine) => {
      await importFromContent(engine, 'concepts/timeline-context', [
        '---',
        'type: concept',
        'title: Timeline Context',
        '---',
        '# Compiled Truth',
        'Timeline fixture.',
        '',
        '---',
        '',
        '- **2026-05-06** | newest entry [Source: timeline source newest]',
        '- **2026-05-05** | second entry [Source: timeline source second]',
        '- **2026-05-04** | third entry [Source: timeline source third]',
        '- **2026-05-03** | fourth entry [Source: timeline source fourth]',
        '- **2026-05-02** | fifth entry [Source: timeline source fifth]',
        '- **2026-05-01** | oldest entry [Source: timeline source oldest]',
      ].join('\n'), { path: 'concepts/timeline-context.md' });
      failOnTimelineTableRead(engine);

      const result = await readContext(engine, {
        selectors: [{ kind: 'timeline_range', slug: 'concepts/timeline-context' }],
        token_budget: 1_000,
      });

      expect(result.canonical_reads).toHaveLength(1);
      expect(result.canonical_reads[0]!.text).toContain('newest entry');
      expect(result.canonical_reads[0]!.text).toContain('oldest entry');
      expect(result.canonical_reads[0]!.source_refs).toContain('timeline source oldest');
      expect(result.canonical_reads[0]!.has_more).toBe(false);
    });
  });

  test('timeline_range falls back to structured timeline entries when page timeline is empty', async () => {
    await withEngine('timeline-entry-fallback', async (engine) => {
      await importFromContent(engine, 'concepts/timeline-entry-fallback', [
        '---',
        'type: concept',
        'title: Timeline Entry Fallback',
        '---',
        '# Compiled Truth',
        'Timeline entry fallback fixture.',
      ].join('\n'), { path: 'concepts/timeline-entry-fallback.md' });
      await engine.addTimelineEntry('concepts/timeline-entry-fallback', {
        date: '2026-05-12',
        source: 'timeline entry source',
        summary: 'Structured timeline evidence.',
        detail: 'Structured detail.',
      });

      const result = await readContext(engine, {
        selectors: [{ kind: 'timeline_range', slug: 'concepts/timeline-entry-fallback' }],
        token_budget: 200,
      });

      expect(result.canonical_reads).toHaveLength(1);
      expect(result.canonical_reads[0]!.text).toContain('Structured timeline evidence.');
      expect(result.canonical_reads[0]!.source_refs).toEqual(['timeline entry source']);
    });
  });

  test('filters source_refs to markers present in the returned char span', async () => {
    await withEngine('source-refs-char-span', async (engine) => {
      await importFromContent(engine, 'concepts/source-span', [
        '---',
        'type: concept',
        'title: Source Span',
        '---',
        '# Compiled Truth',
        'First claim. [Source: A]',
        'Second claim. [Source: B]',
      ].join('\n'), { path: 'concepts/source-span.md' });
      const page = await engine.getPage('concepts/source-span');
      if (!page) throw new Error('source span fixture missing');

      const start = page.compiled_truth.indexOf('First claim.');
      const end = page.compiled_truth.indexOf('Second claim.');
      if (start < 0 || end < 0) throw new Error('source span text missing');

      const result = await readContext(engine, {
        selectors: [{
          kind: 'compiled_truth',
          slug: 'concepts/source-span',
          char_start: start,
          char_end: end,
        }],
        token_budget: 200,
      });

      expect(result.canonical_reads).toHaveLength(1);
      expect(result.canonical_reads[0]!.text).toContain('[Source: A]');
      expect(result.canonical_reads[0]!.text).not.toContain('[Source: B]');
      expect(result.canonical_reads[0]!.source_refs).toEqual(['A']);
    });
  });

  test('honors include_source_refs false even when returned text contains source markers', async () => {
    await withEngine('source-refs-disabled', async (engine) => {
      await importFromContent(engine, 'concepts/source-ref-opt-out', [
        '---',
        'type: concept',
        'title: Source Ref Opt Out',
        '---',
        '# Compiled Truth',
        'Hidden evidence stays in text. [Source: Hidden]',
      ].join('\n'), { path: 'concepts/source-ref-opt-out.md' });

      const result = await readContext(engine, {
        selectors: [{ kind: 'compiled_truth', slug: 'concepts/source-ref-opt-out' }],
        include_source_refs: false,
        token_budget: 200,
      });

      expect(result.canonical_reads).toHaveLength(1);
      expect(result.canonical_reads[0]!.text).toContain('[Source: Hidden]');
      expect(result.canonical_reads[0]!.source_refs).toEqual([]);
    });
  });

  test('reads task working set before raw project context for continuation', async () => {
    await withEngine('task', async (engine) => {
      await engine.createTaskThread({
        id: 'task-read-context',
        scope: 'work',
        title: 'Task Read Context',
        status: 'active',
        repo_path: '/repo/mbrain',
        branch_name: 'feature/context',
        current_summary: 'Continue retrieval implementation.',
      });
      await engine.upsertTaskWorkingSet({
        task_id: 'task-read-context',
        active_paths: ['src/core/operations.ts'],
        active_symbols: ['readContext'],
        blockers: [],
        open_questions: ['How should continuation selectors work?'],
        next_steps: ['Read task state first.'],
        verification_notes: ['Run focused tests.'],
      });

      const result = await readContext(engine, {
        selectors: [{ kind: 'task_working_set', object_id: 'task-read-context' }],
      });

      expect(result.answer_ready.ready).toBe(true);
      expect(result.canonical_reads[0]!.authority).toBe('operational_memory');
      expect(result.canonical_reads[0]!.text).toContain('src/core/operations.ts');
      expect(result.canonical_reads[0]!.text).toContain('Read task state first.');
    });
  });

  test('persists a retrieval trace when requested', async () => {
    await withEngine('persist-trace', async (engine) => {
      await engine.createTaskThread({
        id: 'task-read-trace',
        scope: 'work',
        title: 'Read Trace',
        status: 'active',
        repo_path: '/repo/mbrain',
        branch_name: 'feature/context',
        current_summary: 'Trace read context.',
      });
      await importFromContent(engine, 'concepts/read-trace', [
        '---',
        'type: concept',
        'title: Read Trace',
        '---',
        '# Compiled Truth',
        'Trace-backed canonical read evidence.',
      ].join('\n'), { path: 'concepts/read-trace.md' });

      const result = await readContext(engine, {
        selectors: [{ kind: 'compiled_truth', slug: 'concepts/read-trace' }],
        task_id: 'task-read-trace',
        persist_trace: true,
      });

      expect(result.trace?.task_id).toBe('task-read-trace');
      expect(result.trace?.scope).toBe('work');
      expect(result.trace?.route).toEqual(['read_context']);
      expect(result.trace?.source_refs).toContain('compiled_truth:workspace:default:concepts/read-trace');

      const traces = await engine.listRetrievalTraces('task-read-trace', { limit: 5 });
      expect(traces.map((trace) => trace.id)).toContain(result.trace!.id);
    });
  });

  test('reports unread selectors when canonical targets are missing', async () => {
    await withEngine('missing', async (engine) => {
      const result = await readContext(engine, {
        selectors: [{ kind: 'compiled_truth', slug: 'concepts/missing' }],
      });

      expect(result.answer_ready.ready).toBe(false);
      expect(result.unread_required).toHaveLength(1);
      expect(result.warnings).toContain('Selector could not be read: compiled_truth:workspace:default:concepts/missing');
    });
  });
});
