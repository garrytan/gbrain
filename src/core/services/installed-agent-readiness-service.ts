import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export type InstalledAgentCheckStatus = 'ok' | 'warn' | 'fail';

export interface InstalledAgentCheck {
  name: string;
  status: InstalledAgentCheckStatus;
  message: string;
}

export interface InstalledAgentTool {
  name: string;
}

export interface InstalledAgentReadinessInput {
  command: string;
  commandVersion: string | null;
  tools: InstalledAgentTool[];
  codexPrompt: string | null;
  claudePrompt: string | null;
  claudeStopHook: string | null;
  expectedRulesVersion: string;
}

export interface InstalledAgentReadinessReport {
  status: InstalledAgentCheckStatus;
  checks: InstalledAgentCheck[];
}

export interface InstalledAgentCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type InstalledAgentCommandRunner = (
  command: string,
  args: string[],
) => InstalledAgentCommandResult | Promise<InstalledAgentCommandResult>;

export const REQUIRED_AGENT_TOOLS = [
  'retrieve_context',
  'read_context',
  'record_retrieval_trace',
  'route_memory_writeback',
] as const;

const RULES_START = '<!-- MBRAIN:RULES:START -->';
const RULES_END = '<!-- MBRAIN:RULES:END -->';
const ROUTER_TERMS = ['route_memory_writeback', 'canonical_write_allowed'] as const;

export function parseAgentRulesVersion(content: string): string | null {
  return content.match(/<!--\s*mbrain-agent-rules-version:\s*([\d.]+)\s*-->/)?.[1] ?? null;
}

export function extractManagedRulesBlock(content: string): string | null {
  const startIndex = content.indexOf(RULES_START);
  if (startIndex === -1) return null;

  const blockStartIndex = startIndex + RULES_START.length;
  const endIndex = content.indexOf(RULES_END, blockStartIndex);
  if (endIndex === -1) return null;

  return content.slice(blockStartIndex, endIndex);
}

export function buildInstalledAgentReadinessReport(
  input: InstalledAgentReadinessInput,
): InstalledAgentReadinessReport {
  const checks: InstalledAgentCheck[] = [
    buildCommandVersionCheck(input),
    buildRequiredToolsCheck(input.tools),
    buildPromptRulesCheck('codex_prompt_rules', 'Codex prompt', input.codexPrompt, input.expectedRulesVersion),
    buildPromptRulesCheck('claude_prompt_rules', 'Claude prompt', input.claudePrompt, input.expectedRulesVersion),
    buildClaudeStopHookCheck(input.claudeStopHook),
  ];

  return {
    status: summarizeStatus(checks),
    checks,
  };
}

export async function collectInstalledAgentReadiness({
  command,
  expectedRulesVersion,
  home = process.env.HOME || process.env.USERPROFILE || '',
  runCommand = defaultCommandRunner,
}: {
  command: string;
  expectedRulesVersion: string;
  home?: string;
  runCommand?: InstalledAgentCommandRunner;
}): Promise<InstalledAgentReadinessReport> {
  const versionResult = await runCommand(command, ['--version']);
  const toolsResult = await runCommand(command, ['--tools-json']);

  return buildInstalledAgentReadinessReport({
    command,
    commandVersion: versionResult.exitCode === 0 ? versionResult.stdout.trim() : null,
    tools: toolsResult.exitCode === 0 ? parseToolsJson(toolsResult.stdout) : [],
    codexPrompt: readOptionalFile(join(home, '.codex', 'AGENTS.md')),
    claudePrompt: readOptionalFile(join(home, '.claude', 'CLAUDE.md')),
    claudeStopHook: readOptionalFile(join(home, '.claude', 'scripts', 'hooks', 'stop-mbrain-check.sh')),
    expectedRulesVersion,
  });
}

export function parseToolsJson(stdout: string): InstalledAgentTool[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const tools: unknown[] = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.tools)
        ? parsed.tools
        : [];
    return tools
      .map((tool: unknown) => {
        if (typeof tool === 'string') return { name: tool };
        if (isRecord(tool) && typeof tool.name === 'string') return { name: tool.name };
        return null;
      })
      .filter((tool): tool is InstalledAgentTool => tool !== null);
  } catch {
    return [];
  }
}

export function splitAgentCommand(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const char of command.trim()) {
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) {
    parts.push(current);
  }

  return parts;
}

function buildCommandVersionCheck(input: InstalledAgentReadinessInput): InstalledAgentCheck {
  if (!input.commandVersion?.trim()) {
    return {
      name: 'command_version',
      status: 'fail',
      message: `${input.command} --version did not return a version`,
    };
  }

  return {
    name: 'command_version',
    status: 'ok',
    message: input.commandVersion.trim(),
  };
}

function buildRequiredToolsCheck(tools: InstalledAgentTool[]): InstalledAgentCheck {
  const available = new Set(tools.map((tool) => tool.name));
  const missing = REQUIRED_AGENT_TOOLS.filter((name) => !available.has(name));
  const required = REQUIRED_AGENT_TOOLS.join(', ');

  if (missing.length > 0) {
    return {
      name: 'mcp_required_tools',
      status: 'fail',
      message: `Missing required MCP tools: ${missing.join(', ')}. Required: ${required}`,
    };
  }

  return {
    name: 'mcp_required_tools',
    status: 'ok',
    message: `Required MCP tools present: ${required}`,
  };
}

function buildPromptRulesCheck(
  name: string,
  label: string,
  content: string | null,
  expectedRulesVersion: string,
): InstalledAgentCheck {
  if (content === null) {
    return {
      name,
      status: 'warn',
      message: `${label} file is absent`,
    };
  }

  const rulesBlock = extractManagedRulesBlock(content);
  if (rulesBlock === null) {
    return {
      name,
      status: 'fail',
      message: `${label} missing required rules content: MBRAIN rules block`,
    };
  }

  const version = parseAgentRulesVersion(rulesBlock);
  const missingTerms = [
    ...(version === null ? ['mbrain-agent-rules-version'] : []),
    ...ROUTER_TERMS.filter((term) => !rulesBlock.includes(term)),
  ];

  if (missingTerms.length > 0) {
    return {
      name,
      status: 'fail',
      message: `${label} missing required rules content: ${missingTerms.join(', ')}`,
    };
  }

  if (version !== expectedRulesVersion) {
    return {
      name,
      status: 'fail',
      message: `${label} rules version ${version} does not match expected ${expectedRulesVersion}`,
    };
  }

  return {
    name,
    status: 'ok',
    message: `${label} rules version ${version} is installed`,
  };
}

function buildClaudeStopHookCheck(content: string | null): InstalledAgentCheck {
  if (content === null) {
    return {
      name: 'claude_stop_hook',
      status: 'warn',
      message: 'Claude stop hook is absent',
    };
  }

  if (!content.includes('route_memory_writeback')) {
    return {
      name: 'claude_stop_hook',
      status: 'fail',
      message: 'Claude stop hook does not call route_memory_writeback',
    };
  }

  return {
    name: 'claude_stop_hook',
    status: 'ok',
    message: 'Claude stop hook calls route_memory_writeback',
  };
}

function summarizeStatus(checks: InstalledAgentCheck[]): InstalledAgentCheckStatus {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  return 'ok';
}

function readOptionalFile(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}

function defaultCommandRunner(command: string, args: string[]): InstalledAgentCommandResult {
  const commandParts = splitAgentCommand(command);
  if (commandParts.length === 0) {
    return {
      stdout: '',
      stderr: 'Agent command is empty',
      exitCode: 1,
    };
  }

  try {
    const result = Bun.spawnSync({
      cmd: [...commandParts, ...args],
      stdout: 'pipe',
      stderr: 'pipe',
    });

    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode,
    };
  } catch (error) {
    return {
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
