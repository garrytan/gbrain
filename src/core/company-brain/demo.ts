import { PGLiteEngine } from '../pglite-engine.ts';
import { importFromContent } from '../import-file.ts';
import { loadResolvedPackByName } from '../schema-pack/load-active.ts';
import { reconcileSourceLinks } from '../link-reconciliation.ts';
import { OperationError } from '../ops/contract.ts';
import { COMPANY_BRAIN_SAMPLE } from './sample.ts';

export interface CompanyBrainDemoResult {
  schema_version: 1;
  status: 'complete';
  fictional: true;
  profile: 'company-brain';
  pages: number;
  types: Record<string, number>;
  links: number;
  answers: Array<{ question: string; answer: string; citations: string[] }>;
}

export async function runCompanyBrainDemo(): Promise<CompanyBrainDemoResult> {
  const engine = new PGLiteEngine();
  const sourceId = 'company-demo';
  try {
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$2)', [sourceId, 'Fictional company demo']);
    const pack = await loadResolvedPackByName('company-brain');
    for (const page of COMPANY_BRAIN_SAMPLE) {
      const imported = await importFromContent(engine, page.slug, page.content, {
        sourceId, noEmbed: true, remote: false, activePack: pack.manifest,
        sourcePath: `${page.slug}.md`, ingested_via: 'company-brain-demo',
      });
      if (!['imported', 'skipped'].includes(imported.status)) throw new OperationError('demo_import_failed', 'The fictional page did not import successfully.');
    }
    const graph = await reconcileSourceLinks(engine, sourceId, { pack: pack.manifest });
    if (!graph.ok || !graph.complete || graph.unresolved.length) throw new OperationError('demo_graph_failed', 'The fictional graph did not verify.');
    const customer = 'customers/acme-example';
    const currentDecision = 'decisions/2026-08-20-focus-3pl';
    const accountLinks = await engine.getLinks(customer, { sourceId });
    const decisionLinks = await engine.getLinks(currentDecision, { sourceId });
    const ownerSlug = accountLinks.find(link => link.link_type === 'owned_by')?.to_slug;
    const championSlug = accountLinks.find(link => link.link_type === 'champion')?.to_slug;
    const olderSlug = decisionLinks.find(link => link.link_type === 'supersedes')?.to_slug;
    const meetingSlug = decisionLinks.find(link => link.link_type === 'decided_in')?.to_slug;
    if (!ownerSlug || !championSlug || !olderSlug || !meetingSlug) throw new OperationError('demo_verification_failed', 'Expected ownership or decision provenance is missing.');
    const owner = await engine.getPage(ownerSlug, { sourceId });
    const champion = await engine.getPage(championSlug, { sourceId });
    const decision = await engine.getPage(currentDecision, { sourceId });
    if (!owner || !champion || !decision) throw new OperationError('demo_verification_failed', 'The cited fictional pages could not be read back.');
    const rows = await engine.executeRaw<{ type: string; count: number }>('SELECT type,COUNT(*)::int AS count FROM pages WHERE source_id=$1 AND deleted_at IS NULL GROUP BY type', [sourceId]);
    const types = Object.fromEntries(rows.map(row => [row.type, Number(row.count)]));
    const pages = Object.values(types).reduce((a, b) => a + b, 0);
    if (pages !== COMPANY_BRAIN_SAMPLE.length || types.product !== 1 || types.company !== 1) throw new OperationError('demo_verification_failed', 'The fictional type distribution did not survive import.');
    const cite = (slug: string) => `${sourceId}::${slug}`;
    return { schema_version: 1, status: 'complete', fictional: true, profile: 'company-brain', pages, types, links: graph.linksCreated,
      answers: [
        { question: 'Who owns this account, and who is its champion?', answer: `${owner.title} owns the account; ${champion.title} is its champion.`, citations: [cite(customer), cite(ownerSlug), cite(championSlug)] },
        { question: 'Is the earlier decision still current?', answer: `No. ${decision.title} supersedes ${olderSlug}, with provenance in ${meetingSlug}.`, citations: [cite(currentDecision), cite(olderSlug), cite(meetingSlug)] },
      ] };
  } finally {
    await engine.disconnect();
  }
}
