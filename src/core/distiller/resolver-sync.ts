/**
 * distiller/resolver-sync.ts — categorize `## Uncategorized` RESOLVER rows.
 *
 * `gbrain skillify scaffold` auto-appends new routing rows under an
 * `## Uncategorized` section. Step 7 of Task 1 moves them into the right
 * functional-area section. This is the pure text transform behind that —
 * keyless, deterministic, side-effect-free (content in → content out). The
 * CLI/op layer decides whether to write the result back.
 *
 * A row is moved to the FIRST rule whose `contains` substring appears in it.
 * If a rule's target section doesn't exist, its rows are left in place and the
 * target is reported in `unresolvedTargets` — never dropped.
 */

export interface CategorizeRule {
  /** Substring that routes a matching row to `targetSection`. */
  contains: string;
  /** Section heading text to move the row under (matched as a `## ` prefix). */
  targetSection: string;
}

export interface CategorizeResult {
  content: string;
  moved: { row: string; target: string }[];
  /** Target sections named by a rule but not present in the document. */
  unresolvedTargets: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Default rule: any patient-care role row → the "Patient care" section. */
export function patientCareRules(): CategorizeRule[] {
  return [{ contains: 'role:', targetSection: 'Patient care' }];
}

/** Index of the first `## <section>`-prefixed heading, or -1. */
function headingIndex(lines: string[], section: string): number {
  const re = new RegExp(`^##\\s+${escapeRegExp(section)}`);
  return lines.findIndex((l) => re.test(l));
}

/** End (exclusive) of the section starting at `headingIdx` — next `## ` or EOF. */
function sectionEnd(lines: string[], headingIdx: number): number {
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) return i;
  }
  return lines.length;
}

export function categorizeUncategorizedRows(
  content: string,
  rules: CategorizeRule[],
): CategorizeResult {
  let lines = content.split('\n');
  const moved: CategorizeResult['moved'] = [];
  const unresolved = new Set<string>();

  const uncatIdx = headingIndex(lines, 'Uncategorized');
  if (uncatIdx === -1) return { content, moved, unresolvedTargets: [] };

  const end = sectionEnd(lines, uncatIdx);

  // Table rows in the Uncategorized section: pipe-lines, skipping the first two
  // (header + separator).
  const pipeIdxs: number[] = [];
  for (let i = uncatIdx + 1; i < end; i++) if (/^\s*\|/.test(lines[i])) pipeIdxs.push(i);
  const dataIdxs = pipeIdxs.slice(2);

  const toRemove = new Set<number>();
  const appendByTarget = new Map<string, string[]>();

  for (const idx of dataIdxs) {
    const row = lines[idx];
    const rule = rules.find((r) => row.includes(r.contains));
    if (!rule) continue;
    if (headingIndex(lines, rule.targetSection) === -1) {
      unresolved.add(rule.targetSection);
      continue;
    }
    toRemove.add(idx);
    moved.push({ row, target: rule.targetSection });
    const bucket = appendByTarget.get(rule.targetSection);
    if (bucket) bucket.push(row);
    else appendByTarget.set(rule.targetSection, [row]);
  }

  if (moved.length === 0) return { content, moved, unresolvedTargets: [...unresolved] };

  // Drop moved rows from Uncategorized.
  lines = lines.filter((_, i) => !toRemove.has(i));

  // Insert into each target after its table's last pipe-line (fresh indices).
  for (const [target, rows] of appendByTarget) {
    const hIdx = headingIndex(lines, target);
    if (hIdx === -1) continue; // shouldn't happen (checked above), defensive
    const tEnd = sectionEnd(lines, hIdx);
    let insertAt = -1;
    for (let i = hIdx + 1; i < tEnd; i++) if (/^\s*\|/.test(lines[i])) insertAt = i;
    if (insertAt === -1) insertAt = tEnd - 1; // no table — end of section
    lines.splice(insertAt + 1, 0, ...rows);
  }

  return { content: lines.join('\n'), moved, unresolvedTargets: [...unresolved] };
}
