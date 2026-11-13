/**
 * The Pi half of doctor's `skill_resolver` check: the gbrain-skill-resolver
 * extension (src/core/setup/pi-skill-extension.ts). It reports whether the
 * extension files and the state exist, whether the library the state names is
 * present with that sha256, the pi-user catalog's freshness and pin count,
 * and from the last 24 hours of its daily logs the runs, outcomes and error
 * codes. It always says that Pi started with extensions off (an embedder
 * such as QM) gets no suggestions, since nothing on this host can see that.
 *
 * Read-only. Null when nothing of the extension exists.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { catalogStatus } from '../../../core/skills/resolver/build.ts';
import { logsDir } from '../../../core/skills/resolver/paths.ts';
import { openclawSkillLibDir } from '../../../core/setup/openclaw-skill-plugin.ts';
import { piSkillExtensionDir, readPiSkillState } from '../../../core/setup/pi-skill-extension.ts';

const LOG_WINDOW_MS = 24 * 3600 * 1000;
const LOG_READ_CAP = 4 * 1024 * 1024;

export interface PiSkillView {
  extension: 'present' | 'absent';
  library: 'ok' | 'missing' | 'mismatch' | 'none';
  gbrain_version: string | null;
  catalog: { name: string; fresh: boolean | null; stale_reason: string | null; skills: number; pins: number } | null;
  recent: { runs: number; outcomes: Record<string, number>; errors: Record<string, number> };
  coverage: 'partial';
  coverage_note: string;
}

function recentPi(home: string, now: number): PiSkillView['recent'] {
  const recent: PiSkillView['recent'] = { runs: 0, outcomes: {}, errors: {} };
  const dir = logsDir(home);
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => /^pi-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-2); } catch { return recent; }
  for (const f of files) {
    let text = '';
    try {
      const p = join(dir, f);
      text = readFileSync(p, 'utf8');
      if (statSync(p).size > LOG_READ_CAP) text = text.slice(-LOG_READ_CAP);
    } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let j: { at?: unknown; outcome?: unknown; code?: unknown };
      try { j = JSON.parse(line); } catch { continue; }
      if (typeof j.outcome !== 'string' || typeof j.at !== 'string' || now - Date.parse(j.at) > LOG_WINDOW_MS) continue;
      if (j.outcome === 'rebuilt' || j.outcome === 'compaction') continue;
      recent.runs++;
      recent.outcomes[j.outcome] = (recent.outcomes[j.outcome] ?? 0) + 1;
      if (typeof j.code === 'string') recent.errors[j.code] = (recent.errors[j.code] ?? 0) + 1;
    }
  }
  return recent;
}

export async function piSkillView(home: string, now = Date.now()): Promise<PiSkillView | null> {
  const state = readPiSkillState(home);
  const files = existsSync(join(piSkillExtensionDir(), 'index.js'));
  if (!state && !files) return null;
  let library: PiSkillView['library'] = 'none';
  if (state) {
    try { library = createHash('sha256').update(readFileSync(join(openclawSkillLibDir(home), `${state.library_sha256}.mjs`))).digest('hex') === state.library_sha256 ? 'ok' : 'mismatch'; } catch { library = 'missing'; }
  }
  let catalog: PiSkillView['catalog'] = null;
  if (state) {
    const s = existsSync(join(home, 'skill-index', state.catalog, 'receipt.json')) ? await catalogStatus(state.catalog, { home }) : null;
    catalog = { name: state.catalog, fresh: s ? s.fresh : null, stale_reason: s?.stale_reason ?? (s ? null : 'missing'), skills: s?.receipt?.skill_count ?? 0, pins: state.pinned_ids.length };
  }
  return { extension: files ? 'present' : 'absent', library, gbrain_version: state?.gbrain_version ?? null, catalog, recent: recentPi(home, now),
    coverage: 'partial', coverage_note: 'Pi started with extensions off (pi --no-extensions, or an embedder such as QM) gets no suggestions' };
}

/** The line for harness_wiring, and the first problem with its code, if any. */
export function describePiSkillView(v: PiSkillView): { line: string; problem: { code: string; what: string } | null } {
  const c = v.catalog;
  const errs = Object.entries(v.recent.errors).map(([k, n]) => `${k} x${n}`).join(', ');
  const line = `pi extension ${v.extension}, ${c ? `${c.skills} skills in ${c.name}, ${c.fresh ? 'fresh' : `stale (${c.stale_reason})`}, ${c.pins} pinned` : 'no state'}${v.recent.runs ? `, last 24h ${v.recent.runs} runs${errs ? ` with ${errs}` : ''}` : ''} (partial: ${v.coverage_note})`;
  const problem = !c ? { code: 'skill_resolver_state_missing', what: 'the extension is present but its state file is missing, so it suggests nothing' }
    : v.extension === 'absent' ? { code: 'skill_resolver_plugin_not_installed', what: 'the state is on but the extension is gone from Pi\'s extensions directory' }
      : v.library === 'missing' ? { code: 'skill_resolver_library_missing', what: 'the library the state names is missing, so every run suggests nothing' }
        : v.library === 'mismatch' ? { code: 'skill_resolver_library_mismatch', what: 'the library does not match the sha256 the state names, so the worker refuses it' }
          : c.fresh === null ? { code: 'skill_index_missing', what: `the ${c.name} catalog is missing` } : null;
  return { line, problem };
}
