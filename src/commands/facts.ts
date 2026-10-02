/**
 * `gbrain facts relink` (#5836): link facts saved without an entity to the
 * entity they are about. Trusted local CLI only; the work lives in
 * src/core/facts/relink.ts and src/core/facts/relink-publish.ts.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';
import { RELINK_DEFAULT_LIMIT, RELINK_DEFAULT_MAX_USD, runFactsRelink, type RelinkOptions, type RelinkReport } from '../core/facts/relink.ts';
import { RELINK_REASONS, type RelinkReason } from '../core/facts/relink-reasons.ts';

export function factsHelpText(): string {
  return `Usage: gbrain facts <subcommand>

Subcommands:
  relink    Link facts saved without an entity to the person, company or
            project they are about, onto that entity page's ## Facts fence.

gbrain facts relink [flags]
  --source <id>          Source to repair (default: the resolved source)
  --dry-run              Show what would link; writes nothing, calls no model
  --limit <n>            Facts to examine this run (default ${RELINK_DEFAULT_LIMIT})
  --after-id <n>         Start after this fact id (the printed continuation point)
  --since <ISO date>     Only facts created on or after this date
  --no-llm               Free tiers only (recorded page, unique entity mention)
  --max-usd <n|off>      Cap for the model tier (default ${RELINK_DEFAULT_MAX_USD.toFixed(2)}); alias --max-cost-usd
  --retry-model          Ask the model again about facts it already judged
  --include-private      Also send private facts to the model tier
  --no-conflict-queue    Do not queue linked facts for the conflict sweep
  --examples <n>         Example facts per outcome (default 3)
  --json                 Machine-readable report (schema_version ${1})

Relink never creates pages and never supersedes a fact. Exact duplicates are
retired (expired, kept in history). Linked facts are queued for the System One
conflict sweep when that slot is on. Free tiers cost nothing; the model tier
uses facts.extraction_model and stops at --max-usd.`;
}

interface ParsedArgs { opts: Omit<RelinkOptions, 'config'>; json: boolean; error?: string }

function parseRelinkArgs(args: string[], sourceId: string): ParsedArgs {
  const opts: Omit<RelinkOptions, 'config'> = { sourceId, maxUsd: RELINK_DEFAULT_MAX_USD };
  let json = false;
  const value = (i: number, flag: string): string => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
    return v;
  };
  try {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === '--json') json = true;
      else if (a === '--dry-run') opts.dryRun = true;
      else if (a === '--no-llm') opts.llm = false;
      else if (a === '--retry-model') opts.retryModel = true;
      else if (a === '--include-private') opts.includePrivate = true;
      else if (a === '--no-conflict-queue') opts.conflictQueue = false;
      else if (a === '--source') { opts.sourceId = value(i, a); i++; }
      else if (a === '--limit' || a === '--after-id' || a === '--examples') {
        const n = Number(value(i, a));
        if (!Number.isSafeInteger(n) || n < (a === '--after-id' || a === '--examples' ? 0 : 1)) throw new Error(`${a} must be a whole number`);
        if (a === '--limit') opts.limit = n; else if (a === '--after-id') opts.afterId = n; else opts.examples = n;
        i++;
      } else if (a === '--since') {
        const raw = value(i, a);
        const d = new Date(raw);
        if (!/^\d{4}-\d{2}-\d{2}/.test(raw) || Number.isNaN(d.getTime())) throw new Error('--since takes an ISO 8601 date (e.g. 2026-09-01); use --after-id for a fact id');
        opts.since = d;
        i++;
      } else if (a === '--max-usd' || a === '--max-cost-usd') {
        const raw = value(i, a);
        if (/^(off|unlimited|none)$/i.test(raw)) opts.maxUsd = null;
        else {
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0) throw new Error(`${a} takes a dollar amount or off`);
          opts.maxUsd = n;
        }
        i++;
      } else throw new Error(`unknown flag ${a}`);
    }
  } catch (err) {
    return { opts, json, error: err instanceof Error ? err.message : String(err) };
  }
  return { opts, json };
}

function continuation(report: RelinkReport, args: string[]): string | null {
  if (!report.has_more || report.next_after_id === null) return null;
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--after-id') { i++; continue; }
    kept.push(args[i]!);
  }
  return `gbrain facts relink ${[...kept, '--after-id', String(report.next_after_id)].join(' ')}`;
}

export function formatRelinkReport(report: RelinkReport, args: string[]): string {
  const lines: string[] = [];
  const t = report.linked_by_tier;
  lines.push(`${report.dry_run ? 'DRY RUN: would link' : 'Linked'} ${report.linked} of ${report.scanned} unlinked fact(s) in source ${report.source_id}` +
    ` (page ${t.page}, mention ${t.mention}, model ${t.model}); ${report.deduped} exact duplicate(s) retired.`);
  if (!report.dry_run && report.linked) {
    lines.push(`Conflict sweep: ${report.queued_for_conflict} queued, ${report.eligible_for_conflict} eligible (have an embedding).`);
  }
  if (report.provider) {
    const cost = report.estimated_model_cost_usd == null ? 'unknown price' : `est. $${report.estimated_model_cost_usd.toFixed(4)}`;
    lines.push(`Model tier: ${report.facts_sent_to_model} fact(s) ${report.dry_run ? 'would go' : 'sent'} to ${report.provider} (${cost}` +
      `${report.dry_run ? '' : `, spent $${report.spend_usd.toFixed(4)}`}).` +
      (report.private_excluded_from_model ? ` ${report.private_excluded_from_model} private fact(s) held back (--include-private).` : ''));
  }
  const skipped = Object.entries(report.skipped) as Array<[RelinkReason, number]>;
  if (skipped.length) {
    lines.push('Not linked:');
    for (const [reason, n] of skipped.sort((a, b) => b[1] - a[1])) lines.push(`  ${reason}: ${n}. ${RELINK_REASONS[reason].fix}`);
  }
  if (report.fence_owned) lines.push(`  fence_owned: ${report.fence_owned} (not examined). ${RELINK_REASONS.fence_owned.fix}`);
  for (const [outcome, list] of Object.entries(report.examples)) {
    lines.push(`Examples (${outcome}):`);
    for (const e of list) lines.push(`  #${e.id} ${e.fact}${e.target ? ` -> ${e.target}` : ''}`);
  }
  if (report.stopped) lines.push(`Stopped early: ${report.stopped}.`);
  const next = continuation(report, args);
  if (next) lines.push(`More unlinked facts remain. Continue with:\n  ${next}`);
  else if (report.dry_run && report.linked) lines.push(`Apply with:\n  gbrain facts relink ${args.filter(a => a !== '--dry-run').join(' ')}`.trimEnd());
  return lines.join('\n');
}

/** Exit code: 0 for complete and partial runs (limit or budget), 1 for usage errors. */
export async function runFactsCommand(engine: BrainEngine, args: string[], config: GBrainConfig, sourceId: string): Promise<number> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(factsHelpText());
    return 0;
  }
  if (sub !== 'relink') {
    console.error(`gbrain facts: unknown subcommand ${sub}\n\n${factsHelpText()}`);
    return 1;
  }
  const rest = args.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(factsHelpText());
    return 0;
  }
  const parsed = parseRelinkArgs(rest, sourceId);
  if (parsed.error) {
    console.error(`gbrain facts relink: ${parsed.error}`);
    return 1;
  }
  const isTty = process.stderr.isTTY === true;
  const report = await runFactsRelink(engine, {
    ...parsed.opts, config,
    onModelStart: line => process.stderr.write(`[facts relink] ${line}\n`),
    onProgress: isTty ? (done, total) => { if (done === total || done % 100 === 0) process.stderr.write(`\r[facts relink] free tiers ${done}/${total}`); if (done === total) process.stderr.write('\n'); } : undefined,
  });
  console.log(parsed.json ? JSON.stringify({ ...report, next_command: continuation(report, rest) }, null, 2) : formatRelinkReport(report, rest));
  return 0;
}
