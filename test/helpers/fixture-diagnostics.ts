import { redactConnectionInfo } from '../../src/core/audit/redact-connection-info.ts';

function redactFixtureText(text: string, secrets: readonly string[]): string {
  let safe = text;
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    safe = safe.split(secret).join('[REDACTED]');
  }
  safe = safe
    .replace(/\bgbrain_(?:cs_|cl_)?[A-Za-z0-9_-]+/g, '[REDACTED:credential]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:["']?(?:access_token|refresh_token|client_secret|api_key|authorization)["']?)\s*[:=]\s*["']?)[^\s,"'&}]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|sk-ant)-[A-Za-z0-9_-]+/g, '[REDACTED:provider-key]');
  return redactConnectionInfo(safe);
}

function bounded(text: string, limit = 2000): string {
  const suffix = '\n[truncated]';
  return text.length > limit ? `${text.slice(0, limit - suffix.length)}${suffix}` : text;
}

/** Structured codes only; free-form error messages stay in the redacted detail. */
function operationErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const payload = value as { error?: unknown; code?: unknown; message?: unknown };
  const nested = payload.error && typeof payload.error === 'object'
    ? (payload.error as { code?: unknown }).code : undefined;
  for (const candidate of [nested, payload.code, typeof payload.message === 'string' ? payload.error : undefined]) {
    if (typeof candidate === 'string' && /^[a-z][a-z0-9_.:-]{0,127}$/i.test(candidate)) return candidate;
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) return String(candidate);
  }
  return undefined;
}

function textErrorCode(text: string): string | undefined {
  // CLI stdout may be one pretty-printed object or JSON lines after notices.
  try {
    const code = operationErrorCode(JSON.parse(text));
    if (code) return code;
  } catch { /* Try independently parseable lines below. */ }
  for (const line of text.split('\n')) {
    try {
      const code = operationErrorCode(JSON.parse(line));
      if (code) return code;
    } catch { /* Warning/progress text is not a structured error code. */ }
  }
  return undefined;
}

/** Bounded failure context. Never pass env maps or successful credential output.
 * Known fixture secrets supplement token/credential-field redaction.
 */
export function fixtureDiagnostic(operation: string, detail: string, secrets: readonly string[] = []): string {
  return bounded(redactFixtureText(`${operation}: ${detail}`, secrets));
}

export function cliDiagnostic(operation: string, result: { exitCode: number; stderr: string; stdout: string }, secrets: readonly string[] = []): string {
  // stdout can contain freshly minted credentials even on partial failure;
  // redact it using the same policy before it can become assertion output.
  const code = textErrorCode(result.stdout) ?? textErrorCode(result.stderr);
  const header = fixtureDiagnostic(operation, `exit=${result.exitCode}${code ? ` code=${code}` : ''}`, secrets);
  // Separate budgets preserve evidence from both streams. Redact BEFORE
  // truncation, so cutting through a credential cannot expose its prefix.
  const detail = [['stderr', result.stderr], ['stdout', result.stdout]]
    .filter(([, text]) => text)
    .map(([label, text]) => `${label}:\n${bounded(redactFixtureText(text, secrets), 850)}`)
    .join('\n');
  return bounded(`${header}\n${detail}`);
}

/** On success avoid serializing the tool result (which may carry user data). */
export function toolDiagnostic(operation: string, result: unknown, secrets: readonly string[] = []): string {
  const tool = result as { isError?: boolean; error?: unknown; content?: Array<{ type?: string; text?: string }> };
  if (!tool?.isError && !tool?.error) return operation;
  const texts = Array.isArray(tool.content)
    ? tool.content.filter(item => item.type === 'text').map(item => item.text ?? '') : [];
  const code = texts.map(textErrorCode).find(Boolean) ?? operationErrorCode(tool);
  const detail = texts.join('\n')
    || (typeof tool.error === 'string' ? tool.error : JSON.stringify(tool.error)) || 'tool error';
  return fixtureDiagnostic(operation, `${code ? `code=${code}\n` : ''}${detail}`, secrets);
}
