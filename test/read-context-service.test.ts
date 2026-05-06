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
      expect(result.answer_ready.ready).toBe(false);
      expect(result.answer_ready.unsupported_reasons).toContain('continuation_required');
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
      expect(allowed.canonical_reads[0]!.text).toContain('Private personal detail.');
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

  test('timeline_range includes more than five entries before budget clipping', async () => {
    await withEngine('timeline-six', async (engine) => {
      await importFromContent(engine, 'concepts/timeline-context', [
        '---',
        'type: concept',
        'title: Timeline Context',
        '---',
        '# Compiled Truth',
        'Timeline fixture.',
      ].join('\n'), { path: 'concepts/timeline-context.md' });

      for (const entry of [
        ['2026-05-06', 'newest'],
        ['2026-05-05', 'second'],
        ['2026-05-04', 'third'],
        ['2026-05-03', 'fourth'],
        ['2026-05-02', 'fifth'],
        ['2026-05-01', 'oldest'],
      ] as const) {
        await engine.addTimelineEntry('concepts/timeline-context', {
          date: entry[0],
          source: `timeline source ${entry[1]}`,
          summary: `${entry[1]} entry`,
          detail: `${entry[1]} detail`,
        });
      }

      const result = await readContext(engine, {
        selectors: [{ kind: 'timeline_range', slug: 'concepts/timeline-context' }],
        token_budget: 1_000,
      });

      expect(result.canonical_reads).toHaveLength(1);
      expect(result.canonical_reads[0]!.text).toContain('newest entry');
      expect(result.canonical_reads[0]!.text).toContain('oldest entry');
      expect(result.canonical_reads[0]!.text).toContain('[Source: timeline source oldest]');
      expect(result.canonical_reads[0]!.has_more).toBe(false);
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
