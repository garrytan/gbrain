/**
 * hook-launcher-refresh.ts — \`gbrain post-upgrade\` moves hooks written before
 * the hook launcher existed onto it (#8424), so an upgrade alone closes the
 * hole: a hook that starts gbrain in the session's directory lets that
 * directory's bunfig.toml or .env run code on every prompt.
 *
 * Only gbrain's own entries move, through the writers that own them:
 *   - the turn-rule lane (Claude Code user settings, Codex hooks.json):
 *     syncTurnRuleHook with the binary and GBRAIN_HOME its old command names;
 *   - each installed \`gbrain setup\` receipt of this install: the same apply
 *     setup runs, with the plan the receipt records, and only when the MCP
 *     entry is still exactly setup's (so the apply rewrites hooks, trust and
 *     the receipt, nothing else). Anything else gets a line naming the
 *     command that fixes it.
 * Project-scope setup installs are listed, never rewritten: setup writes those
 * from the project directory. Best-effort; never throws.
 */
import { readFileSync } from 'node:fs';
import { configDir } from '../config.ts';
import { hookEntryHash, parseClaudeHookCommand } from '../bootstrap/hooks.ts';
import { codexHookCensus, codexHookGroupRuns, type CodexHookCensusGroup } from '../bootstrap/codex-hooks.ts';
import { join } from 'node:path';
import { GBRAIN_HOOK_MARKER_KEY, GBRAIN_SETUP_MARKER_VALUE, claudeUserSettingsPath, codexConfigPath, codexHooksPath, type ClaudeHookEvent } from '../bootstrap/host-specs.ts';
import type { CodexSetupEvent } from '../bootstrap/codex-hooks.ts';
import { applyClaudeSetup, claudeSetupPaths, inspectClaudeSetup, readSetupReceipt, type ClaudeSetupPlan } from './claude-code.ts';
import { applyCodexSetup, codexSetupPaths, inspectCodexSetup, readCodexSetupReceipt, type CodexSetupPlan } from './codex.ts';
import { hookLauncherInCommand, hookLauncherPath, hookLauncherState, shellWords } from './hook-launcher.ts';
import { localSetupRecords } from './local-receipts.ts';
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

/** The words after \`env\` that are not assignments: [<launcher>] <bin> hook …; GBRAIN_HOME from the assignments. */
function codexCommandParts(command: string): { gbrainBin: string; gbrainHome?: string } | null {
  const words = shellWords(command) ?? [];
  if (words[0] !== 'env') return null;
  let i = 1;
  let gbrainHome: string | undefined;
  for (; i < words.length && /^[A-Z_]+=/.test(words[i]!); i++) if (words[i]!.startsWith('GBRAIN_HOME=')) gbrainHome = words[i]!.slice('GBRAIN_HOME='.length);
  const rest = words.slice(i);
  const at = rest.indexOf('hook');
  const gbrainBin = at > 0 ? rest[at - 1]! : undefined;
  return gbrainBin?.startsWith('/') ? { gbrainBin, ...(gbrainHome ? { gbrainHome } : {}) } : null;
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
  let group: CodexHookCensusGroup | undefined;
  try { group = codexHookCensus(codexHooksPath()).find((g) => g.lane === 'turn-rule' && g.commands.some((c) => c.includes(TURN_RULE_LANE_TOKEN) && needsLauncher(c))); } catch { return; }
  if (!group) return;
  // Rewriting re-trusts the group, so only a group Codex already runs moves: an untrusted or disabled one keeps Codex's approval gate.
  if (!codexHookGroupRuns(codexHooksPath(), codexConfigPath(), group)) { log('Hook launcher: Codex does not run the codex turn-rule hook (not trusted, or disabled), so it is left as is; run `gbrain setup codex --instructions-only` to rewrite it.'); return; }
  const parts = codexCommandParts(group.commands.find((c) => c.includes(TURN_RULE_LANE_TOKEN))!);
  if (!parts) { log('Hook launcher: the codex turn-rule hook could not be read, so it is left as is; run `gbrain setup codex --instructions-only` to rewrite it.'); return; }
  const o = syncTurnRuleHook({ harness: 'codex', gbrainBin: parts.gbrainBin, gbrainHome: parts.gbrainHome, paths: launcherFor(parts.gbrainHome), rerun: 'gbrain setup codex --instructions-only' });
  log(`Hook launcher: codex turn-rule hook ${o.action === 'write' ? 'now starts gbrain from its own directory' : `left as is (${o.detail}${o.next ? `; run ${o.next}` : ''})`}.`);
}

async function refreshSetup(log: (line: string) => void): Promise<void> {
  const home = configDir();
  for (const record of localSetupRecords(home).filter((r) => r.status === 'installed')) {
    const rerun = `gbrain setup ${record.harness}${record.name === 'gbrain' ? '' : ` --name ${record.name}`}`;
    try {
      if (record.harness === 'claude-code') {
        const receipt = readSetupReceipt(record.path).setup;
        if (!receipt) continue;
        const paths = claudeSetupPaths({ name: receipt.name, scope: receipt.scope, projectDir: receipt.project_dir });
        const owned = new Set([...Object.values(receipt.hooks.owned), ...Object.values(receipt.hooks.pending)]);
        const ours = claudeHookEntries(paths.settingsPath).filter((e) => e[GBRAIN_HOOK_MARKER_KEY] === GBRAIN_SETUP_MARKER_VALUE || owned.has(hookEntryHash(e) ?? '')).map((e) => e.command as string);
        if (!ours.some(needsLauncher)) continue;
        if (receipt.scope === 'project') { log(`Hook launcher: gbrain's hooks in ${paths.settingsPath} start gbrain in the session's directory; from ${receipt.project_dir}, run ${rerun} --scope project.`); continue; }
        const homeEnv = ours.map((c) => parseClaudeHookCommand(c)?.env.GBRAIN_HOME).find((h) => h !== undefined);
        const plan: ClaudeSetupPlan = { name: receipt.name, scope: receipt.scope, launcher: receipt.launcher, brainHome: receipt.gbrain_home, ...(homeEnv ? { gbrainHomeEnv: homeEnv } : {}),
          sourceId: receipt.source_id, surface: receipt.surface, advertise: receipt.advertise ?? null, events: Object.keys({ ...receipt.hooks.owned, ...receipt.hooks.pending }) as ClaudeHookEvent[] };
        if (!receipt.mcp_plugin && inspectClaudeSetup(plan).mcp.state !== 'current') { log(`Hook launcher: gbrain's claude-code hooks start gbrain in the session's directory; run ${rerun} to rewrite them.`); continue; }
        const applied = await applyClaudeSetup(plan, receipt.consent, { pluginOwner: receipt.mcp_plugin ?? null, brainCreated: false, mcpMustBeCurrent: true });
        const left = new Set(claudeHookEntries(paths.settingsPath).filter((e) => needsLauncher(e.command as string)).map((e) => hookEntryHash(e) ?? ''));
        const kept = Object.entries(applied.edited).filter(([, hash]) => left.has(hash)).map(([event]) => event);
        log(kept.length > 0
          ? `Hook launcher: gbrain setup's claude-code ${kept.join(', ')} hook in ${paths.settingsPath} was edited after setup wrote it, so it is kept as is and still starts gbrain in the session's directory; remove or rewrite it, then run ${rerun}.`
          : `Hook launcher: gbrain setup's claude-code hooks in ${paths.settingsPath} now start gbrain from its own directory.`);
      } else if (record.harness === 'codex') {
        const receipt = readCodexSetupReceipt(record.path).setup;
        if (!receipt) continue;
        const paths = codexSetupPaths(receipt.name);
        const ours = codexHookCensus(paths.hooksPath).filter((g) => g.lane === 'setup').flatMap((g) => g.commands);
        if (!ours.some(needsLauncher)) continue;
        const plan: CodexSetupPlan = { name: receipt.name, launcher: receipt.launcher, brainHome: receipt.gbrain_home, ...(receipt.gbrain_home_env ? { gbrainHomeEnv: receipt.gbrain_home_env } : {}),
          sourceId: receipt.source_id, surface: receipt.surface, advertise: receipt.advertise ?? null, events: Object.keys({ ...receipt.hooks.owned, ...receipt.hooks.pending }) as CodexSetupEvent[] };
        if (!receipt.mcp_plugin && inspectCodexSetup(plan).mcp.state !== 'current') { log(`Hook launcher: gbrain's codex hooks start gbrain in the session's directory; run ${rerun} to rewrite them.`); continue; }
        const applied = await applyCodexSetup(plan, receipt.consent, { pluginOwner: receipt.mcp_plugin ?? null, brainCreated: false, mcpMustBeCurrent: true });
        const left = new Set(codexHookCensus(paths.hooksPath).filter((g) => g.commands.some(needsLauncher)).map((g) => g.hash));
        const kept = Object.entries(applied.receipt.hooks.edited).filter(([, hash]) => left.has(hash)).map(([event]) => event);
        log(kept.length > 0
          ? `Hook launcher: gbrain setup's codex ${kept.join(', ')} hook in ${paths.hooksPath} was edited after setup wrote it, so it is kept as is and still starts gbrain in the session's directory; remove or rewrite it, then run ${rerun}.`
          : `Hook launcher: gbrain setup's codex hooks in ${paths.hooksPath} now start gbrain from its own directory.`);
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
}

