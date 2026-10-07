#!/usr/bin/env bun
/**
 * Builds fixtures.jsonl from cases.ts (round 1) and heldout.jsonl from
 * heldout-cases.ts (round 2's held-out set); deterministic, no dates, no randomness.
 *
 * Each case becomes one page: a title, one prose line, then the section
 * body (fences included) in `compiled_truth`, or in `timeline` for a
 * timeline case. `expected` is the same page with the hand-written repaired
 * section; `probe` is the adversarial answer text.
 *
 * Regenerate: bun evals/fence-repair-tier3/generate-fixtures.ts
 * Output:     evals/fence-repair-tier3/fixtures.jsonl and heldout.jsonl (committed)
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';
import { CANONICAL_HEADER } from '../../src/core/fence-repair/schema.ts';
import { CASES, type Case } from './cases.ts';
import { HELDOUT_CASES } from './heldout-cases.ts';

export const FIXTURES_PATH = join(import.meta.dir, 'fixtures.jsonl');
export const HELDOUT_PATH = join(import.meta.dir, 'heldout.jsonl');

const TOKENS: Record<string, string> = {
  '{FB}': FACTS_FENCE_BEGIN, '{FE}': FACTS_FENCE_END, '{TB}': TAKES_FENCE_BEGIN, '{TE}': TAKES_FENCE_END,
  '{FH}': CANONICAL_HEADER.facts.narrow, '{FS}': CANONICAL_HEADER.facts.narrowSep,
  '{FW}': CANONICAL_HEADER.facts.wide, '{FWS}': CANONICAL_HEADER.facts.wideSep,
  '{TH}': CANONICAL_HEADER.takes.narrow, '{TS}': CANONICAL_HEADER.takes.narrowSep,
  '{TW}': CANONICAL_HEADER.takes.wide, '{TWS}': CANONICAL_HEADER.takes.wideSep,
};

export interface FencePageText { compiled_truth: string; timeline: string }

export interface Fixture {
  id: string;
  set: Case['set'];
  adversarial: Case['adversarial'] | null;
  cls: Case['cls'];
  kind: Case['kind'];
  section: 'body' | 'timeline';
  page_visibility: 'private' | 'world';
  tags: string[];
  note: string;
  page: FencePageText;
  /** The page after a correct repair; null when the only correct outcome is to stay held. */
  expected: FencePageText | null;
  /** Adversarial: an answer a model might give (see cases.ts). */
  probe: string | null;
}

const expand = (lines: readonly string[]) => lines.map(line => TOKENS[line] ?? line).join('\n');

function pageOf(c: Case, body: readonly string[]): FencePageText {
  const section = `${expand(body)}\n`;
  const title = `# Notes ${c.id}\n\nWorking notes kept by the brain owner.\n\n`;
  return c.section === 'timeline'
    ? { compiled_truth: `# Notes ${c.id}\n\nWorking notes kept by the brain owner.\n`, timeline: section }
    : { compiled_truth: `${title}${section}`, timeline: '' };
}

export function buildFixtures(cases: readonly Case[] = CASES): Fixture[] {
  return cases.map(c => ({
    id: c.id, set: c.set, adversarial: c.adversarial ?? null, cls: c.cls, kind: c.kind, section: c.section ?? 'body',
    page_visibility: c.vis ?? 'private', tags: c.tags, note: c.note,
    page: pageOf(c, c.body), expected: c.expected ? pageOf(c, c.expected) : null, probe: c.probe ? expand(c.probe) : null,
  }));
}

export function fixturesJsonl(cases: readonly Case[] = CASES): string {
  return buildFixtures(cases).map(f => JSON.stringify(f)).join('\n') + '\n';
}

if (import.meta.main) {
  writeFileSync(FIXTURES_PATH, fixturesJsonl(CASES));
  writeFileSync(HELDOUT_PATH, fixturesJsonl(HELDOUT_CASES));
  console.log(`wrote ${CASES.length} fixtures to ${FIXTURES_PATH} and ${HELDOUT_CASES.length} to ${HELDOUT_PATH}`);
}
