/**
 * The keyless clean-refusal predicate for `gbrain embed`.
 *
 * The documented always-current chain for external agent schedulers is
 * `gbrain sync ... && gbrain embed --stale`; on a keyless brain that chain
 * must exit 0 (nothing to backfill is not a failure). Every OTHER spelling is
 * an explicit request for something impossible on a keyless brain and keeps
 * exiting 1 via EmbeddingDisabledError — the predicate's exclusions mirror
 * runEmbed's dispatch precedence, where a slugs flag wins over stale.
 */
import { describe, test, expect } from 'bun:test';
import { isKeylessStaleRefusal } from '../src/commands/embed.ts';

describe('isKeylessStaleRefusal', () => {
  test('the documented chain spelling refuses cleanly on a keyless brain', () => {
    expect(isKeylessStaleRefusal(['--stale'], true)).toBe(true);
  });

  test('never fires on a brain with embeddings enabled (or unknown)', () => {
    expect(isKeylessStaleRefusal(['--stale'], false)).toBe(false);
    expect(isKeylessStaleRefusal(['--stale'], undefined)).toBe(false);
  });

  test('a slugs list keeps exiting 1 — dispatch gives slugs precedence over stale', () => {
    // Review-army catch: the guard originally excluded only the all flag, so
    // an explicit `embed --slugs a b --stale` on a keyless brain exited 0
    // while doing nothing — contradicting the guard's own contract.
    expect(isKeylessStaleRefusal(['--slugs', 'a', 'b', '--stale'], true)).toBe(false);
  });

  test('the all flag and dry-run are excluded — explicit asks stay loud', () => {
    expect(isKeylessStaleRefusal(['--all', '--stale'], true)).toBe(false);
    expect(isKeylessStaleRefusal(['--stale', '--dry-run'], true)).toBe(false);
  });

  test('a bare stale run with routing flags still qualifies', () => {
    // Scoping flags do not change WHAT is being asked, only where.
    expect(isKeylessStaleRefusal(['--stale', '--source', 'wiki'], true)).toBe(true);
  });

  test('no stale flag, no refusal — an explicit slug is not a stale run', () => {
    expect(isKeylessStaleRefusal(['my-page'], true)).toBe(false);
    expect(isKeylessStaleRefusal([], true)).toBe(false);
  });
});
