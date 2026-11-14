/**
 * The shared-brain agreement step (plan D5, D6; Wakeshift ToS 6.2, 6.3, 6.6).
 * On a brain with live access members, the operator (the brain owner, who
 * holds the Wakeshift app) must show each person one step before the first
 * wake: what watching does, the operator's own terms and privacy links, the
 * Wakeshift disclosure and Wakeshift's Connector Terms and Privacy Policy.
 * `gbrain wakeshift enable` stores the two operator links in the file plane;
 * the terms version is a hash of them, so changing a link asks everyone again.
 * Acceptances live in wake_terms_acceptances, keyed by the principal (the bound
 * member when there is one). A brain with no live members skips the step.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { WakeshiftFileConfig } from './config.ts';

export const WAKESHIFT_CONNECTOR_TERMS_URL = 'https://wakeshift.ai/connector-terms';
export const WAKESHIFT_PRIVACY_URL = 'https://wakeshift.ai/privacy';

export interface OperatorTerms { terms_url: string; privacy_url: string; version: string }

/** An absolute https URL (at most 500 characters), else null. */
export function httpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 500) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' && url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The operator's links from the file plane with their version (first 16 hex of SHA-256 over both), or null when either is missing. */
export function operatorTerms(file: WakeshiftFileConfig): OperatorTerms | null {
  const terms = httpsUrl(file.terms_url);
  const privacy = httpsUrl(file.privacy_url);
  if (!terms || !privacy) return null;
  return { terms_url: terms, privacy_url: privacy, version: createHash('sha256').update(`${terms}\n${privacy}`).digest('hex').slice(0, 16) };
}

export interface WakePrincipalRef { principal_kind: string; principal_id: string; member_id: string | null }

/** The key a principal accepts under, and the input to its hashed Wakeshift user: `member:<id>` when bound, else `<kind>:<id>`. */
export function wakePrincipalKey(p: WakePrincipalRef): string {
  return p.member_id ? `member:${p.member_id}` : `${p.principal_kind}:${p.principal_id}`;
}

export async function termsAccepted(engine: BrainEngine, p: WakePrincipalRef, terms: OperatorTerms | null): Promise<boolean> {
  if (!terms) return false;
  const rows = await engine.executeRaw('SELECT 1 FROM wake_terms_acceptances WHERE principal_key = $1 AND terms_version = $2', [wakePrincipalKey(p), terms.version]);
  return rows.length > 0;
}

export async function recordAcceptance(engine: BrainEngine, p: WakePrincipalRef, terms: OperatorTerms): Promise<void> {
  await engine.executeRaw(
    'INSERT INTO wake_terms_acceptances (principal_key, terms_version) VALUES ($1, $2) ON CONFLICT (principal_key, terms_version) DO NOTHING',
    [wakePrincipalKey(p), terms.version]);
}

/** What a watch_* call returns instead of subscribing, until this principal accepts the current terms version. */
export function agreementStep(terms: OperatorTerms, tool: string): Record<string, unknown> {
  return {
    watching: false,
    agreement_required: true,
    terms_version: terms.version,
    what: `${tool} asks gbrain to wake this conversation through Wakeshift when the thing you watch finishes. Each wake sends Wakeshift a pointer (an id, a status, times, a hashed user id and your MCP client name), never page text, titles or slugs. You can stop any watch with unwatch.`,
    operator_terms_url: terms.terms_url,
    operator_privacy_url: terms.privacy_url,
    wakeshift_disclosure: 'Wakes pass through Wakeshift, operated by Clawvisor Inc. as this brain operator\'s service provider. Wakeshift\'s Connector Terms and Privacy Policy apply to that delivery and to the wakeshift program, if your agent needs it.',
    wakeshift_connector_terms_url: WAKESHIFT_CONNECTOR_TERMS_URL,
    wakeshift_privacy_url: WAKESHIFT_PRIVACY_URL,
    agreement: 'Continuing means agreeing to this brain operator\'s terms and privacy policy and to Wakeshift\'s Connector Terms and Privacy Policy (links above).',
    user_message: 'Show the user what watching does, the four links and the agreement line. Call accept_wakeshift_terms only after they agree, then call this tool again.',
    next: { tool: 'accept_wakeshift_terms', arguments: { terms_version: terms.version } },
  };
}
