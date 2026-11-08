/**
 * Storage shelf recovery as JSONL (GST-1943). `gbrain storage export --jsonl` writes one card per line, sorted by id,
 * stamped fields (`registered_by`, `origin`) included. `gbrain storage import --jsonl <file>` previews each line
 * (create / identical / conflict / invalid) with a plan_hash, and the apply with that plan_hash registers the missing
 * cards through registerCard with origin `import`: gbrain stamps registered_by and origin again, so a file cannot set
 * them. A card on the shelf that differs from its line is a conflict, reported and never overwritten. Idempotent: a
 * rerun finds the cards it created identical. Trusted local CLI only. Lines are validated like a new card, so an
 * invalid line never echoes its values.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../remediation-step.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { registerCard } from '../ops/storage-manifest.ts';
import type { BrainEngine } from '../engine.ts';
import { readShelfCards } from './find.ts';
import { cardContent, cardDigest, parseCardInput, type CardInput } from './schema.ts';
import { shelfWritable } from './source.ts';
import type { SideEffects, StepFailure } from './adopt.ts';

export type ImportAction = 'create' | 'identical' | 'conflict' | 'invalid';
export interface ImportLine { line: number; id: string | null; action: ImportAction; code?: string; reason?: string; message?: string }
export interface ImportPlan { action: 'import'; dry_run: true; file: string; lines: ImportLine[]; counts: Record<ImportAction, number>; plan_hash: string; summary: string[]; apply?: string[] }
export interface ImportApplyResult {
  action: 'import'; dry_run: false; file: string; plan_hash: string; side_effects: SideEffects;
  created: string[]; identical: string[]; conflicts: string[]; invalid: number[]; failure?: StepFailure; rerun?: string[];
}
interface ParsedLine { line: number; id: string | null; card: CardInput | null; code?: string; reason?: string; message?: string }

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** One line per card on the shelf, sorted by id, keys sorted; pages on the shelf that hold no card are listed in `skipped`. */
export async function exportShelfJsonl(engine: BrainEngine): Promise<{ lines: string[]; skipped: string[] }> {
  const rows = await readShelfCards(engine);
  return { lines: rows.flatMap((row) => row.card ? [canonicalJson(row.card)] : []), skipped: rows.filter((row) => !row.card).map((row) => row.id) };
}

function invalidLine(line: number, id: string | null, reason: string, message: string, code = 'storage_record_invalid'): ParsedLine {
  return { line, id, card: null, code, reason, message };
}

function parseLines(text: string): ParsedLine[] {
  const seen = new Set<string>();
  return text.split('\n').flatMap((raw, i): ParsedLine[] => {
    if (!raw.trim()) return [];
    const line = i + 1;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return [invalidLine(line, null, 'not_json', 'the line is not valid JSON')]; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [invalidLine(line, null, 'not_object', 'the line is not a JSON object')];
    const { registered_by: _by, origin: _origin, ...content } = value as Record<string, unknown>;
    const id = typeof content.id === 'string' ? content.id : null;
    let card: CardInput;
    try { card = parseCardInput(content); } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      return [invalidLine(line, id, error.reason ?? 'schema', error.message.replace(/; nothing was written\.$/, ''), error.code)];
    }
    if (seen.has(card.id)) return [invalidLine(line, card.id, 'duplicate_id', `an earlier line holds card id ${card.id}`)];
    seen.add(card.id);
    return [{ line, id: card.id, card }];
  });
}

/** Preview an import: per line what the apply would do. Writes nothing; a brain with a Git checkout refuses until storage init has run. */
export async function previewImport(engine: BrainEngine, file: string, text: string): Promise<ImportPlan & { cards: Map<number, CardInput> }> {
  await shelfWritable(engine);
  const shelf = new Map((await readShelfCards(engine)).map((row) => [row.id, row.card]));
  const cards = new Map<number, CardInput>();
  const lines: ImportLine[] = parseLines(text).map(({ card, ...rest }) => {
    if (!card) return { ...rest, action: 'invalid' };
    cards.set(rest.line, card);
    if (!shelf.has(card.id)) return { line: rest.line, id: card.id, action: 'create' };
    const onShelf = shelf.get(card.id);
    const existing = onShelf ? cardContent(onShelf) : null;
    return { line: rest.line, id: card.id, action: existing && cardDigest(existing) === cardDigest(card) ? 'identical' : 'conflict' };
  });
  const counts: Record<ImportAction, number> = { create: 0, identical: 0, conflict: 0, invalid: 0 };
  for (const line of lines) counts[line.action]++;
  const plan_hash = sha256(JSON.stringify({ v: 1, kind: 'import', lines: lines.map((l) => ({ line: l.line, id: l.id,
    card: cards.has(l.line) ? cardDigest(cards.get(l.line)!) : null, invalid: l.action === 'invalid' ? l.reason : null, conflict: l.action === 'conflict' })) }));
  const summary = [`${lines.length} card line(s) in ${file}: ${counts.create} to create, ${counts.identical} already on the shelf, ${counts.conflict} conflict(s), ${counts.invalid} invalid.`];
  if (counts.conflict) summary.push('A conflict is a card already on the shelf that differs from its line; import never overwrites it.');
  if (counts.invalid) summary.push('Invalid lines are skipped; the line numbers and reasons are listed (values are not shown).');
  const apply = counts.create ? ['gbrain', 'storage', 'import', '--jsonl', file, '--apply', '--expect', plan_hash] : undefined;
  return { action: 'import', dry_run: true, file, lines, counts, plan_hash, summary, ...(apply ? { apply } : {}), cards };
}

/** Apply the previewed import. Creates only; a failure stops the run and reports side_effects and the rerun command. */
export async function applyImport(ctx: OperationContext, file: string, text: string, expect: string): Promise<ImportApplyResult> {
  const { cards, ...plan } = await previewImport(ctx.engine, file, text);
  const previewArgv = ['gbrain', 'storage', 'import', '--jsonl', file, '--json'];
  if (expect !== plan.plan_hash) {
    throw opError('preview_changed', `The import plan for ${file} changed since its preview (approved plan ${expect}); nothing was written.`,
      'Preview the import again, show the user the new plan, and apply the plan_hash it prints only if they approve it.',
      { fix: readFix('Prints the current import plan and its plan_hash; writes nothing.', { argv: previewArgv }) });
  }
  const created: string[] = [];
  let failure: StepFailure | undefined;
  for (const line of plan.lines.filter((l) => l.action === 'create')) {
    try {
      await registerCard(ctx, cards.get(line.line)!, 'import');
      created.push(line.id!);
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      failure = { item: line.id!, code: error.canonical ?? error.code, message: error.message };
      break;
    }
  }
  const ids = (action: ImportAction) => plan.lines.filter((l) => l.action === action).map((l) => l.id!);
  return { action: 'import', dry_run: false, file, plan_hash: plan.plan_hash,
    side_effects: failure ? (created.length ? 'partial' : 'none') : created.length ? 'complete' : 'none',
    created, identical: ids('identical'), conflicts: ids('conflict'), invalid: plan.lines.filter((l) => l.action === 'invalid').map((l) => l.line),
    ...(failure ? { failure, rerun: plan.apply ?? ['gbrain', 'storage', 'import', '--jsonl', file, '--apply', '--expect', plan.plan_hash] } : {}) };
}
