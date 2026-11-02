/**
 * launcher-lanes.ts — the gbrain entries outside setup's and the turn rule's
 * hooks that a harness starts in the session's directory (#8426, #8428): the
 * stdio MCP entries for gbrain serve, the `gbrain bootstrap harness` hooks,
 * the workspace bootstrap lane's hooks and the Codex bootstrap SessionEnd
 * capture. Each is reported with the command that rewrites it through the
 * hook launcher (src/core/setup/hook-launcher.ts). Files only, read-only;
 * doctor's hook_session_cwd and post-upgrade's log lines both read it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyHarnessHook } from '../bootstrap/hooks.ts';
import { codexHookCensus } from '../bootstrap/codex-hooks.ts';
import { readCodexTomlTable } from '../bootstrap/codex-toml.ts';
import { readReceipt } from '../bootstrap/format.ts';
import { CLAUDE_SETTINGS_FILE_RELPATH, GBRAIN_HOOK_MARKER_KEY, GBRAIN_HOOK_MARKER_VALUE, claudeUserMcpConfigPath, claudeUserSettingsPath, codexConfigPath, codexHooksPath, opencodeConfigDir } from '../bootstrap/host-specs.ts';
import { opencodeEntryKind, parseOpencodeConfig } from '../bootstrap/opencode-json.ts';
import { readInterviewState } from '../bootstrap/interview.ts';
import { resolveGbrainHome } from '../gbrain-home.ts';
import { hookLauncherInCommand, hookLauncherState, isHookLauncherPath, type HookLauncherState } from './hook-launcher.ts';
import { localSetupRecords } from './local-receipts.ts';
import { ownedEntryFingerprint } from '../bootstrap/adopted-connections.ts';
import { readSetupReceipt, type ClaudeSetupReceipt } from './claude-code.ts';
import { readCodexSetupReceipt } from './codex.ts';

export type LauncherLane = 'mcp' | 'harness' | 'bootstrap';

export interface LauncherLaneFinding {
  harness: 'claude-code' | 'codex' | 'opencode';
  lane: LauncherLane;
  /** The config, settings or hooks file holding the entry. */
  source: string;
  /** session_cwd: gbrain starts in the session's directory; otherwise the launcher's state. */
  reason: 'session_cwd' | Exclude<HookLauncherState, 'current'>;
  detail: string;
  /** The command that rewrites the entry through the launcher. */
  rerun: string[];
  /** Where to run it, when not from any directory. */
  rerunFrom?: string;
  /** True when rerun is gbrain setup for a user-scope entry setup owns, so an agent may run it; anything else is the user's. */
  setupOwned: boolean;
  /** Which writer owns the entry: setup's are refreshed (or named) by post-upgrade's setup pass, the rest get a line of their own. */
  owner: 'setup' | 'bootstrap' | 'none';
  /** A setup install's entry changed after setup wrote it: setup keeps it, so the user removes or rewrites it first. */
  edited?: boolean;
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

/** A stdio entry that starts gbrain serve, and the launcher state it starts through (null: none). */
function serveEntryLauncher(entry: unknown): { launcher: string | null } | null {
  const e = record(entry);
  if (!e || typeof e.command !== 'string' || typeof e.url === 'string') return null;
  const args = Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === 'string') : [];
  if (!args.includes('serve')) return null;
  return { launcher: isHookLauncherPath(e.command) ? e.command : null };
}

function state(launcher: string | null): { reason: LauncherLaneFinding['reason']; why: string } | null {
  if (!launcher) return { reason: 'session_cwd', why: 'starts gbrain in the session\'s directory, so Bun loads that directory\'s bunfig.toml and .env before gbrain runs' };
  const s = hookLauncherState(launcher);
  return s.state === 'current' ? null : { reason: s.state, why: `runs through ${launcher}, but ${s.detail}` };
}

/**
 * The `gbrain setup` command that rewrites an install's entries with what its receipt records. Setup keeps the recorded
 * capture and providers decisions on its own; a hooks opt-out, a source pin and the recorded binary only come from flags, so the
 * rerun carries them (a recorded binary that no longer exists falls back to setup's PATH lookup).
 */
export function setupRerunArgv(harness: 'claude-code' | 'codex', receipt: Pick<ClaudeSetupReceipt, 'name' | 'consent' | 'source_id'> & Partial<Pick<ClaudeSetupReceipt, 'launcher'>>, projectDir?: string): string[] {
  return ['gbrain', 'setup', harness, ...(receipt.name === 'gbrain' ? [] : ['--name', receipt.name]), ...(projectDir ? ['--scope', 'project'] : []),
    ...(receipt.consent.wiring_scope.value.hooks === 'none' ? ['--no-hooks'] : []), ...(receipt.source_id ? ['--source', receipt.source_id] : []),
    ...(receipt.launcher?.startsWith('/') && existsSync(receipt.launcher) ? ['--gbrain-bin', receipt.launcher] : [])];
}

function mcpFindings(): LauncherLaneFinding[] {
  const out: LauncherLaneFinding[] = [];
  const setup = localSetupRecords().filter((r) => r.status === 'installed');
  const bootstrap = (() => { try { return readReceipt(resolveGbrainHome()); } catch { return null; } })();
  // bootstrap writes a user-scope entry only for a 'user' registration (Claude Code's default writes .mcp.json instead); its rerun keeps a --no-hooks install hook-free.
  const bootstrapRerun = (harness: 'claude-code' | 'codex' | 'opencode'): Pick<LauncherLaneFinding, 'rerun' | 'rerunFrom' | 'setupOwned' | 'owner'> | null => {
    const reg = bootstrap?.registrations.find((r) => r.host === harness && r.scope === 'user' && (r.detail?.split('+') ?? []).includes('mcp'));
    return reg ? { rerun: ['gbrain', 'bootstrap', 'hooks', '--harness', harness, ...(reg.detail!.split('+').includes('hooks') ? [] : ['--no-hooks']), '--repair'], rerunFrom: bootstrap!.workspace_dir, setupOwned: false, owner: 'bootstrap' } : null;
  };
  const rerunFor = (harness: 'claude-code' | 'codex', name: string, entry: unknown, projectDir?: string): Pick<LauncherLaneFinding, 'rerun' | 'rerunFrom' | 'setupOwned' | 'owner' | 'edited'> => {
    const record = setup.find((r) => r.harness === harness && r.name === name && (projectDir ? r.projectDir === projectDir : r.scope !== 'project'));
    // Setup owns the entry only while it is still what setup wrote; an edited one stays the user's, and setup refuses to overwrite it.
    const receipt = record && (() => { try { return (harness === 'claude-code' ? readSetupReceipt(record.path) : readCodexSetupReceipt(record.path)).setup; } catch { return null; } })();
    const owner = receipt && [receipt.entry_hash, receipt.pending_entry_hash].includes(ownedEntryFingerprint(entry as Record<string, unknown>)) ? record : undefined;
    if (owner && receipt) return { rerun: setupRerunArgv(harness, receipt, projectDir), ...(projectDir ? { rerunFrom: projectDir } : {}), setupOwned: !projectDir, owner: 'setup' };
    const boot = projectDir || name !== 'gbrain' ? null : bootstrapRerun(harness);
    if (boot) return boot;
    return { rerun: ['gbrain', 'setup', harness, ...(name === 'gbrain' ? [] : ['--name', name]), ...(projectDir ? ['--scope', 'project'] : [])], ...(projectDir ? { rerunFrom: projectDir } : {}), setupOwned: false, owner: 'none', ...(record ? { edited: true } : {}) };
  };
  const names = [...new Set(['gbrain', ...setup.map((r) => r.name)])];
  const claudePath = claudeUserMcpConfigPath();
  const claude = readJson(claudePath);
  const holders: Array<[Record<string, unknown> | null, string | undefined]> = [[record(claude?.mcpServers), undefined],
    ...Object.entries(record(claude?.projects) ?? {}).map(([dir, p]): [Record<string, unknown> | null, string] => [record(record(p)?.mcpServers), dir])];
  for (const [servers, projectDir] of holders) {
    for (const name of names) {
      const serve = serveEntryLauncher(servers?.[name]);
      const s = serve && state(serve.launcher);
      if (!s) continue;
      out.push({ harness: 'claude-code', lane: 'mcp', source: claudePath, reason: s.reason, ...rerunFor('claude-code', name, servers?.[name], projectDir),
        detail: `the '${name}' MCP server in ${claudePath}${projectDir ? ` (project ${projectDir})` : ''} ${s.why}` });
    }
  }
  const codexPath = codexConfigPath();
  for (const name of names) {
    let table: unknown;
    try { table = readCodexTomlTable(codexPath, ['mcp_servers', name]); } catch { continue; }
    const serve = serveEntryLauncher(table);
    const s = serve && state(serve.launcher);
    if (!s) continue;
    out.push({ harness: 'codex', lane: 'mcp', source: codexPath, reason: s.reason, ...rerunFor('codex', name, table), detail: `[mcp_servers.${name}] in ${codexPath} ${s.why}` });
  }
  // opencode merges both user-global filenames, and starts a local server in each directory it opens (#8435).
  // bootstrap rewrites the global file only for an entry its writer calls ours and while the workspace still records user scope.
  const ocProjectScope = (() => { if (!bootstrap) return false; const read = readInterviewState(bootstrap.workspace_dir); const v = read.ok ? read.state.answers['MCP_SCOPE'] : undefined; return v?.skipped !== true && typeof v?.value === 'string' && v.value.trim().toLowerCase() === 'project'; })();
  const ocFiles = ['opencode.jsonc', 'opencode.json'].map((f) => join(opencodeConfigDir(), f)).flatMap((file) => {
    try { return existsSync(file) ? [{ file, parsed: parseOpencodeConfig(readFileSync(file, 'utf8'), file) }] : []; } catch { return []; }
  });
  // A remote gbrain entry in either file makes bootstrap skip the stdio registration, so it never rewrites the local one.
  const ocRemote = ocFiles.some(({ parsed }) => record(record(parsed.mcp)?.gbrain)?.type === 'remote');
  for (const { file, parsed } of ocFiles) {
    const entry = record(record(parsed.mcp)?.gbrain);
    // A disabled entry never starts, and the repair would turn it back on.
    const argv = entry?.type === 'local' && entry.enabled !== false && Array.isArray(entry.command) ? entry.command.filter((a): a is string => typeof a === 'string') : [];
    const serve = argv.length > 0 ? serveEntryLauncher({ command: argv[0], args: argv.slice(1) }) : null;
    const s = serve && state(serve.launcher);
    if (!s) continue;
    const foreign = opencodeEntryKind(parsed, 'gbrain') === 'foreign';
    const boot = foreign || ocProjectScope || ocRemote ? null : bootstrapRerun('opencode');
    out.push({ harness: 'opencode', lane: 'mcp', source: file, reason: s.reason, ...(boot ?? { rerun: ['gbrain', 'bootstrap', 'hooks', '--harness', 'opencode', '--repair'], ...(bootstrap ? { rerunFrom: bootstrap.workspace_dir } : {}), setupOwned: false, owner: 'none' }),
      detail: `the 'gbrain' MCP server in ${file} ${s.why}${foreign ? ` (gbrain's writer does not recognize it as its own)` : ocRemote ? ' (a remote gbrain entry is also configured, so bootstrap leaves this one alone)' : ocProjectScope ? ' (the workspace now records MCP_SCOPE=project, so bootstrap writes opencode.json in the workspace instead)' : ''}` });
  }
  return out;
}

function claudeHookCommands(path: string, pick: (entry: Record<string, unknown>, event: string) => boolean): string[] {
  const hooks = record(readJson(path)?.hooks);
  if (!hooks) return [];
  return Object.entries(hooks).flatMap(([event, groups]) => (Array.isArray(groups) ? groups : [])
    .flatMap((g) => (Array.isArray(record(g)?.hooks) ? (record(g)!.hooks as unknown[]) : []))
    .map(record).filter((e): e is Record<string, unknown> => !!e && typeof e.command === 'string' && pick(e, event))
    .map((e) => e.command as string));
}

function hookFindings(): LauncherLaneFinding[] {
  const out: LauncherLaneFinding[] = [];
  const first = (commands: string[]) => commands.map((c) => state(hookLauncherInCommand(c))).find((s) => s !== null) ?? null;
  const user = claudeUserSettingsPath();
  const harness = first(claudeHookCommands(user, (e, event) => classifyHarnessHook(e, event, 'any') !== null));
  if (harness) out.push({ harness: 'claude-code', lane: 'harness', source: user, reason: harness.reason, rerun: ['gbrain', 'bootstrap', 'harness', '--harness', 'claude-code'], setupOwned: false, owner: 'bootstrap',
    detail: `gbrain bootstrap harness's hooks in ${user} ${harness.why}` });
  const ws = (() => { try { return readReceipt(resolveGbrainHome())?.workspace_dir; } catch { return undefined; } })();
  if (ws) {
    const local = join(ws, CLAUDE_SETTINGS_FILE_RELPATH);
    const v1 = first(claudeHookCommands(local, (e) => e[GBRAIN_HOOK_MARKER_KEY] === GBRAIN_HOOK_MARKER_VALUE));
    if (v1) out.push({ harness: 'claude-code', lane: 'bootstrap', source: local, reason: v1.reason, rerun: ['gbrain', 'bootstrap', 'hooks', '--harness', 'claude-code', '--repair'], rerunFrom: ws, setupOwned: false, owner: 'bootstrap',
      detail: `gbrain bootstrap's workspace hooks in ${local} ${v1.why}` });
  }
  let census: ReturnType<typeof codexHookCensus> = [];
  try { census = codexHookCensus(codexHooksPath()); } catch { /* unparseable: Codex runs none of it */ }
  const capture = first(census.filter((g) => g.lane === 'bootstrap').flatMap((g) => g.commands));
  if (capture) out.push({ harness: 'codex', lane: 'bootstrap', source: codexHooksPath(), reason: capture.reason, rerun: ['gbrain', 'bootstrap', 'hooks', '--harness', 'codex', '--repair'], ...(ws ? { rerunFrom: ws } : {}), setupOwned: false, owner: 'bootstrap',
    detail: `gbrain bootstrap's Codex SessionEnd capture in ${codexHooksPath()} ${capture.why} (installed by \`gbrain bootstrap hooks\` or \`gbrain bootstrap harness\`; re-run the one you used)` });
  return out;
}

/** Every finding, MCP entries first. */
export function launcherLaneFindings(): LauncherLaneFinding[] {
  return [...mcpFindings(), ...hookFindings()];
}
