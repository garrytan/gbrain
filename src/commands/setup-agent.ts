import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import { VERSION } from '../version.ts';
import {
  applyAutopilotSchedule,
  planAutopilotSchedule,
  removeAutopilotSchedule,
} from './setup-agent-autopilot.ts';
import {
  CLAUDE_MBRAIN_PROMPT_HOOK,
  CLAUDE_MBRAIN_RELEVANCE_LIB,
  CLAUDE_MBRAIN_SKIP_DIRS,
  CLAUDE_MBRAIN_STOP_HOOK,
} from './setup-agent-hook-assets.ts';
import {
  formatSetupAgentTrustUxReport,
  planSetupAgentTrustUx,
} from '../core/services/setup-agent-trust-ux-service.ts';

const MARKER_START = '<!-- MBRAIN:RULES:START -->';
const MARKER_END = '<!-- MBRAIN:RULES:END -->';
const MARKER_VERSION_RE = /<!-- mbrain-agent-rules-version: ([\d.]+) -->/;

interface DetectedClient {
  name: 'claude' | 'codex';
  configDir: string;
  targetFile: string;
  mcpRegistered: boolean;
}

type ClaudeMcpScope = 'user' | 'local';
type SetupAgentRunMode = 'preview' | 'diff' | 'apply' | 'uninstall';
type SetupAgentApplyResult = { client: string; mcp: string; rules: string; mcp_scope?: ClaudeMcpScope };
type SetupAgentUninstallResult = {
  client: string;
  mcp: string;
  rules: string;
  mcp_scope?: ClaudeMcpScope;
  claude_stop_hook?: string;
  claude_prompt_hook?: string;
  claude_relevance_lib?: string;
  claude_skip_dirs?: string;
  claude_settings_hook?: string;
  claude_legacy_hook?: string;
};

export async function runSetupAgent(args: string[]) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const forceClaudeOnly = args.includes('--claude');
  const forceCodexOnly = args.includes('--codex');
  const printOnly = args.includes('--print');
  const jsonOutput = args.includes('--json');
  const skipMcp = args.includes('--skip-mcp');
  const skipAutopilot = args.includes('--no-autopilot');
  const modeParse = parseSetupAgentRunMode(args);
  if ('error' in modeParse) {
    console.error(modeParse.error);
    process.exit(1);
  }
  const runMode = modeParse.mode;
  const scopeParse = parseClaudeMcpScope(args);
  if ('error' in scopeParse) {
    console.error(scopeParse.error);
    process.exit(1);
  }
  const claudeMcpScope = scopeParse.scope;

  // Load the agent rules from the mbrain package
  const rulesContent = loadAgentRules();
  if (!rulesContent) {
    console.error('Could not find docs/MBRAIN_AGENT_RULES.md in the mbrain package.');
    process.exit(1);
  }

  if (printOnly) {
    console.log(formatRulesBlock(rulesContent));
    return;
  }

  // Detect installed clients
  const clients: DetectedClient[] = [];

  const claudeDir = join(home, '.claude');
  const codexDir = join(home, '.codex');

  if (!forceCodexOnly && existsSync(claudeDir)) {
    clients.push({
      name: 'claude',
      configDir: claudeDir,
      targetFile: join(claudeDir, 'CLAUDE.md'),
      mcpRegistered: skipMcp ? false : checkMcpRegistered('claude', home, claudeMcpScope),
    });
  }

  if (!forceClaudeOnly && existsSync(codexDir)) {
    clients.push({
      name: 'codex',
      configDir: codexDir,
      targetFile: join(codexDir, 'AGENTS.md'),
      mcpRegistered: skipMcp ? false : checkMcpRegistered('codex', home),
    });
  }

  // Uninstall must still be able to clean up the autopilot schedule after the
  // AI clients themselves were removed.
  if (clients.length === 0 && runMode !== 'uninstall') {
    console.error('No AI clients detected. Expected ~/.claude/ or ~/.codex/ to exist.');
    console.error('Install Claude Code or Codex first, then rerun: mbrain setup-agent');
    process.exit(1);
  }

  if (runMode === 'preview' || runMode === 'diff') {
    const report = planSetupAgentTrustUx({
      mode: runMode,
      version: VERSION,
      rules_content: rulesContent,
      skip_mcp: skipMcp,
      claude_mcp_scope: claudeMcpScope,
      clients: clients.map((client) => ({
        client: client.name,
        config_dir: client.configDir,
        target_file: client.targetFile,
        mcp_registered: client.mcpRegistered,
        prompt_content: readOptionalFile(client.targetFile),
        ...(client.name === 'claude'
          ? {
              mcp_scope: claudeMcpScope,
              claude_stop_hook_content: readOptionalFile(join(client.configDir, 'scripts', 'hooks', 'stop-mbrain-check.sh')),
              claude_prompt_hook_content: readOptionalFile(join(client.configDir, 'scripts', 'hooks', 'prompt-mbrain-context.sh')),
              claude_relevance_lib_content: readOptionalFile(join(client.configDir, 'scripts', 'hooks', 'lib', 'mbrain-relevance.sh')),
              claude_skip_dirs_content: readOptionalFile(join(client.configDir, 'mbrain-skip-dirs')),
              claude_settings_content: readOptionalFile(join(client.configDir, 'settings.json')),
              claude_legacy_hooks_content: readOptionalFile(join(client.configDir, 'hooks', 'hooks.json')),
            }
          : {}),
      })),
      expected_claude_stop_hook: CLAUDE_MBRAIN_STOP_HOOK,
      expected_claude_prompt_hook: CLAUDE_MBRAIN_PROMPT_HOOK,
      expected_claude_relevance_lib: CLAUDE_MBRAIN_RELEVANCE_LIB,
      expected_claude_skip_dirs: CLAUDE_MBRAIN_SKIP_DIRS,
    });

    const autopilotPlan = skipAutopilot ? null : planAutopilotSchedule();
    if (jsonOutput) {
      console.log(JSON.stringify({
        ...report,
        autopilot: skipAutopilot
          ? { planned: false, reason: 'skipped (--no-autopilot)' }
          : { planned: autopilotPlan?.supported ?? false, ...autopilotPlan },
      }));
    } else {
      console.log(formatSetupAgentTrustUxReport(report));
      if (skipAutopilot) {
        console.log('\nAutopilot schedule: skipped (--no-autopilot)');
      } else if (autopilotPlan?.supported) {
        console.log(`\nAutopilot schedule: --apply would register ${autopilotPlan.mode} (${autopilotPlan.target}) running ${autopilotPlan.schedule_description}. Skip with --no-autopilot.`);
      } else {
        console.log(`\nAutopilot schedule: not available — ${autopilotPlan?.reason ?? 'unsupported platform'}`);
      }
    }
    return;
  }

  if (runMode === 'uninstall') {
    const results = clients.map((client): SetupAgentUninstallResult => {
      const mcpStatus = skipMcp
        ? 'skipped'
        : client.mcpRegistered
          ? unregisterMcp(client.name)
          : 'not_registered';
      const rulesStatus = removeRules(client);
      const claudeStatus = client.name === 'claude'
        ? uninstallClaudeHooks(client.configDir)
        : {};

      return {
        client: client.name,
        mcp: mcpStatus,
        rules: rulesStatus,
        ...(client.name === 'claude' ? { mcp_scope: claudeMcpScope, ...claudeStatus } : {}),
      };
    });

    const autopilotRemoval = skipAutopilot
      ? { status: 'skipped' as const, mode: null, reason: 'skipped (--no-autopilot)' }
      : removeAutopilotSchedule();
    const changed = results.some(uninstallResultChanged) || autopilotRemoval.status === 'removed';
    const status = results.some(uninstallResultWarn) ? 'warn' : 'ok';
    const warnings = buildUninstallWarnings(results);

    if (jsonOutput) {
      const hasClaude = results.some(r => r.client === 'claude');
      console.log(JSON.stringify({
        status,
        version: VERSION,
        mode: 'uninstall',
        mutating: true,
        changed,
        managed_only: true,
        warnings,
        autopilot: autopilotRemoval,
        ...(hasClaude ? { claudeScope: claudeMcpScope } : {}),
        clients: results,
      }));
    } else {
      console.log(status === 'ok'
        ? '\nmbrain setup-agent uninstall complete:\n'
        : '\nmbrain setup-agent partial uninstall:\n');
      console.log(`  Autopilot schedule: ${autopilotRemoval.status}${autopilotRemoval.reason ? ` (${autopilotRemoval.reason})` : ''}`);
      for (const r of results) {
        const clientLabel = r.client === 'claude' ? 'Claude Code' : 'Codex';
        console.log(`  ${clientLabel}:`);
        console.log(`    MCP: ${r.mcp}`);
        console.log(`    Rules: ${r.rules}`);
        if (r.client === 'claude') {
          console.log(`    Claude stop hook: ${r.claude_stop_hook}`);
          console.log(`    Claude prompt hook: ${r.claude_prompt_hook}`);
          console.log(`    Claude relevance lib: ${r.claude_relevance_lib}`);
          console.log(`    Claude skip dirs: ${r.claude_skip_dirs}`);
          console.log(`    Claude settings hook: ${r.claude_settings_hook}`);
          console.log(`    Claude legacy hook: ${r.claude_legacy_hook}`);
        }
      }
      if (warnings.length > 0) {
        console.log('\nWarnings:');
        for (const warning of warnings) console.log(`  - ${warning}`);
      }
      console.log('\nManaged-only uninstall complete. User content and unrelated hooks/settings were preserved.');
    }
    return;
  }

  const results: SetupAgentApplyResult[] = [];

  for (const client of clients) {
    // Step 1: MCP registration
    let mcpStatus = 'already_registered';
    if (!client.mcpRegistered && !skipMcp) {
      mcpStatus = registerMcp(client.name, { claudeScope: claudeMcpScope });
    } else if (skipMcp) {
      mcpStatus = 'skipped';
    }

    // Step 2: Inject agent rules
    const rulesStatus = injectRules(client, rulesContent);

    if (client.name === 'claude') {
      installClaudeHooks(client.configDir);
    }

    results.push({
      client: client.name,
      mcp: mcpStatus,
      rules: rulesStatus,
      ...(client.name === 'claude' ? { mcp_scope: claudeMcpScope } : {}),
    });
  }

  // Autopilot schedule: register a daily candidate-only dream cycle unless
  // the user opted out. The scheduled run creates Memory Inbox candidates only
  // (no canonical writes, no auto-promote, no LLM).
  if (modeParse.compatibilityAlias && !skipAutopilot && !jsonOutput) {
    console.log('Note: this also registers the daily autopilot schedule. Skip with --no-autopilot; inspect first with --preview.');
  }
  const autopilotResult = skipAutopilot
    ? { status: 'skipped' as const, mode: null, reason: 'skipped (--no-autopilot)' }
    : applyAutopilotSchedule(planAutopilotSchedule());

  // Report
  if (jsonOutput) {
    const hasClaude = results.some(r => r.client === 'claude');
    console.log(JSON.stringify({
      status: 'ok',
      version: VERSION,
      mode: 'apply',
      mutating: true,
      compatibility_alias: modeParse.compatibilityAlias,
      changed: results.some((r) => r.mcp === 'registered' || r.rules === 'injected' || r.rules === 'updated')
        || autopilotResult.status === 'installed',
      managed_only: true,
      autopilot: autopilotResult,
      ...(hasClaude ? { claudeScope: claudeMcpScope } : {}),
      clients: results,
    }));
  } else {
    console.log('\nmbrain setup-agent complete:\n');
    if (modeParse.compatibilityAlias) {
      console.log('  Compatibility: bare setup-agent is a legacy mutating alias for --apply.\n');
    }
    for (const r of results) {
      const clientLabel = r.client === 'claude' ? 'Claude Code' : 'Codex';
      const mcpIcon = r.mcp === 'registered' ? '+' : r.mcp === 'already_registered' ? '=' : '-';
      const rulesIcon = r.rules === 'injected' || r.rules === 'updated' ? '+' : '=';
      console.log(`  ${clientLabel}:`);
      console.log(`    [${mcpIcon}] MCP: ${r.mcp}`);
      if (r.client === 'claude') {
        console.log(`    [=] Claude MCP scope: ${r.mcp_scope}`);
      }
      console.log(`    [${rulesIcon}] Rules: ${r.rules}`);
    }
    if (autopilotResult.status === 'installed') {
      console.log(`\n  [+] Autopilot schedule: ${autopilotResult.mode} installed (${autopilotResult.target}) — daily candidate-only dream cycle at 03:00.`);
      console.log('      Run logs append to ~/.mbrain/logs/autopilot.*.log (rotate or clear periodically).');
      for (const warning of autopilotResult.warnings ?? []) {
        console.log(`      warning: ${warning}`);
      }
    } else {
      console.log(`\n  [-] Autopilot schedule: ${autopilotResult.status}${autopilotResult.reason ? ` (${autopilotResult.reason})` : ''}`);
    }
    const configuredClaude = results.some(r => r.client === 'claude');
    if (configuredClaude) {
      console.log('\nClaude Code MBrain hooks:');
      console.log('  UserPromptSubmit injects a short MBrain retrieval/writeback note as silent context on each prompt.');
      console.log('  The Stop hook is non-blocking by default; restore the blocking memory gate with MBRAIN_STOP_HOOK_MODE=block.');
      console.log('  Automatic session capture: MBRAIN_STOP_HOOK_MODE=capture saves session transcripts as Memory Inbox candidates at session end.');
      console.log('  Disable for a session: MBRAIN_PROMPT_HOOK=0 (prompt note) or MBRAIN_STOP_HOOK=0 (stop check)');
      console.log('  Skip directories: add absolute paths to ~/.claude/mbrain-skip-dirs');
    }
    console.log('\nDone. Start a new session in your AI client to activate the rules.');
    console.log('Full reference: use the get_skillpack MCP tool inside your AI client.');
  }
}

function parseSetupAgentRunMode(args: string[]): { mode: SetupAgentRunMode; compatibilityAlias: boolean } | { error: string } {
  const modeFlags = ['--preview', '--diff', '--apply', '--uninstall'].filter((flag) => args.includes(flag));
  if (modeFlags.length > 1) {
    return { error: 'setup-agent modes are mutually exclusive: --preview, --diff, --apply, --uninstall' };
  }
  const flag = modeFlags[0];
  if (flag === '--preview') return { mode: 'preview', compatibilityAlias: false };
  if (flag === '--diff') return { mode: 'diff', compatibilityAlias: false };
  if (flag === '--apply') return { mode: 'apply', compatibilityAlias: false };
  if (flag === '--uninstall') return { mode: 'uninstall', compatibilityAlias: false };
  return { mode: 'apply', compatibilityAlias: true };
}

function parseClaudeMcpScope(args: string[]): { scope: ClaudeMcpScope } | { error: string } {
  let scope: ClaudeMcpScope = 'user';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let value: string | undefined;

    if (arg === '--scope') {
      value = args[i + 1];
      if (!value || value.startsWith('--')) {
        return { error: '--scope must be either "user" or "local"' };
      }
      i++;
    } else if (arg.startsWith('--scope=')) {
      value = arg.slice('--scope='.length);
    } else {
      continue;
    }

    if (value !== 'user' && value !== 'local') {
      return { error: '--scope must be either "user" or "local"' };
    }
    scope = value;
  }

  return { scope };
}

function loadAgentRules(): string | null {
  const candidates = [
    join(__dirname, '..', '..', 'docs', 'MBRAIN_AGENT_RULES.md'),
    join(__dirname, '..', 'docs', 'MBRAIN_AGENT_RULES.md'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, 'utf-8');
    }
  }

  return null;
}

function readOptionalFile(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : null;
  } catch {
    return null;
  }
}

function checkMcpRegistered(client: 'claude' | 'codex', home: string, claudeScope: ClaudeMcpScope = 'user'): boolean {
  if (client === 'claude') {
    if (claudeScope === 'user' && hasClaudeUserConfigMbrain(home)) {
      return true;
    }

    try {
      const out = execSync('claude mcp get mbrain 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
      if (claudeMcpGetOutputMatchesScope(out, claudeScope)) return true;
    } catch { /* command not found or failed */ }
    return false;
  }

  if (client === 'codex') {
    // Check codex config for mbrain MCP entry
    try {
      const out = execSync('codex mcp list 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
      if (out.split('\n').some(line => /\bmbrain\b/.test(line))) return true;
    } catch { /* command not found or failed */ }
    return false;
  }

  return false;
}

function hasClaudeUserConfigMbrain(home: string): boolean {
  const paths = [
    join(home, '.claude.json'),
    join(home, '.claude', 'server.json'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, 'utf-8');
        if (content.includes('"mbrain"')) return true;
      } catch { /* ignore read errors */ }
    }
  }
  return false;
}

function claudeMcpGetOutputMatchesScope(output: string, scope: ClaudeMcpScope): boolean {
  const scopeLine = output.split('\n').find(line => /^\s*Scope:/i.test(line)) ?? '';
  return scope === 'user'
    ? /\bUser\b/i.test(scopeLine)
    : /\bLocal\b/i.test(scopeLine);
}

function registerMcp(client: 'claude' | 'codex', opts: { claudeScope: ClaudeMcpScope }): string {
  const cmd = client === 'claude'
    ? `claude mcp add -s ${opts.claudeScope} mbrain -- mbrain serve`
    : 'codex mcp add mbrain -- mbrain serve';

  try {
    execSync(cmd, { encoding: 'utf-8', timeout: 15000, stdio: 'pipe' });
    return 'registered';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`  Warning: could not register MCP for ${client}: ${msg}`);
    console.warn(`  Run manually: ${cmd}`);
    return 'failed';
  }
}

function unregisterMcp(client: 'claude' | 'codex'): string {
  const cmd = client === 'claude'
    ? 'claude mcp remove mbrain'
    : 'codex mcp remove mbrain';

  try {
    execSync(cmd, { encoding: 'utf-8', timeout: 15000, stdio: 'pipe' });
    return 'removed';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`  Warning: could not remove MCP registration for ${client}: ${msg}`);
    console.warn(`  Remove manually if needed: ${cmd}`);
    return 'remove_failed';
  }
}

function injectRules(client: DetectedClient, rulesContent: string): string {
  const block = formatRulesBlock(rulesContent);

  if (!existsSync(client.targetFile)) {
    atomicWrite(client.targetFile, block + '\n');
    return 'injected';
  }

  const existing = readFileSync(client.targetFile, 'utf-8');

  if (existing.includes(MARKER_START)) {
    const startIdx = existing.indexOf(MARKER_START);
    const endIdx = existing.indexOf(MARKER_END);

    // If end marker is missing or appears before start, treat as malformed -- append fresh
    if (endIdx === -1 || endIdx < startIdx) {
      const separator = existing.endsWith('\n') ? '\n' : '\n\n';
      atomicWrite(client.targetFile, existing + separator + block + '\n');
      return 'injected';
    }

    const existingVersion = extractVersion(existing);
    const newVersion = extractVersion(rulesContent);

    if (existingVersion === newVersion) {
      return 'up_to_date';
    }

    const before = existing.substring(0, startIdx);
    const after = existing.substring(endIdx + MARKER_END.length);
    atomicWrite(client.targetFile, before + block + after);
    return 'updated';
  }

  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  atomicWrite(client.targetFile, existing + separator + block + '\n');
  return 'injected';
}

function removeRules(client: DetectedClient): string {
  if (!existsSync(client.targetFile)) return 'absent';
  const existing = readFileSync(client.targetFile, 'utf-8');
  const startIdx = existing.indexOf(MARKER_START);
  if (startIdx === -1) return 'absent';
  const endIdx = existing.indexOf(MARKER_END, startIdx + MARKER_START.length);
  if (endIdx === -1) return 'malformed_preserved';

  const before = existing.slice(0, startIdx);
  const after = existing.slice(endIdx + MARKER_END.length);
  atomicWrite(client.targetFile, normalizeRemovedRulesContent(before, after));
  return 'removed';
}

function normalizeRemovedRulesContent(before: string, after: string): string {
  const joined = `${before}${after}`;
  return joined.replace(/\n{3,}/g, '\n\n');
}

function installClaudeHooks(claudeDir: string): void {
  const stopHookPath = join(claudeDir, 'scripts', 'hooks', 'stop-mbrain-check.sh');
  const promptHookPath = join(claudeDir, 'scripts', 'hooks', 'prompt-mbrain-context.sh');
  const libPath = join(claudeDir, 'scripts', 'hooks', 'lib', 'mbrain-relevance.sh');
  const skipDirsPath = join(claudeDir, 'mbrain-skip-dirs');
  const settingsPath = join(claudeDir, 'settings.json');
  const legacyHooksJsonPath = join(claudeDir, 'hooks', 'hooks.json');

  atomicWrite(stopHookPath, CLAUDE_MBRAIN_STOP_HOOK);
  chmodSync(stopHookPath, 0o755);

  atomicWrite(promptHookPath, CLAUDE_MBRAIN_PROMPT_HOOK);
  chmodSync(promptHookPath, 0o755);

  atomicWrite(libPath, CLAUDE_MBRAIN_RELEVANCE_LIB);

  // The skip-dirs file is user-editable; never clobber entries on re-run.
  if (!existsSync(skipDirsPath)) {
    atomicWrite(skipDirsPath, CLAUDE_MBRAIN_SKIP_DIRS);
  }

  upsertClaudeHookSettings(settingsPath);
  cleanupLegacyHooksJson(legacyHooksJsonPath);
}

function uninstallClaudeHooks(claudeDir: string): Omit<SetupAgentUninstallResult, 'client' | 'mcp' | 'rules' | 'mcp_scope'> {
  const stopHookPath = join(claudeDir, 'scripts', 'hooks', 'stop-mbrain-check.sh');
  const promptHookPath = join(claudeDir, 'scripts', 'hooks', 'prompt-mbrain-context.sh');
  const libPath = join(claudeDir, 'scripts', 'hooks', 'lib', 'mbrain-relevance.sh');
  const skipDirsPath = join(claudeDir, 'mbrain-skip-dirs');
  const settingsPath = join(claudeDir, 'settings.json');
  const legacyHooksJsonPath = join(claudeDir, 'hooks', 'hooks.json');

  return {
    claude_stop_hook: removeManagedFile(stopHookPath, CLAUDE_MBRAIN_STOP_HOOK),
    claude_prompt_hook: removeManagedFile(promptHookPath, CLAUDE_MBRAIN_PROMPT_HOOK),
    claude_relevance_lib: removeManagedFile(libPath, CLAUDE_MBRAIN_RELEVANCE_LIB),
    claude_skip_dirs: removeManagedFile(skipDirsPath, CLAUDE_MBRAIN_SKIP_DIRS),
    claude_settings_hook: removeClaudeHooksFromSettings(settingsPath),
    claude_legacy_hook: removeClaudeHooksFromSettings(legacyHooksJsonPath),
  };
}

function removeManagedFile(path: string, expectedContent: string): string {
  if (!existsSync(path)) return 'absent';
  const content = readFileSync(path, 'utf-8');
  if (content !== expectedContent) return 'preserved_modified';
  unlinkSync(path);
  return 'removed';
}

const CLAUDE_MANAGED_HOOK_ENTRIES = [
  {
    event: 'Stop',
    entry: {
      matcher: '*',
      hooks: [{
        type: 'command',
        command: 'bash "$HOME/.claude/scripts/hooks/stop-mbrain-check.sh"',
        timeout: 5,
      }],
      description: 'MBrain session memory check (non-blocking by default).',
      id: 'stop:mbrain-check',
    },
  },
  {
    event: 'UserPromptSubmit',
    entry: {
      matcher: '*',
      hooks: [{
        type: 'command',
        command: 'bash "$HOME/.claude/scripts/hooks/prompt-mbrain-context.sh"',
        timeout: 5,
      }],
      description: 'Inject MBrain retrieval/writeback guidance as silent context.',
      id: 'prompt:mbrain-context',
    },
  },
] as const;

function upsertClaudeHookSettings(settingsPath: string): void {
  // Never overwrite a settings.json we cannot faithfully round-trip: a parse
  // failure here used to silently replace the whole file with just our hooks.
  let base: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      console.error(`Warning: ${settingsPath} is not valid JSON; left untouched. Fix it and rerun mbrain setup-agent --apply to register the MBrain hooks.`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`Warning: ${settingsPath} is not a JSON object; left untouched. Fix it and rerun mbrain setup-agent --apply to register the MBrain hooks.`);
      return;
    }
    base = parsed as Record<string, unknown>;
  }

  let hooks: Record<string, unknown>;
  if (base.hooks === undefined) {
    hooks = {};
  } else if (typeof base.hooks === 'object' && base.hooks && !Array.isArray(base.hooks)) {
    hooks = base.hooks as Record<string, unknown>;
  } else {
    console.error(`Warning: "hooks" in ${settingsPath} is not an object; left untouched. Fix it and rerun mbrain setup-agent --apply to register the MBrain hooks.`);
    return;
  }

  for (const { event, entry } of CLAUDE_MANAGED_HOOK_ENTRIES) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] as any[] : [];
    const withoutExisting = existing.filter(e => e?.id !== entry.id);
    hooks[event] = [...withoutExisting, entry];
  }

  base.hooks = hooks;

  atomicWrite(settingsPath, JSON.stringify(base, null, 2) + '\n');
}

function cleanupLegacyHooksJson(legacyPath: string): void {
  // Older versions of setup-agent wrote stop:mbrain-check into ~/.claude/hooks/hooks.json,
  // but Claude Code does not load user-level hooks from that path (it is plugin-scoped).
  // Remove only our own stale entry; leave any other hooks intact.
  if (!existsSync(legacyPath)) return;

  const parsed = parseJsonOrEmpty(legacyPath) as { hooks?: Record<string, unknown> };
  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== 'object') return;

  const stop = Array.isArray(hooks.Stop) ? hooks.Stop as any[] : null;
  if (!stop) return;

  const filtered = stop.filter(entry => entry?.id !== 'stop:mbrain-check');
  if (filtered.length === stop.length) return;

  hooks.Stop = filtered;
  atomicWrite(legacyPath, JSON.stringify(parsed, null, 2) + '\n');
}

function removeClaudeHooksFromSettings(settingsPath: string): string {
  if (!existsSync(settingsPath)) return 'absent';

  const parsed = parseJsonOrEmpty(settingsPath) as { hooks?: Record<string, unknown> };
  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== 'object') return 'absent';

  let removed = false;
  let preservedModified = false;

  for (const { event, entry } of CLAUDE_MANAGED_HOOK_ENTRIES) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] as any[] : null;
    if (!existing) continue;

    const managedEntries = existing.filter(e => isManagedClaudeHookEntry(e, entry));
    const modifiedMbrainEntries = existing.filter(e => e?.id === entry.id && !isManagedClaudeHookEntry(e, entry));
    if (modifiedMbrainEntries.length > 0) preservedModified = true;
    if (managedEntries.length === 0) continue;

    hooks[event] = existing.filter(e => !isManagedClaudeHookEntry(e, entry));
    removed = true;
  }

  if (removed) {
    atomicWrite(settingsPath, JSON.stringify(parsed, null, 2) + '\n');
  }
  if (preservedModified) return 'preserved_modified';
  return removed ? 'removed' : 'absent';
}

function isManagedClaudeHookEntry(candidate: any, managed: { id: string; hooks: readonly { command: string }[] }): boolean {
  // Match on identity and command only: description copy may differ across
  // mbrain versions, and uninstall should still remove our own entry.
  return candidate?.id === managed.id
    && candidate?.matcher === '*'
    && Array.isArray(candidate?.hooks)
    && candidate.hooks.length === 1
    && candidate.hooks[0]?.type === 'command'
    && candidate.hooks[0]?.command === managed.hooks[0].command;
}

function uninstallResultChanged(result: SetupAgentUninstallResult): boolean {
  return Object.entries(result).some(([key, value]) => {
    if (key === 'client' || key === 'mcp_scope') return false;
    return value === 'removed';
  });
}

function uninstallResultWarn(result: SetupAgentUninstallResult): boolean {
  return Object.entries(result).some(([, value]) => {
    return value === 'remove_failed'
      || value === 'preserved_modified'
      || value === 'malformed_preserved';
  });
}

function buildUninstallWarnings(results: SetupAgentUninstallResult[]): string[] {
  const warnings: string[] = [];
  for (const result of results) {
    for (const [key, value] of Object.entries(result)) {
      if (value === 'remove_failed') {
        warnings.push(`${result.client} ${key} removal failed; remove manually if needed.`);
      } else if (value === 'preserved_modified') {
        warnings.push(`${result.client} ${key} was modified by the user and was preserved.`);
      } else if (value === 'malformed_preserved') {
        warnings.push(`${result.client} ${key} has malformed MBrain markers and was preserved.`);
      }
    }
  }
  return warnings;
}

function parseJsonOrEmpty(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function formatRulesBlock(rulesContent: string): string {
  return `${MARKER_START}\n${rulesContent}\n${MARKER_END}`;
}

function extractVersion(content: string): string | null {
  // Scope search to the mbrain marker region if markers exist
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  const region = (startIdx !== -1 && endIdx !== -1) ? content.slice(startIdx, endIdx) : content;
  const match = region.match(MARKER_VERSION_RE);
  return match ? match[1] : null;
}

function atomicWrite(targetPath: string, content: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = targetPath + '.mbrain.tmp';
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, targetPath);
}
