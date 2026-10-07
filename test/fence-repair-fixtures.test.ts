/**
 * Fence repair over every facts/takes fence fixture in the test suite
 * (#6188, E21 + E30): the raw extractor accepts exactly the rows the strict
 * parsers return; Invariant 0 (a page that compiles comes back as the same
 * object); and a seeded mutation fuzz over those fixtures for idempotence,
 * claim preservation, the validator gates and location-only output.
 *
 * Fixtures are harvested by statically evaluating string expressions (string
 * and template literals, `+`, `[...].join(sep)`, the marker constants) in
 * test/**\/*.ts, so new fence fixtures join this sweep automatically.
 */
import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END, parseTakesFence } from '../src/core/takes-fence.ts';
import { stripStrikethrough } from '../src/core/fence-shared.ts';
import { extractRawRows, primaryFence } from '../src/core/fence-repair/raw-rows.ts';
import { normalizeFences } from '../src/core/fence-repair/normalize.ts';
import { sectionsOf, strictPageClean } from '../src/core/fence-repair/page-checks.ts';
import { validateFenceRepair } from '../src/core/fence-repair/validate.ts';
import type { FenceCtx, FencePage } from '../src/core/fence-repair/types.ts';

const MARKERS: Record<string, string> = { FACTS_FENCE_BEGIN, FACTS_FENCE_END, TAKES_FENCE_BEGIN, TAKES_FENCE_END };
const FENCE_TEXT = /gbrain:(facts|takes):/;

function evaluate(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return MARKERS[node.text] ?? null;
  if (ts.isParenthesizedExpression(node)) return evaluate(node.expression);
  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.reduce((out, span) => out + (evaluate(span.expression) ?? 'x') + span.literal.text, node.head.text);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluate(node.left);
    const right = evaluate(node.right);
    return left !== null && right !== null ? left + right : null;
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'join'
    && ts.isArrayLiteralExpression(node.expression.expression)) {
    const sep = node.arguments[0] ? evaluate(node.arguments[0]) : ',';
    const parts = node.expression.expression.elements.map(evaluate);
    return sep !== null && parts.every(p => p !== null) ? parts.join(sep) : null;
  }
  return null;
}

function harvestFixtures(dir: string): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node) => {
    const value = evaluate(node);
    if (value !== null && FENCE_TEXT.test(value)) found.add(value);
    else ts.forEachChild(node, visit);
  };
  const walk = (path: string) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      if (statSync(child).isDirectory()) walk(child);
      else if (child.endsWith('.ts')) {
        const text = readFileSync(child, 'utf8');
        if (FENCE_TEXT.test(text) || text.includes('_FENCE_BEGIN')) visit(ts.createSourceFile(child, text, ts.ScriptTarget.Latest, true));
      }
    }
  };
  walk(dir);
  return [...found];
}

const FIXTURES = harvestFixtures(import.meta.dir);
const PRIVATE: FenceCtx = { pageVisibility: 'private' };

/** Claims per section and kind, in row order, from the raw extraction. */
function rawClaims(page: FencePage): string[] {
  return sectionsOf(page).flatMap(([section, text]) => {
    const raw = extractRawRows(text, section);
    return (['facts', 'takes'] as const).map(kind => `${section}:${kind}:` + (primaryFence(raw, kind)?.rows ?? [])
      .map(r => r.byColumn.get('claim')?.text.replace(/\s+/g, ' ').trim() ?? '').join('\u0001'));
  });
}

describe('fence fixtures in the test suite', () => {
  test('the sweep finds a meaningful corpus', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(120);
    expect(FIXTURES.filter(f => strictPageClean({ compiled_truth: f, timeline: '' })).length).toBeGreaterThanOrEqual(80);
  });

  test('raw-row differential (E21): accepted rows equal the strict parsers\' rows', () => {
    let compared = 0;
    for (const fixture of FIXTURES) {
      const raw = extractRawRows(fixture);
      const parsed = {
        facts: parseFactsFence(fixture).facts.map(f => [f.rowNum, f.claim]),
        takes: parseTakesFence(fixture).takes.map(t => [t.rowNum, t.claim]),
      };
      for (const kind of ['facts', 'takes'] as const) {
        const accepted = (primaryFence(raw, kind)?.rows ?? []).filter(r => r.accepted)
          .map(r => [parseInt(r.cells[0]!.text, 10), stripStrikethrough(r.cells[1]!.text).text]);
        expect(accepted).toEqual(parsed[kind]);
        compared += accepted.length;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(80);
  });

  test('Invariant 0: every fixture page that compiles is returned unchanged; the rest normalize idempotently', () => {
    for (const fixture of FIXTURES) {
      for (const before of [{ compiled_truth: fixture, timeline: '' }, { compiled_truth: '', timeline: fixture }]) {
        const r = normalizeFences(before, PRIVATE);
        if (strictPageClean(before)) {
          expect(r.page).toBe(before);
          continue;
        }
        expect(normalizeFences(r.page, PRIVATE).fixes).toEqual([]);
        expect(rawClaims(r.page)).toEqual(rawClaims(before));
        if (r.residual.length) continue;
        expect(strictPageClean(r.page)).toBe(true);
        expect(validateFenceRepair(before, r.page, { ...PRIVATE, tier: 'deterministic', issues: [...r.fixes, ...r.residual] })).toEqual({ ok: true });
      }
    }
  });
});

/** Deterministic PRNG (mulberry32) so a failing case reproduces. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['partnership', 'Critical', 'very_high', 'public', 'internal', 'shared', '85%', '0', '-2', 'System', 'Alice Example',
  'assessment', 'strategic position', 'wibble', '', 'x', '1.5', 'opinion', 'team', 'minor'];

type Mutation = (lines: string[], rand: () => number) => string[];
const pick = <T>(items: readonly T[], rand: () => number): T => items[Math.floor(rand() * items.length)]!;
const rowLines = (lines: string[]) => lines.map((l, i) => [l, i] as const).filter(([l]) => /^\s*\|/.test(l) && !/^\s*\|[-:\s|]+\|?\s*$/.test(l)).map(([, i]) => i);

const MUTATIONS: Mutation[] = [
  (lines, rand) => { // rewrite one cell
    const rows = rowLines(lines);
    if (!rows.length) return lines;
    const i = pick(rows, rand);
    const cells = lines[i]!.split('|');
    if (cells.length > 3) cells[1 + Math.floor(rand() * (cells.length - 2))] = ` ${pick(WORDS, rand)} `;
    return lines.map((l, k) => (k === i ? cells.join('|') : l));
  },
  (lines, rand) => { // duplicate a row
    const rows = rowLines(lines);
    if (!rows.length) return lines;
    const i = pick(rows, rand);
    return [...lines.slice(0, i + 1), lines[i]!.replace(/(\|\s*)[^|]*/, '$1 copy of a row '), ...lines.slice(i + 1)];
  },
  (lines, rand) => lines.filter(l => !(l.includes('gbrain:facts:end') || l.includes('gbrain:takes:end')) || rand() < 0.3), // drop end markers
  lines => lines.map(l => l.replace('<!--- gbrain:takes:', '<!-- gbrain:takes:')), // two-dash takes markers
  (lines, rand) => { // delete a middle cell
    const rows = rowLines(lines);
    if (!rows.length) return lines;
    const i = pick(rows, rand);
    const cells = lines[i]!.split('|');
    if (cells.length > 5) cells.splice(2 + Math.floor(rand() * (cells.length - 4)), 1);
    return lines.map((l, k) => (k === i ? cells.join('|') : l));
  },
  (lines, rand) => [...lines, '', pick(['Trailing prose line.', '| stray | row |', ''], rand)], // trailing content
];

describe('mutation fuzz over the fixtures', () => {
  test('never throws; idempotent; claims kept; clean outputs pass every gate; output is location-only', () => {
    const rand = prng(6188);
    let repaired = 0;
    let held = 0;
    const clean = FIXTURES.filter(f => strictPageClean({ compiled_truth: f, timeline: '' }));
    for (const fixture of clean) {
      for (let round = 0; round < 10; round++) {
        let lines = fixture.split('\n');
        for (let k = 0; k < 1 + Math.floor(rand() * 3); k++) lines = pick(MUTATIONS, rand)(lines, rand);
        const text = rand() < 0.15 ? lines.join('\r\n') : lines.join('\n');
        const before: FencePage = rand() < 0.3 ? { compiled_truth: 'Intro.\n', timeline: text } : { compiled_truth: text, timeline: '' };
        const ctx: FenceCtx = { pageVisibility: rand() < 0.5 ? 'private' : 'world' };
        const r = normalizeFences(before, ctx);
        if (strictPageClean(before)) expect(validateFenceRepair(before, before, { ...ctx, tier: 'llm', issues: [] })).toEqual({ ok: true });
        expect(normalizeFences(r.page, ctx).fixes).toEqual([]);
        expect(rawClaims(r.page)).toEqual(rawClaims(before));
        const surface = JSON.stringify([r.fixes, r.residual]);
        for (const claim of rawClaims(before).join('\u0001').split('\u0001')) {
          if (claim.length >= 12 && claim.includes(' ')) expect(surface).not.toContain(claim);
        }
        if (r.residual.length) { held++; continue; }
        expect(strictPageClean(r.page)).toBe(true);
        expect(validateFenceRepair(before, r.page, { ...ctx, tier: 'deterministic', issues: [...r.fixes, ...r.residual] })).toEqual({ ok: true });
        if (r.fixes.length) repaired++;
      }
    }
    expect(repaired).toBeGreaterThanOrEqual(50);
    expect(held).toBeGreaterThanOrEqual(50);
  });
});
