/**
 * Operator scripts run on macOS too (the interrupted-run check runs `ubi-runner.sh usage` on a Mac), where awk is the
 * one-true-awk (BWK). Its grammar rejects a comparison in an unparenthesized print or printf argument list: in
 * `printf "%s", o == me ? "y" : ""` the `==` is a syntax error, while gawk, mawk and busybox accept it. This lint
 * finds that construct in the awk programs of scripts/ubicloud, and `usage` runs under every awk on PATH, the
 * one-true-awk (`original-awk`) included where it is installed.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const DIR = join(ROOT, 'scripts/ubicloud');

/** Each print/printf whose unparenthesized argument list holds a comparison at paren depth 0, as `line: text`. */
function bwkPrintComparisons(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\bprintf?\b/g)) {
    let i = match.index! + match[0].length;
    while (source[i] === ' ' || source[i] === '\t') i++;
    if (source[i] === '(' || source[i] === "'") continue;
    let depth = 0;
    for (; i < source.length; i++) {
      const c = source[i]!;
      const two = source.slice(i, i + 2);
      if (c === '"') { for (i++; i < source.length && source[i] !== '"'; i++) if (source[i] === '\\') i++; continue; }
      if (c === '(') { depth++; continue; }
      if (c === ')') { if (depth === 0) break; depth--; continue; }
      if (depth > 0) continue;
      if (['==', '!=', '<=', '>=', '!~'].includes(two) || c === '<' || c === '~') {
        const line = source.slice(0, match.index).split('\n').length;
        found.push(`${line}: ${source.split('\n')[line - 1]!.trim()}`);
        break;
      }
      if (c === ';' || c === '}' || c === '\n' || c === '|' || c === '>' || c === "'") break;
    }
  }
  return found;
}

describe('awk portability (one-true-awk) in scripts/ubicloud', () => {
  it('flags a comparison in an unparenthesized print list and passes the parenthesized form', () => {
    expect(bwkPrintComparisons(`awk '{ printf "%s%s\\n", o, o == me ? " (you)" : "" | "sort" }'`)).toHaveLength(1);
    expect(bwkPrintComparisons(`awk '{ print $1, $2 != "" }'`)).toHaveLength(1);
    expect(bwkPrintComparisons(`awk '{ printf("%s%s\\n", o, (o == me) ? " (you)" : "") | "sort" }'`)).toEqual([]);
    expect(bwkPrintComparisons(`awk '$2==n {print $1}'`)).toEqual([]);
    expect(bwkPrintComparisons(`printf '%s\\n' "$rows" | awk -v o="$OWNER" 'NF && $3!=o {print $3}'`)).toEqual([]);
  });

  it('no awk program in scripts/ubicloud puts a comparison in an unparenthesized print list', () => {
    const hits = readdirSync(DIR).filter(f => f.endsWith('.sh')).flatMap(f => bwkPrintComparisons(readFileSync(join(DIR, f), 'utf8')).map(h => `${f}:${h}`));
    expect(hits).toEqual([]);
  });
});
