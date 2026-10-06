/**
 * `gbrain decide`: System One operator surface (local CLI only; thin clients
 * refuse). Every slot is `off` or `on`; `--shadow` is advanced diagnostics.
 *
 *   status [--json] [--egress]        provider, consent, budget, per-slot readiness
 *   probe [--query <q>] [--yes]       key-only live probe; --query previews S1+S3
 *   enable <slot> [--provider <id>] [--shadow] [--yes] | enable --recommended
 *   disable <slot> | --all
 *   calibrate / qualify / calibrations / dataset   (src/commands/decide/calibrate.ts)
 *   receipts [--slot <slot>] [--since <h>] [--what-if-threshold <t>]  (decide/receipts.ts)
 *
 * Slot lanes add subcommands (proposals, sweep; judge-agreement from decide/eval-lane.ts) through
 * `registerDecideSubcommand`.
 */
import type { BrainEngine } from '../core/engine.ts';
import { loadConfigSnapshot } from '../core/config-snapshot.ts';
import { configureGateway, configureGatewayIfUninitialized, requireConfig } from '../core/ai/gateway.ts';
import { buildGatewayConfig } from '../core/ai/build-gateway-config.ts';
import { typesafeApiKey } from '../core/ai/recipes/typesafe.ts';
import {
  DEFAULT_TYPESAFE_PROVIDER, isTypesafeAlias, isValidProvider, providerKind, readDecideConfig, type DecideConfig,
} from '../core/ai/decide/config.ts';
import { runDecide } from '../core/ai/decide/index.ts';
import { estimateContextTokens, packShape, planBatches } from '../core/ai/decide/pack.ts';
import { KEY_DEFAULT_LABEL, keyDefaultOptOut, readiness, resolveSlotPolicy, type PolicyInputs, type SlotPolicy } from '../core/ai/decide/policy.ts';
import { REFERENCE_CALIBRATIONS, recommendedSlots } from '../core/ai/decide/reference-calibrations.ts';
import { REFUSAL_CATALOG, SLOT_PLAIN_NAMES, refusalLine } from '../core/ai/decide/outcomes.ts';
import { toWireQuestion } from '../core/ai/decide/providers/typesafe.ts';
import { SLOT_SPECS } from '../core/ai/decide/slots.ts';
import {
  conflictNoEntityShare, dailySpend, deleteDecideState, flushDecideWrites, getDecideState, listCalibrations, recentResolvedModels, setDecideState,
  slotUsage, type CalibrationRow,
} from '../core/ai/decide/store.ts';
import { DECIDE_SLOTS, DecideError, EVIDENCE_CLASSES, type DecideQuestion, type DecideSlot } from '../core/ai/decide/types.ts';
import { usageCostUsd } from '../core/budget/reservation-cost.ts';
import { evidenceCoPackedSlots, resetDecideSearchCache } from '../core/search/decide-stage.ts';
import { currentExitCode } from '../core/cli-force-exit.ts';
import { consentGate, engineConsentEnv } from '../core/consent-cli.ts';

export const DECIDE_HELP = `Usage: gbrain decide <subcommand> [options]

System One decision support (TypeSafe Jev or an llm: provider). Each slot is off
or on. Without a TypeSafe key every slot is off; with one, the slots with a measured
win (the enable --recommended set) are on by default until you set them yourself.
Runs on the brain host (local CLI only).

Subcommands:
  status [--json] [--egress]                 Provider, consent, budget and per-slot readiness
  probe [--query <q>] [--yes] [--json]       Live probe with only a key; --query previews rerank
                                             and the evidence gate on your brain (changes nothing)
  enable <slot> [--provider <id>] [--yes] [--json]
                                             Turn a slot on (writes provider, consent and mode)
  enable --recommended [--yes]               Turn on the slots with a recorded win
  enable <slot> --shadow                     Advanced diagnostics: receipts only, no behavior change
  disable <slot> | --all                     Turn a slot (or every slot) off
  calibrate --slot <slot> --dataset <jsonl> [--target precision|recall|f1] [--min <x>]
            [--call-site <site>] [--dry-run] [--json]
  qualify --slot <slot> --dataset <jsonl> [--call-site <site>] [--json]
  calibrations list [--slot <slot>] [--json] | adopt <id> | retire <id> | restore <id>
  dataset --slot <slot> --from <source> <path> [--out <file>]
  receipts [--slot <slot>] [--since <hours>] [--what-if-threshold <t>] [--json]

Slots: ${DECIDE_SLOTS.map((s) => `${s} (${SLOT_PLAIN_NAMES[s]})`).join(', ')}
Docs: docs/guides/system-one.md, docs/architecture/decide.md
`;

export type DecideSubcommand = (engine: BrainEngine, args: string[]) => Promise<number>;
const extraSubcommands = new Map<string, { run: DecideSubcommand; help: string }>();

/** Slot lanes register subcommands (proposals, sweep, judge-agreement) here. */
export function registerDecideSubcommand(name: string, run: DecideSubcommand, help: string): void {
  extraSubcommands.set(name, { run, help });
}

/** Slot lanes register subcommands, what-if reducers and dataset adapters when their module loads. */
export async function loadDecideLanes(): Promise<void> {
  await import('./decide/writepath.ts');
  await import('./decide/eval-lane.ts');
}

export function decideHelpText(): string {
  const extra = [...extraSubcommands.entries()].map(([, v]) => `  ${v.help}`).join('\n');
  return extra ? `${DECIDE_HELP}\nMore subcommands:\n${extra}\n` : DECIDE_HELP;
}

export function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
}

const has = (args: string[], flag: string) => args.includes(flag);

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

export interface DecideState {
  cfg: DecideConfig;
  snapshot: Record<string, string>;
  calibrations: CalibrationRow[];
  lastResolved: Record<string, string>;
  key: { present: boolean; from: string | null };
  rerankerModel: string;
  rerankerEnabled: boolean;
  searchMode: string;
}

export async function loadDecideState(engine: BrainEngine): Promise<DecideState> {
  const snapshot = (await loadConfigSnapshot(engine)) ?? {};
  const [calibrations, recent] = await Promise.all([listCalibrations(engine, { includeRetired: true }), recentResolvedModels(engine, 24 * 7)]);
  const lastResolved: Record<string, string> = {};
  for (const r of recent) lastResolved[r.provider] ??= r.model_resolved;
  let env: Record<string, string | undefined> = process.env;
  try { env = requireConfig().env; } catch { /* unconfigured gateway: process env */ }
  const key = typesafeApiKey(env);
  const cfg = readDecideConfig(snapshot, { typesafeKey: key !== null });
  const { loadSearchModeConfig, resolveSearchMode } = await import('../core/search/mode.ts');
  const modeInput = await loadSearchModeConfig(engine);
  const knobs = resolveSearchMode({ mode: modeInput.mode, overrides: modeInput.overrides });
  return {
    cfg, snapshot, calibrations: calibrations.filter((c) => !c.retired_at), lastResolved,
    key: { present: key !== null, from: key?.from ?? null },
    rerankerModel: knobs.reranker_model, rerankerEnabled: knobs.reranker_enabled, searchMode: knobs.resolved_mode,
  };
}

export function slotPackShape(slot: DecideSlot, cfg: DecideConfig): string {
  if (slot === 'injection') return packShape('evidence', [...evidenceCoPackedSlots(cfg), 'injection']);
  return slot === 'evidence' ? packShape('evidence', evidenceCoPackedSlots(cfg)) : packShape(slot, [], { unpacked: ['answerable', 'triage', 'grounding'].includes(slot) });
}

export function policyInputs(state: DecideState, slot: DecideSlot, cfg = state.cfg, callSite?: string): PolicyInputs {
  return {
    cfg, slot, callSite, packShape: slotPackShape(slot, cfg), calibrations: state.calibrations, lastResolved: state.lastResolved,
    hasTypesafeKey: state.key.present, rerankerModel: state.rerankerEnabled ? state.rerankerModel : undefined,
  };
}

export function policyFor(state: DecideState, slot: DecideSlot, cfg = state.cfg): SlotPolicy {
  return resolveSlotPolicy(policyInputs(state, slot, cfg));
}

/** `requested: <mode> / effective: <mode> / cause: <reason> (<values>) / fix: <command> / docs: <anchor>` */
export function effectiveModeLine(p: SlotPolicy): string | null {
  if (p.requested === p.effective && !p.inactive) return null;
  const entry = REFUSAL_CATALOG[p.inactive ?? ''];
  const cause = entry ? `${p.inactive} (${entry.cause})` : p.inactive ?? 'unknown';
  const fix = entry ? entry.fix.replaceAll('<slot>', p.slot) : 'gbrain decide status';
  return `${p.slot}: requested: ${p.requested} / effective: ${p.effective} / cause: ${cause} / fix: ${fix} / docs: docs/guides/system-one.md${entry?.anchor ?? ''}`;
}

/** Post-set hook for `gbrain config set decide.slots.<slot>.*`. */
export async function printEffectiveModeLines(engine: BrainEngine, slot?: string): Promise<void> {
  if (!slot || !(DECIDE_SLOTS as readonly string[]).includes(slot)) return;
  const state = await loadDecideState(engine);
  const line = effectiveModeLine(policyFor(state, slot as DecideSlot));
  if (line) console.log(line);
}

const TYPICAL_CANDIDATE = 'x'.repeat(1200);
const CLASS_TEXT: Record<string, string> = { query: 'query text', candidates: 'candidate text', facts: 'fact text', conversation: 'conversation text' };
const COST_UNITS: Partial<Record<DecideSlot, { unit: string; questions: number; unpacked?: boolean }>> = {
  rerank: { unit: 'queries', questions: 30 },
  evidence: { unit: 'queries', questions: 20 },
  recall_needed: { unit: 'turns', questions: 1 },
  triage: { unit: 'transcripts', questions: 20, unpacked: true },
  grounding: { unit: 'dream pages', questions: 10, unpacked: true },
  conflict: { unit: 'swept facts', questions: 5 },
};

/** Estimated USD per 1,000 units: from the last 24 h of receipts, else the planner estimate for a typical input. */
function costPer1k(slot: DecideSlot, provider: string, usage?: { decisions: number; input_tokens: number }): { usd: number | null; basis: 'receipts' | 'estimate' | 'n/a' } {
  if (providerKind(provider) !== 'typesafe') return { usd: null, basis: 'n/a' };
  if (usage && usage.decisions > 0) return { usd: (usageCostUsd(provider, usage.input_tokens / usage.decisions, 0, 'decide') ?? 0) * 1000, basis: 'receipts' };
  const typical = COST_UNITS[slot];
  if (!typical) return { usd: null, basis: 'n/a' };
  const q: DecideQuestion = { id: 'q', kind: 'noul', instructions: 'Typical question about `candidate`.', inputs: { candidate: { text: TYPICAL_CANDIDATE, class: 'candidates' } } };
  const tokens = typical.unpacked
    ? typical.questions * planBatches(estimateContextTokens({}), [estimateContextTokens(toWireQuestion(q))])[0]!.estimatedInputTokens
    : planBatches(estimateContextTokens({ query: 'a typical question' }), Array.from({ length: typical.questions }, () => estimateContextTokens(toWireQuestion(q))))
      .reduce((n, b) => n + b.estimatedInputTokens, 0);
  return { usd: (usageCostUsd(provider, tokens, 0, 'decide') ?? 0) * 1000, basis: 'estimate' };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function buildStatus(engine: BrainEngine, state: DecideState) {
  const [spend, usage, noEntity, reviewRates] = await Promise.all([
    dailySpend(engine).catch(() => ({ total: 0, remote: 0 })), slotUsage(engine, 24).catch(() => []),
    conflictNoEntityShare(engine).catch(() => ({ skipped: 0, receipts: 0, share: 0 })),
    import('../core/ai/decide/review-lane.ts').then(m => m.proposalReviewRates(engine)).catch(() => []),
  ]);
  const slots = DECIDE_SLOTS.map((slot) => {
    const p = policyFor(state, slot);
    const u = usage.find((x) => x.slot === slot);
    const inputs = policyInputs(state, slot);
    const newestRef = REFERENCE_CALIBRATIONS.filter((r) => r.slot === slot && r.provider === p.provider).at(-1);
    return {
      slot, plain: SLOT_PLAIN_NAMES[slot], wired: SLOT_SPECS[slot].wired, mode: p.requested, effective: p.effective,
      readiness: readiness(p, inputs), inactive: p.inactive ?? null, provider: p.provider, model: p.model,
      threshold: p.threshold ?? null, threshold_source: p.thresholdSource, calibration: p.calibration?.ref ?? null,
      min_keep: SLOT_SPECS[slot].thresholded ? p.minKeep : null, force_on: p.forceOn,
      newer_reference: newestRef && p.calibration && `ref:${newestRef.id}` !== p.calibration.ref ? `ref:${newestRef.id}` : null,
      receipts_24h: u?.rows ?? 0, decisions_24h: u?.decisions ?? 0, errors_24h: u?.errors ?? 0,
      error_rate_24h: u && u.rows > 0 ? Number((u.errors / u.rows).toFixed(4)) : 0, egress_refusals_24h: u?.egress ?? 0,
      status: !u || u.rows === 0 ? 'pending' : u.skipped === u.rows ? (p.inactive ? 'demoted' : 'blocked') : 'active',
      cost_per_1k: { ...costPer1k(slot, p.provider, u), unit: COST_UNITS[slot]?.unit ?? 'units' },
      effective_line: effectiveModeLine(p),
      ...(state.cfg.slots[slot].keyDefault ? { key_default: true, opt_out: keyDefaultOptOut(slot) } : {}),
      ...(slot === 'conflict' ? { no_entity_7d: noEntity, proposal_review: reviewRates } : {}),
    };
  });
  return {
    provider: state.cfg.provider, provider_pinned: state.cfg.provider !== 'none' && !isTypesafeAlias(state.cfg.provider),
    key: state.key,
    egress: {
      private: state.cfg.egressPrivate, fallback: state.cfg.egressFallback, deny_sources: state.cfg.denySources,
      consent: Object.fromEntries(EVIDENCE_CLASSES.map((c) => [c, state.cfg.consent[c] ? 'allow' : 'deny'])),
    },
    budget: {
      daily_usd: state.cfg.dailyUsd, spent_today_usd: Number(spend.total.toFixed(6)), remote_today_usd: Number(spend.remote.toFixed(6)),
      remote_share: state.cfg.remoteShare,
      excluded: ['S1 on: reranker spend controls (BudgetKind rerank)', 'llm: providers: chat spend controls (BudgetKind chat)'],
    },
    reranker: {
      model: state.rerankerModel, enabled: state.rerankerEnabled, search_mode: state.searchMode,
      jev_called: state.rerankerEnabled && state.rerankerModel.startsWith('typesafe:') ? 'yes (reranker)' : state.cfg.slots.rerank.mode === 'shadow' ? 'shadow' : 'no',
      credential: state.key.from,
    },
    slots,
  };
}

async function cmdStatus(engine: BrainEngine, args: string[]): Promise<number> {
  const state = await loadDecideState(engine);
  const status = await buildStatus(engine, state);
  if (has(args, '--json')) {
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }
  console.log(`System One (decide): provider ${status.provider}${status.provider !== 'none' && !status.provider_pinned ? ' (alias: pin with gbrain decide enable <slot>)' : ''}; key: ${state.key.from ?? 'not set'}`);
  const keyDefaults = status.slots.filter((s) => s.key_default).map((s) => `${s.slot} (${SLOT_SPECS[s.slot].egressClasses.join(', ')})`);
  console.log(`egress: private=${status.egress.private}; consent ${EVIDENCE_CLASSES.map((c) => `${c}=${status.egress.consent[c]}`).join(' ')}; deny_sources: ${status.egress.deny_sources.join(',') || 'none'}; fallback: ${status.egress.fallback}${keyDefaults.length ? `; key default allows: ${keyDefaults.join(', ')}` : ''}`);
  console.log(`budget: $${status.budget.spent_today_usd.toFixed(4)} of $${status.budget.daily_usd.toFixed(2)} today (remote $${status.budget.remote_today_usd.toFixed(4)}, cap ${Math.round(status.budget.remote_share * 100)}%); not covered: ${status.budget.excluded.join('; ')}`);
  console.log(`reranker: ${status.reranker.model} (${status.reranker.enabled ? 'enabled' : 'disabled'}, mode ${status.reranker.search_mode}); Jev called: ${status.reranker.jev_called}`);
  console.log('');
  for (const s of status.slots) {
    const threshold = s.threshold === null ? '' : ` threshold ${s.threshold.toFixed(3)} (${s.threshold_source}${s.calibration ? ` ${s.calibration}` : ''})`;
    const cost = s.cost_per_1k.usd === null ? '' : ` ~$${s.cost_per_1k.usd.toFixed(4)}/1k ${s.cost_per_1k.unit} (${s.cost_per_1k.basis})`;
    const activity = s.receipts_24h > 0 ? ` 24h: ${s.decisions_24h} decisions, ${(s.error_rate_24h * 100).toFixed(1)}% errors` : '';
    console.log(`  ${s.slot.padEnd(14)} ${s.readiness}${threshold}${cost}${activity}${s.wired ? '' : ' (not available in this build)'}`);
    if (s.force_on) console.log(`    WARN: decide.slots.${s.slot}.force_on bypasses the action-precision gate`);
    if (s.newer_reference) console.log(`    newer reference available: ${s.newer_reference} (gbrain decide calibrations adopt ${s.newer_reference})`);
    if (s.no_entity_7d && s.no_entity_7d.skipped > 0) {
      console.log(`    ${(s.no_entity_7d.share * 100).toFixed(1)}% of conflict receipts in 7 days (${s.no_entity_7d.skipped} of ${s.no_entity_7d.receipts}) skipped a fact with no entity (no_entity); link them: gbrain facts relink --dry-run`);
    }
    for (const r of s.proposal_review ?? []) {
      if (!r.enabled && r.pending === 0) continue;
      console.log(`    ${r.kind} proposals: ${r.pending} pending${r.oldest_pending_days !== null ? ` (oldest ${r.oldest_pending_days} days)` : ''}; last 30 days: ${r.accepted_30d} accepted, ${r.rejected_30d} rejected${r.pending > 0 ? ' (review: gbrain decide proposals list)' : ''}`);
    }
    if (s.opt_out) console.log(`    on by default because a TypeSafe key is present (sends ${SLOT_SPECS[s.slot].egressClasses.map((c) => CLASS_TEXT[c]).join(', ')} to TypeSafe); opt out: ${s.opt_out}`);
  }
  const lines = status.slots.map((s) => s.effective_line).filter(Boolean);
  if (lines.length) { console.log(''); for (const l of lines) console.log(l); }
  if (has(args, '--egress')) {
    console.log('\nprovider x data class (the key that decides each cell):');
    for (const c of EVIDENCE_CLASSES) {
      const typesafe = status.egress.consent[c] === 'allow' ? `allow (decide.egress.typesafe.${c})` : `deny (decide.egress.typesafe.${c})`;
      const priv = c === 'query' ? '' : `; private content: ${status.egress.private} (decide.egress.private)`;
      console.log(`  ${c.padEnd(13)} typesafe: ${typesafe}${priv}; llm: chat egress rules; reranker (S1 on): ${c === 'query' || c === 'candidates' ? 'search.reranker.model' : 'n/a'}`);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

const PROBE_QUESTIONS: DecideQuestion[] = [
  { id: 'probe_p', kind: 'noul', instructions: 'Does `note` state a decision?', inputs: { note: { text: 'We decided to ship the beta on Friday.', class: 'query' } } },
  { id: 'probe_c', kind: 'choice', instructions: 'What kind of statement is `note`?', options: { decision: 'a decision', question: 'a question', other: 'anything else' }, inputs: { note: { text: 'We decided to ship the beta on Friday.', class: 'query' } } },
];

export function ensureGatewayForProbe(): void {
  configureGatewayIfUninitialized();
  try { requireConfig(); } catch { configureGateway(buildGatewayConfig({ engine: 'pglite' } as Parameters<typeof buildGatewayConfig>[0])); }
}

export async function cmdProbe(engine: BrainEngine | null, args: string[]): Promise<number> {
  ensureGatewayForProbe();
  const json = has(args, '--json');
  const key = typesafeApiKey(requireConfig().env);
  if (!key) { console.error(refusalLine('no_key')); return 1; }
  const cfg = engine ? readDecideConfig((await loadConfigSnapshot(engine)) ?? {}) : readDecideConfig(null);
  const provider = cfg.provider.startsWith('typesafe:') ? cfg.provider : DEFAULT_TYPESAFE_PROVIDER;
  const query = flagValue(args, '--query');
  if (query) {
    if (!engine) { console.error('probe --query needs a brain: run it on the brain host.'); return 1; }
    const { runProbeQuery } = await import('./decide/probe-query.ts');
    return runProbeQuery(engine, cfg, provider, query, args);
  }
  const consentCfg = { ...cfg, consent: { ...cfg.consent, query: true } };
  try {
    const r = await runDecide({ slot: 'evidence', callSite: 'probe', state: {}, questions: PROBE_QUESTIONS, provider, deadlineMs: 10_000, lane: 'background' }, { engine: null, config: consentCfg });
    const out = {
      requested: provider, model_resolved: r.model_resolved, latency_ms: r.latency_ms, input_tokens: r.usage.input_tokens,
      cost_usd: Number(r.cost_usd.toFixed(8)), key_from: key.from, brain_content_sent: false,
      answers: r.answers, next: 'gbrain decide probe --query "<a question your brain can answer>"',
    };
    if (json) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`TypeSafe Jev probe: resolved ${r.model_resolved} (requested ${provider}) in ${r.latency_ms} ms, ${r.usage.input_tokens} input tokens, $${r.cost_usd.toFixed(6)}.`);
      console.log(`Key: ${key.from}. No brain content was sent.`);
      console.log(`Next: ${out.next}`);
    }
    return 0;
  } catch (err) {
    const reason = err instanceof DecideError ? err.reason : 'provider_error';
    console.error(`probe failed: ${refusalLine(reason)}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// enable / disable
// ---------------------------------------------------------------------------

const RERANK_OWNERSHIP_KEY = 'rerank.ownership';
/** Refusals that keep `enable` from writing anything (effective could not be on). */
const ENABLE_REFUSALS = new Set(['slot_unavailable', 'no_provider', 'no_key', 'no_calibration', 'no_qualification', 'action_precision_low', 'policy_changed', 'pack_shape_mismatch', 'llm_capability']);
const PRIVATE_SLOTS: readonly DecideSlot[] = ['recall_needed', 'triage', 'grounding', 'conflict'];

async function resolvePinned(provider: string): Promise<string> {
  if (!isTypesafeAlias(provider)) return provider;
  const r = await runDecide({ slot: 'evidence', callSite: 'probe', state: {}, questions: [PROBE_QUESTIONS[0]!], provider, deadlineMs: 10_000, lane: 'background' },
    { engine: null, config: { ...readDecideConfig(null), consent: { query: true, candidates: false, facts: false, conversation: false } } });
  return `typesafe:${r.model_resolved}`;
}

/**
 * A4 consent for turning a slot on: text leaves the machine (`egress`) and the
 * provider bills per call (`paid`, bounded by decide.budget.daily_usd). `--yes`
 * authorizes; `--json` never does. Resolves false after printing the refusal
 * (exit verdict 3) or a declined prompt.
 */
async function enableConsent(engine: BrainEngine, args: string[], req: { slots: DecideSlot[]; summary: string[]; dailyUsd: number; argv: string[] }): Promise<boolean> {
  const json = has(args, '--json');
  for (const line of req.summary) (json ? console.error : console.log)(line);
  const what = req.slots.length === 1 ? `Turn on the decide slot ${req.slots[0]}` : `Turn on the decide slots ${req.slots.join(', ')}`;
  const auth = await consentGate({
    command: 'decide enable',
    effects: ['egress', 'paid'],
    actor: 'agent',
    what,
    why: 'System One answers these routing and ranking questions with a hosted model instead of local heuristics; each slot is a measured win on the eval sets.',
    risk: `From now on, brain text named in the summary leaves this machine on every affected call, and the provider bills per call up to decide.budget.daily_usd ($${req.dailyUsd.toFixed(2)}/day). `
      + 'Undo any time: gbrain decide disable --all.',
    user_message: `${what}? Some of your brain's text (${req.summary.find(l => l.startsWith('Data that leaves')) ?? 'see the summary'}) will be sent to the provider on each call, capped at $${req.dailyUsd.toFixed(2)} a day; gbrain decide disable --all turns it off.`,
    argv: req.argv,
    preview_argv: ['gbrain', 'decide', 'status', '--json'],
    est_usd: null,
    args,
  }, { json, env: engineConsentEnv(engine, { configuredCapUsd: req.dailyUsd }) });
  return auth !== null;
}

async function writeConfig(engine: BrainEngine, writes: Array<[string, string]>): Promise<void> {
  for (const [k, v] of writes) await engine.setConfig(k, v);
  resetDecideSearchCache();
}

async function enableRerank(engine: BrainEngine, state: DecideState, provider: string, args: string[]): Promise<Array<[string, string]>> {
  const pinned = provider.startsWith('typesafe:') ? provider : DEFAULT_TYPESAFE_PROVIDER;
  const owned = await getDecideState(engine, RERANK_OWNERSHIP_KEY);
  if (!owned) {
    const previous = { model: state.snapshot['search.reranker.model'] ?? null, enabled: state.snapshot['search.reranker.enabled'] ?? null };
    await setDecideState(engine, RERANK_OWNERSHIP_KEY, JSON.stringify({ previous, wrote: { model: pinned, enabled: 'true' } }));
  }
  if (state.searchMode === 'conservative' && !state.snapshot['search.reranker.enabled']) {
    console.log('WARN: search mode is conservative, which disables reranking; decide enable rerank sets search.reranker.enabled true.');
  }
  void args;
  return [['search.reranker.model', pinned], ['search.reranker.enabled', 'true']];
}

async function conflictShareLine(engine: BrainEngine, fate: string): Promise<string> {
  const share = await (await import('../core/ai/decide/proposals-store.ts')).privateFactShare(engine);
  return `Facts: ${share.private} of ${share.total} active facts are private and ${fate}; an llm: route (decide.slots.conflict.provider llm:<provider:model>) keeps them with your chat provider.`;
}

async function cmdEnable(engine: BrainEngine, args: string[]): Promise<number> {
  const json = has(args, '--json');
  const state = await loadDecideState(engine);
  if (has(args, '--recommended')) return enableRecommended(engine, state, args);
  const slot = args.find((a) => !a.startsWith('--') && a !== 'enable' && a !== flagValue(args, '--provider')) as DecideSlot | undefined;
  if (!slot || !(DECIDE_SLOTS as readonly string[]).includes(slot)) { console.error(`Usage: gbrain decide enable <slot>. Slots: ${DECIDE_SLOTS.join(', ')}`); return 1; }
  if (!SLOT_SPECS[slot].wired) { console.error(refusalLine('slot_unavailable', slot)); return 1; }
  const mode = has(args, '--shadow') ? 'shadow' : 'on';
  if (mode === 'on' && (flagValue(args, '--provider') ?? state.cfg.slots[slot].provider) === state.cfg.slots[slot].provider && state.cfg.slots[slot].keyDefault && !policyFor(state, slot).inactive) {
    if (json) console.log(JSON.stringify({ slot, requested: 'on', effective: 'on', inactive: null, key_default: true, writes: {} }, null, 2));
    else console.log(`${slot}: already on (${KEY_DEFAULT_LABEL}); nothing written. Opt out: ${keyDefaultOptOut(slot)}`);
    return 0;
  }
  const requestedProvider = flagValue(args, '--provider');
  if (requestedProvider && !isValidProvider(requestedProvider)) { console.error(`--provider must be typesafe:<model> or llm:<provider:model> (got ${requestedProvider})`); return 1; }
  const base = requestedProvider ?? state.cfg.slots[slot].provider;
  if (providerKind(base) === 'none' && slot !== 'rerank') { console.error(refusalLine('no_provider', slot)); return 1; }
  let provider = providerKind(base) === 'none' ? DEFAULT_TYPESAFE_PROVIDER : base;
  if (providerKind(provider) === 'typesafe' && !state.key.present) { console.error(refusalLine('no_key', slot)); return 1; }
  try { provider = await resolvePinned(provider); } catch (err) { console.error(`could not resolve ${provider}: ${err instanceof Error ? err.message : err}`); return 1; }

  const writes: Array<[string, string]> = [];
  if (state.cfg.provider === 'none' || (requestedProvider && state.cfg.provider === requestedProvider)) writes.push(['decide.provider', provider]);
  else if (requestedProvider) writes.push([`decide.slots.${slot}.provider`, provider]);
  const typesafe = providerKind(provider) === 'typesafe';
  const classes = SLOT_SPECS[slot].egressClasses;
  if (typesafe && slot !== 'rerank') for (const c of classes) writes.push([`decide.egress.typesafe.${c}`, 'allow']);
  if (typesafe && PRIVATE_SLOTS.includes(slot) && state.cfg.egressPrivate === 'deny' && state.cfg.egressFallback === 'none') {
    console.error(`${refusalLine('egress_private_denied', slot)}\nMissing keys: decide.egress.private=allow, or decide.slots.${slot}.provider llm:<provider:model>, or decide.egress_fallback llm:<provider:model>`);
    if (slot === 'conflict') console.error(await conflictShareLine(engine, 'would be refused'));
    return 1;
  }
  writes.push([`decide.slots.${slot}.mode`, mode]);
  const nextSnapshot = { ...state.snapshot, ...Object.fromEntries(writes) };
  if (slot === 'rerank') { nextSnapshot['search.reranker.model'] = provider; nextSnapshot['search.reranker.enabled'] = 'true'; }
  const nextCfg = readDecideConfig(nextSnapshot, { typesafeKey: state.key.present });
  const nextState: DecideState = { ...state, cfg: nextCfg, snapshot: nextSnapshot, ...(slot === 'rerank' ? { rerankerModel: provider, rerankerEnabled: true } : {}) };
  const policy = policyFor(nextState, slot);
  if (mode === 'on' && policy.inactive && ENABLE_REFUSALS.has(policy.inactive)) {
    console.error(refusalLine(policy.inactive, slot));
    return 1;
  }
  if (policy.calibration) writes.push([`decide.slots.${slot}.calibration`, policy.calibration.ref]);
  const cost = costPer1k(slot, provider);
  const summary = [
    `Enable ${slot} (${SLOT_PLAIN_NAMES[slot]}) ${mode === 'shadow' ? 'in shadow (advanced diagnostics)' : 'on'} with ${provider}.`,
    slot === 'rerank'
      ? 'Data that leaves this machine: query and candidate text go to TypeSafe as the search reranker, exactly as with any configured reranker (Voyage today).'
      : `Data that leaves this machine: ${classes.join(', ')} text to ${typesafe ? 'TypeSafe' : 'your configured chat provider'}; private pages stay local unless decide.egress.private=allow.`,
    ...(slot === 'conflict' && typesafe ? [await conflictShareLine(engine, state.cfg.egressPrivate === 'allow' ? 'are sent (decide.egress.private=allow)' : 'go to decide.egress_fallback')] : []),
    ...(cost.usd !== null ? [`Estimated cost: ~$${cost.usd.toFixed(4)} per 1,000 ${COST_UNITS[slot]?.unit ?? 'units'}; daily cap $${nextCfg.dailyUsd.toFixed(2)} (decide.budget.daily_usd${slot === 'rerank' ? '; S1 on uses reranker spend controls' : ''}).`] : []),
    `Writes: ${[...writes, ...(slot === 'rerank' ? [['search.reranker.model', provider], ['search.reranker.enabled', 'true']] : [])].map(([k, v]) => `${k}=${v}`).join(', ')}`,
  ];
  if (!(await enableConsent(engine, args, { slots: [slot], summary, dailyUsd: nextCfg.dailyUsd,
    argv: ['gbrain', 'decide', 'enable', slot, '--provider', provider, ...(mode === 'shadow' ? ['--shadow'] : []), ...(json ? ['--json'] : [])] }))) return currentExitCode() || 1;
  if (slot === 'rerank') writes.push(...await enableRerank(engine, state, provider, args));
  await writeConfig(engine, writes);
  const after = policyFor(nextState, slot);
  const line = effectiveModeLine(after);
  const result = { slot, requested: mode, effective: after.effective, inactive: after.inactive ?? null, provider, writes: Object.fromEntries(writes) };
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${slot}: requested: ${mode} / effective: ${after.effective}${line ? `\n${line}` : ''}`);
  return after.effective === mode ? 0 : 1;
}

async function enableRecommended(engine: BrainEngine, state: DecideState, args: string[]): Promise<number> {
  const provider = state.cfg.provider !== 'none' ? state.cfg.provider : DEFAULT_TYPESAFE_PROVIDER;
  const model = provider.replace(/^typesafe:/, '');
  const recommended = recommendedSlots(provider, (slot) => state.cfg.slots[slot].minActionPrecision);
  const winners = DECIDE_SLOTS.filter((slot) => recommended.includes(slot));
  if (winners.length === 0) {
    console.error(`no slot has a recorded win for ${model}; see docs/eval/system-one/`);
    return 1;
  }
  // One ask covers every winner; the per-slot runs then carry the approval.
  if (!has(args, '--yes')) {
    const summary = [`Enable ${winners.join(', ')} with ${provider} (the slots with a recorded win; docs/eval/system-one/).`,
      `Data that leaves this machine: the query, candidate and fact text each slot scores, to ${provider.startsWith('typesafe:') ? 'TypeSafe' : 'your configured chat provider'}; private pages stay local unless decide.egress.private=allow.`];
    if (!(await enableConsent(engine, args, { slots: winners, summary, dailyUsd: state.cfg.dailyUsd,
      argv: ['gbrain', 'decide', 'enable', '--recommended', ...(flagValue(args, '--provider') ? ['--provider', flagValue(args, '--provider')!] : []), ...(has(args, '--json') ? ['--json'] : [])] }))) return currentExitCode() || 1;
  }
  let code = 0;
  const pin = state.cfg.provider === 'none' && !flagValue(args, '--provider') ? ['--provider', provider] : [];
  for (const slot of winners) code = Math.max(code, await cmdEnable(engine, ['enable', slot, ...pin, ...args.filter((a) => a !== '--recommended' && a !== '--yes'), '--yes']));
  return code;
}

async function cmdDisable(engine: BrainEngine, args: string[]): Promise<number> {
  const all = has(args, '--all');
  const slot = args.find((a) => !a.startsWith('--') && a !== 'disable') as DecideSlot | undefined;
  if (!all && (!slot || !(DECIDE_SLOTS as readonly string[]).includes(slot))) { console.error(`Usage: gbrain decide disable <slot>|--all. Slots: ${DECIDE_SLOTS.join(', ')}`); return 1; }
  const slots = all ? [...DECIDE_SLOTS] : [slot!];
  const writes: Array<[string, string]> = slots.map((s) => [`decide.slots.${s}.mode`, 'off']);
  const restored: string[] = [];
  if (slots.includes('rerank')) {
    const owned = await getDecideState(engine, RERANK_OWNERSHIP_KEY);
    if (owned) {
      const { previous, wrote } = JSON.parse(owned) as { previous: { model: string | null; enabled: string | null }; wrote: { model: string; enabled: string } };
      const current = { model: await engine.getConfig('search.reranker.model'), enabled: await engine.getConfig('search.reranker.enabled') };
      // Restore only configuration decide still owns (the operator may have changed it since).
      for (const [field, key] of [['model', 'search.reranker.model'], ['enabled', 'search.reranker.enabled']] as const) {
        if (current[field] !== wrote[field]) continue;
        if (previous[field] === null) await engine.unsetConfig(key);
        else writes.push([key, previous[field]!]);
        restored.push(key);
      }
      await deleteDecideState(engine, RERANK_OWNERSHIP_KEY);
    }
  }
  await writeConfig(engine, writes);
  console.log(`${all ? 'Every slot' : slot} is off.${restored.length ? ` Restored ${restored.join(', ')} to the values before decide enable rerank.` : ''}${all ? ' decide.provider none also stops every slot, S1 shadow and the S9 sweep.' : ''}`);
  return 0;
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export async function runDecideCommand(engine: BrainEngine, args: string[]): Promise<number> {
  const sub = args[0];
  await loadDecideLanes();
  try {
    switch (sub) {
      case 'status': return await cmdStatus(engine, args.slice(1));
      case 'probe': return await cmdProbe(engine, args.slice(1));
      case 'enable': return await cmdEnable(engine, args);
      case 'disable': return await cmdDisable(engine, args);
      case 'calibrate': case 'qualify': case 'calibrations': case 'dataset': {
        const m = await import('./decide/calibrate.ts');
        return await m.runCalibrationSubcommand(engine, sub, args.slice(1));
      }
      case 'receipts': {
        const m = await import('./decide/receipts.ts');
        return await m.runReceiptsCommand(engine, args.slice(1));
      }
      default: {
        const extra = sub ? extraSubcommands.get(sub) : undefined;
        if (extra) return await extra.run(engine, args.slice(1));
        if (sub === 'proposals' || sub === 'sweep') {
          console.error(`gbrain decide ${sub} is not available in this build (its slot is not wired yet). See gbrain decide status.`);
          return 1;
        }
        console.error(decideHelpText());
        return sub ? 1 : 0;
      }
    }
  } finally {
    await flushDecideWrites().catch(() => {});
  }
}
