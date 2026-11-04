/**
 * hook-launcher-refresh.ts — \`gbrain post-upgrade\` moves hooks written before
 * the hook launcher existed onto it (#8424), so an upgrade alone closes the
 * hole: a hook that starts gbrain in the session's directory lets that
 * directory's bunfig.toml or .env run code on every prompt.
 *
 * Only gbrain's own entries move, through the writers that own them:
 *   - the turn-rule lane (Claude Code user settings, Codex hooks.json):
 *     syncTurnRuleHook with the binary and GBRAIN_HOME its old command names;
 *   - each installed Claude Code \`gbrain setup\` receipt of this install: the
 *     same apply setup runs, with the plan the receipt records, and only when
 *     the MCP entry is still exactly setup's (so the apply rewrites hooks and
 *     the receipt, nothing else). Codex setup installs, and anything else, get
 *     a line naming the command that fixes it.
 * Project-scope setup installs are listed, never rewritten: setup writes those
 * from the project directory. Best-effort; never throws.
 */
import { readFileSync } from 'node:fs';
import { configDir } from '../config.ts';
import { hookEntryHash, parseClaudeHookCommand } from '../bootstrap/hooks.ts';
import { codexHookCensus } from '../bootstrap/codex-hooks.ts';
import { join } from 'node:path';
import { GBRAIN_HOOK_MARKER_KEY, GBRAIN_SETUP_MARKER_VALUE, claudeUserSettingsPath, codexHooksPath, type ClaudeHookEvent } from '../bootstrap/host-specs.ts';
import { applyClaudeSetup, claudeSetupPaths, inspectClaudeSetup, readSetupReceipt, type ClaudeSetupPlan } from './claude-code.ts';
import { codexSetupPaths, readCodexSetupReceipt } from './codex.ts';
import { hookLauncherInCommand, hookLauncherPath, hookLauncherState } from './hook-launcher.ts';
import { localSetupRecords } from './local-receipts.ts';
import { ownedEntryFingerprint } from '../bootstrap/adopted-connections.ts';
import { launcherLaneFindings, setupRerunArgv } from './launcher-lanes.ts';
import { hasTurnRuleHook, isTurnRuleEntry, syncTurnRuleHook, TURN_RULE_LANE_TOKEN } from './turn-hook.ts';

/** True when this command starts gbrain somewhere other than a current launcher. */
function needsLauncher(command: string): boolean {
  const launcher = hookLauncherInCommand(command);
  return !launcher || hookLauncherState(launcher).state !== 'current';
}

function claudeHookEntries(path: string): Array<Record<string, unknown>> {
  let hooks: unknown;
  try { hooks = (JSON.parse(readFileSync(path, 'utf8')) as { hooks?: unknown })?.hooks; } catch { return []; }
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  return Object.values(hooks as Record<string, unknown>).filter(Array.isArray)
    .flatMap((groups) => (groups as unknown[]).flatMap((g) => (Array.isArray((g as { hooks?: unknown })?.hooks) ? (g as { hooks: unknown[] }).hooks : [])))
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as Record<string, unknown>).command === 'string');
}

/** The launcher of the install the hook's GBRAIN_HOME names, so a hook never depends on another install's directory. */
const launcherFor = (gbrainHome: string | undefined) => (gbrainHome ? { hookLauncher: hookLauncherPath(join(gbrainHome, '.gbrain')) } : {});

function refreshTurnRule(log: (line: string) => void): void {
  const claude = claudeHookEntries(claudeUserSettingsPath()).filter(isTurnRuleEntry).map((e) => e.command as string).find(needsLauncher);
  const claudeParsed = claude ? parseClaudeHookCommand(claude) : null;
  if (claude && claudeParsed) {
    const o = syncTurnRuleHook({ harness: 'claude-code', gbrainBin: claudeParsed.gbrainBin, gbrainHome: claudeParsed.env.GBRAIN_HOME, paths: launcherFor(claudeParsed.env.GBRAIN_HOME), rerun: 'gbrain setup claude-code --instructions-only' });
    log(`Hook launcher: claude-code turn-rule hook ${o.action === 'write' ? 'now starts gbrain from its own directory' : `left as is (${o.detail}${o.next ? `; run ${o.next}` : ''})`}.`);
  } else if (claude) log('Hook launcher: the claude-code turn-rule hook was edited, so it is left as is; run `gbrain setup claude-code --instructions-only` to rewrite it.');
  if (!hasTurnRuleHook('codex')) return;
  let stale = false;
  try { stale = codexHookCensus(codexHooksPath()).some((g) => g.lane === 'turn-rule' && g.commands.some((c) => c.includes(TURN_RULE_LANE_TOKEN) && needsLauncher(c))); } catch { return; }
  // Every install shares one hooks.json and a rewrite recomputes every turn-rule group's trust, so the codex hook is only named here.
  if (stale) log('Hook launcher: the codex turn-rule hook starts gbrain in the session\'s directory, so it is left as is (a rewrite moves Codex trust); run `gbrain setup codex --instructions-only` to rewrite it.');
}

async function refreshSetup(log: (line: string) => void): Promise<void> {
  const home = configDir();
  for (const record of localSetupRecords(home).filter((r) => r.status === 'installed')) {
    let rerun = `gbrain setup ${record.harness}${record.name === 'gbrain' ? '' : ` --name ${record.name}`}`;
    try {
      if (record.harness === 'claude-code') {
        const receipt = readSetupReceipt(record.path).setup;
        if (!receipt) continue;
        rerun = setupRerunArgv('claude-code', receipt).join(' ');
        const paths = claudeSetupPaths({ name: receipt.name, scope: receipt.scope, projectDir: receipt.project_dir });
        const owned = new Set([...Object.values(receipt.hooks.owned), ...Object.values(receipt.hooks.pending)]);
        const ours = claudeHookEntries(paths.settingsPath).filter((e) => e[GBRAIN_HOOK_MARKER_KEY] === GBRAIN_SETUP_MARKER_VALUE || owned.has(hookEntryHash(e) ?? '')).map((e) => e.command as string);
        // Another install's hooks or MCP entry can share these files, so the home comes only from entries this receipt owns.
        const homeEnv = claudeHookEntries(paths.settingsPath).filter((e) => owned.has(hookEntryHash(e) ?? '')).map((e) => parseClaudeHookCommand(e.command as string)?.env.GBRAIN_HOME).find((h) => h !== undefined)
          ?? (receipt.mcp_plugin ? undefined : claudeMcpHome(paths.configPath, receipt.name, receipt.project_dir, [receipt.entry_hash, receipt.pending_entry_hash]));
        const plan: ClaudeSetupPlan = { name: receipt.name, scope: receipt.scope, ...(receipt.project_dir ? { projectDir: receipt.project_dir } : {}), launcher: receipt.launcher, brainHome: receipt.gbrain_home, ...(homeEnv ? { gbrainHomeEnv: homeEnv } : {}),
          sourceId: receipt.source_id, surface: receipt.surface, advertise: receipt.advertise ?? null, events: Object.keys({ ...receipt.hooks.owned, ...receipt.hooks.pending }) as ClaudeHookEvent[] };
        // An MCP entry still exactly what setup last wrote predates the launcher (#8426): setup's own rewrite moves it.
        const mcp = receipt.mcp_plugin ? 'plugin' : inspectClaudeSetup(plan).mcp.state;
        if (!ours.some(needsLauncher) && mcp !== 'owned') continue;
        if (receipt.scope === 'project') { log(`Hook launcher: gbrain setup's entries for ${receipt.project_dir} start gbrain in the session's directory; from ${receipt.project_dir}, run ${rerun} --scope project.`); continue; }
        if (mcp !== 'plugin' && mcp !== 'current' && mcp !== 'owned') { log(`Hook launcher: gbrain's claude-code hooks start gbrain in the session's directory; run ${rerun} to rewrite them.`); continue; }
        const applied = await applyClaudeSetup(plan, receipt.consent, { pluginOwner: receipt.mcp_plugin ?? null, brainCreated: false, refreshOf: receipt });
        const left = new Set(claudeHookEntries(paths.settingsPath).filter((e) => needsLauncher(e.command as string)).map((e) => hookEntryHash(e) ?? ''));
        const kept = Object.entries(applied.edited).filter(([, hash]) => left.has(hash)).map(([event]) => event);
        log(kept.length > 0
          ? `Hook launcher: gbrain setup's claude-code ${kept.join(', ')} hook in ${paths.settingsPath} was edited after setup wrote it, so it is kept as is and still starts gbrain in the session's directory; remove or rewrite it, then run ${rerun}.`
          : `Hook launcher: gbrain setup's claude-code ${mcp === 'owned' ? 'MCP server and hooks' : 'hooks'} now start gbrain from its own directory.`);
      } else if (record.harness === 'codex') {
        const receipt = readCodexSetupReceipt(record.path).setup;
        if (!receipt) continue;
        rerun = setupRerunArgv('codex', receipt).join(' ');
        const paths = codexSetupPaths(receipt.name);
        const hooks = codexHookCensus(paths.hooksPath).some((g) => g.lane === 'setup' && g.commands.some(needsLauncher));
        const mcp = !receipt.mcp_plugin && launcherLaneFindings().some((f) => f.harness === 'codex' && f.lane === 'mcp' && f.owner === 'setup' && f.detail.startsWith(`[mcp_servers.${receipt.name}]`));
        if (!hooks && !mcp) continue;
        // Rewriting re-trusts setup's groups, and a hooks.json every install shares cannot show which install's group Codex runs, so the rewrite stays with setup, where the user approves it; the MCP table moves in the same run.
        log(`Hook launcher: gbrain setup's codex ${[...(mcp ? [`MCP server in ${paths.configPath}`] : []), ...(hooks ? [`hooks in ${paths.hooksPath}`] : [])].join(' and ')} start gbrain in the session's directory; run ${rerun} to rewrite them.`);
      }
    } catch (e) {
      log(`Hook launcher: gbrain's ${record.harness} hooks were not refreshed (${(e as Error).message}); run ${rerun}.`);
    }
  }
}

/** post-upgrade: move every gbrain-written hook this install can find onto the launcher. */
export async function refreshHookLaunchers(log: (line: string) => void = console.log): Promise<void> {
  try { refreshTurnRule(log); } catch (e) { log(`Hook launcher: the turn-rule hooks were not refreshed (${(e as Error).message}); run gbrain doctor --only harness_wiring.`); }
  try { await refreshSetup(log); } catch (e) { log(`Hook launcher: setup's hooks were not refreshed (${(e as Error).message}); run gbrain doctor --only harness_wiring.`); }
  // The other lanes are named, never rewritten here: bootstrap's writers run from the workspace, and their Codex entries move trust.
  try {
    for (const f of launcherLaneFindings().filter((x) => x.owner !== 'setup')) log(`Hook launcher: ${f.detail}; ${f.edited ? 'it was edited after setup wrote it, so it is kept as is; remove or rewrite it, then ' : f.owner === 'none' ? 'gbrain does not rewrite it, so remove it, then ' : ''}${f.rerunFrom ? `from ${f.rerunFrom}, ` : ''}run ${f.rerun.join(' ')} to move it onto gbrain's launcher.`);
  } catch (e) { log(`Hook launcher: the bootstrap lanes were not checked (${(e as Error).message}); run gbrain doctor --only harness_wiring.`); }
}

/** GBRAIN_HOME from setup's own MCP entry, for an install with no hooks to read it from. */
function claudeMcpHome(configPath: string, name: string, projectDir: string | undefined, ownedHashes: Array<string | null | undefined>): string | undefined {
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as { mcpServers?: Record<string, { env?: Record<string, unknown> }>; projects?: Record<string, { mcpServers?: Record<string, { env?: Record<string, unknown> }> }> };
    const entry = (projectDir ? cfg.projects?.[projectDir]?.mcpServers : cfg.mcpServers)?.[name];
    if (!entry || !ownedHashes.includes(ownedEntryFingerprint(entry as Record<string, unknown>))) return undefined;
    const home = entry.env?.GBRAIN_HOME;
    return typeof home === 'string' ? home : undefined;
  } catch { return undefined; }
}

