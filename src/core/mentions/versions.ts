/**
 * The mention pass's version stamps, in a module with no imports. SQL builders that only compare against a stamp
 * (engine-sql/graph-rank.ts, reached from postgres-engine.ts) import them from here: pass.ts statically reaches the
 * schema-pack YAML assets, which Node cannot load, and OpenClaw loads the engine under Node.
 */

/** Bump to rescan every page's mentions once (gazetteer or scanner behavior change). */
export const MENTION_EXTRACTOR_VERSION = 7;
/** Bump to re-derive every entity page's declared aliases and title subject once. */
export const ALIAS_DERIVATION_VERSION = 4;
