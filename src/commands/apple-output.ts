/**
 * Output helpers for `gbrain apple` (issue #6855): the same envelope as
 * `gbrain google` ({ ok, status, next_action: { command?, user_message? },
 * error?: { code, problem, cause, fix, doc_url } }), exit 0 done / 1 failed /
 * 2 waiting on the user (agent contract v1, legacy).
 */
import { agentBlock } from '../core/agent-markers.ts';

export const APPLE_DOC_URL = 'https://github.com/garrytan/gbrain/blob/master/docs/guides/apple-connect.md';

/**
 * Envelopes are built with `next`; `emitEnvelope` is the single place that
 * writes the wire key `next_action` (the `gbrain google` contract), so the
 * agent-contract legacy-advice-key baseline holds exactly one hit here.
 */
export interface AppleEnvelope {
  ok: boolean;
  status: string;
  next?: { command?: string; user_message?: string };
  error?: { code: string; problem: string; cause: string; fix: string; doc_url: string };
  [k: string]: unknown;
}

export type AppleErrorCode =
  | 'unsupported_platform' | 'unknown_service' | 'empty_services' | 'invalid_value' | 'unknown_subcommand' | 'mail_confirmation_required'
  | 'no_brain' | 'source_id_taken' | 'source_not_found' | 'not_apple_source' | 'ambiguous_source' | 'probe_failed' | 'sync_failed' | 'service_scope_mismatch' | 'source_scope_mismatch' | 'source_scope_changed' | 'extraction_consent_requires_identity' | 'mail_routing_unknown';

export interface AppleOut {
  json: boolean;
  write(text: string): void;
}

export function emitEnvelope(out: AppleOut, envelope: AppleEnvelope, humanLines: string[]): void {
  const { next, ...rest } = envelope;
  const wire = { ...rest, ...(next ? { next_action: next } : {}) };
  out.write(out.json ? JSON.stringify(wire, null, 2) + '\n' : humanLines.join('\n') + '\n');
}

/** A failed run (exit 1) with a coded error. */
export function errorEnvelope(code: AppleErrorCode, problem: string, cause: string, fix: string, next?: AppleEnvelope['next']): { envelope: AppleEnvelope; human: string[] } {
  return {
    envelope: { ok: false, status: 'error', error: { code, problem, cause, fix, doc_url: APPLE_DOC_URL }, ...(next ? { next } : {}) },
    human: [`Error (${code}): ${problem}`, `  Why: ${cause}`, `  Fix: ${fix}`, `  Docs: ${APPLE_DOC_URL}`],
  };
}

/** The relay block for the harness: [AGENT] with a fenced [SHOW USER] message (built by the one marker builder). */
export function showUserBlock(userMessage: string, nextCommand?: string): string {
  return agentBlock({ next: nextCommand ? `run ${nextCommand} once the user has done this` : 'wait for the user' }, { showUser: userMessage }).trimEnd();
}
