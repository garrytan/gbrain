/**
 * One turn: `resolveSkills(input)` reads the catalog index(es), ranks the
 * message, applies the session's no-repeat and budget rules and renders the
 * block. It never rebuilds and never opens a brain. It touches the network
 * only for the skill vectors and the model picker below; without them its
 * output outside `meta` is byte-identical for the same index, input and
 * session state. Committing the session state is the caller's
 * second step (`result.commit()`), taken only after the block was
 * delivered.
 *
 * Session rules (one state per session across every merged catalog):
 *  - k shrinks as the budget drains: top_k, then at most 3 once half is
 *    spent, then 1 once 80% is spent;
 *  - once half is spent, only a turn whose top result matched on name,
 *    triggers or routing (or names a skill explicitly) spends any of it;
 *  - a skill suggested once is not suggested again, except once more when
 *    it ranks first with a name, trigger or routing match at least 10 turns
 *    later, or whenever the turn names it explicitly;
 *  - when nothing new is in the top k the block is empty; when no new line
 *    fits what is left of the budget, budget_exhausted is true, but a skill
 *    the turn names explicitly still gets its line (its tokens still count).
 *
 * min_match_strength drops weaker matches before the cut to k, so a floor
 * never shrinks the block below what the stronger matches fill: it filters
 * candidates and does not gate the block. top_gate (TOP_GATE_DEFAULT unless
 * set; 0 turns it off) does: when the best skill the block would show (after exclude,
 * min_match_strength, session dedupe and pacing) scores below it over its
 * catalog's maxIdf, the block is empty (block_reason weak_top_match), unless
 * the turn names a skill. A message that matches no catalog word falls back to
 * previous_user_message.
 *
 * The model picker (router.ts) runs only when the caller passes
 * opts.router and skills.resolver.router is on: after the acknowledgement
 * check, it reads the catalog (every skill up to PICKER_FULL_CATALOG_MAX,
 * else the top PICKER_SHORTLIST ranked) and its picks fill the block in its
 * order, match_strength picked, under the same exclude, floor, dedupe,
 * pacing and budget rules (top_gate does not apply to them). Its "no skill"
 * answer empties the block (no_match). When it cannot answer, the turn is
 * the word matcher's. Only then is the output not byte-identical across
 * runs; `router` reports which answered and why.
 *
 * Skill vectors (vectors.ts): when a catalog has a vectors.bin made by the
 * brain's current embedder (config.json embedding_model) and its key is
 * configured, the turn embeds the message once (at most VECTOR_WAIT_MS, or
 * inside the picker's wait when the picker is on, and never closer to the
 * caller's deadline than VECTOR_DEADLINE_RESERVE_MS) and ranks that catalog by
 * the reciprocal rank fusion of its word ranking and its cosine list (skills
 * at or above the model's cosine floor). The fused order is what the block
 * shows when the picker is off or cannot answer, and the picker's shortlist
 * above PICKER_FULL_CATALOG_MAX (there, every skill's cosine counts). With
 * vectors the no-skill gate is the cosine floor: the block shows only when a
 * skill it holds from a catalog with vectors is at or above it (a skill from
 * a catalog without vectors keeps top_gate). A network result changes the
 * ranking, so the output is not byte-identical across runs either; `vectors`
 * reports whether they were used and why not.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { VERSION } from '../../../version.ts';
import { BLOCK_TOKEN_CAP, BLOCK_TOKENIZER, HARNESSES, renderBlock, type BlockLine } from './block.ts';
import type { BuildReceipt } from './build.ts';
import { dirFingerprintSlice, listCatalogs, readReceipt } from './catalog-files.ts';
import { readResolverSettings, type ResolverSettings, validateSessionTokenBudget } from './config.ts';
import { ResolverError } from './errors.ts';
import { appendDailyLogSync, RESOLVER_LOG } from './daily-log.ts';
import { ensureDir, writeFileAtomic } from './fsutil.ts';
import { EXCLUDE_MAX, MATCH_STRENGTHS, type MatchStrength, STRENGTH_FIELDS, TOP_GATE_DEFAULT, TOP_GATE_MAX, TOP_K_DEFAULT, TOP_K_MAX } from './limits.ts';
import { IndexReader, RANKER_ID, RANKER_VERSION } from './index-format.ts';
import { assertCatalogName, catalogFile, logsDir, resolverHome } from './paths.ts';
import { isAcknowledgement, maxIdf, mentionsSkill, rankIndex, reasonText, type Ranked, type RankResult } from './rank.ts';
import { commitSession, freshState, loadSession, sessionKey, type SessionState, type TurnDelta } from './session.ts';
import { PICKER_FULL_CATALOG_MAX, PICKER_SHORTLIST, pickSkills, routerTimeoutMs, type PickerSkill, type PickOutcome, type RouterFallbackCode } from './router.ts';
import { readBounded } from './fsutil.ts';
import { cosine, embedQuery, readCatalogVectors, RRF_K, turnEmbedder, vectorFloor, vectorsOutdated, VECTOR_DEADLINE_RESERVE_MS, VECTOR_WAIT_MS, type CatalogVectors, type EmbedSkipCode, type QueryOutcome } from './vectors.ts';

export const SCHEMA_VERSION = 1;
export const MESSAGE_CAP_BYTES = 8192;
export { EXCLUDE_MAX, MATCH_STRENGTHS, TOP_K_DEFAULT, TOP_K_MAX, type MatchStrength };
export const RESUGGEST_AFTER_TURNS = 10;
export const STAT_CHECK_INTERVAL_MS = 60_000;
/** Stat calls one turn may spend on the freshness sweep; a larger catalog is swept over several turns. */
export const STAT_CHECK_SLICE = 1024;

export interface TurnInput {
  message: string;
  previous_user_message?: string;
  session_id?: string;
  harness?: string;
  top_k?: number;
  exclude?: string[];
  shadow?: boolean;
  expected_catalog_hash?: string;
  reset_session?: boolean;
  min_match_strength?: MatchStrength;
  top_gate?: number;
}

export interface Suggestion { id: string; name: string; score: number; summary: string; reason: string; match_strength: MatchStrength; path?: string; catalog: string }
export interface TurnError { code: string; message: string; fix: { suggestion: string; command?: string } }
/** Why a block is empty; null when it has a suggestion. */
export type BlockReason = 'ack' | 'no_match' | 'filtered' | 'weak_top_match' | 'deduped' | 'paced' | 'budget_exhausted' | 'shadow' | 'error';
/** Set when the model picker was on for the turn: who answered, with which model, how long it waited, its estimated cost, and why it did not answer. */
export interface RouterReport { mode: 'picker'; answered_by: 'picker' | 'words'; model: string | null; ms: number; est_usd: number; fallback: { code: RouterFallbackCode } | null }
/** Set when a catalog of the turn has skill vectors: whether the turn ranked with them, the embedder, how long it waited for the message's vector, and why it did without. */
export interface VectorsReport { used: boolean; model: string | null; ms: number; fallback: { code: EmbedSkipCode } | null }
export interface TurnOutput {
  schema_version: 1;
  gbrain_version: string;
  catalog: string | null;
  catalog_hash: string | null;
  index_hash: string | null;
  ranker: { id: string; version: number; variant: string | null; k: number };
  no_skill: boolean;
  no_skill_reason: 'ack' | 'no_match' | null;
  budget_exhausted: boolean;
  block_reason: BlockReason | null;
  suggestions: Suggestion[];
  block: string;
  block_tokens: number;
  tokenizer: string;
  deduped: string[];
  shadow: boolean;
  error?: TurnError;
  router?: RouterReport;
  vectors?: VectorsReport;
  meta: { timing_ms: number; index_age_s: number | null; index_stale: boolean };
}

export interface ResolveOptions {
  home?: string;
  catalogs?: string[];
  failOpen?: boolean;
  deadlineMs?: number;
  sessionTokenBudget?: number;
  loadHint?: string;
  /** OpenClaw: the only directory the agent may read files from by path; a suggestion outside it leads the load line with skills_read. */
  readRoot?: string;
  /** OpenClaw: 'others' for a turn outside the agent owner's own sessions. An `audience: owner` skill is never offered then, and a catalog built before audiences were recorded offers nothing until it is rebuilt. */
  audience?: 'owner' | 'others';
  /** Skill ids the host hides from the agent (the caller's own list, not the turn's, so EXCLUDE_MAX does not cut it). */
  hidden?: readonly string[];
  namesOnly?: boolean;
  explainTarget?: string;
  /** Let the turn call the model picker when skills.resolver.router is on. Only the command line and the Claude Code and Codex hook lanes pass it. */
  router?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface Explain {
  target: string;
  indexed: boolean;
  catalog: string | null;
  rank: number | null;
  score: number | null;
  fields: Record<string, string[]>;
  excluded: boolean;
  deduped: boolean;
  in_block: boolean;
  skip_reason: string | null;
  session: { turn: number; spent: number; budget: number; remaining: number } | null;
  /** With skill vectors in the turn: the target's cosine with the message and its catalog's floor. `rank` and `score` stay the word ranking's. */
  vector?: { cosine: number; floor: number };
}

export interface ResolveResult {
  output: TurnOutput;
  /** Shadow mode: the output the on arm would have produced (block included); `output` injects nothing. */
  shadowOutput?: TurnOutput;
  explain?: Explain;
  /** Set when a runtime error was turned into an empty result (failOpen). */
  failOpen?: boolean;
  /** Commit this turn's session state; call only after the block was delivered. */
  commit(): Promise<boolean>;
  /** What commit() would apply, for a caller that commits on another thread (the hook lane): null when there is no session to commit. */
  pending?: { key: string; delta: TurnDelta } | null;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

function invalid(message: string, suggestion: string): ResolverError {
  return new ResolverError('skill_resolve_invalid_input', message, { suggestion });
}

function capUtf8(s: string, max: number): string {
  const b = Buffer.from(s, 'utf8');
  return b.length <= max ? s : b.subarray(0, max).toString('utf8').replace(/\uFFFD+$/, '');
}

export function normalizeTurnInput(raw: unknown): Required<Pick<TurnInput, 'message' | 'top_k' | 'exclude' | 'shadow' | 'reset_session'>> & TurnInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('The turn input must be a JSON object.', 'Send {"message": "..."} (see docs/schemas/skill-resolver.v1.turn-input.json).');
  const o = raw as Record<string, unknown>;
  const known = new Set(['message', 'previous_user_message', 'session_id', 'harness', 'top_k', 'exclude', 'shadow', 'expected_catalog_hash', 'reset_session', 'min_match_strength', 'top_gate']);
  const extra = Object.keys(o).find(k => !known.has(k));
  if (extra) throw invalid(`Unknown turn input field "${extra}".`, 'Use only the fields in docs/schemas/skill-resolver.v1.turn-input.json.');
  if (typeof o.message !== 'string') throw invalid('message is required and must be a string.', 'Send the user message as "message".');
  if (o.previous_user_message !== undefined && typeof o.previous_user_message !== 'string') throw invalid('previous_user_message must be a string.', 'Send a string or omit it.');
  if (o.session_id !== undefined && (typeof o.session_id !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(o.session_id))) throw invalid('session_id must be 1-256 visible ASCII characters.', "Pass the harness's session id.");
  if (o.harness !== undefined && !(HARNESSES as readonly unknown[]).includes(o.harness)) throw invalid(`harness must be one of ${HARNESSES.join(', ')}.`, 'Pass a supported harness, or omit it and use --load-hint.');
  if (o.top_k !== undefined && (!Number.isInteger(o.top_k) || (o.top_k as number) < 1 || (o.top_k as number) > TOP_K_MAX)) throw invalid(`top_k must be an integer from 1 to ${TOP_K_MAX}.`, 'Omit it for the default of 5.');
  if (o.exclude !== undefined && (!Array.isArray(o.exclude) || o.exclude.length > EXCLUDE_MAX || o.exclude.some(x => typeof x !== 'string' || x.length > 256))) throw invalid(`exclude must be at most ${EXCLUDE_MAX} skill ids.`, 'Pass the ids already loaded this turn.');
  if (o.shadow !== undefined && typeof o.shadow !== 'boolean') throw invalid('shadow must be a boolean.', 'Pass true or false.');
  if (o.reset_session !== undefined && typeof o.reset_session !== 'boolean') throw invalid('reset_session must be a boolean.', 'Pass true on the first turn after a compaction.');
  if (o.min_match_strength !== undefined && !(MATCH_STRENGTHS as readonly unknown[]).includes(o.min_match_strength)) throw invalid(`min_match_strength must be one of ${MATCH_STRENGTHS.join(', ')}.`, 'Omit it to keep every match, or pass description to drop body-only matches.');
  if (o.top_gate !== undefined && (typeof o.top_gate !== 'number' || !Number.isFinite(o.top_gate) || o.top_gate < 0 || o.top_gate > TOP_GATE_MAX)) throw invalid(`top_gate must be a number from 0 to ${TOP_GATE_MAX}.`, 'Omit it for the default gate, or pass 0 to turn the gate off.');
  if (o.expected_catalog_hash !== undefined && (typeof o.expected_catalog_hash !== 'string' || !/^[0-9a-f]{64}$/.test(o.expected_catalog_hash))) throw invalid('expected_catalog_hash must be a sha256 hex string.', 'Pass the catalog_hash from the build receipt.');
  return {
    message: capUtf8(o.message, MESSAGE_CAP_BYTES),
    ...(typeof o.previous_user_message === 'string' ? { previous_user_message: capUtf8(o.previous_user_message, MESSAGE_CAP_BYTES) } : {}),
    ...(o.session_id !== undefined ? { session_id: o.session_id as string } : {}),
    ...(o.harness !== undefined ? { harness: o.harness as string } : {}),
    top_k: (o.top_k as number | undefined) ?? TOP_K_DEFAULT,
    exclude: (o.exclude as string[] | undefined) ?? [],
    shadow: o.shadow === true,
    reset_session: o.reset_session === true,
    ...(o.expected_catalog_hash !== undefined ? { expected_catalog_hash: o.expected_catalog_hash as string } : {}),
    ...(o.min_match_strength !== undefined ? { min_match_strength: o.min_match_strength as MatchStrength } : {}),
    ...(o.top_gate === undefined ? { top_gate: TOP_GATE_DEFAULT } : o.top_gate ? { top_gate: o.top_gate as number } : {}),
  };
}

/** A catalog's receipt and open index: what a turn reads once per catalog, and what a warm handle keeps between turns. */
export interface OpenedCatalog { name: string; receipt: BuildReceipt; ix: IndexReader; publishing: boolean }
interface Loaded extends OpenedCatalog { stale: string | null }

/** Where a turn gets its settings and catalogs: the cold path reads them every turn, a warm handle (handle.ts) keeps them. */
export interface TurnSource {
  settings(home: string, env?: NodeJS.ProcessEnv): ResolverSettings;
  open(home: string, name: string): OpenedCatalog;
  /** Called once per turn with every catalog it opened. */
  done(opened: OpenedCatalog[]): void;
}

const COLD: TurnSource = { settings: readResolverSettings, open: openCatalogIndex, done: opened => { for (const c of opened) c.ix.close(); } };
const STAT_TIER_KINDS: readonly string[] = ['dir', 'claude_plugins'];

function defaultCatalogs(home: string): string[] {
  const all = listCatalogs(home);
  if (all.length === 1) return all;
  if (all.length === 0) throw new ResolverError('skill_index_missing', 'No skill catalog has been built yet.', { suggestion: 'Build one: gbrain skills index build --catalog <name> --dir <skills dir> (or --bundled, or --from-json <file>).', argv: ['gbrain', 'skills', 'index', 'build', '--help'] });
  throw new ResolverError('skill_catalog_unknown', `Several catalogs exist (${all.join(', ')}); pick one with --catalog.`, { suggestion: `Pass --catalog with one of: ${all.join(', ')}.` }, { catalogs: all.join(',') });
}

/** Read a catalog's receipt and open its index; throws the turn's refusal when either is missing or incompatible. */
export function openCatalogIndex(home: string, name: string): OpenedCatalog {
  let receipt = readReceipt(home, name);
  if (!receipt) {
    if (existsSync(catalogFile(home, name, 'index.bin'))) throw new ResolverError('skill_index_incompatible', `The catalog "${name}" has an index but no readable receipt.`, { suggestion: 'Rebuild it with gbrain skills index build.' }, { catalog: name });
    throw new ResolverError('skill_index_missing', `The catalog "${name}" has not been built.`, { suggestion: `Build it: gbrain skills index build --catalog ${name} --dir <skills dir> (or --bundled, or --from-json <file>).` }, { catalog: name });
  }
  const fix = receipt.build?.rebuild_argv ?? undefined;
  if (receipt.schema_version !== 1 || receipt.ranker?.id !== RANKER_ID || receipt.ranker?.version !== RANKER_VERSION) {
    throw new ResolverError('skill_index_incompatible', `The catalog "${name}" was built by an incompatible gbrain (receipt schema ${receipt.schema_version}, ranker ${receipt.ranker?.id} v${receipt.ranker?.version}).`,
      fix ? { suggestion: 'Rebuild it with the command it was built with.', argv: fix } : { suggestion: 'The adapter that owns this catalog rebuilds it by passing a new snapshot to gbrain skills index build --from-json -.' }, { catalog: name });
  }
  const ix = IndexReader.open(catalogFile(home, name, 'index.bin'), fix);
  let publishing = false;
  try {
    const size = statSync(catalogFile(home, name, 'index.bin')).size;
    if (size !== receipt.index.size) {
      const again = readReceipt(home, name);
      if (again && again.index.size === size) receipt = again; else publishing = true;
    }
  } catch (e) { ix.close(); throw e; }
  return { name, receipt, ix, publishing };
}

/**
 * The turn's staleness verdict for an opened catalog: publishing, a gbrain
 * version skew, or (directory catalogs) one slice of the stat sweep. A stale
 * catalog gbrain can rebuild gets stale.stamp once (no fsync; an existing
 * stamp is left alone); an adapter-owned stdin catalog never does.
 */
function turnStaleness(home: string, c: OpenedCatalog, now: number, autoRebuild: boolean, want: () => string | null): string | null {
  const { name, receipt } = c;
  let stale: string | null = c.publishing ? 'publishing' : null;
  if (!stale && receipt.gbrain_version !== VERSION) stale = 'gbrain_version_changed';
  if (!stale && STAT_TIER_KINDS.includes(receipt.catalog.source.kind)) {
    const stamp = catalogFile(home, name, 'stat-check');
    let last: { verdict: 'fresh' | 'stale'; cursor: number } | null = null;
    let age = Infinity;
    try { age = now - statSync(stamp).mtimeMs; last = JSON.parse(readFileSync(stamp, 'utf8')); } catch { /* none or unreadable: sweep from the start */ }
    if (last?.verdict === 'stale') stale = 'source_changed';
    else if (!(last?.verdict === 'fresh' && last.cursor === 0 && age < STAT_CHECK_INTERVAL_MS)) {
      const slice = dirFingerprintSlice(home, name, last?.verdict === 'fresh' ? last.cursor : 0, STAT_CHECK_SLICE);
      stale = slice.changed ? 'source_changed' : null;
      try { writeFileAtomic(stamp, JSON.stringify({ verdict: slice.changed ? 'stale' : 'fresh', cursor: slice.changed ? 0 : slice.next })); } catch { /* read-only home: check again next turn */ }
    }
  }
  if (!stale && vectorsOutdated(receipt, now, want)) stale = 'vectors_changed';
  if (stale) stampStale(home, c, stale, autoRebuild);
  return stale;
}

/** Leave stale.stamp (once) on a catalog gbrain can rebuild, so the lane schedules its rebuild. */
function stampStale(home: string, c: OpenedCatalog, reason: string, autoRebuild: boolean): void {
  if (!autoRebuild || !c.receipt.build?.rebuild_argv) return;
  const stamp = catalogFile(home, c.name, 'stale.stamp');
  if (!existsSync(stamp)) { try { writeFileAtomic(stamp, `${JSON.stringify({ reason })}\n`); } catch { /* best effort */ } }
}

function emptyOutput(input: { shadow?: boolean }, extra: Partial<TurnOutput>): TurnOutput {
  return {
    schema_version: 1, gbrain_version: VERSION, catalog: null, catalog_hash: null, index_hash: null,
    ranker: { id: RANKER_ID, version: RANKER_VERSION, variant: null, k: 0 },
    no_skill: false, no_skill_reason: null, budget_exhausted: false, block_reason: extra.error ? 'error' : null, suggestions: [], block: '', block_tokens: 0, tokenizer: BLOCK_TOKENIZER,
    deduped: [], shadow: Boolean(input.shadow), meta: { timing_ms: 0, index_age_s: null, index_stale: false }, ...extra,
  };
}

/** The turn output for a runtime error: no suggestions, block "", `error` set. */
export function errorTurnOutput(err: ResolverError, opts: { shadow?: boolean; catalog?: string | null } = {}): TurnOutput {
  const hash = err.code === 'skill_catalog_mismatch' && typeof err.context.catalog_hash === 'string' ? err.context.catalog_hash : null;
  return emptyOutput({ shadow: opts.shadow }, { error: err.toJSON(), catalog: opts.catalog ?? null, catalog_hash: hash });
}

/** Time the picker leaves the turn for its own steps after the call (window, render). */
const PICKER_RENDER_RESERVE_MS = 20;
const PICKER_FILE_CAP_BYTES = 16 * 1024 * 1024;

/** A catalog's picker.json descriptions by id, or null when it is missing or from another build (the index's summaries are used then). */
function readPickerDescriptions(home: string, c: OpenedCatalog): Map<string, string> | null {
  try {
    const b = readBounded(catalogFile(home, c.name, 'picker.json'), PICKER_FILE_CAP_BYTES);
    if (b === 'too_large') return null;
    const j = JSON.parse(b.toString('utf8')) as { v?: unknown; catalog_hash?: unknown; skills?: unknown };
    return j?.v === 1 && j.catalog_hash === c.receipt.catalog.catalog_hash && Array.isArray(j.skills) ? new Map(j.skills as [string, string][]) : null;
  } catch { return null; } // silent-read-ok: a catalog built before picker.json existed has none; the picker uses each skill's index summary
}

function logUnexpected(home: string, e: unknown): void {
  try {
    const dir = logsDir(home);
    ensureDir(dir);
    const err = e as Error;
    appendDailyLogSync(dir, RESOLVER_LOG, `${JSON.stringify({ at: new Date().toISOString(), version: VERSION, name: err?.name ?? typeof e, stack: String(err?.stack ?? '').split('\n').slice(1, 6).map(l => l.trim()) })}\n`);
  } catch { /* logging never fails a turn */ }
}

/** Resolve one turn. Throws ResolverError on a usage error always, and on a runtime error unless failOpen. */
export async function resolveSkills(rawInput: TurnInput | unknown, opts: ResolveOptions = {}): Promise<ResolveResult> {
  return runTurn(rawInput, opts, COLD);
}

/** One turn over a TurnSource: resolveSkills with the cold source, a warm handle with its own. */
export async function runTurn(rawInput: TurnInput | unknown, opts: ResolveOptions, source: TurnSource): Promise<ResolveResult> {
  const t0 = performance.now();
  const input = normalizeTurnInput(rawInput);
  let home: string;
  try { home = opts.home ?? resolverHome(opts.env); } catch (e) { throw new ResolverError('skill_resolver_config_invalid', (e as Error).message, { suggestion: 'Set GBRAIN_HOME to an absolute path without .. segments, or unset it.' }); }
  try {
    return await resolveInner(input, opts, home, t0, source);
  } catch (e) {
    const err = e instanceof ResolverError ? e : new ResolverError('skill_resolver_internal', 'The skill resolver failed unexpectedly; a scrubbed trace was written under skill-index/logs/.', { suggestion: 'Run gbrain skills index status and report the trace if it repeats.', argv: ['gbrain', 'skills', 'index', 'status', '--json'] });
    if (!(e instanceof ResolverError)) logUnexpected(home, e);
    if (!opts.failOpen || err.usage) throw err;
    const output = errorTurnOutput(err, { shadow: input.shadow, catalog: opts.catalogs?.length === 1 ? opts.catalogs[0]! : null });
    output.meta.timing_ms = round4(performance.now() - t0);
    return { output, failOpen: true, commit: async () => false };
  }
}

async function resolveInner(input: ReturnType<typeof normalizeTurnInput>, opts: ResolveOptions, home: string, t0: number, source: TurnSource): Promise<ResolveResult> {
  const now = (opts.now ?? Date.now)();
  const check = opts.deadlineMs === undefined ? () => {} : () => {
    if (performance.now() - t0 > opts.deadlineMs!) throw new ResolverError('skill_resolve_timeout', `The resolver ran past its ${opts.deadlineMs} ms deadline; nothing was committed.`, { suggestion: 'The turn proceeds without a block; check the index size with gbrain skills index status.' });
  };
  const settings = source.settings(home, opts.env);
  const budget = opts.sessionTokenBudget === undefined ? settings.sessionTokenBudget : validateSessionTokenBudget(opts.sessionTokenBudget, 'sessionTokenBudget');
  const names = opts.catalogs?.length ? [...new Set(opts.catalogs.map(assertCatalogName))] : defaultCatalogs(home);
  const loaded: Loaded[] = [];
  const env = opts.env ?? process.env;
  let wanted: string | null | undefined;
  const want = () => {
    if (wanted === undefined) { const f = turnEmbedder(home, env); wanted = 'skip' in f || vectorFloor(f.embedder.model) === null ? null : f.embedder.model; }
    return wanted;
  };
  try {
    for (const n of names) { const l: Loaded = { ...source.open(home, n), stale: null }; loaded.push(l); l.stale = turnStaleness(home, l, now, settings.autoRebuild, want); check(); }
    const single = loaded.length === 1 ? loaded[0]! : null;
    const catalog = loaded.map(l => l.name).join('+');
    const catalogHash = single ? single.receipt.catalog.catalog_hash : sha(JSON.stringify(loaded.map(l => [l.name, l.receipt.catalog.catalog_hash])));
    const indexHash = single ? single.receipt.index.index_hash : sha(JSON.stringify(loaded.map(l => [l.name, l.receipt.index.index_hash])));
    const variant = loaded.map(l => l.receipt.ranker.variant).join('+');
    if (input.expected_catalog_hash !== undefined && input.expected_catalog_hash !== catalogHash) {
      throw new ResolverError('skill_catalog_mismatch', `The catalog "${catalog}" was built from a different skill list than the caller expects (expected ${input.expected_catalog_hash.slice(0, 12)}, index has ${catalogHash.slice(0, 12)}).`,
        { suggestion: 'Rebuild the catalog from the current skill list (an adapter passes its new snapshot to gbrain skills index build --from-json -), then retry.' }, { catalog, catalog_hash: catalogHash });
    }
    const oldest = Math.min(...loaded.map(l => Date.parse(l.receipt.build.built_at)));
    const meta = { timing_ms: 0, index_age_s: Number.isFinite(oldest) ? Math.max(0, Math.floor((now - oldest) / 1000)) : null, index_stale: loaded.some(l => l.stale !== null) };
    const scope = input.shadow ? 'shadow' : 'on';
    const key = input.session_id ? sessionKey(scope, input.harness, input.session_id) : null;
    const state: SessionState = key && !input.reset_session ? loadSession(home, key) : freshState();
    const turnNo = state.turn + 1;
    const spentFrac = budget === 0 ? 1 : state.spent / budget;
    const kEff = spentFrac < 0.5 ? input.top_k : spentFrac < 0.8 ? Math.min(input.top_k, 3) : 1;
    const base: TurnOutput = {
      ...emptyOutput(input, {}), catalog, catalog_hash: catalogHash, index_hash: indexHash,
      ranker: { id: RANKER_ID, version: RANKER_VERSION, variant, k: kEff }, meta, budget_exhausted: budget === 0 || state.spent >= budget,
    };
    const finish = (out: TurnOutput, delta: { tokens: number; suggested: string[]; resuggested: string[] }, explain?: Explain): ResolveResult => {
      out.meta.timing_ms = round4(performance.now() - t0);
      const pending = key ? { key, delta: { ...delta, reset: input.reset_session } } : null;
      const commit = async () => (pending ? commitSession(home, pending.key, pending.delta) : false);
      if (!input.shadow) return { output: out, ...(explain ? { explain } : {}), commit, pending };
      const quiet: TurnOutput = { ...out, block_reason: 'shadow', suggestions: [], block: '', block_tokens: 0, deduped: [], shadow: true };
      return { output: quiet, shadowOutput: { ...out, shadow: true }, ...(explain ? { explain } : {}), commit, pending };
    };

    if (isAcknowledgement(input.message)) return finish({ ...base, no_skill: true, no_skill_reason: 'ack', block_reason: 'ack' }, { tokens: 0, suggested: [], resuggested: [] });
    const others = opts.audience === 'others';
    const unrecorded = others ? loaded.filter(l => l.receipt.catalog.audiences !== 1) : [];
    if (unrecorded.length) {
      for (const l of unrecorded) stampStale(home, l, 'audiences_missing', settings.autoRebuild);
      base.meta.index_stale = true;
      return finish({ ...base, no_skill: true, no_skill_reason: 'no_match', block_reason: 'no_match' }, { tokens: 0, suggested: [], resuggested: [] });
    }

    const pickerOn = Boolean(opts.router && settings.router.on);
    const total = loaded.reduce((n, l) => n + l.ix.n, 0);
    const waitStart = performance.now();
    const leftNow = () => (opts.deadlineMs === undefined ? Infinity : opts.deadlineMs - (performance.now() - t0) - PICKER_RENDER_RESERVE_MS);
    let vecs: (CatalogVectors | null)[] = [];
    let query: Promise<QueryOutcome> | null = null;
    const cancelQuery = new AbortController();
    if (loaded.some(l => l.receipt.vectors && 'model' in l.receipt.vectors)) {
      const found = turnEmbedder(home, env);
      const t = 'skip' in found || vectorFloor(found.embedder.model) !== null ? found : { skip: 'unmeasured_model' as const };
      const report: VectorsReport = { used: false, model: 'skip' in t ? null : t.embedder.model, ms: 0, fallback: 'skip' in t ? { code: t.skip } : null };
      base.vectors = report;
      if (!('skip' in t)) {
        vecs = loaded.map(l => (l.receipt.vectors && 'model' in l.receipt.vectors ? readCatalogVectors(catalogFile(home, l.name, 'vectors.bin'), l.receipt.catalog.catalog_hash, t.embedder.model) : null));
        if (!vecs.some(Boolean)) report.fallback = { code: 'stale_vectors' };
        else query = embedQuery(t.embedder, t.key, input.message, Math.min(pickerOn ? routerTimeoutMs(input.harness, settings.router) / (total > PICKER_FULL_CATALOG_MAX ? 2 : 1) : VECTOR_WAIT_MS, leftNow() - VECTOR_DEADLINE_RESERVE_MS), cancelQuery.signal);
      }
      check();
    }

    const rankText = (text: string): RankResult[] => loaded.map(l => { const r = rankIndex(l.ix, text, check); check(); return r; });
    let ranks = rankText(input.message);
    if (ranks.every(r => r.idfSum === 0) && input.previous_user_message?.trim()) ranks = rankText(input.previous_user_message);
    const metaOf = (c: number, doc: number) => loaded[c]!.ix.meta(doc);

    const cos: (Float64Array | null)[] = loaded.map(() => null);
    const awaitVectors = async () => {
      if (!query) return;
      const q = await query;
      query = null;
      const report = base.vectors!;
      report.ms = q.ms;
      if (!q.ok) { report.fallback = { code: q.code }; return; }
      loaded.forEach((l, c) => {
        const v = vecs[c];
        if (!v) return;
        if (v.dims !== q.vector.length) { stampStale(home, l, 'vectors_changed', settings.autoRebuild); base.meta.index_stale = true; return; }
        const a = new Float64Array(l.ix.n).fill(-1);
        for (let d = 0; d < l.ix.n; d++) { const row = v.rows.get(metaOf(c, d).id); if (row) a[d] = cosine(row, q.vector); }
        cos[c] = a;
      });
      report.used = cos.some(Boolean);
      if (!report.used) report.fallback = { code: 'stale_vectors' };
      check();
    };
    const floorFor = (base.vectors?.model ? vectorFloor(base.vectors.model) : null) ?? Infinity;
    const fused = (c: number, floor: number): Ranked[] => {
      const a = cos[c];
      const words = ranks[c]!.ranked;
      if (!a) return words;
      const ix = loaded[c]!.ix;
      const name = (d: number) => ix.meta(d).name;
      const id = (d: number) => ix.meta(d).id;
      const tie = (x: number, y: number) => (name(x) < name(y) ? -1 : name(x) > name(y) ? 1 : id(x) < id(y) ? -1 : id(x) > id(y) ? 1 : 0);
      const close: number[] = [];
      for (let d = 0; d < ix.n; d++) if (a[d]! >= floor) close.push(d);
      close.sort((x, y) => a[y]! - a[x]! || tie(x, y));
      const score = new Map<number, number>();
      const wordAt = new Map<number, Ranked>();
      words.forEach((r, i) => { score.set(r.doc, 1 / (RRF_K + i)); wordAt.set(r.doc, r); });
      close.forEach((d, i) => score.set(d, (score.get(d) ?? 0) + 1 / (RRF_K + i)));
      return [...score.keys()].sort((x, y) => score.get(y)! - score.get(x)! || tie(x, y)).map(d => wordAt.get(d) ?? { doc: d, score: 0, norm: 0 });
    };

    const offered = new Map<string, { c: number; doc: number }>();
    let pick: Extract<PickOutcome, { ok: true }> | null = null;
    if (pickerOn) {
      const descriptions = loaded.map(l => readPickerDescriptions(home, l));
      const offer = (c: number, doc: number) => { const m = metaOf(c, doc); if (!m.dep && !(others && m.aud) && !offered.has(m.id)) offered.set(m.id, { c, doc }); };
      if (total <= PICKER_FULL_CATALOG_MAX) loaded.forEach((l, c) => { for (let d = 0; d < l.ix.n; d++) offer(c, d); });
      else {
        await awaitVectors();
        const lists = loaded.map((_, c) => fused(c, -Infinity));
        for (let i = 0; i < Math.max(...lists.map(r => r.length)) && offered.size < PICKER_SHORTLIST; i++) loaded.forEach((_, c) => { const r = lists[c]![i]; if (r && offered.size < PICKER_SHORTLIST) offer(c, r.doc); });
      }
      const skills: PickerSkill[] = [...offered].map(([id, { c, doc }]) => ({ id, description: loaded[c]!.receipt.catalog.hints === 'names_only' ? '' : descriptions[c]?.get(id) ?? metaOf(c, doc).summary }));
      const r0 = performance.now();
      const left = leftNow();
      const wait = routerTimeoutMs(input.harness, settings.router) - (r0 - waitStart);
      const outcome: PickOutcome | null = offered.size === 0 && !settings.router.invalid ? null : left < 1 || wait < 1 ? { ok: false, code: 'timeout', model: settings.router.model, usd: 0 } : await pickSkills(home, input.message, skills, settings.router, Math.min(wait, left), env, opts.now);
      base.router = !outcome ? { mode: 'picker', answered_by: 'words', model: settings.router.model, ms: 0, est_usd: 0, fallback: null }
        : { mode: 'picker', answered_by: outcome.ok ? 'picker' : 'words', model: outcome.model, ms: Math.round(performance.now() - r0), est_usd: outcome.usd, fallback: outcome.ok ? null : { code: outcome.code } };
      check();
      if (outcome?.ok) pick = outcome;
    }
    if (pick && query) {
      cancelQuery.abort();
      query = null;
      base.vectors!.fallback = { code: 'not_needed' };
    }
    await awaitVectors();
    const order = loaded.map((_, c) => fused(c, floorFor));
    const nearHit = cos.some(a => a?.some(x => x >= floorFor));
    if (!pick && ranks.every(r => r.idfSum === 0) && !nearHit) return finish({ ...base, no_skill: true, no_skill_reason: 'no_match', block_reason: 'no_match' }, { tokens: 0, suggested: [], resuggested: [] });

    interface Cand { c: number; doc: number; score: number; id: string; explicit: boolean; picked?: boolean }
    const near = (x: { c: number; doc: number }) => (cos[x.c] ? cos[x.c]![x.doc]! >= floorFor : false);
    const strengthOf = (x: Cand): MatchStrength => {
      if (x.explicit) return 'named';
      if (x.picked) return 'picked';
      const fields = ranks[x.c]!.matchedFields(x.doc).fields;
      return STRENGTH_FIELDS.find(f => f !== 'body' && fields[f]?.length) ?? (near(x) ? 'vector' : 'body');
    };
    const excluded = new Set([...input.exclude, ...(opts.hidden ?? [])]);
    const floor = MATCH_STRENGTHS.indexOf(input.min_match_strength ?? 'body');
    const window: Cand[] = [];
    const seen = new Set<string>();
    const admit = (x: Cand) => {
      seen.add(x.id);
      if (window.length < kEff && !excluded.has(x.id) && (x.explicit || !metaOf(x.c, x.doc).dep) && !(others && metaOf(x.c, x.doc).aud) && MATCH_STRENGTHS.indexOf(strengthOf(x)) <= floor) window.push(x);
    };
    loaded.forEach((_, c) => {
      for (const r of ranks[c]!.ranked) {
        if (!ranks[c]!.nameHits.has(r.doc)) continue;
        const m = metaOf(c, r.doc);
        if (!seen.has(m.id) && mentionsSkill(input.message, m.id, m.name)) admit({ c, doc: r.doc, score: r.score, id: m.id, explicit: true });
      }
    });
    for (const id of pick?.ids ?? []) {
      const at = offered.get(id)!;
      if (!seen.has(id)) admit({ ...at, score: ranks[at.c]!.ranked.find(r => r.doc === at.doc)?.score ?? 0, id, explicit: false, picked: true });
    }
    if (pick && window.length === 0 && pick.ids.length === 0) return finish({ ...base, no_skill: true, no_skill_reason: 'no_match', block_reason: 'no_match' }, { tokens: 0, suggested: [], resuggested: [] });
    const longest = pick ? 0 : Math.max(...order.map(r => r.length));
    for (let i = 0; i < longest && window.length < kEff; i++) {
      loaded.forEach((_, c) => {
        const r = order[c]![i];
        if (!r) return;
        const m = metaOf(c, r.doc);
        if (!seen.has(m.id)) admit({ c, doc: r.doc, score: r.score, id: m.id, explicit: false });
      });
      check();
    }
    const strong = (x: Cand) => x.explicit || x.picked === true || ranks[x.c]!.matchedFields(x.doc).strong;
    const picked: Cand[] = [];
    const resuggested: string[] = [];
    const deduped: string[] = [];
    let paced = false;
    if (budget > 0 && window.length && spentFrac >= 0.5 && !strong(window[0]!)) paced = true;
    if (!paced) {
      window.forEach((x, i) => {
        const last = state.last[x.id];
        if (last !== undefined) {
          const again = x.explicit || (i === 0 && strong(x) && turnNo - last >= RESUGGEST_AFTER_TURNS && !state.again[x.id]);
          if (!again) { deduped.push(x.id); return; }
          if (!x.explicit) resuggested.push(x.id);
        }
        picked.push(x);
      });
    }
    const passesGate = (x: Cand) => (cos[x.c] ? near(x) : x.score / maxIdf(loaded[x.c]!.ix.n) >= input.top_gate!);
    const gated = !pick && input.top_gate !== undefined && picked.length > 0 && !picked.some(x => x.explicit) && !picked.some(passesGate);
    if (gated) picked.length = 0;
    const remaining = Math.max(0, budget - state.spent);
    const lines: BlockLine[] = picked.map(x => {
      const m = metaOf(x.c, x.doc);
      return { id: m.id, name: m.name, summary: m.summary, ...(m.path ? { path: m.path } : {}), namesOnly: Boolean(opts.namesOnly) || loaded[x.c]!.receipt.catalog.hints === 'names_only' };
    });
    let r = renderBlock(lines, { harness: input.harness, loadHint: opts.loadHint, readRoot: opts.readRoot, cap: Math.min(BLOCK_TOKEN_CAP, remaining) });
    const exhausted = budget === 0 || remaining === 0 || (picked.length > 0 && r.kept === 0 && remaining < BLOCK_TOKEN_CAP);
    const named = picked.filter(x => x.explicit).length;
    if (budget > 0 && r.kept === 0 && named > 0) r = renderBlock(lines.slice(0, named), { harness: input.harness, loadHint: opts.loadHint, readRoot: opts.readRoot, cap: BLOCK_TOKEN_CAP });
    const kept = picked.slice(0, r.kept);
    const suggestions: Suggestion[] = kept.map(x => {
      const m = metaOf(x.c, x.doc);
      const namesOnly = lines.find(l => l.id === m.id)!.namesOnly;
      const fields = ranks[x.c]!.matchedFields(x.doc).fields;
      const match_strength = strengthOf(x);
      const words = near(x) ? [reasonText(fields), `meaning: cosine ${cos[x.c]![x.doc]!.toFixed(3)}`].filter(Boolean).join('; ') : reasonText(fields);
      return { id: m.id, name: m.name, score: round4(x.score), summary: namesOnly ? '' : m.summary, reason: x.explicit ? `named in the turn; ${m.dep ? `deprecated${m.rep ? `, use ${m.rep} instead` : ''}; ` : ''}${words}` : x.picked ? 'picked by the model picker' : words, match_strength, ...(m.path ? { path: m.path } : {}), catalog: loaded[x.c]!.name };
    });
    const blockReason: BlockReason | null = suggestions.length ? null : exhausted ? 'budget_exhausted' : gated ? 'weak_top_match' : paced ? 'paced' : window.length ? 'deduped' : 'filtered';
    const out: TurnOutput = { ...base, budget_exhausted: exhausted, block_reason: blockReason, suggestions, block: r.block, block_tokens: r.tokens, deduped };
    let explain: Explain | undefined;
    if (opts.explainTarget !== undefined) {
      const target = opts.explainTarget;
      let found: { c: number; doc: number } | null = null;
      loaded.forEach((l, c) => { if (found) return; for (let d = 0; d < l.ix.n; d++) if (l.ix.meta(d).id === target) { found = { c, doc: d }; break; } });
      const f = found as { c: number; doc: number } | null;
      const pos = f ? ranks[f.c]!.ranked.findIndex(x => x.doc === f.doc) : -1;
      const skip = loaded.map(l => l.receipt.catalog.skipped.find(s => s.id === target)).find(Boolean);
      explain = {
        target, indexed: Boolean(f), catalog: f ? loaded[f.c]!.name : null, rank: pos >= 0 ? pos + 1 : null, score: pos >= 0 ? round4(ranks[f!.c]!.ranked[pos]!.score) : null,
        fields: f ? ranks[f.c]!.matchedFields(f.doc).fields : {}, excluded: excluded.has(target), deduped: deduped.includes(target), in_block: suggestions.some(s => s.id === target),
        skip_reason: skip?.reason ?? null, session: key ? { turn: state.turn, spent: state.spent, budget, remaining } : null,
        ...(f && cos[f.c] ? { vector: { cosine: round4(cos[f.c]![f.doc]!), floor: floorFor } } : {}),
      };
    }
    return finish(out, { tokens: r.tokens, suggested: kept.map(x => x.id), resuggested: resuggested.filter(id => kept.some(x => x.id === id)) }, explain);
  } finally {
    source.done(loaded);
  }
}
