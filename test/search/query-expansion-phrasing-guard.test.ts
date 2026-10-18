/**
 * Guard: `query` expands only when the search mode says so (GBRA-81 item 1b),
 * so no source file or doc may claim it expands "in every mode" or "always".
 * Since the expansion-latency eval (GBRA-94) no mode expands by default, so no
 * file may say `tokenmax` expands by default either.
 * Scans src/, docs/, skills/ and the root agent docs; CHANGELOG history and the
 * dated BEHAVIOR_CHANGES rows are exempt from the tokenmax check.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const ROOT_DOCS = ['INSTALL_FOR_AGENTS.md', 'CLAUDE.md', 'AGENTS.md', 'README.md'];

/** An expansion word and "in every mode" in one clause, or "always expands". */
const CLAIM = /\b(?:expands?|expansion|expanding)\b[^.;\n]{0,40}\bin every mode\b|\bin every mode\b[^.;\n]{0,20}\bexpan(?:ds?|sion)\b|\balways (?:expands?|requests expansion)\b/i;

/** A claim that `tokenmax` turns expansion on by default. */
/** Troubleshooting advice that sends agents to bare `query` for expansion. */
const BARE_QUERY_EXPANSION_ADVICE = /`query` \(multi-query expansion\)|`gbrain query "[^"]*"` wastes an LLM expansion call|search runs without query expansion, so/i;

const TOKENMAX_CLAIM = /\bexpan\w*\b[^.\n]{0,80}\bon (?:in|for|only in) `?tokenmax`?|`?tokenmax`?[^.\n]{0,30}\bexpansion ?[=:]? ?on\b|`?tokenmax`?[^.\n]{0,80}\bexpands by default\b/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|md)$/.test(name) ? [path] : [];
  });
}

describe('query expansion phrasing guard', () => {
  test('the pattern catches the retired claims and spares unrelated "every mode" text', () => {
    for (const old of [
      '`query` expands in every mode unless explicitly disabled',
      'gbrain query requests expansion in every mode unless you pass --no-expand.',
      '(the only verb that can expand) expands by default in every mode',
      'the `query` op always expands',
    ]) expect(old).toMatch(CLAIM);
    for (const fine of ['autocut is off in every mode since rule R2', 'floor 1 in every mode', '`query` expands only when the mode says so']) {
      expect(fine).not.toMatch(CLAIM);
    }
  });

  test('the tokenmax pattern catches the retired claims and spares the current wording', () => {
    for (const old of [
      'Expansion follows the mode for `gbrain query` only: on in `tokenmax`, off in',
      'expand unset follows the mode: off in conservative and balanced, on in tokenmax',
      'tokenmax (expansion=on, limit=50) has a different hash',
      '3) tokenmax — no budget, 50 chunks, reranked, `gbrain query` expands by default.',
    ]) expect(old).toMatch(TOKENMAX_CLAIM);
    for (const old of [
      '| `target_not_retrieved` | No arm returned it for this query. | `query` (multi-query expansion) or rephrase. |',
      '`gbrain query "Alice Example"` wastes an LLM expansion call.',
      'Search runs without query expansion, so synonym- and outcome-phrased matches can be missed',
    ]) expect(old).toMatch(BARE_QUERY_EXPANSION_ADVICE);
    expect('`query --expand` (`expand: true`) or rephrase').not.toMatch(BARE_QUERY_EXPANSION_ADVICE);
    for (const fine of ['`gbrain query` does not expand by default in any mode', 'tokenmax (limit=50, no token budget)', 'reranker on for balanced and tokenmax']) {
      expect(fine).not.toMatch(TOKENMAX_CLAIM);
    }
  });

  test('no file in src/, docs/, skills/ or the root agent docs says tokenmax expands by default', () => {
    const offenders: string[] = [];
    const paths = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'docs')), ...files(join(ROOT, 'skills')), ...ROOT_DOCS.map(f => join(ROOT, f))];
    for (const path of paths) {
      if (relative(ROOT, path) === 'src/core/behavior-change-notice.ts') continue;
      readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
        if (TOKENMAX_CLAIM.test(line) || BARE_QUERY_EXPANSION_ADVICE.test(line)) offenders.push(`${relative(ROOT, path)}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('no file in src/, docs/ or the root agent docs says query expands in every mode', () => {
    const offenders: string[] = [];
    const paths = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'docs')), ...ROOT_DOCS.map(f => join(ROOT, f))];
    for (const path of paths) {
      readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
        if (CLAIM.test(line)) offenders.push(`${relative(ROOT, path)}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
