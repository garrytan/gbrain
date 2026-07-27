/**
 * skillpack/diff-text.ts — minimal pure-JS unified-diff producer.
 *
 * Used by:
 *   - `gbrain skillpack reference` (T4) to present per-file diffs to
 *     the agent so it can decide what to integrate.
 *   - `gbrain skillpack reference --apply-clean-hunks` (T15) as the
 *     producer side; the applier in `apply-hunks.ts` parses the same
 *     format on the consumer side.
 *
 * Algorithm: line-based LCS (Hunt–McIlroy), unified-diff output with a
 * configurable context window (default 3). Zero deps. Predictable
 * output across runs so the apply-clean-hunks round-trip is honest.
 */

const DEFAULT_CONTEXT = 3;

export interface UnifiedDiffOpts {
  /** Lines of context around each hunk. Default 3. */
  context?: number;
  /** Path label printed in the `--- a/...` header. Defaults to "a". */
  oldPath?: string;
  /** Path label printed in the `+++ b/...` header. Defaults to "b". */
  newPath?: string;
}

export function unifiedDiff(a: string, b: string, opts: UnifiedDiffOpts = {}): string {
  if (a === b) return '';
  const context = opts.context ?? DEFAULT_CONTEXT;
  const oldPath = opts.oldPath ?? 'a';
  const newPath = opts.newPath ?? 'b';

  const aSplit = splitLines(a);
  const bSplit = splitLines(b);

  const ops = diffLines(aSplit.lines, bSplit.lines);
  if (ops.length === 0) return '';

  // Step 1: walk ops, attach per-op (aIndex, bIndex) for header math.
  // aIndex = 0-indexed line position in `a` that this op consumes.
  // bIndex = 0-indexed line position in `b` that this op consumes.
  interface AnnotatedOp {
    op: DiffOp;
    aIdx: number; // valid for kind='equal' or 'del'
    bIdx: number; // valid for kind='equal' or 'add'
  }
  const ann: AnnotatedOp[] = [];
  {
    let ai = 0;
    let bi = 0;
    for (const op of ops) {
      ann.push({ op, aIdx: ai, bIdx: bi });
      if (op.kind === 'equal') {
        ai += 1;
        bi += 1;
      } else if (op.kind === 'del') ai += 1;
      else if (op.kind === 'add') bi += 1;
    }
  }

  // Step 2: identify hunk ranges. A hunk spans from `context` equals
  // before the first change to `context` equals after the last change,
  // with consecutive change-groups within 2*context equals merged.
  interface Range { start: number; end: number; } // inclusive op indices

  // First find every "change" op index.
  const changes: number[] = [];
  for (let k = 0; k < ann.length; k++) {
    if (ann[k].op.kind !== 'equal') changes.push(k);
  }
  if (changes.length === 0) return '';

  // Build merged ranges.
  const ranges: Range[] = [];
  let curStart = Math.max(0, changes[0] - context);
  let curEnd = changes[0];
  for (let c = 1; c < changes.length; c++) {
    const want = Math.max(0, changes[c] - context);
    // If extending the current range's context forward covers the gap,
    // merge. Coverage check: previous change's end-of-context >= next
    // change's start-of-context.
    if (curEnd + context >= want) {
      curEnd = changes[c];
    } else {
      ranges.push({ start: curStart, end: curEnd });
      curStart = want;
      curEnd = changes[c];
    }
  }
  ranges.push({ start: curStart, end: curEnd });

  // Step 3: extend each range's end forward by `context` equals.
  for (const r of ranges) {
    let endIdx = r.end;
    let added = 0;
    while (endIdx + 1 < ann.length && added < context) {
      endIdx += 1;
      if (ann[endIdx].op.kind === 'equal') added += 1;
    }
    r.end = endIdx;
  }

  // Step 4: emit hunks.
  const out: string[] = [];
  out.push(`--- ${oldPath}`);
  out.push(`+++ ${newPath}`);

  for (const r of ranges) {
    let aStart = -1;
    let bStart = -1;
    let aCount = 0;
    let bCount = 0;
    const body: string[] = [];
    for (let k = r.start; k <= r.end; k++) {
      const { op, aIdx, bIdx } = ann[k];
      if (op.kind === 'equal') {
        if (aStart === -1) {
          aStart = aIdx;
          bStart = bIdx;
        }
        body.push(' ' + op.line);
        aCount += 1;
        bCount += 1;
      } else if (op.kind === 'del') {
        if (aStart === -1) {
          aStart = aIdx;
          bStart = bIdx;
        }
        body.push('-' + op.line);
        aCount += 1;
      } else if (op.kind === 'add') {
        if (aStart === -1) {
          aStart = aIdx;
          bStart = bIdx;
        }
        body.push('+' + op.line);
        bCount += 1;
      }
    }
    // Empty file edge cases — if no ops emitted (shouldn't happen),
    // skip the hunk.
    if (body.length === 0) continue;

    // 1-indexed line numbers in the header.
    out.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`);
    for (const ln of body) out.push(ln);
  }

  // Trailing-newline markers.
  if (!aSplit.trailingNewline) {
    // Insert `\ No newline at end of file` after the last ' ' or '-' line.
    for (let i = out.length - 1; i >= 0; i--) {
      const c = out[i].charAt(0);
      if (c === ' ' || c === '-') {
        out.splice(i + 1, 0, '\\ No newline at end of file');
        break;
      }
    }
  }
  if (!bSplit.trailingNewline) {
    for (let i = out.length - 1; i >= 0; i--) {
      const c = out[i].charAt(0);
      if (c === ' ' || c === '+') {
        out.splice(i + 1, 0, '\\ No newline at end of file');
        break;
      }
    }
  }

  return out.join('\n') + '\n';
}

interface LineSplit {
  lines: string[];
  trailingNewline: boolean;
}

function splitLines(s: string): LineSplit {
  if (s.length === 0) return { lines: [], trailingNewline: true };
  const trailingNewline = s.endsWith('\n');
  const body = trailingNewline ? s.slice(0, -1) : s;
  return { lines: body.split('\n'), trailingNewline };
}

interface DiffOp {
  kind: 'equal' | 'del' | 'add';
  line: string;
}

/**
 * Line-level LCS-driven diff. Classic O(N*M) dynamic programming.
 */
function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
      }
    }
  }

  const ops: DiffOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ kind: 'equal', line: a[i - 1] });
      i -= 1;
      j -= 1;
    } else if (lcs[i - 1][j] >= lcs[i][j - 1]) {
      ops.push({ kind: 'del', line: a[i - 1] });
      i -= 1;
    } else {
      ops.push({ kind: 'add', line: b[j - 1] });
      j -= 1;
    }
  }
  while (i > 0) {
    ops.push({ kind: 'del', line: a[i - 1] });
    i -= 1;
  }
  while (j > 0) {
    ops.push({ kind: 'add', line: b[j - 1] });
    j -= 1;
  }
  ops.reverse();
  return ops;
}
