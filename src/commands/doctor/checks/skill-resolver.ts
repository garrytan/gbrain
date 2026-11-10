/**
 * `skill_resolver` (GBRA-377 PR B): the skill-resolver hook lane that
 * `gbrain setup <claude-code|codex> --skill-loading resolve` turns on
 * (src/core/skills/resolver/hook-lane.ts). Per harness it reports the lane's
 * hook (wired, untrusted in Codex, or missing), each catalog's freshness
 * (the content tier: source re-read, index re-hashed) and the recent
 * outcomes and error codes from the lane log. It emits nothing when the
 * resolver is not configured: no keys, no hook, no catalog and no lane log.
 * harness_wiring carries the same view in its details.
 *
 * Read-only apart from catalogStatus's session sweep; warns, never fails.
 */
import { join } from 'node:path';
import type { Check } from '../../doctor.ts';
import { doctorVerify } from '../check-fix.ts';
import { configDir } from '../../../core/config.ts';
import { catalogStatus, listCatalogs } from '../../../core/skills/resolver/build.ts';
import { logsDir } from '../../../core/skills/resolver/paths.ts';
import { LANE_LOG, readRecentDailyLog } from '../../../core/skills/resolver/daily-log.ts';
import { projectCatalogPrefix, userCatalogName, type LaneHarness } from '../../../core/skills/resolver/hook-lane.ts';
import { readResolverConfig, resolverHarnesses } from '../../../core/setup/skill-resolver-config.ts';
import { inspectSkillResolverHook } from '../../../core/setup/skill-resolver-hook.ts';

const name = 'skill_resolver';
const HARNESSES: LaneHarness[] = ['claude-code', 'codex'];
/** Lane-log lines doctor reads (the newest), and the tail it reads them from. */
const RECENT_LINES = 200;
const LOG_TAIL_BYTES = 64 * 1024;

export interface SkillResolverCatalogView { name: string; fresh: boolean | null; stale_reason: string | null; skills: number }
export interface SkillResolverHarnessView { harness: LaneHarness; on: boolean; hook: 'wired' | 'untrusted' | 'absent'; catalogs: SkillResolverCatalogView[] }
export interface SkillResolverView {
  config: 'ok' | 'absent' | 'unreadable';
  harnesses: SkillResolverHarnessView[];
  recent: { turns: number; outcomes: Record<string, number>; errors: Record<string, number> };
}

function recentLane(home: string): SkillResolverView['recent'] | null {
  const text = readRecentDailyLog(logsDir(home), LANE_LOG, LOG_TAIL_BYTES);
  if (text === null) return null;
  const outcomes: Record<string, number> = {};
  const errors: Record<string, number> = {};
  const lines = text.split('\n').filter(Boolean).slice(-RECENT_LINES);
  let turns = 0;
  for (const line of lines) {
    let j: { outcome?: unknown; code?: unknown };
    try { j = JSON.parse(line); } catch { continue; }
    if (typeof j.outcome !== 'string') continue;
    turns++;
    outcomes[j.outcome] = (outcomes[j.outcome] ?? 0) + 1;
    if (typeof j.code === 'string') errors[j.code] = (errors[j.code] ?? 0) + 1;
  }
  return { turns, outcomes, errors };
}

/** The resolver's state for doctor, or null when nothing of it exists. */
export async function skillResolverView(home = configDir()): Promise<SkillResolverView | null> {
  const cfg = readResolverConfig(home);
  const on = cfg.state === 'ok' ? resolverHarnesses(cfg.doc) : [];
  const catalogs = listCatalogs(home);
  const recent = recentLane(home);
  const harnesses: SkillResolverHarnessView[] = [];
  for (const harness of HARNESSES) {
    const hook = inspectSkillResolverHook(harness).state;
    const mine = catalogs.filter((n) => n === userCatalogName(harness) || n.startsWith(projectCatalogPrefix(harness)));
    if (!on.includes(harness) && hook === 'absent' && mine.length === 0) continue;
    const views: SkillResolverCatalogView[] = [];
    for (const name of mine) {
      const s = await catalogStatus(name, { home });
      views.push({ name, fresh: s.fresh, stale_reason: s.stale_reason, skills: s.receipt?.skill_count ?? 0 });
    }
    harnesses.push({ harness, on: on.includes(harness), hook, catalogs: views });
  }
  if (harnesses.length === 0 && !recent && !(cfg.state === 'ok' && on.length)) return null;
  return { config: cfg.state, harnesses, recent: recent ?? { turns: 0, outcomes: {}, errors: {} } };
}

const setupArgv = (harness: string) => ['gbrain', 'setup', harness, '--skill-loading', 'resolve'];

/** One line for harness_wiring's message. */
export function describeSkillResolver(v: SkillResolverView): string {
  if (v.config === 'unreadable') return 'Skill resolver: the config file cannot be read (skill_resolver_config_unreadable).';
  const parts = v.harnesses.map((h) => {
    const user = h.catalogs.find((c) => c.name === userCatalogName(h.harness));
    const fresh = !user ? 'no catalog' : user.fresh ? 'fresh' : `stale (${user.stale_reason})`;
    return `${h.harness} ${h.on ? 'on' : 'off'}, hook ${h.hook}, ${user?.skills ?? 0} skills, ${fresh}`;
  });
  const errs = Object.entries(v.recent.errors).map(([c, n]) => `${c} x${n}`).join(', ');
  return `Skill resolver: ${parts.join('; ') || 'no harness on'}${v.recent.turns ? `; last ${v.recent.turns} turns${errs ? ` with ${errs}` : ' without errors'}` : ''}.`;
}

export function skillResolverCheck(v: SkillResolverView | null): Check | null {
  if (!v) return null;
  const details = { ...v };
  if (v.config === 'unreadable') {
    return { name, status: 'warn', message: `${describeSkillResolver(v)} The hook lane prints nothing until it can read it.`, details: { ...details, code: 'skill_resolver_config_unreadable' },
      fix: { consent: [], actor: 'user', requires_exclusive: false, verify: doctorVerify(name), docs: 'docs/guides/skill-resolver.md#skill_resolver_config_unreadable',
        why: 'gbrain never rewrites a config file it cannot parse; the lane and setup leave it alone.',
        user_message: `gbrain's config file (${join(configDir(), 'config.json')}) is not valid JSON, so the skill resolver is paused. Fix or move it, then run: gbrain setup <claude-code|codex> --skill-loading resolve` } };
  }
  const broken = v.harnesses.find((h) => h.on && (h.hook !== 'wired' || !h.catalogs.some((c) => c.name === userCatalogName(h.harness))));
  if (broken) {
    const what = broken.hook === 'untrusted' ? 'its Codex hook is not trusted' : broken.hook === 'absent' ? 'its hook entry is missing' : 'its user catalog is missing';
    return { name, status: 'warn', message: `${describeSkillResolver(v)} ${broken.harness}: the resolver is on but ${what}, so no skills block is added.`, details,
      fix: { argv: setupArgv(broken.harness), consent: ['persistent_install'], actor: 'agent', requires_exclusive: false, verify: doctorVerify(name),
        why: `Rebuilds the ${broken.harness} user catalog and rewrites only the skill-resolver hook entry; --skill-loading off removes it instead.` } };
  }
  return { name, status: 'ok', message: describeSkillResolver(v), details };
}
