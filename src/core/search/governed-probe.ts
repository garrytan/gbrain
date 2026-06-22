import type { MBrainConfig } from '../config.ts';
import type { BrainEngine } from '../engine.ts';
import type { SearchOpts, SearchResult } from '../types.ts';
import { expandQuery } from './expansion.ts';
import { hybridSearch } from './hybrid.ts';

/**
 * Whether the governed retrieval probe should run the full hybrid candidate search
 * (vector + keyword + RRF + query expansion) instead of keyword-only.
 *
 * The governed probe — `retrieve_context` (the rules' mandated first call and
 * `read_context`'s evidence boundary), the `read_context` auto-reads caller, and the
 * broad-synthesis escalation route — historically ran keyword-only while the
 * lower-authority `query` op got full hybrid. That inverted the documented authority
 * gradient: a rule-following agent got strictly worse recall than one ignoring the rules.
 *
 * Off by default so the keyword-only baseline (and thus offline / no-provider installs)
 * stays byte-for-byte unchanged (Invariant 8 — backend semantic parity). When enabled, the
 * hybrid path still degrades to keyword-only if no embedding provider is available.
 */
export function governedProbeHybridEnabled(config?: MBrainConfig | null): boolean {
  return config?.retrieval_governed_probe_hybrid === true;
}

/**
 * Hybrid candidate search bound to a config, mirroring the `query` op's vector + keyword +
 * RRF path with query expansion. Degrades to keyword-only when no embedding provider exists.
 */
export function hybridProbeSearch(
  engine: BrainEngine,
  config: MBrainConfig | null | undefined,
  query: string,
  opts: SearchOpts,
): Promise<SearchResult[]> {
  return hybridSearch(engine, query, {
    ...opts,
    expansion: true,
    expandFn: (variant) => expandQuery(variant, { config: config ?? undefined }),
  });
}
