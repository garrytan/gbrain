/**
 * The Rust engine's writer gate decides by the member's name whether a call waits for an open transaction: a read
 * never waits, a write does (src/core/rust-engine/member-access.ts). Every served member must be listed in exactly one
 * of the two sets, or be a transaction member that admits itself. A served member listed in neither set would count as
 * a write and wait silently behind any open transaction; this test makes that a CI failure.
 */
import { describe, expect, test } from 'bun:test';
import { READ_MEMBERS, SELF_ADMITTED_MEMBERS, WRITE_MEMBERS, isReadMember } from '../src/core/rust-engine/member-access.ts';
import { RUST_ENGINE_MEMBERS } from '../src/core/rust-engine/members.ts';
import { STORE_MEMBERS } from '../src/core/rust-engine/store-members/index.ts';

const served = Object.keys(RUST_ENGINE_MEMBERS).filter((member) => member in STORE_MEMBERS);

describe('Rust engine member access', () => {
  test('every served member is a read, a write or a transaction member, and exactly one of them', () => {
    expect(served.length).toBeGreaterThan(0);
    const unlisted: string[] = [];
    const twice: string[] = [];
    for (const member of served) {
      const sets = [READ_MEMBERS.has(member), WRITE_MEMBERS.has(member), SELF_ADMITTED_MEMBERS.has(member)].filter(Boolean).length;
      if (sets === 0) unlisted.push(member);
      if (sets > 1) twice.push(member);
    }
    expect({ unlisted, twice }).toEqual({ unlisted: [], twice: [] });
  });

  test('every listed member is a served member of the engine', () => {
    const stale = [...READ_MEMBERS, ...WRITE_MEMBERS, ...SELF_ADMITTED_MEMBERS].filter((member) => !served.includes(member));
    expect(stale).toEqual([]);
  });

  test('every served member is in the engine member table', () => {
    expect(Object.keys(STORE_MEMBERS).filter((member) => !(member in RUST_ENGINE_MEMBERS))).toEqual([]);
  });

  test('a member in neither set counts as a write', () => {
    expect(isReadMember('notAServedMember')).toBe(false);
    expect(isReadMember('getPage')).toBe(true);
    expect(isReadMember('putPage')).toBe(false);
    expect(isReadMember('resolveTake')).toBe(false);
  });
});
