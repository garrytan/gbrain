/**
 * cursor-skill-pins.ts — gbrain setup cursor --skill-loading resolve|off:
 * the operator's pinned skills for one Cursor project, and nothing per turn.
 * No Cursor hook can add text to the model's request, so Cursor gets no
 * suggestions; its pinned skills go in a separate, always-applied project
 * rule that gbrain owns (.cursor/rules/gbrain-pinned-skills.mdc). The
 * user's own rules and gbrain's brain-first rule are never touched.
 *
 * Setup builds the project's catalog, cursor-project-<sha16 of the project
 * path>, from the skill directories Cursor loads there (the project's
 * .agents, .cursor, .claude and .codex skills, then the same four under the
 * home directory), and records the project in ~/.gbrain/cursor-skill-pins.json
 * so gbrain skills pin can rewrite the rule from any directory. Pins are
 * checked against that catalog, and each line names the skill's SKILL.md;
 * with no pins there is no rule file. Inside a git repository the rule's path
 * goes in the repository's info/exclude (never .gitignore), so it is never
 * committed. Off removes the rule, that exclude line and the project's
 * record; the pins stay in config.json.
 *
 * No check can see Cursor's request, so doctor reports Cursor as partial:
 * pinned only, no per-turn hook, unverified. Nothing here opens a brain.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { bunSpawnSync } from '../spawn.ts';
import { buildSkillIndex, catalogStatus } from '../skills/resolver/build.ts';
import { ResolverError } from '../skills/resolver/errors.ts';
import { skillIndexRoot } from '../skills/resolver/paths.ts';
import { readDirSources } from '../skills/resolver/sources.ts';
import { catalogSkillPaths, PIN_BLOCK_TOKEN_CAP, readPins, renderPinnedBlock, type PinnedBlock } from './skill-pins.ts';
import { readResolverConfig } from './skill-resolver-config.ts';

export const CURSOR_PINS_CATALOG_PREFIX = 'cursor-project-';
export const CURSOR_PINS_RULE = '.cursor/rules/gbrain-pinned-skills.mdc';
export const CURSOR_PINS_HEAD = '---\ndescription: Pinned skills, managed by gbrain (gbrain setup cursor --skill-loading off removes this file)\nalwaysApply: true\n---\n';
export const CURSOR_COVERAGE_NOTE = 'pinned only, no per-turn hook, unverified';
const STATE_FILE = 'cursor-skill-pins.json';
const SKILL_DIRS = ['.agents/skills', '.cursor/skills', '.claude/skills', '.codex/skills'];
const PINNED_ONLY_NOTE = 'Cursor gets the pinned skills only: no Cursor hook can add text to the model\'s request, so there are no per-turn suggestions, and no check can see that request, so this is unverified';

export interface CursorProjectRecord { catalog: string; skill_dirs: string[]; pinned_ids: string[] }
export interface CursorPinsState { v: 1; projects: Record<string, CursorProjectRecord> }
export interface CursorPinsStep { step: 'catalog' | 'rule' | 'exclude' | 'state'; action: 'write' | 'keep' | 'remove' | 'skip'; detail: string }
export interface CursorPinsResult {
  mode: 'pinned' | 'off';
  project: string;
  catalog: string;
  skills: number;
  pins: number;
  steps: CursorPinsStep[];
  notes: string[];
  error?: { code: 'skill_resolver_setup_incomplete' | 'skill_source_unreadable'; message: string };
}

const home0 = () => process.env.HOME?.trim() || homedir();
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
export const cursorPinsStatePath = (home: string): string => join(home, STATE_FILE);
export const cursorPinsCatalog = (project: string): string => CURSOR_PINS_CATALOG_PREFIX + createHash('sha256').update(real(project)).digest('hex').slice(0, 16);
export const cursorPinsRulePath = (project: string): string => join(project, ...CURSOR_PINS_RULE.split('/'));
const ours = (path: string) => { try { return readFileSync(path, 'utf8').startsWith(CURSOR_PINS_HEAD); } catch { return false; } };

/** The skill directories Cursor loads in this project, whichever exist, the project's first. */
export function cursorSkillDirs(project: string): string[] {
  const seen = new Set<string>();
  return [...SKILL_DIRS.map((d) => join(project, d)), ...SKILL_DIRS.map((d) => join(home0(), d))].filter((d) => {
    if (!existsSync(d) || seen.has(real(d))) return false;
    seen.add(real(d));
    return true;
  });
}

export function readCursorPinsState(home: string): CursorPinsState {
  try {
    const s = JSON.parse(readFileSync(cursorPinsStatePath(home), 'utf8')) as CursorPinsState;
    if (s && s.v === 1 && s.projects && typeof s.projects === 'object' && !Array.isArray(s.projects)) return s;
  } catch { /* none yet */ }
  return { v: 1, projects: {} };
}

function writeState(home: string, state: CursorPinsState): void {
  if (Object.keys(state.projects).length === 0) { try { unlinkSync(cursorPinsStatePath(home)); } catch { /* gone */ } return; }
  mkdirSync(home, { recursive: true });
  atomicWriteTextFile(cursorPinsStatePath(home), JSON.stringify(state, null, 2) + '\n', { freshMode: 0o600 });
}

/** One catalog's pins, each line naming its SKILL.md (Cursor loads a skill by reading its file). */
export function cursorPinnedBlock(home: string, catalog: string): PinnedBlock {
  const paths = catalogSkillPaths(home, catalog);
  return renderPinnedBlock(readPins(readResolverConfig(home), catalog), { harness: 'cursor', known: paths ? new Set(paths.keys()) : null, ...(paths ? { paths } : {}) });
}

/** The exclude file git reads for this project and the line that names the rule; null outside a git repository. */
function gitExclude(project: string): { file: string; line: string } | null {
  const r = bunSpawnSync(['git', '-C', project, 'rev-parse', '--show-toplevel', '--git-path', 'info/exclude'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  if (r.exitCode !== 0) return null;
  const [top, path] = r.stdout.toString().trim().split('\n');
  if (!top || !path) return null;
  const rel = relative(real(top), real(project)).split(sep).join('/');
  return { file: isAbsolute(path) ? path : join(project, path), line: '/' + (rel ? rel + '/' : '') + CURSOR_PINS_RULE };
}

function addExclude(ex: { file: string; line: string }, dryRun: boolean): CursorPinsStep {
  let text = '';
  try { text = readFileSync(ex.file, 'utf8'); } catch { /* git has none yet */ }
  if (text.split('\n').includes(ex.line)) return { step: 'exclude', action: 'keep', detail: ex.file + ' lists ' + ex.line };
  if (!dryRun) {
    mkdirSync(dirname(ex.file), { recursive: true });
    atomicWriteTextFile(ex.file, text + (text && !text.endsWith('\n') ? '\n' : '') + ex.line + '\n');
  }
  return { step: 'exclude', action: 'write', detail: ex.line + ' in ' + ex.file + ', so the rule is never committed' };
}

function dropExclude(ex: { file: string; line: string }, dryRun: boolean): CursorPinsStep | null {
  let text: string;
  try { text = readFileSync(ex.file, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  const kept = lines.filter((l) => l !== ex.line);
  if (kept.length === lines.length) return null;
  if (!dryRun) atomicWriteTextFile(ex.file, kept.join('\n'));
  return { step: 'exclude', action: 'remove', detail: ex.line + ' from ' + ex.file };
}

/** Write (or, with no pins, remove) the project's rule and its exclude line, and record the project. */
function place(home: string, out: CursorPinsResult, dirs: string[], dryRun: boolean): CursorPinsResult {
  const path = cursorPinsRulePath(out.project);
  if (existsSync(path) && !ours(path)) return { ...out, error: { code: 'skill_resolver_setup_incomplete', message: path + ' exists and is not gbrain\'s, so it was left as it is and no pins were placed. Move it, then run setup again.' } };
  const pins = cursorPinnedBlock(home, out.catalog);
  out.pins = pins.ids.length;
  if (pins.unknown.length) out.notes.push('pinned skill(s) not in ' + out.catalog + ', left out of the rule: ' + pins.unknown.join(', ') + ' (skill_resolver_pin_unknown)');
  if (pins.cut.length) out.notes.push('pinned skill(s) past the ' + PIN_BLOCK_TOKEN_CAP + '-token cap, left out of the rule: ' + pins.cut.join(', '));
  const ex = gitExclude(out.project);
  if (!pins.block) {
    if (existsSync(path)) {
      if (!dryRun) unlinkSync(path);
      out.steps.push({ step: 'rule', action: 'remove', detail: path + ' (no pins left)' });
      const d = ex && dropExclude(ex, dryRun);
      if (d) out.steps.push(d);
    } else out.steps.push({ step: 'rule', action: 'skip', detail: 'no pins for ' + out.catalog + ', so no rule file; add one with gbrain skills pin add <skill-id> --catalog ' + out.catalog });
  } else {
    const text = CURSOR_PINS_HEAD + pins.block + '\n';
    const same = (() => { try { return readFileSync(path, 'utf8') === text; } catch { return false; } })();
    if (!same && !dryRun) { mkdirSync(dirname(path), { recursive: true }); atomicWriteTextFile(path, text); }
    out.steps.push({ step: 'rule', action: same ? 'keep' : 'write', detail: path + ' (' + pins.ids.length + ' pinned, always applied)' });
    if (ex) out.steps.push(addExclude(ex, dryRun));
    else out.notes.push(out.project + ' is not in a git repository, so nothing was excluded from commits');
  }
  const state = readCursorPinsState(home);
  const rec: CursorProjectRecord = { catalog: out.catalog, skill_dirs: dirs, pinned_ids: pins.ids };
  const same = JSON.stringify(state.projects[out.project] ?? null) === JSON.stringify(rec);
  if (!same && !dryRun) { state.projects[out.project] = rec; writeState(home, state); }
  out.steps.push({ step: 'state', action: same ? 'keep' : 'write', detail: cursorPinsStatePath(home) });
  return out;
}

/** Turn pinned skills on for one Cursor project (the realpath of the directory setup runs in), or refresh them. Never throws for an expected failure. */
export async function syncCursorSkillPins(opts: { home: string; project: string; dryRun: boolean }): Promise<CursorPinsResult> {
  const { home, project, dryRun } = opts;
  const out: CursorPinsResult = { mode: 'pinned', project, catalog: cursorPinsCatalog(project), skills: 0, pins: 0, steps: [], notes: [] };
  const fail = (code: NonNullable<CursorPinsResult['error']>['code'], message: string): CursorPinsResult => ({ ...out, error: { code, message } });
  const dirs = cursorSkillDirs(project);
  if (dirs.length === 0) return fail('skill_resolver_setup_incomplete', 'No skill directory Cursor loads exists for ' + project + ' (looked for ' + SKILL_DIRS.join(', ') + ' there and under ' + home0() + '). Add a skill to one of them, then run setup again. Nothing was written.');
  const catalog = out.catalog;
  const status = existsSync(join(skillIndexRoot(home), catalog, 'receipt.json')) ? await catalogStatus(catalog, { home }) : null;
  const fresh = !!status?.fresh && JSON.stringify(status.receipt?.source.dirs ?? null) === JSON.stringify(dirs) && (status.receipt?.skill_count ?? 0) > 0;
  try {
    if (fresh) out.skills = status!.receipt!.skill_count;
    else if (dryRun) out.skills = readDirSources(dirs).skills.length;
    else {
      await buildSkillIndex({ catalog, dirs, harness: 'cursor', scope: 'project' }, { home });
      out.skills = catalogSkillPaths(home, catalog)?.size ?? 0;
    }
  } catch (e) {
    return fail(e instanceof ResolverError && e.code === 'skill_source_unreadable' ? 'skill_source_unreadable' : 'skill_resolver_setup_incomplete', 'The ' + catalog + ' catalog could not be built (' + (e instanceof ResolverError ? e.code : (e as Error).message) + '). Nothing else was written.');
  }
  if (out.skills < 1) return fail('skill_resolver_setup_incomplete', 'No model-invocable skill in ' + dirs.join(', ') + '. Add one, then run setup again.');
  out.steps.push({ step: 'catalog', action: fresh ? 'keep' : 'write', detail: catalog + ': ' + out.skills + ' skills from ' + dirs.join(', ') });
  if (dryRun && !fresh) {
    out.steps.push({ step: 'rule', action: 'write', detail: cursorPinsRulePath(project) + ' once ' + catalog + ' is built and has pins' });
    out.steps.push({ step: 'state', action: 'write', detail: cursorPinsStatePath(home) });
    out.notes.push(PINNED_ONLY_NOTE);
    return out;
  }
  const placed = place(home, out, dirs, dryRun);
  if (!placed.error) placed.notes.push(PINNED_ONLY_NOTE);
  return placed;
}

/** Rewrite the rule of the project whose catalog this is (gbrain skills pin add|remove). Null when no project has it. */
export function refreshCursorPins(home: string, catalog: string): CursorPinsResult | null {
  const state = readCursorPinsState(home);
  const project = Object.keys(state.projects).find((p) => state.projects[p]!.catalog === catalog);
  if (!project) return null;
  const out: CursorPinsResult = { mode: 'pinned', project, catalog, skills: 0, pins: 0, steps: [], notes: [] };
  if (!existsSync(project)) return { ...out, error: { code: 'skill_resolver_setup_incomplete', message: project + ' no longer exists, so no rule was written there; the pins are saved in config.json. Recreate the project and run gbrain setup cursor --skill-loading resolve in it.' } };
  return place(home, out, state.projects[project]!.skill_dirs, false);
}

/** Remove the project's rule (only gbrain's), its exclude line and its record; pins stay in config.json. Null when none of them exists. */
export function removeCursorSkillPins(opts: { home: string; project: string; dryRun: boolean }): CursorPinsResult | null {
  const { home, project, dryRun } = opts;
  const path = cursorPinsRulePath(project);
  const state = readCursorPinsState(home);
  const rec = state.projects[project];
  const mine = existsSync(path) && ours(path);
  const ex = gitExclude(project);
  const exStep = ex ? dropExclude(ex, dryRun) : null;
  if (!rec && !mine && !exStep) return null;
  const out: CursorPinsResult = { mode: 'off', project, catalog: rec?.catalog ?? cursorPinsCatalog(project), skills: 0, pins: 0, steps: [], notes: [] };
  if (mine) {
    if (!dryRun) unlinkSync(path);
    out.steps.push({ step: 'rule', action: 'remove', detail: path });
  } else if (existsSync(path)) out.notes.push(path + ' is not gbrain\'s, so it was left as it is');
  if (exStep) out.steps.push(exStep);
  if (rec) {
    if (!dryRun) { delete state.projects[project]; writeState(home, state); }
    out.steps.push({ step: 'state', action: 'remove', detail: project + ' from ' + cursorPinsStatePath(home) + ' (pins stay in config.json)' });
  }
  return out;
}

/** One human line per step, matching setup's step lines. */
export function describeCursorPins(r: CursorPinsResult, dryRun: boolean): string[] {
  const lines = r.steps.map((s) => '  ' + (dryRun && (s.action === 'write' || s.action === 'remove') ? 'would ' + s.action : s.action).padEnd(8) + ' ' + 'pins'.padEnd(7) + ' ' + s.step + ': ' + s.detail);
  if (r.mode === 'pinned' && !r.error) lines.push('skill pins (cursor): ' + r.pins + ' pinned from ' + r.catalog + ' (' + r.skills + ' skills); ' + CURSOR_COVERAGE_NOTE);
  for (const n of r.notes) lines.push('  note     ' + 'pins'.padEnd(7) + ' ' + n);
  return lines;
}
