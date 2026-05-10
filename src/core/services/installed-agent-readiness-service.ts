import { existsSync, readFileSync, realpathSync } from 'fs';
import { basename, join } from 'path';

export type InstalledAgentCheckStatus = 'ok' | 'warn' | 'fail';

export interface InstalledAgentCheck {
  name: string;
  status: InstalledAgentCheckStatus;
  message: string;
}

export interface InstalledAgentTool {
  name: string;
}

export interface InstalledAgentMcpRegistration {
  client: 'codex' | 'claude';
  detected: boolean;
  registered: boolean;
  command: string | null;
  status?: string | null;
  source: string;
  error?: string;
}

export interface InstalledAgentReadinessInput {
  command: string;
  commandPath?: string | null;
  commandVersion: string | null;
  tools: InstalledAgentTool[];
  codexPrompt: string | null;
  claudePrompt: string | null;
  claudeStopHook: string | null;
  codexMcpRegistration?: InstalledAgentMcpRegistration | null;
  claudeMcpRegistration?: InstalledAgentMcpRegistration | null;
  expectedRulesVersion: string;
  expectedRulesContent?: string | null;
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

export type InstalledAgentCommandPathResolver = (
  command: string,
) => string | null | Promise<string | null>;

export const REQUIRED_AGENT_TOOLS = [
  'retrieve_context',
  'read_context',
  'record_retrieval_trace',
  'route_memory_writeback',
] as const;

const RULES_START = '<!-- MBRAIN:RULES:START -->';
const RULES_END = '<!-- MBRAIN:RULES:END -->';
const ROUTER_TERMS = [
  'route_memory_writeback',
  'canonical_write_allowed',
  'target_snapshot_hash',
  'expected_content_hash',
] as const;

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
  const codexPromptCheck = buildPromptRulesCheck(
    'codex_prompt_rules',
    'Codex prompt',
    input.codexPrompt,
    input.expectedRulesVersion,
    input.expectedRulesContent,
  );
  const claudePromptCheck = buildPromptRulesCheck(
    'claude_prompt_rules',
    'Claude prompt',
    input.claudePrompt,
    input.expectedRulesVersion,
    input.expectedRulesContent,
  );
  const checks: InstalledAgentCheck[] = [
    buildCommandVersionCheck(input),
    ...optionalCheck(buildCommandPathCheck(input)),
    buildRequiredToolsCheck(input.tools),
    ...optionalCheck(buildMcpRegistrationCheck(
      'codex_mcp_registration',
      'Codex',
      input.codexMcpRegistration,
      input.command,
      input.commandPath,
    )),
    ...optionalCheck(buildMcpRegistrationCheck(
      'claude_mcp_registration',
      'Claude',
      input.claudeMcpRegistration,
      input.command,
      input.commandPath,
    )),
    codexPromptCheck,
    claudePromptCheck,
    buildPromptCoverageCheck([codexPromptCheck, claudePromptCheck]),
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
  expectedRulesContent = null,
  home = process.env.HOME || process.env.USERPROFILE || '',
  runCommand = defaultCommandRunner,
  resolveCommandPath = defaultCommandPathResolver,
}: {
  command: string;
  expectedRulesVersion: string;
  expectedRulesContent?: string | null;
  home?: string;
  runCommand?: InstalledAgentCommandRunner;
  resolveCommandPath?: InstalledAgentCommandPathResolver;
}): Promise<InstalledAgentReadinessReport> {
  const commandPath = await resolveCommandPath(command);
  const versionResult = await runCommand(command, ['--version']);
  const toolsResult = await runCommand(command, ['--tools-json']);
  const codexMcpRegistration = await collectMcpRegistration('codex', home, runCommand);
  const claudeMcpRegistration = await collectMcpRegistration('claude', home, runCommand);

  return buildInstalledAgentReadinessReport({
    command,
    commandPath,
    commandVersion: versionResult.exitCode === 0 ? versionResult.stdout.trim() : null,
    tools: toolsResult.exitCode === 0 ? parseToolsJson(toolsResult.stdout) : [],
    codexPrompt: readOptionalFile(join(home, '.codex', 'AGENTS.md')),
    claudePrompt: readOptionalFile(join(home, '.claude', 'CLAUDE.md')),
    claudeStopHook: readOptionalFile(join(home, '.claude', 'scripts', 'hooks', 'stop-mbrain-check.sh')),
    codexMcpRegistration,
    claudeMcpRegistration,
    expectedRulesVersion,
    expectedRulesContent,
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

export function parseAgentMcpRegistrationOutput(
  client: InstalledAgentMcpRegistration['client'],
  stdout: string,
): string | null {
  return parseAgentMcpRegistrationDetails(client, stdout)?.command ?? null;
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

function buildCommandPathCheck(input: InstalledAgentReadinessInput): InstalledAgentCheck | null {
  if (input.commandPath === undefined) return null;
  if (!input.commandPath) {
    return {
      name: 'agent_command_path',
      status: 'fail',
      message: `Could not resolve executable for agent command: ${input.command}`,
    };
  }

  return {
    name: 'agent_command_path',
    status: 'ok',
    message: `Resolved agent command executable: ${input.commandPath}`,
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

function buildMcpRegistrationCheck(
  name: string,
  label: string,
  registration: InstalledAgentMcpRegistration | null | undefined,
  expectedAgentCommand: string,
  expectedAgentCommandPath?: string | null,
): InstalledAgentCheck | null {
  if (registration === undefined) return null;
  if (registration === null || !registration.detected) {
    return {
      name,
      status: 'warn',
      message: `${label} config directory not found; skipped MCP registration check`,
    };
  }

  const registrationCommand = registration.command;
  if (!registration.registered || !registrationCommand) {
    return {
      name,
      status: 'fail',
      message: `${label} MCP registration for mbrain was not found${formatRegistrationError(registration)}`,
    };
  }

  const registrationStatusFailure = getRegistrationStatusFailure(registration);
  if (registrationStatusFailure) {
    return {
      name,
      status: 'fail',
      message: `${label} MCP registration status is ${registration.status}; expected ${registrationStatusFailure}`,
    };
  }

  const expectedServerCommands = buildExpectedServerCommands(expectedAgentCommand, expectedAgentCommandPath);
  const expectedServerCommand = expectedServerCommands[0];
  if (expectedServerCommands.some((expected) => registrationCommandMatches(registrationCommand, expected))) {
    return {
      name,
      status: 'ok',
      message: `${label} MCP registration points to ${registrationCommand}`,
    };
  }

  if (isDefaultMbrainServeCommand(registrationCommand)) {
    return {
      name,
      status: 'warn',
      message: `${label} MCP registration points to ${registrationCommand}; checked command is ${expectedServerCommand}`,
    };
  }

  return {
    name,
    status: 'fail',
    message: `${label} MCP registration points to ${registrationCommand}; expected ${expectedServerCommand}`,
  };
}

function buildPromptRulesCheck(
  name: string,
  label: string,
  content: string | null,
  expectedRulesVersion: string,
  expectedRulesContent?: string | null,
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

  if (
    expectedRulesContent
    && normalizeRulesContent(rulesBlock) !== normalizeRulesContentForComparison(expectedRulesContent)
  ) {
    return {
      name,
      status: 'fail',
      message: `${label} managed rules block does not match packaged MBrain agent rules`,
    };
  }

  return {
    name,
    status: 'ok',
    message: `${label} rules version ${version} is installed`,
  };
}

function buildPromptCoverageCheck(promptChecks: InstalledAgentCheck[]): InstalledAgentCheck {
  if (promptChecks.some((check) => check.status === 'ok')) {
    return {
      name: 'agent_prompt_rules',
      status: 'ok',
      message: 'At least one supported agent prompt has the managed MBrain rules installed',
    };
  }

  return {
    name: 'agent_prompt_rules',
    status: 'fail',
    message: 'No supported agent prompt has the managed MBrain rules installed',
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

interface ParsedAgentMcpRegistration {
  command: string;
  status: string | null;
}

function optionalCheck(check: InstalledAgentCheck | null): InstalledAgentCheck[] {
  return check ? [check] : [];
}

async function collectMcpRegistration(
  client: InstalledAgentMcpRegistration['client'],
  home: string,
  runCommand: InstalledAgentCommandRunner,
): Promise<InstalledAgentMcpRegistration | null> {
  const configDir = join(home, client === 'codex' ? '.codex' : '.claude');
  if (!existsSync(configDir)) return null;

  const source = client === 'codex' ? 'codex mcp list' : 'claude mcp get mbrain';
  const result = client === 'codex'
    ? await runCommand('codex', ['mcp', 'list'])
    : await runCommand('claude', ['mcp', 'get', 'mbrain']);
  if (result.exitCode !== 0) {
    return {
      client,
      detected: true,
      registered: false,
      command: null,
      source,
      error: (result.stderr || result.stdout).trim(),
    };
  }

  const parsed = parseAgentMcpRegistrationDetails(client, result.stdout);
  return {
    client,
    detected: true,
    registered: parsed !== null,
    command: parsed?.command ?? null,
    status: parsed?.status ?? null,
    source,
  };
}

function parseAgentMcpRegistrationDetails(
  client: InstalledAgentMcpRegistration['client'],
  stdout: string,
): ParsedAgentMcpRegistration | null {
  return client === 'codex'
    ? parseCodexMcpListOutput(stdout)
    : parseClaudeMcpGetOutput(stdout);
}

function parseCodexMcpListOutput(stdout: string): ParsedAgentMcpRegistration | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/\bmbrain\b/.test(trimmed) || /^Name\s+/i.test(trimmed)) continue;

    const colonMatch = trimmed.match(/^mbrain\s*:\s*(.+)$/i);
    if (colonMatch) {
      return {
        command: cleanRegistrationCommand(colonMatch[1]),
        status: null,
      };
    }

    const columns = trimmed.split(/\s{2,}/);
    if (columns[0] === 'mbrain' && columns[1]) {
      const args = columns[2] && columns[2] !== '-' ? columns[2] : '';
      const status = columns[5] && columns[5] !== '-' ? columns[5] : null;
      return {
        command: cleanRegistrationCommand([columns[1], args].filter(Boolean).join(' ')),
        status,
      };
    }
  }
  return null;
}

function parseClaudeMcpGetOutput(stdout: string): ParsedAgentMcpRegistration | null {
  const command = stdout.match(/^\s*Command:\s*(.+)$/im)?.[1]?.trim();
  if (!command) return null;

  const args = stdout.match(/^\s*Args:\s*(.+)$/im)?.[1]?.trim();
  const status = stdout.match(/^\s*Status:\s*(.+)$/im)?.[1]?.trim() ?? null;
  return {
    command: cleanRegistrationCommand([command, args].filter((part) => part && part !== '-').join(' ')),
    status,
  };
}

function cleanRegistrationCommand(command: string): string {
  return command
    .replace(/\s+-\s+.*$/, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function registrationCommandMatches(actual: string, expected: string): boolean {
  const actualParts = splitAgentCommand(cleanRegistrationCommand(actual));
  const expectedParts = splitAgentCommand(cleanRegistrationCommand(expected));
  return actualParts.length === expectedParts.length
    && actualParts.every((part, index) => (
      index === 0
        ? commandExecutableMatches(part, expectedParts[index])
        : part === expectedParts[index]
    ));
}

function isDefaultMbrainServeCommand(command: string): boolean {
  return registrationCommandMatches(command, 'mbrain serve');
}

function buildExpectedServerCommands(
  expectedAgentCommand: string,
  expectedAgentCommandPath?: string | null,
): string[] {
  const expectedCommands = [`${expectedAgentCommand.trim()} serve`];
  const expectedParts = splitAgentCommand(expectedAgentCommand);
  if (expectedAgentCommandPath && expectedParts.length > 0) {
    expectedCommands.push([
      expectedAgentCommandPath,
      ...expectedParts.slice(1),
      'serve',
    ].join(' '));
  }

  return [...new Set(expectedCommands)];
}

function commandExecutableMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;

  const actualRealPath = realpathIfExisting(actual);
  const expectedRealPath = realpathIfExisting(expected);
  if (actualRealPath && expectedRealPath && actualRealPath === expectedRealPath) return true;

  return basename(actual) === basename(expected);
}

function realpathIfExisting(path: string): string | null {
  try {
    return existsSync(path) ? realpathSync(path) : null;
  } catch {
    return null;
  }
}

function getRegistrationStatusFailure(registration: InstalledAgentMcpRegistration): string | null {
  const status = normalizeRegistrationStatus(registration.status ?? '');
  if (!status) return null;

  if (registration.client === 'codex') {
    return status === 'enabled' ? null : 'enabled';
  }

  return status === 'connected' || status === 'healthy'
    ? null
    : 'connected or healthy';
}

function normalizeRegistrationStatus(status: string): string {
  return status
    .trim()
    .toLowerCase()
    .replace(/^[^a-z0-9]+/, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function formatRegistrationError(registration: InstalledAgentMcpRegistration): string {
  return registration.error ? `: ${registration.error}` : '';
}

function readOptionalFile(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}

function normalizeRulesContentForComparison(content: string): string {
  return normalizeRulesContent(extractManagedRulesBlock(content) ?? content);
}

function normalizeRulesContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
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

function defaultCommandPathResolver(command: string): string | null {
  const commandParts = splitAgentCommand(command);
  const executable = commandParts[0];
  if (!executable) return null;
  if (executable.includes('/')) {
    return existsSync(executable) ? executable : null;
  }

  try {
    const result = Bun.spawnSync({
      cmd: ['which', executable],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const resolved = result.stdout.toString().trim().split(/\r?\n/)[0];
    return result.exitCode === 0 && resolved ? resolved : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
