/**
 * splitBody must stay byte-identical (content_hash is computed over its
 * output) while no longer re-joining every line above each `---` or
 * `## Timeline` candidate.
 *
 * 1. Protects: the compiled_truth / timeline split of every page, and the
 *    linear cost of parsing a chat export separated by `---` lines.
 * 2. Fails when: the "prefix has content" test drifts from the old
 *    `lines.slice(0, i).join('\n').trim()` meaning (differential), or the
 *    per-candidate prefix join comes back (operation-count probe).
 * 3. Existing coverage: test/markdown.test.ts pins named cases but neither a
 *    fuzz corpus against the old implementation nor the cost shape.
 * 4. No production seam: the probe counts Array.prototype.join work.
 */
import { describe, expect, test } from 'bun:test';
import { splitBody } from '../../src/core/markdown.ts';
import { findLineOutsideFencedCode } from '../../src/core/fence-scan.ts';
import { mulberry32 } from '../helpers/seeded-random.ts';

// ---- Oracle: splitBody as it was before the incremental prefix check. ----
function oracleSplitBody(body: string): { compiled_truth: string; timeline: string } {
  const lines = body.split('\n');
  const splitIndex = findLineOutsideFencedCode(lines, (i) => oracleIsSentinel(lines, i));
  if (splitIndex !== -1) {
    return {
      compiled_truth: lines.slice(0, splitIndex).join('\n'),
      timeline: lines.slice(splitIndex + 1).join('\n'),
    };
  }
  const section = oracleBareSection(lines);
  if (section) {
    return {
      compiled_truth: lines.slice(0, section.start).concat(lines.slice(section.end)).join('\n'),
      timeline: lines.slice(section.start, section.end).join('\n'),
    };
  }
  return { compiled_truth: body, timeline: '' };
}

function oracleIsSentinel(lines: string[], i: number): boolean {
  const trimmed = lines[i]!.trim();
  if (trimmed === '<!-- timeline -->' || trimmed === '<!--timeline-->') return true;
  if (trimmed === '--- timeline ---' || /^---\s+timeline\s+---$/i.test(trimmed)) return true;
  if (trimmed === '---') {
    const beforeContent = lines.slice(0, i).join('\n').trim();
    if (beforeContent.length === 0) return false;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!.trim();
      if (next.length === 0) continue;
      return /^##\s+(timeline|history)\s*$/i.test(next);
    }
  }
  return false;
}

const ORACLE_DATED_BULLET_RE = /^\s*[-*+]\s+\**\d{4}\b/;

function oracleBareSection(lines: string[]): { start: number; end: number } | null {
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(lines[i]!);
    if (fence) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!/^##\s+(timeline|history)\b/i.test(lines[i]!.trim())) continue;
    const beforeContent = lines.slice(0, i).join('\n').trim();
    if (beforeContent.length === 0) continue;
    let end = lines.length;
    let datedBullets = 0;
    let shaped = true;
    for (let j = i + 1; j < lines.length; j++) {
      const trimmed = lines[j]!.trim();
      if (/^##\s+\S/.test(trimmed)) { end = j; break; }
      if (trimmed.length === 0) continue;
      if (ORACLE_DATED_BULLET_RE.test(lines[j]!)) { datedBullets++; continue; }
      if (datedBullets > 0 && /^\s{2,}\S/.test(lines[j]!)) continue;
      shaped = false;
      break;
    }
    if (shaped && datedBullets > 0) return { start: i, end };
  }
  return null;
}

// Line shapes that exercise every sentinel rule, blank and whitespace-only
// prefixes (including BOM and NBSP, which trim() removes), fences and CRLF.
const LINE_POOL = [
  '', '', ' ', '\t', '\r', '\uFEFF', '\u00A0', '  \r',
  '---', ' --- ', '---\r', '--- timeline ---', '---   TIMELINE   ---', '<!-- timeline -->', '<!--timeline-->',
  '## Timeline', '## History', '##  timeline  ', '## Timeline\r', '## History of acme-example', '## Notes',
  '- 2024-05-01: alice-example joined', '* **2020** founded', '  continued bullet text', '- not dated',
  '```', '~~~', '```ts', 'plain prose line', 'alice-example: hi there', '# Title',
];

function randomBody(rand: () => number): string {
  const n = Math.floor(rand() * 40);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(LINE_POOL[Math.floor(rand() * LINE_POOL.length)]!);
  return out.join(rand() < 0.1 ? '\r\n' : '\n');
}

describe('splitBody differential (old vs new)', () => {
  test('identical output over a seeded fuzz corpus', () => {
    const rand = mulberry32(0x5eed_b0d1);
    let splits = 0;
    for (let k = 0; k < 20_000; k++) {
      const body = randomBody(rand);
      const got = splitBody(body);
      expect(got).toEqual(oracleSplitBody(body));
      if (got.timeline !== '') splits++;
    }
    // The corpus must reach the split arms, not only the no-sentinel path.
    expect(splits).toBeGreaterThan(1_000);
  });

  test('identical output on whitespace-only prefixes before each rule', () => {
    for (const prefix of ['', '\n', ' \n\t\n', '\uFEFF\n', '\u00A0\n\n']) {
      for (const tail of ['---\n## Timeline\n- 2024-01-01: x', '## Timeline\n- 2024-01-01: x', '---\n\n## History\n- 2020 y']) {
        for (const lead of ['', 'content\n']) {
          const body = prefix + lead + tail;
          expect(splitBody(body)).toEqual(oracleSplitBody(body));
        }
      }
    }
  });
});

/** Total array elements passed through Array.prototype.join while `fn` runs. */
function countJoinedElements(fn: () => void): number {
  const original = Array.prototype.join;
  let joined = 0;
  Array.prototype.join = function (this: unknown[], sep?: string): string {
    joined += this.length;
    return original.call(this, sep);
  };
  try {
    fn();
  } finally {
    Array.prototype.join = original;
  }
  return joined;
}

describe('splitBody cost probe', () => {
  // n chat messages separated by `---` (the rule-3 candidate on every
  // separator) then n prose `## History` headings (the #2225 candidate). The
  // old code joined every line above each candidate: ~n^2 joined elements.
  // Peak memory stays O(n) either way, so the probe never allocates the
  // quadratic case.
  const N = 1_500;
  const lines: string[] = ['# Conversation with alice-example', ''];
  for (let i = 0; i < N; i++) lines.push(`alice-example: message ${i}`, '---');
  lines.push('end of messages');
  for (let i = 0; i < N; i++) lines.push('## History', 'prose, not a dated bullet');
  const body = lines.join('\n');

  test('joins O(lines) elements, not O(lines^2)', () => {
    const lineCount = body.split('\n').length;
    const joined = countJoinedElements(() => splitBody(body));
    expect(joined).toBeLessThanOrEqual(4 * lineCount);
  });

  test('the oracle shows the quadratic shape the probe catches', () => {
    const lineCount = body.split('\n').length;
    const joined = countJoinedElements(() => oracleSplitBody(body));
    expect(joined).toBeGreaterThan(100 * lineCount);
  });
});
