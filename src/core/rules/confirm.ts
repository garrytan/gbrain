/**
 * Owner confirmation of standing rules (C2), on the L1 owner-authority model (src/core/policy/authority.ts). A rule
 * is rendered into the standing-rules section only when the owner confirmed its exact words (the digest) at its
 * exact page revision: at a terminal in a process with no agent marker (gbrain correct or gbrain rules approve
 * <id>@<revision>). The record lives in config under the reserved prefix rules.confirmed., which every config
 * writer refuses outside withOwnerProof, so neither an agent nor a remote caller can confirm a rule.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { withOwnerProof, type OwnerProof } from '../policy/authority.ts';

export const RULE_CONFIRM_PREFIX = 'rules.confirmed.';

/** The fact change an approval also authorizes: a proposed rule's receipt supersedes or withdraws this fact. */
export interface ApprovedFact { action: 'replace' | 'withdraw'; id: string; text: string | null }

/** What the owner confirms: the rule's digest, bound to the fact change it carries when there is one. */
export function approvalDigest(ruleDigest: string, fact: ApprovedFact | null): string {
  return fact ? createHash('sha256').update(JSON.stringify([ruleDigest, fact.action, fact.id, fact.text])).digest('hex') : ruleDigest;
}

export interface RuleConfirmation {
  source_id: string;
  slug: string;
  revision: string;
  /** The rule's digest (ruleDigest); the proof covers approvalDigest(digest, fact). */
  digest: string;
  fact?: ApprovedFact;
  proof: OwnerProof;
}

export const confirmationKey = (sourceId: string, slug: string) => `${RULE_CONFIRM_PREFIX}${sourceId}:${slug}`;

function parse(raw: string | null | undefined): RuleConfirmation | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as RuleConfirmation;
    if (typeof c.revision !== 'string' || typeof c.digest !== 'string' || !c.proof || c.proof.digest !== approvalDigest(c.digest, c.fact ?? null)) return null;
    if (c.proof.method !== 'terminal' && c.proof.method !== 'owner_session') return null;
    return c;
  } catch {
    return null;
  }
}

/** Confirmations for these rule pages, keyed by confirmationKey; an entry whose proof does not cover its digest is dropped. */
export async function readConfirmations(engine: BrainEngine, pages: ReadonlyArray<{ source_id: string; slug: string }>): Promise<Map<string, RuleConfirmation>> {
  if (!pages.length) return new Map();
  const rows = await engine.getConfigValues(pages.map(p => confirmationKey(p.source_id, p.slug)));
  return new Map(rows.flatMap(r => { const c = parse(r.value); return c ? [[r.key, c] as const] : []; }));
}

export async function saveConfirmation(engine: BrainEngine, c: RuleConfirmation): Promise<void> {
  await withOwnerProof(c.proof, () => engine.setConfig(confirmationKey(c.source_id, c.slug), JSON.stringify(c)));
}

/**
 * The owner's approval of one proposal (a correct receipt) that has not finished yet: its revision, the rule's digest
 * and the proof. It lives under the reserved prefix too, so only the owner's approval writes it and a later read or
 * resume can trust it to finish the proposal under the owner's authority; nothing stored in the receipt is trusted.
 */
export interface PendingApproval { revision: string; rule_digest: string; proof: OwnerProof }

export const APPROVAL_PREFIX = `${RULE_CONFIRM_PREFIX}approval.`;

export async function saveApproval(engine: BrainEngine, receiptId: string, a: PendingApproval): Promise<void> {
  await withOwnerProof(a.proof, () => engine.setConfig(`${APPROVAL_PREFIX}${receiptId}`, JSON.stringify(a)));
}

export async function readApproval(engine: BrainEngine, receiptId: string): Promise<PendingApproval | null> {
  const raw = await engine.getConfig(`${APPROVAL_PREFIX}${receiptId}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as PendingApproval; } catch { return null; }
}

export async function clearApproval(engine: BrainEngine, receiptId: string, proof: OwnerProof): Promise<void> {
  await withOwnerProof(proof, () => engine.unsetConfig(`${APPROVAL_PREFIX}${receiptId}`));
}
