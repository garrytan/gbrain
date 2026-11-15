/**
 * The turn input's bounds and the match-strength order, shared by the
 * resolver (resolve.ts) and the lane's config keys (config.ts) without
 * loading the ranker. Leaf module.
 */
export const TOP_K_DEFAULT = 5;
export const TOP_K_MAX = 8;
export const EXCLUDE_MAX = 1024;
/** top_gate's upper bound; 0 turns the gate off. */
export const TOP_GATE_MAX = 100;
/**
 * The gate a turn gets when it sets no top_gate: chosen on harness-evals
 * set P's dev half and checked on its held-out half (docs/guides/skill-resolver.md#top_gate-the-no-skill-gate-on-by-default).
 */
export const TOP_GATE_DEFAULT = 0.6;

/** The strongest way a suggestion matched the turn: named in it, then by field. A body-only match is the weakest. */
export type MatchStrength = 'named' | 'name' | 'triggers' | 'routing' | 'description' | 'body';
export const STRENGTH_FIELDS = ['name', 'triggers', 'routing', 'description', 'body'] as const;
/** Strongest first. */
export const MATCH_STRENGTHS: readonly MatchStrength[] = ['named', ...STRENGTH_FIELDS];
