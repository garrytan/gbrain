/**
 * openclaw-skill-plugin.ts — `gbrain setup openclaw --skill-loading
 * resolve|shadow|off`: the generated OpenClaw plugin `gbrain-skill-resolver`,
 * a sibling of the brain-first `gbrain-turn-rule` plugin (a resolver bug can
 * never take the rule down with it).
 *
 * What setup writes:
 *  - the Node library, content-addressed at <gbrain home>/lib/<sha256>.mjs
 *    (built from this gbrain's own source, mode 0644);
 *  - one catalog per agent, `openclaw-<agent>`, over the agent's skill
 *    directories (<workspace>/skills and <OpenClaw state dir>/skills);
 *  - a data-only state file, <gbrain home>/openclaw-skill-resolver.json
 *    (mode 0600): per agent its mode, catalog, top_k, floor, live fraction
 *    and rendered pinned block, plus the library's sha256. It never names a
 *    path to code: the library directory and the gbrain bin are baked into
 *    the plugin's index.js;
 *  - the plugin itself under <OpenClaw state dir>/gbrain/gbrain-skill-resolver.
 *
 * OpenClaw's CLI (install --link, enable, the conversation-access grant) runs
 * only when the plugin files changed or OpenClaw's config does not show the
 * plugin installed, enabled and allowed, so a mode flip, a pin change or a
 * bare refresh writes the state file and nothing else: no reload, no drained
 * admission. A failed or partial install is never reported as success: it
 * ends `skill_resolver_plugin_not_installed` with the commands still to run.
 */
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { bunSpawnSync } from '../spawn.ts';
import { VERSION } from '../../version.ts';
import { buildSkillIndex, catalogStatus } from '../skills/resolver/build.ts';
import { ResolverError } from '../skills/resolver/errors.ts';
import { logsDir, skillIndexRoot } from '../skills/resolver/paths.ts';
import { readDirSources } from '../skills/resolver/sources.ts';
import { openclawConfigPath, openclawStateDir, parseJson5ish, resolveOpenclawWorkspace } from './brain-first.ts';
import { openclawSkillLoaderJs, openclawSkillWorkerJs } from './openclaw-skill-plugin-code.ts';
import { pinnedBlockFor } from './skill-pins.ts';
import { readResolverConfig } from './skill-resolver-config.ts';
import { laneTurnSettings } from '../skills/resolver/config.ts';

export const OPENCLAW_SKILL_PLUGIN_ID = 'gbrain-skill-resolver';
export const OPENCLAW_SKILL_STATE_FILE = 'openclaw-skill-resolver.json';
export const OPENCLAW_TOP_K_DEFAULT = 3;
export const OPENCLAW_FLOOR_DEFAULT = 'description';
export type OpenclawSkillMode = 'live' | 'shadow' | 'off';

export interface OpenclawSkillAgentState {
  mode: OpenclawSkillMode;
  catalog: string;
  skill_dirs: string[];
  top_k: number;
  min_match: string;
  /** skills.resolver.pinned: skills OpenClaw loads itself, so they are never suggested. */
  exclude_ids: string[];
  live_fraction: number;
  pins_route: 'system' | 'first_turn';
  pinned_block: string;
  pinned_ids: string[];
  owner_sender_ids: string[];
}
export interface OpenclawSkillState { v: 1; gbrain_version: string; library_sha256: string; agents: Record<string, OpenclawSkillAgentState> }

export interface OpenclawSkillStep { step: 'library' | 'catalog' | 'state' | 'plugin' | 'install' | 'verify' | 'self-test'; action: 'write' | 'keep' | 'remove' | 'skip' | 'run'; detail: string }
export interface OpenclawSkillError { code: 'skill_resolver_plugin_not_installed' | 'skill_resolver_setup_incomplete' | 'skill_resolver_host_not_local' | 'skill_resolver_selftest_failed' | 'skill_source_unreadable' | 'skill_resolver_config_invalid'; message: string; commands?: string[]; argv?: string[]; recovery?: string }
export interface OpenclawSkillResult {
  mode: OpenclawSkillMode;
  steps: OpenclawSkillStep[];
  agents: Array<{ id: string; mode: OpenclawSkillMode; catalog: string; skills: number; pins: number; unknown_pins: string[] }>;
  notes: string[];
  error?: OpenclawSkillError;
}

type Run = (argv: string[]) => { ok: boolean; output: string };

export interface OpenclawSkillDeps {
  openclawBin?: string | null;
  nodeBin?: string | null;
  run?: Run;
}

export const openclawSkillPluginDir = (): string => join(openclawStateDir(), 'gbrain', OPENCLAW_SKILL_PLUGIN_ID);
export const openclawSkillStatePath = (home: string): string => join(home, OPENCLAW_SKILL_STATE_FILE);
export const openclawSkillLibDir = (home: string): string => join(home, 'lib');

function defaultRun(argv: string[]): { ok: boolean; output: string } {
  const r = bunSpawnSync(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env, timeout: 120_000 });
  return { ok: r.exitCode === 0, output: `${r.stdout.toString()}${r.stderr.toString()}`.trim() };
}

function which(name: string): string | null {
  try { return Bun.which(name, { PATH: process.env.PATH ?? '' }); } catch { return null; }
}

const shown = (argv: string[]) => argv.map((a) => (/^[\w./:=@-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
const lastLine = (s: string) => s.trim().split('\n').at(-1) || 'no output';

/** `openclaw-<agent>`, folded to the catalog-name alphabet; an id the fold changes gets a short hash of itself, so two agents never share a catalog. */
export function openclawCatalogName(agentId: string): string {
  const slug = agentId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+/, '');
  if (slug && slug === agentId && slug.length <= 54) return `openclaw-${slug}`;
  return `openclaw-${slug.slice(0, 45) || 'agent'}-${createHash('sha256').update(agentId).digest('hex').slice(0, 8)}`;
}

interface RosterEntry { id: string; workspace?: string }

/** The agents openclaw.json defines (agents.list[] or agents.entries), each with its workspace when set. */
export function openclawRoster(): RosterEntry[] {
  try {
    const cfg = parseJson5ish(readFileSync(openclawConfigPath(), 'utf8')) as { agents?: { list?: unknown; entries?: unknown } } | undefined;
    const ws = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    if (Array.isArray(cfg?.agents?.list)) {
      return cfg!.agents!.list.flatMap((a): RosterEntry[] => (a && typeof (a as { id?: unknown }).id === 'string' ? [{ id: (a as { id: string }).id, workspace: ws((a as { workspace?: unknown }).workspace) }] : []));
    }
    if (cfg?.agents?.entries && typeof cfg.agents.entries === 'object') {
      return Object.entries(cfg.agents.entries as Record<string, { workspace?: unknown }>).map(([id, a]) => ({ id, workspace: ws(a?.workspace) }));
    }
  } catch { /* no readable config: the default agent only */ }
  return [];
}

/** The skill directories one agent loads: its workspace's skills/ and the state dir's shared skills/, whichever exist. */
export function openclawAgentSkillDirs(agentId: string, roster: RosterEntry[] = openclawRoster()): string[] {
  const entry = roster.find((r) => r.id === agentId);
  let workspace = entry?.workspace;
  if (!workspace && (roster.length <= 1 || agentId === 'main')) {
    const w = resolveOpenclawWorkspace();
    if (!('error' in w)) workspace = w.path;
  }
  const dirs = [workspace ? join(workspace.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'), 'skills') : null, join(openclawStateDir(), 'skills')];
  return [...new Set(dirs.filter((d): d is string => !!d && existsSync(d)))];
}

export function readOpenclawSkillState(home: string): OpenclawSkillState | null {
  try {
    const s = JSON.parse(readFileSync(openclawSkillStatePath(home), 'utf8')) as OpenclawSkillState;
    return s && s.v === 1 && s.agents && typeof s.agents === 'object' ? s : null;
  } catch { return null; }
}

function pluginFiles(home: string, gbrainBin: string, gbrainHomeEnv: string | null): Record<string, string> {
  return {
    'package.json': `${JSON.stringify({ name: OPENCLAW_SKILL_PLUGIN_ID, version: '1.0.0', private: true, type: 'module', openclaw: { extensions: ['./index.js'] } }, null, 2)}\n`,
    'openclaw.plugin.json': `${JSON.stringify({ id: OPENCLAW_SKILL_PLUGIN_ID, name: 'GBrain skill resolver', description: 'Suggests the installed skills that fit each user message, plus the operator\'s pinned skills (managed by gbrain setup openclaw).', configSchema: { type: 'object', additionalProperties: false } }, null, 2)}\n`,
    'index.js': openclawSkillLoaderJs({ home, libDir: openclawSkillLibDir(home), statePath: openclawSkillStatePath(home), logDir: logsDir(home), gbrainBin, gbrainHomeEnv }),
    'worker.js': openclawSkillWorkerJs(),
  };
}

const installArgv = (bin: string, dir: string): string[][] => [
  [bin, 'plugins', 'install', '--link', dir, '--force', '--accept-capabilities'],
  [bin, 'plugins', 'enable', OPENCLAW_SKILL_PLUGIN_ID],
  [bin, 'config', 'set', `plugins.entries.${OPENCLAW_SKILL_PLUGIN_ID}.hooks.allowConversationAccess`, 'true'],
];

/** Whether OpenClaw's config already loads, enables and allows the plugin (so no CLI call is needed). */
export function openclawSkillPluginRegistered(dir = openclawSkillPluginDir()): boolean {
  try {
    const cfg = parseJson5ish(readFileSync(openclawConfigPath(), 'utf8')) as { plugins?: { load?: { paths?: unknown }; entries?: Record<string, { enabled?: unknown; hooks?: { allowConversationAccess?: unknown } }> } } | undefined;
    const entry = cfg?.plugins?.entries?.[OPENCLAW_SKILL_PLUGIN_ID];
    const paths = Array.isArray(cfg?.plugins?.load?.paths) ? cfg!.plugins!.load!.paths as unknown[] : [];
    return !!entry && entry.enabled !== false && entry.hooks?.allowConversationAccess === true && paths.includes(dir);
  } catch { return false; }
}

/** Build the library from this gbrain's source and keep it at <lib>/<sha256>.mjs, writable by its owner only. */
async function ensureLibrary(home: string, previous: string | null): Promise<{ sha256: string; wrote: boolean; path: string }> {
  const { buildResolverLibrary, LIBRARY_FILE } = await import('../../commands/skill-resolver-library.ts');
  const dir = openclawSkillLibDir(home);
  const built = await buildResolverLibrary(join(dir, LIBRARY_FILE));
  const target = join(dir, `${built.sha256}.mjs`);
  const wrote = !existsSync(target);
  if (wrote) copyFileSync(built.path, target);
  chmodSync(target, 0o644);
  for (const f of readdirSync(dir)) {
    if (/^[0-9a-f]{64}\.mjs$/.test(f) && f !== `${built.sha256}.mjs` && f !== `${previous}.mjs`) rmSync(join(dir, f), { force: true });
  }
  return { sha256: built.sha256, wrote, path: target };
}

function sampleMessage(dirs: string[]): string {
  try { return readDirSources(dirs).skills.find((s) => s.description)?.description ?? 'help'; } catch { return 'help'; }
}

/** Run one turn through the generated plugin under Node (the runtime the gateway uses), with this shell's NODE_OPTIONS. */
function selfTest(node: string, dir: string, agentId: string, message: string, run: Run): { ok: boolean; detail: string } {
  const script = `import(${JSON.stringify(pathToFileURL(join(dir, 'index.js')).href)}).then((m) => m.default.selfTest(${JSON.stringify(agentId)}, ${JSON.stringify(message)})).then((r) => { console.log(JSON.stringify(r)); process.exit(0); }, (e) => { console.log(JSON.stringify({ ok: false, code: String(e && e.code || e) })); process.exit(0); });`;
  const r = run([node, '--input-type', 'module', '-e', script]);
  let doc: { ok?: boolean; code?: string; ms?: number; suggested?: string[] } = {};
  try { doc = JSON.parse(lastLine(r.output)); } catch { /* reported below */ }
  if (r.ok && doc.ok) return { ok: true, detail: `one turn through the plugin under ${node}: ${doc.suggested?.length ?? 0} suggestion(s) in ${doc.ms ?? '?'} ms` };
  return { ok: false, detail: `the plugin's self-test under ${node} failed (${doc.code ?? lastLine(r.output)})` };
}

function hostCount(run: Run, bin: string, agentId: string): number | null {
  const r = run([bin, 'skills', 'list', '--json', '--agent', agentId]);
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.output) as unknown;
    const list = Array.isArray(j) ? j : Array.isArray((j as { skills?: unknown })?.skills) ? (j as { skills: unknown[] }).skills : null;
    return list ? list.length : null;
  } catch { return null; }
}

export interface OpenclawSkillSyncOptions {
  mode: 'live' | 'shadow' | null;
  agents: string[] | 'all' | null;
  home: string;
  gbrainBin: string;
  gbrainHomeEnv: string | null;
  dryRun: boolean;
  /** Library, catalogs and state only: never the plugin files or OpenClaw's CLI (setup --skills-index-only, the plugin's own skew refresh). */
  refreshOnly?: boolean;
  /** Rollout knobs from setup flags; unset ones keep the agent's prior value. */
  tuning?: { live_fraction?: number; pins_route?: 'system' | 'first_turn'; owner_sender_ids?: string[] };
  deps?: OpenclawSkillDeps;
}

/** The lane's own turn settings for openclaw (per_harness, then the global keys), else the OpenClaw defaults. Throws skill_resolver_config_invalid on a bad value, as every lane does. */
function openclawLaneConfig(home: string): { top_k: number; min_match: string; exclude_ids: string[] } {
  const read = readResolverConfig(home);
  const section = read.state === 'ok' ? (read.doc.skills as { resolver?: Record<string, unknown> } | undefined)?.resolver ?? {} : {};
  const s = laneTurnSettings(section, 'openclaw');
  return { top_k: s.top_k ?? OPENCLAW_TOP_K_DEFAULT, min_match: s.min_match_strength ?? OPENCLAW_FLOOR_DEFAULT, exclude_ids: s.exclude ?? [] };
}

/** Turn the plugin on (live or shadow) for some agents, or refresh what is on. Never throws for an expected failure. */
export async function syncOpenclawSkillPlugin(opts: OpenclawSkillSyncOptions): Promise<OpenclawSkillResult> {
  const { home, dryRun } = opts;
  const deps = opts.deps ?? {};
  const run = deps.run ?? defaultRun;
  const out: OpenclawSkillResult = { mode: opts.mode ?? 'live', steps: [], agents: [], notes: [] };
  const fail = (e: OpenclawSkillError) => ({ ...out, error: e });
  const bin = deps.openclawBin !== undefined ? deps.openclawBin : which('openclaw');
  if (!bin && !existsSync(openclawStateDir())) {
    return fail({ code: 'skill_resolver_host_not_local', message: `No openclaw on PATH and no OpenClaw state directory at ${openclawStateDir()}, so this is not the OpenClaw host. The plugin runs inside the gateway and needs this gbrain home, library and bin on the same machine.` });
  }
  if (!opts.gbrainBin.startsWith('/')) return fail({ code: 'skill_resolver_setup_incomplete', message: 'No absolute gbrain binary was found for the plugin (the gateway inherits no PATH); pass --gbrain-bin. Nothing was written.' });

  const prior = readOpenclawSkillState(home);
  const roster = openclawRoster();
  const on = prior ? Object.keys(prior.agents).filter((id) => prior.agents[id]!.mode !== 'off') : [];
  const ids = opts.agents === 'all' ? (roster.length ? roster.map((r) => r.id) : ['main'])
    : opts.agents ?? (on.length || !opts.mode ? on : prior && Object.keys(prior.agents).length ? Object.keys(prior.agents) : ['main']);
  if (ids.length === 0) return { ...out, notes: ['No agent has the skill resolver on; nothing to refresh.'] };

  const agents: Record<string, OpenclawSkillAgentState> = { ...(prior?.agents ?? {}) };
  let lane: ReturnType<typeof openclawLaneConfig>;
  try { lane = openclawLaneConfig(home); } catch (e) {
    if (e instanceof ResolverError && e.code === 'skill_resolver_config_invalid') return fail({ code: 'skill_resolver_config_invalid', message: `${e.message} Nothing was written.` });
    throw e;
  }
  const tune = opts.tuning ?? {};
  for (const id of ids) {
    const before = prior?.agents[id];
    const dirs = openclawAgentSkillDirs(id, roster);
    const catalog = openclawCatalogName(id);
    if (dirs.length === 0) { out.notes.push(`agent ${id}: no skill directory exists (looked for <workspace>/skills and ${join(openclawStateDir(), 'skills')}), so it was skipped`); continue; }
    let skills = 0;
    const status = existsSync(join(skillIndexRoot(home), catalog, 'receipt.json')) ? await catalogStatus(catalog, { home }) : null;
    const fresh = !!status?.fresh && JSON.stringify(status.receipt?.source.dirs ?? null) === JSON.stringify(dirs) && (status.receipt?.skill_count ?? 0) > 0;
    if (fresh) skills = status!.receipt!.skill_count;
    else if (dryRun) skills = readDirSources(dirs).skills.length;
    else {
      try { skills = (await buildSkillIndex({ catalog, dirs, harness: 'openclaw' }, { home })).catalog.skill_count; } catch (e) {
        out.notes.push(`agent ${id}: the catalog build failed (${e instanceof ResolverError ? e.code : (e as Error).message}), so it was skipped`);
        continue;
      }
    }
    if (skills < 1) { out.notes.push(`agent ${id}: no model-invocable skill in ${dirs.join(', ')}, so it was skipped`); continue; }
    out.steps.push({ step: 'catalog', action: fresh ? 'keep' : 'write', detail: `${catalog}: ${skills} skills from ${dirs.join(', ')}` });
    const pins = dryRun ? { block: '', ids: [], unknown: [] as string[] } : pinnedBlockFor(home, catalog, 'openclaw');
    agents[id] = {
      mode: opts.mode ?? before?.mode ?? 'live', catalog, skill_dirs: dirs,
      top_k: lane.top_k, min_match: lane.min_match, exclude_ids: lane.exclude_ids,
      live_fraction: tune.live_fraction ?? before?.live_fraction ?? 1, pins_route: tune.pins_route ?? before?.pins_route ?? 'system',
      pinned_block: pins.block, pinned_ids: pins.ids, owner_sender_ids: tune.owner_sender_ids ?? before?.owner_sender_ids ?? [],
    };
    out.agents.push({ id, mode: agents[id]!.mode, catalog, skills, pins: pins.ids.length, unknown_pins: pins.unknown });
    if (pins.unknown.length) out.notes.push(`agent ${id}: pinned skill(s) not in ${catalog}, left out of the block: ${pins.unknown.join(', ')} (skill_resolver_pin_unknown)`);
  }
  if (out.agents.length === 0) return fail({ code: 'skill_resolver_setup_incomplete', message: `The skill resolver was not turned on for any agent: ${out.notes.join('; ')}. Nothing was written.` });

  const dir = openclawSkillPluginDir();
  const files = pluginFiles(home, opts.gbrainBin, opts.gbrainHomeEnv);
  const changed = Object.entries(files).some(([name, text]) => { try { return readFileSync(join(dir, name), 'utf8') !== text; } catch { return true; } });
  const registered = openclawSkillPluginRegistered(dir);
  if (dryRun) {
    out.steps.push({ step: 'library', action: 'write', detail: `the Node library at ${openclawSkillLibDir(home)}/<sha256>.mjs` });
    out.steps.push({ step: 'state', action: 'write', detail: openclawSkillStatePath(home) });
    if (!opts.refreshOnly) {
      out.steps.push({ step: 'plugin', action: changed ? 'write' : 'keep', detail: `${OPENCLAW_SKILL_PLUGIN_ID} at ${dir}` });
      out.steps.push({ step: 'install', action: changed || !registered ? 'run' : 'skip', detail: changed || !registered ? installArgv(bin ?? 'openclaw', dir).map(shown).join('; ') : 'already installed, enabled and allowed in OpenClaw' });
    }
    return out;
  }

  let lib: { sha256: string; wrote: boolean; path: string };
  try { lib = await ensureLibrary(home, prior?.library_sha256 ?? null); } catch (e) {
    return fail({ code: e instanceof ResolverError && e.code === 'skill_source_unreadable' ? 'skill_source_unreadable' : 'skill_resolver_setup_incomplete',
      message: `The skill resolver library could not be built (${(e as Error).message}). The catalogs were built; the state file and the plugin were not written.` });
  }
  out.steps.push({ step: 'library', action: lib.wrote ? 'write' : 'keep', detail: lib.path });
  const state: OpenclawSkillState = { v: 1, gbrain_version: VERSION, library_sha256: lib.sha256, agents };
  const stateText = `${JSON.stringify(state, null, 2)}\n`;
  const stateChanged = (() => { try { return readFileSync(openclawSkillStatePath(home), 'utf8') !== stateText; } catch { return true; } })();
  if (stateChanged) { mkdirSync(home, { recursive: true }); atomicWriteTextFile(openclawSkillStatePath(home), stateText, { freshMode: 0o600 }); chmodSync(openclawSkillStatePath(home), 0o600); }
  out.steps.push({ step: 'state', action: stateChanged ? 'write' : 'keep', detail: `${openclawSkillStatePath(home)} (${Object.entries(agents).map(([id, a]) => `${id} ${a.mode}`).join(', ')})` });
  if (opts.refreshOnly) return out;

  try {
    if (changed) {
      mkdirSync(dir, { recursive: true });
      for (const [name, text] of Object.entries(files)) atomicWriteTextFile(join(dir, name), text, { freshMode: 0o644 });
    }
  } catch (e) {
    return fail({ code: 'skill_resolver_plugin_not_installed', message: `The plugin could not be written to ${dir} (${(e as Error).message}).`, recovery: 'partial: the library, catalogs and state were written; the plugin files were not, and no OpenClaw command ran.' });
  }
  out.steps.push({ step: 'plugin', action: changed ? 'write' : 'keep', detail: `${OPENCLAW_SKILL_PLUGIN_ID} at ${dir}` });
  const commands = installArgv(bin ?? 'openclaw', dir);
  if (!changed && registered) out.steps.push({ step: 'install', action: 'skip', detail: 'already installed, enabled and allowed in OpenClaw; mode and pins are read from the state file, so nothing reloads' });
  else {
    if (!bin) return fail({ code: 'skill_resolver_plugin_not_installed', message: `The plugin was written to ${dir}, but there is no openclaw on PATH, so OpenClaw has not installed it.`, commands: commands.map(shown), argv: commands[0], recovery: `partial: files written, 0 of ${commands.length} commands ran; run them on the OpenClaw host, restart the gateway, then gbrain doctor --only skill_resolver` });
    for (const [i, argv] of commands.entries()) {
      const r = run(argv);
      if (!r.ok) return fail({ code: 'skill_resolver_plugin_not_installed', message: `\`${shown(argv)}\` failed (${lastLine(r.output)}).`, commands: commands.slice(i).map(shown), argv: argv, recovery: `partial: files written, ${i} of ${commands.length} commands ran; run the rest, restart the gateway, then gbrain doctor --only skill_resolver` });
    }
    out.steps.push({ step: 'install', action: 'run', detail: `installed, enabled and allowed with the openclaw CLI; restart the gateway once to load new plugin code` });
    const inspect = run([bin, 'plugins', 'inspect', OPENCLAW_SKILL_PLUGIN_ID, '--runtime', '--json']);
    const loaded = inspect.ok && inspect.output.includes('before_prompt_build') && /"status"\s*:\s*"loaded"|"imported"\s*:\s*true/.test(inspect.output) && !/"status"\s*:\s*"(?:error|disabled)"/.test(inspect.output);
    if (!loaded) return fail({ code: 'skill_resolver_plugin_not_installed', message: `\`openclaw plugins inspect ${OPENCLAW_SKILL_PLUGIN_ID} --runtime --json\` does not show the plugin loaded with before_prompt_build (${lastLine(inspect.output)}).`, commands: [shown([bin, 'plugins', 'inspect', OPENCLAW_SKILL_PLUGIN_ID, '--runtime', '--json'])], argv: [bin, 'plugins', 'inspect', OPENCLAW_SKILL_PLUGIN_ID, '--runtime', '--json'], recovery: `partial: files written, ${commands.length} of ${commands.length} commands ran, but OpenClaw does not load the plugin; check the inspect output, then gbrain doctor --only skill_resolver` });
    out.steps.push({ step: 'verify', action: 'run', detail: 'openclaw loads it with before_prompt_build' });
  }
  if (bin) {
    for (const a of out.agents) {
      const n = hostCount(run, bin, a.id);
      if (n !== null && n < a.skills) out.notes.push(`agent ${a.id}: OpenClaw lists ${n} skills but ${a.catalog} holds ${a.skills}; OpenClaw dropped some at load (skills.limits.maxCandidatesPerRoot), and skills_read cannot open those (skill_resolver_host_load_cut)`);
    }
  }
  const node = deps.nodeBin !== undefined ? deps.nodeBin : which('node');
  if (!node) out.notes.push('no node on PATH, so the plugin self-test did not run; the gateway runs it under its own Node');
  else {
    const first = out.agents[0]!;
    const t = selfTest(node, dir, first.id, sampleMessage(agents[first.id]!.skill_dirs), run);
    if (!t.ok) return fail({ code: 'skill_resolver_selftest_failed', message: `${t.detail}. The plugin is installed but would not resolve a turn.` });
    out.steps.push({ step: 'self-test', action: 'run', detail: t.detail });
  }
  return out;
}

/**
 * Re-render every OpenClaw agent's pinned block from config.json into the
 * state file (gbrain skills pin add|remove). The plugin re-reads the state on
 * its next turn, so nothing reloads and no OpenClaw command runs. Returns the
 * agents whose block changed.
 */
export function refreshOpenclawPins(home: string): string[] {
  const prior = readOpenclawSkillState(home);
  if (!prior) return [];
  const changed: string[] = [];
  const agents = { ...prior.agents };
  for (const [id, a] of Object.entries(agents)) {
    const pins = pinnedBlockFor(home, a.catalog, 'openclaw');
    if (pins.block === a.pinned_block && JSON.stringify(pins.ids) === JSON.stringify(a.pinned_ids)) continue;
    agents[id] = { ...a, pinned_block: pins.block, pinned_ids: pins.ids };
    changed.push(id);
  }
  if (changed.length) atomicWriteTextFile(openclawSkillStatePath(home), `${JSON.stringify({ ...prior, agents }, null, 2)}\n`, { freshMode: 0o600 });
  return changed;
}

/**
 * Turn the plugin off for some agents (their pins stay in config.json), or
 * for every agent: then uninstall it, delete its directory and the state
 * file. The directory stays until the uninstall succeeds (OpenClaw refuses a
 * config whose load path is missing). Null when nothing of it exists.
 */
export function removeOpenclawSkillPlugin(opts: { home: string; agents: string[] | null; dryRun: boolean; deps?: OpenclawSkillDeps }): OpenclawSkillResult | null {
  const dir = openclawSkillPluginDir();
  const prior = readOpenclawSkillState(opts.home);
  if (!prior && !existsSync(dir)) return null;
  const out: OpenclawSkillResult = { mode: 'off', steps: [], agents: [], notes: [] };
  const agents = { ...(prior?.agents ?? {}) };
  for (const id of opts.agents ?? Object.keys(agents)) {
    if (agents[id]) { agents[id] = { ...agents[id]!, mode: 'off' }; out.agents.push({ id, mode: 'off', catalog: agents[id]!.catalog, skills: 0, pins: 0, unknown_pins: [] }); }
  }
  const left = Object.values(agents).some((a) => a.mode !== 'off');
  if (left && prior) {
    if (!opts.dryRun) atomicWriteTextFile(openclawSkillStatePath(opts.home), `${JSON.stringify({ ...prior, agents }, null, 2)}\n`, { freshMode: 0o600 });
    out.steps.push({ step: 'state', action: 'write', detail: `${openclawSkillStatePath(opts.home)} (${(opts.agents ?? []).join(', ')} off; the plugin stays for the others)` });
    return out;
  }
  if (existsSync(dir)) {
    const deps = opts.deps ?? {};
    const bin = deps.openclawBin !== undefined ? deps.openclawBin : which('openclaw');
    const uninstall = [bin ?? 'openclaw', 'plugins', 'uninstall', OPENCLAW_SKILL_PLUGIN_ID, '--force'];
    if (opts.dryRun) out.steps.push({ step: 'install', action: 'remove', detail: `${shown(uninstall)}, then ${dir}` });
    else {
      const r = bin ? (deps.run ?? defaultRun)(uninstall) : { ok: false, output: 'no openclaw on PATH' };
      if (!r.ok) {
        if (prior) atomicWriteTextFile(openclawSkillStatePath(opts.home), `${JSON.stringify({ ...prior, agents }, null, 2)}\n`, { freshMode: 0o600 });
        return { ...out, error: { code: 'skill_resolver_plugin_not_installed', message: `Every agent is off (the plugin injects nothing now), but \`${shown(uninstall)}\` did not run (${lastLine(r.output)}), so ${dir} stays in place.`, commands: [shown(uninstall)], argv: uninstall, recovery: `partial: state set to off; run the command on the OpenClaw host, then delete ${dir}` } };
      }
      try {
        rmSync(dir, { recursive: true, force: true });
        if (readdirSync(dirname(dir)).length === 0) rmdirSync(dirname(dir));
      } catch { /* uninstalled; a leftover directory is no longer loaded */ }
      out.steps.push({ step: 'install', action: 'remove', detail: `${OPENCLAW_SKILL_PLUGIN_ID} uninstalled and ${dir} removed` });
    }
  }
  if (prior) {
    if (!opts.dryRun) { try { unlinkSync(openclawSkillStatePath(opts.home)); } catch { /* gone */ } }
    out.steps.push({ step: 'state', action: 'remove', detail: `${openclawSkillStatePath(opts.home)} (pins stay in config.json)` });
  }
  return out;
}

/** One human line per step, matching setup's step lines. */
export function describeOpenclawSkill(r: OpenclawSkillResult, dryRun: boolean): string[] {
  const lines = r.steps.map((s) => `  ${(dryRun && (s.action === 'write' || s.action === 'remove' || s.action === 'run') ? `would ${s.action}` : s.action).padEnd(8)} ${'resolver'.padEnd(7)} ${s.step}: ${s.detail}`);
  for (const a of r.agents) lines.push(`skill resolver (openclaw agent ${a.id}): ${a.mode}; ${a.skills} skills in ${a.catalog}; ${a.pins} pinned`);
  for (const n of r.notes) lines.push(`  note     ${'resolver'.padEnd(7)} ${n}`);
  return lines;
}
