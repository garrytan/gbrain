/**
 * Consent primitive (agent operator contract v1, A4). CLI command handlers
 * call `requireConsent()` before paid, destructive, credential, egress or
 * persistent-install work. It resolves with the Authorization that covers the
 * request or throws `confirmation_required` (exit 3) carrying the consent
 * payload. Core library paths never prompt: they take an Authorization.
 *
 * Trust boundary: requireConsent runs only in trusted local CLI handlers, so
 * a `host_admin` action is never authorizable from MCP (no MCP path calls
 * it). User preapprovals live only in the host's file plane
 * (~/.gbrain/config.json), which no MCP or HTTP operation writes; a
 * `consent.*` row in the DB plane is never read.
 *
 * Consent honesty: an agent can always pass `--yes`. This gate forces a stop
 * and supplies relay text; it cannot prove a human agreed. The enforced rails
 * are the spend cap on the Authorization and the plan-hash binding below.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONTRACT_VERSION, cliRenderContext, renderAction, shellQuote, type Action, type Actor, type CliErrorRender, type Effect, type RenderContext, type RenderedAction } from './agent-output.ts';
import { agentBlock } from './agent-markers.ts';
import { writeJsonDocument } from './cli-force-exit.ts';
import { recordAgentContractEvent } from './agent-contract-log.ts';
import { gbrainPath } from './config.ts';
import { PREAPPROVE_PAID_MAX_USD_PER_RUN, PREAPPROVE_PERSISTENT_INSTALL, preapprovalCommand, readConsentPreapprovals, type ConsentPreapprovals } from './consent-preapproval.ts';
import { isInteractive, readLine, type LineRead } from './interaction.ts';
import { OperationError, opError } from './ops/contract.ts';
import { SPEND_POSTURE_CONFIG_KEY, normalizeSpendPosture } from './spend-posture.ts';

export * from './consent-preapproval.ts';

export type CapSource = 'derived' | 'default' | 'user';

export interface Authorization {
  consented_effects: Effect[];
  /** null only when no paid effect. */
  cap_usd: number | null;
  cap_source: CapSource | null;
  via: 'yes' | 'max_usd' | 'tokenmax' | 'preapproval' | 'apply_flag' | 'non_interactive_flag' | 'tty_prompt';
  /** destructive: binds the persisted approved selection. */
  approval_token?: string;
}
type Via = Authorization['via'];

export interface ConsentRequest {
  command: string;
  effects: Effect[];
  actor: Actor;
  what: string; why: string; risk: string;
  user_message: string;
  /** The exact command that runs once approved. */
  argv: string[];
  preview_argv?: string[];
  est_usd?: number | null;
  plan_hash?: string;
  /** destructive: persisted with the approval (A4 destructive rail). */
  selection?: unknown;
  /** Raw argv, for --yes/--max-usd/--expect/--apply/--trust/--non-interactive. */
  args: readonly string[];
}

/** The ambient inputs requireConsent reads; every field defaults to the live process. */
export interface ConsentEnv {
  /** DB-plane config read (`engine.getConfig`) for `spend.posture`; absent → `gated`. */
  getConfig?: (key: string) => Promise<string | null>;
  /** Default: the host file plane (readConsentPreapprovals()). */
  preapprovals?: ConsentPreapprovals;
  /** The command's configured cost cap (e.g. a `*.budget_usd` key); counts as a user cap. */
  configuredCapUsd?: number;
  /** Default: isInteractive(). */
  interactive?: boolean;
  /** Default: interaction.readLine (EOF/timeout = decline). */
  readLine?: (opts: { prompt: string; timeoutMs?: number }) => Promise<LineRead>;
  /** One-line stderr notes (cap printed, preapproval honoured). */
  note?: (line: string) => void;
}

/**
 * Cap for paid work that has no estimate and no user cap. Matches the
 * per-command defaults already shipped (enrich and extract-conversation-facts
 * `DEFAULT_MAX_COST_USD`).
 */
export const DEFAULT_PAID_CAP_USD = 5;
/** `--yes` without `--max-usd`: estimate × 1.5, never below this floor. */
export const DERIVED_CAP_MULTIPLIER = 1.5;
export const DERIVED_CAP_FLOOR_USD = 0.25;

/**
 * What `--non-interactive` authorizes, per command. It is never a blanket
 * `--yes`: `apply-migrations` (where it historically meant `--yes`) gets the
 * autopilot install its Phase F performs, nothing paid or destructive. The
 * post-upgrade caller (`src/commands/upgrade.ts`, applyMigrations) passes
 * `--yes --non-interactive` to apply-migrations, whose only consent effect
 * is that same install. Every other command: nothing.
 */
export const NON_INTERACTIVE_AUTHORIZES: Readonly<Record<string, readonly Effect[]>> = {
  'apply-migrations': ['persistent_install'],
};

// ── flags ──────────────────────────────────────────────────────────────────

export interface ConsentFlags {
  yes: boolean;
  /** Finite positive `--max-usd` / `--max-cost`; anything else is not an authorization. */
  maxUsd: number | null;
  expect: string | null;
  apply: boolean;
  nonInteractive: boolean;
}

function flagValue(args: readonly string[], names: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const n of names) {
      if (a === n) return args[i + 1] ?? null;
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return null;
}

export function parseConsentFlags(args: readonly string[]): ConsentFlags {
  const end = args.indexOf('--');
  const opts = end >= 0 ? args.slice(0, end) : args;
  const usd = Number(flagValue(opts, ['--max-usd', '--max-cost']));
  return {
    yes: opts.includes('--yes'),
    maxUsd: Number.isFinite(usd) && usd > 0 ? usd : null,
    expect: flagValue(opts, ['--expect']),
    apply: opts.includes('--apply') || opts.includes('--trust'),
    nonInteractive: opts.includes('--non-interactive'),
  };
}

// ── caps ───────────────────────────────────────────────────────────────────

const stderrLine = (line: string) => { process.stderr.write(`${line}\n`); };
const ceilCents = (usd: number) => Math.ceil(usd * 100 - 1e-9) / 100;

/** `--yes` without `--max-usd`: estimate × 1.5, floor $0.25, rounded up to the cent. */
export function derivedCapUsd(estUsd: number): number {
  return ceilCents(Math.max(estUsd * DERIVED_CAP_MULTIPLIER, DERIVED_CAP_FLOOR_USD));
}

function capFor(req: ConsentRequest, flags: ConsentFlags, paidVia: Via, pre: ConsentPreapprovals, env: ConsentEnv): { cap_usd: number; cap_source: CapSource } {
  if (flags.maxUsd !== null) return { cap_usd: flags.maxUsd, cap_source: 'user' };
  if (paidVia === 'preapproval') return { cap_usd: pre.paid!.max_usd_per_run!, cap_source: 'user' };
  if (env.configuredCapUsd !== undefined) return { cap_usd: env.configuredCapUsd, cap_source: 'user' };
  const note = env.note ?? stderrLine;
  if (typeof req.est_usd === 'number' && Number.isFinite(req.est_usd)) {
    const cap = derivedCapUsd(req.est_usd);
    note(`[consent] ${req.command}: cost cap $${cap.toFixed(2)} (the $${req.est_usd.toFixed(2)} estimate x${DERIVED_CAP_MULTIPLIER}). Set your own with --max-usd <usd>.`);
    return { cap_usd: cap, cap_source: 'derived' };
  }
  note(`[consent] ${req.command}: no cost estimate, so the default $${DEFAULT_PAID_CAP_USD.toFixed(2)} cap applies. Set your own with --max-usd <usd>.`);
  return { cap_usd: DEFAULT_PAID_CAP_USD, cap_source: 'default' };
}

// ── the matrix ─────────────────────────────────────────────────────────────

interface Coverage { flags: ConsentFlags; pre: ConsentPreapprovals; tokenmax: boolean }

/** Which mechanism authorizes one effect, or null. The published consent matrix. */
function coverEffect(effect: Effect, req: ConsentRequest, c: Coverage): Via | null {
  const { flags, pre } = c;
  if (effect === 'destructive') {
    if (!flags.yes) return null;
    return !req.plan_hash || flags.expect === req.plan_hash ? 'yes' : null;
  }
  if (effect === 'paid') {
    if (flags.maxUsd !== null) return 'max_usd';
    if (flags.yes) return 'yes';
    if (c.tokenmax) return 'tokenmax';
    const limit = pre.paid?.max_usd_per_run;
    if (limit !== undefined && (req.est_usd == null || req.est_usd <= limit)) return 'preapproval';
    return null;
  }
  if (flags.yes) return 'yes';
  if (flags.apply) return 'apply_flag';
  if (flags.nonInteractive && NON_INTERACTIVE_AUTHORIZES[req.command]?.includes(effect)) return 'non_interactive_flag';
  if (effect === 'persistent_install' && pre.persistent_install) return 'preapproval';
  return null;
}

const VIA_ORDER: readonly Via[] = ['yes', 'max_usd', 'apply_flag', 'non_interactive_flag', 'tokenmax', 'preapproval'];

async function spendPostureIsTokenmax(env: ConsentEnv): Promise<boolean> {
  if (!env.getConfig) return false;
  try {
    return normalizeSpendPosture(await env.getConfig(SPEND_POSTURE_CONFIG_KEY)) === 'tokenmax';
  } catch {
    return false;
  }
}

async function promptConsent(req: ConsentRequest, env: ConsentEnv): Promise<boolean> {
  const read = await (env.readLine ?? readLine)({ prompt: `${req.what}: ${req.user_message} [y/N] ` });
  return read.kind === 'line' && /^y(es)?$/i.test(read.text);
}

/**
 * CLI command handlers only. Resolves with the authorization or throws
 * OperationError('confirmation_required') (`isConsentRefusal`, exit 3,
 * printed by `printConsentRefusal`), or `preview_changed` when `--expect`
 * names a different plan than the one being applied.
 */
export async function requireConsent(req: ConsentRequest, env: ConsentEnv = {}): Promise<Authorization> {
  if (req.effects.length === 0) return { consented_effects: [], cap_usd: null, cap_source: null, via: 'yes' };
  const flags = parseConsentFlags(req.args);
  if (req.effects.includes('destructive') && req.plan_hash && flags.expect !== null && flags.expect !== req.plan_hash) {
    throw previewChangedError(req, flags.expect);
  }
  const pre = env.preapprovals ?? readConsentPreapprovals();
  const tokenmax = req.effects.includes('paid') && await spendPostureIsTokenmax(env);
  const vias = req.effects.map(e => coverEffect(e, req, { flags, pre, tokenmax }));
  let via: Via;
  if (vias.every((v): v is Via => v !== null)) {
    via = VIA_ORDER.find(v => vias.includes(v))!;
  } else if (env.interactive ?? isInteractive()) {
    if (!(await promptConsent(req, env))) throw consentRefusal(req, 'declined');
    via = 'tty_prompt';
  } else {
    throw consentRefusal(req, 'refused');
  }
  if (via !== 'tty_prompt' && vias.includes('preapproval')) {
    const keys = req.effects.filter((_, i) => vias[i] === 'preapproval')
      .map(e => (e === 'paid' ? PREAPPROVE_PAID_MAX_USD_PER_RUN : PREAPPROVE_PERSISTENT_INSTALL));
    (env.note ?? stderrLine)(`[consent] ${req.command}: proceeding under the user's preapproval ${keys.join(', ')} (remove with: gbrain config unset <key>).`);
    recordAgentContractEvent({ command: req.command, transport: 'cli', code: 'confirmation_required', effects: [...req.effects], outcome: 'preapproved' });
  }
  const paidIdx = req.effects.indexOf('paid');
  const cap = paidIdx >= 0
    ? capFor(req, flags, via === 'tty_prompt' ? 'tty_prompt' : vias[paidIdx]!, pre, env)
    : { cap_usd: null, cap_source: null };
  const approval_token = req.effects.includes('destructive') && req.plan_hash && req.selection !== undefined
    ? persistApproval(req.selection, req.plan_hash)
    : undefined;
  return { consented_effects: [...req.effects], ...cap, via, ...(approval_token ? { approval_token } : {}) };
}

// ── refusal payload + rendering ────────────────────────────────────────────

/** The exit-3 `--json` document (and the data behind the human `[AGENT]` block). */
export interface ConfirmationPayload {
  status: 'confirmation_required';
  error: 'confirmation_required';
  code: 'confirmation_required';
  message: string;
  suggestion: string;
  effects: Effect[];
  actor: Actor;
  why: string;
  risk: string;
  est_usd: number | null;
  user_message: string;
  fix: RenderedAction;
  preview: { argv: string[]; command: string } | null;
  plan_hash?: string;
  preapprove_argv?: string[];
  docs_cmd: string[];
  contract_version: 1;
}

/** The approved command: `--yes`, plus `--expect <plan_hash>` for destructive work, so it runs verbatim once approved. */
export function consentFix(req: ConsentRequest): Action {
  const argv = [...req.argv];
  if (!argv.includes('--yes')) argv.push('--yes');
  if (req.effects.includes('destructive') && req.plan_hash && !argv.includes('--expect')) argv.push('--expect', req.plan_hash);
  return {
    argv, consent: [...req.effects], actor: req.actor, why: req.why, user_message: req.user_message,
    requires_exclusive: false,
    ...(req.preview_argv ? { preview_argv: req.preview_argv } : {}),
    ...(req.plan_hash ? { plan_hash: req.plan_hash } : {}),
  };
}

/**
 * Destructive approvals bind the plan: the approved command already carries
 * `--yes --expect <plan_hash>`. Paid payloads offer a per-run preapproval
 * (`gbrain config set consent.preapprove.paid.max_usd_per_run <usd>`);
 * destructive ones never do.
 */
export function confirmationPayload(req: ConsentRequest, ctx: RenderContext): ConfirmationPayload {
  const destructive = req.effects.includes('destructive');
  const rendered = renderAction(consentFix(req), ctx);
  const paid = req.effects.includes('paid');
  return {
    status: 'confirmation_required',
    error: 'confirmation_required',
    code: 'confirmation_required',
    message: `${req.what} needs the user's approval before it runs; nothing was changed.`,
    suggestion: `Ask the user: ${req.user_message} If they agree, run: ${rendered.command}`,
    effects: [...req.effects],
    actor: req.actor,
    why: req.why,
    risk: req.risk,
    est_usd: req.est_usd ?? null,
    user_message: req.user_message,
    fix: rendered,
    preview: rendered.preview_argv ? { argv: rendered.preview_argv, command: shellQuote(rendered.preview_argv) } : null,
    ...(req.plan_hash ? { plan_hash: req.plan_hash } : {}),
    ...(paid && !destructive ? { preapprove_argv: preapprovalCommand(PREAPPROVE_PAID_MAX_USD_PER_RUN, '<usd>') } : {}),
    docs_cmd: ['gbrain', 'errors', 'confirmation_required'],
    contract_version: CONTRACT_VERSION,
  };
}

/** A `confirmation_required` OperationError carrying its payload. */
export interface ConsentRefusal extends OperationError { consent: ConfirmationPayload }

export function isConsentRefusal(e: unknown): e is ConsentRefusal {
  return e instanceof OperationError && e.code === 'confirmation_required' && (e as Partial<ConsentRefusal>).consent !== undefined;
}

/** The exit-3 refusal for `req`, rendered for `ctx` (no prompt, no log): for gates outside requireConsent. */
export function buildConsentRefusal(req: ConsentRequest, ctx: RenderContext = cliRenderContext()): ConsentRefusal {
  const payload = confirmationPayload(req, ctx);
  const e = opError('confirmation_required', payload.message, payload.suggestion, { why: req.why, fix: consentFix(req) }) as ConsentRefusal;
  e.consent = payload;
  return e;
}

function consentRefusal(req: ConsentRequest, outcome: 'refused' | 'declined'): ConsentRefusal {
  const e = buildConsentRefusal(req);
  recordAgentContractEvent({ command: req.command, transport: 'cli', code: 'confirmation_required', effects: [...req.effects], outcome });
  return e;
}

function previewChangedError(req: ConsentRequest, expected: string): OperationError {
  recordAgentContractEvent({ command: req.command, transport: 'cli', code: 'preview_changed', effects: [...req.effects], outcome: 'refused' });
  return opError('preview_changed',
    `The plan changed since it was approved (--expect ${expected}, current plan ${req.plan_hash}); nothing was changed.`,
    'Preview again, show the user the new plan, and re-run with the new --expect value only if they approve it.',
    { why: 'An approval covers exactly the plan the user saw; a different plan needs a new approval.',
      ...(req.preview_argv ? { fix: { argv: req.preview_argv, consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Shows the current plan and its plan_hash.' } } : {}) });
}

/**
 * Exit-3 output for a refusal. `--json`: the payload document on stdout.
 * Human: the `[AGENT]` block (fenced `[SHOW USER]` relay of user_message) on
 * stdout and the one-line error on stderr. Pure: callers write the strings.
 */
export function renderConsentRefusal(p: ConfirmationPayload, opts: { json: boolean }): CliErrorRender {
  if (opts.json) return { stdout: `${JSON.stringify(p, null, 2)}\n`, exitCode: 3 };
  const preview = p.preview ? ` To look first (read-only): ${p.preview.command}` : '';
  const preapprove = p.preapprove_argv ? `To stop asking for runs under a limit the user picks: ${shellQuote(p.preapprove_argv)}` : '';
  const block = agentBlock({
    ask: p.user_message,
    why: p.why,
    risk: p.risk,
    consent: p.effects.join(', '),
    actor: p.fix.actor,
    next: p.fix.next,
    if_yes: [p.fix.command, preapprove].filter(Boolean).join(' — '),
    if_no: `Nothing runs; nothing was changed.${preview}`,
  }, { showUser: p.user_message });
  return { stdout: block, stderr: `Error [confirmation_required]: ${p.message}\n`, exitCode: 3 };
}

/** Write a refusal and return its exit code (3). The one way a CLI handler reports `confirmation_required`. */
export function printConsentRefusal(e: ConsentRefusal, opts: { json: boolean }): number {
  const out = renderConsentRefusal(e.consent, opts);
  // D2: under the --json guard only writeStdoutFinal reaches fd 1 (the payload / [AGENT] block is the final document).
  if (out.stdout) void writeJsonDocument(out.stdout, t => process.stdout.write(t));
  if (out.stderr) process.stderr.write(out.stderr);
  return out.exitCode;
}

// ── derived-cap exhaustion ─────────────────────────────────────────────────

/** `--max-usd` for the resume: twice the cap that ran out, rounded up to the cent. */
export function resumeMaxUsd(capUsd: number): number {
  return ceilCents(Math.max(capUsd * 2, DERIVED_CAP_FLOOR_USD));
}

/**
 * The exit-1 error for paid work that stopped at its derived cap: names the
 * checkpoint and the exact resume command (`--max-usd <n>`). BudgetTracker
 * logs `derived_cap_exhausted` to E11 when it throws; this only shapes the
 * report.
 */
export function derivedCapExhaustedError(opts: { command: string; argv: readonly string[]; spentUsd: number; capUsd: number; checkpoint?: string }): OperationError {
  const argv: string[] = [];
  for (let i = 0; i < opts.argv.length; i++) {
    const a = opts.argv[i];
    if (a === '--max-usd' || a === '--max-cost') { i++; continue; }
    if (a.startsWith('--max-usd=') || a.startsWith('--max-cost=')) continue;
    argv.push(a);
  }
  const n = resumeMaxUsd(opts.capUsd);
  argv.push('--max-usd', n.toFixed(2));
  const where = opts.checkpoint ? ` Progress is checkpointed (${opts.checkpoint}).` : '';
  return opError('derived_cap_exhausted',
    `${opts.command} stopped at its $${opts.capUsd.toFixed(2)} cost cap (derived from the estimate) after spending $${opts.spentUsd.toFixed(2)}.${where}`,
    `Ask the user whether to continue with a $${n.toFixed(2)} cap, then run: ${shellQuote(argv)}`,
    { why: 'The estimate was low; the derived cap stops the run instead of spending past what was approved.',
      fix: { argv, consent: ['paid'], actor: 'agent', requires_exclusive: false,
        why: `Resumes from the checkpoint under a $${n.toFixed(2)} cap.`,
        user_message: `The run spent its $${opts.capUsd.toFixed(2)} budget before finishing. Continue with up to $${n.toFixed(2)} more?` } });
}

// ── destructive rail: plan hash + persisted approval ───────────────────────

/** The effective selection previews, hashes, approval, apply and verification share. */
export interface PlanSelection {
  brain: string;
  source: string | null;
  operation: string;
  records: ReadonlyArray<{ id: string; revision?: string | number | null; source_incarnation?: string | number | null }>;
  parameters: Record<string, unknown>;
  effects: readonly Effect[];
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => (v as Record<string, unknown>)[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Stable over key order, record order and effect order; changes with any record, revision or parameter. */
export function computePlanHash(sel: PlanSelection): string {
  const normal = {
    brain: sel.brain,
    source: sel.source,
    operation: sel.operation,
    records: [...sel.records].map(r => ({ id: r.id, revision: r.revision ?? null, source_incarnation: r.source_incarnation ?? null }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    parameters: sel.parameters,
    effects: [...new Set(sel.effects)].sort(),
  };
  return `ph_${createHash('sha256').update(canonicalJson(normal)).digest('hex').slice(0, 24)}`;
}

export interface StoredApproval {
  approval_token: string;
  plan_hash: string;
  selection: unknown;
  approved_at: string;
}

const TOKEN_RE = /^apr_[0-9a-f]{32}$/;
const approvalPath = (token: string) => gbrainPath('consent', 'approvals', `${token}.json`);

/** Persist the approved selection under GBRAIN_HOME; returns the approval token. */
export function persistApproval(selection: unknown, planHash: string): string {
  const token = `apr_${randomBytes(16).toString('hex')}`;
  const record: StoredApproval = { approval_token: token, plan_hash: planHash, selection, approved_at: new Date().toISOString() };
  const path = approvalPath(token);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return token;
}

export function readApproval(token: string): StoredApproval | null {
  if (!TOKEN_RE.test(token)) return null;
  try {
    const r = JSON.parse(readFileSync(approvalPath(token), 'utf8')) as StoredApproval;
    return r.approval_token === token && typeof r.plan_hash === 'string' ? r : null;
  } catch {
    return null;
  }
}

export type ApprovalCheck =
  | { ok: true; approval: StoredApproval }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'changed'; changed: string[]; added: string[]; removed: string[] };

/**
 * Apply-time check (run under the brain's lock): recompute the plan hash of
 * the selection as it is now. A changed record or a newly matching record
 * means the user approved something else, so the caller re-asks.
 */
export function verifyApproval(token: string, current: PlanSelection): ApprovalCheck {
  const approval = readApproval(token);
  if (!approval) return { ok: false, reason: 'missing' };
  if (computePlanHash(current) === approval.plan_hash) return { ok: true, approval };
  const byId = (records: PlanSelection['records'] | undefined) => new Map((records ?? []).map(r =>
    [r.id, canonicalJson([r.revision ?? null, r.source_incarnation ?? null])]));
  const before = byId((approval.selection as Partial<PlanSelection> | null)?.records);
  const after = byId(current.records);
  const changed = [...after.keys()].filter(id => before.has(id) && before.get(id) !== after.get(id));
  return {
    ok: false, reason: 'changed', changed,
    added: [...after.keys()].filter(id => !before.has(id)),
    removed: [...before.keys()].filter(id => !after.has(id)),
  };
}

/** verifyApproval as a guard: throws `preview_changed` (re-ask) unless the approval still covers the selection. */
export function assertApproval(token: string, current: PlanSelection, opts: { command: string; preview_argv?: string[] }): StoredApproval {
  const check = verifyApproval(token, current);
  if (check.ok) return check.approval;
  recordAgentContractEvent({ command: opts.command, transport: 'cli', code: 'preview_changed', effects: [...current.effects], outcome: check.reason });
  const detail = check.reason === 'missing'
    ? 'no stored approval matches that token'
    : `${check.changed.length} changed, ${check.added.length} newly matching, ${check.removed.length} no longer matching record(s)`;
  throw opError('preview_changed', `The approved plan no longer matches the brain (${detail}); nothing was changed.`,
    'Preview again, show the user the new plan, and apply only with their new approval.',
    { why: 'An approval covers exactly the records the user saw.', reason: check.reason,
      ...(opts.preview_argv ? { fix: { argv: opts.preview_argv, consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Shows the current plan and its plan_hash.' } } : {}) });
}
