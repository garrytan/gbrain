#!/usr/bin/env bun
/**
 * Builds fixtures.jsonl from cases.ts; deterministic, no dates, no randomness.
 *
 * Each case becomes one fixture: the held file and the named page as path,
 * path-derived slug and content, the canonical slug for a true duplicate,
 * and the expected verdict set the scorer grades against (`best`,
 * `acceptable`, `hard`). The judgment input the model sees (frontmatter,
 * headings, first 60 body lines, lines mentioning the other page) is built
 * from the content at run time by `input.ts`, so a fixture carries the files
 * as they would sit in a checkout and nothing derived.
 *
 * Regenerate: bun evals/content-repair-judgment/generate-fixtures.ts
 * Output:     evals/content-repair-judgment/fixtures.jsonl (committed)
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { slugifyPath } from '../../src/core/sync.ts';
import { CASES, type Case, type CaseFile } from './cases.ts';

export const FIXTURES_PATH = join(import.meta.dir, 'fixtures.jsonl');

/** The three coded answers the model may give; `merge_into` carries a canonical slug in the verdict. */
export type Answer = 'merge_into' | 'remove_slug' | 'needs_human';

export interface FixtureFile { path: string; slug: string; content: string }

export interface Fixture {
  id: string;
  set: Case['set'];
  cls: Case['cls'];
  tags: string[];
  note: string;
  held: FixtureFile;
  named: FixtureFile | null;
  /** True duplicates: the slug that keeps the page. */
  canonical: string | null;
  /**
   * `best`: the answers a correct model gives. `acceptable`: safe answers that cost a repair but not correctness
   * (`needs_human` always; for an adversarial pair `remove_slug` is best and `needs_human` acceptable). `hard`: answers that
   * would damage the brain (a `merge_into` of two different things or into the wrong canonical; a `remove_slug` that mints a
   * second page for one thing). An ambiguous pair has no hard answer: a guess is reported, not counted.
   */
  expected: { best: Answer[]; acceptable: Answer[]; hard: Answer[] };
}

export function expectedFor(set: Case['set']): Fixture['expected'] {
  switch (set) {
    case 'true_duplicate': return { best: ['merge_into'], acceptable: ['needs_human'], hard: ['remove_slug'] };
    case 'stray_slug': return { best: ['remove_slug'], acceptable: ['needs_human'], hard: ['merge_into'] };
    case 'adversarial': return { best: ['remove_slug'], acceptable: ['needs_human'], hard: ['merge_into'] };
    case 'ambiguous': return { best: ['needs_human'], acceptable: [], hard: [] };
  }
}

const fileOf = (f: CaseFile): FixtureFile => ({ path: f.path, slug: slugifyPath(f.path), content: f.lines.join('\n') + '\n' });

export function buildFixtures(cases: readonly Case[] = CASES): Fixture[] {
  return cases.map(c => ({ id: c.id, set: c.set, cls: c.cls, tags: c.tags, note: c.note, held: fileOf(c.held), named: c.named ? fileOf(c.named) : null, canonical: c.canonical, expected: expectedFor(c.set) }));
}

export function fixturesJsonl(cases: readonly Case[] = CASES): string {
  return buildFixtures(cases).map(f => JSON.stringify(f)).join('\n') + '\n';
}

if (import.meta.main) {
  writeFileSync(FIXTURES_PATH, fixturesJsonl(CASES));
  console.log(`wrote ${CASES.length} fixtures to ${FIXTURES_PATH}`);
}
