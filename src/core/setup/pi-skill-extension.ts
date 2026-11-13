/**
 * pi-skill-extension.ts — gbrain setup pi --skill-loading resolve|off: the
 * skill resolver for the Pi coding agent, as a generated Pi extension.
 *
 * Pi loads extensions into its own Node process from
 * $PI_CODING_AGENT_DIR/extensions (default ~/.pi/agent). Setup builds one
 * catalog, pi-user, from the skill directories Pi loads for every project
 * ($PI_CODING_AGENT_DIR/skills and ~/.agents/skills), keeps the resolver
 * library at ~/.gbrain/lib/<sha256>.mjs (the one the OpenClaw plugin uses),
 * writes a data-only state file (~/.gbrain/pi-skill-resolver.json) and the
 * extension (pi-skill-extension-code.ts). On each user run the extension
 * sends up to top_k suggestions as one hidden message and the pinned block as
 * a system prompt section; a skill Pi does not show the model that run is
 * never suggested. Project skills (.pi/skills, .agents/skills) are not in the
 * catalog. Pi run with extensions off (pi --no-extensions, or an embedder
 * whose resource loader sets noExtensions) gets nothing, and setup says so.
 *
 * Setup proves the extension resolves under Node (self-test) and, with pi on
 * PATH, that `pi --help` lists its --gbrain-skill-resolver flag. Nothing here
 * opens a brain, so a brainless or keyless home stays as it is.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { bunSpawnSync } from '../spawn.ts';
import { VERSION } from '../../version.ts';
import { buildSkillIndex, catalogStatus } from '../skills/resolver/build.ts';
import { ResolverError } from '../skills/resolver/errors.ts';
import { logsDir, skillIndexRoot } from '../skills/resolver/paths.ts';
import { readDirSources } from '../skills/resolver/sources.ts';
import { laneTurnSettings } from '../skills/resolver/config.ts';
import { ensureResolverLibrary, openclawSkillLibDir } from './openclaw-skill-plugin.ts';
import { piSkillLoaderJs, piSkillWorkerJs } from './pi-skill-extension-code.ts';
import { catalogSkillIds, pinnedBlockFor } from './skill-pins.ts';
import { readResolverConfig } from './skill-resolver-config.ts';

export const PI_SKILL_EXTENSION_ID = 'gbrain-skill-resolver';
export const PI_SKILL_CATALOG = 'pi-user';
export const PI_SKILL_FLAG = '--gbrain-skill-resolver';
const STATE_FILE = 'pi-skill-resolver.json';
const TOP_K_DEFAULT = 3;
const FLOOR_DEFAULT = 'description';
const CATALOG_IDS_MAX = 1024;
export const PI_NO_EXTENSIONS_NOTE = 'Pi started with extensions off (pi --no-extensions, or a program that embeds Pi with noExtensions, as QM does) loads no extension, so those sessions get no suggestions';

export interface PiSkillState {
  v: 1; gbrain_version: string; library_sha256: string; mode: 'live'; catalog: string; skill_dirs: string[];
  top_k: number; min_match: string; exclude_ids: string[]; pinned_block: string; pinned_ids: string[]; catalog_ids: string[];
}
export interface PiSkillStep { step: 'catalog' | 'library' | 'state' | 'extension' | 'self-test' | 'verify'; action: 'write' | 'keep' | 'remove' | 'skip' | 'run'; detail: string }
export interface PiSkillResult {
  mode: 'live' | 'off';
  steps: PiSkillStep[];
  catalog: string;
  skills: number;
  pins: number;
  notes: string[];
  error?: { code: 'skill_resolver_setup_incomplete' | 'skill_resolver_plugin_not_installed' | 'skill_resolver_selftest_failed' | 'skill_resolver_config_invalid' | 'skill_source_unreadable'; message: string };
}
type Run = (argv: string[]) => { ok: boolean; output: string };
export interface PiSkillDeps { piBin?: string | null; nodeBin?: string | null; run?: Run }

const home0 = () => process.env.HOME?.trim() || homedir();
export function piAgentDir(): string {
  const v = process.env.PI_CODING_AGENT_DIR?.trim();
  return v ? resolve(v.replace(/^~(?=\/|$)/, home0())) : join(home0(), '.pi', 'agent');
}
export const piSkillExtensionDir = (): string => join(piAgentDir(), 'extensions', PI_SKILL_EXTENSION_ID);
export const piSkillStatePath = (home: string): string => join(home, STATE_FILE);
/** The skill directories Pi loads in every project, whichever exist. */
export function piSkillDirs(): string[] {
  return [...new Set([join(piAgentDir(), 'skills'), join(home0(), '.agents', 'skills')].filter((d) => existsSync(d)))];
}

export function readPiSkillState(home: string): PiSkillState | null {
  try {
    const s = JSON.parse(readFileSync(piSkillStatePath(home), 'utf8')) as PiSkillState;
    return s && s.v === 1 && typeof s.catalog === 'string' ? s : null;
  } catch { return null; }
}

function defaultRun(argv: string[]): { ok: boolean; output: string } {
  const r = bunSpawnSync(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env, timeout: 60_000 });
  return { ok: r.exitCode === 0, output: `${r.stdout.toString()}${r.stderr.toString()}`.trim() };
}
function which(name: string): string | null {
  try { return Bun.which(name, { PATH: process.env.PATH ?? '' }); } catch { return null; }
}
const lastLine = (s: string) => s.trim().split('\n').at(-1) || 'no output';

function extensionFiles(home: string, gbrainBin: string, gbrainHomeEnv: string | null): Record<string, string> {
  const dir = piSkillExtensionDir();
  return {
    'package.json': `${JSON.stringify({ name: PI_SKILL_EXTENSION_ID, version: '1.0.0', private: true, type: 'module', pi: { extensions: ['./index.js'] } }, null, 2)}\n`,
    'index.js': piSkillLoaderJs({ home, libDir: openclawSkillLibDir(home), statePath: piSkillStatePath(home), logDir: logsDir(home), workerPath: join(dir, 'worker.js'), gbrainBin, gbrainHomeEnv }),
    'worker.js': piSkillWorkerJs(),
  };
}

/** Run one shadow turn through the generated extension under Node, the runtime Pi uses. */
function selfTest(node: string, dir: string, message: string, run: Run): { ok: boolean; detail: string } {
  const script = `import(${JSON.stringify(pathToFileURL(join(dir, 'index.js')).href)}).then((m) => m.selfTest(${JSON.stringify(message)})).then((r) => { console.log(JSON.stringify(r)); process.exit(0); }, (e) => { console.log(JSON.stringify({ ok: false, code: String(e && e.code || e) })); process.exit(0); });`;
  const r = run([node, '--input-type', 'module', '-e', script]);
  let doc: { ok?: boolean; code?: string; ms?: number; suggested?: string[] } = {};
  try { doc = JSON.parse(lastLine(r.output)); } catch { /* reported below */ }
  if (r.ok && doc.ok) return { ok: true, detail: `one turn through the extension under ${node}: ${doc.suggested?.length ?? 0} suggestion(s) in ${doc.ms ?? '?'} ms` };
  return { ok: false, detail: `the extension's self-test under ${node} failed (${doc.code ?? lastLine(r.output)})` };
}

export interface PiSkillSyncOptions { home: string; gbrainBin: string; gbrainHomeEnv: string | null; dryRun: boolean; refreshOnly?: boolean; deps?: PiSkillDeps }

/** Turn the Pi extension on, or refresh it (library, catalog and state only with refreshOnly). Never throws for an expected failure. */
export async function syncPiSkillExtension(opts: PiSkillSyncOptions): Promise<PiSkillResult> {
  const { home, dryRun } = opts;
  const deps = opts.deps ?? {};
  const run = deps.run ?? defaultRun;
  const out: PiSkillResult = { mode: 'live', steps: [], catalog: PI_SKILL_CATALOG, skills: 0, pins: 0, notes: [] };
  const fail = (code: NonNullable<PiSkillResult['error']>['code'], message: string): PiSkillResult => ({ ...out, error: { code, message } });
  if (!opts.gbrainBin.startsWith('/')) return fail('skill_resolver_setup_incomplete', 'No absolute gbrain binary was found for the extension (Pi may start with no PATH that has gbrain); pass --gbrain-bin. Nothing was written.');
  const dirs = piSkillDirs();
  if (dirs.length === 0) return fail('skill_resolver_setup_incomplete', `No Pi skill directory exists (looked for ${join(piAgentDir(), 'skills')} and ${join(home0(), '.agents', 'skills')}). Add a skill to one of them, then run setup again. Nothing was written.`);
  let lane: { top_k: number; min_match: string; exclude_ids: string[] };
  try {
    const read = readResolverConfig(home);
    const section = read.state === 'ok' ? (read.doc.skills as { resolver?: Record<string, unknown> } | undefined)?.resolver ?? {} : {};
    const s = laneTurnSettings(section, 'pi');
    lane = { top_k: s.top_k ?? TOP_K_DEFAULT, min_match: s.min_match_strength ?? FLOOR_DEFAULT, exclude_ids: s.exclude ?? [] };
  } catch (e) {
    if (e instanceof ResolverError && e.code === 'skill_resolver_config_invalid') return fail('skill_resolver_config_invalid', `${e.message} Nothing was written.`);
    throw e;
  }
  const catalog = PI_SKILL_CATALOG;
  const status = existsSync(join(skillIndexRoot(home), catalog, 'receipt.json')) ? await catalogStatus(catalog, { home }) : null;
  const fresh = !!status?.fresh && JSON.stringify(status.receipt?.source.dirs ?? null) === JSON.stringify(dirs) && (status.receipt?.skill_count ?? 0) > 0;
  let ids: string[];
  if (fresh) ids = [...(catalogSkillIds(home, catalog) ?? [])];
  else if (dryRun) ids = readDirSources(dirs).skills.map((s) => s.id);
  else {
    try { await buildSkillIndex({ catalog, dirs, harness: 'pi' }, { home }); } catch (e) {
      return fail(e instanceof ResolverError && e.code === 'skill_source_unreadable' ? 'skill_source_unreadable' : 'skill_resolver_setup_incomplete', `The pi-user catalog could not be built (${e instanceof ResolverError ? e.code : (e as Error).message}). Nothing else was written.`);
    }
    ids = [...(catalogSkillIds(home, catalog) ?? [])];
  }
  out.skills = fresh ? status!.receipt!.skill_count : ids.length;
  if (out.skills < 1) return fail('skill_resolver_setup_incomplete', `No model-invocable skill in ${dirs.join(', ')}. Add one, then run setup again.`);
  out.steps.push({ step: 'catalog', action: fresh ? 'keep' : 'write', detail: `${catalog}: ${out.skills} skills from ${dirs.join(', ')}` });
  const pins = dryRun ? { block: '', ids: [] as string[], unknown: [] as string[] } : pinnedBlockFor(home, catalog, 'pi');
  out.pins = pins.ids.length;
  if (pins.unknown.length) out.notes.push(`pinned skill(s) not in ${catalog}, left out of the block: ${pins.unknown.join(', ')} (skill_resolver_pin_unknown)`);
  if (ids.length > CATALOG_IDS_MAX) out.notes.push(`${catalog} holds ${ids.length} skills; only the first ${CATALOG_IDS_MAX} are checked against the skills Pi loads each run`);
  const dir = piSkillExtensionDir();
  const files = extensionFiles(home, opts.gbrainBin, opts.gbrainHomeEnv);
  const changed = Object.entries(files).some(([name, text]) => { try { return readFileSync(join(dir, name), 'utf8') !== text; } catch { return true; } });
  if (dryRun) {
    out.steps.push({ step: 'library', action: 'write', detail: `the Node library at ${openclawSkillLibDir(home)}/<sha256>.mjs` });
    out.steps.push({ step: 'state', action: 'write', detail: piSkillStatePath(home) });
    if (!opts.refreshOnly) out.steps.push({ step: 'extension', action: changed ? 'write' : 'keep', detail: dir });
    return out;
  }
  let lib: { sha256: string; wrote: boolean; path: string };
  try { lib = await ensureResolverLibrary(home); } catch (e) {
    return fail('skill_resolver_setup_incomplete', `The skill resolver library could not be built (${(e as Error).message}). The catalog was built; the state file and the extension were not written.`);
  }
  out.steps.push({ step: 'library', action: lib.wrote ? 'write' : 'keep', detail: lib.path });
  const state: PiSkillState = { v: 1, gbrain_version: VERSION, library_sha256: lib.sha256, mode: 'live', catalog, skill_dirs: dirs, top_k: lane.top_k, min_match: lane.min_match,
    exclude_ids: lane.exclude_ids, pinned_block: pins.block, pinned_ids: pins.ids, catalog_ids: ids.slice(0, CATALOG_IDS_MAX) };
  const stateText = `${JSON.stringify(state, null, 2)}\n`;
  const stateChanged = (() => { try { return readFileSync(piSkillStatePath(home), 'utf8') !== stateText; } catch { return true; } })();
  if (stateChanged) { mkdirSync(home, { recursive: true }); atomicWriteTextFile(piSkillStatePath(home), stateText, { freshMode: 0o600 }); }
  out.steps.push({ step: 'state', action: stateChanged ? 'write' : 'keep', detail: piSkillStatePath(home) });
  if (opts.refreshOnly) return out;
  try {
    if (changed) {
      mkdirSync(dir, { recursive: true });
      for (const [name, text] of Object.entries(files)) atomicWriteTextFile(join(dir, name), text, { freshMode: 0o644 });
    }
  } catch (e) {
    return fail('skill_resolver_plugin_not_installed', `The extension could not be written to ${dir} (${(e as Error).message}). The library, catalog and state were written.`);
  }
  out.steps.push({ step: 'extension', action: changed ? 'write' : 'keep', detail: dir });
  const node = deps.nodeBin !== undefined ? deps.nodeBin : which('node');
  if (!node) out.notes.push('no node on PATH, so the extension self-test did not run; Pi runs it under its own Node');
  else {
    const message = (() => { try { return readDirSources(dirs).skills.find((s) => s.description)?.description ?? 'help'; } catch { return 'help'; } })();
    const t = selfTest(node, dir, message, run);
    if (!t.ok) return fail('skill_resolver_selftest_failed', `${t.detail}. The extension is written but would not resolve a run.`);
    out.steps.push({ step: 'self-test', action: 'run', detail: t.detail });
  }
  const pi = deps.piBin !== undefined ? deps.piBin : which('pi');
  if (!pi) out.notes.push(`no pi on PATH, so setup could not check that Pi loads the extension; \`pi --help\` lists ${PI_SKILL_FLAG} once it does`);
  else {
    const help = run([pi, '--help']);
    if (!help.output.includes(PI_SKILL_FLAG)) return fail('skill_resolver_plugin_not_installed', `The extension was written to ${dir}, but \`${pi} --help\` does not list ${PI_SKILL_FLAG}, so this Pi does not load it (${lastLine(help.output)}). Check that PI_CODING_AGENT_DIR is the same for Pi and for this setup.`);
    out.steps.push({ step: 'verify', action: 'run', detail: `${pi} --help lists ${PI_SKILL_FLAG}` });
  }
  out.notes.push(PI_NO_EXTENSIONS_NOTE);
  return out;
}

/** Re-render the pinned block into the state file (gbrain skills pin add|remove); the extension reads it on its next run. True when it changed. */
export function refreshPiPins(home: string): boolean {
  const prior = readPiSkillState(home);
  if (!prior) return false;
  const pins = pinnedBlockFor(home, prior.catalog, 'pi');
  if (pins.block === prior.pinned_block && JSON.stringify(pins.ids) === JSON.stringify(prior.pinned_ids)) return false;
  atomicWriteTextFile(piSkillStatePath(home), `${JSON.stringify({ ...prior, pinned_block: pins.block, pinned_ids: pins.ids }, null, 2)}\n`, { freshMode: 0o600 });
  return true;
}

/** Remove the extension directory and the state file (pins stay in config.json). Null when neither exists. */
export function removePiSkillExtension(opts: { home: string; dryRun: boolean }): PiSkillResult | null {
  const dir = piSkillExtensionDir();
  const state = existsSync(piSkillStatePath(opts.home));
  if (!state && !existsSync(dir)) return null;
  const out: PiSkillResult = { mode: 'off', steps: [], catalog: PI_SKILL_CATALOG, skills: 0, pins: 0, notes: [] };
  if (existsSync(dir)) {
    if (!opts.dryRun) rmSync(dir, { recursive: true, force: true });
    out.steps.push({ step: 'extension', action: 'remove', detail: dir });
  }
  if (state) {
    if (!opts.dryRun) { try { unlinkSync(piSkillStatePath(opts.home)); } catch { /* gone */ } }
    out.steps.push({ step: 'state', action: 'remove', detail: `${piSkillStatePath(opts.home)} (pins stay in config.json)` });
  }
  return out;
}

/** One human line per step, matching setup's step lines. */
export function describePiSkill(r: PiSkillResult, dryRun: boolean): string[] {
  const lines = r.steps.map((s) => `  ${(dryRun && (s.action === 'write' || s.action === 'remove' || s.action === 'run') ? `would ${s.action}` : s.action).padEnd(8)} ${'resolver'.padEnd(7)} ${s.step}: ${s.detail}`);
  if (r.mode === 'live' && !r.error) lines.push(`skill resolver (pi): on; ${r.skills} skills in ${r.catalog}; ${r.pins} pinned`);
  for (const n of r.notes) lines.push(`  note     ${'resolver'.padEnd(7)} ${n}`);
  return lines;
}
