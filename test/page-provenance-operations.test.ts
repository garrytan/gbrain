import { describe, expect, test } from 'bun:test';
import { formatResult, operationsByName } from '../src/core/operations.ts';

function opContext(engine: any) {
  return {
    engine,
    config: {} as any,
    logger: console,
    dryRun: false,
  };
}

describe('page provenance why operation', () => {
  test('builds a unified why view for a page slug', async () => {
    const op = operationsByName.explain_page_provenance;
    expect(op?.cliHints?.name).toBe('why');
    const page = {
      id: 1,
      slug: 'systems/retrieval',
      type: 'system',
      title: 'Retrieval',
      compiled_truth: 'Retrieval uses canonical reads. [Source: User, direct message, 2026-07-03 09:00 KST]',
      timeline: '- **2026-07-03** | Retrieval changed. [Source: User, direct message, 2026-07-03 10:00 KST]',
      frontmatter: { aliases: ['retrieval'] },
      created_at: new Date('2026-07-03T00:00:00.000Z'),
      updated_at: new Date('2026-07-03T10:00:00.000Z'),
      compiled_truth_changed_at: new Date('2026-07-03T09:00:00.000Z'),
      timeline_changed_at: new Date('2026-07-03T10:00:00.000Z'),
    };
    const engine = {
      resolveSlugs: async () => ['systems/retrieval'],
      getPage: async () => page,
      getTimeline: async () => [{
        id: 1,
        date: '2026-07-03',
        content: 'Retrieval changed.',
        source: 'User',
        created_at: new Date('2026-07-03T10:00:00.000Z'),
      }],
      getVersions: async () => [
        { id: 2, slug: 'systems/retrieval', content_hash: 'hash:v2', created_at: new Date('2026-07-03T10:00:00.000Z') },
        { id: 1, slug: 'systems/retrieval', content_hash: 'hash:v1', created_at: new Date('2026-07-03T09:00:00.000Z') },
      ],
      getIngestLog: async () => [
        {
          id: 10,
          source_type: 'sync',
          source_ref: 'git:brain',
          pages_updated: ['systems/retrieval'],
          summary: 'Imported retrieval page.',
          created_at: new Date('2026-07-03T10:01:00.000Z'),
        },
      ],
      getBacklinks: async () => [{
        from: 'projects/mbrain',
        to: 'systems/retrieval',
        context: 'uses retrieval',
        link_type: 'wikilink',
      }],
      listMemoryCandidateEntries: async () => [{
        id: 'candidate:retrieval',
        status: 'promoted',
        verification_status: 'verified',
        proposed_content: 'Retrieval should explain why it selected reads.',
        source_refs: ['Source: User, direct message, 2026-07-03 09:30 KST'],
        reviewed_at: new Date('2026-07-03T09:40:00.000Z'),
        review_reason: 'promoted into canonical page',
      }],
      listCanonicalHandoffEntries: async () => [{
        id: 'handoff:retrieval',
        candidate_id: 'candidate:retrieval',
        target_object_type: 'curated_note',
        target_object_id: 'systems/retrieval',
        completed_at: new Date('2026-07-03T09:45:00.000Z'),
        completion_kind: 'page_written',
        completion_ref: 'systems/retrieval',
      }],
    };

    const result = await op.handler(opContext(engine), { slug: 'retrieval', limit: 5 }) as any;

    expect(result.resolved_slug).toBe('systems/retrieval');
    expect(result.citations).toContain('User, direct message, 2026-07-03 09:00 KST');
    expect(result.version_history).toHaveLength(2);
    expect(result.ingest_log).toHaveLength(1);
    expect(result.candidate_trail[0]).toMatchObject({
      id: 'candidate:retrieval',
      status: 'promoted',
      verification_status: 'verified',
    });
    expect(result.canonical_handoffs[0]).toMatchObject({
      id: 'handoff:retrieval',
      candidate_id: 'candidate:retrieval',
    });

    const formatted = formatResult('explain_page_provenance', result);
    expect(formatted).toContain('Why: systems/retrieval');
    expect(formatted).toContain('Citations');
    expect(formatted).toContain('Version History');
    expect(formatted).toContain('Ingest Log');
    expect(formatted).toContain('Memory Candidate Trail');
    expect(formatted).toContain('Backlinks');
  });

  test('paginates provenance logs until matching ingest rows are found', async () => {
    const page = {
      slug: 'systems/retrieval',
      type: 'system',
      title: 'Retrieval',
      compiled_truth: 'Retrieval uses canonical reads.',
      timeline: '',
      frontmatter: {},
      created_at: new Date('2026-07-03T00:00:00.000Z'),
      updated_at: new Date('2026-07-03T10:00:00.000Z'),
      compiled_truth_changed_at: new Date('2026-07-03T09:00:00.000Z'),
      timeline_changed_at: new Date('2026-07-03T10:00:00.000Z'),
    };
    const calls: Array<{ limit?: number; offset?: number }> = [];
    const engine = {
      resolveSlugs: async () => ['systems/retrieval'],
      getPage: async () => page,
      getTimeline: async () => [],
      getVersions: async () => [],
      getBacklinks: async () => [],
      listMemoryCandidateEntries: async () => [],
      listCanonicalHandoffEntries: async () => [],
      getIngestLog: async (opts?: { limit?: number; offset?: number }) => {
        calls.push(opts ?? {});
        if ((opts?.offset ?? 0) === 0) {
          return Array.from({ length: opts?.limit ?? 50 }, (_, index) => ({
            id: index,
            source_type: 'sync',
            source_ref: `git:other:${index}`,
            pages_updated: [`systems/other-${index}`],
            summary: 'Unrelated import.',
            created_at: new Date('2026-07-03T10:01:00.000Z'),
          }));
        }
        return [{
          id: 100,
          source_type: 'sync',
          source_ref: 'git:brain',
          pages_updated: ['systems/retrieval'],
          summary: 'Imported retrieval page after older sync.',
          created_at: new Date('2026-07-03T09:01:00.000Z'),
        }];
      },
    };

    const result = await operationsByName.explain_page_provenance.handler(opContext(engine), {
      slug: 'retrieval',
      limit: 1,
    }) as any;

    expect(calls.length).toBeGreaterThan(1);
    expect(result.ingest_log).toHaveLength(1);
    expect(result.ingest_log[0].source_ref).toBe('git:brain');
  });
});
