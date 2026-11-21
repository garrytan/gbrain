/**
 * A call sent to the Rust brain's owner whose answer never came back (cancel, deadline, owner gone) may still commit,
 * so its error names the read that confirms the write instead of advising a rerun (owner-ipc/confirming-reads.ts and
 * routes.ts confirmingReadAdvice). These tests pin that every forwarded write has such a read, that each read named
 * is a member that only reads, and the three errors' answers before and after the send.
 */
import { describe, expect, test } from 'bun:test';
import { RUST_ENGINE_MEMBERS } from '../src/core/rust-engine/members.ts';
import { OWNER_IPC_CONFIRMING_READS } from '../src/core/rust-engine/owner-ipc/confirming-reads.ts';
import {
  OWNER_IPC_ROUTES, confirmingReadAdvice, ownerCallCancelled, ownerCallTimeout, ownerGone, ownerMemberOnlyReads,
} from '../src/core/rust-engine/owner-ipc/routes.ts';

const forwarded = Object.entries(OWNER_IPC_ROUTES).filter(([, route]) => route === 'forward').map(([member]) => member);
const writes = forwarded.filter(member => !ownerMemberOnlyReads(member));

describe('the confirming read for each forwarded write', () => {
  // Value: protects=a new write routed over the owner socket gets a named confirming read; fails_when=a forwarded
  // write has no entry, or a read or unknown member has one; why_new=the table is new; seam=none; no_claim=the read
  // finds every row the write changed
  test('every forwarded write has an entry, and no read or unknown member has one', () => {
    expect(writes.filter(member => !(member in OWNER_IPC_CONFIRMING_READS))).toEqual([]);
    expect(Object.keys(OWNER_IPC_CONFIRMING_READS).filter(member => !writes.includes(member))).toEqual([]);
  });

  test('each member an entry names exists and only reads', () => {
    const named = Object.values(OWNER_IPC_CONFIRMING_READS).flatMap(read => read.match(/\b[a-z]+[A-Z]\w*\b/g) ?? []);
    expect(named.length).toBeGreaterThan(50);
    expect(named.filter(member => !(member in RUST_ENGINE_MEMBERS) || !ownerMemberOnlyReads(member))).toEqual([]);
  });

  test('insertFact names the facts read for that entity; a read says a rerun is safe', () => {
    expect(confirmingReadAdvice('insertFact')).toBe(
      'Before you rerun insertFact, run listFactsByEntity for that entity to see whether it committed; rerun it only if it did not.');
    expect(confirmingReadAdvice('getPage')).toBe('Before you rerun getPage: it only reads, so nothing was written and running it again is safe.');
    expect(confirmingReadAdvice('lockPageKeys')).toContain('there is nothing: the lock is released');
  });
});

describe('a sent call whose answer never came back', () => {
  // Value: protects=a sent write's timeout or owner exit is not reported as safe to retry; fails_when=the sent timeout
  // keeps code timeout or retryable true, or owner-gone keeps retryable true for a write; why_new=finding 4 covered only
  // the cancel; seam=none; no_claim=how long the owner takes to finish the call
  test('cancel, deadline and owner exit after the send: unknown, retryable only for a read, with the confirming read', () => {
    for (const error of [ownerCallCancelled('insertFact', true), ownerCallTimeout('insertFact', 300, 'sent'), ownerGone('insertFact', 42, true)]) {
      expect(error).toMatchObject({ code: 'owner_unavailable', reason: 'outcome_unknown', retryable: false });
      expect(error.suggestion).toContain('run listFactsByEntity for that entity to see whether it committed');
      expect(error.suggestion).not.toContain('Retry the same call');
    }
    for (const error of [ownerCallCancelled('getPage', true), ownerCallTimeout('getPage', 300, 'sent'), ownerGone('getPage', 42, true)]) {
      expect(error).toMatchObject({ code: 'owner_unavailable', reason: 'outcome_unknown', retryable: true });
    }
  });

  test('before the send nothing ran, so the answers stay as they were', () => {
    expect(ownerCallCancelled('insertFact', false)).toMatchObject({ code: 'cancelled' });
    expect(ownerCallTimeout('insertFact', 300, 'not_sent')).toMatchObject({ code: 'timeout', reason: 'not_sent', retryable: true });
    expect(ownerCallTimeout('insertFact', 300, 'queued')).toMatchObject({ code: 'timeout', reason: 'not_started', retryable: true });
    expect(ownerGone('insertFact', 42, false)).toMatchObject({ code: 'owner_unavailable', reason: 'not_sent', retryable: true });
  });
});
