/**
 * Capture-time admission policy (capture-policy PR).
 * Deterministic and conservative: framed marketing and logistics can drop;
 * scheduling needs both a scheduling signal and a date/time. Physical shipping,
 * travel/account logistics and short-lived status drop only without substance.
 * Money, metrics, decisions, legal terms and strategy veto those noise rules.
 * Explicit remember/write-single bypass admission. Defaults are off; shadow
 * measures without changing facts. Routing uses identity evidence, never fuzzy
 * matches, and cannot route around a subject-scoped withdrawal.
 */
import type { StrictResolution } from '../entities/resolve.ts';
import { extractCandidates } from '../context/entity-salience.ts';
import { SLUG_IN_TEXT_RE, SENTENCE_OPENERS, shedOpener, isNonName } from './subject-infer.ts';

export type CaptureCategory = 'scheduling' | 'logistics' | 'shipping' | 'spam' | 'transient';
export interface CaptureClaim {
  fact: string;
  kind?: string | null;
  notability?: string | null;
  claim_metric?: string | null;
}
interface CaptureVerdict { verdict: 'keep' | 'drop'; category: CaptureCategory | null; rule: string }
export function classifyCaptureValue(input: CaptureClaim): CaptureVerdict {
  const drop = (category: CaptureCategory) => ({ verdict: 'drop' as const, category, rule: `capture.${category}.v1` });
  const text = input.fact;
  const substance = input.kind === 'metric' || !!input.claim_metric || [
    /\$|\b(?:USD|EUR)\b|\d\s*%|\b\d+(?:\.\d+)?\s*[kmb]\b/i,
    /\b(?:decided|agreed|signed|approved|rejected|hired|raised|closed|invested|terminated|acquired|licensed|filed|must|will not)\b/i,
    /\b(?:patent|IP|FTO|IND|FDA|contract|term sheet|NDA|license|strategy|priority|risk|competitor|valuation)\b/i,
    /\b(?:round|Series|revenue|ARR|MRR|margin|headcount)\b/i,
  ].some(pattern => pattern.test(text));
  if (substance) return { verdict: 'keep', category: null, rule: 'capture.substance.v1' };
  const future = /\b(?:will|scheduled for|planned for|upcoming|invite|reschedul\w*|proposed|set up)\b/i.test(text);
  const past = /\b(?:took place|was held|met|had a (?:meeting|call)|discussed|presented)\b/i.test(text);
  const topic = /\b(?:about|regarding|to (?:discuss|share|review|present|negotiate))\b/i.test(text);
  const counterparty = /\bwith\s+\p{Lu}[\p{L}]+/u.test(text);
  const relativeTime = /\b(?:\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm)|noon|midnight|today|tomorrow|tonight|next week|next month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text);
  const absoluteDate = /\b(?:\d{4}-\d{2}-\d{2}|(?:january|february|april|june|july|august|september|october|november|december)\s+\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/i.test(text);
  if (/\b(?:meeting|call|appointment|invite|reschedul\w*|attend\w*)\b/i.test(text)
    && future && (relativeTime || absoluteDate) && !past && !topic && !counterparty) return drop('scheduling');
  const status = /\b(?:booked|reserved|confirmed|check-in|departs|lands|arrived|delayed|tracking)\b/i.test(text);
  if (status
    && /\b(?:parcel|courier|tracking number|delivery ETA|customs (?:status|clearance)|physical shipment)\b/i.test(text)) return drop('shipping');
  if (status
    && /\b(?:travel booking|hotel|flight|restaurant|room booking|parking|wi-?fi|password reset)\b/i.test(text)) return drop('logistics');
  if (/\b(?:received|arrived|sent us|in my inbox)\b/i.test(text)
    && /\b(?:newsletter|unsubscribe|limited time|sponsored (?:email|message|post|content|offer)|promotional offer|webinar invitation|marketing email)\b/i.test(text)) return drop('spam');
  if (/\b(?:is running late|out of office until|waiting for a reply|will send (?:it|this) tomorrow|reminder to)\b/i.test(text)) return drop('transient');
  return { verdict: 'keep', category: null, rule: 'capture.default_keep.v1' };
}
export type CaptureMode = 'off' | 'shadow' | 'on';
export function captureMode(raw: string | null | undefined): CaptureMode {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'shadow' ? 'shadow' : /^(on|true|1|yes|enabled)$/.test(value) ? 'on' : 'off';
}
export function routingTypes(raw: string | null | undefined, fallback: string): string[] {
  return (raw ?? fallback).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
export interface RoutingInput {
  fact: string; slug: string; broadNames?: string[]; broadTypes?: string[]; specificTypes?: string[];
}
export interface RoutingDeps {
  /** Must return live fact entities through strict identity arms only. */
  resolve(query: string): Promise<StrictResolution>;
  typeOf(slug: string): Promise<string | null>;
  isWithdrawn(slug: string): Promise<boolean>;
}
interface RoutingDecision { slug: string | null; rerouted: boolean; reason: string }
export async function chooseSpecificEntity(input: RoutingInput, deps: RoutingDeps): Promise<RoutingDecision> {
  const stay = (reason: string) => ({ slug: input.slug, rerouted: false, reason });
  if (await deps.isWithdrawn(input.slug)) return { slug: null, rerouted: false, reason: 'withdrawn_original' };
  const broad = input.broadTypes ?? ['company'];
  const specific = input.specificTypes ?? ['person', 'project', 'deal'];
  if (!broad.includes((await deps.typeOf(input.slug)) ?? '')) return stay('not_broad');
  const names = [...(input.broadNames ?? []), input.slug, input.slug.split('/').pop()!.replace(/-/g, ' ')];
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const claim = ` ${normalize(input.fact)} `;
  if (names.some(name => normalize(name) && claim.includes(` ${normalize(name)} `))) return stay('broad_mentioned');
  if (/\b(?:[\p{L}]+(?:\s+[\p{L}]+)*['’]s|her|his|their)\s+(?:company|startup|firm)\b/iu.test(input.fact)) return stay('possessive_broad');
  const candidates = [
    ...[...new Set(input.fact.match(SLUG_IN_TEXT_RE) ?? [])].map(query => ({ query, sentenceStart: false })),
    ...extractCandidates(input.fact).filter(c => !c.weak).map(shedOpener),
  ];
  const targets = new Set<string>();
  for (const c of candidates) {
    const result = await deps.resolve(c.query);
    if (result.slug === null) {
      const opener = c.sentenceStart && SENTENCE_OPENERS.has(c.query.toLowerCase());
      if (result.miss === 'not_entity' || result.miss === 'no_page' && (isNonName(c.query) || opener)) continue;
      return stay('competing_name');
    }
    if (result.arm === 'same_name') return stay('non_identity');
    if (result.slug === input.slug) return stay('broad_mentioned');
    const type = await deps.typeOf(result.slug);
    if (broad.includes(type ?? '') || result.slug.startsWith('companies/')) return stay('other_broad');
    const dir = result.slug.split('/')[0]!;
    const specificDirectory = specific.some(t => (t === 'person' ? 'people' : t === 'company' ? 'companies' : `${t}s`) === dir);
    if (!specific.includes(type ?? '') && !specific.includes(dir) && !specificDirectory) return stay('other_entity');
    if (!/[\s/\-]/.test(c.query) && (dir === 'people' || type === 'person')) return stay('bare_first_name');
    targets.add(result.slug);
  }
  if (targets.size !== 1) return stay(targets.size ? 'multiple_specific' : 'no_specific');
  const slug = [...targets][0]!;
  if (await deps.isWithdrawn(slug)) return { slug: null, rerouted: false, reason: 'withdrawn_target' };
  return { slug, rerouted: true, reason: 'unique_specific' };
}
