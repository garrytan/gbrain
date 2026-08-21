/**
 * Leaf module holding the default embedding model + dimensions.
 *
 * Extracted so schema helpers (pglite-schema.ts, postgres-engine.ts) +
 * registry helpers (search/embedding-column.ts) can import the constants
 * without pulling the full AI gateway (which loads every provider SDK).
 *
 * gateway.ts re-exports these so existing import sites keep working.
 *
 * Single source of truth for "what does a fresh brain look like when the
 * user passes zero flags?" Touching these defaults touches every fresh
 * install AND every doctor consistency check.
 */

// LEGACY CONFIGLESS RUNTIME FALLBACK — not the new-install default anymore.
//
// v0.36.0 chose ZeroEntropy as the system default (11/20 eval wins vs OpenAI
// and Voyage). ZeroEntropy's hosted API shuts down on ZEROENTROPY_SUNSET_DATE,
// so v0.46.3 split the default: these two constants now serve ONLY brains with
// no `embedding_model` in file config (old/hand-rolled installs whose stored
// vectors live in ZE's 1280d space — flipping this under them would break
// retrieval BEFORE the provider itself dies). Every new-install surface reads
// NEW_INSTALL_DEFAULT_* below. The September removal release deletes this
// fallback and hard-errors unmigrated configless brains with the migrate
// command. Do NOT point anything new at these.
export const DEFAULT_EMBEDDING_MODEL = 'zeroentropyai:zembed-1';
export const DEFAULT_EMBEDDING_DIMENSIONS = 1280;

// NEW-INSTALL DEFAULT (v0.46.3): voyage-4 @ 1024d.
//
// Why Voyage: ZeroEntropy covered BOTH gbrain touchpoints (embedding +
// reranking); Voyage is the only replacement that covers both on one key
// (rerank-2.5 rides VOYAGE_API_KEY; OpenAI has no reranker API), the
// multimodal model is already voyage:voyage-multimodal-3, and the voyage-4
// family is the current hosted retrieval SOTA. Why voyage-4 (not -large/-lite):
// $0.06/M ≈ zembed-1's $0.05/M, and the v4 trio SHARES ONE EMBEDDING SPACE —
// a brain indexed with voyage-4 can later point its query model at
// voyage-4-large or -lite with no reindex, so the within-family choice is
// reversible. 1024 is a valid Voyage Matryoshka step {256, 512, 1024, 2048}
// and matches the embedding_image/embedding_multimodal widths.
//
// Consumers (new-install surfaces ONLY): init auto-pick canonical tiebreak,
// the interactive picker default, the no-keys hint, keyless fresh-install
// schema sizing (passed as an explicit init param — the schema generators keep
// importing the legacy constants for existing-brain reconnects), and all
// recommendation copy (playbook, banners, doctor fix-hints, advisor).
export const NEW_INSTALL_DEFAULT_EMBEDDING_MODEL = 'voyage:voyage-4';
export const NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS = 1024;

/**
 * Recommended reranker replacement (v0.46.3). The runtime reranker defaults
 * (gateway DEFAULT_RERANKER_MODEL + the mode-bundle reranker_model values)
 * stay on zerank-2 until the September removal so existing ZE-keyed brains
 * keep their working reranker until the API actually dies; init writes this
 * as an explicit `search.reranker.model` config for voyage-keyed installs
 * (any picked embedding provider; keyed non-voyage installs get explicit
 * `search.reranker.enabled false` instead), and the migration playbook sets
 * it for migrating users.
 */
export const NEW_INSTALL_DEFAULT_RERANKER_MODEL = 'voyage:rerank-2.5';

/**
 * LEGACY runtime/bundle reranker default — the sunsetting ZeroEntropy
 * zerank-2. The ONE code home for the value (#3657 seam): the three mode
 * bundles (`src/core/search/mode.ts` MODE_BUNDLES.*.reranker_model) and the
 * gateway's runtime fallback (`src/core/ai/gateway.ts` DEFAULT_RERANKER_MODEL)
 * all resolve through this constant, so the September default swap is a
 * one-line edit HERE (plus retiring the matching RERANKER_SUNSETS row).
 * Pinned by test/reranker-default-seam.test.ts, which also fails if the
 * literal grows a new code home. Do NOT point new code at this; new-install
 * surfaces read NEW_INSTALL_DEFAULT_RERANKER_MODEL above.
 */
export const LEGACY_DEFAULT_RERANKER_MODEL = 'zeroentropyai:zerank-2';

/**
 * ZeroEntropy announced (2026-07-24) that its hosted API — including
 * /models/embed and /models/rerank — shuts down on this date. Query
 * embedding uses the same endpoint as ingestion, so a brain still on a
 * `zeroentropyai:*` embedding model loses semantic retrieval ENTIRELY on
 * that date (existing vectors become unqueryable, not just new content).
 * Single source of truth for the upgrade banner + the `provider_sunset`
 * doctor check. Self-hosting the Apache-2.0 zembed-1 weights is unaffected.
 */
export const ZEROENTROPY_SUNSET_DATE = '2026-09-04';

/** A reranker model family with an announced provider shutdown. */
export interface RerankerSunset {
  /** Provider-prefix match: `model.startsWith(prefix)`. */
  prefix: string;
  /** ISO date the hosted API dies. */
  date: string;
  /** Paste-ready live replacement (`gbrain config set search.reranker.model <this>`). */
  replacement: string;
}

/**
 * Sunset list for reranker models (#3657/#4382). Doctor's `search_mode`
 * check consults this BEFORE recommending `gbrain search modes --reset`:
 * a reset that would re-arm a listed model gets the sunset date named
 * instead of the reset command, and an ACTIVE listed reranker warns with
 * the date. Prefix-matching by provider covers zerank-2/-1/-1-small in
 * one row. Retire a row in the release that deletes the provider recipe.
 */
export const RERANKER_SUNSETS: ReadonlyArray<RerankerSunset> = Object.freeze([
  Object.freeze({
    prefix: 'zeroentropyai:',
    date: ZEROENTROPY_SUNSET_DATE,
    replacement: NEW_INSTALL_DEFAULT_RERANKER_MODEL,
  }),
]);

/** Sunset entry matching a reranker model string, or null when it is live. */
export function rerankerSunset(model: string | null | undefined): RerankerSunset | null {
  if (!model) return null;
  for (const s of RERANKER_SUNSETS) {
    if (model.startsWith(s.prefix)) return s;
  }
  return null;
}

/**
 * ONE canonical rendering of the sunset-migration command for every surface
 * that tells a user/agent how to leave a dying provider (gateway deprecation
 * line, init warnings, upgrade banners, doctor provider_sunset, ze-switch
 * refusal, advisor). Before this, five surfaces printed five different
 * commands — including one with an unsubstituted placeholder and this
 * brain's current width as `--dim`, which is INVALID on Voyage (valid
 * widths: 256/512/1024/2048). Rules:
 *   - the Voyage command ALWAYS carries `--dim 1024` (never the brain's
 *     current width);
 *   - the keep-width OpenAI alternative renders only when the current
 *     column width is known and <= 1536 (text-embedding-3-small's cap);
 *   - the note explains the rebuild whenever the width changes.
 * Lives here (zero-dep constants module) so every consumer can import it
 * without cycles; drift-guarded by test against the doc/skill copies.
 */
export function renderCanonicalMigrationCommands(opts: { colDims?: number | null } = {}): {
  /** Live run (agents append --yes themselves after consent). */
  recommended: string;
  /** Cost preview — what every warning surface should print first. */
  recommendedDryRun: string;
  /** Keep-width alternative (no schema rebuild), when the width allows it. */
  openaiAlternative: string | null;
  /** Rebuild explanation when the recommended target changes the width. */
  note: string | null;
} {
  const base = `gbrain migrate embeddings --to ${NEW_INSTALL_DEFAULT_EMBEDDING_MODEL} --dim ${NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS}`;
  const colDims = opts.colDims ?? null;
  const openaiAlternative = colDims !== null && colDims <= 1536
    ? `gbrain migrate embeddings --to openai:text-embedding-3-small --dim ${colDims} --dry-run`
    : null;
  const note = colDims !== null && colDims !== NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS
    ? `(--dim ${NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS} rebuilds the ${colDims}d index — Voyage's valid widths are 256/512/1024/2048${openaiAlternative ? `; the OpenAI alternative keeps this brain's ${colDims}d width` : ''}.)`
    : null;
  return {
    recommended: base,
    recommendedDryRun: `${base} --dry-run`,
    openaiAlternative,
    note,
  };
}
