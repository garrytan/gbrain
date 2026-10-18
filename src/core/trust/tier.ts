/**
 * Memory trust tiers (#5575): how much a stored fact, take, page or timeline
 * entry deserves to influence an agent. One vocabulary, one order and one set
 * of user-facing labels for every writer, reader, gate and doctor check.
 *
 * Order (highest first, also the filter order of `min_trust`):
 * user_confirmed > operator_curated > tool_observed > agent_written > unknown > external_untrusted.
 * `unknown` marks rows written before tiers existed (or by a writer that has
 * not declared its channel yet); it is never treated as confirmed.
 *
 * The effective tier of a write is computed once, here (`effectiveWriteTrust`),
 * by the writer or coordinator scope; it reaches the database through the
 * transaction-local `gbrain.write_trust_tier` / `gbrain.write_origin` settings
 * (persistence/context.ts) and the BEFORE ROW trigger (trust/schema.ts) only
 * clamps it. The same value is what the write gate receives.
 */
import { opError } from '../ops/contract.ts';

export const TRUST_TIERS = [
  'user_confirmed', 'operator_curated', 'tool_observed', 'agent_written', 'unknown', 'external_untrusted',
] as const;
export type TrustTier = typeof TRUST_TIERS[number];

/** Larger is more trusted. Shared with the trigger SQL (trust/schema.ts) through `trustRankSql`. */
export const TRUST_TIER_RANK: Readonly<Record<TrustTier, number>> = Object.freeze({
  user_confirmed: 6, operator_curated: 5, tool_observed: 4, agent_written: 3, unknown: 2, external_untrusted: 1,
});

/** The fixed user-facing labels (DX-8). Enum names appear only in JSON. */
export const TRUST_TIER_LABELS: Readonly<Record<TrustTier, string>> = Object.freeze({
  user_confirmed: 'confirmed by you',
  operator_curated: 'your notes',
  tool_observed: 'tool data',
  agent_written: 'written by an agent',
  unknown: 'unverified origin',
  external_untrusted: 'external, untrusted',
});

/** Writers at or above this tier restamp a row on a content rewrite (CEO-12); lower writers can only lower it. */
export const OWNER_TIER_FLOOR: TrustTier = 'operator_curated';

export function isTrustTier(value: unknown): value is TrustTier {
  return typeof value === 'string' && Object.hasOwn(TRUST_TIER_RANK, value);
}

/** A tier named by a caller (CLI flag, op param, config value); anything else is `invalid_params` listing the accepted values. */
export function parseTrustTier(value: unknown, param = 'tier'): TrustTier {
  if (isTrustTier(value)) return value;
  throw opError('invalid_params', `${param} must be one of ${TRUST_TIERS.join(', ')}; got ${JSON.stringify(value)}.`,
    `Pass one of: ${TRUST_TIERS.join(', ')}.`);
}

/** Positive when `a` is more trusted than `b`, negative when less, 0 when equal. */
export function compareTrust(a: TrustTier, b: TrustTier): number {
  return TRUST_TIER_RANK[a] - TRUST_TIER_RANK[b];
}

/** The least trusted of the given tiers (taint, nesting, lowering). At least one tier is required. */
export function minTrust(first: TrustTier, ...rest: TrustTier[]): TrustTier {
  return rest.reduce((low, tier) => (TRUST_TIER_RANK[tier] < TRUST_TIER_RANK[low] ? tier : low), first);
}

/** The most trusted of the given tiers (the stricter of two read floors). */
export function maxTrust(first: TrustTier, ...rest: TrustTier[]): TrustTier {
  return rest.reduce((high, tier) => (TRUST_TIER_RANK[tier] > TRUST_TIER_RANK[high] ? tier : high), first);
}

/** CEO-13: `min_trust=floor` admits rows at or above the floor. */
export function admitsTrust(rowTier: TrustTier, floor: TrustTier): boolean {
  return TRUST_TIER_RANK[rowTier] >= TRUST_TIER_RANK[floor];
}

/** Every tier a `min_trust=floor` read admits, highest first (for SQL `= ANY($n)` filters). */
export function tiersAtOrAbove(floor: TrustTier): TrustTier[] {
  return TRUST_TIERS.filter(tier => admitsTrust(tier, floor));
}

export function trustLabel(tier: TrustTier): string {
  return TRUST_TIER_LABELS[tier];
}

/**
 * The label of an agent-written row whose agent declared `content_origin: "user_said"`, i.e. the user's own words relayed by
 * their agent. The tier stays agent_written (no authority raise); only the
 * wording changes, so models stop discounting the user's own preferences as
 * an agent's guess. Distinct from "confirmed by you" and "your notes". A
 * flagged (instruction-like, unconfirmed) row never gets it: it keeps
 * "unconfirmed, agent-written". The eval harness reads this constant.
 */
export const USER_SAID_TRUST_LABEL = 'you told your agent this (not yet confirmed)';
/** The marker appended to a user_said row's short origin (`mcp:remember:user_said`) on every read surface. */
export const USER_SAID_ORIGIN_MARKER = 'user_said';

/** A stored tier read back from the database; NULL (a legacy page_versions row) and unrecognized values read as `unknown`. */
export function storedTrustTier(value: unknown): TrustTier {
  return isTrustTier(value) ? value : 'unknown';
}

/**
 * A per-token read floor (`oauth_clients.min_trust`, `access_tokens.min_trust`,
 * CEO-18) read back at token verification: NULL means no floor; a value that
 * names no tier (a damaged row) fails closed to the strictest floor.
 */
export function storedMinTrust(value: unknown): TrustTier | undefined {
  if (value === null || value === undefined) return undefined;
  return isTrustTier(value) ? value : 'user_confirmed';
}

/** SQL expression mapping a tier-valued expression to its rank (unrecognized and NULL -> 0). */
export function trustRankSql(expr: string): string {
  return `(CASE ${expr} ${TRUST_TIERS.map(tier => `WHEN '${tier}' THEN ${TRUST_TIER_RANK[tier]}`).join(' ')} ELSE 0 END)`;
}

/** SQL expression mapping a rank expression back to its tier name. */
export function trustTierFromRankSql(expr: string): string {
  return `(CASE ${expr} ${TRUST_TIERS.map(tier => `WHEN ${TRUST_TIER_RANK[tier]} THEN '${tier}'`).join(' ')} ELSE 'unknown' END)`;
}

// ---------------------------------------------------------------------------
// Agent-declared content origin (DX-8, CEO-26)
// ---------------------------------------------------------------------------

export const CONTENT_ORIGINS = ['user_said', 'tool_output', 'inferred'] as const;
export type ContentOrigin = typeof CONTENT_ORIGINS[number];

/** `tool_output` lowers a write to external_untrusted; `user_said` never confers owner authority. */
export function contentOriginTier(value: unknown): TrustTier {
  if (value === 'tool_output') return 'external_untrusted';
  if (value === 'user_said' || value === 'inferred') return 'agent_written';
  throw opError('invalid_params', `content_origin must be one of ${CONTENT_ORIGINS.join(', ')}; got ${JSON.stringify(value)}.`,
    `Pass content_origin as one of: ${CONTENT_ORIGINS.join(', ')} (tool_output for text that came from a web page, email, file or other tool).`);
}

// ---------------------------------------------------------------------------
// The effective tier of one write (ENG-18), and its origin record (CEO-1)
// ---------------------------------------------------------------------------

export type TaintTable = 'facts' | 'takes' | 'pages' | 'timeline_entries';
export interface TaintInput { table: TaintTable; id: number | string; tier: TrustTier }

/** At most this many taint inputs are kept in `write_origin` (the 32 least trusted); complete edges live elsewhere (ENG-7). */
export const TAINT_INPUT_SAMPLE_LIMIT = 32;

/** Stored in `write_origin` (jsonb). `channel` names the write path, e.g. `mcp:put_page`, `sync`, `connector:google`. */
export interface WriteOrigin {
  channel: string;
  /** The agent's declared `content_origin` (validated at admission); `user_said` changes the read label, never the tier. */
  content_origin?: ContentOrigin;
  connector?: string;
  source_uri?: string;
  request_id?: string;
  taint_inputs?: TaintInput[];
  taint_inputs_truncated?: true;
  taint_input_count?: number;
}

/** What a writer declares to the attribution seam: the tier its rows get and why. */
export interface WriteTrust { tier: TrustTier; origin: WriteOrigin | null }

export interface WriteTrustInput {
  /** The tier the write channel earns (A3), e.g. agent_written for a remote MCP write. */
  channel: TrustTier;
  /** Lowering signals: content_origin, frontmatter markers, source trust settings. They can only lower. */
  lowerTo?: readonly TrustTier[];
  /** A model or rule derived this content from other rows: tier = min(inputs, agent_written) (A3, ENG-3). */
  derived?: boolean;
  /** Every input placed in the derivation's context (ENG-3). */
  inputs?: readonly TaintInput[];
  origin: Omit<WriteOrigin, 'taint_inputs' | 'taint_inputs_truncated' | 'taint_input_count'>;
}

/**
 * Computes the tier once. A derived write is capped at agent_written and at
 * the least trusted input; lowering signals apply last. The origin keeps a
 * bounded display sample of the inputs (least trusted first).
 */
export function effectiveWriteTrust(input: WriteTrustInput): WriteTrust {
  const inputs = input.inputs ?? [];
  const caps: TrustTier[] = [...(input.lowerTo ?? []), ...inputs.map(i => i.tier)];
  if (input.derived) caps.push('agent_written');
  const tier = minTrust(input.channel, ...caps);
  const origin: WriteOrigin = { ...input.origin };
  if (inputs.length) {
    const sample = [...inputs].sort((a, b) => compareTrust(a.tier, b.tier)).slice(0, TAINT_INPUT_SAMPLE_LIMIT);
    origin.taint_inputs = sample;
    if (inputs.length > TAINT_INPUT_SAMPLE_LIMIT) {
      origin.taint_inputs_truncated = true;
      origin.taint_input_count = inputs.length;
    }
  }
  return { tier, origin };
}

/** Combines a nested declaration with the enclosing one: a nested write can lower the tier, never raise it. */
export function nestWriteTrust(outer: WriteTrust | null, inner: WriteTrust): WriteTrust {
  if (!outer) return inner;
  return { tier: minTrust(outer.tier, inner.tier), origin: inner.origin ?? outer.origin };
}
