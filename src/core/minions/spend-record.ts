/**
 * The stored shape of `minion_jobs.spend_authorization` and its strict
 * parser. Dependency-free so the row mapper (types.ts) can use it; the
 * runtime (guard, producers, claim SQL) lives in spend-authorization.ts.
 */
import type { Effect } from '../agent-output.ts';
import type { Authorization, CapSource } from '../consent.ts';

export type SpendBasis = 'authorized' | 'legacy_default' | 'unrecorded' | 'invalid';

export interface SpendAuthorization {
  version: 1;
  kind: 'authorized' | 'legacy_default';
  group_id: string;
  /** Jobs the producer queued under this group. */
  of?: number;
  consented_effects?: Effect[];
  /** null only when `uncapped`. */
  cap_usd: number | null;
  uncapped?: true;
  cap_source: CapSource;
  via?: Authorization['via'];
  command: string;
  est_usd?: number;
  /** The producer's command without consent flags: the base of the resume command. */
  argv?: string[];
  authorized_at: string;
}

/** What a job's handler sees of its group (`ctx.spend`). */
export interface JobSpendContext {
  record: SpendAuthorization;
  budget_key: string;
}

const KINDS = new Set(['authorized', 'legacy_default']);
const CAP_SOURCES = new Set(['derived', 'default', 'user']);
const VIAS = new Set(['yes', 'max_usd', 'tokenmax', 'preapproval', 'apply_flag', 'non_interactive_flag', 'tty_prompt']);
const KEYS = new Set(['version', 'kind', 'group_id', 'of', 'consented_effects', 'cap_usd', 'uncapped', 'cap_source', 'via', 'command', 'est_usd', 'argv', 'authorized_at']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const strings = (v: unknown) => Array.isArray(v) && v.every(s => typeof s === 'string');

/**
 * Strict parser for the `minion_jobs.spend_authorization` column. Returns
 * null for SQL NULL and throws TypeError on any malformed or unknown shape:
 * a record is written only by trusted producers and the claim UPDATE.
 */
export function parseSpendAuthorization(raw: unknown): SpendAuthorization | null {
  if (raw == null) return null;
  const v = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new TypeError('spend_authorization is not an object');
  const r = v as Record<string, unknown>;
  const bad = (field: string) => new TypeError(`spend_authorization.${field} is invalid`);
  for (const k of Object.keys(r)) if (!KEYS.has(k)) throw bad(k);
  if (r.version !== 1) throw bad('version');
  if (typeof r.kind !== 'string' || !KINDS.has(r.kind)) throw bad('kind');
  if (typeof r.group_id !== 'string' || !UUID.test(r.group_id)) throw bad('group_id');
  if (r.of !== undefined && !(Number.isSafeInteger(r.of) && (r.of as number) > 0)) throw bad('of');
  if (r.consented_effects !== undefined && !strings(r.consented_effects)) throw bad('consented_effects');
  if (r.uncapped !== undefined && r.uncapped !== true) throw bad('uncapped');
  if (r.uncapped ? r.cap_usd !== null : !(typeof r.cap_usd === 'number' && Number.isFinite(r.cap_usd) && r.cap_usd > 0)) throw bad('cap_usd');
  if (typeof r.cap_source !== 'string' || !CAP_SOURCES.has(r.cap_source)) throw bad('cap_source');
  if (r.via !== undefined && (typeof r.via !== 'string' || !VIAS.has(r.via))) throw bad('via');
  if (typeof r.command !== 'string' || !r.command || r.command.length > 64) throw bad('command');
  if (r.est_usd !== undefined && !(typeof r.est_usd === 'number' && Number.isFinite(r.est_usd) && r.est_usd >= 0)) throw bad('est_usd');
  if (r.argv !== undefined && !strings(r.argv)) throw bad('argv');
  if (typeof r.authorized_at !== 'string' || Number.isNaN(Date.parse(r.authorized_at))) throw bad('authorized_at');
  return r as unknown as SpendAuthorization;
}

/** How a job's spend is governed, with the sentence `jobs get` and the basis log show. */
export function spendBasis(job: { spend_authorization?: SpendAuthorization | null; spend_authorization_invalid?: true }): { basis: SpendBasis; why: string } {
  const r = job.spend_authorization;
  if (job.spend_authorization_invalid) return { basis: 'invalid', why: 'The stored spend authorization is malformed, so the worker refuses to run this job; cancel it and run the producing command again.' };
  if (!r) return { basis: 'unrecorded', why: 'No submit-time spend authorization exists for this job; it runs under its producer\'s own budget (client daily budget, cycle budget, configured embedding caps or --max-usd), if any.' };
  const unmetered = r.cap_source === 'user' ? '' : ' A non-embedding model with no known price runs unmetered under this cap (it warns); capped embeddings require known pricing and a provider token ceiling.';
  if (r.uncapped) return { basis: r.kind, why: `The user authorized ${r.command} without a cost ceiling (${r.via ?? 'max_usd'}); spend is ledgered against group ${r.group_id}.` };
  if (r.kind === 'legacy_default') return { basis: r.kind, why: `This job was queued before submit-time authorization existed, so it runs under the $${r.cap_usd!.toFixed(2)} default cap. Re-run ${r.command} with --max-usd <usd> to authorize a different amount.${unmetered}` };
  return { basis: r.kind, why: `The user approved $${r.cap_usd!.toFixed(2)} (${r.cap_source}) for ${r.command}; every job of group ${r.group_id} shares that total.${unmetered}` };
}
