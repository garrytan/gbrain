/**
 * brain-first.ts — the managed brain-first instruction block that every
 * harness install writes into the harness's own instruction surface.
 *
 * Why: registering the MCP server is not enough. In a preregistered harness
 * run, agents with gbrain registered and no instruction reached for it in
 * 1 trial of 100 (no harness acts on the MCP `initialize` instructions),
 * and 92 of 100 once one short rule sat in the agent's own instructions.
 * So `gbrain setup <harness>`, `gbrain connect --install` and
 * `gbrain bootstrap harness` write this block by default; `--no-instructions`
 * (or GBRAIN_AGENT_INSTRUCTIONS=0) opts out and removes it.
 *
 * Ownership is by markers (src/core/managed-block.ts): the interior is
 * gbrain's and is replaced on upgrade; text outside the markers is never
 * touched. The ledger at <configDir>/agent-instructions.json records each
 * surface's decision (installed or declined), the access the block names and
 * whether gbrain created the file, so a re-run keeps an opt-out, `--remove`
 * deletes a file only gbrain created, and doctor's harness_wiring check can
 * tell current from stale.
 *
 * The text stays short on purpose: it is loaded into every turn.
 */
import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { claudeUserMemoryPath, codexAgentsOverridePath, codexGlobalAgentsPath, opencodeConfigDir } from '../bootstrap/host-specs.ts';
import { configDir } from '../config.ts';
import { probeBlock, removeBlock, spliceBlock, type BlockMarkers } from '../managed-block.ts';
import { ensureGitExcluded } from '../context/compiled-core.ts';
import type { McpSurface } from '../../mcp/surface.ts';

export const BRAIN_FIRST_VERSION = 2;
export const BRAIN_FIRST_BEGIN = '<!-- gbrain:brain-first:begin -->';
export const BRAIN_FIRST_END = '<!-- gbrain:brain-first:end -->';
export const BRAIN_FIRST_OPT_OUT_ENV = 'GBRAIN_AGENT_INSTRUCTIONS';
const MARKERS: BlockMarkers = { begin: BRAIN_FIRST_BEGIN, end: BRAIN_FIRST_END, label: 'brain-first', rerun: 'gbrain setup <harness> --instructions-only' };
const LEDGER_FILE = 'agent-instructions.json';

/** Harnesses whose instruction surface gbrain can write. */
export const BRAIN_FIRST_HARNESSES = ['claude-code', 'codex', 'opencode', 'openclaw', 'hermes', 'cursor'] as const;
export type BrainFirstHarness = (typeof BRAIN_FIRST_HARNESSES)[number];
export function isBrainFirstHarness(v: string | undefined): v is BrainFirstHarness {
  return (BRAIN_FIRST_HARNESSES as readonly string[]).includes(v ?? '');
}

/** How the agent reaches the brain, which decides the tool names the block uses. */
export type BrainFirstAccess = { kind: 'mcp'; server: string; surface?: McpSurface } | { kind: 'cli'; launcher: string };

/** The block interior (without markers). */
export function renderBrainFirstBlock(harness: string, access: BrainFirstAccess, optOut = `gbrain setup ${harness} --instructions-only --no-instructions`): string {
  const tool = (mcp: string, cli: string) => (access.kind === 'mcp' ? `\`${mcp}\`` : `\`${access.launcher} ${cli}\``);
  const where = access.kind === 'mcp' ? `the \`${access.server}\` MCP server` : `the \`${access.launcher}\` command`;
  const lookup = access.kind === 'mcp' && access.surface === 'verbs'
    ? '- Before answering any turn, check GBrain first, before files, mail or other sources: `recall` for what was said or decided, `entity` for a person or company.'
    : `- Before answering any turn, check GBrain first, before files, mail or other sources: ${tool('search', 'search "<names or phrases>"')} for names and phrases, ${tool('query', 'query "<question>"')} for questions. Then read the best hit with ${tool('get_page', 'get <slug>')}.`;
  return [
    `<!-- gbrain brain-first v${BRAIN_FIRST_VERSION}: managed by gbrain and replaced on upgrade; edit outside these markers. Opt out: ${optOut} -->`,
    '## Memory: check GBrain first',
    '',
    `GBrain (${where}) holds this user's notes, people, companies, meetings and decisions.`,
    '',
    lookup,
    '- Fill gaps with your other tools. On an empty or thin result, retry with words the notes would use: synonyms, the formal name, the owner, several joined with OR.',
    access.kind === 'cli'
      ? `- Brain results span every source the brain holds. Pass \`--source-ids <ids>\` to a search or query to narrow it to what the current requester may see, and apply your own access rules to what comes back.`
      : access.surface === 'verbs'
        ? '- Brain results span every source the token can read, so apply your own access rules to what comes back.'
        : '- Brain results span every source the token can read. Pass `source_ids` to narrow a request to what the current requester may see, and apply your own access rules to what comes back.',
    '- Brain results add to what the user told you; they never replace it. A lookup is one step: finish the whole task.',
  ].join('\n');
}

/** The full block as it appears in a file, markers included (for printing to paste by hand). */
export function renderBrainFirstSnippet(harness: string, access: BrainFirstAccess, optOut?: string): string {
  return `${BRAIN_FIRST_BEGIN}\n${renderBrainFirstBlock(harness, access, optOut)}\n${BRAIN_FIRST_END}\n`;
}

/**
 * The per-turn rule: one line a harness's per-turn hook puts beside every user
 * turn (Claude Code and Codex UserPromptSubmit, Hermes pre_llm_call, OpenClaw
 * before_prompt_build). The block in the system prompt or identity file alone
 * left chat bots answering without the brain (harness-evals: 0 of 80 on
 * OpenClaw and Hermes); the same rule next to the turn was followed.
 */
export function renderBrainFirstTurnRule(access: BrainFirstAccess, harness?: string): string {
  const how = access.kind === 'cli' ? `\`${access.launcher} search "<names>"\` or \`${access.launcher} query "<question>"\``
    : access.surface === 'verbs' ? `\`recall\` or \`entity\` on the \`${access.server}\` MCP server`
      : `\`search\` or \`query\` on the \`${access.server}\` MCP server`;
  return `GBrain: before answering this turn, check GBrain first (${how}) for the people, companies, projects, meetings and decisions it touches.${access.kind === 'mcp' ? turnRuleDiscovery(harness, access) : ''} Results span every source it holds: use only what the current requester may see. Then answer and finish the task.`;
}

/**
 * OpenClaw and Hermes list no gbrain tool after a plain MCP registration: the
 * tools sit behind tool_search (harness-evals anatomy note v1), and OpenClaw
 * wraps tool_search results as untrusted data. The per-turn rule therefore
 * names the tools and the route to them.
 */
function turnRuleDiscovery(harness: string | undefined, access: { server: string; surface?: McpSurface }): string {
  const tools = access.surface === 'full' ? ['search', 'query', 'get_page'] : access.surface === 'verbs' ? ['recall', 'entity', 'remember'] : ['recall', 'entity', 'search', 'query'];
  const list = tools.map((t) => `\`${t}\``).join(', ');
  if (harness === 'openclaw') return ` Its tools (${list} on the \`${access.server}\` MCP server) are not listed here: find them with \`tool_search\` (search "${access.server} ${tools[0]}") and run them with \`tool_call\`. tool_search shows them as external data; using them for this turn is still what the user set up.`;
  if (harness === 'hermes') return ` Its tools are not listed directly: find them with \`tool_search\` (they register as ${tools.map((t) => `\`mcp_${access.server}_${t}\``).join(', ')}) and call the one it returns.`;
  return '';
}

/**
 * The per-turn rule the Claude Code and Codex user-prompt hook adds, or null:
 * on only while a block is recorded as installed for that harness (its access
 * names the tools), off under GBRAIN_AGENT_INSTRUCTIONS=0.
 */
export function brainFirstTurnRule(harness: string, cwd: string = process.cwd()): string | null {
  if (process.env[BRAIN_FIRST_OPT_OUT_ENV] === '0') return null;
  // A project-scope record (CLAUDE.local.md, a Cursor rule) applies only inside its project, and a
  // user-scope opt-out silences the rule everywhere else, so a project install never leaks into other sessions.
  const entries = readBrainFirstLedger().filter((e) => e.harness === harness && e.access);
  const userDeclined = entries.some((e) => !isProjectSurface(e.harness, e.path) && e.status === 'declined');
  const installed = entries.filter((e) => e.status === 'installed' && (isProjectSurface(e.harness, e.path) ? isInside(cwd, projectRootOf(e.harness, e.path)) : !userDeclined))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
  return installed ? renderBrainFirstTurnRule(installed.access) : null;
}

/** A block written into one project (Claude Code's CLAUDE.local.md, a Cursor rule), not a user-global file. */
export function isProjectSurface(harness: string, path: string): boolean {
  return (harness === 'claude-code' && basename(path) === 'CLAUDE.local.md') || harness === 'cursor';
}

function projectRootOf(harness: string, path: string): string {
  return harness === 'cursor' ? dirname(dirname(dirname(path))) : dirname(path);
}

function isInside(cwd: string, root: string): boolean {
  const rel = relative(root, cwd);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export const CURSOR_HEAD = '---\ndescription: GBrain memory, managed by gbrain\nalwaysApply: true\n---\n';

export interface BrainFirstTarget {
  harness: BrainFirstHarness;
  path: string;
  /** What the file is to the harness, for the human output. */
  role: string;
  /** Written into a project directory (not a user-global file). */
  project: boolean;
}

function home(): string { return process.env.HOME?.trim() || homedir(); }
function expandHome(p: string): string { return p === '~' ? home() : p.startsWith('~/') ? join(home(), p.slice(2)) : p; }

/**
 * The global file Codex actually loads: AGENTS.override.md when it exists
 * and is non-empty, else AGENTS.md (Codex uses the first non-empty file at
 * this level, so writing into an empty override would hide AGENTS.md).
 */
export function codexInstructionFile(overridePath: string, agentsPath: string): string {
  try {
    if (readFileSync(overridePath, 'utf8').trim() !== '') return overridePath;
  } catch { /* no override */ }
  return agentsPath;
}

/** OpenClaw's state directory: OPENCLAW_STATE_DIR, else ~/.openclaw (or ~/.openclaw-<profile>). */
export function openclawStateDir(): string {
  const explicit = process.env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) return expandHome(explicit);
  const profile = process.env.OPENCLAW_PROFILE?.trim();
  return join(home(), profile && profile !== 'default' ? `.openclaw-${profile}` : '.openclaw');
}

/** openclaw.json: OPENCLAW_CONFIG_PATH, else <state dir>/openclaw.json. */
export function openclawConfigPath(): string {
  return process.env.OPENCLAW_CONFIG_PATH?.trim() ? expandHome(process.env.OPENCLAW_CONFIG_PATH.trim()) : join(openclawStateDir(), 'openclaw.json');
}

/**
 * openclaw.json is JSON5. Comments and trailing commas parse as JSONC; bare
 * object keys are quoted first. Anything else reads as unparseable, and the
 * caller asks for --workspace rather than guess.
 */
export function parseJson5ish(text: string): unknown {
  const quotedKeys = text.replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/g, '$1"$2":');
  const doubleQuoted = quotedKeys.replace(/'((?:[^'\\\n]|\\.)*)'/g, (_m, s: string) => JSON.stringify(s.replace(/\\'/g, "'")));
  for (const candidate of [text, quotedKeys, doubleQuoted]) {
    const errors: ParseError[] = [];
    const value = parseJsonc(candidate, errors, { allowTrailingComma: true });
    if (errors.length === 0) return value;
  }
  return undefined;
}

/**
 * The OpenClaw workspace whose AGENTS.md (its operating instructions, loaded
 * every session and by subagents) gets the block: an explicit
 * `agents.defaults.workspace` in openclaw.json, else OPENCLAW_WORKSPACE_DIR,
 * else <state dir>/workspace. A roster of several agents has no single
 * workspace, so the caller must name one.
 */
export function resolveOpenclawWorkspace(): { path: string } | { error: string } {
  const configPath = openclawConfigPath();
  let configured: string | undefined;
  if (existsSync(configPath)) {
    const cfg = parseJson5ish(readFileSync(configPath, 'utf8')) as { agents?: { defaults?: { workspace?: unknown }; list?: unknown; entries?: unknown } } | undefined;
    if (!cfg || typeof cfg !== 'object') return { error: `${configPath} could not be read as JSON, so the workspace is unknown. Pass --workspace <dir>.` };
    const roster = Array.isArray(cfg.agents?.list) ? cfg.agents.list.length : cfg.agents?.entries && typeof cfg.agents.entries === 'object' ? Object.keys(cfg.agents.entries).length : 0;
    if (roster > 1) return { error: `${configPath} defines ${roster} agents, each with its own workspace. Pass --workspace <dir> for the agent that should use gbrain.` };
    const sole = roster === 1 ? (Array.isArray(cfg.agents?.list) ? cfg.agents.list[0] : Object.values(cfg.agents?.entries as object)[0]) as { workspace?: unknown } | undefined : undefined;
    const workspace = [sole?.workspace, cfg.agents?.defaults?.workspace].find((w): w is string => typeof w === 'string' && w.trim() !== '');
    if (workspace) configured = workspace.trim();
  }
  const fromEnv = process.env.OPENCLAW_WORKSPACE_DIR?.trim();
  return { path: expandHome(configured ?? fromEnv ?? join(openclawStateDir(), 'workspace')) };
}

/** The instruction file a harness loads every session, or an error naming what to pass. */
export function brainFirstTarget(harness: BrainFirstHarness, opts: { scope?: 'user' | 'project'; projectDir?: string; workspace?: string } = {}): BrainFirstTarget | { error: string } {
  const projectDir = opts.projectDir ?? process.cwd();
  switch (harness) {
    case 'claude-code':
      return opts.scope === 'project'
        ? { harness, path: join(projectDir, 'CLAUDE.local.md'), role: 'Claude Code local project instructions', project: true }
        : { harness, path: claudeUserMemoryPath(), role: 'Claude Code user instructions', project: false };
    case 'codex': {
      const path = codexInstructionFile(codexAgentsOverridePath(), codexGlobalAgentsPath());
      return path === codexGlobalAgentsPath()
        ? { harness, path, role: 'Codex user instructions', project: false }
        : { harness, path, role: 'Codex user instructions (a non-empty AGENTS.override.md, which Codex loads instead of AGENTS.md)', project: false };
    }
    case 'opencode':
      return { harness, path: join(opencodeConfigDir(), 'AGENTS.md'), role: 'opencode global rules', project: false };
    case 'openclaw': {
      const ws = opts.workspace ? { path: expandHome(opts.workspace) } : resolveOpenclawWorkspace();
      if ('error' in ws) return ws;
      return { harness, path: join(ws.path, 'AGENTS.md'), role: 'OpenClaw workspace operating instructions', project: false };
    }
    case 'hermes': {
      const hermesHome = process.env.HERMES_HOME?.trim() ? expandHome(process.env.HERMES_HOME.trim()) : join(home(), '.hermes');
      return { harness, path: join(hermesHome, 'SOUL.md'), role: 'Hermes system prompt (SOUL.md, slot 1; the identity text above the block is left as it is)', project: false };
    }
    case 'cursor':
      return { harness, path: join(projectDir, '.cursor', 'rules', 'gbrain-brain-first.mdc'), role: 'Cursor project rule (always applied)', project: true };
  }
}

// ── Ledger ────────────────────────────────────────────────────────────────

export interface BrainFirstLedgerEntry {
  harness: string;
  path: string;
  status: 'installed' | 'declined';
  block_version: number;
  access: BrainFirstAccess;
  /** The command that last wrote or declined it. */
  writer: string;
  /** gbrain created the file, so removal may delete it once nothing else is left. */
  created_file: boolean;
  updated_at: string;
}

interface Ledger { version: 1; entries: BrainFirstLedgerEntry[] }

export function brainFirstLedgerPath(): string { return join(configDir(), LEDGER_FILE); }

export function readBrainFirstLedger(): BrainFirstLedgerEntry[] {
  const path = brainFirstLedgerPath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Ledger;
    return Array.isArray(raw?.entries) ? raw.entries.filter((e) => e && typeof e.path === 'string' && typeof e.harness === 'string') : [];
  } catch {
    return [];
  }
}

function writeLedger(entries: BrainFirstLedgerEntry[]): void {
  atomicWriteTextFile(brainFirstLedgerPath(), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { freshMode: 0o600 });
}

function upsertLedger(entry: BrainFirstLedgerEntry): void {
  writeLedger([...readBrainFirstLedger().filter((e) => !(e.harness === entry.harness && e.path === entry.path)), entry]);
}

function dropLedger(harness: string, path: string): void {
  const all = readBrainFirstLedger();
  const rest = all.filter((e) => !(e.harness === harness && e.path === path));
  if (rest.length !== all.length) writeLedger(rest);
}

/** The record for this surface; failing that, an opt-out recorded for the same harness at another path (the target moved), so an opt-out survives the move. */
export function priorBrainFirst(harness: string, path: string): BrainFirstLedgerEntry | undefined {
  const all = readBrainFirstLedger();
  return all.find((e) => e.harness === harness && e.path === path) ?? all.find((e) => e.harness === harness && e.status === 'declined');
}

// ── Decision, inspection, sync, removal ───────────────────────────────────

export type BrainFirstDecisionSource = 'flag' | 'default' | 'prior' | 'opt_out';
export interface BrainFirstDecision { value: 'accepted' | 'declined'; source: BrainFirstDecisionSource }

/** --instructions / --no-instructions win, then GBRAIN_AGENT_INSTRUCTIONS=0, then a recorded decision, then on by default. */
export function resolveBrainFirstDecision(flag: boolean | undefined, prior: Pick<BrainFirstLedgerEntry, 'status'> | undefined): BrainFirstDecision {
  if (flag !== undefined) return { value: flag ? 'accepted' : 'declined', source: 'flag' };
  if (process.env[BRAIN_FIRST_OPT_OUT_ENV] === '0') return { value: 'declined', source: 'opt_out' };
  if (prior) return { value: prior.status === 'declined' ? 'declined' : 'accepted', source: 'prior' };
  return { value: 'accepted', source: 'default' };
}

export type BrainFirstState = 'no_file' | 'absent' | 'current' | 'stale' | 'damaged';

/** Is the block in `path` the one gbrain would write for this access? */
export function inspectBrainFirst(path: string, expected?: string): { state: BrainFirstState; version?: number } {
  if (!existsSync(path)) return { state: 'no_file' };
  const probe = probeBlock(MARKERS, readFileSync(path, 'utf8'));
  if (probe.state !== 'present') return { state: probe.state };
  const version = Number(/gbrain brain-first v(\d+)/.exec(probe.interior ?? '')?.[1] ?? 0);
  const current = expected !== undefined ? probe.interior === expected : version === BRAIN_FIRST_VERSION;
  return { state: current ? 'current' : 'stale', version };
}

export interface BrainFirstOutcome {
  harness: string;
  path: string;
  role: string;
  decision: BrainFirstDecision;
  /** write: added or upgraded; keep: already current; remove: opted out, block deleted; skip: nothing to do; preserve: left alone (see detail). */
  action: 'write' | 'keep' | 'remove' | 'skip' | 'preserve';
  state_before: BrainFirstState;
  detail: string;
}

/** A directory entry exists, a dangling symlink included (existsSync follows links). */
export function direntExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/** gbrain created this file, it is still a plain file, and nothing but our block was in it. */
function ownedEmptyFile(prior: BrainFirstLedgerEntry | undefined, path: string, stripped: string): boolean {
  return (prior?.created_file ?? false) && !lstatSync(path).isSymbolicLink() && (stripped.trim() === '' || stripped === CURSOR_HEAD);
}

/**
 * Write `next` only if the file still holds what we read: another writer (an
 * editor, a second install) that saved in between keeps its text, and this run
 * reports the file as changed instead. A file that appeared since we found
 * none is never replaced.
 */
export function writeUnlessChanged(path: string, read: string, wasMissing: boolean, next: string): void {
  const now = direntExists(path) && existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (wasMissing ? now !== null : now !== read) throw new Error('the file changed while gbrain was updating it; re-run to apply the block to the new contents');
  atomicWriteTextFile(path, next, { freshMode: 0o644 });
}

/**
 * Make the surface match the decision: write or upgrade the block when
 * accepted, strip it when declined, record the decision. Never throws: a
 * damaged block or an unwritable file is reported as `preserve` so the rest
 * of the install still finishes.
 */
export function syncBrainFirst(opts: { target: BrainFirstTarget; access: BrainFirstAccess; decision: BrainFirstDecision; writer: string; dryRun: boolean }): BrainFirstOutcome {
  const { target, access, decision } = opts;
  const body = renderBrainFirstBlock(target.harness, access);
  const before = inspectBrainFirst(target.path, body);
  const out = (action: BrainFirstOutcome['action'], detail: string): BrainFirstOutcome =>
    ({ harness: target.harness, path: target.path, role: target.role, decision, action, state_before: before.state, detail });
  const recorded = priorBrainFirst(target.harness, target.path);
  const prior = recorded?.path === target.path ? recorded : undefined;
  const record = (status: 'installed' | 'declined', created: boolean) => {
    if (opts.dryRun) return;
    upsertLedger({ harness: target.harness, path: target.path, status, block_version: BRAIN_FIRST_VERSION, access, writer: opts.writer, created_file: created, updated_at: new Date().toISOString() });
  };
  try {
    if (before.state === 'damaged') {
      return out('preserve', `the brain-first markers in ${target.path} were hand-edited (duplicate, orphan or out of order); fix or delete them, then re-run`);
    }
    if (decision.value === 'declined') {
      // The target moved (Codex: a non-empty AGENTS.override.md now wins), so an opt-out also strips the
      // blocks this harness still has at its other user-global paths; otherwise their records keep the per-turn rule on.
      if (!target.project) {
        for (const other of readBrainFirstLedger().filter((e) => e.harness === target.harness && e.path !== target.path && e.status === 'installed' && !isProjectSurface(e.harness, e.path))) {
          syncBrainFirst({ ...opts, target: { ...target, path: other.path }, access: other.access });
        }
      }
      if (before.state === 'no_file' || before.state === 'absent') {
        record('declined', false);
        return out('skip', `no brain-first block in ${target.path}; opt-out recorded`);
      }
      const existing = readFileSync(target.path, 'utf8');
      if (!opts.dryRun) {
        const stripped = removeBlock(MARKERS, existing).text;
        if (ownedEmptyFile(prior, target.path, stripped)) unlinkSync(target.path);
        else writeUnlessChanged(target.path, existing, false, stripped);
      }
      record('declined', false);
      return out('remove', `brain-first block from ${target.path}; opt-out recorded`);
    }
    if (before.state === 'current') {
      record('installed', prior?.created_file ?? false);
      return out('keep', `brain-first block in ${target.path} is current`);
    }
    if (target.harness === 'hermes' && (before.state === 'no_file' || readFileSync(target.path, 'utf8').trim() === '')) {
      return out('skip', `${target.path} is missing or empty, and Hermes uses a non-empty SOUL.md instead of its default identity; start Hermes once (it seeds SOUL.md) or write your identity there, then re-run`);
    }
    const created = before.state === 'no_file' && !direntExists(target.path);
    if (!opts.dryRun) {
      const existing = before.state === 'no_file' ? (created && target.harness === 'cursor' ? CURSOR_HEAD : '') : readFileSync(target.path, 'utf8');
      writeUnlessChanged(target.path, existing, before.state === 'no_file', spliceBlock(MARKERS, existing, body));
      if (created && target.project) {
        try { ensureGitExcluded(target.path); } catch { /* a project file outside git, or an unwritable exclude, stays as written */ }
      }
    }
    record('installed', created || (prior?.created_file ?? false));
    return out('write', `brain-first block ${before.state === 'stale' ? 'upgraded in' : created ? 'in new file' : 'appended to'} ${target.path}`);
  } catch (e) {
    return out('preserve', `${target.path} could not be updated (${e instanceof Error ? e.message : String(e)}); nothing else was changed`);
  }
}

/** The uninstall path: strip the block, delete the file only when gbrain created it and nothing else is left, forget the record. */
export function removeBrainFirst(opts: { harness: string; path: string; dryRun: boolean; server?: string }): BrainFirstOutcome {
  const prior = readBrainFirstLedger().find((e) => e.harness === opts.harness && e.path === opts.path);
  const before = inspectBrainFirst(opts.path);
  const decision: BrainFirstDecision = { value: 'declined', source: 'flag' };
  const out = (action: BrainFirstOutcome['action'], detail: string): BrainFirstOutcome =>
    ({ harness: opts.harness, path: opts.path, role: 'instruction file', decision, action, state_before: before.state, detail });
  try {
    if (before.state === 'damaged') return out('preserve', `the brain-first markers in ${opts.path} were hand-edited; remove the block by hand`);
    if (opts.server !== undefined && prior?.status === 'installed' && prior.access.kind === 'mcp' && prior.access.server !== opts.server) {
      return out('skip', `the brain-first block in ${opts.path} was last written for the \`${prior.access.server}\` connection, so removing \`${opts.server}\` leaves it`);
    }
    if (before.state === 'no_file' || before.state === 'absent') {
      if (!opts.dryRun) dropLedger(opts.harness, opts.path);
      return out('skip', `no brain-first block in ${opts.path}`);
    }
    if (!opts.dryRun) {
      const existing = readFileSync(opts.path, 'utf8');
      const stripped = removeBlock(MARKERS, existing).text;
      const deleteFile = ownedEmptyFile(prior, opts.path, stripped);
      if (deleteFile) unlinkSync(opts.path);
      else writeUnlessChanged(opts.path, existing, false, stripped);
      dropLedger(opts.harness, opts.path);
      return out('remove', `brain-first block from ${opts.path}${deleteFile ? ' (file removed: gbrain created it and nothing else was in it)' : ''}`);
    }
    return out('remove', `brain-first block from ${opts.path}`);
  } catch (e) {
    return out('preserve', `${opts.path} could not be updated (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** A writable harness's target at a path an installer already resolved (its own config dir, a test sandbox). */
export function brainFirstTargetAt(harness: BrainFirstHarness, path: string): BrainFirstTarget {
  const base = brainFirstTarget(harness);
  return { harness, path, role: 'error' in base ? 'instruction file' : base.role, project: false };
}

/**
 * The installer lanes (`gbrain connect --install`, `gbrain bootstrap harness`):
 * write or upgrade the block unless opted out, or strip it on removal.
 */
export function installerBrainFirst(opts: { target: BrainFirstTarget; access: BrainFirstAccess; writer: string; instructions?: boolean; remove?: boolean; dryRun?: boolean }): BrainFirstOutcome {
  if (opts.remove) {
    return removeBrainFirst({ harness: opts.target.harness, path: opts.target.path, dryRun: opts.dryRun ?? false, ...(opts.access.kind === 'mcp' ? { server: opts.access.server } : {}) });
  }
  const decision = resolveBrainFirstDecision(opts.instructions, priorBrainFirst(opts.target.harness, opts.target.path));
  return syncBrainFirst({ target: opts.target, access: opts.access, decision, writer: opts.writer, dryRun: opts.dryRun ?? false });
}

/** One human line per outcome, matching setup's step lines. */
export function describeBrainFirstOutcome(o: BrainFirstOutcome, dryRun: boolean): string {
  return `  ${(dryRun && o.action !== 'keep' && o.action !== 'skip' ? `would ${o.action}` : o.action).padEnd(8)} ${'instructions'.padEnd(7)} ${o.detail}`;
}
