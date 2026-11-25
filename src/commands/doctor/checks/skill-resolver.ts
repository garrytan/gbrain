/**
 * `skill_resolver` (GBRA-377 PR B): the skill-resolver hook lane that
 * `gbrain setup <claude-code|codex|hermes> --skill-loading resolve` turns on
 * (src/core/skills/resolver/hook-lane.ts). Per harness it reports the lane's
 * hook (wired, untrusted in Codex or unapproved in Hermes, outdated when it predates the SessionStart
 * compaction reset, or missing), each catalog's freshness
 * (the content tier: source re-read, index re-hashed) and the recent
 * outcomes and error codes from the lane log (warning when one harness
 * misses the deadline on more than 5% of at least 20 ranked turns), and, with the model picker on
 * (skills.resolver.router), its last 24 hours: picker turns, fallbacks by
 * code and today's spend against the daily cap. It emits nothing when the
 * resolver is not configured: no keys, no hook, no catalog and no lane log.
 * harness_wiring carries the same view in its details.
 *
 * Read-only apart from catalogStatus's session sweep; warns, never fails.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Check } from '../../doctor.ts';
import { doctorVerify } from '../check-fix.ts';
import { configDir } from '../../../core/config.ts';
import { catalogStatus, listCatalogs } from '../../../core/skills/resolver/build.ts';
import { logsDir } from '../../../core/skills/resolver/paths.ts';
import { LANE_LOG, readRecentDailyLog } from '../../../core/skills/resolver/daily-log.ts';
import { CLAUDE_PLUGINS_CATALOG, projectCatalogPrefix, userCatalogName } from '../../../core/skills/resolver/hook-lane.ts';
import { readResolverConfig, resolverHarnesses } from '../../../core/setup/skill-resolver-config.ts';
import { ROUTER_MAX_USD_PER_DAY_MAX, routerSettings } from '../../../core/skills/resolver/config.ts';
import { readRouterSpend } from '../../../core/skills/resolver/router.ts';
import { inspectSkillResolverHook, type ResolverHarness, type ResolverHookState } from '../../../core/setup/skill-resolver-hook.ts';
import { describeOpenclawSkill, OPENCLAW_MISS_RATE_WARN, openclawSkillView, type OpenclawSkillView } from './skill-resolver-openclaw.ts';
import { describePiSkillView, piSkillView, type PiSkillView } from './skill-resolver-pi.ts';
import { cursorSkillView, describeCursorSkillView, type CursorSkillView } from './skill-resolver-cursor.ts';

const name = 'skill_resolver';
const HARNESSES: ResolverHarness[] = ['claude-code', 'codex', 'hermes'];
/** Lane-log lines doctor reads (the newest), and the tail it reads them from. */
const RECENT_LINES = 200;
const LOG_TAIL_BYTES = 64 * 1024;
/** Outcomes of prompts the lane never ranked; they cannot miss the deadline, so the miss rate leaves them out. */
const UNRANKED = new Set(['off', 'yield', 'reset', 'no_catalog']);
/** A user prompt the lane ranked or ran out of time on. `empty` before ranking (a blank prompt) has no catalogs; `empty` after it (every match already offered) does. */
const rankedPrompt = (event: unknown, outcome: string, catalogs: unknown) =>
  event === 'user-prompt' && !UNRANKED.has(outcome) && !outcome.startsWith('skipped_') && (outcome !== 'empty' || Array.isArray(catalogs));
/** Below this many ranked turns of one harness, its miss rate is not judged. */
const MISS_MIN_TURNS = 20;

export interface SkillResolverCatalogView { name: string; fresh: boolean | null; stale_reason: string | null; skills: number }
export interface SkillResolverHarnessView { harness: ResolverHarness; on: boolean; hook: ResolverHookState; catalogs: SkillResolverCatalogView[] }
export interface SkillResolverView {
  config: 'ok' | 'absent' | 'unreadable';
  harnesses: SkillResolverHarnessView[];
  recent: { turns: number; outcomes: Record<string, number>; errors: Record<string, number>; misses?: Record<string, LaneMisses> };
  /** With skills.resolver.router on: the last 24 hours of picker turns in the lane log and today's spend. */
  router?: SkillResolverRouterView;
  /** The OpenClaw plugin (gbrain setup openclaw --skill-loading resolve|shadow), when any of it exists. */
  openclaw?: OpenclawSkillView;
  /** The Pi extension (gbrain setup pi --skill-loading resolve), when any of it exists. */
  pi?: PiSkillView;
  /** Cursor's pinned-skills rules (gbrain setup cursor --skill-loading resolve), when a project is recorded. */
  cursor?: CursorSkillView;
}

/** One harness's share of the recent lane turns: those it ranked, and those that ran out of time (skill_resolve_timeout, from the lane or the resolver). */
export interface LaneMisses { ranked: number; missed: number }
export interface SkillResolverRouterView { turns: number; picker: number; fallbacks: Record<string, number>; last: string | null; last_at: string | null; spent_usd: number; cap_usd: number; day: string; today: string }
/** Below this many picker turns in 24 hours, the fallback rate is not judged. */
const ROUTER_MIN_TURNS = 10;
/** A fallback share at or above this warns. */
const ROUTER_FALLBACK_WARN = 0.2;
/** Fallbacks that need the user: the newest picker turn ending in one warns. */
const ROUTER_SETUP_CODES = ['missing_key', 'no_pricing', 'config_invalid'];
/** A daily_cap fallback warns while today's spend is at least this share of the cap (a call is refused once its largest cost would pass the cap), or while today's newest picker turn was refused. */
const ROUTER_CAP_NEAR = 0.8;

function recentRouter(home: string, now = Date.now()): Omit<SkillResolverRouterView, 'spent_usd' | 'cap_usd' | 'day' | 'today'> {
  const text = readRecentDailyLog(logsDir(home), LANE_LOG, LOG_TAIL_BYTES * 16, now) ?? '';
  const out = { turns: 0, picker: 0, fallbacks: {} as Record<string, number>, last: null as string | null, last_at: null as string | null };
  for (const line of text.split('\n')) {
    let j: { at?: unknown; router?: { by?: unknown; code?: unknown } };
    try { j = JSON.parse(line); } catch { continue; }
    if (!j.router || typeof j.at !== 'string' || now - Date.parse(j.at) > 86_400_000) continue;
    if (j.router.by !== 'picker' && typeof j.router.code !== 'string') continue;
    out.turns++;
    if (j.router.by === 'picker') out.picker++;
    if (typeof j.router.code === 'string') out.fallbacks[j.router.code] = (out.fallbacks[j.router.code] ?? 0) + 1;
    out.last = typeof j.router.code === 'string' ? j.router.code : null;
    out.last_at = j.at;
  }
  try {
    if (out.last_at && statSync(join(home, 'config.json')).mtimeMs > Date.parse(out.last_at)) { out.last = null; out.last_at = null; }
  } catch { /* silent-read-ok: no config.json means no change since the newest turn */ }
  return out;
}

function recentLane(home: string): SkillResolverView['recent'] | null {
  const text = readRecentDailyLog(logsDir(home), LANE_LOG, LOG_TAIL_BYTES);
  if (text === null) return null;
  const outcomes: Record<string, number> = {};
  const errors: Record<string, number> = {};
  const misses: Record<string, LaneMisses> = {};
  const lines = text.split('\n').filter(Boolean).slice(-RECENT_LINES);
  let turns = 0;
  for (const line of lines) {
    let j: { outcome?: unknown; code?: unknown; harness?: unknown; event?: unknown; catalogs?: unknown };
    try { j = JSON.parse(line); } catch { continue; }
    if (typeof j.outcome !== 'string') continue;
    turns++;
    outcomes[j.outcome] = (outcomes[j.outcome] ?? 0) + 1;
    if (typeof j.code === 'string') errors[j.code] = (errors[j.code] ?? 0) + 1;
    if (typeof j.harness !== 'string' || !rankedPrompt(j.event, j.outcome, j.catalogs)) continue;
    const m = (misses[j.harness] ??= { ranked: 0, missed: 0 });
    m.ranked++;
    if (j.code === 'skill_resolve_timeout') m.missed++;
  }
  return { turns, outcomes, errors, misses };
}

/** A catalog a turn can rank with no project: the user catalog, and for Claude Code the plugins catalog. */
const isTurnCatalog = (harness: ResolverHarness, n: string) => n === userCatalogName(harness) || (harness === 'claude-code' && n === CLAUDE_PLUGINS_CATALOG);

/** The resolver's state for doctor, or null when nothing of it exists. */
export async function skillResolverView(home = configDir()): Promise<SkillResolverView | null> {
  const cfg = readResolverConfig(home);
  const on = cfg.state === 'ok' ? resolverHarnesses(cfg.doc) : [];
  const catalogs = listCatalogs(home);
  const recent = recentLane(home);
  const harnesses: SkillResolverHarnessView[] = [];
  for (const harness of HARNESSES) {
    const hook = inspectSkillResolverHook(harness).state;
    const mine = catalogs.filter((n) => isTurnCatalog(harness, n) || n.startsWith(projectCatalogPrefix(harness)));
    if (!on.includes(harness) && hook === 'absent' && mine.length === 0) continue;
    const views: SkillResolverCatalogView[] = [];
    for (const name of mine) {
      const s = await catalogStatus(name, { home });
      views.push({ name, fresh: s.fresh, stale_reason: s.stale_reason, skills: s.receipt?.skill_count ?? 0 });
    }
    harnesses.push({ harness, on: on.includes(harness), hook, catalogs: views });
  }
  const openclaw = await openclawSkillView(home);
  const pi = await piSkillView(home);
  const cursor = await cursorSkillView(home);
  if (harnesses.length === 0 && !recent && !(cfg.state === 'ok' && on.length) && !openclaw && !pi && !cursor) return null;
  const section = cfg.state === 'ok' ? ((cfg.doc.skills as { resolver?: Record<string, unknown> } | undefined)?.resolver ?? {}) : {};
  const rs = routerSettings(section);
  const now = Date.now();
  const router = rs.on ? { ...recentRouter(home, now), ...(await readRouterSpend(home, now).then(x => ({ spent_usd: x.charged_usd, day: x.day }))), cap_usd: rs.maxUsdPerDay, today: new Date(now).toISOString().slice(0, 10) } : null;
  return { config: cfg.state, harnesses, recent: recent ?? { turns: 0, outcomes: {}, errors: {} }, ...(router ? { router } : {}), ...(openclaw ? { openclaw } : {}), ...(pi ? { pi } : {}), ...(cursor ? { cursor } : {}) };
}

const setupArgv = (harness: string) => ['gbrain', 'setup', harness, '--skill-loading', 'resolve'];

/** One line for harness_wiring's message. */
export function describeSkillResolver(v: SkillResolverView): string {
  if (v.config === 'unreadable') return 'Skill resolver: the config file cannot be read (skill_resolver_config_unreadable).';
  const parts = v.harnesses.map((h) => {
    const user = h.catalogs.find((c) => c.name === userCatalogName(h.harness)) ?? h.catalogs.find((c) => isTurnCatalog(h.harness, c.name));
    const fresh = !user ? 'no catalog' : user.fresh ? 'fresh' : `stale (${user.stale_reason})`;
    return `${h.harness} ${h.on ? 'on' : 'off'}, hook ${h.hook}, ${user?.skills ?? 0} skills, ${fresh}`;
  });
  const errs = Object.entries(v.recent.errors).map(([c, n]) => `${c} x${n}`).join(', ');
  const oc = v.openclaw ? `; ${describeOpenclawSkill(v.openclaw).line}` : '';
  const pi = v.pi ? `; ${describePiSkillView(v.pi).line}` : '';
  const cursor = v.cursor ? `; ${describeCursorSkillView(v.cursor).line}` : '';
  const r = v.router;
  const rt = r ? `; model picker on: answered ${r.picker} of ${r.turns} turns in 24 h${Object.keys(r.fallbacks).length ? ` (fell back: ${Object.entries(r.fallbacks).map(([c, n]) => `${c} x${n}`).join(', ')})` : ''}, ${r.spent_usd.toFixed(4)} of ${r.cap_usd.toFixed(2)} USD today` : '';
  return `Skill resolver: ${parts.join('; ') || (v.openclaw || v.pi || v.cursor ? 'no hook harness on' : 'no harness on')}${v.recent.turns ? `; last ${v.recent.turns} turns${errs ? ` with ${errs}` : ' without errors'}` : ''}${rt}${oc}${pi}${cursor}.`;
}

export function skillResolverCheck(v: SkillResolverView | null): Check | null {
  if (!v) return null;
  const details = { ...v };
  if (v.config === 'unreadable') {
    return { name, status: 'warn', message: `${describeSkillResolver(v)} The hook lane prints nothing until it can read it.`, details: { ...details, code: 'skill_resolver_config_unreadable' },
      fix: { consent: [], actor: 'user', requires_exclusive: false, verify: doctorVerify(name), docs: 'docs/guides/skill-resolver.md#skill_resolver_config_unreadable',
        why: 'gbrain never rewrites a config file it cannot parse; the lane and setup leave it alone.',
        user_message: `gbrain's config file (${join(configDir(), 'config.json')}) is not valid JSON, so the skill resolver is paused. Fix or move it, then run: gbrain setup <claude-code|codex|hermes> --skill-loading resolve` } };
  }
  const broken = v.harnesses.find((h) => h.on && (h.hook !== 'wired' || !h.catalogs.some((c) => isTurnCatalog(h.harness, c.name))));
  if (broken) {
    const what = broken.hook === 'outdated' ? `its hook has no SessionStart entry (installed before the compaction reset), so skills offered before a compaction are not offered again; ${setupArgv(broken.harness).join(' ')} adds it`
      : `${broken.hook === 'untrusted' ? (broken.harness === 'hermes' ? 'its Hermes hook is not approved in shell-hooks-allowlist.json (hermes hooks doctor shows it)' : 'its Codex hook is not trusted') : broken.hook === 'absent' ? 'its hook entry is missing' : 'its user catalog is missing'}, so no skills block is added`;
    return { name, status: 'warn', message: `${describeSkillResolver(v)} ${broken.harness}: the resolver is on but ${what}.`, details,
      fix: { argv: setupArgv(broken.harness), consent: ['persistent_install'], actor: 'agent', requires_exclusive: false, verify: doctorVerify(name),
        why: `Rebuilds the ${broken.harness} user catalog and rewrites only the skill-resolver hook entry; --skill-loading off removes it instead.` } };
  }
  const slow = Object.entries(v.recent.misses ?? {}).find(([, m]) => m.ranked >= MISS_MIN_TURNS && m.missed / m.ranked > OPENCLAW_MISS_RATE_WARN);
  if (slow) {
    const [harness, m] = slow;
    return { name, status: 'warn', message: `${describeSkillResolver(v)} ${harness}: ${(m.missed / m.ranked * 100).toFixed(1)}% of the last ${m.ranked} ranked turns missed the deadline and got no suggestions.`, details: { ...details, code: 'skill_resolve_timeout' },
      fix: { consent: [], actor: 'user', requires_exclusive: false, verify: doctorVerify(name), docs: 'docs/guides/skill-resolver.md#skill_resolve_timeout',
        why: 'The lane prints nothing when a turn runs past its deadline, so the harness gets no skills block; doctor cannot speed the host up.',
        user_message: `${harness} turns keep missing the skill resolver's deadline. Check the catalog size with gbrain skills index status and whether the machine is busy during turns; gbrain setup ${harness} --skill-loading off turns the resolver off.` } };
  }
  const oc = v.openclaw ? describeOpenclawSkill(v.openclaw).problem : null;
  if (oc) {
    return { name, status: 'warn', message: `${describeSkillResolver(v)} OpenClaw: ${oc.what}.`, details: { ...details, code: oc.code },
      fix: { argv: ['gbrain', 'setup', 'openclaw', '--skills-index-only'], consent: [], actor: 'agent', requires_exclusive: false, verify: doctorVerify(name), docs: `docs/guides/skill-resolver.md#${oc.code}`,
        why: "Rebuilds the OpenClaw catalogs, the library and the plugin state, re-reading OpenClaw's skill list (read-only) so skills it hides or no longer lists stop being suggested; it installs nothing and changes no OpenClaw config. gbrain setup openclaw --skill-loading resolve reinstalls the plugin itself." } };
  }
  const pi = v.pi ? describePiSkillView(v.pi).problem : null;
  if (pi) {
    return { name, status: 'warn', message: `${describeSkillResolver(v)} Pi: ${pi.what}.`, details: { ...details, code: pi.code },
      fix: { argv: setupArgv('pi'), consent: ['persistent_install'], actor: 'agent', requires_exclusive: false, verify: doctorVerify(name), docs: `docs/guides/skill-resolver.md#${pi.code}`,
        why: 'Rebuilds the pi-user catalog, the library and the state, and rewrites the Pi extension; gbrain setup pi --skill-loading off removes it instead.' } };
  }
  const cursor = v.cursor ? describeCursorSkillView(v.cursor).problem : null;
  if (cursor) {
    return { name, status: 'warn', message: `${describeSkillResolver(v)} Cursor: ${cursor.what}.`, details: { ...details, code: cursor.code },
      fix: { argv: setupArgv('cursor'), consent: ['persistent_install'], actor: 'agent', requires_exclusive: false, verify: doctorVerify(name), docs: `docs/guides/skill-resolver.md#${cursor.code}`,
        why: `Run it in ${cursor.project}: it rebuilds that project's catalog and rewrites its pinned-skills rule; gbrain setup cursor --skill-loading off there removes them instead.` } };
  }
  const router = v.router ? routerProblem(v.router) : null;
  if (router) return { name, status: 'warn', message: `${describeSkillResolver(v)} ${router.what}`, details: { ...details, code: `skill_router_${router.code}` }, fix: router.fix };
  return { name, status: 'ok', message: describeSkillResolver(v), details };
}

/** The model picker's problem worth a warning, or null: today's spend at the cap, a setup fallback on the newest picker turn, or a high fallback rate. */
function routerProblem(r: SkillResolverRouterView): { code: string; what: string; fix: NonNullable<Check['fix']> } | null {
  const docs = (code: string) => `docs/guides/skill-resolver.md#router_fallback-${code}`;
  const base = { requires_exclusive: false, verify: doctorVerify(name) };
  const spent = r.spent_usd >= r.cap_usd * ROUTER_CAP_NEAR;
  if (r.fallbacks.daily_cap && r.cap_usd > 0 && (spent || (r.last === 'daily_cap' && r.last_at?.slice(0, 10) === r.today))) {
    const raise = Math.min(ROUTER_MAX_USD_PER_DAY_MAX, Math.max(1, r.cap_usd * 2));
    const told = spent
      ? `The skill picker spent its ${r.cap_usd.toFixed(2)} USD daily cap`
      : `The skill picker refuses its calls: one call's largest cost is more than what is left of its ${r.cap_usd.toFixed(2)} USD daily cap`;
    const what = spent
      ? `The model picker reached its daily cap: ${r.spent_usd.toFixed(4)} of ${r.cap_usd.toFixed(2)} USD spent on ${r.day} (UTC), so the word matcher answers until the cap resets at 00:00 UTC.`
      : `The model picker refuses its calls: one call's largest cost is more than what is left of the ${r.cap_usd.toFixed(2)} USD daily cap (${r.spent_usd.toFixed(4)} spent on ${r.day}, UTC), so the word matcher answers.`;
    return { code: 'daily_cap', what, fix: raise > r.cap_usd
      ? { ...base, argv: ['gbrain', 'config', 'set', 'skills.resolver.router_max_usd_per_day', String(raise)], consent: ['paid'], actor: 'agent', docs: docs('daily_cap'),
        why: 'Raises the daily spend cap for the model picker; each turn costs about $0.0001 to $0.001.',
        user_message: `${told}${spent ? ' and resets at 00:00 UTC' : ''}. Raise the cap to ${raise} USD a day?` }
      : { ...base, consent: [], actor: 'user', docs: docs('daily_cap'), why: `The cap is already at its ${ROUTER_MAX_USD_PER_DAY_MAX} USD maximum.`,
        user_message: `${told}, the most it allows; ${spent ? 'it resets at 00:00 UTC' : 'a cheaper skills.resolver.router_model is the fix'}.` } };
  }
  if (r.last && ROUTER_SETUP_CODES.includes(r.last)) {
    const what = { missing_key: 'has no key for its model (set an Anthropic, OpenAI or Google key, or skills.resolver.router_model)', no_pricing: 'names a model gbrain has no price for, so its daily cap cannot be enforced (set skills.resolver.router_model to a priced model)', config_invalid: 'has a bad setting under skills.resolver.router_*' }[r.last]!;
    return { code: r.last, what: `The model picker is on but ${what}, so the word matcher answers.`,
      fix: { ...base, consent: [], actor: 'user', docs: docs(r.last), why: 'The docs section for this code names the setting to change.',
        user_message: `The skill picker is on but ${what}. See ${docs(r.last)}.` } };
  }
  const fallbacks = Object.entries(r.fallbacks).filter(([c]) => c !== 'daily_cap');
  const fell = fallbacks.reduce((n, [, k]) => n + k, 0);
  if (r.turns < ROUTER_MIN_TURNS || fell / r.turns < ROUTER_FALLBACK_WARN) return null;
  const top = fallbacks.sort((a, b) => b[1] - a[1])[0]![0];
  return { code: top, what: `The model picker fell back on ${fell} of ${r.turns} turns in 24 hours (mostly ${top}), so the word matcher answered them.`,
    fix: { ...base, consent: [], actor: 'user', docs: docs(top), why: 'A slow or failing provider; the docs section for the code names the fix.',
      user_message: `The skill picker fell back to word matching on ${fell} of ${r.turns} turns in the last day, mostly ${top}. See ${docs(top)}.` } };
}
