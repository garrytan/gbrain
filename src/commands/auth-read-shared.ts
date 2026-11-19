import type { BrainEngine } from '../core/engine.ts';
import { sqlQueryForEngine } from '../core/sql-query.ts';
import { GrantError, grantFromClient, type ClientGrant, type PrincipalGrant } from '../core/grants/model.ts';
import { credentialReadSources } from '../core/grants/shared-exposure.ts';
import { sharedReadSources } from '../core/grants/read-shared.ts';
import type { RescopeTokenResult } from '../core/grants/legacy-token.ts';

/** GST-2898: refuse an unknown or archived source before minting a key that names it. */
export async function assertActiveSourceIds(engine: BrainEngine, ids: string[]): Promise<void> {
  const rows = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE id = ANY($1::text[]) AND archived IS NOT TRUE', [ids]);
  const missing = ids.filter(id => !rows.some(r => r.id === id));
  if (missing.length) throw new GrantError('invalid_grant', `Unknown or archived source: ${missing.join(', ')} (see gbrain sources list)`);
}

/**
 * GST-2898: what a key writes and reads, as `auth create`, `auth register-client` and `auth rescope` print it.
 * With the read-shared switch on it names the shared set now, and when nothing but `default` is shared, the command
 * that shares a source.
 */
export async function readSetLines(engine: BrainEngine, grant: Pick<PrincipalGrant, 'principal' | 'scopes' | 'sources' | 'readShared'>, member: string | null): Promise<string[]> {
  const s = grant.sources;
  const write = s.kind === 'none' ? 'nothing' : s.kind === 'default' ? 'default' : s.writeSource;
  const stored = s.kind === 'scalar' ? [s.writeSource] : s.kind === 'federated' ? s.readSources : s.kind === 'default' ? ['default'] : [];
  if (grant.readShared !== true || s.kind === 'none') {
    return [`  writes: ${write}. reads: ${(await credentialReadSources(engine, grant as PrincipalGrant, member)).join(', ') || 'nothing'}.`];
  }
  const shared = await sharedReadSources(sqlQueryForEngine(engine), member).catch(() => null);
  const lines = [`  writes: ${write}. reads: ${stored.join(', ')}, plus every shared source (now: ${shared ? shared.join(', ') : 'unreadable, so only the sources listed'}; `
    + 'sources shared later join automatically; guest sources and other members\' own sources are never included).'];
  if (shared && shared.every(id => id === 'default')) lines.push('  No other source is shared yet; share one with gbrain sources federate <id>.');
  return lines;
}

/** GST-2898: a client's resolved read set before and after a rescope, through credentialReadSources. */
export async function clientReadsChange(engine: BrainEngine, clientId: string, before: ClientGrant, after: ClientGrant): Promise<RescopeTokenResult['reads']> {
  const [row] = await engine.executeRaw<{ member_id: unknown }>('SELECT to_jsonb(c)->>\'member_id\' AS member_id FROM oauth_clients c WHERE c.client_id = $1', [clientId]);
  const member = typeof row?.member_id === 'string' ? row.member_id : null;
  const [was, now] = [await credentialReadSources(engine, grantFromClient(before), member), await credentialReadSources(engine, grantFromClient(after), member)];
  const shared = after.readShared === true && !after.sourcesNone ? await sharedReadSources(sqlQueryForEngine(engine), member).catch(() => undefined) : undefined;
  return { before: was, after: now, stops_reading: was.filter(s => !now.includes(s)), ...(shared ? { shared_now: shared } : {}) };
}

/**
 * GST-2898: the read set a rescope leaves, the shared set with the switch on, and the sources a narrowing stops
 * reading (it applies: narrowing is safe), with the flag that keeps every shared source only while the switch stayed off
 * and the key still reads a source (never after `--read-shared off` or `--sources none`, which refuses the switch).
 */
export function readsChangeLines(reads: RescopeTokenResult['reads'], before: boolean, after: boolean, target: string): string[] {
  const lines: string[] = [];
  if (before !== after) lines.push(`  Read shared sources: ${before ? 'on' : 'off'} -> ${after ? 'on' : 'off'}`);
  if (after) {
    lines.push(`  Reads: ${reads.after.join(', ') || 'nothing'} (every shared source, now: ${reads.shared_now?.join(', ') ?? 'unreadable'}; sources shared later join automatically; `
      + 'guest sources and other members\' own sources are never included)');
    if (reads.shared_now?.every(id => id === 'default')) lines.push('  No other source is shared yet; share one with gbrain sources federate <id>.');
  } else if (JSON.stringify(reads.before) !== JSON.stringify(reads.after)) {
    lines.push(`  Reads: ${reads.before.join(', ') || 'nothing'} -> ${reads.after.join(', ') || 'nothing'}`);
  }
  if (reads.stops_reading.length) {
    lines.push(`  This key stops reading: ${reads.stops_reading.join(', ')}.${after || before || !reads.after.length ? '' : ` Add --read-shared on to keep reading every shared source (gbrain auth rescope ${target} --read-shared on).`}`);
  }
  return lines;
}

/** GST-2898: `auth create --sources <write,read...> --read-shared on|off`; the write source comes first. */
export function parseCreateSourceFlags(rest: string[]): { sources?: string[]; readShared?: boolean; error?: string } {
  const sourcesIdx = rest.indexOf('--sources');
  const sourcesValue = sourcesIdx >= 0 ? rest[sourcesIdx + 1] : undefined;
  if (sourcesIdx >= 0 && (sourcesValue === undefined || sourcesValue.startsWith('--'))) {
    return { error: 'the sources flag requires a value: the write source first, then any other sources it reads (e.g. private-alice-example)' };
  }
  const sources = sourcesValue !== undefined ? [...new Set(sourcesValue.split(',').map(s => s.trim()).filter(Boolean))] : undefined;
  if (sources !== undefined && sources.length === 0) return { error: 'the sources flag needs at least one source id (to mint a key that reads nothing, mint it and run gbrain auth rescope --sources none)' };
  const sharedIdx = rest.indexOf('--read-shared');
  const sharedValue = sharedIdx >= 0 ? rest[sharedIdx + 1] : undefined;
  if (sharedIdx >= 0 && sharedValue !== 'on' && sharedValue !== 'off') return { error: 'the read-shared flag requires on or off' };
  if (sharedValue === 'on' && sources === undefined) {
    return { error: '--read-shared on needs --sources <write-source>: a key with no source list already reads every shared source (read_shared_needs_source)' };
  }
  return { ...(sources !== undefined ? { sources } : {}), ...(sharedValue === 'on' ? { readShared: true } : {}) };
}

