/**
 * GBRA-287: how the two stored-page-body fault codes are classified.
 *
 * 1. Protects: a managed-sync freeze hold naming `page_body_segmented` reads upgrade / a person, and one naming
 *    `page_body_rows_unreadable` reads repair / a person (GST-1209 follow-up: no retry clears it; the `freeze_<code>` rows), while a write receipt carrying
 *    either bare code keeps the class it had before (a caller refusal, a gbrain defect): the hold rows never leak into
 *    receipt diagnosis (`gbrain write-request`, writer failures, doctor).
 * 2. Fails when: the hold rows are keyed by the bare codes (receipts turn into sync faults), or holdVerdict stops
 *    reading `meta.write_failure.code` (the holds read as an unplaced page_write_failed).
 * 3. Pure.
 */
import { describe, expect, test } from 'bun:test';
import { classifyTerminal } from '../src/core/persistence/terminal-classify.ts';
import { holdVerdict } from '../src/core/persistence/sync-status.ts';

const receipt = (error_code: string) => classifyTerminal({ request_id: 'r', source_id: 'default', slug: 'notes/a', operation: 'put_page', state: 'failed',
  error_code, error_message: 'x', recovery: false } as never);
const freezeHold = (code: string) => ({ source_id: 'default', path: 'notes/a.md', slug: 'notes/a', code: 'page_write_failed', held_at: new Date().toISOString(),
  meta: { attempts: 1, write_failure: { code, origin: 'freeze', error_class: code, errno: null, request_id: null, attempts: 1, gbrain_version: 'x' } } }) as never;

describe('GBRA-287: page-body fault classes', () => {
  test('a write receipt with a bare page-body code keeps its class', () => {
    expect(receipt('page_body_segmented')).toMatchObject({ category: 'caller_refusal', needs_human: false, public_category: 'content_refused' });
    expect(receipt('page_body_rows_unreadable')).toMatchObject({ category: 'gbrain_defect', needs_human: true });
  });

  test('a freeze hold is classified by the page-body code it names', () => {
    expect(holdVerdict(freezeHold('page_body_segmented'), undefined)).toMatchObject({ safe_actions: ['upgrade'], needs_human: true });
    expect(holdVerdict(freezeHold('page_body_rows_unreadable'), undefined)).toMatchObject({ safe_actions: ['repair'], needs_human: true });
    expect(holdVerdict(freezeHold('storage_error'), undefined).human_reason).toContain('gbrain write-request');
  });
});
