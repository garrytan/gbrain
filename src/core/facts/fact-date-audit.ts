import type { BrainEngine } from '../engine.ts';
import { readFactDateAnchors, readFactDateAssessments, useFactDateAuditSnapshot } from '../engine-sql/fact-date-verification.ts';
import { findBulkFactDays, type BulkFactDay } from './bulk-days.ts';
import { factDateProof, matchesDatedExcerpt, type FactDateProof } from './fact-date-proof.ts';

type Assessment = FactDateProof & { source_id: string };
const dayKey = (source: string, day: string) => JSON.stringify([source, day]);

/** The original bulk-day rule stays in force for detection and repair selection. */
export function findFactDateAuditDays(engine: BrainEngine, sourceIds?: string[]) {
  return engine.transaction(async tx => {
    await useFactDateAuditSnapshot(tx);
    const days = await findBulkFactDays(tx, sourceIds);
    const verified = await readVerifiedFacts(tx, days.filter(day => day.dated_claims === 0));
    return days.map(day => {
      const verified_facts = verified.get(dayKey(day.source_id, day.day))?.size ?? 0;
      const evidence_status = verified_facts === day.facts ? 'confirmed_same_day' as const : 'review_required' as const;
      return { ...day, verified_facts, evidence_status };
    });
  }, { readOnly: true });
}

async function readVerifiedFacts(tx: BrainEngine, days: BulkFactDay[]) {
  const verified = new Map<string, Set<number>>();
  if (!days.length) return verified;
  const assessments: Assessment[] = [];
  for (const row of await readFactDateAssessments(tx, days)) {
    const proof = factDateProof.safeParse(row.proof);
    if (proof.success && proof.data.source_incarnation === row.source_incarnation && proof.data.utc_day === row.day) {
      assessments.push({ ...proof.data, source_id: row.source_id });
    }
  }
  if (!assessments.length) return verified;
  for (const anchor of await readFactDateAnchors(tx, assessments)) {
    const proof = assessments[anchor.index];
    if (!proof || proof.fact_digest !== anchor.fact_digest || !matchesDatedExcerpt(proof, anchor.excerpt)) continue;
    const key = dayKey(proof.source_id, proof.utc_day);
    let ids = verified.get(key);
    if (!ids) { ids = new Set(); verified.set(key, ids); }
    ids.add(proof.fact_id);
  }
  return verified;
}
