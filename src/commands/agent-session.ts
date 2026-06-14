import { readFileSync, statSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';
import { DEFAULT_RUNTIME_CONFIG } from '../core/engine-factory.ts';
import { dispatchOperation, operationsByName, type OperationContext } from '../core/operations.ts';
import {
  normalizeAgentSessionCaptureEnvelope,
  parseClaudeCodeTranscript,
} from '../core/services/agent-session-capture-envelope-service.ts';
import type { AgentSessionCaptureOperationInput, AgentSessionWriteMode } from '../core/types.ts';

type AgentSessionAction = 'preview' | 'capture';

interface ParsedAgentSessionArgs {
  action: AgentSessionAction;
  file?: string;
  transcript_path?: string;
  session_id?: string;
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
  let envelope: AgentSessionCaptureOperationInput;
  let transcriptStats: { parsed_events: number; skipped_lines: number } | null = null;
  if (parsed.transcript_path) {
    // Mirror the stop hook's 50MB guard for direct CLI use.
    const stats = statSync(parsed.transcript_path);
    if (stats.size > 52_428_800) {
      throw new Error('transcript file exceeds the 50MB capture limit');
    }
    const result = parseClaudeCodeTranscript(readFileSync(parsed.transcript_path, 'utf-8'), {
      session_id: parsed.session_id as string,
    });
    envelope = result.input;
    transcriptStats = { parsed_events: result.parsed_events, skipped_lines: result.skipped_lines };
    if (envelope.events.length === 0) {
      console.log('agent-session: transcript contains no capturable user/assistant text; nothing to do');
      return;
    }
  } else {
    envelope = normalizeAgentSessionCaptureEnvelope(JSON.parse(readFileSync(parsed.file as string, 'utf-8')));
  }
  const input = {
    ...envelope,
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
  const result = await dispatchOperation(ctx, op, input);

  if (parsed.json) {
    console.log(JSON.stringify(
      transcriptStats ? { ...(result as Record<string, unknown>), transcript: transcriptStats } : result,
      null,
      2,
    ));
    return;
  }

  console.log(formatAgentSessionSummary(parsed.action, result as Record<string, unknown>, transcriptStats));
}

function parseAgentSessionArgs(args: string[]): ParsedAgentSessionArgs {
  const action = args[0];
  if (action !== 'preview' && action !== 'capture') {
    throw new Error('agent-session action must be preview or capture');
  }

  const file = readFlag(args, '--file');
  const transcriptPath = readFlag(args, '--transcript-path');
  const sessionId = readFlag(args, '--session-id');
  if ((file ? 1 : 0) + (transcriptPath ? 1 : 0) !== 1) {
    throw new Error('provide exactly one of --file or --transcript-path');
  }
  if (transcriptPath && !sessionId) {
    throw new Error('--session-id is required with --transcript-path');
  }
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
    transcript_path: transcriptPath,
    session_id: sessionId,
    json: hasFlag(args, '--json'),
    apply,
    dry_run: dryRun,
    write_mode: writeMode as AgentSessionWriteMode | undefined,
  };
}

function formatAgentSessionSummary(
  action: AgentSessionAction,
  result: Record<string, unknown>,
  transcriptStats: { parsed_events: number; skipped_lines: number } | null = null,
): string {
  const signals = Array.isArray(result.signals) ? result.signals.length : 0;
  const routes = Array.isArray(result.routes) ? result.routes.length : 0;
  const parts = [
    `agent-session ${action}: applied=${String(result.applied)}`,
    `signals=${signals}`,
    `routes=${routes}`,
  ];
  if (transcriptStats) {
    parts.push(`transcript_events=${transcriptStats.parsed_events}`, `skipped_lines=${transcriptStats.skipped_lines}`);
  }
  return parts.join(' ') + '\n';
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
    '  mbrain agent-session preview --transcript-path transcript.jsonl --session-id <id> [--json]',
    '  mbrain agent-session capture --file session.json (--apply|--dry-run) [--write-mode candidate_only|direct_personal_when_allowed] [--json]',
    '  mbrain agent-session capture --transcript-path transcript.jsonl --session-id <id> (--apply|--dry-run) [--write-mode ...] [--json]',
  ].join('\n'));
}
