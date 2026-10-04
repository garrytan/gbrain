/**
 * FROZEN copy of the pre-wave thin client's result parsing (src/core/mcp-client.ts
 * at f776fca, v0.60.37.0): how a deployed old client reads tool results. Never
 * edit: test/thin-client-contract-skew.test.ts runs it against the v1 goldens.
 * (Receipt validation is reduced to the key copy; the old client validated shape.)
 */
export function oldExtractToolErrorCode(message: string): string | undefined {
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === 'object') {
      const code = typeof parsed.error === 'string'
        ? parsed.error : parsed.error?.code ?? parsed.code;
      if (typeof code === 'string') return code;
    }
  } catch { /* not json; fall through */ }
  if (/missing[_\s-]?scope|scope.+(insufficient|required)|forbidden|access.+denied/i.test(message)) {
    return 'missing_scope';
  }
  return undefined;
}

export function oldExtractToolErrorDetail(message: string): Record<string, unknown> {
  const code = oldExtractToolErrorCode(message);
  const detail: Record<string, unknown> = code ? { code } : {};
  try {
    const body: unknown = JSON.parse(message);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return detail;
    const envelope = body as Record<string, unknown>;
    if (typeof envelope.message === 'string') detail.message = envelope.message;
    if (typeof envelope.suggestion === 'string') detail.suggestion = envelope.suggestion;
    if (envelope.protocol_version === 1) detail.protocol_version = 1;
    if (typeof envelope.detail === 'string') detail.server_detail = envelope.detail;
    if (typeof envelope.docs === 'string') detail.docs = envelope.docs;
    if (envelope.write_request && typeof envelope.write_request === 'object') detail.write_request = envelope.write_request;
    if (typeof envelope.write_error === 'string') detail.write_error = envelope.write_error;
  } catch { /* plain text */ }
  return detail;
}

/** The old client's isError path joined EVERY block with '\n' before parsing. */
export function oldReadError(res: { content: Array<{ text?: string }> }): Record<string, unknown> {
  const message = res.content.map(c => c.text ?? '').join('\n');
  return oldExtractToolErrorDetail(message);
}

/** The old client's success path: content[0] only. */
export function oldUnpack(res: { content: Array<{ type?: string; text?: string }> }): unknown {
  return JSON.parse(res.content[0]!.text!);
}
