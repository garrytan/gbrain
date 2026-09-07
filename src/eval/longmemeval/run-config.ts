/**
 * run-config.ts — resolved retrieval pins, the `retrieval_config_hash`, the
 * `run_config` receipt block, secret redaction for ledger/error text, and the
 * dev-slice (`--question-ids`) loader.
 *
 * INVARIANT: pure given its inputs. No engine, no gateway read — the harness
 * (src/commands/eval-longmemeval.ts) resolves the mode bundle and the embedder
 * string and passes them in. Two runs with identical pins AND an identical
 * resolved `knobs_hash` produce an identical `retrieval_config_hash`
 * regardless of flag order, dataset, output path or clock, so a resume file
 * written under different pins — or under a snapshot that differs in any
 * non-pin knob (rrf k, autocut jump, token budget, ...) — is refused (plan
 * D33) and the hash never covers anything a row cannot reproduce. The
 * human-readable pins block stays alongside for the receipt reader.
 *
 * INVARIANT: `redactSecrets` is applied to every error string BEFORE it is
 * written to a receipt row or the eval ledger (plan 0k / TODOS 1914) —
 * provider keys, bearer tokens and DB connection strings never land on disk.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { SearchMode } from '../../core/search/mode.ts';
import type { LongMemEvalQuestion } from './adapter.ts';

/** The pins that change fused results for one `gbrain eval longmemeval` run. */
export interface RetrievalPins {
  /** Resolved search mode (flag > config snapshot > balanced). */
  mode: SearchMode;
  /** `--keyword-only`: engine.searchKeyword, no vector arm, no reranker. */
  keyword_only: boolean;
  reranker: { enabled: boolean; model: string };
  autocut: boolean;
  /** Expansion fires only with `--expansion` (per-call wins over the bundle). */
  expansion: boolean;
  /** `null` = legacy weighting (every RRF list weight 1). */
  expansion_variant_budget: number | null;
  /** `model@dims` of the embedder, or `unconfigured` when no gateway is set up. */
  embedder: string;
  top_k: number;
  trajectory: boolean;
  /**
   * Raw `--search-pin KEY=VALUE` map (sorted by key), present ONLY when at
   * least one pin was given. A pin the mode resolver does not parse (e.g.
   * `search.adaptive_return`) still changes ranking but never reaches
   * `knobs_hash`; folding the raw map here keeps two differently-pinned runs
   * from merging on resume. Omitted when empty so every pre-existing
   * receipt's hash is unchanged.
   */
  search_pins?: Record<string, string>;
}

/** Stable JSON: sorted keys at every level so key order can never move the hash. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The resolved-knobs fingerprint folded into `retrievalConfigHash` (D15/D33). */
export interface KnobsFingerprint {
  /** `knobsHash(resolveSearchMode(...))` — every search knob the run resolved. */
  knobs_hash: string;
  /** `KNOBS_HASH_VERSION` at run time (the hash's vocabulary version). */
  knobs_hash_version: number;
}

/**
 * sha256 (hex) over the stable JSON of `{ pins, knobs_hash, knobs_hash_version }`.
 * The eight pins alone would let a resume merge two runs whose injected
 * config snapshot differs in a non-pin knob; folding the resolved knobs hash
 * closes that (the knobs hash already covers every pin, so the pins block is
 * kept for readability, not for coverage). `pins.search_pins` (raw
 * `--search-pin` map) covers the keys the knobs hash does not parse.
 */
export function retrievalConfigHash(pins: RetrievalPins, knobs: KnobsFingerprint): string {
  return createHash('sha256')
    .update(stableStringify({ pins, knobs_hash: knobs.knobs_hash, knobs_hash_version: knobs.knobs_hash_version }))
    .digest('hex');
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Scrub provider/DB secrets from free text. Conservative patterns: URL
 * userinfo (`scheme://user:pass@`), bearer tokens, `key=value` pairs whose
 * key smells like a secret, and the common provider key prefixes. The
 * surrounding message (which stage failed, which host) survives so the
 * error stays diagnosable.
 */
export function redactSecrets(text: string): string {
  return text
    // scheme://user:password@host → scheme://<redacted>@host
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1<redacted>@')
    // Authorization: Bearer <token>
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>')
    // api_key=..., apiKey: ..., token=..., password=..., secret=...
    .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret)(\s*[=:]\s*)["']?[^\s"'&,;]+/gi, '$1$2<redacted>')
    // Provider key shapes: sk-..., sk-ant-..., pa-..., AKIA..., ghp_..., xoxb-...
    .replace(/\b(sk-(?:ant-)?|pa-|ghp_|gho_|xox[abpr]-)[A-Za-z0-9_-]{8,}/g, '$1<redacted>')
    .replace(/\bAKIA[0-9A-Z]{12,}/g, 'AKIA<redacted>')
    // postgres://host/db?password=... is covered above; also scrub ?sslpassword= style
    .replace(/([?&](?:ssl)?password=)[^&\s]+/gi, '$1<redacted>');
}

/**
 * `--question-ids FILE`: one question_id per line; blank lines and `#`
 * comments ignored. Throws when the file is missing or yields no ids.
 */
export function loadQuestionIds(path: string): string[] {
  if (!existsSync(path)) throw new Error(`--question-ids file not found: ${path}`);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!seen.has(line)) { seen.add(line); ids.push(line); }
  }
  if (ids.length === 0) throw new Error(`--question-ids file is empty: ${path}`);
  return ids;
}

/** `run_config.cache` receipt block (plan D9/D18). */
export interface CacheReceipt {
  path: string;
  hits: number;
  misses: number;
  bypassed: number;
  /** Cache infrastructure faults (re-embedded uncached / write-back lost). Must be 0 for a receipt. */
  infra_faults: number;
  canonical_sha256: string;
  sha256: string;
}

export interface RunConfigInput {
  pins: RetrievalPins;
  retrieval_config_hash: string;
  dataset_sha256: string;
  dataset_questions: number;
  knobs_hash: string;
  knobs_hash_version: number;
  cache: CacheReceipt | null;
  /** Why the cache block is null (`disabled`, `keyword_only`, `gateway_unconfigured`, ...). */
  cache_skipped?: string;
  reranker_skipped_rows: number;
  /** Rows whose vector arm silently degraded (vector_enabled=false / embed_unavailable / embed_timeout) on a non-keyword-only run. */
  vector_degraded_rows: number;
  /** Rows whose --expansion did not run as configured (expansion_failed / expansion_partial). */
  expansion_failed_rows: number;
  expansion_replay_miss: number;
  expansion_replay: string | null;
  gold_missing_from_haystack: number;
  slug_collisions: number;
  excluded_abstention: number;
  question_ids_file: string | null;
  errors: number;
}

/** The `run_config` object stamped on the by_type_summary (schema v2). */
export function buildRunConfig(input: RunConfigInput): Record<string, unknown> {
  const p = input.pins;
  return {
    mode: p.mode,
    keyword_only: p.keyword_only,
    reranker: { enabled: p.reranker.enabled, model: p.reranker.model },
    autocut: p.autocut,
    expansion: p.expansion,
    expansion_variant_budget: p.expansion_variant_budget,
    expansion_replay: input.expansion_replay,
    embedder: p.embedder,
    topK: p.top_k,
    trajectory: p.trajectory,
    ...(p.search_pins && Object.keys(p.search_pins).length > 0 ? { search_pins: p.search_pins } : {}),
    dataset_sha256: input.dataset_sha256,
    dataset_questions: input.dataset_questions,
    question_ids_file: input.question_ids_file,
    retrieval_config_hash: input.retrieval_config_hash,
    knobs_hash: input.knobs_hash,
    knobs_hash_version: input.knobs_hash_version,
    cache: input.cache,
    ...(input.cache === null && input.cache_skipped ? { cache_skipped: input.cache_skipped } : {}),
    reranker_skipped_rows: input.reranker_skipped_rows,
    vector_degraded_rows: input.vector_degraded_rows,
    expansion_failed_rows: input.expansion_failed_rows,
    expansion_replay_miss: input.expansion_replay_miss,
    gold_missing_from_haystack: input.gold_missing_from_haystack,
    slug_collisions: input.slug_collisions,
    excluded_abstention: input.excluded_abstention,
    errors: input.errors,
  };
}

/** The `question_date` field is optional on disk; the reader emits `Current Date:` only when present. */
export type DatasetQuestion = LongMemEvalQuestion & { question_date?: string };

/**
 * Load a LongMemEval dataset (JSONL, or a JSON array) and its sha256 (the
 * receipt's dataset pin). Throws with a download hint when missing and with
 * the line number on a parse failure — the harness maps both to exit 1.
 */
export function loadDataset(datasetPath: string, downloadUrl: string): { questions: DatasetQuestion[]; sha256: string } {
  if (!existsSync(datasetPath)) {
    throw new Error(`dataset not found: ${datasetPath}\nDownload from ${downloadUrl}`);
  }
  const bytes = readFileSync(datasetPath);
  const sha256 = sha256Hex(bytes);
  const raw = bytes.toString('utf8');
  if (raw.trimStart().startsWith('[')) {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error(`dataset ${datasetPath} parsed as JSON but is not an array`);
    return { questions: arr as DatasetQuestion[], sha256 };
  }
  const out: DatasetQuestion[] = [];
  let lineNo = 0;
  for (const line of raw.split('\n')) {
    lineNo++;
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as DatasetQuestion);
    } catch (err: any) {
      throw new Error(`dataset ${datasetPath}:${lineNo}: ${err.message ?? err}`);
    }
  }
  return { questions: out, sha256 };
}
