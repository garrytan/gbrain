/**
 * Scenario S25 — memory consolidation preserves authority over time.
 *
 * Rejected and superseded candidates must disappear from default retrieval
 * while remaining visible in audit retrieval, and canonical answers must still
 * come from read_context.
 */

import { describe, expect, test } from 'bun:test';
import { allocateSqliteBrain } from './helpers.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { retrieveContext } from '../../src/core/services/retrieve-context-service.ts';
import { readContext } from '../../src/core/services/read-context-service.ts';
import {
  advanceMemoryCandidateStatus,
  createMemoryCandidateEntryWithStatusEvent,
} from '../../src/core/services/memory-inbox-service.ts';
import { promoteMemoryCandidateEntry } from '../../src/core/services/memory-inbox-promotion-service.ts';
import { recordCanonicalHandoff } from '../../src/core/services/canonical-handoff-service.ts';
import { supersedeMemoryCandidateEntry } from '../../src/core/services/memory-inbox-supersession-service.ts';

describe('S25 — memory consolidation retention', () => {
  test('default retrieval hides superseded candidates while audit retrieval preserves lifecycle history', async () => {
    const handle = await allocateSqliteBrain('s25-memory-consolidation-retention');
    const oldCandidateContent = 'Old retention candidate for systems/mbrain-retention.';
    const newCandidateContent = 'Newer retention candidate for systems/mbrain-retention.';

    try {
      await importFromContent(handle.engine, 'systems/mbrain-retention', [
        '---',
        'type: system',
        'title: MBrain retention fixture',
        '---',
        'Canonical retention truth stays source-grounded.',
        '[Source: Scenario S25]',
        '',
        '---',
        '',
        '- **2026-05-17** | Scenario seed. [Source: Scenario S25]',
      ].join('\n'), { path: 'systems/mbrain-retention.md' });

      const trace = await handle.engine.putRetrievalTrace({
        id: 'trace-s25-retention',
        task_id: null,
        scope: 'work',
        route: ['retrieve_context'],
        source_refs: ['page:systems/mbrain-retention'],
        verification: ['scenario:knowledge_qa'],
        selected_intent: 'broad_synthesis',
        outcome: 'retention scenario retrieval',
      });

      await createMemoryCandidateEntryWithStatusEvent(handle.engine, {
        id: 'candidate-s25-old',
        scope_id: 'workspace:default',
        candidate_type: 'fact',
        proposed_content: oldCandidateContent,
        source_refs: ['Scenario S25 old candidate'],
        generated_by: 'manual',
        extraction_kind: 'manual',
        confidence_score: 0.9,
        importance_score: 0.8,
        recurrence_score: 0.1,
        sensitivity: 'work',
        status: 'captured',
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain-retention',
        interaction_id: trace.id,
      });
      await advanceMemoryCandidateStatus(handle.engine, {
        id: 'candidate-s25-old',
        next_status: 'candidate',
        interaction_id: trace.id,
      });
      await advanceMemoryCandidateStatus(handle.engine, {
        id: 'candidate-s25-old',
        next_status: 'staged_for_review',
        interaction_id: trace.id,
      });
      await promoteMemoryCandidateEntry(handle.engine, {
        id: 'candidate-s25-old',
        interaction_id: trace.id,
      });
      await recordCanonicalHandoff(handle.engine, {
        candidate_id: 'candidate-s25-old',
        interaction_id: trace.id,
      });

      await createMemoryCandidateEntryWithStatusEvent(handle.engine, {
        id: 'candidate-s25-new',
        scope_id: 'workspace:default',
        candidate_type: 'fact',
        proposed_content: newCandidateContent,
        source_refs: ['Scenario S25 new candidate'],
        generated_by: 'manual',
        extraction_kind: 'manual',
        confidence_score: 0.95,
        importance_score: 0.9,
        recurrence_score: 0.2,
        sensitivity: 'work',
        status: 'captured',
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain-retention',
        interaction_id: trace.id,
      });
      await advanceMemoryCandidateStatus(handle.engine, {
        id: 'candidate-s25-new',
        next_status: 'candidate',
        interaction_id: trace.id,
      });
      await advanceMemoryCandidateStatus(handle.engine, {
        id: 'candidate-s25-new',
        next_status: 'staged_for_review',
        interaction_id: trace.id,
      });
      await promoteMemoryCandidateEntry(handle.engine, {
        id: 'candidate-s25-new',
        interaction_id: trace.id,
      });
      await supersedeMemoryCandidateEntry(handle.engine, {
        superseded_candidate_id: 'candidate-s25-old',
        replacement_candidate_id: 'candidate-s25-new',
        review_reason: 'Newer candidate supersedes the old candidate.',
        interaction_id: trace.id,
      });

      const normal = await retrieveContext(handle.engine, {
        query: 'retention',
        requested_scope: 'work',
        known_subjects: ['systems/mbrain-retention'],
      });
      expect(normal.answerability.must_read_context).toBe(true);
      expect(normal.required_reads).toContainEqual(expect.objectContaining({
        kind: 'compiled_truth',
        scope_id: 'workspace:default',
        slug: 'systems/mbrain-retention',
      }));
      expect(normal.candidate_signals.map((signal) => signal.candidate_id)).not.toContain('candidate-s25-old');
      expect(normal.candidate_signals.map((signal) => signal.candidate_id)).toContain('candidate-s25-new');
      expect(normal.candidate_signals.every((signal) => signal.activation === 'candidate_only')).toBe(true);

      const audit = await retrieveContext(handle.engine, {
        query: 'audit rejected superseded retention systems/mbrain-retention',
        requested_scope: 'work',
        known_subjects: ['systems/mbrain-retention'],
      });
      expect(audit.candidate_signal_policy.mode).toBe('audit');
      expect(audit.candidate_signals.map((signal) => signal.candidate_id)).toContain('candidate-s25-old');
      expect(audit.candidate_signals.find((signal) => signal.candidate_id === 'candidate-s25-old')!.status).toBe(
        'superseded',
      );

      const read = await readContext(handle.engine, {
        selectors: normal.required_reads,
        requested_scope: 'work',
      });
      const canonicalRead = read.canonical_reads.find(
        (entry) => entry.selector.slug === 'systems/mbrain-retention',
      );
      expect(canonicalRead?.authority).toBe('canonical_compiled_truth');
      expect(canonicalRead?.text).toContain('Canonical retention truth stays source-grounded.');
      expect(canonicalRead?.text).not.toContain(oldCandidateContent);
      expect(canonicalRead?.text).not.toContain(newCandidateContent);
    } finally {
      await handle.teardown();
    }
  });
});
