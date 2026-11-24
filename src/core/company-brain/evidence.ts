import type { BrainEngine } from '../engine.ts';

export interface CompanyBrainEvidence {
  ownership: { status: 'not_applicable' } | { status: 'verified'; page: string; owner: string; citations: string[] };
  supersession: { status: 'not_applicable' } | { status: 'verified'; newer: string; older: string; citations: string[] };
  page: { title: string; citation: string } | null;
}

export async function readCompanyBrainEvidence(engine: BrainEngine, sourceId: string): Promise<CompanyBrainEvidence> {
  const { owner, decision, page } = await engine.readCompanyBrainEvidenceRows(sourceId);
  const cite = (slug: string) => `${sourceId}::${slug}`;
  return {
    ownership: owner ? { status: 'verified', page: owner.from_title, owner: owner.to_title,
      citations: [cite(owner.from_slug), cite(owner.to_slug)] } : { status: 'not_applicable' },
    supersession: decision ? { status: 'verified', newer: decision.from_title, older: decision.to_title,
      citations: [cite(decision.from_slug), cite(decision.to_slug)] } : { status: 'not_applicable' },
    page: page ? { title: page.title, citation: cite(page.slug) } : null,
  };
}
