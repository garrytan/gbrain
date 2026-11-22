/**
 * Every BrainEngine member, classified for the Rust engine (docs/designs/RUST_ENGINE.md, "Capability gating").
 *
 * `implemented` members run on the Rust engine. Every other member names the capability it belongs to; until the Rust
 * engine implements it, a call rejects with `engine_capability_missing` naming that capability, before any work, so
 * nothing is written. The `satisfies` clause makes a new BrainEngine member fail to compile until it is classified here.
 * The rows live in the family files under ./members/ (a new member goes in the file of its family); this file composes
 * them, so the exhaustiveness check below still covers every member.
 */
import type { Capability } from '../engine-capabilities.ts';
import type { BrainEngine } from '../engine.ts';
import { FOUNDATION_MEMBERS } from './members/foundation.ts';
import { PAGES_MEMBERS } from './members/pages.ts';
import { CONTENT_MEMBERS } from './members/content.ts';
import { FACTS_MEMBERS } from './members/facts.ts';
import { DOCTOR_MEMBERS } from './members/doctor.ts';
import { RECORDS_MEMBERS } from './members/records.ts';
import { CYCLE_MEMBERS } from './members/cycle.ts';
import { PERSISTENCE_MEMBERS } from './members/persistence.ts';
import { ACCESS_MEMBERS } from './members/access.ts';
import { JOBS_MEMBERS } from './members/jobs.ts';
import { LEDGER_MEMBERS } from './members/ledgers.ts';

export type MemberClass = 'implemented' | Capability;

export const RUST_ENGINE_MEMBERS = {
  ...FOUNDATION_MEMBERS,
  ...PAGES_MEMBERS,
  ...CONTENT_MEMBERS,
  ...FACTS_MEMBERS,
  ...DOCTOR_MEMBERS,
  ...RECORDS_MEMBERS,
  ...CYCLE_MEMBERS,
  ...PERSISTENCE_MEMBERS,
  ...ACCESS_MEMBERS,
  ...JOBS_MEMBERS,
  ...LEDGER_MEMBERS,
} as const satisfies Record<keyof BrainEngine, MemberClass>;

export type RustEngineMember = keyof typeof RUST_ENGINE_MEMBERS;

