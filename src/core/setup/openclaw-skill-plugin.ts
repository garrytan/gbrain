/**
 * openclaw-skill-plugin.ts — `gbrain setup openclaw --skill-loading
 * resolve|shadow|off`: the generated OpenClaw plugin `gbrain-skill-resolver`,
 * a sibling of the brain-first `gbrain-turn-rule` plugin (a resolver bug can
 * never take the rule down with it).
 *
 * What setup writes:
 *  - the Node library, content-addressed at <gbrain home>/lib/<sha256>.mjs
 *    (built from this gbrain's own source, mode 0644);
 *  - one catalog per agent, `openclaw-<agent>`, over every skill root
 *    OpenClaw loads for that agent (extra dirs and plugin skill roots,
 *    bundled, custodian, workshop, managed, personal, the project's
 *    .agents/skills and the workspace's skills/), read from the gateway's
 *    skills.status (each entry's filePath and source) and ordered by
 *    OpenClaw's precedence, so a same-named skill resolves to the copy
 *    OpenClaw loads;
 *  - a data-only state file, <gbrain home>/openclaw-skill-resolver.json
 *    (mode 0600): the gbrain home it belongs to, and per agent its mode,
 *    catalog, skill roots (with their OpenClaw source), each skill's
 *    SKILL.md path, top_k, floor, live fraction, how the agent may read
 *    files by path and rendered pinned block, plus the library's sha256. It
 *    never names a path to code: the library directory and the gbrain bin
 *    are baked into the plugin's index.js;
 *  - the plugin itself under <OpenClaw state dir>/gbrain/gbrain-skill-resolver.
 *
 * Each agent's catalog is checked against what OpenClaw shows that agent's
 * model (the gateway's skills.status for the agent, else
 * `openclaw skills list --json --agent <id>`, `modelVisible`): a
 * skill OpenClaw hides from it (ineligible on this host, left out by the
 * agent's skill filter, model invocation disabled, or cut at load) is added
 * to the agent's exclude_ids, so it is never suggested. With no openclaw on
 * PATH, or a list that names none of the catalog's skills, nothing is
 * filtered and the result says so.
 *
 * OpenClaw's CLI (install --link, enable, the conversation-access grant) runs
 * only when the plugin files changed or OpenClaw's config does not show the
 * plugin installed, enabled and allowed, so a mode flip, a pin change or a
 * bare refresh writes the state file and nothing else: no reload, no drained
 * admission. A failed or partial install is never reported as success: it
 * ends `skill_resolver_plugin_not_installed` with the commands still to run.
 */
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { VERSION } from '../../version.ts';
import { buildSkillIndex, catalogStatus } from '../skills/resolver/build.ts';
import { ResolverError } from '../skills/resolver/errors.ts';
import { logsDir, skillIndexRoot } from '../skills/resolver/paths.ts';
import { readDirSources } from '../skills/resolver/sources.ts';
import { openclawConfigPath, openclawPath, openclawStateDir, parseJson5ish, resolveOpenclawWorkspace } from './brain-first.ts';
import { openclawSkillLoaderJs, openclawSkillWorkerJs } from './openclaw-skill-plugin-code.ts';
import { openclawPluginRegistered, runOpenclawCli } from './openclaw-turn-plugin.ts';
import { catalogSkillPaths, pinnedBlockFor, type PinClass } from './skill-pins.ts';
import { readResolverConfig } from './skill-resolver-config.ts';
import { laneTurnSettings } from '../skills/resolver/config.ts';

export const OPENCLAW_SKILL_PLUGIN_ID = 'gbrain-skill-resolver';
export const OPENCLAW_SKILL_STATE_FILE = 'openclaw-skill-resolver.json';
export const OPENCLAW_TOP_K_DEFAULT = 3;
export const OPENCLAW_FLOOR_DEFAULT = 'description';
export type OpenclawSkillMode = 'live' | 'shadow' | 'off';

export interface OpenclawSkillRoot { dir: string; source: string }
/** How the agent's model may read files by path: anywhere, only inside its workspace (tools.fs.workspaceOnly), or not at all (a sandbox). */
export type OpenclawPathReads = 'any' | 'workspace' | 'none';

export interface OpenclawSkillAgentState {
  mode: OpenclawSkillMode;
  catalog: string;
  /** The skill roots in OpenClaw's precedence, highest first (what the catalog is built from). */
  skill_dirs: string[];
  skill_roots?: OpenclawSkillRoot[];
  /** Each catalog skill's SKILL.md path, by id: a read of that path counts as a read of the skill. */
  skill_files?: Record<string, string>;
  path_reads?: OpenclawPathReads;
  workspace_dir?: string;
  top_k: number;
  min_match: string;
  /** skills.resolver.top_gate when set (0 turns the gate off); unset leaves the resolver's default. */
  top_gate?: number;
  /** skills.resolver.pinned: skills OpenClaw loads itself, so they are never suggested. */
  exclude_ids: string[];
  live_fraction: number;
  pins_route: 'system' | 'first_turn';
  /** The owner-session pins (the session-start brief when pins_route is first_turn). */
  pinned_block: string;
  pinned_ids: string[];
  /** The pins for conversations (groups, channels, other people's DMs), every turn. */
  conversation_pinned_block?: string;
  conversation_pinned_ids?: string[];
  /** The session classes that get suggestions (relay, cron, heartbeat, webhook and internal turns never do); absent means both. */
  suggest_classes?: PinClass[];
  owner_sender_ids: string[];
}
export interface OpenclawSkillState { v: 1; gbrain_version: string; library_sha256: string; gbrain_home?: string; agents: Record<string, OpenclawSkillAgentState> }

export interface OpenclawSkillStep { step: 'library' | 'catalog' | 'state' | 'plugin' | 'install' | 'verify' | 'self-test'; action: 'write' | 'keep' | 'remove' | 'skip' | 'run'; detail: string }
export interface OpenclawSkillError { code: 'skill_resolver_plugin_not_installed' | 'skill_resolver_setup_incomplete' | 'skill_resolver_host_not_local' | 'skill_resolver_selftest_failed' | 'skill_source_unreadable' | 'skill_resolver_config_invalid'; message: string; commands?: string[]; argv?: string[]; recovery?: string }
export interface OpenclawSkillResult {
  mode: OpenclawSkillMode;
  steps: OpenclawSkillStep[];
  agents: Array<{ id: string; mode: OpenclawSkillMode; catalog: string; skills: number; pins: number; conversation_pins?: number; unknown_pins: string[]; sources?: Record<string, number> }>;
  notes: string[];
  error?: OpenclawSkillError;
}

type Run = (argv: string[]) => { ok: boolean; output: string; stdout?: string };

export interface OpenclawSkillDeps {
  openclawBin?: string | null;
  nodeBin?: string | null;
  run?: Run;
}

export const openclawSkillPluginDir = (): string => join(openclawStateDir(), 'gbrain', OPENCLAW_SKILL_PLUGIN_ID);
export const openclawSkillStatePath = (home: string): string => join(home, OPENCLAW_SKILL_STATE_FILE);
export const openclawSkillLibDir = (home: string): string => join(home, 'lib');

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

type Cfg = Record<string, any>;

function openclawConfig(): Cfg {
  let text: string;
  try { text = readFileSync(openclawConfigPath(), 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}; // silent-read-ok: no openclaw.json means OpenClaw runs on its defaults (no extra dirs, listing on, reads unrestricted)
    throw err;
  }
  return (parseJson5ish(text) as Cfg | undefined) ?? {};
}

function agentConfig(cfg: Cfg, agentId: string): Cfg {
  const list = cfg.agents?.list;
  if (Array.isArray(list)) return list.find((a: Cfg) => a && a.id === agentId) ?? {};
  const entry = cfg.agents?.entries?.[agentId];
  return entry && typeof entry === 'object' ? entry : {};
}

const realOr = (p: string) => { try { return realpathSync(p); } catch { return p; } };
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * OpenClaw's skill sources, highest precedence first. OpenClaw 2026.11.4 lists its roots lowest first
 * (src/skills/loading/workspace-skill-sources.ts: skills.load.extraDirs and plugin skill roots, bundled,
 * custodian, the agent's workshop, managed, personal ~/.agents/skills, the project's .agents/skills, the
 * workspace's skills/) and a later root's skill replaces an earlier one of the same name.
 */
export const OPENCLAW_SOURCE_ORDER = ['openclaw-workspace', 'agents-skills-project', 'agents-skills-personal', 'openclaw-managed', 'openclaw-workshop', 'openclaw-custodian', 'openclaw-bundled', 'openclaw-extra'] as const;

/** One skill as OpenClaw reports it for an agent: its source, its SKILL.md (the gateway and skills info carry it; skills list does not) and whether the agent's model may use it. */
export interface HostSkill { name: string; source: string; filePath?: string; visible: boolean }
export interface HostSkills { via: 'gateway' | 'cli'; workspaceDir?: string; managedSkillsDir?: string; skills: HostSkill[]; listed: Set<string>; visible: Set<string> }

/**
 * How an agent's model sees skills: whether OpenClaw lists any in its prompt (skillsLimits.maxSkillsPromptChars
 * or skills.limits.maxSkillsPromptChars / maxSkillsInPrompt at 0 turns the listing off), and whether it may read
 * a file by path (tools.fs.workspaceOnly keeps reads inside its workspace; a sandbox materializes skills under
 * other paths, so a host path is not readable).
 */
/** The root the agent's read tool may open: '' for none, undefined for any (the plugin's readRootOf mirrors this). */
const readRootFor = (reads: OpenclawPathReads | undefined, workspace: string | null | undefined): string | undefined =>
  reads === 'none' ? '' : reads === 'workspace' ? workspace || '' : undefined;

export interface OpenclawAgentPolicy { listing: 'on' | 'off'; path_reads: OpenclawPathReads; path_reads_why: string | null; workspace: string | null }

export function openclawAgentPolicy(agentId: string, roster: RosterEntry[] = openclawRoster(), hostWorkspace?: string): OpenclawAgentPolicy {
  const cfg = openclawConfig();
  const agent = agentConfig(cfg, agentId);
  const limits = cfg.skills?.limits ?? {};
  const chars = typeof agent.skillsLimits?.maxSkillsPromptChars === 'number' ? agent.skillsLimits.maxSkillsPromptChars : limits.maxSkillsPromptChars;
  const listing = chars === 0 || limits.maxSkillsInPrompt === 0 ? 'off' : 'on';
  const sandbox = agent.sandbox?.mode ?? cfg.agents?.defaults?.sandbox?.mode;
  const workspaceOnly = (agent.tools?.fs?.workspaceOnly ?? cfg.tools?.fs?.workspaceOnly) === true;
  const ws = hostWorkspace ?? openclawAgentWorkspace(agentId, roster, cfg);
  const [path_reads, path_reads_why]: [OpenclawPathReads, string | null] = typeof sandbox === 'string' && sandbox !== 'off' ? ['none', `sandbox.mode ${sandbox}`]
    : workspaceOnly ? ['workspace', 'tools.fs.workspaceOnly'] : ['any', null];
  return { listing, path_reads, path_reads_why, workspace: ws ? realOr(ws) : null };
}

/**
 * The agent's workspace as OpenClaw resolves it (src/agents/agent-scope-config.ts resolveAgentWorkspaceDir): its own
 * workspace, else the default agent's, else agents.defaults.workspace/<id>, else <state dir>/workspace-<id>.
 */
function openclawAgentWorkspace(agentId: string, roster: RosterEntry[], cfg?: Cfg): string | undefined {
  const entry = roster.find((r) => r.id === agentId);
  if (entry?.workspace) return openclawPath(entry.workspace);
  if (roster.length <= 1 || agentId === 'main') {
    const w = resolveOpenclawWorkspace();
    if (!('error' in w)) return openclawPath(w.path);
  }
  const fallback = (cfg ?? openclawConfig()).agents?.defaults?.workspace;
  if (typeof fallback === 'string' && fallback.trim()) return join(openclawPath(fallback.trim()), agentId.toLowerCase());
  return join(openclawStateDir(), `workspace-${agentId.toLowerCase()}`);
}

/** skills.load.extraDirs from openclaw.json, as OpenClaw resolves them (~ expanded), in config order. */
export function openclawExtraDirs(): string[] {
  const dirs = openclawConfig().skills?.load?.extraDirs;
  return Array.isArray(dirs) ? dirs.filter((d): d is string => typeof d === 'string' && d.trim() !== '').map((d) => openclawPath(d.trim())) : [];
}

/**
 * The skill roots one agent's catalog is built from, highest precedence first, so the catalog's
 * first-wins rule picks the copy of a same-named skill that OpenClaw loads. Known roots come from the
 * host's report (workspace, managed) and openclaw.json (extraDirs, last listed wins); every other
 * root (bundled, custodian, workshop, personal, a plugin's skill root) is the folder holding a skill
 * the host reports. With the CLI fallback (no filePath in skills list), one `openclaw skills info` per
 * such source finds its root. With no host report, the workspace, project, managed and extra roots.
 */
export function openclawSkillRoots(agentId: string, host: HostSkills | null, deps: { run?: Run; bin?: string | null; roster?: RosterEntry[]; prior?: readonly OpenclawSkillRoot[] } = {}): { roots: OpenclawSkillRoot[]; notes: string[] } {
  const roster = deps.roster ?? openclawRoster();
  const notes: string[] = [];
  const ws = host?.workspaceDir ?? openclawAgentWorkspace(agentId, roster);
  const extras = openclawExtraDirs();
  const known: OpenclawSkillRoot[] = [
    ...(ws ? [{ dir: join(ws, 'skills'), source: 'openclaw-workspace' }, { dir: join(ws, '.agents', 'skills'), source: 'agents-skills-project' }] : []),
    { dir: host?.managedSkillsDir ?? join(openclawStateDir(), 'skills'), source: 'openclaw-managed' },
    ...extras.map((dir) => ({ dir, source: 'openclaw-extra' })).reverse(),
  ];
  const found: OpenclawSkillRoot[] = [];
  const placed = (file: string) => [...known, ...found].some((r) => within(realOr(file), realOr(r.dir)));
  const add = (file: string, source: string) => { if (!placed(file)) found.push({ dir: dirname(dirname(file)), source }); };
  for (const s of host?.skills ?? []) if (s.filePath) add(s.filePath, s.source);
  if (!host && deps.prior?.length) {
    const kept = deps.prior.filter((r) => !known.some((k) => realOr(k.dir) === realOr(r.dir)) && isDir(r.dir));
    found.push(...kept.map((r) => ({ dir: r.dir, source: r.source })));
    if (kept.length) notes.push(`OpenClaw did not answer, so the ${kept.length} skill root(s) it reported last time (${[...new Set(kept.map((r) => r.source))].join(', ')}) were kept`);
  }
  if (host && deps.run && deps.bin) {
    let calls = 0;
    const lookedUp = new Set<string>();
    for (const s of host.skills) {
      if (s.filePath || lookedUp.has(s.source)) continue;
      if ([...known, ...found].some((r) => isDir(join(r.dir, s.name)))) continue;
      if (calls >= OPENCLAW_INFO_CALLS_MAX) { notes.push(`\`openclaw skills info\` was called ${OPENCLAW_INFO_CALLS_MAX} times without placing every skill's folder, so some ${s.source} skills may be missing from the catalog; start the gateway and run setup again, so its skills.status names every path`); break; }
      calls++;
      const info = skillInfo(deps.run, deps.bin, agentId, s.name);
      if (info?.filePath) add(info.filePath, info.source ?? s.source);
      if (s.source !== 'openclaw-extra') lookedUp.add(s.source);
    }
  }
  const rank = (src: string) => { const i = (OPENCLAW_SOURCE_ORDER as readonly string[]).indexOf(src); return i < 0 ? OPENCLAW_SOURCE_ORDER.length : i; };
  const extraFound = found.filter((r) => r.source === 'openclaw-extra');
  const ordered = [...known.filter((r) => r.source !== 'openclaw-extra'), ...found.filter((r) => r.source !== 'openclaw-extra'), ...extraFound, ...known.filter((r) => r.source === 'openclaw-extra')]
    .map((r, i) => ({ r, i })).sort((a, b) => rank(a.r.source) - rank(b.r.source) || a.i - b.i).map(({ r }) => r);
  const seen = new Set<string>();
  const roots = ordered.flatMap((r) => { const real = realOr(r.dir); if (!isDir(real) || seen.has(real)) return []; seen.add(real); return [{ dir: real, source: r.source }]; });
  return { roots, notes };
}

const OPENCLAW_INFO_CALLS_MAX = 12;
/** How long setup waits for one read-only OpenClaw call (skills.status, skills list, skills info); installs keep runOpenclawCli's own limit. */
const OPENCLAW_PROBE_TIMEOUT_MS = 20_000;

/** One skill's entry from `openclaw skills info <name> --json --agent <id>` (it carries filePath), or null. */
function skillInfo(run: Run, bin: string, agentId: string, name: string): { filePath?: string; source?: string } | null {
  const r = run([bin, 'skills', 'info', name, '--json', '--agent', agentId]);
  if (!r.ok) return null;
  try {
    const stdout = r.stdout ?? r.output;
    const j = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { filePath?: unknown; source?: unknown };
    return { ...(typeof j.filePath === 'string' ? { filePath: j.filePath } : {}), ...(typeof j.source === 'string' ? { source: j.source } : {}) };
  } catch { return null; }
}

/** The OpenClaw source of a SKILL.md path: the first (highest-precedence) root that holds it. */
export function sourceOfPath(path: string, roots: readonly OpenclawSkillRoot[]): string | null {
  return roots.find((r) => within(path, realOr(r.dir)))?.source ?? null;
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
  return openclawPluginRegistered(OPENCLAW_SKILL_PLUGIN_ID, dir);
}

/** Build the library from this gbrain's source and keep it at <lib>/<sha256>.mjs, writable by its owner only; the prune keeps every library a consumer's state (OpenClaw, Pi) still names. */
export async function ensureResolverLibrary(home: string): Promise<{ sha256: string; wrote: boolean; path: string }> {
  const { buildResolverLibrary, LIBRARY_FILE } = await import('../../commands/skill-resolver-library.ts');
  const dir = openclawSkillLibDir(home);
  const built = await buildResolverLibrary(join(dir, LIBRARY_FILE));
  const target = join(dir, `${built.sha256}.mjs`);
  const wrote = !existsSync(target);
  if (wrote) copyFileSync(built.path, target);
  chmodSync(target, 0o644);
  const { readPiSkillState } = await import('./pi-skill-extension.ts');
  const keep = new Set([built.sha256, readOpenclawSkillState(home)?.library_sha256, readPiSkillState(home)?.library_sha256].map((s) => `${s}.mjs`));
  for (const f of readdirSync(dir)) {
    if (/^[0-9a-f]{64}\.mjs$/.test(f) && !keep.has(f)) rmSync(join(dir, f), { force: true });
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

function parseSkillReport(r: { ok: boolean; output: string; stdout?: string }, via: HostSkills['via']): HostSkills | null {
  if (!r.ok) return null;
  try {
    const stdout = r.stdout ?? r.output;
    const j = JSON.parse(stdout.slice(stdout.indexOf('{'))) as Record<string, unknown>;
    const list = Array.isArray(j?.skills) ? j.skills as Array<Record<string, unknown>> : null;
    if (!list) return null;
    const named = list.filter((e) => e && typeof e.name === 'string');
    const shows = (e: Record<string, unknown>) => (typeof e.modelVisible === 'boolean' ? e.modelVisible
      : e.eligible === true && e.disabled !== true && e.blockedByAgentFilter !== true && e.blockedByAllowlist !== true);
    const skills = named.map((e): HostSkill => ({ name: e.name as string, source: typeof e.source === 'string' ? e.source : 'unknown', ...(typeof e.filePath === 'string' && e.filePath ? { filePath: e.filePath } : {}), visible: shows(e) }));
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    return { via, ...(str(j.workspaceDir) ? { workspaceDir: str(j.workspaceDir) } : {}), ...(str(j.managedSkillsDir) ? { managedSkillsDir: str(j.managedSkillsDir) } : {}), skills,
      listed: new Set(skills.map((s) => s.name)), visible: new Set(skills.filter((s) => s.visible).map((s) => s.name)) };
  } catch { return null; }
}

/**
 * What OpenClaw loads for one agent and which of those skills its model can use (modelVisible; else eligible and
 * not hidden): the gateway's skills.status, whose entries carry each skill's filePath and source, else
 * `openclaw skills list --json --agent <id>` (no filePath on OpenClaw 2026.11.4); null when both fail.
 */
export function hostSkills(run: Run, bin: string, agentId: string): HostSkills | null {
  return parseSkillReport(run([bin, 'gateway', 'call', 'skills.status', '--params', JSON.stringify({ agentId }), '--json']), 'gateway')
    ?? parseSkillReport(run([bin, 'skills', 'list', '--json', '--agent', agentId]), 'cli');
}

/**
 * Doctor's re-check of what setup filtered: the agent's catalog skills that setup still offers (not in excluded) but
 * OpenClaw now hides from the agent's model (hidden) or no longer lists at all (cut, its load limits). Read-only; null
 * with no openclaw on PATH, a failed list, or a list naming none of the catalog.
 */
export function openclawHostDrift(agentId: string, catalogIds: string[], excluded: string[], deps: OpenclawSkillDeps = {}): { hidden: string[]; cut: string[] } | null {
  const bin = deps.openclawBin !== undefined ? deps.openclawBin : which('openclaw');
  if (!bin) return null;
  const host = hostSkills(deps.run ?? ((argv) => runOpenclawCli(argv, 20_000)), bin, agentId);
  if (!host || !catalogIds.some((n) => host.listed.has(n))) return null;
  const offered = catalogIds.filter((n) => !excluded.includes(n) && !host.visible.has(n));
  const cut = offered.filter((n) => !host.listed.has(n));
  return { hidden: offered.filter((n) => !cut.includes(n)), cut };
}

const someNames = (ids: string[]) => `${ids.slice(0, 10).join(', ')}${ids.length > 10 ? ` and ${ids.length - 10} more` : ''}`;

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
  tuning?: { live_fraction?: number; pins_route?: 'system' | 'first_turn'; owner_sender_ids?: string[]; suggest_classes?: PinClass[] };
  deps?: OpenclawSkillDeps;
}

/** The lane's own turn settings for openclaw (per_harness, then the global keys), else the OpenClaw defaults. Throws skill_resolver_config_invalid on a bad value, as every lane does. */
function openclawLaneConfig(home: string): { top_k: number; min_match: string; top_gate?: number; exclude_ids: string[] } {
  const read = readResolverConfig(home);
  const section = read.state === 'ok' ? (read.doc.skills as { resolver?: Record<string, unknown> } | undefined)?.resolver ?? {} : {};
  const s = laneTurnSettings(section, 'openclaw');
  return { top_k: s.top_k ?? OPENCLAW_TOP_K_DEFAULT, min_match: s.min_match_strength ?? OPENCLAW_FLOOR_DEFAULT, ...(s.top_gate !== undefined ? { top_gate: s.top_gate } : {}), exclude_ids: s.exclude ?? [] };
}

/** Turn the plugin on (live or shadow) for some agents, or refresh what is on. Never throws for an expected failure. */
export async function syncOpenclawSkillPlugin(opts: OpenclawSkillSyncOptions): Promise<OpenclawSkillResult> {
  const { home, dryRun } = opts;
  const deps = opts.deps ?? {};
  const run = deps.run ?? runOpenclawCli;
  const probe: Run = deps.run ?? ((argv) => runOpenclawCli(argv, OPENCLAW_PROBE_TIMEOUT_MS));
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
    const host = bin ? hostSkills(probe, bin, id) : null;
    const { roots, notes: rootNotes } = openclawSkillRoots(id, host, { run: probe, bin, roster, prior: before?.skill_roots });
    for (const n of rootNotes) out.notes.push(`agent ${id}: ${n}`);
    const dirs = roots.map((r) => r.dir);
    const catalog = openclawCatalogName(id);
    if (dirs.length === 0) { out.notes.push(`agent ${id}: no skill directory exists (looked for <workspace>/skills, <workspace>/.agents/skills, ${join(openclawStateDir(), 'skills')}, skills.load.extraDirs and every root OpenClaw reports), so it was skipped`); continue; }
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
    const files = dryRun && !fresh ? new Map(readDirSources(dirs).skills.map((s) => [s.id, s.path ?? ''])) : (catalogSkillPaths(home, catalog) ?? new Map<string, string>());
    const catalogIds = [...files.keys()];
    let hidden: string[] = [];
    if (bin && !host) out.notes.push(`agent ${id}: \`openclaw gateway call skills.status\` and \`openclaw skills list --json --agent ${id}\` failed, so skills OpenClaw hides from this agent were not filtered out of ${catalog}`);
    else if (host && !catalogIds.some((n) => host.listed.has(n))) out.notes.push(`agent ${id}: OpenClaw lists none of ${catalog}'s skills for this agent, so the catalog was not filtered (check that the agent's workspace is ${dirs[0]})`);
    else if (host) hidden = catalogIds.filter((n) => !host.visible.has(n));
    const shadowed = host ? host.skills.filter((s) => s.filePath && files.get(s.name) && realOr(s.filePath) !== realOr(files.get(s.name)!) && !hidden.includes(s.name)).map((s) => s.name) : [];
    if (shadowed.length) out.notes.push(`agent ${id}: for ${shadowed.length} skill(s) OpenClaw loads a different copy than ${catalog} holds, so they are never suggested: ${someNames(shadowed)}`);
    const missing = host ? host.skills.filter((s) => s.visible && !files.has(s.name)).map((s) => s.name) : [];
    if (missing.length) out.notes.push(`agent ${id}: ${missing.length} skill(s) OpenClaw loads for this agent are not in ${catalog} (their folder is in no root setup found): ${someNames(missing)}`);
    const cut = host ? hidden.filter((n) => !host.listed.has(n)) : [];
    const shut = hidden.filter((n) => !cut.includes(n));
    if (shut.length) out.notes.push(`agent ${id}: ${shut.length} skill(s) OpenClaw hides from this agent's model (ineligible on this host, outside its skill filter, or model invocation off) are never suggested: ${someNames(shut)}`);
    if (cut.length) out.notes.push(`agent ${id}: OpenClaw does not list ${cut.length} of ${catalog}'s skills (dropped at load by skills.limits.maxCandidatesPerRoot or skills.limits.maxSkillsLoadedPerSource, or not in its skill roots), so they are never suggested: ${someNames(cut)} (skill_resolver_host_load_cut)`);
    hidden.push(...shadowed);
    const policy = openclawAgentPolicy(id, roster, host?.workspaceDir);
    const none = { block: '', ids: [] as string[], unknown: [] as string[], withheld: [] as string[] };
    const root = readRootFor(policy.path_reads, policy.workspace);
    const pins = dryRun ? none : pinnedBlockFor(home, catalog, 'openclaw', root, { cls: 'owner', hidden });
    const talk = dryRun ? none : pinnedBlockFor(home, catalog, 'openclaw', root, { cls: 'conversation', hidden });
    const sources: Record<string, number> = {};
    for (const [sid, p] of files) if (!hidden.includes(sid)) { const s = sourceOfPath(p, roots) ?? 'unknown'; sources[s] = (sources[s] ?? 0) + 1; }
    agents[id] = {
      mode: opts.mode ?? before?.mode ?? 'live', catalog, skill_dirs: dirs, skill_roots: roots, skill_files: Object.fromEntries([...files].filter(([, p]) => p)),
      path_reads: policy.path_reads, ...(policy.workspace ? { workspace_dir: policy.workspace } : {}),
      top_k: lane.top_k, min_match: lane.min_match, ...(lane.top_gate !== undefined ? { top_gate: lane.top_gate } : {}), exclude_ids: [...new Set([...lane.exclude_ids, ...hidden])],
      live_fraction: tune.live_fraction ?? before?.live_fraction ?? 1, pins_route: tune.pins_route ?? before?.pins_route ?? 'system',
      pinned_block: pins.block, pinned_ids: pins.ids, conversation_pinned_block: talk.block, conversation_pinned_ids: talk.ids,
      ...((tune.suggest_classes ?? before?.suggest_classes) ? { suggest_classes: tune.suggest_classes ?? before!.suggest_classes } : {}),
      owner_sender_ids: tune.owner_sender_ids ?? before?.owner_sender_ids ?? [],
    };
    const unknown = [...new Set([...pins.unknown, ...talk.unknown])];
    const withheld = [...new Set([...pins.withheld, ...talk.withheld])];
    out.agents.push({ id, mode: agents[id]!.mode, catalog, skills: skills - new Set(hidden).size, pins: pins.ids.length, conversation_pins: talk.ids.length, unknown_pins: unknown, sources });
    if (unknown.length) out.notes.push(`agent ${id}: pinned skill(s) not in ${catalog}, left out of the block: ${unknown.join(', ')} (skill_resolver_pin_unknown)`);
    if (withheld.length) out.notes.push(`agent ${id}: pinned skill(s) OpenClaw hides from this agent, loads from another folder, or marks audience: owner (kept out of conversations), left out of the block: ${withheld.join(', ')} (skill_resolver_pin_withheld)`);
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
  try { lib = await ensureResolverLibrary(home); } catch (e) {
    return fail({ code: e instanceof ResolverError && e.code === 'skill_source_unreadable' ? 'skill_source_unreadable' : 'skill_resolver_setup_incomplete',
      message: `The skill resolver library could not be built (${(e as Error).message}). The catalogs were built; the state file and the plugin were not written.` });
  }
  out.steps.push({ step: 'library', action: lib.wrote ? 'write' : 'keep', detail: lib.path });
  const state: OpenclawSkillState = { v: 1, gbrain_version: VERSION, library_sha256: lib.sha256, gbrain_home: home, agents };
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
  let lane: string[] = [];
  try { lane = openclawLaneConfig(home).exclude_ids; } catch { /* a bad config: setup reports it; every exclude counts as hidden here */ }
  for (const [id, a] of Object.entries(agents)) {
    const hidden = (a.exclude_ids ?? []).filter((x) => !lane.includes(x));
    const root = readRootFor(a.path_reads, a.workspace_dir);
    const pins = pinnedBlockFor(home, a.catalog, 'openclaw', root, { cls: 'owner', hidden });
    const talk = pinnedBlockFor(home, a.catalog, 'openclaw', root, { cls: 'conversation', hidden });
    if (pins.block === a.pinned_block && JSON.stringify(pins.ids) === JSON.stringify(a.pinned_ids)
      && talk.block === (a.conversation_pinned_block ?? '') && JSON.stringify(talk.ids) === JSON.stringify(a.conversation_pinned_ids ?? [])) continue;
    agents[id] = { ...a, pinned_block: pins.block, pinned_ids: pins.ids, conversation_pinned_block: talk.block, conversation_pinned_ids: talk.ids };
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
      const r = bin ? (deps.run ?? runOpenclawCli)(uninstall) : { ok: false, output: 'no openclaw on PATH' };
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
  for (const a of r.agents) lines.push(`skill resolver (openclaw agent ${a.id}): ${a.mode}; ${a.skills} skills in ${a.catalog}${a.sources && Object.keys(a.sources).length ? ` (${Object.entries(a.sources).map(([s, n]) => `${s} ${n}`).join(', ')})` : ''}; ${a.pins} pinned`);
  for (const n of r.notes) lines.push(`  note     ${'resolver'.padEnd(7)} ${n}`);
  return lines;
}
