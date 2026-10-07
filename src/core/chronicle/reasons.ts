// Life Chronicle (#5876): the one reason table for automatic event extraction, and the
// `chronicle_backstop` write-receipt field built from it. Docs (docs/guides/life-chronicle.md)
// and tests render from CHRONICLE_REASONS; nothing else spells these codes out.
import { pricingSetCommand } from '../budget/no-pricing.ts';
import type { Action, Actor } from '../agent-output.ts';

/**
 * Where a code is decided: `decision` when
 * the page is written (receipt), `discovery` when the phase finds the page, `execution` when it judges
 * the page, `phase` for a whole run.
 */
export type ChronicleStage = 'decision' | 'discovery' | 'execution' | 'phase';

export interface ChronicleReasonContext {
  /** Omitted on brain-wide surfaces (doctor, advisor): the pointer then covers every source. */
  sourceId?: string;
  /** The day to scope a backfill pointer to (YYYY-MM-DD, compared with the page's updated date). */
  since: string;
  /** Configured chat model, for the pricing registration command. */
  model?: string;
  dailyLimit?: number;
  recentDays?: number;
}

interface ChronicleReason {
  stage: ChronicleStage;
  meaning: (ctx: ChronicleReasonContext) => string;
  fix?: (ctx: ChronicleReasonContext) => Action;
}

/**
 * The backfill pointer every surface emits. The paid form carries `--yes` (chronicle-backfill's
 * consent flag): it is the command to run after the user agrees, never before.
 */
export function chronicleBackfillArgv(opts: { sourceId?: string; since: string; limit?: number; dryRun: boolean }): string[] {
  return ['gbrain', 'chronicle-backfill', ...(opts.sourceId ? ['--source', opts.sourceId] : []),
    '--since', opts.since, '--limit', String(opts.limit ?? 50), opts.dryRun ? '--dry-run' : '--yes'];
}

/** The run-now pointer: the chronicle phase in the foreground (paid). */
export const CHRONICLE_RUN_NOW_ARGV = ['gbrain', 'dream', '--phase', 'chronicle'] as const;

const backfill = (actor: Actor, why: string) => (ctx: ChronicleReasonContext): Action => ({
  argv: chronicleBackfillArgv({ sourceId: ctx.sourceId, since: ctx.since, dryRun: false }),
  preview_argv: chronicleBackfillArgv({ sourceId: ctx.sourceId, since: ctx.since, dryRun: true }),
  consent: ['paid'], actor, why, requires_exclusive: false,
});

const FIX_BY_BACKFILL = 'Preview with the dry run, then backfill these pages if the user agrees to one paid chat call per page.';
const FIX_ON_HOST = 'Only the brain host operator can extract these pages: preview and backfill on the brain host if the user agrees to the cost.';

export const CHRONICLE_REASONS = {
  auto_chronicle_off: { stage: 'decision',
    meaning: () => 'Automatic event extraction is off on this brain by choice (`gbrain config set auto_chronicle false`).' },
  auto_chronicle_invalid: { stage: 'decision',
    meaning: () => 'auto_chronicle holds a value that is neither true nor false, so it reads as off.',
    fix: () => ({ argv: ['gbrain', 'config', 'set', 'auto_chronicle', 'true'], consent: ['paid'], actor: 'agent',
      why: 'Ask the user whether automatic extraction should be on (one paid chat call per eligible page) or off (`gbrain config set auto_chronicle false`).',
      requires_exclusive: false }) },
  slug_bound_client: { stage: 'decision',
    meaning: () => 'The writer is confined (slug-bound, delegated or namespace-restricted), so its writes never trigger extraction into life/events/.',
    fix: backfill('host_admin', FIX_ON_HOST) },
  operation_bound_client: { stage: 'decision',
    meaning: () => 'The writer\'s grant lists operations without extract_facts, the permission that covers derived extraction.',
    fix: backfill('host_admin', FIX_ON_HOST) },
  no_extract: { stage: 'decision',
    meaning: () => 'The sync ran with extraction turned off (--no-extract, or a remote sync, which never extracts).',
    fix: backfill('agent', FIX_BY_BACKFILL) },
  history: { stage: 'decision',
    meaning: (ctx) => `The page's own date is more than ${ctx.recentDays ?? 30} days old (chronicle.auto_recent_days); history is extracted only on request.`,
    fix: backfill('agent', FIX_BY_BACKFILL) },
  not_yet_happened: { stage: 'decision',
    meaning: () => 'The calendar event has not ended yet; it is picked up automatically after its end time, with no edit needed.' },
  too_short: { stage: 'decision',
    meaning: () => 'The page body is under 80 characters, too short to hold events.' },
  dream_generated: { stage: 'decision',
    meaning: () => 'Dream-generated pages are never mined for events.' },
  no_write_decision: { stage: 'discovery',
    meaning: () => 'This revision has no recorded write decision (written by an older binary or before this release activated), so only a trusted backfill extracts it.',
    fix: backfill('agent', FIX_BY_BACKFILL) },
  not_chronicle_shaped: { stage: 'decision',
    meaning: () => 'The page is no longer a meeting, conversation or calendar page, so the events extracted from it were retired.' },
  already_extracted: { stage: 'decision',
    meaning: () => 'This exact content was already extracted; its events are current, so no new call is made.' },
  superseded: { stage: 'execution',
    meaning: () => 'A newer revision replaced this content before extraction ran; the newer revision carries its own decision.' },
  daily_limit: { stage: 'execution',
    meaning: (ctx) => `The automatic daily limit (chronicle.auto_daily_limit = ${ctx.dailyLimit ?? 200} calls per rolling 24 hours) is used up; pending pages wait for a free slot.`,
    fix: (ctx) => ({ argv: ['gbrain', 'config', 'set', 'chronicle.auto_daily_limit', String((ctx.dailyLimit ?? 200) * 2)],
      consent: ['paid'], actor: 'agent', requires_exclusive: false,
      why: 'Pending pages run on their own as slots free up. Raise the limit only if the user agrees to more paid calls per day.' }) },
  judge_llm_unavailable: { stage: 'execution',
    meaning: () => 'No chat provider is configured on the brain host, so extraction cannot run.',
    fix: () => ({ consent: ['credentials'], actor: 'user', requires_exclusive: false,
      why: 'Ask the user to configure a chat provider key on the brain host (see docs/ai-providers/); pending pages run on the next cycle.' }) },
  no_pricing: { stage: 'execution',
    meaning: (ctx) => `chronicle.job_budget_usd was set explicitly, and gbrain has no price for ${ctx.model ?? 'the chat model'}, so the cap cannot be enforced.`,
    fix: (ctx) => ({ argv: ['gbrain', 'pricing', 'set', ctx.model ?? '<model>', ...pricingSetCommand('model', 'chat').split(' ').slice(4)],
      consent: [], actor: 'agent', requires_exclusive: false,
    why: 'Look up the model\'s current price and register it on the brain host; extraction retries on the next cycle.',
    inputs: [{ name: 'usd-per-1M-input-tokens', how: 'the provider pricing page' },
      { name: 'usd-per-1M-output-tokens', how: 'the provider pricing page' },
      { name: 'pricing-page-url', how: 'the URL you read the price from' }] }) },
  budget_exhausted: { stage: 'execution',
    meaning: () => 'The extraction call cost more than chronicle.job_budget_usd allows for one page.',
    fix: () => ({ argv: ['gbrain', 'config', 'set', 'chronicle.job_budget_usd', '0.50'], consent: ['paid'], actor: 'agent',
      requires_exclusive: false, why: 'Raising the per-page cap lets long pages finish; ask the user before raising spend.' }) },
  campaign_exhausted: { stage: 'execution',
    meaning: () => 'The page used every attempt its capped backfill (chronicle-backfill --max-usd) authorized without finishing, so it stops before spending more.',
    fix: (ctx) => ({ argv: chronicleBackfillArgv({ sourceId: ctx.sourceId, since: ctx.since, dryRun: true }), consent: [], actor: 'agent',
      requires_exclusive: false,
      why: 'Preview what a new backfill would queue (read-only); queuing it again is paid, so ask the user for a new --max-usd first.' }) },
  judge_chat_error: { stage: 'execution',
    meaning: () => 'The chat provider returned an error; the page retries with backoff.',
    fix: () => ({ consent: [], actor: 'provider', requires_exclusive: false,
      why: 'Wait for the retry; if it keeps failing, check the provider status and key.' }) },
  judge_truncated: { stage: 'execution',
    meaning: () => 'The extraction output hit chronicle.judge_max_tokens and was cut off, so nothing was written.',
    fix: () => ({ argv: ['gbrain', 'config', 'set', 'chronicle.judge_max_tokens', '8000'], consent: ['paid'], actor: 'agent',
      requires_exclusive: false, why: 'A higher output cap lets event-dense pages finish; ask the user before raising spend.' }) },
  judge_parse_failed: { stage: 'execution',
    meaning: () => 'The extraction output had no parseable JSON array, so nothing was written; the page retries on a later run.' },
  malformed_proposal: { stage: 'execution',
    meaning: () => 'A proposed event failed validation, so the whole batch was rejected and nothing was written; the page retries on a later run.' },
  publish_error: { stage: 'execution',
    meaning: () => 'Publishing the events failed; nothing from this attempt replaced the previous events, and the page retries on a later run.' },
  judge_refused: { stage: 'execution',
    meaning: () => 'The chat model refused or filtered the page; no events were written.' },
  page_missing: { stage: 'execution',
    meaning: () => 'The page was deleted before extraction ran.' },
  no_events: { stage: 'execution',
    meaning: () => 'Extraction read the page and found no events.' },
  future_dated: { stage: 'execution',
    meaning: () => 'Every event the extraction proposed was dated after the page\'s own day (a plan, follow-up or scheduled item), so none was written; only what happened by the end of the page\'s day becomes an event.' },
  date_imprecise: { stage: 'execution',
    meaning: () => 'Every event the extraction proposed had only a year or a month ("back in 2024"), so none was written; the timeline stores days and never invents one.' },
  no_chat_provider: { stage: 'phase',
    meaning: () => 'No chat provider is configured on the brain host, so the chronicle phase made no calls.',
    fix: () => ({ consent: ['credentials'], actor: 'user', requires_exclusive: false,
      why: 'Ask the user to configure a chat provider key on the brain host (see docs/ai-providers/); pending pages run on the next cycle.' }) },
} as const satisfies Record<string, ChronicleReason>;

export type ChronicleReasonCode = keyof typeof CHRONICLE_REASONS;

/** Eligibility reasons for pages that are not chronicle-shaped: the receipt omits the field for them. */
const NOT_CHRONICLE_SHAPED = /^(kind:|diary_excluded$|event_self$|subagent_scratch$)/;

/**
 * The write-time decision (ledger.ts `decideChronicle`): `pending` with no reason is
 * queued for the next cycle; `pending` with a reason (`not_yet_happened`) waits and reports that
 * reason like a skip; `skipped` carries its reason.
 */
export type ChronicleDecision = { state: 'pending' | 'skipped'; reason?: string | null };

export type ChronicleBackstopReceipt =
  | { pending: 'next_cycle'; daily_remaining?: number }
  | { skipped: string; stage: ChronicleStage; why: string; fix?: Action };

/**
 * The `chronicle_backstop` receipt field (sibling of `facts_backstop`). Omitted (undefined) for pages
 * that are not chronicle-shaped, so ordinary notes carry no `kind:<type>` noise. An unknown reason
 * still reports itself with a doctor pointer rather than disappearing.
 */
export function chronicleBackstopReceipt(decision: ChronicleDecision, ctx: ChronicleReasonContext & { dailyRemaining?: number }): ChronicleBackstopReceipt | undefined {
  if (!decision.reason) {
    return decision.state === 'pending'
      ? { pending: 'next_cycle', ...(ctx.dailyRemaining === undefined ? {} : { daily_remaining: ctx.dailyRemaining }) }
      : chronicleBackstopReceipt({ state: 'skipped', reason: 'unknown' }, ctx);
  }
  const reason = decision.reason;
  if (NOT_CHRONICLE_SHAPED.test(reason)) return undefined;
  const entry: ChronicleReason | undefined = (CHRONICLE_REASONS as Record<string, ChronicleReason>)[reason];
  if (!entry) {
    return { skipped: reason, stage: 'decision', why: `Extraction was skipped (${reason}).`,
      fix: { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Read the auto_chronicle check for details.' } };
  }
  const fix = entry.fix?.(ctx);
  return { skipped: reason, stage: entry.stage, why: entry.meaning(ctx), ...(fix ? { fix } : {}) };
}

function shellWord(word: string): string {
  return /^[\w.:/@+=<>-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Markdown reason table for docs/guides/life-chronicle.md (rendered with placeholder values). */
export function renderChronicleReasonTable(): string {
  const ctx: ChronicleReasonContext = { sourceId: '<source>', since: '<YYYY-MM-DD>', model: '<provider:model>', dailyLimit: 200, recentDays: 30 };
  const rows = Object.entries(CHRONICLE_REASONS).map(([code, reason]) => {
    const entry: ChronicleReason = reason;
    const fix = entry.fix?.(ctx);
    const command = fix?.argv ? `\`${fix.argv.map(shellWord).join(' ')}\`` : '—';
    const preview = fix?.preview_argv ? ` (preview: \`${fix.preview_argv.map(shellWord).join(' ')}\`)` : '';
    const consent = fix && fix.consent.length > 0 ? fix.consent.join(', ') : '—';
    return `| \`${code}\` | ${entry.stage} | ${entry.meaning(ctx)} | ${fix ? `${command}${preview}` : '—'} | ${fix?.actor ?? '—'} | ${consent} |`;
  });
  return ['| Code | Stage | Meaning | Fix | Who acts | Consent |', '|---|---|---|---|---|---|', ...rows].join('\n');
}
