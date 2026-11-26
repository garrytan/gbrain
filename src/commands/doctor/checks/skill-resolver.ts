/**
 * `skill_resolver` (GBRA-377 PR B): the skill-resolver hook lane that
 * `gbrain setup <claude-code|codex|hermes> --skill-loading resolve` turns on
 * (src/core/skills/resolver/hook-lane.ts). Per harness it reports the lane's
 * hook (wired, untrusted in Codex or unapproved in Hermes, outdated when it predates the SessionStart
 * compaction reset, or missing), each catalog's freshness
 * (the content tier: source re-read, index re-hashed) and the recent
 * outcomes and error codes from the lane log (warning when a harness that is
 * on timed out on TIMEOUT_WARN or more of at least TIMEOUT_MIN_PROMPTS recent
 * user prompts), and, with the model picker on
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
import { describeOpenclawSkill, openclawSkillView, type OpenclawSkillView } from './skill-resolver-openclaw.ts';
import { describePiSkillView, piSkillView, type PiSkillView } from './skill-resolver-pi.ts';
import { cursorSkillView, describeCursorSkillView, type CursorSkillView } from './skill-resolver-cursor.ts';

const name = 'skill_resolver';
const HARNESSES: ResolverHarness[] = ['claude-code', 'codex', 'hermes'];
/** Lane-log lines doctor reads (the newest), and the tail it reads them from. */
const RECENT_LINES = 200;
const LOG_TAIL_BYTES = 64 * 1024;
/** Below this many recent user prompts from one harness, its timeout share is not judged. */
const TIMEOUT_MIN_PROMPTS = 20;
/** A share of one harness's recent user prompts ending in skill_resolve_timeout at or above this warns. */
const TIMEOUT_WARN = 0.2;

export interface SkillResolverCatalogView { name: string; fresh: boolean | null; stale_reason: string | null; skills: number }
export interface SkillResolverHarnessView { harness: ResolverHarness; on: boolean; hook: ResolverHookState; catalogs: SkillResolverCatalogView[] }
export interface SkillResolverView {
  config: 'ok' | 'absent' | 'unreadable';
  harnesses: SkillResolverHarnessView[];
  /** prompts: per harness, the recent user-prompt lines and how many of them ended in skill_resolve_timeout. */
  recent: { turns: number; outcomes: Record<string, number>; errors: Record<string, number>; prompts?: Record<string, { turns: number; timeouts: number }> };
  /** With skills.resolver.router on: the last 24 hours of picker turns in the lane log and today's spend. */
  router?: SkillResolverRouterView;
  /** The OpenClaw plugin (gbrain setup openclaw --skill-loading resolve|shadow), when any of it exists. */
  openclaw?: OpenclawSkillView;
  /** The Pi extension (gbrain setup pi --skill-loading resolve), when any of it exists. */
  pi?: PiSkillView;
  /** Cursor's pinned-skills rules (gbrain setup cursor --skill-loading resolve), when a project is recorded. */
  cursor?: CursorSkillView;
}

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
  const prompts: Record<string, { turns: number; timeouts: number }> = {};
  const lines = text.split('\n').filter(Boolean).slice(-RECENT_LINES);
  let turns = 0;
  for (const line of lines) {
    let j: { outcome?: unknown; code?: unknown; harness?: unknown; event?: unknown };
    try { j = JSON.parse(line); } catch { continue; }
    if (typeof j.outcome !== 'string') continue;
    turns++;
    outcomes[j.outcome] = (outcomes[j.outcome] ?? 0) + 1;
    if (typeof j.code === 'string') errors[j.code] = (errors[j.code] ?? 0) + 1;
    if (j.event !== 'user-prompt' || typeof j.harness !== 'string') continue;
    const p = (prompts[j.harness] ??= { turns: 0, timeouts: 0 });
    p.turns++;
    if (j.code === 'skill_resolve_timeout') p.timeouts++;
  }
  return { turns, outcomes, errors, prompts };
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
  const slow = v.harnesses.find((h) => { const p = v.recent.prompts?.[h.harness]; return h.on && !!p && p.turns >= TIMEOUT_MIN_PROMPTS && p.timeouts / p.turns >= TIMEOUT_WARN; });
  if (slow) {
    const p = v.recent.prompts![slow.harness]!;
    const what = `${p.timeouts} of the last ${p.turns} prompts (${Math.round(p.timeouts / p.turns * 100)}%) ran past the lane's deadline (skill_resolve_timeout) and got no skills block`;
    return { name, status: 'warn', message: `${describeSkillResolver(v)} ${slow.harness}: ${what}.`, details: { ...details, code: 'skill_resolve_timeout' },
      fix: { consent: [], actor: 'user', requires_exclusive: false, verify: doctorVerify(name), docs: 'docs/guides/skill-resolver.md#skill_resolve_timeout',
        why: 'The lane prints nothing for a turn that runs past its deadline; doctor cannot make the machine or the catalog faster.',
        user_message: `${slow.harness}: ${what}. Check the catalog size with gbrain skills index status and whether the machine is busy during turns; gbrain setup ${slow.harness} --skill-loading off turns the resolver off.` } };
  }
  const oc = v.openclaw ? describeOpenclawSkill(v.openclaw).problem : null;
  if (oc?.code === 'skill_resolver_plugin_outdated') {
    return { name, status: 'warn', message: `${describeSkillResolver(v)} OpenClaw: ${oc.what}.`, details: { ...details, code: oc.code },
      fix: { consent: ['persistent_install'], actor: 'user', requires_exclusive: false, verify: doctorVerify(name), docs: `docs/guides/skill-resolver.md#${oc.code}`,
        why: 'Setup rewrites and reinstalls the plugin only when it runs with the flags the install used (--workspace, --name, --agent), which only the user knows; a gateway restart then loads the new code. Modes, pins and settings stay as they are.',
        user_message: 'The OpenClaw skill-resolver plugin running in your gateway is older than this gbrain, so it ignores the operator rule, --brief pins and --require-owner-sender. Rerun the gbrain setup openclaw command you installed with (keep its --workspace, --name and --agent flags), then restart the OpenClaw gateway once.' } };
  }
  if (oc?.code === 'skill_resolver_owner_unverified') {
    const argv = ['gbrain', 'setup', 'openclaw', '--skills-index-only', '--agent', oc.agent ?? 'main', '--owner-sender', '<sender-id>'];
    return { name, status: 'warn', message: `${describeSkillResolver(v)} OpenClaw: ${oc.what}.`, details: { ...details, code: oc.code },
      fix: { argv, consent: [], actor: 'user', requires_exclusive: false, verify: doctorVerify(name), docs: `docs/guides/skill-resolver.md#${oc.code}`,
        inputs: [{ name: 'sender-id', how: "Ask the user for their own sender id on the channel they message the agent from, as OpenClaw's commands.ownerAllowFrom names it (for example telegram:123456789)." }],
        why: 'Only the owner knows their sender id. With it set, a turn on the shared main session from anyone else is treated as another person\'s DM: conversation pins only, no owner-only skill, no brief.',
        user_message: `Anyone who messages OpenClaw agent ${oc.agent ?? 'main'} directly lands on its main session and is treated as you. Run: ${argv.join(' ')} (your id on that channel). Or add --require-owner-sender instead, so the main session is treated as another person's DM until an owner sender is set.` } };
  }
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
