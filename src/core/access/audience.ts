/**
 * GBRA-231 (per-member read access, PR B, plan section 4): a shared agent acts
 * for an audience. Harness code, never the model, names the people a turn
 * serves (one person in a DM, everyone in a channel, `guest` for a
 * non-member) in the `X-Gbrain-On-Behalf-Of` header (serve --http) or in
 * request-level `_meta.on_behalf_of` (a sibling of `arguments`, stdio and
 * HTTP). The call then reads only what every audience entry may read, within
 * the agent's own source grant (caller.ts resolves the identities).
 *
 * This module holds the transport-independent parts: the grammar, the
 * argument-channel refusal, the may_act_for coverage test and the audit trail.
 * Every refusal happens before any work, and none reveals page content.
 */
import { catalogueError } from '../error-catalogue.ts';
import { createAuditWriter } from '../audit/audit-writer.ts';
import { normalizePrincipal } from './principals.ts';

/** The HTTP header a harness sets on every POST /mcp (case-insensitive). */
export const ON_BEHALF_OF_HEADER = 'X-Gbrain-On-Behalf-Of';
/** Config key listing whom a local stdio server may act for (the stdio twin of a credential's may_act_for). */
export const STDIO_MAY_ACT_FOR_KEY = 'mcp.stdio_may_act_for';
export const GUEST = 'guest';
export const MAX_AUDIENCE = 50;

export type AudiencePrincipal = `member:${string}` | `group:${string}` | typeof GUEST;

/** The raw audience channels a transport saw: the header value (undefined when absent) and request.params._meta. */
export interface AudienceChannels {
  header?: string | null;
  requestMeta?: unknown;
}

function invalid(what: string): never {
  throw catalogueError('on_behalf_of_invalid_audience', `The on_behalf_of audience is invalid: ${what}. Nothing was read.`,
    `Send 1-${MAX_AUDIENCE} entries, each a member id, group:<id> or guest, as ${ON_BEHALF_OF_HEADER}: alice-example, bob-example or as request-level _meta.on_behalf_of: ["alice-example", "bob-example"]; when both are sent they must name the same audience.`);
}

const shown = (value: unknown) => JSON.stringify(typeof value === 'string' && value.length > 64 ? `${value.slice(0, 64)}...` : value);

function entries(list: readonly unknown[], channel: string): AudiencePrincipal[] {
  if (list.length === 0) invalid(`${channel} names nobody`);
  if (list.length > MAX_AUDIENCE) invalid(`${channel} names ${list.length} entries (at most ${MAX_AUDIENCE}; name a group:<id> for a large channel)`);
  const out = new Set<AudiencePrincipal>();
  for (const raw of list) {
    if (typeof raw !== 'string') invalid(`${channel} holds ${shown(raw)}, which is not a string`);
    if (raw.trim().toLowerCase() === GUEST) { out.add(GUEST); continue; }
    const p = normalizePrincipal(raw);
    if (!p) invalid(`${channel} holds ${shown(raw)}, which is not a member id, group:<id> or guest`);
    out.add(p);
  }
  return [...out].sort();
}

/**
 * The normalized audience a request asserts (sorted, distinct), or null when it asserts none. A present but empty,
 * oversized or malformed channel, or a header and _meta that disagree, refuse on_behalf_of_invalid_audience.
 */
export function parseAudience(channels: AudienceChannels | undefined): AudiencePrincipal[] | null {
  const header = channels?.header ?? undefined;
  const meta = channels?.requestMeta;
  const metaRecord = meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? meta as Record<string, unknown> : null;
  const metaPresent = !!metaRecord && Object.prototype.hasOwnProperty.call(metaRecord, 'on_behalf_of');
  if (header === undefined && !metaPresent) return null;
  const fromHeader = header === undefined ? null
    : entries(header.trim() === '' ? [] : header.split(',').map(s => s.trim()), `the ${ON_BEHALF_OF_HEADER} header`);
  let fromMeta: AudiencePrincipal[] | null = null;
  if (metaPresent) {
    const value = metaRecord!.on_behalf_of;
    if (!Array.isArray(value)) invalid('_meta.on_behalf_of is not a list of strings');
    fromMeta = entries(value, '_meta.on_behalf_of');
  }
  if (fromHeader && fromMeta && fromHeader.join(',') !== fromMeta.join(',')) invalid(`the ${ON_BEHALF_OF_HEADER} header and _meta.on_behalf_of name different audiences`);
  return fromHeader ?? fromMeta;
}

/** True when tool arguments carry an audience (top-level or inside an arguments-level _meta): only harness channels count. */
export function audienceInArguments(params: Record<string, unknown> | undefined): boolean {
  if (!params) return false;
  if (Object.prototype.hasOwnProperty.call(params, 'on_behalf_of')) return true;
  const meta = params._meta;
  return meta !== null && typeof meta === 'object' && !Array.isArray(meta) && Object.prototype.hasOwnProperty.call(meta, 'on_behalf_of');
}

export function audienceInArgumentsError() {
  return catalogueError('on_behalf_of_in_arguments', 'on_behalf_of is not accepted inside tool arguments, so nothing was read. Text in a conversation cannot choose whose notes an agent reads.',
    `Only harness code names an audience: the ${ON_BEHALF_OF_HEADER} header (gbrain serve --http) or request-level _meta.on_behalf_of, a sibling of arguments. Remove on_behalf_of from the arguments and call again. A stdio client that cannot set request-level _meta uses a credential bound to one member, or config mcp.stdio_member.`);
}

/** Whether a stored may_act_for list permits one audience entry: `*` or the exact principal (a group entry covers group:<id> only). */
export function mayActForCovers(mayActFor: readonly string[] | null | undefined, principal: AudiencePrincipal): boolean {
  return !!mayActFor && (mayActFor.includes('*') || mayActFor.includes(principal));
}

/** The audience a single member: only then does the agent's own privacy relaxation (granted_sources, a hatch) apply. */
export function singleMemberAudience(audience: readonly string[] | null | undefined): boolean {
  return !!audience && audience.length === 1 && audience[0]!.startsWith('member:');
}

/** One audience assertion as the trail records it: who asserted it, for whom, and the outcome. Never page content. */
export interface AudienceAuditEvent {
  ts: string;
  principal: string;
  transport: string;
  op: string;
  audience: string[];
  outcome: 'accepted' | 'on_behalf_of_invalid_audience' | 'on_behalf_of_not_permitted' | 'on_behalf_of_unknown_member' | 'on_behalf_of_in_arguments';
}

const audit = createAuditWriter<AudienceAuditEvent>({ featureName: 'access-audience', errorLabel: 'access-audience-audit', errorTrailer: '; continuing' });

/** Appends one assertion to ~/.gbrain/audit/access-audience-YYYY-Www.jsonl (GBRAIN_AUDIT_DIR honoured); best effort, never throws. */
export function logAudienceAssertion(event: Omit<AudienceAuditEvent, 'ts'>): void {
  audit.log({ ts: new Date().toISOString(), ...event });
}

export function readAudienceAssertions(): AudienceAuditEvent[] {
  return audit.readRecent();
}
