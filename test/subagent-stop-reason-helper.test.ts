/**
 * Unit pins for src/core/minions/subagent-stop-reason.ts (#6448): the one
 * mapping from a provider turn to the SubagentStopReason the handler reports.
 */
import { describe, expect, test } from 'bun:test';
import {
  directStopReason,
  gatewayStopReason,
  isEmptyFinalText,
  replayTerminalStopReason,
} from '../src/core/minions/subagent-stop-reason.ts';

describe('subagent-stop-reason', () => {
  test('isEmptyFinalText: null, empty and whitespace-only are empty; text is not', () => {
    expect(isEmptyFinalText(null)).toBe(true);
    expect(isEmptyFinalText(undefined)).toBe(true);
    expect(isEmptyFinalText('')).toBe(true);
    expect(isEmptyFinalText(' \n\t')).toBe(true);
    expect(isEmptyFinalText('ok')).toBe(false);
  });

  test('directStopReason: max_tokens and refusal win over emptiness; empty clean stop is error', () => {
    expect(directStopReason('max_tokens', '')).toBe('max_tokens');
    expect(directStopReason('max_tokens', 'truncated')).toBe('max_tokens');
    expect(directStopReason('refusal', '')).toBe('refusal');
    expect(directStopReason('end_turn', '')).toBe('error');
    expect(directStopReason('end_turn', '  ')).toBe('error');
    expect(directStopReason('end_turn', 'done')).toBe('end_turn');
    expect(directStopReason(null, 'done')).toBe('end_turn');
    expect(directStopReason(undefined, '')).toBe('error');
  });

  test('gatewayStopReason covers every ToolLoopStopReason', () => {
    expect(gatewayStopReason('end')).toBe('end_turn');
    expect(gatewayStopReason('length')).toBe('max_tokens');
    expect(gatewayStopReason('max_turns')).toBe('max_turns');
    expect(gatewayStopReason('refusal')).toBe('refusal');
    expect(gatewayStopReason('content_filter')).toBe('refusal');
    expect(gatewayStopReason('empty_response')).toBe('error');
    expect(gatewayStopReason('aborted')).toBe('error');
    expect(gatewayStopReason('unrecoverable')).toBe('error');
  });

  test('replayTerminalStopReason: cap recovers max_tokens, empty text is error, text is end_turn', () => {
    expect(replayTerminalStopReason(8192, 8192, '')).toBe('max_tokens');
    expect(replayTerminalStopReason(9000, 8192, 'partial')).toBe('max_tokens');
    expect(replayTerminalStopReason(50, 8192, '')).toBe('error');
    expect(replayTerminalStopReason(null, 8192, ' ')).toBe('error');
    expect(replayTerminalStopReason(undefined, 8192, 'answer')).toBe('end_turn');
    expect(replayTerminalStopReason(50, 8192, 'answer')).toBe('end_turn');
  });
});
