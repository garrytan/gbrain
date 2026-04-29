import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import { VERSION } from '../version.ts';
import {
  CLAUDE_MBRAIN_RELEVANCE_LIB,
  CLAUDE_MBRAIN_SKIP_DIRS,
  CLAUDE_MBRAIN_STOP_HOOK,
} from './setup-agent-hook-assets.ts';

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

export async function runSetupAgent(args: string[]) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const forceClaudeOnly = args.includes('--claude');
  const forceCodexOnly = args.includes('--codex');
  const printOnly = args.includes('--print');
  const jsonOutput = args.includes('--json');
  const skipMcp = args.includes('--skip-mcp');
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
      mcpRegistered: checkMcpRegistered('claude', home, claudeMcpScope),
    });
  }

  if (!forceClaudeOnly && existsSync(codexDir)) {
    clients.push({
      name: 'codex',
      configDir: codexDir,
      targetFile: join(codexDir, 'AGENTS.md'),
      mcpRegistered: checkMcpRegistered('codex', home),
    });
  }

  if (clients.length === 0) {
    console.error('No AI clients detected. Expected ~/.claude/ or ~/.codex/ to exist.');
    console.error('Install Claude Code or Codex first, then rerun: mbrain setup-agent');
    process.exit(1);
  }

  const results: Array<{ client: string; mcp: string; rules: string; mcp_scope?: ClaudeMcpScope }> = [];

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
      installClaudeStopHook(client.configDir);
    }

    results.push({
      client: client.name,
      mcp: mcpStatus,
      rules: rulesStatus,
      ...(client.name === 'claude' ? { mcp_scope: claudeMcpScope } : {}),
    });
  }

  // Report
  if (jsonOutput) {
    const hasClaude = results.some(r => r.client === 'claude');
    console.log(JSON.stringify({
      status: 'ok',
      version: VERSION,
      ...(hasClaude ? { claudeScope: claudeMcpScope } : {}),
      clients: results,
    }));
  } else {
    console.log('\nmbrain setup-agent complete:\n');
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
    const configuredClaude = results.some(r => r.client === 'claude');
    if (configuredClaude) {
      console.log('\nClaude Code MBrain memory check:');
      console.log('  This installs a Stop hook that may appear under Claude Code as "Stop hook error".');
      console.log('  That label is Claude Code UI wording; the MBrain hook is a memory reminder, not a crash.');
      console.log('  Disable for a session: MBRAIN_STOP_HOOK=0 claude');
      console.log('  Skip directories: add absolute paths to ~/.claude/mbrain-skip-dirs');
    }
    console.log('\nDone. Start a new session in your AI client to activate the rules.');
    console.log('Full reference: use the get_skillpack MCP tool inside your AI client.');
  }
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
    join(process.cwd(), 'docs', 'MBRAIN_AGENT_RULES.md'),
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

function installClaudeStopHook(claudeDir: string): void {
  const hookPath = join(claudeDir, 'scripts', 'hooks', 'stop-mbrain-check.sh');
  const libPath = join(claudeDir, 'scripts', 'hooks', 'lib', 'mbrain-relevance.sh');
  const skipDirsPath = join(claudeDir, 'mbrain-skip-dirs');
  const settingsPath = join(claudeDir, 'settings.json');
  const legacyHooksJsonPath = join(claudeDir, 'hooks', 'hooks.json');

  atomicWrite(hookPath, CLAUDE_MBRAIN_STOP_HOOK);
  chmodSync(hookPath, 0o755);

  atomicWrite(libPath, CLAUDE_MBRAIN_RELEVANCE_LIB);
  atomicWrite(skipDirsPath, CLAUDE_MBRAIN_SKIP_DIRS);

  upsertClaudeStopHook(settingsPath);
  cleanupLegacyHooksJson(legacyHooksJsonPath);
}

function upsertClaudeStopHook(settingsPath: string): void {
  const stopHookEntry = {
    matcher: '*',
    hooks: [{
      type: 'command',
      command: 'bash "$HOME/.claude/scripts/hooks/stop-mbrain-check.sh"',
      timeout: 5,
    }],
    description: 'Ask agent to write session knowledge back to mbrain.',
    id: 'stop:mbrain-check',
  };

  const base: Record<string, unknown> = existsSync(settingsPath)
    ? parseJsonOrEmpty(settingsPath)
    : {};

  const hooks = typeof base.hooks === 'object' && base.hooks ? base.hooks as Record<string, unknown> : {};
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop as any[] : [];
  const withoutExisting = stop.filter(entry => entry?.id !== 'stop:mbrain-check');

  hooks.Stop = [...withoutExisting, stopHookEntry];
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
