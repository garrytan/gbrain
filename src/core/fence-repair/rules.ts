/**
 * Tier 1 cell rules for one fence row (#6188), plus the outputs a rule may
 * produce for a given before value (the validator's gate (f) uses those to
 * accept a changed cell). Rules read only the cell they rewrite (`kind_map`
 * also appends the original word to the facts `context` cell), so a row's
 * plan never depends on other rows.
 */
import { escapeFenceCell } from '../fence-shared.ts';
import { isValidHolder } from '../takes-fence.ts';
import {
  ALLOWED, appendOriginalKind, cellValid, confidenceFormat, enumSynonym, factsKindMap, holderAlias, supersededRef, takesKindMap,
} from './schema.ts';
import type { FenceCtx, FenceKind, FenceReason, FixClass } from './types.ts';

/** A cell's source text and its parsed text. */
export interface CellText {
  raw: string;
  text: string;
}

export interface CellChange {
  column: string;
  /** New source text for the cell (escaped for the table). */
  raw: string;
  class: FixClass;
}

export interface RuleIssue {
  column: string;
  reason: FenceReason;
  allowed?: readonly string[];
}

export interface RowPlan {
  changes: CellChange[];
  issues: RuleIssue[];
  /** The `#` cell is not a positive whole number. */
  badNumber: boolean;
}

const RULE_COLUMNS: Record<FenceKind, readonly string[]> = {
  facts: ['kind', 'confidence', 'visibility', 'notability', 'claim_value'],
  takes: ['kind', 'who', 'weight'],
};

/** Plan Tier 1 changes and residual issues for one aligned row. */
export function planRowRules(kind: FenceKind, cells: ReadonlyMap<string, CellText>, ctx: FenceCtx): RowPlan {
  const plan: RowPlan = { changes: [], issues: [], badNumber: false };
  const num = cells.get('#');
  if (num && !cellValid(kind, '#', num.text)) plan.badNumber = true;
  for (const column of RULE_COLUMNS[kind]) {
    const cell = cells.get(column);
    if (!cell || cellValid(kind, column, cell.text)) continue;
    if (kind === 'facts' && column === 'kind') planFactsKind(plan, cell, cells.get('context'));
    else planCell(plan, kind, column, cell, ctx);
  }
  return plan;
}

function residual(plan: RowPlan, kind: FenceKind, column: string, reason: FenceReason): void {
  const allowed = ALLOWED[kind][column];
  plan.issues.push(allowed ? { column, reason, allowed } : { column, reason });
}

function planFactsKind(plan: RowPlan, kindCell: CellText, contextCell: CellText | undefined): void {
  if (!kindWord(kindCell.text)) {
    plan.issues.push({ column: 'kind', reason: 'claim_split', allowed: ALLOWED.facts.kind });
    return;
  }
  const before = contextCell?.text ?? '';
  const after = appendOriginalKind(before, kindCell.text);
  if (supersededRef(before) !== supersededRef(after) || forgotten(before) !== forgotten(after)) {
    residual(plan, 'facts', 'kind', 'enum_unmapped');
    return;
  }
  plan.changes.push({ column: 'kind', raw: factsKindMap(kindCell.text), class: 'kind_map' });
  if (after !== before) plan.changes.push({ column: 'context', raw: appendOriginalKind(contextCell?.raw ?? '', kindCell.raw), class: 'kind_map' });
}

/**
 * A facts kind cell `kind_map` may read: at most three words, no sentence
 * punctuation, no markdown link or strikethrough. Anything longer is more
 * likely the end of a claim an unescaped `|` cut in two (with the kind cell
 * missing, the row keeps its width), so it is never stored as a kind note.
 */
export function kindWord(text: string): boolean {
  const word = text.trim();
  return word.split(/\s+/).length <= 3 && !/[.,;:!?]/.test(word) && !/\[[^\]]*\]\(|~~/.test(word);
}

function forgotten(context: string): boolean {
  return /^forgotten\s*:/i.test(context.trim());
}

function planCell(plan: RowPlan, kind: FenceKind, column: string, cell: CellText, ctx: FenceCtx): void {
  const out = ruleOutputs(kind, column, cell.text, ctx)[0];
  if (out) {
    plan.changes.push({ column, raw: escapeFenceCell(out.text), class: out.class });
    return;
  }
  residual(plan, kind, column, residualReason(kind, column, cell.text));
}

function residualReason(kind: FenceKind, column: string, text: string): FenceReason {
  if (column === 'kind') return 'takes_kind_unsupported';
  if (column === 'claim_value') return 'claim_value_invalid';
  if (column === 'visibility' || column === 'notability') return 'enum_unmapped';
  if (column === 'who') return text.trim() ? 'holder_unresolved' : 'holder_missing';
  if (column === 'weight' && !text.trim()) return 'weight_missing';
  return 'confidence_out_of_range';
}

/**
 * Every value a named rule may write in `column` for the before text, with
 * its class. Empty when no rule applies.
 */
export function ruleOutputs(kind: FenceKind, column: string, text: string, ctx: FenceCtx): Array<{ text: string; class: FixClass }> {
  switch (column) {
    case 'kind': {
      const mapped = kind === 'facts' ? (kindWord(text) ? factsKindMap(text) : null) : takesKindMap(text, ctx.takesPackKinds);
      return mapped ? [{ text: mapped, class: 'kind_map' }] : [];
    }
    case 'visibility':
    case 'notability': {
      const mapped = kind === 'facts' ? enumSynonym(column, text, ctx.pageVisibility) : null;
      return mapped ? [{ text: mapped, class: 'enum_synonym' }] : [];
    }
    case 'confidence':
    case 'weight': {
      const formatted = confidenceFormat(text);
      return formatted ? [{ text: formatted, class: 'confidence_format' }] : [];
    }
    case 'who':
      return kind === 'takes' ? holderOutputs(text, ctx) : [];
    default:
      return [];
  }
}

function holderOutputs(text: string, ctx: FenceCtx): Array<{ text: string; class: FixClass }> {
  const out: Array<{ text: string; class: FixClass }> = [];
  const alias = holderAlias(text);
  if (alias) out.push({ text: alias, class: 'holder_alias' });
  const verified = ctx.verifiedHolders?.get(text.trim());
  if (verified && isValidHolder(verified) && verified !== alias) out.push({ text: verified, class: 'holder_verified' });
  return out;
}
