#!/usr/bin/env bun
/**
 * #5575 (ENG-16) regex-safety lint for the write gate detector.
 *
 * Every pattern in `WRITE_GATE_PATTERNS` (src/core/write-gate-patterns.ts)
 * must be safe to run on attacker-controlled text of any size:
 *   - no unbounded quantifier (`*`, `+`, `{n,}`) and no bound above 200,
 *   - no repeated group that itself contains a repeat (nested quantifiers),
 *   - no backreference,
 *   - a longest possible match of at most MAX_MATCH_CHARS, and a `preceded`
 *     context of at most MAX_PRECEDING_CHARS (together the window overlap,
 *     so a match straddling two scan windows is still found),
 *   - non-global and non-sticky (`.test()` keeps no state), with at least one
 *     lowercase prefilter anchor.
 *
 * Usage: bun scripts/check-write-gate-regex.ts   (exit 0 clean, 1 on violations)
 * Self-test seam: with GBRAIN_GUARD_ROOT set, the guard checks the patterns
 * listed in <root>/patterns.json ({ name, source, flags, anchors, preceded? }
 * objects) instead of the real table (scripts/guard-self-test.sh fixtures).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_MATCH_CHARS, MAX_PRECEDING_CHARS, WRITE_GATE_PATTERNS, type WriteGatePattern } from '../src/core/write-gate-patterns.ts';
import { analyzeRegexSource } from '../src/core/write-gate-regex.ts';

export function checkWriteGatePatterns(patterns: readonly WriteGatePattern[] = WRITE_GATE_PATTERNS): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const p of patterns) {
    if (names.has(p.name)) problems.push(`${p.name}: duplicate pattern name`);
    names.add(p.name);
    if (p.rx.global || p.rx.sticky) problems.push(`${p.name}: global or sticky flag (stateful .test())`);
    if (!p.anchors.length || p.anchors.some(a => !a || a !== a.toLowerCase())) problems.push(`${p.name}: needs non-empty lowercase prefilter anchors`);
    const { maxLength, errors } = analyzeRegexSource(p.rx.source);
    for (const e of errors) problems.push(`${p.name}: ${e}`);
    if (maxLength > MAX_MATCH_CHARS) problems.push(`${p.name}: longest match ${maxLength} chars exceeds MAX_MATCH_CHARS ${MAX_MATCH_CHARS}`);
    if (p.preceded) {
      if (p.preceded.global || p.preceded.sticky) problems.push(`${p.name}: preceded regex is global or sticky`);
      if (!p.preceded.source.endsWith('$')) problems.push(`${p.name}: preceded regex must end with $ (it checks the text right before the match)`);
      const ctx = analyzeRegexSource(p.preceded.source);
      for (const e of ctx.errors) problems.push(`${p.name} (preceded): ${e}`);
      if (ctx.maxLength > MAX_PRECEDING_CHARS) problems.push(`${p.name}: preceded context ${ctx.maxLength} chars exceeds MAX_PRECEDING_CHARS ${MAX_PRECEDING_CHARS}`);
    }
  }
  return problems;
}

function fixturePatterns(root: string): WriteGatePattern[] {
  const rows = JSON.parse(readFileSync(join(root, 'patterns.json'), 'utf8')) as Array<{ name: string; source: string; flags?: string; anchors: string[]; preceded?: string }>;
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- self-test fixture patterns this guard exists to vet; never runs on user text
  return rows.map(r => ({ name: r.name, family: 'override', rx: new RegExp(r.source, r.flags ?? 'i'), anchors: r.anchors, ...(r.preceded ? { preceded: new RegExp(r.preceded, 'i') } : {}) }));
}

if (import.meta.main) {
  const root = process.env.GBRAIN_GUARD_ROOT;
  const problems = checkWriteGatePatterns(root ? fixturePatterns(root) : WRITE_GATE_PATTERNS);
  if (problems.length) {
    console.error(`write-gate regex safety: ${problems.length} violation(s)`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`write-gate regex safety: ${WRITE_GATE_PATTERNS.length} patterns bounded (max match <= ${MAX_MATCH_CHARS} chars).`);
}
