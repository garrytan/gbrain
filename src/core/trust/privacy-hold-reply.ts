/**
 * GST-2900: the reply to a held write, as a caller who cannot read the private copy sees it. A world write that restates
 * a private fact is stored private and files a supersede_fact proposal carrying the widening (GST-2511 on a page fence,
 * GST-2875 on remember); its reply names that proposal in `contested`. For a caller whose fact reads are world-only
 * (worldOnlyFacts) and who cannot read the proposal's private fact (memberFactAdmitSql, grantedPrivateFactSql), the ref
 * is dropped at read time from every `contested` in the reply: the reply itself, its `outcome` and `write_request`
 * copies, and the receipt get_write_request returns later, so the reply reads as a plain save. Any other contested ref
 * (a guarded supersession, a slot conflict) stays, and so does every ref for the owner and the local CLI. A write runs
 * without the credential's private-facts grant (dispatch applies it to reads only), so the write's reply is checked
 * under the grant it would read with. A failed lookup drops every ref (fail closed).
 */
import type { BrainEngine } from '../engine.ts';
import { grantedPrivateFactSql, memberFactAdmitSql } from '../access/member-facts.ts';
import { currentReadMode } from '../access/scope-read.ts';
import { withCallerAccess, worldOnlyFacts } from '../search/private-visibility.ts';
import { parseTrustProposalRef } from './proposals.ts';

interface ContestedReply { proposal_ref: string; proposal_refs?: string[] }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isContested = (v: unknown): v is ContestedReply => isRecord(v) && typeof v.proposal_ref === 'string';
const refsOf = (c: ContestedReply): string[] => Array.isArray(c.proposal_refs) ? c.proposal_refs.filter((r): r is string => typeof r === 'string') : [c.proposal_ref];

function collectRefs(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6) return;
  if (Array.isArray(value)) { for (const v of value) collectRefs(v, out, depth + 1); return; }
  if (!isRecord(value)) return;
  for (const [key, v] of Object.entries(value)) {
    if (key === 'contested' && isContested(v)) for (const ref of refsOf(v)) out.add(ref);
    else collectRefs(v, out, depth + 1);
  }
}

function stripRefs(value: unknown, hidden: ReadonlySet<string>, depth = 0): unknown {
  if (depth > 6) return value;
  if (Array.isArray(value)) return value.map(v => stripRefs(v, hidden, depth + 1));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key !== 'contested' || !isContested(v)) { out[key] = stripRefs(v, hidden, depth + 1); continue; }
    const kept = refsOf(v).filter(ref => !hidden.has(ref));
    const { proposal_refs: _refs, ...rest } = v;
    if (kept.length) out[key] = { ...rest, proposal_ref: kept[0], ...(kept.length > 1 ? { proposal_refs: kept } : {}) };
  }
  return out;
}

/** A supersede_fact proposal whose before state carries a visibility: a privacy hold (`before_state->'visibility' IS NOT NULL`). */
const isPrivacyHold = (p: { action: string; before_state: unknown } | null): boolean =>
  p !== null && p.action === 'supersede_fact' && isRecord(p.before_state) && Object.hasOwn(p.before_state, 'visibility');

/**
 * The refs among `refs` that are privacy holds on a private fact this caller cannot read. The holds are read through
 * the typed proposal read; only a caller whose fact reads are widened (a member page, a private-facts grant) needs the
 * readability join, and only over the holds.
 */
async function hiddenHoldRefs(engine: Pick<BrainEngine, 'listUnreadablePrivacyHoldIds' | 'getTrustProposal'>, refs: readonly string[], grant: readonly string[] | undefined): Promise<Set<string>> {
  const parsed = new Map(refs.map(ref => [parseTrustProposalRef(ref), ref] as const).filter((e): e is [number, string] => e[0] !== null));
  if (!parsed.size) return new Set();
  try {
    const ids = new Map<number, string>();
    for (const [id, ref] of parsed) if (isPrivacyHold(await engine.getTrustProposal(id))) ids.set(id, ref);
    if (!ids.size) return new Set();
    const underGrant = <R>(build: () => R): R => grant?.length && currentReadMode() === undefined ? withCallerAccess({ privateFactSources: grant }, build) : build();
    const admits = underGrant(() => [memberFactAdmitSql('f'), grantedPrivateFactSql('f')]);
    if (admits.every(sql => sql === 'FALSE')) return new Set(ids.values());
    const hidden = await underGrant(() => engine.listUnreadablePrivacyHoldIds([...ids.keys()]));
    return new Set(hidden.map(id => ids.get(id)!).filter(Boolean));
  } catch {
    return new Set(refs);
  }
}

/** `result` as `remote`'s caller reads it: privacy-hold refs it cannot read, even with `grant` (a write's private-facts sources), removed from every `contested`. */
export async function hidePrivacyHoldRefs<T>(engine: Pick<BrainEngine, 'listUnreadablePrivacyHoldIds' | 'getTrustProposal'>, remote: boolean | undefined, result: T, grant?: readonly string[]): Promise<T> {
  if (!worldOnlyFacts(remote) || !isRecord(result) && !Array.isArray(result)) return result;
  const refs = new Set<string>();
  collectRefs(result, refs);
  if (!refs.size) return result;
  const hidden = await hiddenHoldRefs(engine, [...refs], grant);
  return hidden.size ? stripRefs(result, hidden) as T : result;
}
