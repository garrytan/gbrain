/**
 * Multi-user lane L4, audit row B3 (docs/designs/rust-engine/multi-user-server.md, "M2: per-user access"): which
 * caller access record a call on a served brain runs under (src/core/rust-engine/owner-ipc/frame-access.ts).
 *
 * 1. Protects: a server never runs a call under an access record a client built for a principal other than the brain
 *    owner. The owner's floor is trusted local, so the frame's record stays a narrowing claim, as today. Any other
 *    principal runs under the record the store built for it (`tokenCallerRecord`), and a frame that claims a different
 *    record is refused before anything runs.
 * 2. Fails when: a non-owner principal's frame record is used, a different claimed record is accepted, a non-owner
 *    principal without a store-built record runs at all, or the owner's narrowing claim stops working.
 * 3. Seams: none; the function is pure. The served session's two call sites wire it in (lane L3, part 3 of B3).
 */
import { describe, expect, test } from 'bun:test';
import { frameAccessFor, type FramePrincipal } from '../src/core/rust-engine/owner-ipc/frame-access.ts';
import type { CallerAccess } from '../src/core/search/private-visibility.ts';

const OWNER: FramePrincipal = { kind: 'owner_token', floorRemote: false };
const LOCAL: FramePrincipal = { kind: 'local_owner', floorRemote: false };
const ALICE_RECORD = { identity: ['member:alice-example'], hidePrivate: true } as Partial<CallerAccess> as CallerAccess;
const ALICE: FramePrincipal = { kind: 'member_token', floorRemote: true, record: ALICE_RECORD };
const NARROW = { identity: ['member:bob-example'], hidePrivate: true } as Partial<CallerAccess> as CallerAccess;

const refusal = (fn: () => unknown) => {
  try { fn(); return null; } catch (e) { const err = e as { code?: string; reason?: string; detail?: string }; return { code: err.code, reason: err.reason, detail: err.detail }; }
};

describe('the access record a served call runs under (B3)', () => {
  test('the owner floor keeps the frame\'s narrowing claim, and no claim means the owner\'s trusted view', () => {
    for (const p of [OWNER, LOCAL]) {
      expect(frameAccessFor(p, NARROW, 'getPage')).toBe(NARROW);
      expect(frameAccessFor(p, null, 'getPage')).toBeNull();
    }
  });

  test('another principal runs under the record the store built for it, whatever the frame claims', () => {
    expect(frameAccessFor(ALICE, null, 'getPage')).toBe(ALICE_RECORD);
    // The same record in another key order is the same claim.
    expect(frameAccessFor(ALICE, { hidePrivate: true, identity: ['member:alice-example'] } as never, 'getPage')).toBe(ALICE_RECORD);
  });

  test('a frame that claims a different record for another principal is refused before anything runs', () => {
    expect(refusal(() => frameAccessFor(ALICE, NARROW, 'getPage'))).toEqual({
      code: 'permission_denied', reason: 'access_mismatch', detail: 'member=getPage via=served reason=access_mismatch ran=false written=nothing',
    });
    // A wider claim (no hidePrivate) is refused the same way.
    expect(refusal(() => frameAccessFor(ALICE, { identity: ['member:alice-example'] } as never, 'getPage'))?.reason).toBe('access_mismatch');
  });

  test('another principal without a store-built record runs nothing (fail closed)', () => {
    for (const p of [{ kind: 'member_token', floorRemote: true }, { kind: 'owner_token', floorRemote: true }] as FramePrincipal[]) {
      expect(refusal(() => frameAccessFor(p, null, 'getPage'))?.reason).toBe('access_record_missing');
      expect(refusal(() => frameAccessFor(p, NARROW, 'getPage'))?.reason).toBe('access_record_missing');
    }
  });

  test('an owner principal that carries a store-built record is held to it like any other', () => {
    const owned: FramePrincipal = { kind: 'owner_token', floorRemote: false, record: ALICE_RECORD };
    expect(frameAccessFor(owned, null, 'getPage')).toBe(ALICE_RECORD);
    expect(refusal(() => frameAccessFor(owned, NARROW, 'getPage'))?.reason).toBe('access_mismatch');
  });
});
