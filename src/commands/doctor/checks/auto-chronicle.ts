/**
 * auto_chronicle (#5876): automatic event extraction health. On by default; the chronicle cycle
 * phase extracts pending meeting/conversation/calendar pages recorded in `chronicle_page_state`.
 * Reports the setting, 24 h use of the daily limit with the largest writer's share, 7-day outcomes
 * and spend (priced dollars, unpriced calls and missing cost records apart), and the command that
 * runs pending pages now. `auto_chronicle_default_on` stays visible (info) until the operator
 * answers the default-on change with `gbrain config set auto_chronicle true|false`.
 * Config-plane only: no provider calls.
 */
import {
  AUTO_CHRONICLE_KEEP_ARGV, AUTO_CHRONICLE_OPT_OUT_ARGV, CHRONICLE_NUMERIC_KEYS, autoChronicleNeedsAcknowledgement,
  autoChronicleSetting, chronicleSettings,
} from '../../../core/chronicle/config.ts';
import { describeChronicleActivity, readChronicleDuplicateEvents, readChronicleLedgerStats } from '../../../core/chronicle/ledger-stats.ts';
import { CHRONICLE_REASONS, CHRONICLE_RUN_NOW_ARGV, chronicleBackfillArgv } from '../../../core/chronicle/reasons.ts';
import type { Action } from '../../../core/agent-output.ts';
import type { ReadinessState } from '../../../core/readiness.ts';
import type { Check } from '../../doctor.ts';
import { doctorVerify, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

export const AUTO_CHRONICLE_DOCS = 'docs/guides/life-chronicle.md';

const command = (argv: readonly string[]) => argv.join(' ');
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

async function chatAvailable(): Promise<boolean> {
  try {
    const { isAvailable } = await import('../../../core/ai/gateway.ts');
    return isAvailable('chat');
  } catch {
    return false;
  }
}

function warn(code: string, message: string, fix: Action, extra: Record<string, unknown> & { readiness?: ReadinessState } = {}): Omit<Check, 'name'> {
  return { status: 'warn', message, fix, ...(extra.readiness ? { readiness_state: extra.readiness } : {}),
    details: { code, ...extra, fix, ...(fix.argv ? { fix_hint: command(fix.argv) } : {}), docs: AUTO_CHRONICLE_DOCS } };
}

/** The two answers to the default-on change; keeping it is the paid choice. */
const KEEP_FIX: Action = { argv: [...AUTO_CHRONICLE_KEEP_ARGV], consent: ['paid', 'egress'], actor: 'agent', requires_exclusive: false,
  why: 'Keeping automatic extraction records that the user accepted one paid chat call per eligible page; page text goes to the chat provider.',
  user_message: 'Automatic event extraction is on: each new or changed meeting, conversation or calendar page gets one paid chat call. Keep it on, or turn it off?',
  verify: doctorVerify('auto_chronicle_default_on') };
/** Off by choice: the enable command, information only (turning it on is paid; ask first). */
const ENABLE_FIX: Action = { argv: [...AUTO_CHRONICLE_KEEP_ARGV], consent: ['paid', 'egress'], actor: 'agent', requires_exclusive: false,
  why: 'Turns automatic event extraction back on: one paid chat call per eligible new or changed page, page text sent to the chat provider.',
  verify: doctorVerify('auto_chronicle') };
const OPT_OUT_FIX: Action = { argv: [...AUTO_CHRONICLE_OPT_OUT_ARGV], consent: [], actor: 'agent', requires_exclusive: false,
  why: 'Turns automatic extraction off; history stays available on request with chronicle-backfill.',
  verify: doctorVerify('auto_chronicle_default_on') };

async function runAutoChronicle(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const raw = await engine.getConfig('auto_chronicle');
  const setting = autoChronicleSetting(raw);
  const settings = await chronicleSettings(engine);
  const checks: Check[] = [];
  const backfillPreview = command(chronicleBackfillArgv({ since: daysAgo(30), dryRun: true }));

  if (setting === 'invalid') {
    checks.push({ name: 'auto_chronicle', ...warn('auto_chronicle_invalid',
      `auto_chronicle is '${raw}', which is neither true nor false, so automatic event extraction is off. ` +
      `Ask the user which they want, then run \`${command(AUTO_CHRONICLE_KEEP_ARGV)}\` or \`${command(AUTO_CHRONICLE_OPT_OUT_ARGV)}\`.`,
      CHRONICLE_REASONS.auto_chronicle_invalid.fix(), { enabled: false, readiness: 'degraded' }) });
  } else if (setting === 'off') {
    checks.push(infoCheck('auto_chronicle',
      `auto_chronicle is off by choice. History stays available on request (paid; ask the user first): \`${backfillPreview}\`.`,
      'disabled_by_choice', ENABLE_FIX, { enabled: false, severity: 'info', readiness: 'disabled_by_choice', docs: AUTO_CHRONICLE_DOCS }));
  } else {
    const stats = await readChronicleLedgerStats(engine);
    const chat = await chatAvailable();
    const activity = stats.available ? describeChronicleActivity(stats, settings.dailyLimit)
      : 'The chronicle ledger is not created yet; run `gbrain apply-migrations --yes --no-autopilot-install`.';
    const summary = { enabled: true, source: raw == null ? 'default' : 'explicit', daily_limit: settings.dailyLimit,
      job_budget_usd: settings.jobBudgetUsd, ledger_available: stats.available, pending: stats.pending,
      auto_calls_24h: stats.autoCalls24h, principals_24h: stats.principals24h, last_7d: stats.last7d, spend_7d: stats.spend7d,
      chat_available: chat, run_now: [...CHRONICLE_RUN_NOW_ARGV] };
    const failures = Object.entries(stats.last7d.failedReasons).filter(([reason]) => reason in CHRONICLE_REASONS);
    if (!chat && stats.pending > 0) {
      checks.push({ name: 'auto_chronicle', ...warn('judge_llm_unavailable',
        `auto_chronicle is on, but no chat provider is configured, so ${stats.pending} pending page(s) cannot be extracted. ${activity} ` +
        'Ask the user to configure a chat provider key on the brain host; pending pages run on the next cycle.',
        CHRONICLE_REASONS.judge_llm_unavailable.fix(), { ...summary, readiness: 'missing' }) });
    } else if (stats.last7d.failed > 0 && failures.length > 0) {
      const [reason] = failures[0];
      const entry = CHRONICLE_REASONS[reason as keyof typeof CHRONICLE_REASONS];
      const ctxFix = { since: daysAgo(7), dailyLimit: settings.dailyLimit, recentDays: settings.recentDays };
      const fix: Action = ('fix' in entry ? entry.fix(ctxFix) : undefined)
        ?? { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Re-check after the next cycle.' };
      checks.push({ name: 'auto_chronicle', ...warn(reason,
        `auto_chronicle is on; ${stats.last7d.failed} automatic extraction(s) failed in 7 days, most often ${reason}: ${entry.meaning(ctxFix)} ${activity}`,
        fix, { ...summary, readiness: 'degraded' }) });
    } else {
      const limited = stats.pending > 0 && stats.autoCalls24h >= settings.dailyLimit
        ? ' The daily limit is used up, so pending pages wait for a free slot; raising chronicle.auto_daily_limit needs the user\'s agreement.' : '';
      const runNow = stats.pending > 0 && !limited
        ? ` Pending pages run in the next autopilot cycle; to run them now: \`${command(CHRONICLE_RUN_NOW_ARGV)}\` (paid).` : limited;
      const noChat = chat ? '' : ' No chat provider is configured, so nothing will be extracted until one is.';
      const readiness: ReadinessState = chat ? 'ok' : 'missing';
      checks.push({ name: 'auto_chronicle', status: 'ok', readiness_state: readiness,
        message: `auto_chronicle is on${raw == null ? ' (default)' : ''}. ${activity}${runNow}${noChat}`,
        details: { ...summary, severity: 'info', readiness, docs: AUTO_CHRONICLE_DOCS } });
    }
  }

  if (settings.invalid.length > 0) {
    const first = settings.invalid[0];
    checks.push({ name: 'chronicle_config_invalid', ...warn('chronicle_config_invalid',
      `${settings.invalid.map((i) => `${i.key}='${i.raw}'`).join(', ')} ${settings.invalid.length === 1 ? 'is' : 'are'} out of range, so the default ` +
      `${settings.invalid.length === 1 ? 'applies' : 'apply'} (${settings.invalid.map((i) => `${i.key}=${i.fallback}`).join(', ')}). ` +
      `Set a valid value, for example \`gbrain config set ${first.key} ${first.fallback}\`.`,
      { argv: ['gbrain', 'config', 'set', first.key, String(first.fallback)], consent: [], actor: 'agent', requires_exclusive: false,
        why: `${first.key}: ${CHRONICLE_NUMERIC_KEYS[first.key].meaning}.` },
      { invalid: settings.invalid }) });
  } else {
    checks.push({ name: 'chronicle_config_invalid', status: 'ok', message: 'chronicle.* settings are valid.' });
  }

  const duplicates = await readChronicleDuplicateEvents(engine);
  if (duplicates.pages > 0) {
    checks.push(infoCheck('chronicle_duplicate_events',
      `${duplicates.pages} meeting or conversation page(s) hold ${duplicates.surplus} live event(s) from earlier extraction runs that their newest extraction did not produce. ` +
        'Most are reworded copies an earlier release added each time it re-read a long page (#8972); this release no longer adds them. ' +
        'Nothing is changed automatically; a preview-first repair is tracked in https://github.com/garrytan/gbrain/issues/9012.',
      'ok', undefined, { code: 'chronicle_duplicate_events', severity: 'info', pages: duplicates.pages, surplus_events: duplicates.surplus, docs: AUTO_CHRONICLE_DOCS }));
  } else {
    checks.push({ name: 'chronicle_duplicate_events', status: 'ok', message: 'No page holds live events from an earlier extraction run beside its newest one.' });
  }

  if (await autoChronicleNeedsAcknowledgement(engine)) {
    const ceiling = settings.dailyLimit * settings.jobBudgetUsd;
    checks.push(infoCheck('auto_chronicle_default_on',
      'Automatic event extraction is on by default and the user has not confirmed it yet. ' +
        `Each eligible new or changed meeting, conversation or calendar page gets one paid chat call (cap $${settings.jobBudgetUsd.toFixed(2)} per page; ` +
        `at most ${settings.dailyLimit} calls per day, so at most $${ceiling.toFixed(2)} per day for a priced model; an unpriced model has no cap), ` +
        'and page text goes to the configured chat provider. Relay this to the user, then run ' +
        `\`${command(AUTO_CHRONICLE_KEEP_ARGV)}\` to keep it or \`${command(AUTO_CHRONICLE_OPT_OUT_ARGV)}\` to opt out.`,
      'ok', KEEP_FIX,
      { code: 'auto_chronicle_default_on', severity: 'info', ask_user: true, docs: AUTO_CHRONICLE_DOCS, fix: KEEP_FIX,
        decisions: [{ id: 'keep', label: 'Keep automatic extraction on', argv: [...AUTO_CHRONICLE_KEEP_ARGV], fix: KEEP_FIX },
          { id: 'opt_out', label: 'Turn automatic extraction off', argv: [...AUTO_CHRONICLE_OPT_OUT_ARGV], fix: OPT_OUT_FIX }],
        default: 'keep' }));
  } else {
    checks.push({ name: 'auto_chronicle_default_on', status: 'ok', message: 'The auto_chronicle setting is confirmed.' });
  }
  return checks;
}

export const autoChronicleEntry: DoctorEntry = {
  name: 'auto_chronicle',
  emits: ['auto_chronicle', 'chronicle_config_invalid', 'chronicle_duplicate_events', 'auto_chronicle_default_on'],
  run: runAutoChronicle,
};
