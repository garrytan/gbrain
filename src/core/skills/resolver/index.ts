/**
 * gbrain's general-purpose skill resolver (library entry; also published
 * as `gbrain/skill-resolver` and as a prebuilt, dependency-free bundle).
 *
 *   await buildSkillIndex({ catalog: 'claude-user', dirs: ['/home/alice-example/.claude/skills'] })
 *   const r = await resolveSkills({ message, session_id }, { catalogs: ['claude-user'] })
 *   deliver(r.output.block); await r.commit()
 *
 * Engine-free: nothing here opens a brain, a database, the network or a
 * model. Guide: docs/guides/skill-resolver.md. Contract:
 * docs/schemas/skill-resolver.v1.*.json.
 */
export { buildSkillIndex, catalogStatus, listCatalogs, removeSkillIndex, sessionStatus, type BuildInput, type BuildReceipt, type CatalogStatus } from './build.ts';
export { resolveSkills, normalizeTurnInput, errorTurnOutput, SCHEMA_VERSION, EXCLUDE_MAX, MATCH_STRENGTHS, type Explain, type MatchStrength, type ResolveOptions, type ResolveResult, type Suggestion, type TurnInput, type TurnOutput } from './resolve.ts';
export { commitSessionAsync, type TurnDelta } from './session.ts';
export { openCatalog, type CatalogHandle, type CatalogHandleOptions, type CatalogTurnOptions } from './handle.ts';
export { buildSkillIndexOffThread } from './build-thread.ts';
export { VERSION as GBRAIN_VERSION } from '../../../version.ts';
export { ResolverError, type ResolverErrorCode } from './errors.ts';
export { HARNESSES, BLOCK_TOKEN_CAP } from './block.ts';
export { resolverHome } from './paths.ts';
import { resolverHome } from './paths.ts';
import { gcSessionsAsync, resetSession, sessionKey } from './session.ts';

/**
 * What this build of the resolver supports beyond the first v1 release, so
 * an adapter can check before it sends a field: min_match_strength in the
 * turn input, exclude up to EXCLUDE_MAX ids, the index's catalog_hash on
 * skill_catalog_mismatch, a named skill's line past a spent budget,
 * previous_user_message as the fallback ranking text, the pi and cursor
 * harnesses, OpenClaw's skills list --json as a catalog, --from-json with
 * --dir bodies, Claude Code plugin catalogs, the warm handle (openCatalog),
 * the worker-thread build (buildSkillIndexOffThread), gcSkillSessions, the
 * hook lane for Hermes (`hook user-prompt --harness hermes`, answering
 * {"context"}), the lane's Codex project catalog (codex-project-<hash>,
 * the .agents/skills dirs from the project root to cwd) and top_gate in the
 * turn input (block_reason weak_top_match).
 */
export const RESOLVER_FEATURES: readonly string[] = ['min_match_strength', 'exclude_1024', 'mismatch_catalog_hash', 'named_past_budget', 'previous_user_message', 'harness_pi', 'harness_cursor', 'openclaw_skills_list', 'from_json_with_dirs', 'from_json_when_to_use', 'claude_plugins', 'open_catalog', 'build_off_thread', 'gc_sessions', 'harness_hermes_lane', 'codex_project_catalog', 'top_gate'];

/** One bounded pass (at most 1,000 files, async I/O) deleting session files idle for 7 days; returns how many it deleted. Commits already run one at most every 10 minutes. */
export async function gcSkillSessions(opts: { home?: string; now?: number } = {}): Promise<number> {
  return gcSessionsAsync(opts.home ?? resolverHome(), opts.now);
}

/** Drop a session's dedupe and budget state (what a compaction does). */
export async function resetSkillSession(sessionId: string, opts: { home?: string; harness?: string; shadow?: boolean } = {}): Promise<void> {
  await resetSession(opts.home ?? resolverHome(), sessionKey(opts.shadow ? 'shadow' : 'on', opts.harness, sessionId));
}
