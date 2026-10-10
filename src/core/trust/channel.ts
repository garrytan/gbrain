/**
 * Write-time trust tiers per channel (#5575: A3, CEO-21, CEO-26/DX-8, ENG-18).
 * Deterministic, never guessed: the tier comes from who is writing and through
 * which path, and frontmatter or an agent's `content_origin` can only lower it.
 *
 * - Remote MCP / serve-http / thin-client agent writes: agent_written.
 * - Local CLI `remember` / `put_page` / `capture` and the other journaled
 *   agent verbs: agent_written (a local agent with a shell is
 *   indistinguishable from the human; only CEO-9 confirmation raises).
 * - `content_origin: tool_output` lowers an agent write to external_untrusted.
 * - Connector jobs (Google, GitHub), webhook and ingestion-daemon captures and
 *   third-party transcript imports: external_untrusted.
 * - Owner-source sync / import / reconcile / file repair: operator_curated (or
 *   the source's `sources set-trust` default, never above operator_curated),
 *   lowered by the page's frontmatter markers: the lower-only `trust_tier`
 *   marker, `source_kind` / `ingested_via` / `captured_via` channel stamps,
 *   `transcript_import`, clipper `source_url`, `provenance: auto-extracted`
 *   and `dream_generated`.
 *
 * The coordinator declares `preparedTrust ?? requestChannelTrust(row)` once per
 * publication (persistence/coordinator.ts, group-publish.ts); preparers that
 * know more (sync markers, derivation inputs) declare their own.
 */
import type { BrainEngine } from '../engine.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { CONNECTOR_SOURCE_KINDS } from '../persistence/connector-identity.ts';
import {
  CONTENT_ORIGINS, OWNER_TIER_FLOOR, TRUST_TIER_RANK, compareTrust, contentOriginTier, effectiveWriteTrust, isTrustTier, minTrust, trustRankSql,
  type ContentOrigin, type TrustTier, type WriteTrust,
} from './tier.ts';

/** Journaled verbs an agent (remote or local) calls directly; their rows are agent_written unless lowered. */
export const AGENT_WRITE_OPERATIONS: readonly string[] = [
  'put_page', 'put_pages', 'capture', 'edit_page', 'delete_page', 'restore_page', 'revert_version', 'remember',
  'add_tag', 'remove_tag', 'add_timeline_entry', 'takes_add', 'takes_update', 'takes_supersede', 'takes_resolve',
  'takes_remove', 'loops_close', 'relink_facts', 'decide_proposal',
];

/**
 * Intent kinds whose preparer computes the tier from the page (owner-source sync and import paths), and
 * the owner's `quarantine clear`, which only removes a gate-owned marker and keeps the page's tier.
 */
const OWNER_SOURCE_KINDS = ['canonical_reconcile', 'managed_file_import', 'managed_file_repair', 'managed_grandfather', 'managed_quarantine_clear'];

/** Page frontmatter `source_kind` / `ingested_via` / `captured_via` values written by an ingestion capture (external). */
export const EXTERNAL_CAPTURE_KINDS: readonly string[] = ['webhook', 'file-watcher', 'inbox-folder', 'cron-scheduler', 'ingest_capture'];
/** ...and by an agent through a gbrain verb (agent_written). */
const AGENT_CAPTURE_KINDS = ['put_page', 'capture-cli', 'capture-mcp', 'capture'];
/**
 * Harnesses whose `transcript_import` pages are the user's own sessions with
 * their agent (or their own chat exports): relayed user turns count as
 * agent_written. Any other harness is a third-party transcript: external.
 */
export const OWN_SESSION_HARNESSES: readonly string[] = [
  'claude-code', 'codex', 'openclaw', 'cursor', 'hermes', 'gemini-cli', 'opencode', 'chatgpt', 'claude', 'grok',
];

/**
 * The internal intent kind of a journaled request (`managed_*`, `connector_v2_*`,
 * `canonical_reconcile`, `code_projection_reindex`), or ''. A caller's own `kind`
 * param (a fact kind on remember, a take kind on takes_add) is not a channel.
 */
function internalIntentKind(intent: Record<string, unknown> | null | undefined): string {
  const kind = typeof intent?.kind === 'string' ? intent.kind : '';
  return /^(?:managed_|connector_v2_|canonical_|code_projection_)/.test(kind) ? kind : '';
}

/** The origin channel name of a journaled request, e.g. `mcp:put_page`, `cli:remember`, `connector:google`. */
export function requestChannel(row: Pick<WriteRequest, 'operation' | 'authority' | 'intent'>): string {
  const kind = internalIntentKind(row.intent);
  if (kind.startsWith('connector_v2_') || kind.startsWith('managed_connector_')) return `connector:${kind}`;
  if (kind) return kind;
  return `${row.authority?.remote === true ? 'mcp' : 'cli'}:${row.operation}`;
}

/** The agent's declared content origin from a request intent (validated at admission); undefined when absent. */
export function intentContentOrigin(intent: Record<string, unknown> | null | undefined): TrustTier | undefined {
  const value = intent?.content_origin;
  return value === undefined || value === null ? undefined : contentOriginTier(value);
}

/**
 * The tier a journaled request earns from its channel alone, or undefined for
 * intents whose preparer must declare one (owner-source sync, derived
 * maintenance) or that write no tiered rows. Undeclared rows stamp `unknown`.
 */
export function requestChannelTrust(row: Pick<WriteRequest, 'id' | 'operation' | 'authority' | 'intent'>): WriteTrust | undefined {
  const kind = internalIntentKind(row.intent);
  const declared = row.intent?.content_origin;
  const origin = { channel: requestChannel(row), request_id: row.id,
    ...((CONTENT_ORIGINS as readonly unknown[]).includes(declared) ? { content_origin: declared as ContentOrigin } : {}) };
  if (kind.startsWith('connector_v2_') || kind.startsWith('managed_connector_')) return effectiveWriteTrust({ channel: 'external_untrusted', origin });
  if (row.authority?.remote === true) {
    const lowered = intentContentOrigin(row.intent);
    return effectiveWriteTrust({ channel: 'agent_written', lowerTo: lowered ? [lowered] : [], origin });
  }
  if (kind.startsWith('managed_sync_') || kind.startsWith('managed_maintenance_') || kind.startsWith('managed_facts_')
    || kind.startsWith('managed_atom_') || OWNER_SOURCE_KINDS.includes(kind)) return undefined;
  if (AGENT_WRITE_OPERATIONS.includes(row.operation)) {
    const lowered = intentContentOrigin(row.intent);
    return effectiveWriteTrust({ channel: 'agent_written', lowerTo: lowered ? [lowered] : [], origin });
  }
  return undefined;
}

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** The tier a single channel stamp names (`source_kind`, `ingested_via`, `captured_via`), or undefined. */
function stampTier(value: unknown): TrustTier | undefined {
  const v = str(value);
  if (!v) return undefined;
  if (EXTERNAL_CAPTURE_KINDS.includes(v)) return 'external_untrusted';
  if (v.startsWith('mcp:') || AGENT_CAPTURE_KINDS.includes(v)) return 'agent_written';
  if (v.startsWith('connector:') || (CONNECTOR_SOURCE_KINDS as readonly string[]).includes(v)) return 'external_untrusted';
  return undefined;
}

/**
 * Every lowering signal in a page's frontmatter (CEO-21). They can only lower:
 * a `trust_tier: user_confirmed` marker typed by hand is ignored (it names no
 * tier below the channel's), and nothing here can raise.
 */
export function frontmatterTrustCaps(frontmatter: Record<string, unknown> | null | undefined): TrustTier[] {
  const fm = frontmatter ?? {};
  const caps: TrustTier[] = [];
  if (isTrustTier(fm.trust_tier)) caps.push(fm.trust_tier);
  for (const key of ['source_kind', 'ingested_via', 'captured_via']) {
    const tier = stampTier(fm[key]);
    if (tier) caps.push(tier);
  }
  const transcript = fm.transcript_import as { harness?: unknown } | undefined;
  if (transcript && typeof transcript === 'object') {
    caps.push(OWN_SESSION_HARNESSES.includes(str(transcript.harness).toLowerCase()) ? 'agent_written' : 'external_untrusted');
  }
  if (str(fm.source_url) && (str(fm.clipped_at) || str(fm.clipper) || str(fm.captured_via) === 'clipper' || str(fm.type) === 'clipping')) {
    caps.push('external_untrusted');
  }
  if (str(fm.provenance) === 'auto-extracted' || fm.dream_generated === true || str(fm.dream_generated) === 'true') caps.push('agent_written');
  return caps;
}

/**
 * `frontmatterTrustCaps` as SQL over a jsonb frontmatter expression: one rank
 * term per signal (NULL when it does not apply), for `LEAST(...)` in the trust
 * backfill of claimed sources (trust/claim.ts). `fm` is a trusted alias or
 * column expression, never caller input; every literal comes from the lists
 * above. Kept in step with `frontmatterTrustCaps` by test/trust-claim.test.ts.
 */
export function frontmatterTrustCapsSql(fm: string): string[] {
  const list = (values: readonly string[]) => values.map(v => `'${v.replace(/'/g, "''")}'`).join(',');
  const text = (key: string, base = fm) => `(CASE WHEN jsonb_typeof(${base}->'${key}') = 'string' THEN NULLIF(btrim(${base}->>'${key}', E' \\t\\n\\r'), '') END)`;
  const stamp = (key: string) => `CASE WHEN ${text(key)} IN (${list(EXTERNAL_CAPTURE_KINDS)}) THEN ${TRUST_TIER_RANK.external_untrusted}
    WHEN ${text(key)} LIKE 'mcp:%' OR ${text(key)} IN (${list(AGENT_CAPTURE_KINDS)}) THEN ${TRUST_TIER_RANK.agent_written}
    WHEN ${text(key)} LIKE 'connector:%' OR ${text(key)} IN (${list(CONNECTOR_SOURCE_KINDS)}) THEN ${TRUST_TIER_RANK.external_untrusted} END`;
  return [
    `CASE WHEN jsonb_typeof(${fm}->'trust_tier') = 'string' THEN NULLIF(${trustRankSql(`(${fm}->>'trust_tier')`)}, 0) END`,
    ...['source_kind', 'ingested_via', 'captured_via'].map(stamp),
    `CASE WHEN jsonb_typeof(${fm}->'transcript_import') IN ('object', 'array') THEN
      CASE WHEN lower(${text('harness', `(${fm}->'transcript_import')`)}) IN (${list(OWN_SESSION_HARNESSES)}) THEN ${TRUST_TIER_RANK.agent_written} ELSE ${TRUST_TIER_RANK.external_untrusted} END END`,
    `CASE WHEN ${text('source_url')} IS NOT NULL AND (${text('clipped_at')} IS NOT NULL OR ${text('clipper')} IS NOT NULL
      OR ${text('captured_via')} = 'clipper' OR ${text('type')} = 'clipping') THEN ${TRUST_TIER_RANK.external_untrusted} END`,
    `CASE WHEN ${text('provenance')} = 'auto-extracted' OR ${fm}->'dream_generated' = 'true'::jsonb OR ${text('dream_generated')} = 'true'
      THEN ${TRUST_TIER_RANK.agent_written} END`,
  ];
}

/** A per-source default set by `gbrain sources set-trust` (sources.config.trust_tier), clamped to operator_curated. */
export function sourceDefaultTier(config: Record<string, unknown> | null | undefined): TrustTier {
  const value = config?.trust_tier;
  return isTrustTier(value) ? minTrust(value, OWNER_TIER_FLOOR) : OWNER_TIER_FLOOR;
}

/**
 * The tier of an owner-source sync / import of one page: the source default
 * lowered by the page's markers (connector sources are external outright).
 */
export function ownerPageTrust(input: {
  frontmatter: Record<string, unknown> | null | undefined;
  sourceConfig?: Record<string, unknown> | null;
  channel: string;
  requestId?: string | null;
  sourceUri?: string | null;
}): WriteTrust {
  const kind = str(input.sourceConfig?.kind);
  const base = (CONNECTOR_SOURCE_KINDS as readonly string[]).includes(kind) ? 'external_untrusted' : sourceDefaultTier(input.sourceConfig);
  return effectiveWriteTrust({
    channel: base, lowerTo: frontmatterTrustCaps(input.frontmatter),
    origin: { channel: input.channel, ...(input.requestId ? { request_id: input.requestId } : {}), ...(input.sourceUri ? { source_uri: input.sourceUri } : {}) },
  });
}

/**
 * CEO-21: the lower-only `trust_tier` marker a write-through stamps into the
 * canonical file when the write is below operator_curated. An existing lower
 * marker is kept (min). Returns the frontmatter unchanged at owner tiers.
 */
export function stampTrustMarker(frontmatter: Record<string, unknown>, tier: TrustTier): Record<string, unknown> {
  if (compareTrust(tier, OWNER_TIER_FLOOR) >= 0) return frontmatter;
  const prior = frontmatter.trust_tier;
  const marker = isTrustTier(prior) ? minTrust(prior, tier) : tier;
  if (prior === marker) return frontmatter;
  return { ...frontmatter, trust_tier: marker };
}

/**
 * The tier of a journaled owner-source write of one page (managed sync,
 * import, reconcile, file repair, grandfather): `ownerPageTrust` from the
 * source's config, capped at agent_written when a remote caller admitted it.
 */
export async function ownerImportTrust(engine: Pick<BrainEngine, 'executeRaw'>, row: Pick<WriteRequest, 'id' | 'source_id' | 'authority' | 'intent' | 'operation'>,
  frontmatter: Record<string, unknown> | null | undefined, sourceUri?: string | null): Promise<WriteTrust> {
  const [source] = await engine.executeRaw<{ config: Record<string, unknown> | string | null }>('SELECT config FROM sources WHERE id = $1', [row.source_id]);
  const config = typeof source?.config === 'string' ? JSON.parse(source.config) as Record<string, unknown> : source?.config ?? null;
  const trust = ownerPageTrust({ frontmatter, sourceConfig: config, channel: requestChannel(row), requestId: row.id, sourceUri });
  return row.authority?.remote === true ? { ...trust, tier: minTrust(trust.tier, 'agent_written') } : trust;
}

/** A direct (unmanaged) import declares the tier its caller passed to the write gate (ENG-18); absent: undeclared. */
export function writeTrustOfGate(input: { tier: TrustTier; origin?: { channel?: string | null; connector?: string | null; source_uri?: string | null } | null; requestId?: string | null } | undefined): WriteTrust | undefined {
  if (!input) return undefined;
  const o = input.origin;
  return { tier: input.tier, origin: { channel: o?.channel ?? 'import', ...(o?.connector ? { connector: o.connector } : {}), ...(o?.source_uri ? { source_uri: o.source_uri } : {}),
    ...(input.requestId ? { request_id: input.requestId } : {}) } };
}

/** The write-gate input for an owner-source page import: `ownerImportTrust` as the gate sees it (ENG-18). */
export async function ownerGateInput(engine: Pick<BrainEngine, 'executeRaw'>, row: Pick<WriteRequest, 'id' | 'source_id' | 'authority' | 'intent' | 'operation'>,
  frontmatter: Record<string, unknown> | null | undefined, sourceUri?: string | null) {
  const trust = await ownerImportTrust(engine, row, frontmatter, sourceUri);
  return { tier: trust.tier, origin: { channel: trust.origin?.channel ?? null, source_uri: trust.origin?.source_uri ?? null }, requestId: row.id };
}

/** The write-gate input of an unmanaged owner file import (direct sync / import of a source's files): the source default lowered by markers. */
export async function ownerSourceGateInput(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, frontmatter: Record<string, unknown> | null | undefined) {
  const [source] = await engine.executeRaw<{ config: Record<string, unknown> | string | null }>('SELECT config FROM sources WHERE id = $1', [sourceId]);
  const config = typeof source?.config === 'string' ? JSON.parse(source.config) as Record<string, unknown> : source?.config ?? null;
  const trust = ownerPageTrust({ frontmatter, sourceConfig: config, channel: 'import' });
  return { tier: trust.tier, origin: { channel: 'import' }, requestId: null };
}

/**
 * The `trust_tier` marker is hash-ephemeral (utils.ts), so an import whose only
 * change is adding or removing it would read as unchanged; removing it by hand
 * is the owner act that restamps a page on the next sync (CEO-21), so it counts.
 */
/**
 * CEO-21: `frontmatter` with its trust_tier marker set back to what the caller
 * supplied (removed when it supplied none). No-op detection compares this
 * view, so a server-stamped marker never turns an unchanged write into a write.
 */
export function suppliedTrustMarkerView(frontmatter: Record<string, unknown>, supplied: unknown): Record<string, unknown> {
  const { trust_tier: _stamped, ...rest } = frontmatter;
  return supplied === undefined ? rest : { ...rest, trust_tier: supplied };
}

export function trustMarkerChanged(prior: Record<string, unknown> | null | undefined, next: Record<string, unknown> | null | undefined): boolean {
  return (prior?.trust_tier ?? null) !== (next?.trust_tier ?? null);
}
