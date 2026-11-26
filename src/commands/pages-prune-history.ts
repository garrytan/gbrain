/**
 * `gbrain pages prune-history` (#9737): the owner prunes saved versions from chosen pages' history, preview first.
 * (`gbrain history <slug>` is the get_versions read, so the prune lives with the other page-level operator commands.)
 *
 *   gbrain pages prune-history <slug> | --prefix <p> | --type <t> | --all  [--source <id>]
 *       (--keep N | --older-than <72h|30d> | --version <id>...)  [--json]
 *       [--yes --expect <plan_hash>]
 *
 * Without --yes it only previews: the pages, how many versions go and stay, the oldest and newest removed, the bytes,
 * and the plan_hash. --yes --expect <plan_hash> applies that exact plan; a different plan refuses preview_changed and
 * changes nothing. Logic: core/page-state/history-prune.ts. Runs on the brain host only (no operation exposes it).
 */
import type { BrainEngine } from '../core/engine.ts';
import { usageError, writeCliError } from '../cli/cli-error.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { opError } from '../core/ops/contract.ts';
import { shellQuote } from '../core/agent-output.ts';
import { OLDER_THAN_RE } from '../cli/strict-args.ts';
import { applyHistoryPrune, planHistoryPrune, type HistoryPrunePlan, type HistoryPruneSelection } from '../core/page-state/history-prune.ts';

const USAGE = 'gbrain pages prune-history <slug> | --prefix <p> | --type <t> | --all [--source <id>] (--keep N | --older-than <72h|30d> | --version <id>...) [--json] [--yes --expect <plan_hash>]';
const PAGES_SHOWN = 20;

export interface HistoryPruneArgs extends HistoryPruneSelection { json: boolean; yes: boolean; dryRun?: boolean; expect?: string; olderThan?: string }

export function parseHistoryPruneArgs(args: readonly string[]): HistoryPruneArgs {
  const out: HistoryPruneArgs = { json: false, yes: false };
  const positional: string[] = [];
  const value = (i: number, name: string) => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--') || !v.trim()) throw usageError(`${name} needs a value; nothing was pruned.`, `Usage: ${USAGE}`);
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') out.json = true;
    else if (a === '--yes') out.yes = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--all') out.all = true;
    else if (a === '--expect') out.expect = value(i++, a);
    else if (a === '--source') out.sourceId = value(i++, a);
    else if (a === '--prefix') out.prefix = value(i++, a);
    else if (a === '--type') out.type = value(i++, a);
    else if (a === '--keep') {
      const n = value(i++, a);
      if (!/^\d+$/.test(n)) throw usageError(`--keep takes a whole number, not ${n}; nothing was pruned.`, `Usage: ${USAGE}`);
      out.keep = Number(n);
    } else if (a === '--older-than') {
      const n = value(i++, a);
      if (!OLDER_THAN_RE.test(n)) throw usageError(`--older-than takes hours (72 or 72h) or days (30d), not ${n}; nothing was pruned.`, `Usage: ${USAGE}`);
      out.olderThan = n;
      out.olderThanHours = n.endsWith('d') ? parseInt(n, 10) * 24 : parseInt(n, 10);
    } else if (a === '--version') {
      const n = value(i++, a);
      if (!/^\d+$/.test(n)) throw usageError(`--version takes a version id from get_versions, not ${n}; nothing was pruned.`, `Usage: ${USAGE}`);
      (out.versionIds ??= []).push(Number(n));
    } else if (a.startsWith('-')) throw usageError(`gbrain pages prune-history does not accept ${a}; nothing was pruned.`, `Usage: ${USAGE}`);
    else if (!a.trim()) throw usageError('A page slug cannot be empty; nothing was pruned.', `Usage: ${USAGE}`);
    else positional.push(a);
  }
  if (positional.length > 1) throw usageError('Name one page slug, or use --prefix, --type or --all; nothing was pruned.', `Usage: ${USAGE}`);
  if (positional[0]) out.slug = positional[0];
  const scopes = [out.slug !== undefined, out.prefix !== undefined || out.type !== undefined, out.all === true].filter(Boolean).length;
  if (scopes !== 1) throw usageError('Choose the pages with exactly one of: a slug, --prefix/--type, or --all; nothing was pruned.', `Usage: ${USAGE}`);
  if (out.versionIds && (out.keep !== undefined || out.olderThanHours !== undefined || out.slug === undefined)) {
    throw usageError('--version names versions of one <slug> and does not combine with --keep or --older-than; nothing was pruned.', `Usage: ${USAGE}`);
  }
  if (!out.versionIds && out.keep === undefined && out.olderThanHours === undefined) {
    throw usageError('Say which versions go: --keep N, --older-than <72h|30d>, or --version <id>; nothing was pruned.', `Usage: ${USAGE}`);
  }
  if (out.yes !== (out.expect !== undefined)) {
    throw usageError('Applying needs both --yes and --expect <plan_hash> from the preview; nothing was pruned.', `Preview first: ${shellQuote(previewArgv(out))}`);
  }
  return out;
}

function selectionArgv(a: HistoryPruneArgs): string[] {
  return ['gbrain', 'pages', 'prune-history', ...(a.slug !== undefined ? [a.slug] : []), ...(a.prefix !== undefined ? ['--prefix', a.prefix] : []),
    ...(a.type !== undefined ? ['--type', a.type] : []), ...(a.all ? ['--all'] : []), ...(a.sourceId !== undefined ? ['--source', a.sourceId] : []),
    ...(a.keep !== undefined ? ['--keep', String(a.keep)] : []), ...(a.olderThan !== undefined ? ['--older-than', a.olderThan] : []),
    ...(a.versionIds ?? []).flatMap(id => ['--version', String(id)])];
}
const previewArgv = (a: HistoryPruneArgs) => [...selectionArgv(a), '--json'];

function describePlan(plan: HistoryPrunePlan, apply: string[] | null): string {
  const t = plan.totals;
  if (!t.versions) return 'Nothing to prune: no saved version matches.';
  const lines = [`Would prune ${t.versions} saved version(s) from ${t.pages} page(s), ${t.bytes} bytes, saved ${t.oldest_at} to ${t.newest_at}. The live pages do not change.`];
  for (const p of plan.pages.slice(0, PAGES_SHOWN)) {
    lines.push(`  ${p.source_id}:${p.slug}  prune ${p.versions_pruned}, keep ${p.versions_kept}  (${p.oldest_pruned_at} .. ${p.newest_pruned_at}, ${p.bytes_pruned} bytes)`);
  }
  if (plan.pages.length > PAGES_SHOWN) lines.push(`  and ${plan.pages.length - PAGES_SHOWN} more page(s) (--json lists every one)`);
  const kept = plan.kept_by_rule;
  if (kept.segmented_versions || kept.agent_policy_pages) lines.push(`Kept by rule: ${kept.segmented_versions} segmented version(s), every version of ${kept.agent_policy_pages} agent_policy page(s).`);
  lines.push(`plan_hash: ${plan.plan_hash}`);
  if (apply) lines.push(`A pruned version can't be restored. Apply, only after the user agrees: ${shellQuote(apply)}`);
  return lines.join('\n');
}

async function prune(engine: BrainEngine, args: string[]): Promise<void> {
  const parsed = parseHistoryPruneArgs(args);
  const plan = await planHistoryPrune(engine, parsed);
  const sources = plan.slug_sources ?? [];
  if (sources.length > 1) {
    throw usageError(`${parsed.slug} names a page in ${sources.length} sources (${sources.join(', ')}); nothing was pruned.`, `Name the one you mean: ${shellQuote(previewArgv({ ...parsed, sourceId: sources[0] }))}`);
  }
  const print = (doc: unknown, text: string) => process.stdout.write((parsed.json ? JSON.stringify(doc, null, 2) : text) + '\n');
  if (!parsed.yes || parsed.dryRun) {
    const apply = plan.totals.versions ? [...selectionArgv(parsed), '--yes', '--expect', plan.plan_hash] : null;
    print({ dry_run: true, ...plan, ...(apply ? { apply } : {}) }, describePlan(plan, apply));
    return;
  }
  if (parsed.expect !== plan.plan_hash) {
    throw opError('preview_changed', `The prune plan changed since its preview (--expect ${parsed.expect}, current plan ${plan.plan_hash}); nothing was pruned.`,
      'Preview again, show the user the new plan, and apply with its plan_hash only if they agree.',
      { why: 'An approval covers exactly the versions the user saw.',
        fix: { argv: previewArgv(parsed), consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows the current plan and its plan_hash; changes nothing.' } });
  }
  const pruned = await applyHistoryPrune(engine, plan);
  print({ dry_run: false, plan_hash: plan.plan_hash, pruned, totals: plan.totals },
    (pruned.versions ? `Pruned ${pruned.versions} saved version(s) from ${pruned.pages} page(s). The live pages did not change.` : 'Nothing to prune: no saved version matches.')
      + (pruned.unchanged_pages ? `\n${pruned.unchanged_pages} page(s) were left as they are: renamed, moved, deleted or already pruned since the preview.` : ''));
}

export async function runPruneHistory(engine: BrainEngine, args: string[]): Promise<void> {
  try {
    await prune(engine, args);
  } catch (e) {
    setCliExitVerdict(writeCliError(e, 'pages', { json: args.includes('--json') }));
  }
}
