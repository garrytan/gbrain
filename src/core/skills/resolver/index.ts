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
export { resolveSkills, normalizeTurnInput, errorTurnOutput, SCHEMA_VERSION, type Explain, type MatchStrength, type ResolveOptions, type ResolveResult, type Suggestion, type TurnInput, type TurnOutput } from './resolve.ts';
export { commitSessionAsync, type TurnDelta } from './session.ts';
export { VERSION as GBRAIN_VERSION } from '../../../version.ts';
export { ResolverError, type ResolverErrorCode } from './errors.ts';
export { HARNESSES, BLOCK_TOKEN_CAP } from './block.ts';
export { resolverHome } from './paths.ts';
import { resolverHome } from './paths.ts';
import { resetSession, sessionKey } from './session.ts';

/** Drop a session's dedupe and budget state (what a compaction does). */
export async function resetSkillSession(sessionId: string, opts: { home?: string; harness?: string; shadow?: boolean } = {}): Promise<void> {
  await resetSession(opts.home ?? resolverHome(), sessionKey(opts.shadow ? 'shadow' : 'on', opts.harness, sessionId));
}
