/**
 * loops-exclusion — the Gmail-label exclusion policy for the open-loop engine
 * (#5445). A user labels threads the engine must leave alone (mailbox warm-up
 * mail the owner's own address sends, automated outreach) and names those
 * labels per source (`g_loops_exclude_labels`, comma-separated label names or
 * ids) or brain-wide (`loops.extraction_exclude_labels`, the fallback when
 * the source sets nothing).
 *
 * The policy is resolved ONCE per sweep (`GmailClient.getLabels()` turns
 * names into ids) and the resolution is stored next to the source
 * (`op_checkpoints`, op `loops-exclusion`), so the two places that run
 * without a Gmail client, the paid `loops_extract` job and the due-grace-hold
 * publication, apply the policy that is current at THEIR time, not the one
 * current at enqueue: a label added after a job was queued still stops it.
 *
 * Fail closed: a label name the account does not have, or a label list that
 * could not be read, leaves the policy `unresolved`. While it is, no NEW paid
 * extraction runs for that source (`excluded_label_unresolved`, visible in
 * the sweep's eligibility counters and retried on the next sweep), and the
 * deterministic lane withholds new opens the same way. Closes, ingestion and
 * already-open loops are never touched by this policy.
 */
import type { BrainEngine } from '../engine.ts';
import { connectorStateKey } from '../persistence/connector-state.ts';
import type { GoogleSourceConfig } from './types.ts';

export const LOOPS_EXCLUDE_LABELS_CONFIG_KEY = 'loops.extraction_exclude_labels';
export const LOOPS_EXCLUSION_OP = 'loops-exclusion';

export interface LoopsExclusionPolicy {
  /** The configured tokens (names or ids), in config order, de-duplicated. */
  tokens: string[];
  /** Label ids the policy excludes. */
  ids: ReadonlySet<string>;
  /** Tokens that could not be matched to a label; non-empty means fail closed. */
  unresolved: string[];
}

/** The policy of a source with nothing configured. */
export const NO_EXCLUSION: LoopsExclusionPolicy = Object.freeze({ tokens: [], ids: new Set<string>(), unresolved: [] });

/** Gmail's fixed system label ids; every other id is a user label `Label_<n>`. */
const SYSTEM_LABEL_IDS = new Set(['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT', 'CHAT',
  'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS']);
/** A token that is certainly a label id, so it resolves without a catalog. */
const isLabelId = (token: string): boolean => /^Label_\d+$/.test(token) || SYSTEM_LABEL_IDS.has(token);

/** Splits a raw config value (comma-separated, or an array) into trimmed, de-duplicated tokens. */
export function parseExcludeLabelTokens(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(',') : [];
  return [...new Set(parts.map((t) => t.trim()).filter((t) => t.length > 0))];
}

/** The tokens in force for a source: its own `g_loops_exclude_labels`, else the brain-wide key. */
export async function excludedLabelTokens(engine: Pick<BrainEngine, 'getConfig'>, cfg: Pick<GoogleSourceConfig, 'loopsExcludeLabels'>): Promise<string[]> {
  if (cfg.loopsExcludeLabels && cfg.loopsExcludeLabels.length > 0) return [...cfg.loopsExcludeLabels];
  try {
    return parseExcludeLabelTokens(await engine.getConfig(LOOPS_EXCLUDE_LABELS_CONFIG_KEY));
  } catch {
    return [];
  }
}

/**
 * Matches tokens against the account's label catalog: an id token is kept
 * verbatim; a name token matches a label name case-insensitively. With no
 * catalog (the label list failed), only id-shaped tokens resolve and every
 * name stays unresolved.
 */
export function resolveExcludedLabels(tokens: string[], catalog: ReadonlyArray<{ id: string; name: string }> | null): LoopsExclusionPolicy {
  const ids = new Set<string>();
  const unresolved: string[] = [];
  const byId = new Set((catalog ?? []).map((l) => l.id));
  const byName = new Map((catalog ?? []).map((l) => [l.name.toLowerCase(), l.id] as const));
  for (const token of tokens) {
    if (byId.has(token)) { ids.add(token); continue; }
    const named = byName.get(token.toLowerCase());
    if (named !== undefined) { ids.add(named); continue; }
    if (catalog === null && isLabelId(token)) { ids.add(token); continue; }
    unresolved.push(token);
  }
  return { tokens: [...tokens], ids, unresolved };
}

/** Whether a thread carrying `labelIds` is excluded by the policy. */
export function isExcludedByLabels(policy: LoopsExclusionPolicy, labelIds: Iterable<string>): boolean {
  if (policy.ids.size === 0) return false;
  for (const id of labelIds) if (policy.ids.has(id)) return true;
  return false;
}

/** The label ids a rendered email page carries (`labels:` frontmatter). */
export function pageLabelIds(frontmatter: Record<string, unknown> | null | undefined): string[] {
  const labels = frontmatter?.labels;
  return Array.isArray(labels) ? labels.filter((l): l is string => typeof l === 'string') : [];
}

interface StoredResolution { version: 1; tokens: string[]; ids: string[]; unresolved: string[]; at: string }

async function resolutionKey(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<string | null> {
  const [row] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  return row ? connectorStateKey(sourceId, row.incarnation) : null;
}

/** Stores the sweep's resolution so the job handler and hold publication can apply it without a Gmail call. */
export async function storeLoopsExclusion(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, policy: LoopsExclusionPolicy): Promise<void> {
  const key = await resolutionKey(engine, sourceId);
  if (!key) return;
  const stored: StoredResolution = { version: 1, tokens: policy.tokens, ids: [...policy.ids], unresolved: policy.unresolved, at: new Date().toISOString() };
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,jsonb_build_array($3::text::jsonb))
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array($3::text::jsonb), updated_at=now()`,
  [LOOPS_EXCLUSION_OP, key, JSON.stringify(stored)]);
}

/**
 * The policy in force for a source right now, without a Gmail client: the
 * configured tokens, resolved through the sweep's stored resolution when it
 * was made for the same tokens. Tokens changed since the last sweep resolve
 * by id shape only; their names stay unresolved (fail closed) until a sweep
 * re-reads the label list.
 */
export async function loadLoopsExclusionPolicy(engine: Pick<BrainEngine, 'executeRaw' | 'getConfig'>, sourceId: string,
  cfg?: Pick<GoogleSourceConfig, 'loopsExcludeLabels'>): Promise<LoopsExclusionPolicy> {
  let sourceCfg = cfg;
  if (!sourceCfg) {
    const [row] = await engine.executeRaw<{ config: Record<string, unknown> | string | null }>('SELECT config FROM sources WHERE id=$1', [sourceId]);
    const raw = typeof row?.config === 'string' ? JSON.parse(row.config) as Record<string, unknown> : row?.config ?? {};
    sourceCfg = { loopsExcludeLabels: parseExcludeLabelTokens(raw.g_loops_exclude_labels) };
  }
  const tokens = await excludedLabelTokens(engine, sourceCfg);
  if (tokens.length === 0) return NO_EXCLUSION;
  const key = await resolutionKey(engine, sourceId);
  const [row] = key ? await engine.executeRaw<{ stored: StoredResolution | null }>(
    'SELECT completed_keys->0 AS stored FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [LOOPS_EXCLUSION_OP, key]) : [];
  const stored = row?.stored;
  if (stored?.version === 1 && sameTokens(stored.tokens, tokens)) {
    return { tokens, ids: new Set(stored.ids), unresolved: [...stored.unresolved] };
  }
  return resolveExcludedLabels(tokens, null);
}

function sameTokens(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}
