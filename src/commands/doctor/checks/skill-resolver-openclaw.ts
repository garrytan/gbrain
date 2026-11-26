/**
 * The OpenClaw half of doctor's `skill_resolver` check: the
 * gbrain-skill-resolver plugin (src/core/setup/openclaw-skill-plugin.ts).
 * Per agent it reports the mode, the catalog's freshness and the pinned
 * count; for the plugin, whether its files exist, OpenClaw's config loads it,
 * and the library the state names is present with that sha256; and from the
 * last 24 hours of its daily logs, the turns, outcomes, error codes, the
 * deadline-miss rate and how often a suggested skill was then read, split
 * by session class, by whether OpenClaw sent a memory audience and by the
 * skill's OpenClaw source. A live agent on OpenClaw's shared main DM session
 * (session.dmScope main) with no owner sender set warns, unless every turn
 * it logged in that window carried OpenClaw's memory audience. An agent whose
 * OpenClaw prompt lists no skills (maxSkillsPromptChars 0) while the
 * resolver is live reads "listing off, resolver live": skills reach its
 * model only through the suggestions, by path or skills_read.
 *
 * Read-only. Null when nothing of the plugin exists.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { catalogStatus } from '../../../core/skills/resolver/build.ts';
import { logsDir } from '../../../core/skills/resolver/paths.ts';
import { OPENCLAW_SKILL_PLUGIN_CODE_VERSION } from '../../../core/setup/openclaw-skill-plugin-code.ts';
import { openclawAgentPolicy, openclawHostDrift, openclawLoaderVersion, openclawOwnerUnverified, openclawSkillLibDir, openclawSkillPluginDir, openclawSkillPluginRegistered, readOpenclawSkillState, type OpenclawPathReads } from '../../../core/setup/openclaw-skill-plugin.ts';
import { catalogSkillIds } from '../../../core/setup/skill-pins.ts';

const LOG_WINDOW_MS = 24 * 3600 * 1000;
const LOG_READ_CAP = 4 * 1024 * 1024;
/** A deadline-miss rate above this blocks go-live (the plan's bar) and warns here. */
export const OPENCLAW_MISS_RATE_WARN = 0.05;

export const LISTING_OFF_RESOLVER_LIVE = 'listing off, resolver live';
/** Turns that never get pins or suggestions, so they say nothing about whether OpenClaw sends a memory audience on user turns. */
const SILENT = new Set(['relay', 'cron', 'heartbeat', 'webhook', 'internal']);

interface SplitCounts { turns: number; suggested: number; would_suggest: number; reads: number; reads_of_suggested: number }
interface SourceCounts { suggested: number; would_suggest: number; reads: number; reads_of_suggested: number }

export interface OpenclawSkillView {
  plugin: 'installed' | 'files_only' | 'absent';
  /** The plugin code version in the installed index.js; older than this gbrain's, it ignores newer state fields (the rule line, brief pins, require_owner_sender). */
  loader_version: number | null;
  /** The version the gateway ran on its newest logged turn: older than the installed files until the gateway restarts. */
  running_version: number | null;
  library: 'ok' | 'missing' | 'mismatch' | 'none';
  gbrain_version: string | null;
  /** The gbrain home the plugin state belongs to (the state file's gbrain_home), null for a state written before it was recorded. */
  gbrain_home: string | null;
  agents: Array<{ id: string; mode: string; catalog: string; fresh: boolean | null; stale_reason: string | null; skills: number; pins: number; conversation_pins: number; suggest_in: string[]; listing: 'on' | 'off'; path_reads: OpenclawPathReads; verdict: string | null; host?: { hidden: string[]; cut: string[] } | null;
    /** Live, on dmScope main, with no owner_sender_ids and no require_owner_sender, and not every recent turn had a memory audience: another person's DM may count as the owner's. */
    owner_unverified: boolean;
    /** --require-owner-sender is set in state (enforced only once a logged turn shows the gateway running version 6 or later). */
    require_owner_sender: boolean }>;
  recent: { turns: number; outcomes: Record<string, number>; errors: Record<string, number>; deadline_misses: number; miss_rate: number | null; reads: number; reads_of_suggested: number;
    by_session_class: Record<string, SplitCounts>; by_source: Record<string, SourceCounts>;
    /** Turns by whether OpenClaw sent a memory audience (host) or the class came from the session key (unknown). */
    by_audience: Record<string, number>;
    /** The same split per agent. */
    by_agent_audience: Record<string, Record<string, number>>;
    /** The plugin code version the gateway ran on the newest turn it logged (0: a version from before turns recorded it), null with no turn logged. */
    running_version: number | null };
}

function recentOpenclaw(home: string, now: number): OpenclawSkillView['recent'] {
  const recent: OpenclawSkillView['recent'] = { turns: 0, outcomes: {}, errors: {}, deadline_misses: 0, miss_rate: null, reads: 0, reads_of_suggested: 0, by_session_class: {}, by_source: {}, by_audience: {}, by_agent_audience: {}, running_version: null };
  const cls = (v: unknown) => (recent.by_session_class[typeof v === 'string' && v ? v : 'unknown'] ??= { turns: 0, suggested: 0, would_suggest: 0, reads: 0, reads_of_suggested: 0 });
  const src = (v: unknown) => (recent.by_source[typeof v === 'string' && v ? v : 'unknown'] ??= { suggested: 0, would_suggest: 0, reads: 0, reads_of_suggested: 0 });
  const dir = logsDir(home);
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => /^openclaw-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-2); } catch { return recent; }
  let resolved = 0;
  for (const f of files) {
    let text = '';
    try {
      const p = join(dir, f);
      text = readFileSync(p, 'utf8');
      if (statSync(p).size > LOG_READ_CAP) text = text.slice(-LOG_READ_CAP);
    } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let j: { at?: unknown; agent?: unknown; plugin?: unknown; outcome?: unknown; code?: unknown; suggested?: unknown; session_class?: unknown; audience?: unknown; source?: unknown; sources?: unknown };
      try { j = JSON.parse(line); } catch { continue; }
      if (typeof j.outcome !== 'string' || typeof j.at !== 'string' || now - Date.parse(j.at) > LOG_WINDOW_MS) continue;
      if (typeof j.agent === 'string') recent.running_version = Number(j.plugin) || 0;
      if (j.outcome === 'read') {
        const c = cls(j.session_class), s = src(j.source);
        recent.reads++; c.reads++; s.reads++;
        if (j.suggested === true) { recent.reads_of_suggested++; c.reads_of_suggested++; s.reads_of_suggested++; }
        continue;
      }
      if (['rebuilt', 'compaction', 'refreshed'].includes(j.outcome)) continue;
      if (j.session_class !== undefined || j.outcome !== 'error') {
        const c = cls(j.session_class);
        c.turns++;
        if (j.audience === 'host' || j.audience === 'unknown') {
          recent.by_audience[j.audience] = (recent.by_audience[j.audience] ?? 0) + 1;
          if (typeof j.agent === 'string' && !SILENT.has(String(j.session_class))) { const m = (recent.by_agent_audience[j.agent] ??= {}); m[j.audience] = (m[j.audience] ?? 0) + 1; }
        }
        const names = Array.isArray(j.suggested) ? j.suggested : [];
        const field = j.outcome === 'would_suggest' ? 'would_suggest' : j.outcome === 'suggested' ? 'suggested' : null;
        if (field) {
          c[field]++;
          names.forEach((_, i) => { src(Array.isArray(j.sources) ? j.sources[i] : undefined)[field]++; });
        }
      }
      recent.turns++;
      recent.outcomes[j.outcome] = (recent.outcomes[j.outcome] ?? 0) + 1;
      if (typeof j.code === 'string') recent.errors[j.code] = (recent.errors[j.code] ?? 0) + 1;
      if (j.outcome === 'timeout') recent.deadline_misses++;
      if (!j.outcome.startsWith('skipped_') && j.outcome !== 'retry') resolved++;
    }
  }
  recent.miss_rate = resolved ? recent.deadline_misses / resolved : null;
  return recent;
}

export async function openclawSkillView(home: string, now = Date.now()): Promise<OpenclawSkillView | null> {
  const state = readOpenclawSkillState(home);
  const dir = openclawSkillPluginDir();
  const files = existsSync(join(dir, 'index.js'));
  if (!state && !files) return null;
  let library: OpenclawSkillView['library'] = 'none';
  if (state) {
    const p = join(openclawSkillLibDir(home), `${state.library_sha256}.mjs`);
    try { library = createHash('sha256').update(readFileSync(p)).digest('hex') === state.library_sha256 ? 'ok' : 'mismatch'; } catch { library = 'missing'; }
  }
  const agents: OpenclawSkillView['agents'] = [];
  const loader = files ? openclawLoaderVersion() : null;
  const guardRuns = loader !== null && loader >= OPENCLAW_SKILL_PLUGIN_CODE_VERSION;
  for (const [id, a] of Object.entries(state?.agents ?? {})) {
    const s = existsSync(join(home, 'skill-index', a.catalog, 'receipt.json')) ? await catalogStatus(a.catalog, { home }) : null;
    const ids = a.mode !== 'off' && s ? catalogSkillIds(home, a.catalog) : null;
    const host = ids ? openclawHostDrift(id, [...ids], a.exclude_ids ?? []) : null;
    const policy = openclawAgentPolicy(id);
    agents.push({ id, mode: a.mode, catalog: a.catalog, fresh: s ? s.fresh : null, stale_reason: s?.stale_reason ?? (s ? null : 'missing'), skills: s?.receipt?.skill_count ?? 0, pins: a.pinned_ids.length,
      conversation_pins: a.conversation_pinned_ids?.length ?? 0, suggest_in: a.suggest_classes ?? ['owner', 'conversation'],
      listing: policy.listing, path_reads: policy.path_reads, verdict: null, ...(ids ? { host } : {}), owner_unverified: openclawOwnerUnverified(id, guardRuns ? a : { ...a, require_owner_sender: false }), require_owner_sender: !!a.require_owner_sender });
  }
  const recent = recentOpenclaw(home, now);
  if (recent.running_version === null || recent.running_version < OPENCLAW_SKILL_PLUGIN_CODE_VERSION) for (const a of agents) if (a.mode === 'live') a.owner_unverified = openclawOwnerUnverified(a.id, { ...state!.agents[a.id]!, require_owner_sender: false });
  for (const a of agents) {
    const seen = recent.by_agent_audience[a.id];
    if (seen && (seen.host ?? 0) > 0 && !seen.unknown) a.owner_unverified = false;
  }
  const plugin = files ? (openclawSkillPluginRegistered(dir) ? 'installed' : 'files_only') : 'absent';
  for (const a of agents) if (a.listing === 'off' && a.mode === 'live' && plugin === 'installed') a.verdict = LISTING_OFF_RESOLVER_LIVE;
  return { plugin, loader_version: loader, running_version: recent.running_version, library, gbrain_version: state?.gbrain_version ?? null, gbrain_home: state?.gbrain_home ?? null, agents, recent };
}

/** One line for doctor's message, and the problem to warn about (null when healthy). */
export function describeOpenclawSkill(v: OpenclawSkillView): { line: string; problem: { code: string; what: string; agent?: string } | null } {
  const on = v.agents.filter((a) => a.mode !== 'off');
  const agents = v.agents.map((a) => `${a.id} ${a.mode}, ${a.skills} skills, ${a.fresh === null ? 'no catalog' : a.fresh ? 'fresh' : `stale (${a.stale_reason})`}, ${a.pins} pinned${a.conversation_pins ? ` (+${a.conversation_pins} for conversations)` : ''}${a.verdict ? `, ${a.verdict}` : ''}`).join('; ');
  const r = v.recent;
  const miss = r.miss_rate === null ? '' : `, deadline misses ${(r.miss_rate * 100).toFixed(1)}%`;
  const reads = r.reads ? `, ${r.reads_of_suggested}/${r.reads} skill reads were suggested` : '';
  const errs = Object.entries(r.errors).map(([c, n]) => `${c} x${n}`).join(', ');
  const keyed = r.by_audience.unknown ? `, ${r.by_audience.unknown} without a memory audience (classed by session key)` : '';
  const line = `openclaw plugin ${v.plugin}, library ${v.library}; ${agents || 'no agent'}${r.turns ? `; last 24h ${r.turns} turns${keyed}${miss}${reads}${errs ? `, ${errs}` : ''}` : ''}`;
  let problem: { code: string; what: string; agent?: string } | null = null;
  const exposed = on.find((a) => a.owner_unverified);
  const reachableByPath = (a: OpenclawSkillView['agents'][number]) => a.verdict === LISTING_OFF_RESOLVER_LIVE && a.path_reads === 'any';
  const drift = on.find((a) => a.host && ((a.host.cut.length && !reachableByPath(a)) || a.host.hidden.length));
  const names = (ids: string[]) => `${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ` and ${ids.length - 5} more` : ''}`;
  if (on.length && v.plugin !== 'installed') problem = { code: 'skill_resolver_plugin_not_installed', what: v.plugin === 'absent' ? 'the plugin files are missing' : "OpenClaw's config does not load, enable and allow the plugin" };
  else if (on.length && (v.loader_version === null || v.loader_version < OPENCLAW_SKILL_PLUGIN_CODE_VERSION)) problem = { code: 'skill_resolver_plugin_outdated', what: `the installed plugin code (${v.loader_version === null ? 'no readable version' : `version ${v.loader_version}`}) is older than this gbrain's (${OPENCLAW_SKILL_PLUGIN_CODE_VERSION}), so it ignores newer settings (the operator rule, --brief pins, --require-owner-sender)` };
  else if (on.length && v.running_version !== null && v.running_version < OPENCLAW_SKILL_PLUGIN_CODE_VERSION) problem = { code: 'skill_resolver_plugin_outdated', what: `the gateway still runs older plugin code (${v.running_version ? `version ${v.running_version}` : 'from before version 6'}) on its newest logged turn, so it ignores newer settings until it restarts (the warning clears after the first turn on the new code)` };
  else if (on.length && v.library !== 'ok') problem = { code: v.library === 'mismatch' ? 'skill_resolver_library_mismatch' : 'skill_resolver_library_missing', what: `the library the state names is ${v.library}` };
  else if (on.some((a) => a.fresh === null)) problem = { code: 'skill_index_missing', what: 'an agent has no catalog' };
  else if (exposed) problem = { code: 'skill_resolver_owner_unverified', agent: exposed.id, what: `agent ${exposed.id}: OpenClaw puts every direct message on this agent's main session (session.dmScope main), no owner sender is set, and its turns in the last 24 hours did not all carry OpenClaw's memory audience, so anyone who messages the agent directly gets the owner's pins, brief, operator rule and owner-only skill suggestions${exposed.require_owner_sender ? ' (--require-owner-sender is set, but no turn in the last 24 hours shows the gateway running the plugin code that enforces it; the warning clears after the first such turn)' : ''}` };
  else if (drift?.host) {
    const { hidden } = drift.host;
    const cut = reachableByPath(drift) ? [] : drift.host.cut;
    problem = cut.length
      ? { code: 'skill_resolver_host_load_cut', what: `agent ${drift.id}: OpenClaw no longer lists ${cut.length} skill(s) the plugin still suggests (dropped at load by skills.limits.maxCandidatesPerRoot or skills.limits.maxSkillsLoadedPerSource), so skills_read cannot open them: ${names(cut)}` }
      : { code: 'skill_resolver_host_hidden', what: `agent ${drift.id}: OpenClaw now hides ${hidden.length} skill(s) the plugin still suggests from this agent's model (ineligible on this host, outside its skill filter, or model invocation off): ${names(hidden)}` };
  }
  else if (r.miss_rate !== null && r.miss_rate > OPENCLAW_MISS_RATE_WARN && r.turns >= 20) problem = { code: 'skill_resolve_timeout', what: `${(r.miss_rate * 100).toFixed(1)}% of turns missed the 50 ms deadline and got no suggestions` };
  return { line, problem };
}
