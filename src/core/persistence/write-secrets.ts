/**
 * secrets.on_write: what a remote (MCP) page write does with text secret-scan.ts says holds a secret. `off` (the default)
 * changes nothing; `redact` replaces each claimed value with its `<REDACTED:pattern>` token before the write is
 * journaled; `block` refuses the write (`secret_in_write`). Local callers (remote === false: the CLI, sync, imports) are
 * never screened. File plane like secrets.on_push, so only the brain host's operator sets it; a value other than off,
 * redact or block screens as block. Refusals and receipts name pattern names and a count, never a value or a preview.
 */
import { loadConfigFileOnly } from '../config.ts';
import { opError, type OperationContext } from '../ops/contract.ts';
import { applyRedaction, planRedaction, scanText, type RedactionPlan, type SecretFinding } from '../secret-scan.ts';
import { scanTextStream } from '../secret-scan-stream.ts';
import { stripNul } from '../batch-rows.ts';

export const ON_WRITE_KEY = 'secrets.on_write';
export const ON_WRITE_MODES = ['off', 'redact', 'block'] as const;
export type OnWrite = typeof ON_WRITE_MODES[number];
export interface SecretsRedacted { count: number; patterns: string[] }

export function onWriteMode(): OnWrite {
  const mode = loadConfigFileOnly()?.secrets?.on_write;
  if (mode == null) return 'off';
  return ON_WRITE_MODES.includes(mode as OnWrite) ? mode as OnWrite : 'block';
}

/** Stand-ins documentation uses (the AWS documentation's example key id, a database URL's user:password), allowed by fingerprint. */
let docPlaceholders: string[] | null = null;
const allowlist = () => docPlaceholders ??= ['AKIAIOSFODNN7EXAMPLE', ...['postgres', 'postgresql'].map(scheme => `${scheme}://user:password@`)]
  .flatMap(text => scanText(text).map(finding => finding.fingerprint));

/** Every string a write stores, rebuilt through `fn`; an edit's old_text only locates the text it replaces, so it is kept. */
function mapStored(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map(item => mapStored(item, fn));
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'old_text' ? item : mapStored(item, fn)]));
}

const patternsOf = (findings: SecretFinding[]) => [...new Set(findings.map(finding => finding.pattern))].sort();

function secretInWrite(operation: string, findings: SecretFinding[], mode: OnWrite, uploaded = false) {
  const patterns = patternsOf(findings);
  return opError('secret_in_write',
    `${operation}: the text looks like it holds ${findings.length} secret${findings.length === 1 ? '' : 's'} (${patterns.join(', ')}), and this brain screens secrets in remote writes (secrets.on_write ${mode})`
      + (uploaded ? '; an uploaded body is never rewritten, so the upload was discarded and nothing was written.' : ', so nothing was written.'),
    'Remove the secret (name the environment variable or secret store entry that holds it instead) and send the write again with a new request_id.',
    { docs: 'docs/guides/write-refusals.md#secret_in_write', detail: patterns.join(','),
      why: 'A page is read by everyone the brain serves and sent to its model providers, so a credential stored in one is exposed to all of them.' });
}

/**
 * Admission screen for a remote write's parameters: unchanged when the policy is off, the caller is local or nothing
 * is found; a refusal under block; under redact the parameters with every claimed value (and its echoes in other
 * fields) replaced, with the count and pattern names. Text is screened as sent, then (after that redaction) as it will
 * be stored, without U+0000 (stripPageTextNul): a value split by NUL bytes is found, and so is one a NUL ends before
 * text it would join; only a string that held a claimed value comes back without them.
 */
export function screenWriteSecrets(ctx: Pick<OperationContext, 'remote'>, operation: string, params: Record<string, unknown>):
  { params: Record<string, unknown>; redacted: SecretsRedacted | null } {
  if (ctx.remote === false) return { params, redacted: null };
  const mode = onWriteMode();
  if (mode === 'off') return { params, redacted: null };
  const echoValues = new Map<string, string>();
  const plan = (value: unknown, form: (text: string) => string) => {
    const plans: RedactionPlan[] = [];
    mapStored(value, text => (plans.push(planRedaction(form(text), { allowlist: allowlist(), echoValues })), text));
    return plans;
  };
  const rawPlans = plan(params, text => text);
  let at = 0;
  const rawRedacted = mapStored(params, () => applyRedaction(rawPlans[at++]!));
  let nul = false;
  mapStored(params, text => (nul ||= text.includes('\u0000'), text));
  const plans = nul ? plan(rawRedacted, stripNul) : [];
  const findings = [...rawPlans, ...plans].flatMap(p => p.redactions);
  if (!findings.length) return { params, redacted: null };
  if (mode === 'block') throw secretInWrite(operation, findings, mode);
  at = 0;
  return { params: (nul ? mapStored(rawRedacted, text => { const out = applyRedaction(plans[at++]!); return out === stripNul(text) ? text : out; }) : rawRedacted) as Record<string, unknown>,
    redacted: { count: findings.length, patterns: patternsOf(findings) } };
}

/**
 * Commit screen for a remote upload's assembled body, read part by part: null when the policy is off, the caller is
 * local or nothing is found, else the refusal (under redact too, since the body is bound to the sha256 declared at begin).
 */
export async function screenUploadedSecrets(ctx: Pick<OperationContext, 'remote'>, parts: AsyncIterable<Uint8Array | null>) {
  if (ctx.remote === false) return null;
  const mode = onWriteMode();
  if (mode === 'off') return null;
  async function* bytes() { for await (const part of parts) { if (!part) return; yield part; } }
  const findings = await scanTextStream(bytes(), { allowlist: allowlist() });
  return findings.length ? secretInWrite('commit_page_upload', findings, mode, true) : null;
}
