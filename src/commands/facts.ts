/**
 * `gbrain facts relink` (#5836): link facts saved without an entity to the
 * entity they are about. Trusted local CLI only; the work lives in
 * src/core/facts/relink.ts and src/core/facts/relink-publish.ts.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';
import { RELINK_DEFAULT_LIMIT, RELINK_DEFAULT_MAX_USD, runFactsRelink, type RelinkOptions, type RelinkReport } from '../core/facts/relink.ts';
import { RELINK_REASONS, type RelinkReason } from '../core/facts/relink-reasons.ts';
import { CONVERSATION_RELINK_PAGES, runConversationRelink, type ConversationRelinkReport } from '../core/facts/conversation-relink.ts';
import { DEFAULT_MAX_RESUBMITS, FACTS_ABSORB_RETRY_MAX_KEY, factsRetryDeadCommand, readDeadFactsAbsorbRetry, updateDeadFactsAbsorbKeys } from '../core/facts/dead-absorb-retry.ts';

export function factsHelpText(): string {
  return `Usage: gbrain facts <subcommand>

Subcommands:
  relink      Link facts saved without an entity to the person, company or
              project they are about, onto that entity page's ## Facts fence.
  retry-dead  Show or reset the retry set of dead page-write facts-absorb jobs.

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

gbrain facts relink --conversation [--source <id>] [--slugs <a,b>] [--dry-run] [--json]
  Link the conversation extractor's facts saved without an entity (plain
  relink never examines them), free only: a fact naming exactly one entity
  page in full is linked, one write per page. Without --slugs, the
  ${CONVERSATION_RELINK_PAGES} pages with the most untried unlinked facts. Facts it cannot
  resolve are recorded, and the report prints the paid re-extraction for
  their pages.

Relink never creates pages and never supersedes a fact. Exact duplicates are
retired (expired, kept in history). Linked facts are queued for the System One
conflict sweep when that slot is on. Free tiers cost nothing; the model tier
uses facts.extraction_model and stops at --max-usd.

gbrain facts retry-dead [--list] [--json]
gbrain facts retry-dead --reset <key>|--all [--json]
gbrain facts retry-dead --clear <key>|--all [--json]
  A put_page's facts-absorb job that died on a provider or configuration
  failure is re-submitted by the next maintenance pass (the facts_drain
  phase) once extraction is servable again, at most
  ${FACTS_ABSORB_RETRY_MAX_KEY} times per job (default ${DEFAULT_MAX_RESUBMITS}; 0 disables) and at most
  once an hour. --list shows the set: pending, exhausted (at the limit),
  cleared and not retryable (a deterministic failure). --reset lets the next
  pass re-submit a key again (naming a not-retryable job's key, after its
  cause is fixed, adds it); --clear stops re-submitting a key. Keys are the
  jobs' idempotency keys (facts-absorb:write:<request id>). Each re-submitted
  job is one paid extraction call when it runs.`;
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

export function formatConversationRelinkReport(r: ConversationRelinkReport, args: string[]): string {
  const lines = [`${r.dry_run ? 'DRY RUN: would link' : 'Linked'} ${r.linked} conversation fact(s) on ${r.pages.length} page(s) in source ${r.source_id}`
    + ` (mention tier, no model call); ${r.unresolved} unresolved${r.changed ? `; ${r.changed} changed before the write (run again)` : ''}.`];
  for (const p of r.pages) lines.push(`  ${p.slug}: ${p.linked} linked, ${p.unresolved} unresolved`);
  if (r.dry_run && r.linked) lines.push(`Apply with:\n  gbrain facts relink ${args.filter(a => a !== '--dry-run').join(' ')}`);
  if (r.reextract_slugs.length) {
    const base = `gbrain extract-conversation-facts --source-id ${r.source_id} --slugs ${r.reextract_slugs.join(',')} --force`;
    lines.push(`No entity could be proven for ${r.unresolved} fact(s). Re-extraction calls the fact model again (paid); preview, then run with the amount the user approves:\n  ${base} --dry-run\n  ${base} --max-cost-usd <N>`);
  }
  return lines.join('\n');
}

/** `--conversation` flags: --source, --slugs, --dry-run, --json; anything else is a usage error. */
async function runConversation(engine: BrainEngine, args: string[], config: GBrainConfig, sourceId: string): Promise<number> {
  const opts: { sourceId: string; slugs?: string[]; dryRun?: boolean } = { sourceId };
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const v = args[i + 1];
    if (a === '--conversation') continue;
    if (a === '--json') json = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if ((a === '--source' || a === '--slugs') && v !== undefined && !v.startsWith('--')) {
      if (a === '--source') opts.sourceId = v; else opts.slugs = v.split(',').map(s => s.trim()).filter(Boolean);
      i++;
    } else {
      console.error(`gbrain facts relink --conversation: ${a === '--source' || a === '--slugs' ? `${a} requires a value` : `unknown flag ${a} (takes --source, --slugs, --dry-run, --json)`}`);
      return 1;
    }
  }
  const report = await runConversationRelink(engine, config, opts);
  console.log(json ? JSON.stringify(report, null, 2) : formatConversationRelinkReport(report, args));
  return 0;
}

/** C-9: the dead facts-absorb retry set (src/core/facts/dead-absorb-retry.ts). Exit 1 on a usage error. */
async function runRetryDead(engine: BrainEngine, args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(factsHelpText()); return 0; }
  const json = args.includes('--json');
  const action = args.includes('--reset') ? 'reset' : args.includes('--clear') ? 'clear' : null;
  if (args.includes('--reset') && args.includes('--clear')) { console.error('gbrain facts retry-dead: pass one of --reset or --clear.'); return 1; }
  if (!action) {
    const status = await readDeadFactsAbsorbRetry(engine);
    if (json) { console.log(JSON.stringify(status, null, 2)); return 0; }
    console.log(`Dead facts-absorb retry set (limit ${status.max_resubmits} re-submit(s) per job${status.max_resubmits === 0 ? ', disabled' : ''}):`);
    console.log(`  pending ${status.pending}, exhausted ${status.exhausted.length}, cleared ${status.cleared}, not retryable ${status.not_retryable.length}${status.waiting_on ? ` (waiting on ${status.waiting_on})` : ''}`);
    for (const e of status.exhausted) console.log(`  exhausted  job ${e.job_id} ${e.slug ?? ''} after ${e.resubmits} re-submit(s); reset: ${factsRetryDeadCommand('--reset', e.key)}`);
    for (const e of status.not_retryable.slice(0, 20)) console.log(`  not retryable  job ${e.job_id} ${e.slug ?? ''}: fix the cause in its error (gbrain jobs get ${e.job_id}), then gbrain jobs retry ${e.job_id}`);
    return 0;
  }
  const flag = args.indexOf(`--${action}`);
  const target = args[flag + 1];
  const all = args.includes('--all');
  if (!all && (!target || target.startsWith('--'))) { console.error(`gbrain facts retry-dead --${action} needs a key (facts-absorb:write:<request id>) or --all; gbrain facts retry-dead --list shows them.`); return 1; }
  const changed = await updateDeadFactsAbsorbKeys(engine, action, all ? 'all' : [target!]);
  if (json) console.log(JSON.stringify({ status: action, keys: changed }, null, 2));
  else if (changed.length === 0) console.log(`No dead facts-absorb job matches ${all ? '--all' : target}; gbrain facts retry-dead --list shows the set.`);
  else console.log(action === 'reset'
    ? `Reset ${changed.length} key(s); the next maintenance pass may re-submit them (one paid extraction call each).`
    : `Cleared ${changed.length} key(s); they stay dead and are not re-submitted again.`);
  return 0;
}

/** Exit code: 0 for complete and partial runs (limit or budget), 1 for usage errors. */
export async function runFactsCommand(engine: BrainEngine, args: string[], config: GBrainConfig, sourceId: string): Promise<number> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(factsHelpText());
    return 0;
  }
  if (sub === 'retry-dead') return runRetryDead(engine, args.slice(1));
  if (sub !== 'relink') {
    console.error(`gbrain facts: unknown subcommand ${sub}\n\n${factsHelpText()}`);
    return 1;
  }
  const rest = args.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(factsHelpText());
    return 0;
  }
  if (rest.includes('--conversation')) return runConversation(engine, rest, config, sourceId);
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
