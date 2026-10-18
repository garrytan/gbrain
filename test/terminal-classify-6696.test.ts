/**
 * #6696 (PR C, C10): classifier follow-ups on the #6650 terminal-receipt classifier.
 *
 * Protects: a `source_changed` receipt whose canonical file is missing (a ghost page: the database page outlived its
 * file) is its own category with the ghost repair exit instead of a sync retry that can never import a file that is not
 * there; a `fence_unrenderable` adoption refusal written before the fix that stopped the loop (#6657) reads historical,
 * while one from a fixed build stays an unresolved defect.
 */
import { describe, expect, test } from 'bun:test';
import { classifyTerminal, TERMINAL_FIXED_IN, type TerminalInput } from '../src/core/persistence/terminal-classify.ts';

const base: TerminalInput = { source_id: 'src', slug: 'projects/acme-example', operation: 'submit_job', state: 'conflict', error_code: null, error_detail: null,
  recovery: null, blocked_reason: null, compacted: false };

describe('classifyTerminal (#6696 C10)', () => {
  test('a missing canonical file is its own category whose exit is the ghost-page repair, by message or recorded reason', () => {
    const byMessage = classifyTerminal({ ...base, error_code: 'source_changed', error_message: 'The canonical file was removed outside coordinated publication.' })!;
    const byReason = classifyTerminal({ ...base, error_code: 'source_changed', compacted: true, error_detail: { reason: 'canonical_file_missing' } })!;
    for (const verdict of [byMessage, byReason]) {
      expect(verdict).toMatchObject({ category: 'canonical_file_missing', code: 'source_changed', class: 'page', safe_actions: ['repair'], needs_human: true, defect: false });
      expect(verdict.action.argv).toEqual(['gbrain', 'repair', 'ghost-pages', '--source', 'src']);
      expect(verdict.action.verify?.argv).toEqual(['gbrain', 'sources', 'writer', 'failures', 'src', '--json']);
      expect(verdict.action.docs).toBe('docs/guides/write-refusals.md#canonical_file_missing');
    }
  });

  test('a fence_unrenderable refusal from a build before the adoption fix is historical; a newer one is an unresolved defect', () => {
    const refusal = { ...base, state: 'failed', error_code: 'fence_unrenderable', error_message: 'The adopted fence row does not render its legacy fact.' };
    expect(TERMINAL_FIXED_IN).toMatchObject({ fence_unrenderable: '0.60.218.0' });
    expect(classifyTerminal({ ...refusal, build: '0.60.217.0' })).toMatchObject({ category: 'fence_unrenderable', historical: true, defect: true, fixed_in: '0.60.218.0' });
    expect(classifyTerminal({ ...refusal, build: '0.60.218.0' })).toMatchObject({ category: 'fence_unrenderable', historical: false, defect: true });
    expect(classifyTerminal({ ...refusal, build: '0.60.217.0' })!.action.argv).toEqual(['gbrain', 'doctor', '--only', 'fence_integrity', '--json']);
  });
});
