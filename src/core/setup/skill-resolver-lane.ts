/**
 * Identity of the skill-resolver hook lane (`GBRAIN_HOOK_LANE=skill-resolver`,
 * src/core/skills/resolver/hook-lane.ts), as a leaf every other lane can
 * import: its entries never count as a turn-rule, setup, bootstrap or plugin
 * wiring of an event (the resolver lane only adds the skills block, never the
 * per-turn rule or the read-context block), and those lanes never yield to it.
 */
export const SKILL_RESOLVER_LANE = 'skill-resolver';
export const SKILL_RESOLVER_MARKER = 'skill-resolver-v1';
export const SKILL_RESOLVER_LANE_TOKEN = 'GBRAIN_HOOK_LANE=skill-resolver';

/** A hook command that runs this lane (any carrier, any event). */
export function isSkillResolverCommand(command: unknown): boolean {
  return typeof command === 'string' && /(?:^|[\s'])GBRAIN_HOOK_LANE=skill-resolver(?=[\s']|$)/.test(command) && /\shook\s/.test(command);
}

/** A Claude Code hook entry that is this lane's: marked, or (marker dropped on a rewrite) its command. */
export function isSkillResolverEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  return e._gbrain === SKILL_RESOLVER_MARKER || isSkillResolverCommand(e.command);
}
