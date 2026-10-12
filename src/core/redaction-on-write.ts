/**
 * Redact-on-write — the ingest half of the redaction seam
 * (`redaction-policy.ts`). With `redaction.on_write` set to `facts` or `all`,
 * a page written at an untrusted trust tier (`agent_written`, `unknown`,
 * `external_untrusted`) is stored with each span the scanner claims for
 * `redaction.on_write_classes` replaced by its `<REDACTED:pattern>` token.
 * Owner-tier writes (`user_confirmed`, `operator_curated`, `tool_observed`)
 * and writes with no tier (owner paths that skip the write gate) keep today's
 * behaviour. Default `off`: the parsed page is never touched.
 *
 * Runs in `settleContentDisposition` (import-screen.ts) after the observe-only
 * guardrail hook, so a registered guardrail saw the raw text, and BEFORE the
 * content-sanity gate, the write gate and the content hash, so the hash,
 * `page_versions` and every derived projection reflect the stored (redacted)
 * body. `facts` scope touches only the rows inside ```facts fences; `all`
 * covers title, body and timeline.
 *
 * The receipt names pattern and fingerprint per claimed span, never a value.
 */
import { applyRedaction, planRedaction, type EchoDictionary } from './secret-scan.ts';
import { redactionPolicy, type RedactionPolicy } from './redaction-policy.ts';

export interface RedactionReceipt {
  pattern: string;
  /** `sha256:<16 hex>` of the claimed value — the allowlist key, never the value. */
  fingerprint: string;
  field: 'title' | 'body' | 'timeline';
}

const UNTRUSTED_TIERS: ReadonlySet<string> = new Set(['agent_written', 'unknown', 'external_untrusted']);

/** Whether the on-write splice applies to a write at `tier` under `policy`. */
export function onWriteRedactionApplies(tier: unknown, policy: RedactionPolicy = redactionPolicy()): boolean {
  return policy.onWrite !== 'off' && policy.onWriteClasses.length > 0 && typeof tier === 'string' && UNTRUSTED_TIERS.has(tier);
}

const FACTS_FENCE_RE = /(```facts[^\n]*\n)([\s\S]*?)(\n?```)/g;

/**
 * Splice the on-write redaction into `parsed` in place and return the receipt
 * (empty when the policy or the tier keeps the write raw).
 */
export function applyOnWriteRedaction(
  parsed: { title: string; compiled_truth: string; timeline: string },
  tier: unknown,
  policy: RedactionPolicy = redactionPolicy(),
): RedactionReceipt[] {
  if (!onWriteRedactionApplies(tier, policy)) return [];
  const classes = policy.onWriteClasses;
  const highEntropy = classes.includes('credential');
  const echoValues: EchoDictionary = new Map();
  const receipts: RedactionReceipt[] = [];
  const redact = (text: string, field: RedactionReceipt['field']): string => {
    if (!text) return text;
    const plan = planRedaction(text, { classes, highEntropy, echoValues });
    if (plan.claimed.length === 0 && echoValues.size === 0) return text;
    for (const r of plan.redactions) receipts.push({ pattern: r.pattern, fingerprint: r.fingerprint, field });
    return applyRedaction(plan);
  };
  if (policy.onWrite === 'all') {
    parsed.title = redact(parsed.title, 'title');
    parsed.compiled_truth = redact(parsed.compiled_truth, 'body');
    parsed.timeline = redact(parsed.timeline, 'timeline');
  } else {
    parsed.compiled_truth = parsed.compiled_truth.replace(FACTS_FENCE_RE, (_m, open: string, inner: string, close: string) => open + redact(inner, 'body') + close);
  }
  return receipts;
}
