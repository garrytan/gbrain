/**
 * The OpenClaw half of doctor's `skill_resolver` check: the
 * gbrain-skill-resolver plugin (src/core/setup/openclaw-skill-plugin.ts).
 * Per agent it reports the mode, the catalog's freshness and the pinned
 * count; for the plugin, whether its files exist, OpenClaw's config loads it,
 * and the library the state names is present with that sha256; and from the
 * last 24 hours of its daily logs, the turns, outcomes, error codes, the
 * deadline-miss rate and how often a suggested skill was then read.
 *
 * Read-only. Null when nothing of the plugin exists.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { catalogStatus } from '../../../core/skills/resolver/build.ts';
import { logsDir } from '../../../core/skills/resolver/paths.ts';
import { openclawSkillLibDir, openclawSkillPluginDir, openclawSkillPluginRegistered, readOpenclawSkillState } from '../../../core/setup/openclaw-skill-plugin.ts';

const LOG_WINDOW_MS = 24 * 3600 * 1000;
const LOG_READ_CAP = 4 * 1024 * 1024;
/** A deadline-miss rate above this blocks go-live (the plan's bar) and warns here. */
export const OPENCLAW_MISS_RATE_WARN = 0.05;

export interface OpenclawSkillView {
  plugin: 'installed' | 'files_only' | 'absent';
  library: 'ok' | 'missing' | 'mismatch' | 'none';
  gbrain_version: string | null;
  agents: Array<{ id: string; mode: string; catalog: string; fresh: boolean | null; stale_reason: string | null; skills: number; pins: number }>;
  recent: { turns: number; outcomes: Record<string, number>; errors: Record<string, number>; deadline_misses: number; miss_rate: number | null; reads: number; reads_of_suggested: number };
}

function recentOpenclaw(home: string, now: number): OpenclawSkillView['recent'] {
  const recent: OpenclawSkillView['recent'] = { turns: 0, outcomes: {}, errors: {}, deadline_misses: 0, miss_rate: null, reads: 0, reads_of_suggested: 0 };
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
      let j: { at?: unknown; outcome?: unknown; code?: unknown; suggested?: unknown };
      try { j = JSON.parse(line); } catch { continue; }
      if (typeof j.outcome !== 'string' || typeof j.at !== 'string' || now - Date.parse(j.at) > LOG_WINDOW_MS) continue;
      if (j.outcome === 'read') { recent.reads++; if (j.suggested === true) recent.reads_of_suggested++; continue; }
      if (['rebuilt', 'compaction'].includes(j.outcome)) continue;
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
  for (const [id, a] of Object.entries(state?.agents ?? {})) {
    const s = existsSync(join(home, 'skill-index', a.catalog, 'receipt.json')) ? await catalogStatus(a.catalog, { home }) : null;
    agents.push({ id, mode: a.mode, catalog: a.catalog, fresh: s ? s.fresh : null, stale_reason: s?.stale_reason ?? (s ? null : 'missing'), skills: s?.receipt?.skill_count ?? 0, pins: a.pinned_ids.length });
  }
  return { plugin: files ? (openclawSkillPluginRegistered(dir) ? 'installed' : 'files_only') : 'absent', library, gbrain_version: state?.gbrain_version ?? null, agents, recent: recentOpenclaw(home, now) };
}

/** One line for doctor's message, and the problem to warn about (null when healthy). */
export function describeOpenclawSkill(v: OpenclawSkillView): { line: string; problem: { code: string; what: string } | null } {
  const on = v.agents.filter((a) => a.mode !== 'off');
  const agents = v.agents.map((a) => `${a.id} ${a.mode}, ${a.skills} skills, ${a.fresh === null ? 'no catalog' : a.fresh ? 'fresh' : `stale (${a.stale_reason})`}, ${a.pins} pinned`).join('; ');
  const r = v.recent;
  const miss = r.miss_rate === null ? '' : `, deadline misses ${(r.miss_rate * 100).toFixed(1)}%`;
  const reads = r.reads ? `, ${r.reads_of_suggested}/${r.reads} skill reads were suggested` : '';
  const errs = Object.entries(r.errors).map(([c, n]) => `${c} x${n}`).join(', ');
  const line = `openclaw plugin ${v.plugin}, library ${v.library}; ${agents || 'no agent'}${r.turns ? `; last 24h ${r.turns} turns${miss}${reads}${errs ? `, ${errs}` : ''}` : ''}`;
  let problem: { code: string; what: string } | null = null;
  if (on.length && v.plugin !== 'installed') problem = { code: 'skill_resolver_plugin_not_installed', what: v.plugin === 'absent' ? 'the plugin files are missing' : "OpenClaw's config does not load, enable and allow the plugin" };
  else if (on.length && v.library !== 'ok') problem = { code: v.library === 'mismatch' ? 'skill_resolver_library_mismatch' : 'skill_resolver_library_missing', what: `the library the state names is ${v.library}` };
  else if (on.some((a) => a.fresh === null)) problem = { code: 'skill_index_missing', what: 'an agent has no catalog' };
  else if (r.miss_rate !== null && r.miss_rate > OPENCLAW_MISS_RATE_WARN && r.turns >= 20) problem = { code: 'skill_resolve_timeout', what: `${(r.miss_rate * 100).toFixed(1)}% of turns missed the 50 ms deadline and got no suggestions` };
  return { line, problem };
}
