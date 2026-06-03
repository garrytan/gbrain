import { readFileSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';
import { DEFAULT_RUNTIME_CONFIG } from '../core/engine-factory.ts';
import { operationsByName, type OperationContext } from '../core/operations.ts';
import { normalizeAgentSessionCaptureEnvelope } from '../core/services/agent-session-capture-envelope-service.ts';
import type { AgentSessionWriteMode } from '../core/types.ts';

type AgentSessionAction = 'preview' | 'capture';

interface ParsedAgentSessionArgs {
  action: AgentSessionAction;
  file: string;
  json: boolean;
  apply: boolean;
  dry_run: boolean;
  write_mode?: AgentSessionWriteMode;
}

const WRITE_MODES = new Set<AgentSessionWriteMode>([
  'candidate_only',
  'direct_personal_when_allowed',
]);

export async function runAgentSession(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const parsed = parseAgentSessionArgs(args);
  const input = {
    ...normalizeAgentSessionCaptureEnvelope(JSON.parse(readFileSync(parsed.file, 'utf-8'))),
    write_mode: parsed.write_mode ?? 'candidate_only',
    ...(parsed.action === 'capture' ? { apply: parsed.apply, dry_run: parsed.dry_run } : {}),
  };
  const ctx: OperationContext = {
    engine,
    config: loadConfig() ?? DEFAULT_RUNTIME_CONFIG,
    logger: { info: console.log, warn: console.warn, error: console.error },
    dryRun: parsed.dry_run,
  };
  const op = parsed.action === 'preview'
    ? operationsByName.preview_agent_session_memory
    : operationsByName.capture_agent_session_memory;
  const result = await op.handler(ctx, input);

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatAgentSessionSummary(parsed.action, result as Record<string, unknown>));
}

function parseAgentSessionArgs(args: string[]): ParsedAgentSessionArgs {
  const action = args[0];
  if (action !== 'preview' && action !== 'capture') {
    throw new Error('agent-session action must be preview or capture');
  }

  const file = readFlag(args, '--file');
  if (!file) throw new Error('--file is required');
  const apply = hasFlag(args, '--apply');
  const dryRun = hasFlag(args, '--dry-run');
  if (action === 'capture' && apply === dryRun) {
    throw new Error('capture requires exactly one of --apply or --dry-run');
  }
  const writeMode = readFlag(args, '--write-mode');
  if (writeMode !== undefined && !WRITE_MODES.has(writeMode as AgentSessionWriteMode)) {
    throw new Error('--write-mode must be candidate_only or direct_personal_when_allowed');
  }

  return {
    action,
    file,
    json: hasFlag(args, '--json'),
    apply,
    dry_run: dryRun,
    write_mode: writeMode as AgentSessionWriteMode | undefined,
  };
}

function formatAgentSessionSummary(action: AgentSessionAction, result: Record<string, unknown>): string {
  const signals = Array.isArray(result.signals) ? result.signals.length : 0;
  const routes = Array.isArray(result.routes) ? result.routes.length : 0;
  return [
    `agent-session ${action}: applied=${String(result.applied)}`,
    `signals=${signals}`,
    `routes=${routes}`,
  ].join(' ') + '\n';
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function readFlag(args: string[], flag: string): string | undefined {
  const eq = args.find((arg) => arg.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function printUsage(): void {
  console.log([
    'Usage:',
    '  mbrain agent-session preview --file session.json [--json]',
    '  mbrain agent-session capture --file session.json (--apply|--dry-run) [--write-mode candidate_only|direct_personal_when_allowed] [--json]',
  ].join('\n'));
}
