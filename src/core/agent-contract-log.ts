/**
 * Agent-contract health log (agent operator wave E11 seam, landed with A1).
 *
 * Dispatch, renderCliError and requireConsent append one line per
 * NON-SUCCESS outcome: `{ts, op|command, transport, code, has_suggestion |
 * effects, outcome}`. Never params, never messages: only codes and shapes.
 * Fail-open and synchronous (one small O_APPEND write per event, safe on the
 * exit path). Bounded: the file is truncated to its newest half once it
 * passes MAX_BYTES. Doctor's `agent_contract` check (Lane E) reads it.
 *
 * Path: `<GBRAIN_HOME>/agent-contract/events.jsonl` via gbrainPath.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gbrainPath } from './config.ts';
import type { Effect, Transport } from './agent-output.ts';

const MAX_BYTES = 1024 * 1024;

export interface AgentContractEvent {
  op?: string;
  command?: string;
  transport: Transport;
  code: string;
  has_suggestion?: boolean;
  effects?: Effect[];
  outcome?: string;
  /** Internal normaliser fault class (never a message). */
  fault?: string;
}

export function agentContractLogPath(): string {
  return gbrainPath('agent-contract', 'events.jsonl');
}

/** Append one bounded JSONL line. Fail-open: logging can never change an outcome. */
export function appendBoundedJsonl(path: string, record: Record<string, unknown>, maxBytes: number = MAX_BYTES): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    if (statSync(path).size <= maxBytes) return;
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    writeFileSync(path, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`, { mode: 0o600 });
  } catch { /* fail-open */ }
}

export function recordAgentContractEvent(event: AgentContractEvent): void {
  appendBoundedJsonl(agentContractLogPath(), { ts: new Date().toISOString(), ...event });
}

/** Read back recent events (newest last). Never throws. */
export function readAgentContractEvents(limit = 500): Array<AgentContractEvent & { ts: string }> {
  try {
    const lines = readFileSync(agentContractLogPath(), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}
