/**
 * Owner trust actions (#5575: A4, CEO-9, CEO-12, DX-2, DX-3, DX-7, DX-13,
 * DX-14, ENG-10, ENG-15): confirm, drop, release, revert, allow and the
 * `disable --all` kill switch, shared by the local CLI, the resident owner's
 * IPC administration (persistence/administration.ts) and the `confirm_memory`
 * op (ops/trust.ts).
 *
 * Every action runs in two steps. `previewOwnerAction` reads the target and
 * returns what the owner approves: a one-line summary, the typed token, the
 * exact command, whether the action raises trust (CEO-9) and a `binding` that
 * names the target's exact state (row content and tier, page revision,
 * proposal status). `applyOwnerAction` previews again under the same rules,
 * refuses with `preview_changed` when the binding moved, and refuses a
 * raising action without a confirmation. The confirmation itself is
 * established by the caller: the CLI's typed-token TTY prompt, or a
 * memory_confirm connection (trust/confirm.ts). Over IPC the prompt happens
 * in the invoking CLI and the resident owner re-runs the preview and checks
 * the binding before applying (DX-2).
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import type { Principal } from '../persistence/model.ts';
import type { OwnerConfirmation } from './confirm.ts';
import { tierRaiseFix } from './confirm.ts';
import { decideTrustProposal } from './decide.ts';
import { resolveContestedFactOnConfirm } from './supersede-handlers.ts';
import { getTrustProposal, pendingTrustProposalsFor, trustProposalRef, type TrustDecisionResult, type TrustProposalRow } from './proposals.ts';
import {
  confirmPage, latestPageVersionId, lowerPageState, readPageTrustState, readPageVersion, revertLoweredPage, revertPageToVersion,
  setRowTier, versionTier, type PageActionResult,
} from './page-handlers.ts';
import { formatTrustRef, pageRef, parseTrustRef, resolvePageRef, type TrustRef } from './refs.ts';
import { storedTrustTier, trustLabel, type TrustTier } from './tier.ts';
import { isQuarantined } from '../quarantine.ts';
import { getWriteGateHold, releaseWriteGateHold, type WriteGateHold } from '../write-gate-store.ts';
import { withCoordinatedWrite, withTrustPromotion, withWriteAttribution, withWriteTrust } from '../persistence/context.ts';
import { maintenanceAttribution } from '../persistence/attribution.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import {
  addTrustAllowRule, getTrustAllowRule, normalizeTrustAllowRule, parseAllowRuleRef, principalLabel, removeTrustAllowRule, type TrustAllowRule,
} from './allow-rules.ts';

export const OWNER_ACTIONS = ['confirm', 'drop', 'release', 'revert', 'allow', 'allow_remove', 'disable', 'enable'] as const;
export type OwnerActionName = typeof OWNER_ACTIONS[number];

export interface OwnerActionInput {
  action: OwnerActionName;
  /** The typed ref (confirm, drop, release, revert, allow_remove). */
  ref?: string;
  /** Routing for a bare page slug, and the source of an allow rule. */
  source?: string | null;
  /** revert p:<source>/<slug> --version <id>. */
  version?: number;
  uri_prefix?: string | null;
  reason_family?: string | null;
  reason?: string | null;
}

export interface OwnerActionPreview {
  action: OwnerActionName;
  ref: string;
  summary: string;
  /** What the owner types on the TTY (the ref, or a hash8 for long refs). */
  token: string;
  /** The exact local command that performs this action (never with --yes). */
  command: string[];
  /** CEO-9: the action raises trust (or lowers protection), so it needs the owner's confirmation. */
  raises: boolean;
  /** The target's exact approved state; apply refuses when it moved. */
  binding: string;
  tier?: TrustTier;
  target_tier?: TrustTier;
  /** Page actions: the page revision and (revert) the version the owner approved. */
  revision?: string;
  version_id?: number;
}

export interface OwnerActionResult {
  action: OwnerActionName;
  ref: string;
  status: string;
  tier?: TrustTier;
  prior_tier?: TrustTier;
  detail?: Record<string, unknown>;
}

export interface OwnerApplyOptions {
  /** The binding from the preview the owner approved. */
  binding: string;
  /** How the owner confirmed; required when the preview raises. */
  confirmation: OwnerConfirmation | null;
  by?: Principal | null;
  config?: GBrainConfig;
  /** A memory_confirm caller's context (managed page writes admit under its authority). */
  ctx?: OperationContext;
}

const hash8 = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 8);
const bindingOf = (value: unknown): string => createHash('sha256')
  .update(JSON.stringify(value, (_key, v: unknown) => typeof v === 'bigint' ? v.toString() : v)).digest('hex');
const snippet = (text: unknown, max = 80): string => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};
const trustCommand = (...args: string[]): string[] => ['gbrain', 'trust', ...args];

function notFound(ref: string, what: string): Error {
  return opError('not_found', `No ${what} ${ref}.`, 'Check the ref; gbrain trust review lists what is waiting for you.');
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

interface RowTarget { table: 'facts' | 'takes'; id: number; sourceId: string; tier: TrustTier; text: string; binding: string; live: boolean }

async function readFactTarget(engine: BrainEngine, id: number): Promise<RowTarget | null> {
  const [row] = await engine.executeRaw<Record<string, unknown>>(
    `SELECT id, source_id, trust_tier, fact, entity_slug, kind, claim_metric, claim_value, claim_unit, claim_period, value, event_type, dimension, context,
            expired_at, superseded_by FROM facts WHERE id = $1`, [id]);
  if (!row) return null;
  return { table: 'facts', id, sourceId: String(row.source_id), tier: storedTrustTier(row.trust_tier), text: String(row.fact ?? ''),
    binding: bindingOf({ ...row, expired_at: row.expired_at ? String(row.expired_at) : null }), live: !row.expired_at };
}

async function readTakeTarget(engine: BrainEngine, id: number): Promise<RowTarget | null> {
  const [row] = await engine.executeRaw<Record<string, unknown>>(
    `SELECT t.id, p.source_id, t.trust_tier, t.claim, t.kind, t.holder, t.active, t.superseded_by
       FROM takes t JOIN pages p ON p.id = t.page_id WHERE t.id = $1`, [id]);
  if (!row) return null;
  return { table: 'takes', id, sourceId: String(row.source_id), tier: storedTrustTier(row.trust_tier), text: String(row.claim ?? ''),
    binding: bindingOf(row), live: row.active !== false };
}

// Held writes (write-gate-store.ts). Release publishes the held row at user_confirmed in the same transaction (CEO-9).
export interface HoldRow { id: number; kind: 'fact' | 'take'; source_id: string; slug: string; status: string; tier: TrustTier; reason_families: string[]; payload: Record<string, unknown>; last_seen_at: string }
export interface HoldStoreAdapter {
  get(engine: BrainEngine, id: number): Promise<HoldRow | null>;
  list(engine: BrainEngine, opts: { sourceId?: string; since?: Date }): Promise<HoldRow[]>;
  /** Marks the hold released and publishes its payload at user_confirmed in `tx`; false when it was no longer held. */
  release(tx: BrainEngine, id: number, by: string): Promise<boolean>;
  drop(tx: BrainEngine, id: number, by: string): Promise<boolean>;
}
async function holdTableExists(engine: BrainEngine): Promise<boolean> {
  const [row] = await engine.executeRaw<{ t: string | null }>(`SELECT to_regclass('write_gate_holds')::text AS t`);
  return !!row?.t;
}
const holdColumns = `id, kind, source_id, slug, status, tier, reason_families, payload, last_seen_at`;
function holdRow(r: Record<string, unknown>): HoldRow {
  const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) as Record<string, unknown> : (r.payload as Record<string, unknown> | null) ?? {};
  return { id: Number(r.id), kind: r.kind as HoldRow['kind'], source_id: String(r.source_id), slug: String(r.slug ?? ''), status: String(r.status),
    tier: storedTrustTier(r.tier), reason_families: (r.reason_families as string[] | null) ?? [], payload, last_seen_at: new Date(r.last_seen_at as string).toISOString() };
}
const decideHoldSql = (status: 'released' | 'dropped') =>
  `UPDATE write_gate_holds SET status = '${status}', decided_at = now(), decided_by = $2 WHERE id = $1 AND status = 'held' RETURNING id`;
const defaultHoldStore: HoldStoreAdapter = {
  async get(engine, id) {
    if (!(await holdTableExists(engine))) return null;
    const [row] = await engine.executeRaw<Record<string, unknown>>(`SELECT ${holdColumns} FROM write_gate_holds WHERE id = $1`, [id]);
    return row ? holdRow(row) : null;
  },
  async list(engine, opts) {
    if (!(await holdTableExists(engine))) return [];
    const rows = await engine.executeRaw<Record<string, unknown>>(
      `SELECT ${holdColumns} FROM write_gate_holds WHERE status = 'held' AND ($1::text IS NULL OR source_id = $1)
         AND ($2::timestamptz IS NULL OR last_seen_at >= $2) ORDER BY id LIMIT 1000`, [opts.sourceId ?? null, opts.since?.toISOString() ?? null]);
    return rows.map(holdRow);
  },
  async release(tx, id, by) {
    const held = await getWriteGateHold(tx, id);
    if (held?.kind === 'take') {
      throw opError('unavailable', `h${id} is a held take; releasing takes is not supported yet, so nothing was changed.`,
        `Drop it with gbrain trust drop h${id}, or add the take yourself with gbrain takes add.`);
    }
    const hold = await releaseWriteGateHold(tx, id, by);
    if (!hold) return false;
    await publishReleasedFact(tx, hold);
    return true;
  },
  async drop(tx, id, by) { return (await tx.executeRaw(decideHoldSql('dropped'), [id, by])).length === 1; },
};
/**
 * The released fact enters memory as the owner's confirmed row: database-only (the hold kept no fence
 * position; its embedding is filled by the usual backfill), stamped user_confirmed under the promotion capability.
 */
async function publishReleasedFact(tx: BrainEngine, hold: WriteGateHold): Promise<void> {
  const p = hold.payload;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const trust = { tier: 'user_confirmed' as const, origin: { channel: 'trust_release', request_id: hold.request_id ?? undefined } };
  const write = () => withTrustPromotion(tx, 'user_confirmed', () => withWriteTrust(tx, trust, () => tx.insertFact({ // gbrain-allow-direct-insert: owner release of a held fact (CEO-9), inside the owner's coordinated transaction
    fact: String(p.fact ?? ''), kind: (str(p.kind) ?? 'fact') as never, entity_slug: str(p.entity_slug), visibility: (p.visibility === 'world' ? 'world' : 'private'),
    source: str(p.source) ?? `trust release h${hold.id}`, context: str(p.context), source_session: str(p.source_session), confidence: 1,
    valid_from: str(p.valid_from) ? new Date(String(p.valid_from)) : new Date(), valid_until: str(p.valid_until) ? new Date(String(p.valid_until)) : null,
    embedding: null, embedding_model: null,
  }, { source_id: hold.source_id })));
  if (await managedPersistenceEnabled(tx)) await withCoordinatedWrite(tx, [hold.source_id], write, await maintenanceAttribution(tx));
  else await withWriteAttribution(tx, await maintenanceAttribution(tx), write);
}
let holdStore: HoldStoreAdapter = defaultHoldStore;
/** Test seam (and the L2a merge point): the hold store the owner actions use. */
export function __setHoldStoreForTests(store: HoldStoreAdapter | null): void { holdStore = store ?? defaultHoldStore; }
export function currentHoldStore(): HoldStoreAdapter { return holdStore; }

// ---------------------------------------------------------------------------
// Kill switch (DX-13)
// ---------------------------------------------------------------------------

/** `gbrain trust disable --all`: the values it writes. */
export const TRUST_KILL_SWITCH_VALUES: Readonly<Record<string, string>> = Object.freeze({
  'write_gate.external_mode': 'off',
  'write_gate.agent_mode': 'off',
  'trust.agent_activation': 'allow',
});
/** The receipt of the last disable/enable: who, when, and the values the disable replaced. */
export const TRUST_KILL_SWITCH_KEY = 'trust.kill_switch';
interface KillSwitchReceipt { state: 'disabled' | 'enabled'; at: string; by: string; prior?: Record<string, string | null>; disabled_at?: string }

async function readKillSwitch(engine: BrainEngine): Promise<KillSwitchReceipt | null> {
  const raw = await engine.getConfig(TRUST_KILL_SWITCH_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as KillSwitchReceipt; } catch { return null; }
}
async function currentSwitchValues(engine: BrainEngine): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const key of Object.keys(TRUST_KILL_SWITCH_VALUES)) out[key] = await engine.getConfig(key);
  return out;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function requireRef(input: OwnerActionInput): TrustRef {
  if (!input.ref) throw opError('invalid_params', `trust ${input.action} needs a ref.`, 'Pass a ref such as f12, t3, h4, tp7 or p:default/notes/alice-example; gbrain trust review lists them.');
  return parseTrustRef(input.ref);
}

function unsupported(action: OwnerActionName, ref: TrustRef): Error {
  return opError('invalid_params', `trust ${action} does not apply to ${formatTrustRef(ref)}.`,
    'confirm takes a fact (f12), take (t3), page (p:default/notes/alice-example), trust proposal (tp7) or held write (h4); drop takes a trust proposal or held write; release takes a held write; revert takes an agent-edit trust proposal or a page; allow --remove takes an allow rule (a2). gbrain trust review lists the refs.');
}

async function pendingProposal(engine: BrainEngine, id: number): Promise<TrustProposalRow> {
  const p = await getTrustProposal(engine, id);
  if (!p) throw notFound(trustProposalRef(id), 'trust proposal');
  if (p.status !== 'pending') throw opError('invalid_params', `${trustProposalRef(id)} is already ${p.status}; there is nothing to decide.`, 'gbrain trust review lists what is still pending.');
  return p;
}

function proposalSummary(p: TrustProposalRow, verb: 'Accept' | 'Dismiss' | 'Revert'): string {
  if (p.action === 'lower_page') {
    const s = lowerPageState(p);
    const page = pageRef(p.source_id, s.slug);
    if (verb === 'Accept') return `Endorse the agent edit of ${page}: raise it from "${trustLabel(s.edited_tier)}" to "confirmed by you"`;
    if (verb === 'Revert') return `Revert the agent edit of ${page}: restore version ${s.version_id ?? '?'} and its tier "${trustLabel(s.prior_tier)}"`;
    return `Dismiss ${trustProposalRef(p.id)}: ${page} stays "${trustLabel(s.edited_tier)}"`;
  }
  const target = `${p.target_table === 'facts' ? 'f' : p.target_table === 'takes' ? 't' : ''}${p.target_id}`;
  const related = p.related_id === null ? '' : ` with ${p.related_table === 'facts' ? 'f' : p.related_table === 'takes' ? 't' : ''}${p.related_id}`;
  const what = p.action === 'forget' ? `forget ${target}` : p.action.startsWith('supersede') ? `supersede ${target}${related}` : `${p.action.replace('_', ' ')} ${target}${related}`;
  return verb === 'Accept' ? `Accept ${trustProposalRef(p.id)}: ${what} (raises trust over "${trustLabel(storedTrustTier(p.before_state.prior_tier ?? p.before_state.tier))}")`
    : `Dismiss ${trustProposalRef(p.id)}: do not ${what}`;
}

async function proposalBinding(engine: BrainEngine, p: TrustProposalRow): Promise<string> {
  const page = p.action === 'lower_page' ? await readPageTrustState(engine, p.source_id, lowerPageState(p).slug) : null;
  return bindingOf({ id: p.id, status: p.status, updated_at: p.updated_at, page: page?.revision ?? null });
}

async function previewConfirm(engine: BrainEngine, ref: TrustRef, input: OwnerActionInput): Promise<OwnerActionPreview> {
  if (ref.kind === 'fact' || ref.kind === 'take') {
    const label = formatTrustRef(ref);
    const row = ref.kind === 'fact' ? await readFactTarget(engine, ref.id) : await readTakeTarget(engine, ref.id);
    if (!row) throw notFound(label, ref.kind);
    if (!row.live) throw opError('invalid_params', `${label} is no longer active (expired, superseded or forgotten); there is nothing to confirm.`, 'Confirm the row that replaced it instead; gbrain trust explain shows its history.');
    return { action: 'confirm', ref: label, token: label, command: trustCommand('confirm', label), raises: row.tier !== 'user_confirmed', binding: row.binding,
      tier: row.tier, target_tier: 'user_confirmed', summary: `Raise ${ref.kind} ${label} ("${snippet(row.text)}") from "${trustLabel(row.tier)}" to "confirmed by you"` };
  }
  if (ref.kind === 'page') {
    const { sourceId, slug } = await resolvePageRef(engine, ref, input.source);
    const label = pageRef(sourceId, slug);
    const state = await readPageTrustState(engine, sourceId, slug);
    if (!state) throw notFound(label, 'page');
    if (isQuarantined(state.snapshot.page.frontmatter)) {
      throw opError('invalid_params', `${label} is quarantined; confirming it would not make it visible.`,
        `Review it first; clearing the quarantine is a separate owner step: gbrain quarantine clear ${slug} --source-id ${sourceId}.`);
    }
    return { action: 'confirm', ref: label, token: hash8(`${label}@${state.revision}`), command: trustCommand('confirm', label),
      raises: state.tier !== 'user_confirmed' || state.hasMarker, binding: state.revision, tier: state.tier, target_tier: 'user_confirmed', revision: state.revision,
      summary: `Raise page ${label} from "${trustLabel(state.tier)}" to "confirmed by you"${state.hasMarker ? ' and remove its trust_tier marker' : ''}` };
  }
  if (ref.kind === 'proposal') {
    const p = await pendingProposal(engine, ref.id);
    return { action: 'confirm', ref: trustProposalRef(p.id), token: trustProposalRef(p.id), command: trustCommand('confirm', trustProposalRef(p.id)),
      raises: true, binding: await proposalBinding(engine, p), target_tier: 'user_confirmed', summary: proposalSummary(p, 'Accept') };
  }
  if (ref.kind === 'hold') return previewHold(engine, ref.id, 'release');
  throw unsupported('confirm', ref);
}

async function previewHold(engine: BrainEngine, id: number, action: 'release' | 'drop'): Promise<OwnerActionPreview> {
  const label = `h${id}`;
  const hold = await holdStore.get(engine, id);
  if (!hold) throw notFound(label, 'held write');
  const text = hold.payload.fact ?? hold.payload.claim ?? '';
  return { action, ref: label, token: label, command: trustCommand(action, label), raises: action === 'release',
    binding: bindingOf({ id: hold.id, status: hold.status, last_seen_at: hold.last_seen_at }), tier: hold.tier,
    ...(action === 'release' ? { target_tier: 'user_confirmed' as TrustTier } : {}),
    summary: action === 'release'
      ? `Release held ${hold.kind} ${label} ("${snippet(text)}", ${hold.reason_families.join(', ') || 'detector error'}) into memory as "confirmed by you"`
      : `Drop held ${hold.kind} ${label} ("${snippet(text)}"); it stays out of memory` };
}

async function previewRevert(engine: BrainEngine, ref: TrustRef, input: OwnerActionInput): Promise<OwnerActionPreview> {
  if (ref.kind === 'proposal') {
    const p = await pendingProposal(engine, ref.id);
    if (p.action !== 'lower_page') throw opError('invalid_params', `${trustProposalRef(p.id)} is a ${p.action} proposal; only agent-edit items (lower_page) revert.`, `Use gbrain trust confirm ${trustProposalRef(p.id)} or gbrain trust drop ${trustProposalRef(p.id)}.`);
    const s = lowerPageState(p);
    return { action: 'revert', ref: trustProposalRef(p.id), token: trustProposalRef(p.id), command: trustCommand('revert', trustProposalRef(p.id)),
      raises: true, binding: await proposalBinding(engine, p), tier: s.edited_tier, target_tier: s.prior_tier, summary: proposalSummary(p, 'Revert') };
  }
  if (ref.kind !== 'page') throw unsupported('revert', ref);
  const { sourceId, slug } = await resolvePageRef(engine, ref, input.source);
  const label = pageRef(sourceId, slug);
  const state = await readPageTrustState(engine, sourceId, slug);
  if (!state) throw notFound(label, 'page');
  let versionId = input.version ?? null;
  if (versionId === null) {
    const lowered = (await pendingTrustProposalsFor(engine, 'pages', state.pageId)).find(p => p.action === 'lower_page');
    versionId = (lowered ? lowerPageState(lowered).version_id : null) ?? await latestPageVersionId(engine, state.pageId);
  }
  if (versionId === null) throw opError('not_found', `${label} has no earlier version to revert to.`, `gbrain history ${slug} lists a page's versions.`);
  const version = await readPageVersion(engine, state.pageId, versionId);
  if (!version) throw opError('not_found', `Version ${versionId} is not in the history of ${label}.`, `List the page's versions with gbrain history ${slug} and pass one of their ids to --version.`);
  const tier = versionTier(version);
  return { action: 'revert', ref: label, token: hash8(`${label}@${state.revision}#${versionId}`), command: [...trustCommand('revert', label), '--version', String(versionId)],
    raises: true, binding: bindingOf({ revision: state.revision, version: versionId }), tier: state.tier, target_tier: tier, revision: state.revision, version_id: versionId,
    summary: `Revert page ${label} to version ${versionId}: restore its content and its tier "${trustLabel(tier)}"${version.trust_tier ? '' : ' (a version from before trust tiers reads as unverified origin)'}` };
}

/** Reads the target and returns what the owner approves. Read-only. */
export async function previewOwnerAction(engine: BrainEngine, input: OwnerActionInput): Promise<OwnerActionPreview> {
  switch (input.action) {
    case 'confirm': return previewConfirm(engine, requireRef(input), input);
    case 'release': {
      const ref = requireRef(input);
      if (ref.kind !== 'hold') throw unsupported('release', ref);
      return previewHold(engine, ref.id, 'release');
    }
    case 'drop': {
      const ref = requireRef(input);
      if (ref.kind === 'hold') return previewHold(engine, ref.id, 'drop');
      if (ref.kind !== 'proposal') throw unsupported('drop', ref);
      const p = await pendingProposal(engine, ref.id);
      return { action: 'drop', ref: trustProposalRef(p.id), token: trustProposalRef(p.id), command: trustCommand('drop', trustProposalRef(p.id)),
        raises: false, binding: await proposalBinding(engine, p), summary: proposalSummary(p, 'Dismiss') };
    }
    case 'revert': return previewRevert(engine, requireRef(input), input);
    case 'allow': {
      const rule = normalizeTrustAllowRule({ sourceId: input.source ?? '', uriPrefix: input.uri_prefix, reasonFamily: input.reason_family, reason: input.reason });
      const command = [...trustCommand('allow', '--source', rule.sourceId), ...(rule.uriPrefix ? ['--uri-prefix', rule.uriPrefix] : []),
        ...(rule.reasonFamily ? ['--reason-family', rule.reasonFamily] : [])];
      return { action: 'allow', ref: `allow:${rule.sourceId}`, token: `allow-${rule.sourceId}`, command, raises: true, binding: bindingOf(rule),
        summary: `Stop holding ${rule.reasonFamily ? `"${rule.reasonFamily}" ` : ''}instruction-like content from source ${rule.sourceId}${rule.uriPrefix ? ` under ${rule.uriPrefix}` : ''}` };
    }
    case 'allow_remove': {
      const id = input.ref ? parseAllowRuleRef(input.ref) : null;
      if (id === null) throw opError('invalid_params', 'trust allow --remove needs an allow rule ref a<id>.', 'gbrain trust review lists the allow rules with their refs.');
      const rule = await getTrustAllowRule(engine, id);
      if (!rule || rule.removed_at) throw notFound(`a${id}`, 'active allow rule');
      return { action: 'allow_remove', ref: rule.ref, token: rule.ref, command: trustCommand('allow', '--remove', rule.ref), raises: false,
        binding: bindingOf(rule), summary: `Remove allow rule ${rule.ref} (source ${rule.source_id}${rule.uri_prefix ? `, ${rule.uri_prefix}` : ''})` };
    }
    case 'disable': {
      const values = await currentSwitchValues(engine);
      return { action: 'disable', ref: 'trust:all', token: 'disable-all', command: trustCommand('disable', '--all'), raises: true, binding: bindingOf(values),
        summary: 'Turn the memory trust protections off: write_gate.external_mode=off, write_gate.agent_mode=off, trust.agent_activation=allow' };
    }
    case 'enable': {
      const receipt = await readKillSwitch(engine);
      return { action: 'enable', ref: 'trust:all', token: 'enable-all', command: trustCommand('disable', '--all', '--undo'), raises: false,
        binding: bindingOf({ receipt, values: await currentSwitchValues(engine) }), summary: 'Restore the memory trust protections the last disable --all turned off' };
    }
  }
}

/** DX-3: the fix an owner action emits when it needs the user. Tier-raising actions never carry --yes and are never `run`. */
export function ownerActionFix(preview: OwnerActionPreview) {
  return tierRaiseFix(preview.command, `${preview.summary}. Only the owner can do this, in an interactive terminal on the brain host.`,
    `Run on the brain host, in a terminal: ${preview.command.join(' ')}`);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function fromDecision(action: OwnerActionName, d: TrustDecisionResult): OwnerActionResult {
  if (d.status === 'stale' || d.status === 'refused' || d.status === 'not_found') {
    throw opError('preview_changed', `${d.ref} could not be decided (${d.status}${d.reason ? `: ${d.reason}` : ''}); nothing was changed.`,
      'Run gbrain trust review to see its current state.');
  }
  return { action, ref: d.ref, status: d.status, ...(d.detail ? { detail: d.detail } : {}) };
}

function asPageResult(action: OwnerActionName, r: PageActionResult): OwnerActionResult {
  return { action, ref: r.ref, status: r.status, tier: r.tier, prior_tier: r.prior_tier,
    detail: { ...(r.marker_removed !== undefined ? { marker_removed: r.marker_removed } : {}), ...(r.version_id !== undefined ? { version_id: r.version_id } : {}) } };
}

/**
 * Applies one owner action the owner approved. Re-reads the target, refuses
 * when it changed since the preview (`preview_changed`) or when a raising
 * action has no confirmation (`confirmation_required`), then performs it.
 */
export async function applyOwnerAction(engine: BrainEngine, input: OwnerActionInput, opts: OwnerApplyOptions): Promise<OwnerActionResult> {
  const preview = await previewOwnerAction(engine, input);
  if (preview.binding !== opts.binding) {
    throw opError('preview_changed', `${preview.ref} changed after you approved it; nothing was changed.`,
      'Run the command again: it shows the current state and asks for a new confirmation.');
  }
  if (preview.raises && !opts.confirmation) {
    throw opError('confirmation_required', `${preview.summary} needs the owner's confirmation; nothing was changed.`,
      'Do not retry with --yes. Tell the user to run the command in fix in an interactive terminal on the brain host.', { fix: ownerActionFix(preview) });
  }
  const confirmation = opts.confirmation ?? { via: 'tty' as const };
  const by = opts.by ?? null;
  const decision = { confirmation, decidedBy: by, ...(opts.config ? { config: opts.config } : {}) };
  const ref = input.ref ? parseTrustRef(input.ref) : null;
  switch (input.action) {
    case 'confirm':
    case 'release': {
      if (ref?.kind === 'fact' || ref?.kind === 'take') {
        const read = ref.kind === 'fact' ? readFactTarget : readTakeTarget;
        const row = (await read(engine, ref.id))!;
        // A contested fact: confirming either side resolves its supersede_fact proposal (one value stays current), even when it is already confirmed.
        const resolved = ref.kind === 'fact' && row.binding === opts.binding ? await resolveContestedFactOnConfirm(engine, ref.id, decision) : null;
        if (resolved?.status === 'accepted') return { action: input.action, ref: preview.ref, status: 'confirmed', tier: 'user_confirmed', prior_tier: row.tier, detail: { resolved_proposal: resolved.ref } };
        if (!preview.raises) return { action: input.action, ref: preview.ref, status: 'unchanged', tier: 'user_confirmed', prior_tier: 'user_confirmed' };
        const ok = await setRowTier(engine, { table: row.table, id: row.id, sourceId: row.sourceId, tier: 'user_confirmed', ceiling: 'user_confirmed', by,
          note: { via: confirmation.via, action: 'confirm', by: principalLabel(by) },
          expect: async tx => (await read(tx, ref.id))?.binding === opts.binding });
        if (!ok) throw opError('preview_changed', `${preview.ref} changed after you approved it; nothing was changed.`, 'Run the command again.');
        return { action: input.action, ref: preview.ref, status: 'confirmed', tier: 'user_confirmed', prior_tier: row.tier };
      }
      if (ref?.kind === 'page') {
        const { sourceId, slug } = await resolvePageRef(engine, ref, input.source);
        if (!preview.raises) return { action: 'confirm', ref: preview.ref, status: 'unchanged', tier: 'user_confirmed', prior_tier: 'user_confirmed' };
        return asPageResult('confirm', await confirmPage(engine, { sourceId, slug, expectedRevision: preview.revision!, confirmation, by, config: opts.config, ctx: opts.ctx }));
      }
      if (ref?.kind === 'proposal') return fromDecision('confirm', await decideTrustProposal(engine, ref.id, 'accept', decision));
      if (ref?.kind === 'hold') {
        const released = await engine.transaction(tx => holdStore.release(tx, ref.id, principalLabel(by)));
        if (!released) throw opError('preview_changed', `h${ref.id} was decided meanwhile; nothing was changed.`, 'Run gbrain trust review.');
        return { action: 'release', ref: preview.ref, status: 'released', tier: 'user_confirmed', prior_tier: preview.tier };
      }
      throw unsupported(input.action, ref!);
    }
    case 'drop': {
      if (ref?.kind === 'hold') {
        if (!(await engine.transaction(tx => holdStore.drop(tx, ref.id, principalLabel(by))))) throw opError('preview_changed', `h${ref.id} was decided meanwhile; nothing was changed.`, 'Run gbrain trust review.');
        return { action: 'drop', ref: preview.ref, status: 'dropped' };
      }
      if (ref?.kind === 'proposal') return fromDecision('drop', await decideTrustProposal(engine, ref.id, 'reject', decision));
      throw unsupported('drop', ref!);
    }
    case 'revert': {
      if (ref?.kind === 'proposal') {
        const p = (await getTrustProposal(engine, ref.id))!;
        if (p.status !== 'pending') throw opError('preview_changed', `${trustProposalRef(p.id)} is ${p.status}; nothing was changed.`, 'Run gbrain trust review.');
        return fromDecision('revert', await revertLoweredPage(engine, p, decision));
      }
      if (ref?.kind === 'page') {
        const { sourceId, slug } = await resolvePageRef(engine, ref, input.source);
        return asPageResult('revert', await revertPageToVersion(engine, { sourceId, slug, expectedRevision: preview.revision!, versionId: preview.version_id!, confirmation, by, config: opts.config, ctx: opts.ctx }));
      }
      throw unsupported('revert', ref!);
    }
    case 'allow': {
      const { rule, created } = await addTrustAllowRule(engine, { sourceId: input.source ?? '', uriPrefix: input.uri_prefix, reasonFamily: input.reason_family, reason: input.reason }, by);
      return { action: 'allow', ref: rule.ref, status: created ? 'added' : 'unchanged', detail: { rule } };
    }
    case 'allow_remove': {
      const rule = await removeTrustAllowRule(engine, parseAllowRuleRef(input.ref!)!, by);
      if (!rule) throw opError('preview_changed', `${preview.ref} was removed meanwhile.`, 'Run gbrain trust review.');
      return { action: 'allow_remove', ref: rule.ref, status: 'removed', detail: { rule: rule as TrustAllowRule } };
    }
    case 'disable': {
      const prior = await currentSwitchValues(engine);
      const at = new Date().toISOString();
      const receipt: KillSwitchReceipt = { state: 'disabled', at, by: principalLabel(by), prior };
      for (const [key, value] of Object.entries(TRUST_KILL_SWITCH_VALUES)) await engine.setConfig(key, value);
      await engine.setConfig(TRUST_KILL_SWITCH_KEY, JSON.stringify(receipt));
      return { action: 'disable', ref: preview.ref, status: 'disabled', detail: { values: { ...TRUST_KILL_SWITCH_VALUES }, prior, at } };
    }
    case 'enable': {
      const last = await readKillSwitch(engine);
      const current = await currentSwitchValues(engine);
      const restored: string[] = [];
      for (const [key, wrote] of Object.entries(TRUST_KILL_SWITCH_VALUES)) {
        // Restore only what the disable still owns: a value the owner changed since stays.
        if (last?.state !== 'disabled' || current[key] !== wrote) continue;
        const prior = last.prior?.[key] ?? null;
        if (prior === null) await engine.unsetConfig(key); else await engine.setConfig(key, prior);
        restored.push(key);
      }
      const at = new Date().toISOString();
      await engine.setConfig(TRUST_KILL_SWITCH_KEY, JSON.stringify({ state: 'enabled', at, by: principalLabel(by), ...(last?.at ? { disabled_at: last.at } : {}) } satisfies KillSwitchReceipt));
      return { action: 'enable', ref: preview.ref, status: last?.state === 'disabled' ? 'enabled' : 'unchanged', detail: { restored, at } };
    }
  }
}

/** The kill switch receipt and current values (review and explain show it). */
export async function trustKillSwitchState(engine: BrainEngine): Promise<{ receipt: KillSwitchReceipt | null; values: Record<string, string | null> }> {
  return { receipt: await readKillSwitch(engine), values: await currentSwitchValues(engine) };
}
