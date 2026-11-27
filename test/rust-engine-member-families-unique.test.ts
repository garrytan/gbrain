/**
 * src/core/rust-engine/members.ts composes the member-to-capability map from family files under
 * src/core/rust-engine/members/ with object spreads. The `satisfies Record<keyof BrainEngine, MemberClass>` check
 * catches a missing member but not a member listed in two family files: the later spread silently wins, so a member
 * could be classified twice with two different capabilities and only one of them would apply.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: every BrainEngine member is classified in exactly one family file.
 * 2. Fails when: a member key appears in two family maps.
 * 3. Existing coverage: the typed exhaustiveness check covers missing members only.
 * 4. Seams: none; the family maps are imported as they are.
 */
import { describe, expect, test } from 'bun:test';
import { FOUNDATION_MEMBERS } from '../src/core/rust-engine/members/foundation.ts';
import { PAGES_MEMBERS } from '../src/core/rust-engine/members/pages.ts';
import { CONTENT_MEMBERS } from '../src/core/rust-engine/members/content.ts';
import { FACTS_MEMBERS } from '../src/core/rust-engine/members/facts.ts';
import { DOCTOR_MEMBERS } from '../src/core/rust-engine/members/doctor.ts';
import { RECORDS_MEMBERS } from '../src/core/rust-engine/members/records.ts';
import { CYCLE_MEMBERS } from '../src/core/rust-engine/members/cycle.ts';
import { PERSISTENCE_MEMBERS } from '../src/core/rust-engine/members/persistence.ts';
import { ACCESS_MEMBERS } from '../src/core/rust-engine/members/access.ts';
import { JOBS_MEMBERS } from '../src/core/rust-engine/members/jobs.ts';
import { LEDGER_MEMBERS } from '../src/core/rust-engine/members/ledgers.ts';
import { RUST_ENGINE_MEMBERS } from '../src/core/rust-engine/members.ts';

const FAMILIES: Record<string, Record<string, unknown>> = {
  foundation: FOUNDATION_MEMBERS, pages: PAGES_MEMBERS, content: CONTENT_MEMBERS, facts: FACTS_MEMBERS, doctor: DOCTOR_MEMBERS,
  records: RECORDS_MEMBERS, cycle: CYCLE_MEMBERS, persistence: PERSISTENCE_MEMBERS, access: ACCESS_MEMBERS, jobs: JOBS_MEMBERS,
  ledgers: LEDGER_MEMBERS,
};

describe('Rust engine member families', () => {
  test('each member is classified in exactly one family file, and the composed map holds them all', () => {
    const seen = new Map<string, string[]>();
    for (const [family, map] of Object.entries(FAMILIES)) {
      for (const member of Object.keys(map)) seen.set(member, [...(seen.get(member) ?? []), family]);
    }
    expect([...seen].filter(([, families]) => families.length > 1)).toEqual([]);
    expect(Object.keys(RUST_ENGINE_MEMBERS).sort()).toEqual([...seen.keys()].sort());
  });
});
