/**
 * #6712 PR 2 (L5): `public_category` is a closed public vocabulary beside the unchanged `category`. The mapping is total:
 * every terminal category, every fault-table code and every registry code maps into it, and the receipt, the hold, the
 * last error and doctor's failures all read it from the one classifier (`classifyTerminal`).
 */
import { describe, expect, test } from 'bun:test';
import { CODES } from '../src/core/error-registry.ts';
import { PUBLIC_BY_CODE, PUBLIC_BY_TERMINAL, PUBLIC_CATEGORIES, publicCategory } from '../src/core/persistence/public-category.ts';
import { SYNC_FAULT_TABLE } from '../src/core/persistence/sync-fault-class.ts';
import { classifyRecordedFault, classifyTerminal } from '../src/core/persistence/terminal-classify.ts';

const allowed = new Set<string>(PUBLIC_CATEGORIES);

describe('public_category', () => {
  test('the vocabulary is the ten named categories', () => {
    expect([...PUBLIC_CATEGORIES]).toEqual(['drift', 'conflict', 'content_refused', 'file_missing', 'permission', 'storage', 'config', 'superseded', 'transient', 'defect']);
  });

  test('every fault-table code has its own row (no fault code falls through to the registry class)', () => {
    const missing = SYNC_FAULT_TABLE.map(rule => rule.code).filter(code => !(code in PUBLIC_BY_CODE));
    expect(missing).toEqual([]);
    for (const value of Object.values(PUBLIC_BY_CODE)) expect(allowed.has(value)).toBe(true);
    for (const value of Object.values(PUBLIC_BY_TERMINAL)) expect(allowed.has(value)).toBe(true);
  });

  test('every registry code, and a code this build does not know, maps into the vocabulary', () => {
    for (const code of [...Object.keys(CODES), 'a_code_from_the_future']) expect(allowed.has(publicCategory({ code }))).toBe(true);
    expect(publicCategory({ code: 'a_code_from_the_future' })).toBe('defect');
    expect(publicCategory({ code: 'knock_on_exhausted' })).toBe('superseded');
  });

  test('a specific terminal category decides; sync faults go by code', () => {
    expect(publicCategory({ category: 'canonical_file_missing', code: 'source_changed' })).toBe('file_missing');
    expect(publicCategory({ category: 'sync_fault', code: 'worktree_dirty' })).toBe('drift');
    expect(publicCategory({ category: 'caller_refusal', code: 'permission_denied' })).toBe('permission');
  });

  test('classifyTerminal carries public_category beside the unchanged category, on receipts and on recorded faults', () => {
    const receipt = classifyTerminal({ source_id: 's', slug: 'notes/a', operation: 'submit_job', state: 'failed', error_code: 'source_changed', error_detail: { reason: 'canonical_file_missing' },
      recovery: null, blocked_reason: null, compacted: false })!;
    expect(receipt).toMatchObject({ category: 'canonical_file_missing', public_category: 'file_missing' });
    expect(classifyRecordedFault({ source_id: 's', code: 'file_drift' })).toMatchObject({ category: 'sync_fault', public_category: 'drift' });
    expect(classifyRecordedFault({ source_id: 's', code: 'connection_lost' }).public_category).toBe('transient');
    expect(classifyRecordedFault({ source_id: 's', code: 'concurrent_write' }).public_category).toBe('conflict');
  });
});
