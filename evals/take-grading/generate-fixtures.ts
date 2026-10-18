#!/usr/bin/env bun
/**
 * Deterministic builder: `cases.ts` → `fixtures.jsonl` (committed), dev split
 * first, then the counted split. Regenerate after editing a case; the keyless
 * test fails on drift.
 *
 *   bun evals/take-grading/generate-fixtures.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFixtures, type Fixture } from './cases.ts';

export type { Fixture } from './cases.ts';
export const FIXTURES_PATH = join(import.meta.dir, 'fixtures.jsonl');

export function allFixtures(): Fixture[] {
  const counted = buildFixtures('counted');
  return [...buildFixtures('dev', new Set(counted.map(f => f.take.claim))), ...counted];
}

export function fixturesJsonl(): string {
  return allFixtures().map(f => JSON.stringify(f)).join('\n') + '\n';
}

if (import.meta.main) {
  writeFileSync(FIXTURES_PATH, fixturesJsonl());
  console.log(`wrote ${allFixtures().length} fixtures to ${FIXTURES_PATH}`);
}
